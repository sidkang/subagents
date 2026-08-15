/**
 * Per-Child JJ worktree backend for the sidkang/subagents fork.
 *
 * Transparent replacement behind stock `worktree.ts` create/diff/cleanup:
 * - effective cwd is a JJ repo → one independent JJ workspace per stock worktree slot
 * - otherwise callers keep the stock Git implementation
 *
 * Duplicate-as-workspace topology (no long-lived frozen base F / WeakMap):
 * 1. Snapshot Source once; record exact Source WC commit S0
 * 2. Per Child: `jj duplicate -r S0` → owned duplicate D0 (same tree/parents, new change D)
 * 3. `jj workspace add --name … -r D0 <path>` creates bootstrap WC C (parent D0)
 * 4. Immediately `jj edit <D change>` so workspace @ is D itself; unreferenced C drops
 * 5. worktree.workspaceChangeId = D; worktree.workspaceCommitId = initial D0 commit
 *    setup.baseCommit = S0 (shared freeze). Capture uses per-worktree D0.
 * 6. Child rewrites D; capture `jj diff --from D0 --to @` (fail closed if D0 missing)
 * 7. Later Source rewrites do not stale sibling D workspaces
 * 8. Cleanup: exact name/root + current change==D + parents(@)==parents(D0) +
 *    no live descendants of the current workspace commit → forget +
 *    abandon that exact commit (never a possibly-divergent change id) + rm path
 *
 * Snapshot-first for capture/cleanup work checks is preserved.
 * No workflow-level Shared JJ Placement.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAuthorityDecision, type AuthorityPolicyConfig } from "../../policy/authority.ts";
import { getAgentDir } from "../../shared/utils.ts";

export interface WorktreeSetup {
	cwd: string;
	worktrees: WorktreeInfo[];
	/** Shared freeze: Source S0 commit at createJjWorktrees. Capture uses per-W D0. */
	baseCommit: string;
	capturedDiffs?: WorktreeDiff[];
	/** Narrow internal marker: present only for JJ-backed setups. */
	backend?: "jj";
}

export interface WorktreeInfo {
	path: string;
	agentCwd: string;
	/** For JJ: workspace name (not a Git branch). */
	branch: string;
	index: number;
	nodeModulesLinked: boolean;
	syntheticPaths: string[];
	/** Owned Child change id (identity match only; never a destructive revset). */
	workspaceChangeId?: string;
	/** Initial D0 commit id (capture base / parent check / handoff). */
	workspaceCommitId?: string;
	backend?: "jj";
}

export interface WorktreeDiff {
	index: number;
	agent: string;
	branch: string;
	diffStat: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	patchPath: string;
	error?: string;
}

export interface WorktreeCleanupTask {
	index: number;
	path: string;
	branch: string;
	worktreeRemoved: boolean;
	branchRemoved: boolean;
	preserved?: boolean;
	reason?: string;
	errors?: string[];
	backend?: "jj";
	workspaceChangeId?: string;
	/** Initial D0 commit id (capture base / parent check / handoff). */
	workspaceCommitId?: string;
}

export type WorktreeCleanupIntent =
	| { kind: "preserve"; capturedDiffs?: WorktreeDiff[]; handoffManifestPath?: string }
	| {
			kind: "discard";
			authorization:
				| { kind: "policy"; policy?: AuthorityPolicyConfig }
				| { kind: "confirmed"; policy?: AuthorityPolicyConfig };
	  }
	| { kind: "setup-rollback" };

export interface WorktreeCleanupReport {
	state: "complete" | "partial";
	tasks: WorktreeCleanupTask[];
	pruned: boolean;
	errors?: string[];
}

interface WorktreeSetupHookConfig {
	hookPath: string;
	timeoutMs?: number;
}

interface CreateWorktreesOptions {
	agents?: string[];
	setupHook?: WorktreeSetupHookConfig;
	baseDir?: string;
}

interface ResolvedWorktreeSetupHook {
	hookPath: string;
	timeoutMs: number;
}

interface WorktreeSetupHookInput {
	version: 1;
	repoRoot: string;
	worktreePath: string;
	agentCwd: string;
	branch: string;
	index: number;
	runId: string;
	baseCommit: string;
	agent?: string;
}

interface WorktreeSetupHookOutput {
	syntheticPaths?: string[];
}

interface JjRepoLayout {
	root: string;
	cwdRelative: string;
}

interface JjRepoState extends JjRepoLayout {
	/** Exact Source WC commit S0 at freeze (setup.baseCommit). */
	baseCommit: string;
	/** Source @ change id at freeze (forensics). */
	baseChange: string;
}

const DUPLICATE_AS_COMMIT_RE = /Duplicated\s+[0-9a-f]+\s+as\s+([0-9a-f]{40})\b/gi;

interface WorkspaceIdentity {
	changeId: string;
	commitId: string;
	parentCommitIds: string[];
}

const WORKSPACE_WC_IDENTITY_TEMPLATE =
	'change_id ++ "\\n" ++ commit_id ++ "\\n" ++ parents.map(|c| c.commit_id() ++ "\\n")';
const DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS = 30000;

function runJj(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("jj", args, {
		cwd,
		encoding: "utf-8",
		maxBuffer: 50 * 1024 * 1024,
		timeout: 120_000,
	});
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function runJjChecked(cwd: string, args: string[]): string {
	const result = runJj(cwd, args);
	if (result.status !== 0) {
		const message = result.stderr.trim() || result.stdout.trim() || `jj ${args.join(" ")} failed`;
		throw new Error(message);
	}
	return result.stdout;
}

function real(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

/** True when cwd is inside a JJ repository (`.jj` walks up). */
export function findJjRoot(cwd: string): string | null {
	let cur = path.resolve(cwd);
	for (;;) {
		if (fs.existsSync(path.join(cur, ".jj"))) return real(cur);
		const parent = path.dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}

/** Prefer JJ when effective cwd is inside a JJ repo. */
export function isJjWorktreeCwd(cwd: string): boolean {
	return findJjRoot(cwd) !== null;
}

function resolveCwdRelative(root: string, cwd: string): string {
	// real() both sides so macOS /var vs /private/var (and similar) do not false-escape.
	const rel = path.relative(real(root), real(cwd));
	if (!rel || rel === ".") return "";
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`worktree isolation cwd escapes JJ root: ${cwd}`);
	}
	return rel;
}

function resolveRepoLayout(cwd: string): JjRepoLayout {
	const root = findJjRoot(cwd);
	if (!root) throw new Error("worktree isolation requires a JJ repository");
	const cwdRelative = resolveCwdRelative(root, cwd);
	return { root, cwdRelative };
}

/**
 * Snapshot Source once and record exact S0 commit/change.
 * Per-Child D0 is created later via `jj duplicate -r S0`.
 */
function snapshotSourceS0(root: string): { sourceBaseCommit: string; baseChange: string } {
	runJjChecked(root, ["util", "snapshot"]);
	const sourceBaseCommit = runJjChecked(root, [
		"--ignore-working-copy",
		"log",
		"-r",
		"@",
		"--no-graph",
		"-T",
		"commit_id",
	]).trim();
	const baseChange = runJjChecked(root, [
		"--ignore-working-copy",
		"log",
		"-r",
		"@",
		"--no-graph",
		"-T",
		"change_id",
	]).trim();
	if (!/^[0-9a-f]{40}$/.test(sourceBaseCommit)) {
		throw new Error(`empty or non-full Source base commit: ${sourceBaseCommit || "<empty>"}`);
	}
	if (!baseChange) throw new Error("empty Source base change id");
	return { sourceBaseCommit, baseChange };
}

function readParentCommitIds(root: string, rev: string): string[] | null {
	const r = runJj(root, [
		"--ignore-working-copy",
		"log",
		"-r",
		rev,
		"--no-graph",
		"-T",
		'parents.map(|c| c.commit_id() ++ "\n")',
	]);
	if (r.status !== 0) return null;
	return r.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function parentsEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((v, i) => v === b[i]);
}

function isExactCommitId(id: string): boolean {
	return /^[0-9a-f]{40}$/.test(id);
}

/** Best-effort abandon of one exact commit when it has no live descendants. */
function abandonRevisionIfSafe(sourceRoot: string, commitId: string): void {
	const id = commitId.trim();
	if (!isExactCommitId(id)) return;
	const descendants = liveDescendantsOfRevision(sourceRoot, id);
	if (!descendants.ok || descendants.ids.length > 0) return;
	runJj(sourceRoot, ["abandon", id]);
}

function duplicateOwnedBase(root: string, sourceBaseCommit: string): {
	duplicateCommitId: string;
	duplicateChangeId: string;
	parentCommitIds: string[];
} {
	const dup = runJj(root, [
		"--ignore-working-copy",
		"--color=never",
		"--config",
		'templates.commit_summary="commit_id"',
		"duplicate",
		"-r",
		sourceBaseCommit,
	]);
	if (dup.status !== 0) {
		throw new Error(
			`jj duplicate failed: ${(dup.stderr || dup.stdout).trim() || "jj duplicate failed"}`,
		);
	}
	const textOut = `${dup.stdout || ""}\n${dup.stderr || ""}`;
	const matches = [...textOut.matchAll(DUPLICATE_AS_COMMIT_RE)].map((m) => m[1]!).filter(Boolean);
	if (matches.length !== 1) {
		throw new Error(
			`jj duplicate: expected exactly one "Duplicated ... as <40hex>" line, got ${matches.length}: ${textOut.trim()}`,
		);
	}
	const duplicateCommitId = matches[0]!;
	if (duplicateCommitId === sourceBaseCommit) {
		throw new Error("jj duplicate: D0 must differ from Source commit S0");
	}
	const duplicateChangeId = runJjChecked(root, [
		"--ignore-working-copy",
		"log",
		"-r",
		duplicateCommitId,
		"--no-graph",
		"-T",
		"change_id",
	]).trim();
	if (!duplicateChangeId) throw new Error("empty duplicate change id");
	const parentCommitIds = readParentCommitIds(root, duplicateCommitId);
	if (!parentCommitIds) {
		abandonRevisionIfSafe(root, duplicateCommitId);
		throw new Error("failed to read parents of duplicate D0");
	}
	const emptyDiff = runJj(root, [
		"--ignore-working-copy",
		"diff",
		"--from",
		sourceBaseCommit,
		"--to",
		duplicateCommitId,
		"--git",
	]);
	if (emptyDiff.status !== 0) {
		abandonRevisionIfSafe(root, duplicateCommitId);
		throw new Error(
			`duplicate content check failed: ${(emptyDiff.stderr || emptyDiff.stdout).trim()}`,
		);
	}
	if (emptyDiff.stdout.trim().length > 0) {
		abandonRevisionIfSafe(root, duplicateCommitId);
		throw new Error("duplicate D0 must be content-identical to Source S0 (non-empty diff)");
	}
	return { duplicateCommitId, duplicateChangeId, parentCommitIds };
}

function normalizeComparableCwd(cwd: string): string {
	const resolved = path.resolve(cwd);
	let existing = resolved;
	const missingSegments: string[] = [];
	while (true) {
		try {
			return path.join(fs.realpathSync(existing), ...missingSegments.reverse());
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) return resolved;
			missingSegments.push(path.basename(existing));
			existing = parent;
		}
	}
}

function resolveWorktreeBaseDir(configuredBaseDir: string | undefined, repoRoot: string): string {
	const rawBaseDir = configuredBaseDir ?? process.env.PI_SUBAGENTS_WORKTREE_DIR;
	if (rawBaseDir === undefined) return os.tmpdir();
	const trimmed = rawBaseDir.trim();
	if (!trimmed) throw new Error("worktree base directory cannot be empty");
	const expanded = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
	const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(repoRoot, expanded);
	const extensionsDir = normalizeComparableCwd(path.join(getAgentDir(), "extensions"));
	const relativeToExtensions = path.relative(extensionsDir, normalizeComparableCwd(resolved));
	if (!relativeToExtensions || (!relativeToExtensions.startsWith(`..${path.sep}`) && relativeToExtensions !== ".." && !path.isAbsolute(relativeToExtensions))) {
		throw new Error(`worktree base directory cannot be inside Pi extensions directory: ${extensionsDir}. Choose a directory outside it.`);
	}
	try {
		fs.mkdirSync(resolved, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`failed to create worktree base directory ${resolved}: ${message}`);
	}
	return resolved;
}

function buildWorktreePath(baseDir: string, runId: string, index: number): string {
	return path.join(baseDir, `pi-worktree-${runId}-${index}`);
}

function buildWorkspaceName(runId: string, index: number): string {
	// jj workspace names: keep opaque, path-safe, unique per stock slot.
	const safeRun = String(runId).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48);
	return `pi-jj-${safeRun}-${index}`;
}

/** Inventory of registered workspace name → root path via stable machine template. */
function workspaceListInventory(sourceRoot: string): Map<string, string> {
	const listed = runJj(sourceRoot, [
		"--ignore-working-copy",
		"workspace",
		"list",
		"-T",
		'name ++ "\t" ++ root ++ "\n"',
	]);
	if (listed.status !== 0) {
		throw new Error(`jj workspace list failed: ${(listed.stderr || listed.stdout).trim()}`);
	}
	const inventory = new Map<string, string>();
	for (const line of listed.stdout.replace(/\r\n/g, "\n").split("\n")) {
		if (!line.trim()) continue;
		const tab = line.indexOf("\t");
		if (tab <= 0) continue;
		const name = line.slice(0, tab).trim();
		const root = line.slice(tab + 1).trim();
		if (name && root) inventory.set(name, root);
	}
	return inventory;
}

function workspaceListNames(sourceRoot: string): Set<string> {
	return new Set(workspaceListInventory(sourceRoot).keys());
}

function parseWorkspaceIdentity(stdout: string): WorkspaceIdentity | null {
	const lines = stdout.replace(/\r\n/g, "\n").split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	if (lines.length < 2) return null;
	const changeId = (lines[0] ?? "").trim();
	const commitId = (lines[1] ?? "").trim();
	if (!changeId || !commitId) return null;
	const parentCommitIds = lines
		.slice(2)
		.map((line) => line.trim())
		.filter(Boolean);
	return { changeId, commitId, parentCommitIds };
}

function readWorkspaceIdentity(workspacePath: string): WorkspaceIdentity | null {
	const r = runJj(workspacePath, [
		"--ignore-working-copy",
		"log",
		"-r",
		"@",
		"--no-graph",
		"-T",
		WORKSPACE_WC_IDENTITY_TEMPLATE,
	]);
	if (r.status !== 0) return null;
	return parseWorkspaceIdentity(r.stdout);
}

function linkNodeModulesIfPresent(toplevel: string, worktreePath: string): boolean {
	const nodeModulesPath = path.join(toplevel, "node_modules");
	const nodeModulesLinkPath = path.join(worktreePath, "node_modules");
	if (!fs.existsSync(nodeModulesPath) || fs.existsSync(nodeModulesLinkPath)) return false;
	try {
		fs.symlinkSync(nodeModulesPath, nodeModulesLinkPath);
		return true;
	} catch {
		return false;
	}
}

function isMissingRevision(stderr: string, stdout: string): boolean {
	const text = `${stderr || ""}\n${stdout || ""}`;
	if (/resolved to more than one|ambiguous/i.test(text)) return false;
	return /No such revision|No revisions matched|doesn't exist|does not exist|absent/i.test(text);
}

function isWorkingCopyStaleMessage(stderr: string, stdout: string): boolean {
	return /working copy is stale/i.test(`${stderr || ""}\n${stdout || ""}`);
}

/**
 * Snapshot-first invariant for Child disk bytes (capture + cleanup work checks).
 *
 * NEVER run `workspace update-stale` before the first `util snapshot` of Child
 * working-copy bytes. `update-stale` after an external rewrite/describe can wipe
 * unsnapshotted unique files (silent data loss).
 *
 * Order:
 * 1. `jj util snapshot` first — records Child disk bytes into the WC commit
 * 2. On snapshot failure (including stale): preserve bytes/workspace and fail;
 *    do NOT proceed to destructive `update-stale`
 * 3. Only after a successful snapshot, run `workspace update-stale` if a probe
 *    still reports stale; then optional re-snapshot
 * 4. Subsequent identity/diff reads may use `--ignore-working-copy` when the
 *    snapshotted commit is already authoritative
 *
 * Post-add setup may still run update-stale before any Child writes (no Child
 * bytes at risk). After launch, only this helper may heal stale for capture/cleanup.
 */
function prepareChildWorkspaceSnapshotFirst(
	workspacePath: string,
): { ok: true } | { ok: false; reason: string } {
	const snap = runJj(workspacePath, ["util", "snapshot"]);
	if (snap.status !== 0) {
		const detail = (snap.stderr || snap.stdout).trim() || "jj util snapshot failed";
		return {
			ok: false,
			reason: `snapshot failed before update-stale (workspace bytes preserved): ${detail}`,
		};
	}

	// After a successful snapshot, only run update-stale if still required.
	const probe = runJj(workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
	if (probe.status === 0) {
		return { ok: true };
	}
	if (!isWorkingCopyStaleMessage(probe.stderr, probe.stdout)) {
		const detail = (probe.stderr || probe.stdout).trim() || "workspace unreadable after snapshot";
		return { ok: false, reason: `workspace probe failed after snapshot: ${detail}` };
	}

	const stale = runJj(workspacePath, ["workspace", "update-stale"]);
	if (stale.status !== 0) {
		const detail = (stale.stderr || stale.stdout).trim() || "jj workspace update-stale failed";
		return {
			ok: false,
			reason: `update-stale failed after snapshot (workspace bytes preserved): ${detail}`,
		};
	}

	// Optional re-snapshot after heal so subsequent reads see a consistent WC.
	const snap2 = runJj(workspacePath, ["util", "snapshot"]);
	if (snap2.status !== 0) {
		const detail = (snap2.stderr || snap2.stdout).trim() || "jj util snapshot failed after update-stale";
		return {
			ok: false,
			reason: `snapshot failed after update-stale (workspace bytes preserved): ${detail}`,
		};
	}
	return { ok: true };
}

function safePatchAgentName(agent: string): string {
	return agent.replace(/[^\w.-]/g, "_");
}

function emptyDiff(index: number, agent: string, branch: string, patchPath: string, error?: string): WorktreeDiff {
	return {
		index,
		agent,
		branch,
		diffStat: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		patchPath,
		...(error ? { error } : {}),
	};
}

function writeEmptyPatch(patchPath: string): void {
	try {
		fs.writeFileSync(patchPath, "", "utf-8");
	} catch {
		/* best-effort */
	}
}

function parseHookTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error("worktree setup hook timeout must be an integer greater than 0");
	}
	return timeoutMs;
}

function resolveWorktreeSetupHook(
	repoRoot: string,
	config: WorktreeSetupHookConfig | undefined,
): ResolvedWorktreeSetupHook | undefined {
	if (!config) return undefined;
	const hookPath = config.hookPath.trim();
	if (!hookPath) {
		throw new Error("worktree setup hook path cannot be empty");
	}

	const expandedHookPath = hookPath.startsWith("~/") ? path.join(os.homedir(), hookPath.slice(2)) : hookPath;
	let resolvedPath: string;
	if (path.isAbsolute(expandedHookPath)) {
		resolvedPath = expandedHookPath;
	} else if (expandedHookPath.includes("/") || expandedHookPath.includes("\\")) {
		resolvedPath = path.resolve(repoRoot, expandedHookPath);
	} else {
		throw new Error("worktree setup hook must be an absolute path or a repo-relative path");
	}

	if (!fs.existsSync(resolvedPath)) {
		throw new Error(`worktree setup hook not found: ${resolvedPath}`);
	}
	if (fs.statSync(resolvedPath).isDirectory()) {
		throw new Error(`worktree setup hook must be a file, got directory: ${resolvedPath}`);
	}

	return {
		hookPath: resolvedPath,
		timeoutMs: parseHookTimeout(config.timeoutMs),
	};
}

function normalizeSyntheticPath(worktreePath: string, rawPath: string): string {
	const trimmed = rawPath.trim();
	if (!trimmed) throw new Error("synthetic path cannot be empty");
	if (path.isAbsolute(trimmed)) throw new Error(`synthetic path must be relative: ${rawPath}`);

	const resolved = path.resolve(worktreePath, trimmed);
	const relative = path.relative(worktreePath, resolved);
	if (!relative || relative === ".") {
		throw new Error(`synthetic path cannot target the worktree root: ${rawPath}`);
	}
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`synthetic path escapes the worktree root: ${rawPath}`);
	}
	return path.normalize(relative);
}

/**
 * JJ analogue of stock `git ls-files` tracked-path rejection for syntheticPaths.
 * Inspect the already-snapshotted @, not the live WC: a hook-created file must
 * remain eligible as synthetic the same way an untracked Git file does.
 */
function hasTrackedEntries(worktreePath: string, relativePath: string): boolean {
	const result = runJj(worktreePath, [
		"--ignore-working-copy",
		"file",
		"list",
		"-r",
		"@",
		"--",
		relativePath,
	]);
	if (result.status !== 0) {
		const detail = (result.stderr || result.stdout).trim() || "jj file list failed";
		throw new Error(`tracked-path validation failed: ${detail}`);
	}
	return result.stdout.trim().length > 0;
}

function parseWorktreeSetupHookOutput(rawStdout: string): WorktreeSetupHookOutput {
	const trimmed = rawStdout.trim();
	if (!trimmed) {
		throw new Error("worktree setup hook returned empty stdout; expected JSON object");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`worktree setup hook returned invalid JSON: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("worktree setup hook stdout must be a JSON object");
	}
	return parsed as WorktreeSetupHookOutput;
}

function runWorktreeSetupHook(
	hook: ResolvedWorktreeSetupHook,
	input: WorktreeSetupHookInput,
): string[] {
	const result = spawnSync(hook.hookPath, [], {
		cwd: input.worktreePath,
		encoding: "utf-8",
		input: JSON.stringify(input),
		timeout: hook.timeoutMs,
		shell: false,
	});

	if (result.error) {
		const code = "code" in result.error ? result.error.code : undefined;
		if (code === "ETIMEDOUT") {
			throw new Error(`worktree setup hook timed out after ${hook.timeoutMs}ms`);
		}
		throw new Error(`worktree setup hook failed: ${result.error.message}`);
	}

	if (result.status !== 0) {
		const details = result.stderr.trim() || result.stdout.trim() || "no output";
		throw new Error(`worktree setup hook failed with exit code ${result.status}: ${details}`);
	}

	const output = parseWorktreeSetupHookOutput(result.stdout);
	if (output.syntheticPaths === undefined) return [];
	if (!Array.isArray(output.syntheticPaths)) {
		throw new Error("worktree setup hook output field 'syntheticPaths' must be an array of relative paths");
	}

	const uniquePaths = new Set<string>();
	for (const candidate of output.syntheticPaths) {
		if (typeof candidate !== "string") {
			throw new Error("worktree setup hook output field 'syntheticPaths' must contain only strings");
		}
		const normalizedPath = normalizeSyntheticPath(input.worktreePath, candidate);
		if (hasTrackedEntries(input.worktreePath, normalizedPath)) {
			throw new Error(`worktree setup hook cannot mark tracked paths as synthetic: ${normalizedPath}`);
		}
		uniquePaths.add(normalizedPath);
	}
	return [...uniquePaths];
}

/**
 * Forget exact workspace name only when inventory registers that name at the
 * recorded canonical root. Requires BOTH exact name and root match.
 * Missing recorded path → always preserve. Name re-bound to another path → never forget.
 * Returns true only when the name is confirmed absent from workspace list.
 * Never throws; false means preserve registration/path.
 */
function forgetWorkspaceProven(
	sourceRoot: string,
	workspaceName: string,
	recordedPath: string | undefined,
): { forgotten: boolean; error?: string } {
	const recorded = typeof recordedPath === "string" ? recordedPath.trim() : "";
	if (!recorded) {
		return {
			forgotten: false,
			error: "workspace forget refused: recorded workspace path missing; preserved registration/path",
		};
	}
	const recordedRoot = real(recorded);

	let before: Map<string, string>;
	try {
		before = workspaceListInventory(sourceRoot);
	} catch (error) {
		return {
			forgotten: false,
			error: `workspace inventory failed before forget: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const registeredRoot = before.get(workspaceName);
	if (registeredRoot === undefined) {
		// Already absent: registration is gone (or never held). Safe to treat as forgotten.
		return { forgotten: true };
	}
	// Name re-bound to a different path → never forget the foreign registration.
	if (real(registeredRoot) !== recordedRoot) {
		return {
			forgotten: false,
			error: `workspace forget refused: ${workspaceName} registered at different root; preserved registration/path`,
		};
	}
	const forget = runJj(sourceRoot, ["workspace", "forget", workspaceName]);
	if (forget.status !== 0) {
		return {
			forgotten: false,
			error: `workspace forget failed: ${(forget.stderr || forget.stdout).trim()}`,
		};
	}
	try {
		const after = workspaceListInventory(sourceRoot);
		if (after.has(workspaceName)) {
			return {
				forgotten: false,
				error: `workspace forget no-op: ${workspaceName} still listed`,
			};
		}
		return { forgotten: true };
	} catch (error) {
		return {
			forgotten: false,
			error: `workspace inventory failed after forget: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Predict agent cwd for a JJ worktree slot (same path formula as create).
 */
export function resolveExpectedJjWorktreeAgentCwd(
	cwd: string,
	runId: string,
	index: number,
	baseDir?: string,
): string {
	// Path prediction only — never snapshot Source or create workspaces.
	const repo = resolveRepoLayout(cwd);
	const worktreePath = buildWorktreePath(resolveWorktreeBaseDir(baseDir, repo.root), runId, index);
	return repo.cwdRelative ? path.join(worktreePath, repo.cwdRelative) : worktreePath;
}

/**
 * Query live descendants of one exact commit id.
 * Change ids are refused: they can match multiple divergent revisions.
 * Fail closed on empty/non-commit id, query failure, or ambiguity — callers must preserve.
 */
function liveDescendantsOfRevision(
	sourceRoot: string,
	revision: string,
): { ok: true; ids: string[] } | { ok: false; error: string } {
	const id = revision.trim();
	if (!isExactCommitId(id)) {
		return { ok: false, error: "descendants query refused: exact commit id required" };
	}
	const descendants = runJj(sourceRoot, [
		"--ignore-working-copy",
		"log",
		"-r",
		`descendants(${id}) ~ ${id}`,
		"--no-graph",
		"-T",
		'commit_id ++ "\\n"',
	]);
	if (descendants.status !== 0) {
		const text = (descendants.stderr || descendants.stdout).trim();
		return {
			ok: false,
			error: `descendants query failed for ${id}: ${text || "jj log failed"}`,
		};
	}
	const ids = descendants.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return { ok: true, ids };
}

function taskBase(worktree: WorktreeInfo): Pick<WorktreeCleanupTask, "index" | "path" | "branch" | "backend" | "workspaceChangeId" | "workspaceCommitId"> {
	return {
		index: worktree.index,
		path: worktree.path,
		branch: worktree.branch,
		backend: "jj",
		...(worktree.workspaceChangeId ? { workspaceChangeId: worktree.workspaceChangeId } : {}),
		...(worktree.workspaceCommitId ? { workspaceCommitId: worktree.workspaceCommitId } : {}),
	};
}

/** Test-only path-remove failpoint (set message to force failure; clear with undefined). */
let forcePathRemoveErrorForTests: string | undefined;

/** Install/clear test-only path-remove failpoint. Production never sets this. */
export function setForcePathRemoveErrorForTests(message?: string): void {
	forcePathRemoveErrorForTests = message;
}

function removeWorktreePath(worktreePath: string): { removed: boolean; error?: string } {
	if (typeof forcePathRemoveErrorForTests === "string" && forcePathRemoveErrorForTests) {
		return { removed: false, error: `path remove failed: ${forcePathRemoveErrorForTests}` };
	}
	try {
		fs.rmSync(worktreePath, { recursive: true, force: true });
		return { removed: true };
	} catch (error) {
		return {
			removed: false,
			error: `path remove failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Best-effort exact cleanup after post-add failure.
 * Destructive forget/rm only when exact workspace change identity was recorded
 * and still holds (name+root inventory + identity proven ownership). Path is
 * removed only after forget is proven by inventory. Missing recorded change id
 * or recorded path (e.g. post-add identity phase failed before capture) → preserve
 * both registration and path — never forget/rm on uncertainty or re-bound names.
 */
function rollbackOwnedWorkspace(
	sourceRoot: string,
	workspaceName: string,
	worktreePath: string,
	recorded?: { changeId?: string; baseCommit?: string },
): { pathRemoved: boolean; forgotten: boolean; abandoned: boolean; errors: string[] } {
	const errors: string[] = [];
	// Missing recorded path → always preserve (including setup-rollback).
	if (!worktreePath?.trim()) {
		errors.push(
			"setup-rollback refused: recorded workspace path missing; preserved registration/path",
		);
		return { pathRemoved: false, forgotten: false, abandoned: false, errors };
	}
	// Pre-identity: successful add but no recorded change id → preserve registration/path.
	if (!recorded?.changeId) {
		errors.push(
			"setup-rollback refused: workspace change identity not recorded; preserved registration/path",
		);
		return { pathRemoved: false, forgotten: false, abandoned: false, errors };
	}
	// If recorded identity is available and no longer holds, do not forget a re-bound foreign workspace.
	let ownedCommitId: string | undefined;
	if (fs.existsSync(worktreePath)) {
		const identity = readWorkspaceIdentity(worktreePath);
		const d0Parents =
			recorded.baseCommit ? readParentCommitIds(sourceRoot, recorded.baseCommit) : null;
		if (
			!identity ||
			identity.changeId !== recorded.changeId ||
			!isExactCommitId(identity.commitId) ||
			(recorded.baseCommit &&
				(!d0Parents || !parentsEqual(identity.parentCommitIds, d0Parents)))
		) {
			errors.push("setup-rollback refused: workspace identity uncertain or re-bound; preserved registration/path");
			return { pathRemoved: false, forgotten: false, abandoned: false, errors };
		}
		ownedCommitId = identity.commitId;
	}

	// Path gone / identity unreadable: forget may drop leftover registration, but never
	// abandon by change id. Only an exact proven workspace commit is safe to abandon.
	if (!ownedCommitId) {
		const forgetResult = forgetWorkspaceProven(sourceRoot, workspaceName, worktreePath);
		if (!forgetResult.forgotten) {
			if (forgetResult.error) errors.push(forgetResult.error);
			return { pathRemoved: false, forgotten: false, abandoned: false, errors };
		}
		errors.push(
			"setup-rollback skipped abandon: exact owned commit not proven from workspace identity; preserved history",
		);
		return { pathRemoved: true, forgotten: true, abandoned: false, errors };
	}

	// Foreign descendant of the exact owned commit: never forget/abandon.
	const wDesc = liveDescendantsOfRevision(sourceRoot, ownedCommitId);
	if (!wDesc.ok) {
		errors.push(
			`setup-rollback refused: ${wDesc.error}; preserved registration/path`,
		);
		return { pathRemoved: false, forgotten: false, abandoned: false, errors };
	}
	if (wDesc.ids.length > 0) {
		errors.push(
			`setup-rollback refused: workspace commit ${ownedCommitId} has live descendants (${wDesc.ids.join(", ")}); preserved registration/path`,
		);
		return { pathRemoved: false, forgotten: false, abandoned: false, errors };
	}

	const forgetResult = forgetWorkspaceProven(sourceRoot, workspaceName, worktreePath);
	if (!forgetResult.forgotten) {
		if (forgetResult.error) errors.push(forgetResult.error);
		return { pathRemoved: false, forgotten: false, abandoned: false, errors };
	}

	let abandoned = false;
	const abandon = runJj(sourceRoot, ["abandon", ownedCommitId]);
	if (abandon.status !== 0 && !isMissingRevision(abandon.stderr, abandon.stdout)) {
		errors.push(`abandon failed: ${(abandon.stderr || abandon.stdout).trim()}`);
		// Registration already dropped; keep path when abandon fails.
		return { pathRemoved: false, forgotten: true, abandoned: false, errors };
	}
	abandoned = true;

	if (fs.existsSync(worktreePath)) {
		const removed = removeWorktreePath(worktreePath);
		if (!removed.removed) {
			if (removed.error) errors.push(removed.error);
			return { pathRemoved: false, forgotten: true, abandoned, errors };
		}
	}
	return { pathRemoved: true, forgotten: true, abandoned, errors };
}

function createSingleJjWorktree(
	repo: JjRepoState,
	runId: string,
	index: number,
	baseDir: string,
	setupHook: ResolvedWorktreeSetupHook | undefined,
	agent: string | undefined,
): WorktreeInfo {
	const workspaceName = buildWorkspaceName(runId, index);
	const worktreePath = buildWorktreePath(baseDir, runId, index);

	if (fs.existsSync(worktreePath)) {
		throw new Error(`JJ worktree path already exists: ${worktreePath}`);
	}
	const existing = workspaceListNames(repo.root);
	if (existing.has(workspaceName)) {
		throw new Error(`JJ workspace name collision: ${workspaceName}`);
	}

	// 1) Owned duplicate D0 of frozen S0 (sibling of Source, not a child of Source @).
	const dup = duplicateOwnedBase(repo.root, repo.baseCommit);
	const d0 = dup.duplicateCommitId;
	const dChange = dup.duplicateChangeId;
	const d0Parents = dup.parentCommitIds;

	// 2) workspace add -r D0 → bootstrap WC C with parent D0.
	const add = runJj(repo.root, [
		"workspace",
		"add",
		"--name",
		workspaceName,
		"-r",
		d0,
		worktreePath,
	]);
	if (add.status !== 0) {
		let nameAppeared = false;
		try {
			nameAppeared = workspaceListNames(repo.root).has(workspaceName);
		} catch {
			nameAppeared = true;
		}
		const pathExists = fs.existsSync(worktreePath);
		// Best-effort abandon the exact D0 commit if add failed cleanly.
		if (!pathExists && !nameAppeared) {
			abandonRevisionIfSafe(repo.root, d0);
		}
		if (pathExists || nameAppeared) {
			throw new Error(
				`jj workspace add failed with partial identity retained (${workspaceName}): ${(add.stderr || add.stdout).trim()}`,
			);
		}
		throw new Error(`jj workspace add failed: ${(add.stderr || add.stdout).trim()}`);
	}

	const resolvedPath = real(worktreePath);
	let recordedChangeId: string | undefined = dChange;
	try {
		// 3) Move workspace @ onto D itself (drop bootstrap C).
		runJjChecked(resolvedPath, ["edit", dChange]);
		runJjChecked(resolvedPath, ["util", "snapshot"]);
		const identity = readWorkspaceIdentity(resolvedPath);
		if (!identity) {
			throw new Error(`workspace @ identity read failed for ${workspaceName}`);
		}
		if (identity.changeId !== dChange) {
			throw new Error(
				`workspace @ change must be owned D ${dChange}, got ${identity.changeId}`,
			);
		}
		// Initially @ commit is D0; after edit it may already equal D0.
		if (identity.commitId !== d0) {
			// After edit onto D, @ should be D0 before any Child writes.
			// Accept only if still same change and parents match D0 parents.
			const parents = identity.parentCommitIds;
			if (!parentsEqual(parents, d0Parents)) {
				throw new Error(
					`workspace @ parents must equal parents(D0), got [${parents.join(", ")}] expected [${d0Parents.join(", ")}]`,
				);
			}
		} else if (!parentsEqual(identity.parentCommitIds, d0Parents)) {
			throw new Error(
				`workspace @ parents must equal parents(D0), got [${identity.parentCommitIds.join(", ")}]`,
			);
		}
		// D0 must still resolve (capture base).
		const d0Still = runJj(repo.root, [
			"--ignore-working-copy",
			"log",
			"-r",
			d0,
			"--no-graph",
			"-T",
			"commit_id",
		]);
		if (d0Still.status !== 0 || d0Still.stdout.trim() !== d0) {
			throw new Error(`initial D0 ${d0} no longer resolves after workspace edit`);
		}

		const nodeModulesLinked = linkNodeModulesIfPresent(repo.root, resolvedPath);
		const syntheticPaths = nodeModulesLinked ? ["node_modules"] : [];
		const agentCwd = repo.cwdRelative ? path.join(resolvedPath, repo.cwdRelative) : resolvedPath;

		if (setupHook) {
			const hookSyntheticPaths = runWorktreeSetupHook(setupHook, {
				version: 1,
				repoRoot: repo.root,
				worktreePath: resolvedPath,
				agentCwd,
				branch: workspaceName,
				index,
				runId,
				// Hook sees S0 freeze (shared); Child WC is D.
				baseCommit: repo.baseCommit,
				agent,
			});
			syntheticPaths.push(...hookSyntheticPaths);
		}

		return {
			path: resolvedPath,
			agentCwd,
			branch: workspaceName,
			index,
			nodeModulesLinked,
			syntheticPaths,
			workspaceChangeId: dChange,
			// Initial D0 commit — capture base; fail closed later if missing.
			workspaceCommitId: d0,
			backend: "jj",
		};
	} catch (error) {
		rollbackOwnedWorkspace(repo.root, workspaceName, resolvedPath, {
			changeId: recordedChangeId,
			// Parent check uses D0 parents via workspaceCommitId; rollback abandons
			// the exact current owned commit when identity is proven.
			baseCommit: d0,
		});
		throw error;
	}
}

export function createJjWorktrees(
	cwd: string,
	runId: string,
	count: number,
	options?: CreateWorktreesOptions,
): WorktreeSetup {
	// Validate hook/baseDir before creating any D so invalid config leaves no residue.
	const layout = resolveRepoLayout(cwd);
	const setupHook = resolveWorktreeSetupHook(layout.root, options?.setupHook);
	const baseDir = resolveWorktreeBaseDir(options?.baseDir, layout.root);

	const frozen = snapshotSourceS0(layout.root);
	const repo: JjRepoState = {
		...layout,
		baseCommit: frozen.sourceBaseCommit,
		baseChange: frozen.baseChange,
	};
	const setup: WorktreeSetup = {
		cwd: repo.root,
		worktrees: [],
		baseCommit: repo.baseCommit,
		backend: "jj",
	};
	try {
		for (let index = 0; index < count; index++) {
			setup.worktrees.push(
				createSingleJjWorktree(repo, runId, index, baseDir, setupHook, options?.agents?.[index]),
			);
		}
	} catch (error) {
		cleanupJjWorktrees(setup, { kind: "setup-rollback" });
		throw error;
	}
	return setup;
}

function isInsideResolvedRoot(candidate: string, root: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function fsErrorCode(error: unknown): unknown {
	return error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
}

/**
 * Delete one synthetic path without following any intermediate symlink.
 * Fail closed on every intermediate symbolic link, even when its real target
 * remains inside the workspace. The final path itself may be a symlink and is
 * unlinked without following it.
 */
function removeSyntheticPath(worktreePath: string, syntheticPath: string): void {
	const resolved = path.resolve(worktreePath, syntheticPath);
	const relative = path.relative(worktreePath, resolved);
	if (!relative || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return;
	}

	const workspaceRoot = real(worktreePath);
	const parts = relative.split(path.sep).filter((part) => part && part !== ".");
	let current = worktreePath;
	for (let index = 0; index < parts.length; index++) {
		current = path.join(current, parts[index]!);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(current);
		} catch (error) {
			if (fsErrorCode(error) === "ENOENT") return;
			throw error;
		}

		const isLast = index === parts.length - 1;
		if (stat.isSymbolicLink()) {
			if (isLast) {
				fs.unlinkSync(current);
				return;
			}
			// Intermediate symlink: never follow, even if the target is in-workspace.
			throw new Error(
				`synthetic path escapes the JJ workspace via intermediate symlink: ${syntheticPath}`,
			);
		}

		if (!isLast) {
			if (!stat.isDirectory()) return;
			const dirReal = real(current);
			if (!isInsideResolvedRoot(dirReal, workspaceRoot)) {
				throw new Error(
					`synthetic path escapes the JJ workspace via intermediate symlink: ${syntheticPath}`,
				);
			}
			continue;
		}

		const finalReal = real(current);
		if (!isInsideResolvedRoot(finalReal, workspaceRoot)) {
			throw new Error(
				`synthetic path escapes the JJ workspace via intermediate symlink: ${syntheticPath}`,
			);
		}
		if (stat.isDirectory()) fs.rmSync(current, { recursive: true, force: true });
		else fs.unlinkSync(current);
	}
}

function removeSyntheticPaths(worktree: WorktreeInfo): void {
	const seen = new Set<string>();
	for (const syntheticPath of worktree.syntheticPaths) {
		if (seen.has(syntheticPath)) continue;
		seen.add(syntheticPath);
		removeSyntheticPath(worktree.path, syntheticPath);
	}
}

/**
 * After the first successful Child snapshot, delete synthetic paths and record
 * the deletion in the authoritative WC commit before any --ignore-working-copy
 * read. Never calls update-stale.
 */
function applySyntheticRemovalToAuthoritativeSnapshot(
	worktree: WorktreeInfo,
): { ok: true } | { ok: false; reason: string } {
	if (worktree.syntheticPaths.length === 0) return { ok: true };
	removeSyntheticPaths(worktree);
	const snap = runJj(worktree.path, ["util", "snapshot"]);
	if (snap.status !== 0) {
		const detail = (snap.stderr || snap.stdout).trim() || "jj util snapshot failed";
		return {
			ok: false,
			reason: `snapshot after synthetic path removal failed (workspace bytes preserved): ${detail}`,
		};
	}
	return { ok: true };
}

function captureJjDiff(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	agent: string,
	patchPath: string,
): WorktreeDiff {
	// Verify the exact registered workspace and owned Child change before a
	// snapshot. Full topology is checked after snapshot so stale Child bytes are
	// preserved before a concurrent external rewrite can make them unreadable.
	if (!ownedWorkspaceRegistrationStillHolds(setup, worktree)) {
		throw new Error("workspace registration or change identity drifted; capture refused");
	}
	const prepared = prepareChildWorkspaceSnapshotFirst(worktree.path);
	if (!prepared.ok) {
		throw new Error(prepared.reason);
	}
	if (!ownedIdentityStillHolds(setup, worktree)) {
		throw new Error("workspace identity drifted after snapshot; capture refused");
	}
	const synthetics = applySyntheticRemovalToAuthoritativeSnapshot(worktree);
	if (!synthetics.ok) {
		throw new Error(synthetics.reason);
	}
	if (worktree.syntheticPaths.length > 0 && !ownedIdentityStillHolds(setup, worktree)) {
		throw new Error("workspace identity drifted after synthetic path removal; capture refused");
	}
	// Diff from initial D0; fail closed if D0 no longer resolves.
	const d0 = worktree.workspaceCommitId;
	if (!d0 || !/^[0-9a-f]{40}$/.test(d0)) {
		throw new Error("missing initial D0 (workspaceCommitId) for capture");
	}
	const d0Check = runJj(setup.cwd, [
		"--ignore-working-copy",
		"log",
		"-r",
		d0,
		"--no-graph",
		"-T",
		"commit_id",
	]);
	if (d0Check.status !== 0 || d0Check.stdout.trim() !== d0) {
		throw new Error(`initial D0 ${d0} no longer resolves; capture refused`);
	}
	const diff = runJj(worktree.path, [
		"--ignore-working-copy",
		"diff",
		"--from",
		d0,
		"--to",
		"@",
		"--git",
	]);
	if (diff.status !== 0) {
		throw new Error(`jj diff failed: ${(diff.stderr || diff.stdout).trim()}`);
	}
	const patch = diff.stdout;
	fs.writeFileSync(patchPath, patch, "utf-8");
	if (!patch.trim()) {
		return emptyDiff(worktree.index, agent, worktree.branch, patchPath);
	}
	// Approximate numstat from git-format patch headers for stock shape.
	const fileHeaders = patch.match(/^diff --git /gm);
	const filesChanged = fileHeaders?.length ?? 0;
	let insertions = 0;
	let deletions = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
		else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
	}
	const statLines = [` ${filesChanged} files changed, ${insertions} insertions(+), ${deletions} deletions(-)`];
	return {
		index: worktree.index,
		agent,
		branch: worktree.branch,
		diffStat: statLines.join("\n"),
		filesChanged,
		insertions,
		deletions,
		patchPath,
	};
}

export function diffJjWorktrees(setup: WorktreeSetup, agents: string[], diffsDir: string): WorktreeDiff[] {
	try {
		fs.mkdirSync(diffsDir, { recursive: true });
	} catch {
		return [];
	}
	const diffs: WorktreeDiff[] = [];
	for (let index = 0; index < setup.worktrees.length; index++) {
		const worktree = setup.worktrees[index]!;
		const agent = agents[index] ?? `task-${index + 1}`;
		const patchPath = path.join(diffsDir, `task-${index}-${safePatchAgentName(agent)}.patch`);
		try {
			diffs.push(captureJjDiff(setup, worktree, agent, patchPath));
		} catch (error) {
			writeEmptyPatch(patchPath);
			diffs.push(
				emptyDiff(index, agent, worktree.branch, patchPath, error instanceof Error ? error.message : String(error)),
			);
		}
	}
	setup.capturedDiffs = diffs;
	return diffs;
}

function handoffRecordsPatch(manifestPath: string | undefined, patchPath: string): boolean {
	if (!manifestPath || !fs.existsSync(manifestPath)) return false;
	try {
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
			version?: unknown;
			groups?: Array<{ children?: Array<{ patch?: { path?: unknown; error?: unknown } }> }>;
		};
		if (manifest.version !== 1 || !Array.isArray(manifest.groups)) return false;
		const resolvedPatchPath = path.resolve(patchPath);
		return manifest.groups.some(
			(group) =>
				Array.isArray(group.children) &&
				group.children.some(
					(child) =>
						child.patch?.error === undefined &&
						typeof child.patch?.path === "string" &&
						path.resolve(child.patch.path) === resolvedPatchPath,
				),
		);
	} catch {
		return false;
	}
}

function hasWorkInWorkspace(setup: WorktreeSetup, worktree: WorktreeInfo): { ok: true; hasWork: boolean } | { ok: false; reason: string } {
	if (!fs.existsSync(worktree.path)) {
		return { ok: false, reason: "workspace path missing" };
	}
	const d0 = worktree.workspaceCommitId;
	if (!d0 || !/^[0-9a-f]{40}$/.test(d0)) {
		return { ok: false, reason: "missing initial D0 (workspaceCommitId)" };
	}
	const d0Check = runJj(setup.cwd, [
		"--ignore-working-copy",
		"log",
		"-r",
		d0,
		"--no-graph",
		"-T",
		"commit_id",
	]);
	if (d0Check.status !== 0 || d0Check.stdout.trim() !== d0) {
		return { ok: false, reason: `initial D0 ${d0} no longer resolves` };
	}
	const diff = runJj(worktree.path, [
		"--ignore-working-copy",
		"diff",
		"--from",
		d0,
		"--to",
		"@",
		"--git",
	]);
	if (diff.status !== 0) {
		return { ok: false, reason: `diff check failed: ${(diff.stderr || diff.stdout).trim()}` };
	}
	return { ok: true, hasWork: diff.stdout.trim().length > 0 };
}

function ownedWorkspaceRegistrationStillHolds(setup: WorktreeSetup, worktree: WorktreeInfo): boolean {
	if (!worktree.workspaceChangeId || !worktree.path?.trim() || !worktree.branch?.trim()) return false;
	let inventory: Map<string, string>;
	try {
		inventory = workspaceListInventory(setup.cwd);
	} catch {
		return false;
	}
	const registeredRoot = inventory.get(worktree.branch);
	if (registeredRoot === undefined || real(registeredRoot) !== real(worktree.path)) return false;
	const identity = readWorkspaceIdentity(worktree.path);
	return identity?.changeId === worktree.workspaceChangeId;
}

function ownedIdentityStillHolds(setup: WorktreeSetup, worktree: WorktreeInfo): boolean {
	if (!worktree.workspaceCommitId || !ownedWorkspaceRegistrationStillHolds(setup, worktree)) return false;
	const d0 = worktree.workspaceCommitId;
	// D0 must still resolve (capture/cleanup base).
	const d0Check = runJj(setup.cwd, [
		"--ignore-working-copy",
		"log",
		"-r",
		d0,
		"--no-graph",
		"-T",
		"commit_id",
	]);
	if (d0Check.status !== 0 || d0Check.stdout.trim() !== d0) return false;
	const d0Parents = readParentCommitIds(setup.cwd, d0);
	if (!d0Parents) return false;
	const identity = readWorkspaceIdentity(worktree.path);
	if (!identity || !parentsEqual(identity.parentCommitIds, d0Parents)) return false;
	return true;
}

function cleanupSingleJjWorktree(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	intent: WorktreeCleanupIntent,
): WorktreeCleanupTask {
	const errors: string[] = [];
	const base = taskBase(worktree);

	if (intent.kind === "setup-rollback") {
		// Setup-rollback: destructive only for name+root inventory + identity-proven ownership.
		// Missing recorded path or change id → preserve registration/path.
		if (!worktree.path?.trim()) {
			return {
				...base,
				worktreeRemoved: false,
				branchRemoved: false,
				preserved: true,
				reason: "setup-rollback refused: recorded workspace path missing",
				errors: [
					"setup-rollback refused: recorded workspace path missing; preserved registration/path",
				],
			};
		}
		if (!worktree.workspaceChangeId) {
			return {
				...base,
				worktreeRemoved: false,
				branchRemoved: false,
				preserved: true,
				reason: "setup-rollback refused: workspace change identity not recorded",
				errors: [
					"setup-rollback refused: workspace change identity not recorded; preserved registration/path",
				],
			};
		}
		// Never forget a re-bound foreign workspace; path only after proven forget.
		if (fs.existsSync(worktree.path) && !ownedIdentityStillHolds(setup, worktree)) {
			return {
				...base,
				worktreeRemoved: false,
				branchRemoved: false,
				preserved: true,
				reason: "setup-rollback refused: workspace identity uncertain or re-bound",
				errors: ["setup-rollback refused: workspace identity uncertain or re-bound; preserved registration/path"],
			};
		}
		const result = rollbackOwnedWorkspace(setup.cwd, worktree.branch, worktree.path, {
			changeId: worktree.workspaceChangeId,
			baseCommit: worktree.workspaceCommitId, // D0
		});
		errors.push(...result.errors);
		if (!result.forgotten) {
			return {
				...base,
				worktreeRemoved: false,
				branchRemoved: false,
				preserved: true,
				reason: "setup-rollback preserve: forget unproven",
				...(errors.length ? { errors } : {}),
			};
		}
		// Report consistency: path-still-present after forget means worktreeRemoved=false.
		// abandon fail → branchRemoved=false; rm fail after abandon → branchRemoved=true + preserved.
		if (!result.pathRemoved && fs.existsSync(worktree.path)) {
			if (!result.abandoned) {
				return {
					...base,
					worktreeRemoved: false,
					branchRemoved: false,
					preserved: true,
					reason: "abandon failed after forget",
					...(errors.length ? { errors } : {}),
				};
			}
			return {
				...base,
				worktreeRemoved: false,
				branchRemoved: true,
				preserved: true,
				reason: "path remove failed",
				...(errors.length ? { errors } : {}),
			};
		}
		return {
			...base,
			worktreeRemoved: true,
			branchRemoved: result.abandoned,
			...(result.abandoned ? {} : { preserved: true, reason: "abandon failed after forget" }),
			...(errors.length ? { errors } : {}),
		};
	}

	// Prove exact workspace registration and the owned Child change before a
	// snapshot. A path can be replaced by a foreign workspace; never touch it.
	if (!ownedWorkspaceRegistrationStillHolds(setup, worktree)) {
		return {
			...base,
			worktreeRemoved: false,
			branchRemoved: false,
			preserved: true,
			reason: "workspace identity uncertain; preserved",
			errors: ["cleanup refused: workspace registration or change identity drifted or unreadable"],
		};
	}
	// Snapshot Child bytes before rejecting a stale or externally rewritten WC.
	const prepared = prepareChildWorkspaceSnapshotFirst(worktree.path);
	if (!prepared.ok) {
		return {
			...base,
			worktreeRemoved: false,
			branchRemoved: false,
			preserved: true,
			reason: "cleanup safety check failed",
			errors: [`cleanup refused: ${prepared.reason}`],
		};
	}
	if (!ownedIdentityStillHolds(setup, worktree)) {
		return {
			...base,
			worktreeRemoved: false,
			branchRemoved: false,
			preserved: true,
			reason: "workspace identity uncertain; preserved",
			errors: ["cleanup refused: workspace topology drifted after snapshot"],
		};
	}
	try {
		const synthetics = applySyntheticRemovalToAuthoritativeSnapshot(worktree);
		if (!synthetics.ok) {
			return {
				...base,
				worktreeRemoved: false,
				branchRemoved: false,
				preserved: true,
				reason: "cleanup safety check failed",
				errors: [...errors, `cleanup refused: ${synthetics.reason}`],
			};
		}
	} catch (error) {
		return {
			...base,
			worktreeRemoved: false,
			branchRemoved: false,
			preserved: true,
			reason: "cleanup safety check failed",
			errors: [
				...errors,
				`cleanup refused: synthetic path cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
			],
		};
	}
	if (worktree.syntheticPaths.length > 0 && !ownedIdentityStillHolds(setup, worktree)) {
		return {
			...base,
			worktreeRemoved: false,
			branchRemoved: false,
			preserved: true,
			reason: "workspace identity uncertain; preserved",
			errors: [...errors, "cleanup refused: workspace topology drifted after synthetic path removal"],
		};
	}
	const work = hasWorkInWorkspace(setup, worktree);
	if (!work.ok) {
		return {
			...base,
			worktreeRemoved: false,
			branchRemoved: false,
			preserved: true,
			reason: "cleanup safety check failed",
			errors: [...errors, `cleanup refused: ${work.reason}`],
		};
	}
	if (work.hasWork && intent.kind === "preserve") {
		const captured = (intent.capturedDiffs ?? setup.capturedDiffs)?.find((diff) => diff.index === worktree.index);
		const patchCaptured =
			captured !== undefined &&
			captured.error === undefined &&
			fs.existsSync(captured.patchPath) &&
			fs.statSync(captured.patchPath).size > 0 &&
			handoffRecordsPatch(intent.handoffManifestPath, captured.patchPath);
		if (!patchCaptured) {
			const reason = "worktree contains changes that are not represented by a captured handoff patch";
			return {
				...base,
				worktreeRemoved: false,
				branchRemoved: false,
				preserved: true,
				reason,
				errors: [...errors, `cleanup refused: ${reason}; preserved ${worktree.path}`],
			};
		}
	}
	if (work.hasWork && intent.kind === "discard") {
		const decision = resolveAuthorityDecision({ action: "discardWorktree", policy: intent.authorization.policy });
		const authorized = decision === "auto" || (decision === "confirm" && intent.authorization.kind === "confirmed");
		if (!authorized) {
			const reason =
				decision === "forbid"
					? "authority policy forbids worktree discard"
					: "worktree discard requires explicit user confirmation";
			return {
				...base,
				worktreeRemoved: false,
				branchRemoved: false,
				preserved: true,
				reason,
				errors: [...errors, `cleanup refused: ${reason}; preserved ${worktree.path}`],
			};
		}
	}
	// Conservative identity re-check before any forget/abandon.
	if (!ownedIdentityStillHolds(setup, worktree)) {
		return {
			...base,
			worktreeRemoved: false,
			branchRemoved: false,
			preserved: true,
			reason: "workspace identity uncertain; preserved",
			errors: [...errors, "cleanup refused: workspace change identity drifted or unreadable"],
		};
	}

	// Destructive descendant/abandon must use the current workspace commit, not D0
	// and not a possibly-divergent change id. workspaceCommitId stays D0.
	const ownedIdentity = readWorkspaceIdentity(worktree.path);
	if (
		!ownedIdentity ||
		ownedIdentity.changeId !== worktree.workspaceChangeId ||
		!isExactCommitId(ownedIdentity.commitId)
	) {
		return {
			...base,
			worktreeRemoved: false,
			branchRemoved: false,
			preserved: true,
			reason: "workspace identity uncertain; preserved",
			errors: [...errors, "cleanup refused: exact owned workspace commit not proven"],
		};
	}
	const ownedCommitId = ownedIdentity.commitId;

	// Foreign descendant of the exact owned commit: preserve registration/path.
	const wDesc = liveDescendantsOfRevision(setup.cwd, ownedCommitId);
	if (!wDesc.ok) {
		return {
			...base,
			worktreeRemoved: false,
			branchRemoved: false,
			preserved: true,
			reason: "workspace descendants query failed; preserved",
			errors: [...errors, `cleanup refused: ${wDesc.error}; preserved registration/path`],
		};
	}
	if (wDesc.ids.length > 0) {
		return {
			...base,
			worktreeRemoved: false,
			branchRemoved: false,
			preserved: true,
			reason: "workspace has live foreign descendants; preserved",
			errors: [
				...errors,
				`cleanup refused: workspace commit ${ownedCommitId} has live descendants (${wDesc.ids.join(", ")}); preserved registration/path`,
			],
		};
	}

	const forgetResult = forgetWorkspaceProven(setup.cwd, worktree.branch, worktree.path);
	if (!forgetResult.forgotten) {
		return {
			...base,
			worktreeRemoved: false,
			branchRemoved: false,
			preserved: true,
			reason: "workspace forget failed",
			errors: [...errors, forgetResult.error ?? "workspace forget unproven"],
		};
	}

	// Abandon only the exact current owned commit.
	const abandon = runJj(setup.cwd, ["abandon", ownedCommitId]);
	if (abandon.status !== 0 && !isMissingRevision(abandon.stderr, abandon.stdout)) {
		// forget succeeded but abandon failed: while path exists, worktreeRemoved=false;
		// branch/change removal flag remains false (change not abandoned).
		const pathStillThere = fs.existsSync(worktree.path);
		return {
			...base,
			worktreeRemoved: !pathStillThere,
			branchRemoved: false,
			preserved: true,
			reason: "abandon failed after forget",
			errors: [...errors, `abandon failed: ${(abandon.stderr || abandon.stdout).trim()}`],
		};
	}

	if (fs.existsSync(worktree.path)) {
		const removed = removeWorktreePath(worktree.path);
		if (!removed.removed) {
			if (removed.error) errors.push(removed.error);
			// forget+abandon succeeded; path still present → worktreeRemoved=false, branchRemoved=true, preserved.
			return {
				...base,
				worktreeRemoved: false,
				branchRemoved: true,
				preserved: true,
				reason: "path remove failed",
				...(errors.length ? { errors } : {}),
			};
		}
	}

	return {
		...base,
		worktreeRemoved: true,
		branchRemoved: true,
		...(errors.length ? { errors } : {}),
	};
}

export function cleanupJjWorktrees(
	setup: WorktreeSetup,
	intent: WorktreeCleanupIntent = {
		kind: "preserve",
		...(setup.capturedDiffs ? { capturedDiffs: setup.capturedDiffs } : {}),
	},
): WorktreeCleanupReport {
	const tasks: WorktreeCleanupTask[] = [];
	// Order: forget + abandon each owned W + remove path first.
	for (let index = setup.worktrees.length - 1; index >= 0; index--) {
		tasks.push(cleanupSingleJjWorktree(setup, setup.worktrees[index]!, intent));
	}
	tasks.sort((left, right) => left.index - right.index);

	const allOwnedWClean =
		tasks.length === 0 ||
		tasks.every((task) => task.worktreeRemoved && task.branchRemoved && !task.preserved);

	// No long-lived F: each W owns its D and abandons it during per-W cleanup.
	const state = allOwnedWClean ? "complete" : "partial";
	return {
		state,
		tasks,
		pruned: state === "complete",
	};
}
