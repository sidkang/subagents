import assert from "node:assert/strict";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
	cleanupWorktrees as cleanupForkWorktrees,
	createWorktrees as createForkWorktrees,
	diffWorktrees as diffForkWorktrees,
} from "../../src/runs/shared/worktree.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const overlaySource = join(root, "src/runs/shared/jj-worktree-backend.ts");

function sh(cwd, cmd, args, env) {
	return spawnSync(cmd, args, { cwd, encoding: "utf8", env: env ?? process.env });
}

function createTempJjSource(prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const init = sh(dir, "jj", ["git", "init", "--colocate"]);
	if (init.status !== 0) {
		const init2 = sh(dir, "jj", ["init", "--git"]);
		if (init2.status !== 0) {
			throw new Error(`jj init failed: ${init.stderr || init2.stderr}`);
		}
	}
	writeFileSync(join(dir, "README.md"), "# fixture\n");
	const desc = sh(dir, "jj", ["describe", "-m", "init"]);
	if (desc.status !== 0) throw new Error(desc.stderr || "jj describe failed");
	const newc = sh(dir, "jj", ["new"]);
	if (newc.status !== 0) throw new Error(newc.stderr || "jj new failed");
	return dir;
}

function createTempGitRepo(prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	sh(dir, "git", ["init"]);
	sh(dir, "git", ["config", "user.email", "test@example.com"]);
	sh(dir, "git", ["config", "user.name", "test"]);
	writeFileSync(join(dir, "README.md"), "# git fixture\n");
	sh(dir, "git", ["add", "."]);
	sh(dir, "git", ["commit", "-m", "init"]);
	return dir;
}

function writeGetAgentDirStub(staging) {
	const utilsDir = join(staging, "src", "shared");
	mkdirSync(utilsDir, { recursive: true });
	writeFileSync(
		join(utilsDir, "utils.ts"),
		[
			'import * as os from "node:os";',
			'import * as path from "node:path";',
			"export function getAgentDir() {",
			"\tconst configured = process.env.PI_CODING_AGENT_DIR;",
			'\tif (configured === "~") return os.homedir();',
			'\tif (configured?.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));',
			'\treturn configured || path.join(os.homedir(), ".pi", "agent");',
			"}",
			"",
		].join("\n"),
	);
}

async function stageHandoffModule() {
	const staging = mkdtempSync(join(tmpdir(), "subagents-handoff-stage-"));
	const sharedDir = join(staging, "src/runs/shared");
	const sharedRoot = join(staging, "src/shared");
	const policyDir = join(staging, "src/policy");
	mkdirSync(sharedDir, { recursive: true });
	mkdirSync(sharedRoot, { recursive: true });
	mkdirSync(policyDir, { recursive: true });
	cpSync(join(root, "src/runs/shared/parallel-handoff.ts"), join(sharedDir, "parallel-handoff.ts"));
	cpSync(overlaySource, join(sharedDir, "jj-worktree-backend.ts"));
	writeGetAgentDirStub(staging);
	writeFileSync(
		join(sharedDir, "worktree.ts"),
		`import { cleanupJjWorktrees } from "./jj-worktree-backend.ts";
export function cleanupWorktrees(setup, intent) {
  if (setup?.backend === "jj" || setup?.worktrees?.some((wt) => wt?.backend === "jj")) {
    return cleanupJjWorktrees(setup, intent);
  }
  throw new Error("expected JJ setup in handoff discard test");
}
`,
	);
	writeFileSync(join(sharedRoot, "types.ts"), "export /** @typedef {string} SubagentResultStatus */\n");
	writeFileSync(
		join(sharedRoot, "atomic-json.ts"),
		`import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
export function writeAtomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}
`,
	);
	writeFileSync(join(policyDir, "authority.ts"), "export function resolveAuthorityDecision(){return 'auto';}\n");
	const handoff = await import(pathToFileURL(join(sharedDir, "parallel-handoff.ts")).href + `?h=${Date.now()}-${Math.random()}`);
	return { staging, handoff };
}

async function loadBackend() {
	assert.ok(existsSync(overlaySource));

	const staging = mkdtempSync(join(tmpdir(), "subagents-backend-load-"));
	const sharedDir = join(staging, "src", "runs", "shared");
	const policyDir = join(staging, "src", "policy");
	mkdirSync(sharedDir, { recursive: true });
	mkdirSync(policyDir, { recursive: true });
	cpSync(overlaySource, join(sharedDir, "jj-worktree-backend.ts"));
	writeFileSync(
		join(policyDir, "authority.ts"),
		["export function resolveAuthorityDecision() { return 'auto'; }", ""].join("\n"),
	);
	writeGetAgentDirStub(staging);
	globalThis.__subagentsBackendStagings ??= [];
	globalThis.__subagentsBackendStagings.push(staging);
	return import(pathToFileURL(join(sharedDir, "jj-worktree-backend.ts")).href + `?t=${Date.now()}-${Math.random()}`);
}

function writeHook(dir, body) {
	const hookPath = join(dir, "setup-hook.sh");
	writeFileSync(hookPath, body);
	chmodSync(hookPath, 0o755);
	return hookPath;
}

function makeJjPathWrapper(mode) {
	// mode: 'fail-forget' | 'fail-update-stale' | 'fail-edit' | 'fail-abandon' | 'fail-file-list' | 'fail-second-snapshot' | 'count' | 'pass'
	const bin = mkdtempSync(join(tmpdir(), "subagents-path-"));
	const realJj = spawnSync("which", ["jj"], { encoding: "utf8" }).stdout.trim();
	assert.ok(realJj, "jj must be on PATH");
	const wrapper = join(bin, "jj");
	if (mode === "fail-forget") {
		writeFileSync(
			wrapper,
			`#!/bin/sh
if [ "$1" = "workspace" ] && [ "$2" = "forget" ]; then
  echo "forced forget failure" >&2
  exit 1
fi
exec ${JSON.stringify(realJj)} "$@"
`,
		);
	} else if (mode === "fail-update-stale") {
		// Legacy alias: post-add identity used to call update-stale.
		writeFileSync(
			wrapper,
			`#!/bin/sh
if [ "$1" = "workspace" ] && [ "$2" = "update-stale" ]; then
  echo "forced update-stale failure" >&2
  exit 1
fi
exec ${JSON.stringify(realJj)} "$@"
`,
		);
	} else if (mode === "fail-edit") {
		// Post-add identity phase: workspace add succeeds, then edit onto D fails
		// before ownership is fully proven for destructive cleanup.
		writeFileSync(
			wrapper,
			`#!/bin/sh
if [ "$1" = "edit" ]; then
  echo "forced edit failure" >&2
  exit 1
fi
exec ${JSON.stringify(realJj)} "$@"
`,
		);
	} else if (mode === "fail-abandon") {
		// Allow workspace forget; fail change abandon (including owned D).
		writeFileSync(
			wrapper,
			`#!/bin/sh
if [ "$1" = "abandon" ]; then
  echo "forced abandon failure" >&2
  exit 1
fi
exec ${JSON.stringify(realJj)} "$@"
`,
		);
	} else if (mode === "fail-file-list") {
		writeFileSync(
			wrapper,
			`#!/bin/sh
prev=""
for arg in "$@"; do
  if [ "$prev" = "file" ] && [ "$arg" = "list" ]; then
    echo "forced file list failure" >&2
    exit 1
  fi
  prev="$arg"
done
exec ${JSON.stringify(realJj)} "$@"
`,
		);
	} else if (mode === "fail-second-snapshot") {
		const counter = join(bin, "snapshot.count");
		writeFileSync(
			wrapper,
			`#!/bin/sh
counter=${JSON.stringify(counter)}
prev=""
for arg in "$@"; do
  if [ "$prev" = "util" ] && [ "$arg" = "snapshot" ]; then
    n=0
    [ -f "$counter" ] && n=$(cat "$counter")
    n=$((n + 1))
    printf '%s' "$n" > "$counter"
    if [ "$n" -ge 2 ]; then
      echo "forced second snapshot failure" >&2
      exit 1
    fi
    break
  fi
  prev="$arg"
done
exec ${JSON.stringify(realJj)} "$@"
`,
		);
	} else if (mode === "count") {
		const logPath = join(bin, "jj-calls.log");
		writeFileSync(
			wrapper,
			`#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
exec ${JSON.stringify(realJj)} "$@"
`,
		);
	} else {
		writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(realJj)} "$@"\n`);
	}
	chmodSync(wrapper, 0o755);
	return bin;
}

/**
 * Create a visible external revision that shares the workspace change id but
 * not the current commit. The workspace @ is restored to the original commit.
 */
function createExternalDivergentSibling(workspacePath, uniqueName = "foreign-divergent.txt") {
	const ownedChange = sh(workspacePath, "jj", [
		"--ignore-working-copy",
		"log",
		"-r",
		"@",
		"--no-graph",
		"-T",
		"change_id",
	]).stdout.trim();
	const ownedCommit = sh(workspacePath, "jj", [
		"--ignore-working-copy",
		"log",
		"-r",
		"@",
		"--no-graph",
		"-T",
		"commit_id",
	]).stdout.trim();
	assert.match(ownedCommit, /^[0-9a-f]{40}$/);
	writeFileSync(join(workspacePath, uniqueName), "FOREIGN_DIVERGENT_CONTENT\n");
	const described = sh(workspacePath, "jj", ["describe", "-m", "external divergent rewrite"]);
	assert.equal(described.status, 0, described.stderr || described.stdout);
	const divergentCommit = sh(workspacePath, "jj", [
		"--ignore-working-copy",
		"log",
		"-r",
		"@",
		"--no-graph",
		"-T",
		"commit_id",
	]).stdout.trim();
	assert.match(divergentCommit, /^[0-9a-f]{40}$/);
	assert.notEqual(divergentCommit, ownedCommit);
	const newWc = sh(workspacePath, "jj", ["new"]);
	assert.equal(newWc.status, 0, newWc.stderr || newWc.stdout);
	const leftover = sh(workspacePath, "jj", [
		"--ignore-working-copy",
		"log",
		"-r",
		"@",
		"--no-graph",
		"-T",
		"commit_id",
	]).stdout.trim();
	const edited = sh(workspacePath, "jj", ["edit", ownedCommit]);
	assert.equal(edited.status, 0, edited.stderr || edited.stdout);
	if (leftover && leftover !== ownedCommit && leftover !== divergentCommit) {
		sh(workspacePath, "jj", ["abandon", leftover]);
	}
	const nowCommit = sh(workspacePath, "jj", [
		"--ignore-working-copy",
		"log",
		"-r",
		"@",
		"--no-graph",
		"-T",
		"commit_id",
	]).stdout.trim();
	assert.equal(nowCommit, ownedCommit);
	const changeLog = sh(workspacePath, "jj", [
		"--ignore-working-copy",
		"log",
		"-r",
		ownedChange,
		"--no-graph",
		"-T",
		"commit_id",
	]);
	assert.notEqual(changeLog.status, 0, "expected the owned change id to be divergent");
	assert.match(`${changeLog.stderr}\n${changeLog.stdout}`, /divergent/i);
	const divFile = sh(workspacePath, "jj", ["file", "show", "-r", divergentCommit, uniqueName]);
	assert.equal(divFile.status, 0, divFile.stderr || divFile.stdout);
	assert.match(divFile.stdout, /FOREIGN_DIVERGENT_CONTENT/);
	return { ownedChange, ownedCommit, divergentCommit, uniqueName };
}

function assertDivergentSiblingSurvived(source, divergentCommit, uniqueName) {
	const visible = sh(source, "jj", [
		"--ignore-working-copy",
		"log",
		"-r",
		"all() ~ hidden()",
		"--no-graph",
		"-T",
		'commit_id ++ "\\n"',
	]).stdout;
	assert.ok(
		visible.split("\n").map((line) => line.trim()).includes(divergentCommit),
		`external divergent commit must remain visible:\n${visible}`,
	);
	const content = sh(source, "jj", ["file", "show", "-r", divergentCommit, uniqueName]);
	assert.equal(content.status, 0, content.stderr || content.stdout);
	assert.match(content.stdout, /FOREIGN_DIVERGENT_CONTENT/);
}

test("fork worktree seam routes a JJ cwd to isolated JJ workspaces", () => {
	const source = createTempJjSource("subagents-fork-route-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-fork-route-base-"));
	const diffsDir = mkdtempSync(join(tmpdir(), "subagents-fork-route-diffs-"));
	let setup;
	try {
		setup = createForkWorktrees(source, "fork-route", 2, { baseDir });
		assert.equal(setup.backend, "jj");
		assert.equal(setup.worktrees.length, 2);
		assert.ok(setup.worktrees.every((worktree) => worktree.backend === "jj"));
		writeFileSync(join(setup.worktrees[0].path, "a.txt"), "a\n");
		writeFileSync(join(setup.worktrees[1].path, "b.txt"), "b\n");
		const diffs = diffForkWorktrees(setup, ["a", "b"], diffsDir);
		assert.equal(diffs.length, 2);
		const cleanup = cleanupForkWorktrees(setup, {
			kind: "discard",
			authorization: { kind: "confirmed" },
		});
		assert.equal(cleanup.state, "complete", JSON.stringify(cleanup));
	} finally {
		if (setup) {
			for (const worktree of setup.worktrees) {
				if (existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true });
			}
		}
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(diffsDir, { recursive: true, force: true });
	}
});

test("JJ: independent workspaces per child, patches, cleanup; worktree:false zero JJ", async () => {
	const mod = await loadBackend();
	const {
		isJjWorktreeCwd,
		createJjWorktrees,
		diffJjWorktrees,
		cleanupJjWorktrees,
	} = mod;

	const source = createTempJjSource("subagents-wt-src-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-wt-base-"));
	try {
		assert.equal(isJjWorktreeCwd(source), true);

		const sourceAtBefore = sh(source, "jj", ["log", "-r", "@", "--no-graph", "-T", "commit_id"]).stdout.trim();
		const setup = createJjWorktrees(source, "runA", 2, { baseDir });
		assert.equal(setup.backend, "jj");
		assert.equal(setup.worktrees.length, 2);
		// setup.baseCommit is Source S0 freeze.
		assert.equal(setup.baseCommit, sourceAtBefore);
		assert.notEqual(setup.worktrees[0].path, setup.worktrees[1].path);
		assert.notEqual(setup.worktrees[0].branch, setup.worktrees[1].branch);
		assert.ok(setup.worktrees[0].workspaceChangeId);
		assert.ok(setup.worktrees[1].workspaceChangeId);
		assert.notEqual(setup.worktrees[0].workspaceChangeId, setup.worktrees[1].workspaceChangeId);
		assert.ok(setup.worktrees[0].workspaceCommitId);
		assert.ok(setup.worktrees[1].workspaceCommitId);
		assert.notEqual(setup.worktrees[0].workspaceCommitId, setup.worktrees[1].workspaceCommitId);
		// Each D0 is distinct from S0 but content-identical.
		assert.notEqual(setup.worktrees[0].workspaceCommitId, sourceAtBefore);

		// Workspace @ is owned D (not bootstrap C): change matches, parents == parents(D0).
		for (const wt of setup.worktrees) {
			const ch = sh(wt.path, "jj", [
				"--ignore-working-copy",
				"log",
				"-r",
				"@",
				"--no-graph",
				"-T",
				"change_id",
			]).stdout.trim();
			assert.equal(ch, wt.workspaceChangeId);
			const parents = sh(wt.path, "jj", [
				"--ignore-working-copy",
				"log",
				"-r",
				"@",
				"--no-graph",
				"-T",
				'parents.map(|c| c.commit_id() ++ "\n")',
			]).stdout.trim();
			const d0Parents = sh(source, "jj", [
				"--ignore-working-copy",
				"log",
				"-r",
				wt.workspaceCommitId,
				"--no-graph",
				"-T",
				'parents.map(|c| c.commit_id() ++ "\n")',
			]).stdout.trim();
			assert.equal(parents, d0Parents);
		}

		writeFileSync(join(setup.worktrees[0].path, "child0.txt"), "hello-0\n");
		writeFileSync(join(setup.worktrees[1].path, "child1.txt"), "hello-1\n");

		const diffsDir = mkdtempSync(join(tmpdir(), "subagents-diffs-"));
		const diffs = diffJjWorktrees(setup, ["agent-a", "agent-b"], diffsDir);
		assert.equal(diffs.length, 2);
		assert.ok(diffs[0].filesChanged >= 1);
		assert.ok(diffs[1].filesChanged >= 1);
		assert.ok(existsSync(diffs[0].patchPath));
		assert.ok(readFileSync(diffs[0].patchPath, "utf8").includes("child0.txt"));
		assert.ok(readFileSync(diffs[1].patchPath, "utf8").includes("child1.txt"));

		const sourceFiles = sh(source, "jj", ["diff", "--git"]).stdout;
		assert.ok(!sourceFiles.includes("child0.txt"));

		const report = cleanupJjWorktrees(setup, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(report.state, "complete", JSON.stringify(report));
		assert.ok(report.tasks.length === 2);
		for (const task of report.tasks) {
			assert.equal(task.worktreeRemoved, true, JSON.stringify(task));
			assert.equal(task.branchRemoved, true, JSON.stringify(task));
			assert.equal(task.backend, "jj");
			assert.ok(task.workspaceChangeId);
			assert.ok(task.workspaceCommitId);
			assert.equal(task.workspaceCommitId, setup.worktrees[task.index].workspaceCommitId);
			assert.ok(!existsSync(task.path));
		}

		const names = sh(source, "jj", ["workspace", "list", "-T", 'name ++ "\n"']).stdout;
		assert.ok(!names.includes("pi-jj-runA-0"));
		assert.ok(!names.includes("pi-jj-runA-1"));
		// Owned D changes abandoned (not visible).
		for (const wt of setup.worktrees) {
			const dVis = sh(source, "jj", [
				"--ignore-working-copy",
				"log",
				"-r",
				`~hidden() & ${wt.workspaceChangeId}`,
				"--no-graph",
				"-T",
				"change_id",
			]).stdout.trim();
			assert.equal(dVis, "", `D ${wt.workspaceChangeId} should be abandoned`);
		}
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("JJ D topology: A/B independent D survive Source snapshot/noise; clean patches; full cleanup", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees, diffJjWorktrees, cleanupJjWorktrees } = mod;
	const source = createTempJjSource("subagents-d-noise-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-d-noise-base-"));
	try {
		const S = sh(source, "jj", ["log", "-r", "@", "--no-graph", "-T", "commit_id"]).stdout.trim();
		const setup = createJjWorktrees(source, "dAB", 2, { baseDir });
		assert.equal(setup.baseCommit, S);
		const d0a = setup.worktrees[0].workspaceCommitId;
		const d0b = setup.worktrees[1].workspaceCommitId;
		assert.ok(d0a && d0b && d0a !== d0b && d0a !== S);

		// Unsnapshotted unique files in both children.
		writeFileSync(join(setup.worktrees[0].path, "child-a.txt"), "A_UNIQUE\n");
		writeFileSync(join(setup.worktrees[1].path, "child-b.txt"), "B_UNIQUE\n");

		// Repeated Source snapshot/noise + .pi-subagents writes (must not stale W).
		mkdirSync(join(source, ".pi-subagents"), { recursive: true });
		writeFileSync(join(source, ".pi-subagents", "noise.json"), '{"n":1}\n');
		assert.equal(sh(source, "jj", ["util", "snapshot"]).status, 0);
		assert.equal(sh(source, "jj", ["describe", "-m", "source noise 1"]).status, 0);
		writeFileSync(join(source, "src-noise.txt"), "noise\n");
		assert.equal(sh(source, "jj", ["util", "snapshot"]).status, 0);
		assert.equal(sh(source, "jj", ["new", "-m", "more source"]).status, 0);
		writeFileSync(join(source, ".pi-subagents", "noise2.json"), '{"n":2}\n');
		assert.equal(sh(source, "jj", ["util", "snapshot"]).status, 0);

		// Children must still be readable (not stale) and capture clean business patches.
		for (const wt of setup.worktrees) {
			const st = sh(wt.path, "jj", ["status"]);
			assert.equal(st.status, 0, st.stderr || st.stdout);
			assert.doesNotMatch(`${st.stderr}\n${st.stdout}`, /working copy is stale/i);
		}

		const diffsDir = mkdtempSync(join(tmpdir(), "subagents-frozen-diffs-"));
		const diffs = diffJjWorktrees(setup, ["agent-a", "agent-b"], diffsDir);
		assert.equal(diffs.length, 2);
		assert.equal(diffs[0].error, undefined, JSON.stringify(diffs[0]));
		assert.equal(diffs[1].error, undefined, JSON.stringify(diffs[1]));
		const p0 = readFileSync(diffs[0].patchPath, "utf8");
		const p1 = readFileSync(diffs[1].patchPath, "utf8");
		assert.ok(p0.includes("child-a.txt") && p0.includes("A_UNIQUE"), p0);
		assert.ok(p1.includes("child-b.txt") && p1.includes("B_UNIQUE"), p1);
		// No .pi-subagents contamination from Source noise.
		assert.ok(!p0.includes(".pi-subagents"), p0);
		assert.ok(!p1.includes(".pi-subagents"), p1);
		assert.ok(!p0.includes("src-noise.txt") && !p1.includes("src-noise.txt"));

		const report = cleanupJjWorktrees(setup, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(report.state, "complete", JSON.stringify(report));
		assert.ok(!report.errors?.length, JSON.stringify(report.errors));
		for (const task of report.tasks) {
			assert.equal(task.worktreeRemoved, true);
			assert.ok(!existsSync(task.path));
		}
		const names = sh(source, "jj", ["workspace", "list", "-T", 'name ++ "\n"']).stdout;
		assert.ok(!names.includes("pi-jj-dAB-0"));
		assert.ok(!names.includes("pi-jj-dAB-1"));
		for (const wt of setup.worktrees) {
			const dVis = sh(source, "jj", [
				"--ignore-working-copy",
				"log",
				"-r",
				`~hidden() & ${wt.workspaceChangeId}`,
				"--no-graph",
				"-T",
				"change_id",
			]).stdout.trim();
			assert.equal(dVis, "", `D ${wt.workspaceChangeId} residual must be abandoned`);
		}
		rmSync(diffsDir, { recursive: true, force: true });
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("mutable Source-parent control: Source noise stales children of S (documents why D topology)", async () => {
	// Direct control (not via backend): children of mutable Source S go stale after Source snapshot.
	const source = createTempJjSource("subagents-mutable-control-");
	const w0 = mkdtempSync(join(tmpdir(), "subagents-mutable-w0-"));
	const w1 = mkdtempSync(join(tmpdir(), "subagents-mutable-w1-"));
	rmSync(w0, { recursive: true, force: true });
	rmSync(w1, { recursive: true, force: true });
	try {
		const S = sh(source, "jj", ["log", "-r", "@", "--no-graph", "-T", "commit_id"]).stdout.trim();
		assert.equal(
			sh(source, "jj", ["workspace", "add", "--name", "mut0", "-r", S, w0]).status,
			0,
		);
		assert.equal(
			sh(source, "jj", ["workspace", "add", "--name", "mut1", "-r", S, w1]).status,
			0,
		);
		writeFileSync(join(w0, "a.txt"), "A\n");
		writeFileSync(join(w1, "b.txt"), "B\n");
		mkdirSync(join(source, ".pi-subagents"), { recursive: true });
		writeFileSync(join(source, ".pi-subagents", "n.json"), "{}\n");
		assert.equal(sh(source, "jj", ["util", "snapshot"]).status, 0);
		assert.equal(sh(source, "jj", ["describe", "-m", "source noise"]).status, 0);
		const st0 = sh(w0, "jj", ["status"]);
		const st1 = sh(w1, "jj", ["status"]);
		assert.notEqual(st0.status, 0);
		assert.notEqual(st1.status, 0);
		assert.match(`${st0.stderr}\n${st0.stdout}`, /working copy is stale/i);
		assert.match(`${st1.stderr}\n${st1.stdout}`, /working copy is stale/i);
	} finally {
		sh(source, "jj", ["workspace", "forget", "mut0"]);
		sh(source, "jj", ["workspace", "forget", "mut1"]);
		rmSync(w0, { recursive: true, force: true });
		rmSync(w1, { recursive: true, force: true });
		rmSync(source, { recursive: true, force: true });
	}
});

test("foreign descendant of owned D: preserve W registration/path", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees, cleanupJjWorktrees } = mod;
	const source = createTempJjSource("subagents-foreign-desc-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-foreign-desc-base-"));
	const foreignBase = mkdtempSync(join(tmpdir(), "subagents-foreign-ws-"));
	let foreignPath;
	try {
		const setup = createJjWorktrees(source, "foreignD", 1, { baseDir });
		const wt = setup.worktrees[0];
		const D = wt.workspaceChangeId;
		const D0 = wt.workspaceCommitId;
		assert.ok(D && D0);

		// Foreign workspace parented on current D (live descendant of owned D).
		foreignPath = join(foreignBase, "foreign-child");
		const addForeign = sh(source, "jj", [
			"workspace",
			"add",
			"--name",
			"foreign-child-of-D",
			"-r",
			D,
			foreignPath,
		]);
		assert.equal(addForeign.status, 0, addForeign.stderr || addForeign.stdout);
		assert.ok(existsSync(foreignPath));

		const report = cleanupJjWorktrees(setup, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		// Owned W preserved while foreign descendant exists.
		assert.equal(report.tasks[0].worktreeRemoved, false, JSON.stringify(report.tasks[0]));
		assert.equal(report.tasks[0].preserved, true);
		assert.ok(existsSync(wt.path));
		assert.equal(report.state, "partial", JSON.stringify(report));
		assert.ok(
			(report.tasks[0].errors ?? []).some((e) => /live descendants|preserved/i.test(e)) ||
				/descendant|preserved/i.test(report.tasks[0].reason ?? ""),
			JSON.stringify(report.tasks[0]),
		);
		assert.ok(existsSync(foreignPath));
		const names = sh(source, "jj", ["workspace", "list", "-T", 'name ++ "\n"']).stdout;
		assert.ok(names.includes(wt.branch), names);
		assert.ok(names.includes("foreign-child-of-D"), names);
	} finally {
		if (source) {
			sh(source, "jj", ["workspace", "forget", "foreign-child-of-D"]);
			if (foreignPath && existsSync(foreignPath)) {
				const cid = sh(foreignPath, "jj", [
					"--ignore-working-copy",
					"log",
					"-r",
					"@",
					"--no-graph",
					"-T",
					"change_id",
				]).stdout.trim();
				if (cid) sh(source, "jj", ["abandon", cid]);
			}
		}
		if (foreignPath) rmSync(foreignPath, { recursive: true, force: true });
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(foreignBase, { recursive: true, force: true });
	}
});

test("Git fallback / worktree:false: stock path never invokes jj", async () => {
	const mod = await loadBackend();
	const { isJjWorktreeCwd } = mod;
	const gitRepo = createTempGitRepo("subagents-git-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-git-base-"));
	const diffsDir = mkdtempSync(join(tmpdir(), "subagents-git-diffs-"));
	const bin = makeJjPathWrapper("count");
	const prevPath = process.env.PATH;
	process.env.PATH = `${bin}:${prevPath}`;
	let setup;
	try {
		assert.equal(isJjWorktreeCwd(gitRepo), false);
		setup = createForkWorktrees(gitRepo, "git-zero-jj", 1, { baseDir });
		assert.notEqual(setup.backend, "jj");
		writeFileSync(join(setup.worktrees[0].path, "git-only.txt"), "git\n");
		const diffs = diffForkWorktrees(setup, ["worker"], diffsDir);
		assert.equal(diffs.length, 1);
		const cleanup = cleanupForkWorktrees(setup, {
			kind: "discard",
			authorization: { kind: "confirmed" },
		});
		assert.equal(cleanup.state, "complete", JSON.stringify(cleanup));
		const calls = existsSync(join(bin, "jj-calls.log"))
			? readFileSync(join(bin, "jj-calls.log"), "utf8").trim()
			: "";
		assert.equal(calls, "", `non-JJ stock path must not invoke jj:\n${calls}`);
	} finally {
		process.env.PATH = prevPath;
		if (setup) {
			for (const worktree of setup.worktrees) {
				if (existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true });
			}
		}
		rmSync(gitRepo, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(diffsDir, { recursive: true, force: true });
		rmSync(bin, { recursive: true, force: true });
	}
});

test("JJ: rejects worktree base directories inside Pi extensions and symlink aliases", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees } = mod;
	const source = createTempJjSource("subagents-jj-ext-dir-");
	const tempHome = mkdtempSync(join(tmpdir(), "subagents-jj-ext-home-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const extensionsDir = join(tempHome, ".pi", "agent", "extensions");
	const aliasDir = join(tempHome, "extension-alias");
	try {
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		delete process.env.PI_CODING_AGENT_DIR;
		mkdirSync(extensionsDir, { recursive: true });
		symlinkSync(extensionsDir, aliasDir, process.platform === "win32" ? "junction" : "dir");

		assert.throws(
			() => createJjWorktrees(source, "extension-dir", 1, { baseDir: extensionsDir }),
			/worktree base directory cannot be inside Pi extensions directory/i,
		);
		assert.throws(
			() => createJjWorktrees(source, "extension-subdir", 1, { baseDir: join(extensionsDir, "checkout") }),
			/worktree base directory cannot be inside Pi extensions directory/i,
		);
		assert.throws(
			() => createForkWorktrees(source, "extension-dir-route", 1, { baseDir: extensionsDir }),
			/worktree base directory cannot be inside Pi extensions directory/i,
		);
		assert.throws(
			() => createJjWorktrees(source, "extension-symlink", 1, { baseDir: join(aliasDir, "checkout") }),
			/worktree base directory cannot be inside Pi extensions directory/i,
		);
		assert.throws(
			() => createForkWorktrees(source, "extension-symlink-route", 1, { baseDir: join(aliasDir, "checkout") }),
			/worktree base directory cannot be inside Pi extensions directory/i,
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		rmSync(source, { recursive: true, force: true });
		rmSync(tempHome, { recursive: true, force: true });
	}
});

test("setupHook success: JSON input, agents, syntheticPaths; tracked path rejected", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees, cleanupJjWorktrees } = mod;
	const source = createTempJjSource("subagents-hook-ok-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-hook-base-"));
	const hookDir = mkdtempSync(join(tmpdir(), "subagents-hook-bin-"));
	try {
		const hookPath = writeHook(
			hookDir,
			`#!/bin/sh
input=$(cat)
echo "$input" > "${hookDir}/seen.json"
mkdir -p .hook-cache
printf '%s\\n' '{"syntheticPaths":[".hook-cache"]}'
`,
		);
		const setup = createJjWorktrees(source, "hookOk", 1, {
			baseDir,
			agents: ["worker-a"],
			setupHook: { hookPath, timeoutMs: 10_000 },
		});
		assert.ok(setup.worktrees[0].syntheticPaths.includes(".hook-cache"));
		const seen = JSON.parse(readFileSync(join(hookDir, "seen.json"), "utf8"));
		assert.equal(seen.version, 1);
		assert.equal(seen.agent, "worker-a");
		assert.equal(seen.index, 0);
		assert.equal(seen.runId, "hookOk");
		assert.ok(seen.branch.startsWith("pi-jj-"));
		assert.ok(seen.worktreePath);
		assert.ok(seen.repoRoot);
		assert.ok(seen.baseCommit);

		// Tracked path rejection
		const badHook = writeHook(
			hookDir,
			`#!/bin/sh
printf '%s\\n' '{"syntheticPaths":["README.md"]}'
`,
		);
		assert.throws(
			() =>
				createJjWorktrees(source, "hookBadTracked", 1, {
					baseDir,
					setupHook: { hookPath: badHook },
				}),
			/cannot mark tracked paths as synthetic|tracked/,
		);

		// Invalid timeout
		assert.throws(
			() =>
				createJjWorktrees(source, "hookBadTimeout", 1, {
					baseDir,
					setupHook: { hookPath, timeoutMs: 0 },
				}),
			/timeout must be an integer greater than 0/,
		);

		cleanupJjWorktrees(setup, { kind: "discard", authorization: { kind: "policy" } });
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(hookDir, { recursive: true, force: true });
	}
});

test("JJ: excludes hook-created synthetic files from captured patch", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees, diffJjWorktrees, cleanupJjWorktrees } = mod;
	const source = createTempJjSource("subagents-hook-synth-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-hook-synth-base-"));
	const hookDir = mkdtempSync(join(tmpdir(), "subagents-hook-synth-bin-"));
	try {
		const hookPath = writeHook(
			hookDir,
			`#!/bin/sh
printf '%s\\n' 'synthetic-fixture' > hook-fixture.txt
printf '%s\\n' '{"syntheticPaths":["hook-fixture.txt"]}'
`,
		);

		const setup = createJjWorktrees(source, "hookSynth", 1, {
			baseDir,
			setupHook: { hookPath, timeoutMs: 10_000 },
		});
		assert.ok(setup.worktrees[0].syntheticPaths.includes("hook-fixture.txt"));
		assert.ok(existsSync(join(setup.worktrees[0].path, "hook-fixture.txt")));
		writeFileSync(join(setup.worktrees[0].path, "business.txt"), "business-change\n");

		const diffsDir = mkdtempSync(join(tmpdir(), "subagents-hook-synth-diffs-"));
		const diffs = diffJjWorktrees(setup, ["agent-a"], diffsDir);
		assert.equal(diffs.length, 1);
		assert.equal(diffs[0].error, undefined, JSON.stringify(diffs[0]));
		const patch = readFileSync(diffs[0].patchPath, "utf8");
		assert.ok(patch.includes("business.txt"), patch);
		assert.ok(patch.includes("business-change"), patch);
		assert.ok(!patch.includes("hook-fixture.txt"), patch);
		assert.ok(!patch.includes("synthetic-fixture"), patch);

		const report = cleanupJjWorktrees(setup, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(report.state, "complete", JSON.stringify(report));
		assert.equal(report.tasks[0].worktreeRemoved, true, JSON.stringify(report.tasks[0]));

		const onlySetup = createJjWorktrees(source, "hookOnlySynth", 1, {
			baseDir,
			setupHook: { hookPath, timeoutMs: 10_000 },
		});
		assert.ok(existsSync(join(onlySetup.worktrees[0].path, "hook-fixture.txt")));
		const onlyDiffsDir = mkdtempSync(join(tmpdir(), "subagents-hook-only-synth-diffs-"));
		const onlyDiffs = diffJjWorktrees(onlySetup, ["agent-b"], onlyDiffsDir);
		assert.equal(onlyDiffs.length, 1);
		assert.equal(onlyDiffs[0].error, undefined, JSON.stringify(onlyDiffs[0]));
		const onlyPatch = readFileSync(onlyDiffs[0].patchPath, "utf8");
		assert.equal(onlyPatch.trim(), "", onlyPatch);
		assert.ok(!onlyPatch.includes("hook-fixture.txt"));
		assert.equal(onlyDiffs[0].filesChanged, 0);

		const onlyReport = cleanupJjWorktrees(onlySetup, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(onlyReport.state, "complete", JSON.stringify(onlyReport));
		assert.equal(onlyReport.tasks[0].worktreeRemoved, true, JSON.stringify(onlyReport.tasks[0]));

		rmSync(diffsDir, { recursive: true, force: true });
		rmSync(onlyDiffsDir, { recursive: true, force: true });
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(hookDir, { recursive: true, force: true });
	}
});

test("tracked-path validation fail-closes on jj file list failure and accepts dash-leading synthetic paths", async () => {
	const source = createTempJjSource("subagents-hook-file-list-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-hook-file-list-base-"));
	const hookDir = mkdtempSync(join(tmpdir(), "subagents-hook-file-list-bin-"));
	const failBin = makeJjPathWrapper("fail-file-list");
	const prevPath = process.env.PATH;
	try {
		const dashHook = writeHook(
			hookDir,
			`#!/bin/sh
printf '%s\\n' 'dash-synthetic' > ./-hook-cache
printf '%s\\n' '{\"syntheticPaths\":[\"-hook-cache\"]}'
`,
		);
		const dashMod = await loadBackend();
		const dashSetup = dashMod.createJjWorktrees(source, "hookDash", 1, {
			baseDir,
			setupHook: { hookPath: dashHook, timeoutMs: 10_000 },
		});
		assert.ok(dashSetup.worktrees[0].syntheticPaths.includes("-hook-cache"));
		assert.ok(existsSync(join(dashSetup.worktrees[0].path, "-hook-cache")));
		dashMod.cleanupJjWorktrees(dashSetup, {
			kind: "discard",
			authorization: { kind: "policy" },
		});

		process.env.PATH = `${failBin}:${prevPath}`;
		const failMod = await loadBackend();
		const failHook = writeHook(
			hookDir,
			`#!/bin/sh
printf '%s\\n' '{\"syntheticPaths\":[\".hook-cache\"]}'
`,
		);
		assert.throws(
			() =>
				failMod.createJjWorktrees(source, "hookFileListFail", 1, {
					baseDir,
					setupHook: { hookPath: failHook },
				}),
			/tracked-path validation failed|forced file list failure/,
		);
	} finally {
		process.env.PATH = prevPath;
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(hookDir, { recursive: true, force: true });
		rmSync(failBin, { recursive: true, force: true });
	}
});

test("capture and cleanup refuse intermediate symlink escape; outside sentinel survives", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees, diffJjWorktrees, cleanupJjWorktrees } = mod;
	const source = createTempJjSource("subagents-synth-symlink-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-synth-symlink-base-"));
	const hookDir = mkdtempSync(join(tmpdir(), "subagents-synth-symlink-bin-"));
	const outside = mkdtempSync(join(tmpdir(), "subagents-synth-sentinel-"));
	const sentinel = join(outside, "SENTINEL");
	const plantedTmp = join(outside, "tmp");
	mkdirSync(plantedTmp, { recursive: true });
	writeFileSync(join(plantedTmp, "SENTINEL"), "must-survive\n");
	writeFileSync(sentinel, "must-survive\n");
	const hookPath = writeHook(
		hookDir,
		`#!/bin/sh
mkdir -p cache/tmp
printf '%s\\n' 'synthetic-bytes' > cache/tmp/file.txt
printf '%s\\n' '{\"syntheticPaths\":[\"cache/tmp\"]}'
`,
	);

	const plantEscape = (worktreePath) => {
		const cachePath = join(worktreePath, "cache");
		rmSync(cachePath, { recursive: true, force: true });
		symlinkSync(outside, cachePath);
	};
	const unlinkEscape = (worktreePath) => {
		const cachePath = join(worktreePath, "cache");
		try {
			if (existsSync(cachePath) && lstatSync(cachePath).isSymbolicLink()) unlinkSync(cachePath);
		} catch {
			// Best-effort: do not follow the escape into the outside sentinel.
		}
	};

	try {
		const captureSetup = createJjWorktrees(source, "synthEscapeCap", 1, {
			baseDir,
			setupHook: { hookPath, timeoutMs: 10_000 },
		});
		plantEscape(captureSetup.worktrees[0].path);
		const diffsDir = mkdtempSync(join(tmpdir(), "subagents-synth-escape-diffs-"));
		try {
			const diffs = diffJjWorktrees(captureSetup, ["agent-a"], diffsDir);
			assert.match(diffs[0]?.error ?? "", /intermediate symlink|escapes the JJ workspace/i);
			assert.ok(existsSync(join(plantedTmp, "SENTINEL")), "capture must not delete the outside sentinel");
			assert.equal(readFileSync(join(plantedTmp, "SENTINEL"), "utf8"), "must-survive\n");
		} finally {
			unlinkEscape(captureSetup.worktrees[0].path);
			rmSync(diffsDir, { recursive: true, force: true });
			cleanupJjWorktrees(captureSetup, {
				kind: "discard",
				authorization: { kind: "policy" },
			});
		}

		const cleanupSetup = createJjWorktrees(source, "synthEscapeClean", 1, {
			baseDir,
			setupHook: { hookPath, timeoutMs: 10_000 },
		});
		plantEscape(cleanupSetup.worktrees[0].path);
		try {
			const report = cleanupJjWorktrees(cleanupSetup, {
				kind: "discard",
				authorization: { kind: "policy" },
			});
			assert.equal(report.tasks[0]?.preserved, true, JSON.stringify(report.tasks[0]));
			assert.match(
				`${report.tasks[0]?.reason ?? ""}\n${(report.tasks[0]?.errors ?? []).join("\n")}`,
				/intermediate symlink|escapes the JJ workspace|synthetic path cleanup failed/i,
			);
			assert.ok(existsSync(cleanupSetup.worktrees[0].path));
			assert.ok(existsSync(join(plantedTmp, "SENTINEL")), "cleanup must not delete the outside sentinel");
			assert.equal(readFileSync(join(plantedTmp, "SENTINEL"), "utf8"), "must-survive\n");
		} finally {
			unlinkEscape(cleanupSetup.worktrees[0].path);
			if (existsSync(cleanupSetup.worktrees[0].path)) {
				cleanupJjWorktrees(cleanupSetup, {
					kind: "discard",
					authorization: { kind: "policy" },
				});
			}
		}

		const finalLinkSetup = createJjWorktrees(source, "synthFinalLink", 1, {
			baseDir,
			setupHook: { hookPath, timeoutMs: 10_000 },
		});
		finalLinkSetup.worktrees[0].syntheticPaths = ["cache"];
		const cachePath = join(finalLinkSetup.worktrees[0].path, "cache");
		rmSync(cachePath, { recursive: true, force: true });
		symlinkSync(outside, cachePath);
		const finalDiffsDir = mkdtempSync(join(tmpdir(), "subagents-synth-final-diffs-"));
		try {
			const diffs = diffJjWorktrees(finalLinkSetup, ["agent-b"], finalDiffsDir);
			assert.equal(diffs[0]?.error, undefined, JSON.stringify(diffs[0]));
			assert.ok(!existsSync(cachePath) || !lstatSync(cachePath).isSymbolicLink());
			assert.ok(existsSync(join(plantedTmp, "SENTINEL")), "final symlink unlink must not follow outside");
		} finally {
			unlinkEscape(finalLinkSetup.worktrees[0].path);
			rmSync(finalDiffsDir, { recursive: true, force: true });
			cleanupJjWorktrees(finalLinkSetup, {
				kind: "discard",
				authorization: { kind: "policy" },
			});
		}
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(hookDir, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("cleanup without prior capture still removes synthetic-only work", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees, cleanupJjWorktrees } = mod;
	const source = createTempJjSource("subagents-cleanup-only-synth-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-cleanup-only-synth-base-"));
	const hookDir = mkdtempSync(join(tmpdir(), "subagents-cleanup-only-synth-bin-"));
	try {
		const hookPath = writeHook(
			hookDir,
			`#!/bin/sh
printf '%s\\n' 'synthetic-only' > hook-fixture.txt
printf '%s\\n' '{\"syntheticPaths\":[\"hook-fixture.txt\"]}'
`,
		);
		const setup = createJjWorktrees(source, "cleanupOnlySynth", 1, {
			baseDir,
			setupHook: { hookPath, timeoutMs: 10_000 },
		});
		assert.ok(existsSync(join(setup.worktrees[0].path, "hook-fixture.txt")));
		const report = cleanupJjWorktrees(setup, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(report.state, "complete", JSON.stringify(report));
		assert.equal(report.tasks[0]?.preserved, undefined, JSON.stringify(report.tasks[0]));
		assert.equal(report.tasks[0]?.worktreeRemoved, true, JSON.stringify(report.tasks[0]));
		assert.ok(!existsSync(setup.worktrees[0].path));
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(hookDir, { recursive: true, force: true });
	}
});

test("second snapshot after synthetic removal failpoint preserves the workspace", async () => {
	const source = createTempJjSource("subagents-second-snap-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-second-snap-base-"));
	const hookDir = mkdtempSync(join(tmpdir(), "subagents-second-snap-bin-"));
	const bin = makeJjPathWrapper("fail-second-snapshot");
	const prevPath = process.env.PATH;
	try {
		const hookPath = writeHook(
			hookDir,
			`#!/bin/sh
printf '%s\\n' 'synthetic-only' > hook-fixture.txt
printf '%s\\n' '{\"syntheticPaths\":[\"hook-fixture.txt\"]}'
`,
		);
		const createMod = await loadBackend();
		const setup = createMod.createJjWorktrees(source, "secondSnap", 1, {
			baseDir,
			setupHook: { hookPath, timeoutMs: 10_000 },
		});
		process.env.PATH = `${bin}:${prevPath}`;
		const failMod = await loadBackend();
		const report = failMod.cleanupJjWorktrees(setup, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(report.tasks[0]?.preserved, true, JSON.stringify(report.tasks[0]));
		assert.equal(report.tasks[0]?.worktreeRemoved, false, JSON.stringify(report.tasks[0]));
		assert.match(
			`${report.tasks[0]?.reason ?? ""}\n${(report.tasks[0]?.errors ?? []).join("\n")}`,
			/snapshot after synthetic path removal failed/,
		);
		assert.ok(existsSync(setup.worktrees[0].path));
		process.env.PATH = prevPath;
		const finish = createMod.cleanupJjWorktrees(setup, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(finish.state, "complete", JSON.stringify(finish));
	} finally {
		process.env.PATH = prevPath;
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(hookDir, { recursive: true, force: true });
		rmSync(bin, { recursive: true, force: true });
	}
});

test("setupHook failure after add: exact cleanup when forget succeeds", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees } = mod;
	const source = createTempJjSource("subagents-hook-fail-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-hook-fail-base-"));
	const hookDir = mkdtempSync(join(tmpdir(), "subagents-hook-fail-bin-"));
	try {
		const hookPath = writeHook(
			hookDir,
			`#!/bin/sh
echo boom >&2
exit 2
`,
		);
		assert.throws(
			() =>
				createJjWorktrees(source, "hookFail", 1, {
					baseDir,
					setupHook: { hookPath },
				}),
			/setup hook failed/,
		);
		const names = sh(source, "jj", ["workspace", "list", "-T", 'name ++ "\n"']).stdout;
		assert.ok(!names.includes("pi-jj-hookFail-0"), names);
		// Path under baseDir should be gone
		const leftover = spawnSync("ls", [baseDir], { encoding: "utf8" });
		assert.ok(!(leftover.stdout || "").includes("pi-worktree-hookFail-0"));
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(hookDir, { recursive: true, force: true });
	}
});

test("forget failure keeps path+registration (PATH wrapper failpoint)", async () => {
	const bin = makeJjPathWrapper("fail-forget");
	const prevPath = process.env.PATH;
	process.env.PATH = `${bin}:${prevPath}`;
	try {
		// Reload backend under wrapper PATH so spawnSync("jj") hits wrapper.
		const mod = await loadBackend();
		const { createJjWorktrees, cleanupJjWorktrees } = mod;
		const source = createTempJjSource("subagents-forget-fail-");
		const baseDir = mkdtempSync(join(tmpdir(), "subagents-forget-base-"));
		try {
			// create uses workspace add (allowed); cleanup discard uses forget (fails)
			const setup = createJjWorktrees(source, "forgetFail", 1, { baseDir });
			const wt = setup.worktrees[0];
			assert.ok(existsSync(wt.path));
			const report = cleanupJjWorktrees(setup, {
				kind: "discard",
				authorization: { kind: "policy" },
			});
			assert.equal(report.tasks[0].preserved, true);
			assert.equal(report.tasks[0].worktreeRemoved, false);
			assert.ok(existsSync(wt.path));
			const names = sh(source, "jj", ["workspace", "list", "-T", 'name ++ "\n"']).stdout;
			// Still registered because forget failed
			assert.ok(names.includes(wt.branch), names);

			// Restore real jj on PATH and cleanup for real
			process.env.PATH = prevPath;
			const report2 = cleanupJjWorktrees(setup, {
				kind: "discard",
				authorization: { kind: "policy" },
			});
			assert.equal(report2.tasks[0].worktreeRemoved, true);
			assert.ok(!existsSync(wt.path));
		} finally {
			rmSync(source, { recursive: true, force: true });
			rmSync(baseDir, { recursive: true, force: true });
		}
	} finally {
		process.env.PATH = prevPath;
		rmSync(bin, { recursive: true, force: true });
	}
});

test("post-add identity phase failure: preserve name+path (PATH wrapper fail-edit)", async () => {
	const bin = makeJjPathWrapper("fail-edit");
	const prevPath = process.env.PATH;
	process.env.PATH = `${bin}:${prevPath}`;
	const workspaceName = "pi-jj-preIdFail-0";
	let source;
	let baseDir;
	let leftoverPath;
	try {
		const mod = await loadBackend();
		const { createJjWorktrees } = mod;
		source = createTempJjSource("subagents-preid-fail-");
		baseDir = mkdtempSync(join(tmpdir(), "subagents-preid-base-"));
		assert.throws(
			() => createJjWorktrees(source, "preIdFail", 1, { baseDir }),
			/edit|forced edit|workspace @ identity|failed/i,
		);

		// Workspace add succeeded before identity phase; destructive rollback must NOT run.
		const names = sh(source, "jj", ["workspace", "list", "-T", 'name ++ "\n"']).stdout;
		assert.ok(names.includes(workspaceName), `expected registration retained: ${names}`);

		const candidate = join(baseDir, "pi-worktree-preIdFail-0");
		// realpath may differ on macOS (/var vs /private/var); check baseDir listing.
		const listing = spawnSync("ls", ["-la", baseDir], { encoding: "utf8" });
		assert.ok(
			(listing.stdout || "").includes("pi-worktree-preIdFail-0") || existsSync(candidate),
			`expected worktree path retained under ${baseDir}: ${listing.stdout}`,
		);
		leftoverPath = existsSync(candidate) ? candidate : null;
		if (!leftoverPath) {
			// Resolve via workspace list root if needed
			const listPaths = sh(source, "jj", [
				"workspace",
				"list",
				"-T",
				'name ++ "\\t" ++ root ++ "\\n"',
			]).stdout;
			const line = listPaths.split("\n").find((l) => l.startsWith(`${workspaceName}\t`));
			if (line) leftoverPath = line.split("\t")[1]?.trim();
		}
		assert.ok(leftoverPath && existsSync(leftoverPath), `path must remain: ${leftoverPath}`);
	} finally {
		// Manual fixture cleanup (setup must not have forgotten/rm'd).
		process.env.PATH = prevPath;
		if (source && leftoverPath) {
			sh(source, "jj", ["workspace", "forget", workspaceName]);
			rmSync(leftoverPath, { recursive: true, force: true });
		} else if (source) {
			sh(source, "jj", ["workspace", "forget", workspaceName]);
		}
		if (source) rmSync(source, { recursive: true, force: true });
		if (baseDir) rmSync(baseDir, { recursive: true, force: true });
		rmSync(bin, { recursive: true, force: true });
	}
});

test("name re-bound to foreign path: setup-rollback/cleanup preserve foreign registration", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees, cleanupJjWorktrees } = mod;
	let source;
	let ownedBase;
	let foreignBase;
	let foreignPath;
	let workspaceName;
	try {
		source = createTempJjSource("subagents-rebind-");
		ownedBase = mkdtempSync(join(tmpdir(), "subagents-rebind-owned-"));
		foreignBase = mkdtempSync(join(tmpdir(), "subagents-rebind-foreign-"));
		const setup = createJjWorktrees(source, "rebind1", 1, { baseDir: ownedBase });
		const owned = setup.worktrees[0];
		workspaceName = owned.branch;
		const oldRecord = {
			...setup,
			worktrees: [
				{
					...owned,
					// Snapshot the old ownership record before re-bind.
					path: owned.path,
					branch: workspaceName,
					workspaceChangeId: owned.workspaceChangeId,
				},
			],
		};

		// Forget/remove the owned workspace so the name can be re-bound.
		const forget = sh(source, "jj", ["workspace", "forget", workspaceName]);
		assert.equal(forget.status, 0, forget.stderr || forget.stdout);
		rmSync(owned.path, { recursive: true, force: true });
		assert.ok(!existsSync(owned.path));

		// Foreign workspace reuses the same name at a different path.
		foreignPath = join(foreignBase, "foreign-ws");
		const addForeign = sh(source, "jj", [
			"workspace",
			"add",
			"--name",
			workspaceName,
			"-r",
			"@",
			foreignPath,
		]);
		assert.equal(addForeign.status, 0, addForeign.stderr || addForeign.stdout);
		assert.ok(existsSync(foreignPath));

		const inventoryBefore = sh(source, "jj", [
			"workspace",
			"list",
			"-T",
			'name ++ "\\t" ++ root ++ "\\n"',
		]).stdout;
		assert.ok(
			inventoryBefore.split("\n").some((line) => {
				const [name, root] = line.split("\t");
				return name === workspaceName && root && root.includes("foreign-ws");
			}),
			inventoryBefore,
		);

		// Setup-rollback with the OLD record must not forget the foreign registration.
		const rollbackReport = cleanupJjWorktrees(oldRecord, { kind: "setup-rollback" });
		assert.equal(rollbackReport.tasks[0].preserved, true, JSON.stringify(rollbackReport.tasks[0]));
		assert.equal(rollbackReport.tasks[0].worktreeRemoved, false);
		assert.ok(existsSync(foreignPath), "foreign path must remain after setup-rollback");

		// Discard cleanup with the OLD record must also preserve.
		const discardReport = cleanupJjWorktrees(oldRecord, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(discardReport.tasks[0].preserved, true, JSON.stringify(discardReport.tasks[0]));
		assert.ok(existsSync(foreignPath), "foreign path must remain after discard cleanup");

		const inventoryAfter = sh(source, "jj", [
			"workspace",
			"list",
			"-T",
			'name ++ "\\t" ++ root ++ "\\n"',
		]).stdout;
		const foreignStillListed = inventoryAfter.split("\n").some((line) => {
			const [name, root] = line.split("\t");
			return name === workspaceName && root && (root.includes("foreign-ws") || existsSync(root));
		});
		assert.ok(foreignStillListed, `foreign registration must remain: ${inventoryAfter}`);
		assert.ok(existsSync(foreignPath));

		// Missing recorded path on setup-rollback is always conservative preserve.
		const missingPathRecord = {
			...oldRecord,
			worktrees: [{ ...oldRecord.worktrees[0], path: "" }],
		};
		const missingPathReport = cleanupJjWorktrees(missingPathRecord, { kind: "setup-rollback" });
		assert.equal(missingPathReport.tasks[0].preserved, true);
		assert.match(
			missingPathReport.tasks[0].reason ?? "",
			/recorded workspace path missing/,
		);
		assert.ok(existsSync(foreignPath));
		const namesFinal = sh(source, "jj", ["workspace", "list", "-T", 'name ++ "\\n"']).stdout;
		assert.ok(namesFinal.includes(workspaceName), namesFinal);
	} finally {
		if (source && workspaceName) {
			sh(source, "jj", ["workspace", "forget", workspaceName]);
		}
		if (foreignPath) rmSync(foreignPath, { recursive: true, force: true });
		if (source) rmSync(source, { recursive: true, force: true });
		if (ownedBase) rmSync(ownedBase, { recursive: true, force: true });
		if (foreignBase) rmSync(foreignBase, { recursive: true, force: true });
	}
});

test("capture and cleanup never touch a foreign workspace at a recorded Child path", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees, cleanupJjWorktrees, diffJjWorktrees } = mod;
	const source = createTempJjSource("subagents-replaced-path-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-replaced-path-base-"));
	const diffsDir = mkdtempSync(join(tmpdir(), "subagents-replaced-path-diffs-"));
	const bin = mkdtempSync(join(tmpdir(), "subagents-replaced-path-bin-"));
	const tracePath = join(bin, "jj-cwds.log");
	const realJj = spawnSync("which", ["jj"], { encoding: "utf8" }).stdout.trim();
	const wrapper = join(bin, "jj");
	const previousPath = process.env.PATH;
	let replacementPath;
	let replacementName;
	try {
		assert.ok(realJj, "jj must be on PATH");
		const setup = createJjWorktrees(source, "replaced-path", 1, { baseDir });
		const owned = setup.worktrees[0];
		const oldRecord = {
			...setup,
			worktrees: [{ ...owned, syntheticPaths: ["foreign-synthetic.txt"] }],
		};

		assert.equal(sh(source, "jj", ["workspace", "forget", owned.branch]).status, 0);
		rmSync(owned.path, { recursive: true, force: true });
		replacementPath = owned.path;
		replacementName = "foreign-replacement";
		const added = sh(source, "jj", [
			"workspace",
			"add",
			"--name",
			replacementName,
			"-r",
			"@",
			replacementPath,
		]);
		assert.equal(added.status, 0, added.stderr || added.stdout);
		const foreignSyntheticPath = join(replacementPath, "foreign-synthetic.txt");
		writeFileSync(foreignSyntheticPath, "must-survive\n");

		writeFileSync(
			wrapper,
			`#!/bin/sh
printf '%s\\t%s\\n' "$PWD" "$*" >> ${JSON.stringify(tracePath)}
exec ${JSON.stringify(realJj)} "$@"
`,
		);
		chmodSync(wrapper, 0o755);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;

		const diffs = diffJjWorktrees(oldRecord, ["worker"], diffsDir);
		assert.match(diffs[0]?.error ?? "", /identity drifted.*capture refused/i);
		assert.ok(existsSync(foreignSyntheticPath), "capture must not delete foreign synthetic files");

		const report = cleanupJjWorktrees(oldRecord, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(report.tasks[0]?.preserved, true, JSON.stringify(report.tasks[0]));
		assert.ok(existsSync(foreignSyntheticPath), "cleanup must not delete foreign synthetic files");
		const trace = existsSync(tracePath) ? readFileSync(tracePath, "utf8") : "";
		assert.ok(
			!trace.split("\n").some((line) => line.startsWith(`${replacementPath}\t`)),
			`cleanup/capture must not run jj in the replacement workspace:\n${trace}`,
		);
	} finally {
		process.env.PATH = previousPath;
		if (replacementName) sh(source, "jj", ["workspace", "forget", replacementName]);
		if (replacementPath) rmSync(replacementPath, { recursive: true, force: true });
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(diffsDir, { recursive: true, force: true });
		rmSync(bin, { recursive: true, force: true });
	}
});

test("JJ snapshot-first: external rewrite preserves unsnapshotted marker; stale fails closed", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees, diffJjWorktrees, cleanupJjWorktrees } = mod;
	const source = createTempJjSource("subagents-snap-first-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-snap-first-base-"));
	try {
		// --- Case A: external describe (concurrent rewrite) with unsnapshotted unique file.
		// Old order (update-stale before snapshot) wipes the marker; snapshot-first keeps it in the patch.
		const setupDescribe = createJjWorktrees(source, "snapDesc", 1, { baseDir });
		const wtDesc = setupDescribe.worktrees[0];
		const marker = "UNIQUE_MARKER_SNAPSHOT_FIRST\n";
		writeFileSync(join(wtDesc.path, "unique-marker.txt"), marker);
		// External rewrite of the Child WC change from Source WITHOUT ever running jj in the Child.
		const desc = sh(source, "jj", [
			"--ignore-working-copy",
			"describe",
			"-r",
			wtDesc.workspaceChangeId,
			"-m",
			"rewritten externally for capture",
		]);
		assert.equal(desc.status, 0, desc.stderr || desc.stdout);
		// Marker still only on disk (unsnapshotted).
		assert.equal(readFileSync(join(wtDesc.path, "unique-marker.txt"), "utf8"), marker);

		const diffsDir = mkdtempSync(join(tmpdir(), "subagents-snap-first-diffs-"));
		const diffs = diffJjWorktrees(setupDescribe, ["snap-agent"], diffsDir);
		assert.equal(diffs.length, 1);
		assert.equal(diffs[0].error, undefined, JSON.stringify(diffs[0]));
		const patch = readFileSync(diffs[0].patchPath, "utf8");
		assert.ok(
			patch.includes("unique-marker.txt"),
			`capture must preserve unsnapshotted marker after external describe; patch was:\n${patch}`,
		);
		assert.ok(patch.includes("UNIQUE_MARKER_SNAPSHOT_FIRST"), patch);
		// Disk bytes still present after capture.
		assert.equal(readFileSync(join(wtDesc.path, "unique-marker.txt"), "utf8"), marker);

		// Cleanup with successful capture may proceed (discard authorized).
		const cleanDesc = cleanupJjWorktrees(setupDescribe, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(cleanDesc.tasks[0].worktreeRemoved, true, JSON.stringify(cleanDesc.tasks[0]));

		// --- Case B: external rebase makes WC truly stale with unsnapshotted unique file.
		// Snapshot fails; must NOT run update-stale; preserve disk bytes; capture errors; cleanup preserves.
		const setupStale = createJjWorktrees(source, "snapStale", 1, { baseDir });
		const wtStale = setupStale.worktrees[0];
		const staleMarker = "STALE_UNIQUE_BYTES\n";
		writeFileSync(join(wtStale.path, "stale-unique.txt"), staleMarker);
		// Create a different destination and rebase the Child change from Source.
		writeFileSync(join(source, "other-dest.txt"), "other\n");
		const newDest = sh(source, "jj", ["new", "-m", "other dest"]);
		assert.equal(newDest.status, 0, newDest.stderr || newDest.stdout);
		const destCommit = sh(source, "jj", ["log", "-r", "@", "--no-graph", "-T", "commit_id"]).stdout.trim();
		const rebase = sh(source, "jj", [
			"--ignore-working-copy",
			"rebase",
			"-r",
			wtStale.workspaceChangeId,
			"-d",
			destCommit,
		]);
		assert.equal(rebase.status, 0, rebase.stderr || rebase.stdout);
		// Confirm Child is stale and marker still on disk before backend runs.
		const staleStatus = sh(wtStale.path, "jj", ["status"]);
		assert.notEqual(staleStatus.status, 0);
		assert.match(`${staleStatus.stderr}\n${staleStatus.stdout}`, /working copy is stale/i);
		assert.equal(readFileSync(join(wtStale.path, "stale-unique.txt"), "utf8"), staleMarker);

		const staleDiffsDir = mkdtempSync(join(tmpdir(), "subagents-snap-stale-diffs-"));
		const staleDiffs = diffJjWorktrees(setupStale, ["stale-agent"], staleDiffsDir);
		assert.equal(staleDiffs.length, 1);
		assert.ok(staleDiffs[0].error, "capture must fail closed on stale snapshot");
		assert.match(
			staleDiffs[0].error,
			/snapshot failed before update-stale|working copy is stale/i,
			staleDiffs[0].error,
		);
		// Critical: disk bytes preserved — old order would wipe via update-stale.
		assert.ok(existsSync(wtStale.path), "workspace path must remain");
		assert.equal(
			readFileSync(join(wtStale.path, "stale-unique.txt"), "utf8"),
			staleMarker,
			"stale capture must not wipe unsnapshotted unique file",
		);

		const cleanStale = cleanupJjWorktrees(setupStale, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(cleanStale.tasks[0].preserved, true, JSON.stringify(cleanStale.tasks[0]));
		assert.equal(cleanStale.tasks[0].worktreeRemoved, false);
		assert.ok(
			(cleanStale.tasks[0].errors ?? []).some((e) =>
				/snapshot failed before update-stale|working copy is stale|cleanup refused/i.test(e),
			),
			JSON.stringify(cleanStale.tasks[0]),
		);
		assert.equal(
			readFileSync(join(wtStale.path, "stale-unique.txt"), "utf8"),
			staleMarker,
			"cleanup must not wipe unique file after stale failure",
		);
		// Manual fixture cleanup (backend correctly preserved).
		sh(source, "jj", ["workspace", "forget", wtStale.branch]);
		rmSync(wtStale.path, { recursive: true, force: true });
		rmSync(diffsDir, { recursive: true, force: true });
		rmSync(staleDiffsDir, { recursive: true, force: true });
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("conservative cleanup preserves on identity drift", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees, cleanupJjWorktrees } = mod;
	const source = createTempJjSource("subagents-wt-drift-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-wt-base-drift-"));
	try {
		const setup = createJjWorktrees(source, "runB", 1, { baseDir });
		const wt = setup.worktrees[0];
		wt.workspaceChangeId = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
		const report = cleanupJjWorktrees(setup, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(report.tasks[0].preserved, true);
		assert.ok(existsSync(wt.path));
		const id = sh(wt.path, "jj", [
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			"change_id",
		]).stdout.trim();
		wt.workspaceChangeId = id;
		const report2 = cleanupJjWorktrees(setup, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(report2.tasks[0].worktreeRemoved, true);
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("persisted JJ handoff → discardPreservedWorktrees forgets workspace + removes path", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees } = mod;
	const source = createTempJjSource("subagents-handoff-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-handoff-base-"));
	const handoffDir = mkdtempSync(join(tmpdir(), "subagents-handoff-man-"));
	try {
		const setup = createJjWorktrees(source, "handoff1", 1, { baseDir });
		const wt = setup.worktrees[0];
		writeFileSync(join(wt.path, "kept.txt"), "preserve-me\n");

		// Stage the fork-owned parallel-handoff with real worktree routing.
		// Stage minimal graph: parallel-handoff imports worktree + types + atomic-json.
		const staging = mkdtempSync(join(tmpdir(), "subagents-handoff-stage-"));
		const sharedDir = join(staging, "src/runs/shared");
		const sharedRoot = join(staging, "src/shared");
		const policyDir = join(staging, "src/policy");
		mkdirSync(sharedDir, { recursive: true });
		mkdirSync(sharedRoot, { recursive: true });
		mkdirSync(policyDir, { recursive: true });
		cpSync(
			join(root, "src/runs/shared/parallel-handoff.ts"),
			join(sharedDir, "parallel-handoff.ts"),
		);
		cpSync(overlaySource, join(sharedDir, "jj-worktree-backend.ts"));
		writeGetAgentDirStub(staging);
		// Minimal worktree.ts that routes JJ cleanup to the real overlay backend.
		writeFileSync(
			join(sharedDir, "worktree.ts"),
			`import { cleanupJjWorktrees } from "./jj-worktree-backend.ts";
export function cleanupWorktrees(setup, intent) {
  if (setup?.backend === "jj" || setup?.worktrees?.some((wt) => wt?.backend === "jj")) {
    return cleanupJjWorktrees(setup, intent);
  }
  throw new Error("expected JJ setup in handoff discard test");
}
`,
		);
		writeFileSync(
			join(sharedRoot, "types.ts"),
			"export /** @typedef {string} SubagentResultStatus */\n",
		);
		writeFileSync(
			join(sharedRoot, "atomic-json.ts"),
			`import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
export function writeAtomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}
`,
		);
		writeFileSync(join(policyDir, "authority.ts"), "export function resolveAuthorityDecision(){return 'auto';}\n");

		const handoff = await import(
			pathToFileURL(join(sharedDir, "parallel-handoff.ts")).href + `?h=${Date.now()}`
		);
		const manifestPath = join(handoffDir, "handoff.json");
		// Write pending handoff (preserves cleanup tasks with JJ identity)
		handoff.writePendingParallelHandoff({
			manifestPath,
			runId: "handoff-run",
			mode: "parallel",
			source: "foreground",
			cwd: source,
			stepIndex: 0,
			flatStartIndex: 0,
			setup,
		});
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		assert.equal(manifest.version, 1);
		// Handoff persists baseCommit (shared Source snapshot S0) plus Child workspace identity; legacy source/frozen fields are not persisted.
		assert.equal(manifest.groups[0].baseCommit, setup.baseCommit);
		assert.equal(manifest.groups[0].sourceBaseCommit, undefined);
		assert.equal(manifest.groups[0].frozenBaseCommitId, undefined);
		const task = manifest.groups[0].cleanup.tasks[0];
		assert.equal(task.backend, "jj");
		assert.equal(task.workspaceChangeId, wt.workspaceChangeId);
		assert.equal(task.workspaceCommitId, wt.workspaceCommitId);
		assert.equal(task.preserved, true);
		assert.equal(task.path, wt.path);

		const D = wt.workspaceChangeId;
		const discarded = handoff.discardPreservedWorktrees(manifestPath, { kind: "policy" });
		assert.match(discarded.text, /Discard processed 1/);
		assert.ok(!existsSync(wt.path), "path removed after discard");
		const names = sh(source, "jj", ["workspace", "list", "-T", 'name ++ "\n"']).stdout;
		assert.ok(!names.includes(wt.branch), names);
		const after = JSON.parse(readFileSync(manifestPath, "utf8"));
		const afterTask = after.groups[0].cleanup.tasks[0];
		assert.equal(afterTask.worktreeRemoved, true);
		assert.equal(afterTask.branchRemoved, true);
		// Reconstructed handoff has full W identity → abandons owned D.
		const dVis = sh(source, "jj", [
			"--ignore-working-copy",
			"log",
			"-r",
			`~hidden() & ${D}`,
			"--no-graph",
			"-T",
			"change_id",
		]).stdout.trim();
		assert.equal(dVis, "", "handoff discard abandons owned D");
		assert.equal(after.groups[0].cleanup.state, "complete");

		// Second discard: no pending W.
		const again = handoff.discardPreservedWorktrees(manifestPath, { kind: "policy" });
		assert.match(again.text, /No preserved worktrees remain/);
		rmSync(staging, { recursive: true, force: true });
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(handoffDir, { recursive: true, force: true });
	}
});

test("final cleanup report keeps D0 so later discard reconstructs full identity", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees, cleanupJjWorktrees } = mod;
	const source = createTempJjSource("subagents-handoff-d0-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-handoff-d0-base-"));
	const handoffDir = mkdtempSync(join(tmpdir(), "subagents-handoff-d0-man-"));
	const foreignBase = mkdtempSync(join(tmpdir(), "subagents-handoff-d0-foreign-"));
	let foreignPath;
	let staging;
	try {
		const setup = createJjWorktrees(source, "handoffD0", 1, { baseDir });
		const wt = setup.worktrees[0];
		const D = wt.workspaceChangeId;
		const D0 = wt.workspaceCommitId;
		assert.ok(D && D0);

		const staged = await stageHandoffModule();
		staging = staged.staging;
		const handoff = staged.handoff;
		const manifestPath = join(handoffDir, "handoff.json");
		handoff.writePendingParallelHandoff({
			manifestPath,
			runId: "handoff-d0",
			mode: "parallel",
			source: "foreground",
			cwd: source,
			stepIndex: 0,
			flatStartIndex: 0,
			setup,
		});

		foreignPath = join(foreignBase, "foreign-child-of-D");
		const addForeign = sh(source, "jj", [
			"workspace",
			"add",
			"--name",
			"foreign-child-of-D",
			"-r",
			D,
			foreignPath,
		]);
		assert.equal(addForeign.status, 0, addForeign.stderr || addForeign.stdout);

		const report = cleanupJjWorktrees(setup, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(report.tasks[0].preserved, true, JSON.stringify(report.tasks[0]));
		assert.equal(report.tasks[0].workspaceChangeId, D);
		assert.equal(report.tasks[0].workspaceCommitId, D0, "cleanup report must keep D0");
		assert.ok(existsSync(wt.path));

		const stripped = {
			...report,
			tasks: report.tasks.map((task) => {
				const { workspaceCommitId: _dropped, ...rest } = task;
				return rest;
			}),
		};
		assert.equal(stripped.tasks[0].workspaceCommitId, undefined);

		handoff.writeParallelHandoffGroup({
			manifestPath,
			runId: "handoff-d0",
			mode: "parallel",
			source: "foreground",
			cwd: source,
			stepIndex: 0,
			flatStartIndex: 0,
			setup,
			diffs: [],
			results: [],
			cleanup: stripped,
		});
		const finalized = JSON.parse(readFileSync(manifestPath, "utf8"));
		const finalizedTask = finalized.groups[0].cleanup.tasks[0];
		assert.equal(finalizedTask.workspaceChangeId, D);
		assert.equal(finalizedTask.workspaceCommitId, D0, "final handoff write must not erase D0");
		assert.equal(finalizedTask.preserved, true);

		const foreignChange = sh(foreignPath, "jj", [
			"--ignore-working-copy",
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			"change_id",
		]).stdout.trim();
		sh(source, "jj", ["workspace", "forget", "foreign-child-of-D"]);
		if (foreignChange) sh(source, "jj", ["abandon", foreignChange]);
		rmSync(foreignPath, { recursive: true, force: true });
		foreignPath = undefined;

		const discarded = handoff.discardPreservedWorktrees(manifestPath, { kind: "policy" });
		assert.match(discarded.text, /Discard processed 1/);
		assert.ok(!existsSync(wt.path), "path removed after restored discard");
		const names = sh(source, "jj", ["workspace", "list", "-T", 'name ++ "\n"']).stdout;
		assert.ok(!names.includes(wt.branch), names);
		const dVis = sh(source, "jj", [
			"--ignore-working-copy",
			"log",
			"-r",
			`~hidden() & ${D}`,
			"--no-graph",
			"-T",
			"change_id",
		]).stdout.trim();
		assert.equal(dVis, "", "reconstructed discard abandons owned D");
		assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).groups[0].cleanup.state, "complete");
	} finally {
		if (foreignPath) {
			sh(source, "jj", ["workspace", "forget", "foreign-child-of-D"]);
			rmSync(foreignPath, { recursive: true, force: true });
		}
		if (staging) rmSync(staging, { recursive: true, force: true });
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(handoffDir, { recursive: true, force: true });
		rmSync(foreignBase, { recursive: true, force: true });
	}
});


test("invalid hook timeout/path and empty baseDir leave no visible duplicate (pre-duplicate validation)", async () => {
	const bin = mkdtempSync(join(tmpdir(), "subagents-pre-duplicate-bin-"));
	const realJj = spawnSync("which", ["jj"], { encoding: "utf8" }).stdout.trim();
	assert.ok(realJj);
	const wrapper = join(bin, "jj");
	const markerPath = join(bin, "duplicate-called");
	writeFileSync(
		wrapper,
		`#!/bin/sh
if [ "$1" = "--ignore-working-copy" ] && echo "$*" | grep -q " duplicate"; then
  echo called > ${JSON.stringify(markerPath)}
fi
if [ "$1" = "duplicate" ] || { [ "$1" = "--ignore-working-copy" ] && [ "$2" = "--color=never" ]; }; then
  for a in "$@"; do
    if [ "$a" = "duplicate" ]; then
      echo called > ${JSON.stringify(markerPath)}
      break
    fi
  done
fi
exec ${JSON.stringify(realJj)} "$@"
`,
	);
	chmodSync(wrapper, 0o755);
	const prevPath = process.env.PATH;
	process.env.PATH = `${bin}:${prevPath}`;
	try {
		const mod = await loadBackend();
		const { createJjWorktrees } = mod;
		const source = createTempJjSource("subagents-pref-val-");
		const baseDir = mkdtempSync(join(tmpdir(), "subagents-pref-base-"));
		const hookDir = mkdtempSync(join(tmpdir(), "subagents-pref-hook-"));
		try {
			const hookPath = writeHook(hookDir, "#!/bin/sh\nprintf '%s\\n' '{}'\n");
			// Invalid timeout must fail before duplicate.
			if (existsSync(markerPath)) rmSync(markerPath);
			assert.throws(
				() =>
					createJjWorktrees(source, "prefTimeout", 1, {
						baseDir,
						setupHook: { hookPath, timeoutMs: 0 },
					}),
				/timeout must be an integer greater than 0/,
			);
			assert.ok(!existsSync(markerPath), "duplicate must not run for invalid timeout");

			// Missing hook path must fail before duplicate.
			if (existsSync(markerPath)) rmSync(markerPath);
			assert.throws(
				() =>
					createJjWorktrees(source, "prefMissingHook", 1, {
						baseDir,
						setupHook: { hookPath: join(hookDir, "no-such-hook.sh") },
					}),
				/setup hook not found/,
			);
			assert.ok(!existsSync(markerPath), "duplicate must not run for missing hook");

			// Empty baseDir must fail before duplicate.
			if (existsSync(markerPath)) rmSync(markerPath);
			assert.throws(
				() => createJjWorktrees(source, "prefEmptyBase", 1, { baseDir: "   " }),
				/worktree base directory cannot be empty/,
			);
			assert.ok(!existsSync(markerPath), "duplicate must not run for empty baseDir");
		} finally {
			rmSync(source, { recursive: true, force: true });
			rmSync(baseDir, { recursive: true, force: true });
			rmSync(hookDir, { recursive: true, force: true });
		}
	} finally {
		process.env.PATH = prevPath;
		rmSync(bin, { recursive: true, force: true });
	}
});

test("post-duplicate content-check failpoint rolls back D0/D (no visible leak)", async () => {
	const bin = mkdtempSync(join(tmpdir(), "subagents-postdup-bin-"));
	const realJj = spawnSync("which", ["jj"], { encoding: "utf8" }).stdout.trim();
	assert.ok(realJj);
	const wrapper = join(bin, "jj");
	// Fail the post-duplicate content `jj diff --from S0 --to D0 --git` only.
	writeFileSync(
		wrapper,
		`#!/bin/sh
# Match: jj --ignore-working-copy diff --from <hex> --to <hex> --git
if [ "$1" = "--ignore-working-copy" ] && [ "$2" = "diff" ] && [ "$3" = "--from" ] && [ "$5" = "--to" ]; then
  echo "forced duplicate content check failure" >&2
  exit 1
fi
exec ${JSON.stringify(realJj)} "$@"
`,
	);
	chmodSync(wrapper, 0o755);
	const prevPath = process.env.PATH;
	process.env.PATH = `${bin}:${prevPath}`;
	const source = createTempJjSource("subagents-postdup-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-postdup-base-"));
	// Snapshot visible non-@ commits before (should stay free of leaked D).
	const beforeLog = sh(source, "jj", [
		"--ignore-working-copy",
		"log",
		"-r",
		"all() ~ hidden()",
		"--no-graph",
		"-T",
		'commit_id ++ "\\n"',
	]).stdout;
	try {
		const mod = await loadBackend();
		const { createJjWorktrees } = mod;
		assert.throws(
			() => createJjWorktrees(source, "postDupFail", 1, { baseDir }),
			/duplicate content check failed|forced frozen content check|content-identical/,
		);
		// No leftover workspaces.
		const names = sh(source, "jj", ["workspace", "list", "-T", 'name ++ "\\n"']).stdout;
		assert.ok(!names.includes("pi-jj-postDupFail-0"), names);
		// Visible commit set must not grow by an orphan duplicate (rollback abandons D).
		// Compare against real jj (not wrapper) by restoring PATH for queries.
		process.env.PATH = prevPath;
		const afterLog = sh(source, "jj", [
			"--ignore-working-copy",
			"log",
			"-r",
			"all() ~ hidden()",
			"--no-graph",
			"-T",
			'commit_id ++ "\\n"',
		]).stdout;
		const before = new Set(beforeLog.split("\n").map((l) => l.trim()).filter(Boolean));
		const after = new Set(afterLog.split("\n").map((l) => l.trim()).filter(Boolean));
		// Stronger: no workspace under baseDir and duplicate-created D0 is not visible as
		// a second head sibling. Query immutable empty + count of heads.
		const heads = sh(source, "jj", [
			"--ignore-working-copy",
			"log",
			"-r",
			"heads(all())",
			"--no-graph",
			"-T",
			'commit_id ++ "\\n"',
		]).stdout.trim().split("\n").filter(Boolean);
		// Source should remain a single head lineage (the duplicate was abandoned).
		assert.ok(heads.length >= 1, `heads=${heads.join(",")}`);
		// Diff set: any new visible commit that is not current @ should not exist.
		const atNow = sh(source, "jj", [
			"--ignore-working-copy",
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			"commit_id",
		]).stdout.trim();
		const leaked = [...after].filter((id) => !before.has(id) && id !== atNow);
		assert.deepEqual(leaked, [], `leaked visible commits after post-dup fail: ${leaked.join(",")}`);
	} finally {
		process.env.PATH = prevPath;
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(bin, { recursive: true, force: true });
	}
});

test("foreign descendant of owned W: preserve registration/path; IDs/parent/history unchanged", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees, cleanupJjWorktrees } = mod;
	const source = createTempJjSource("subagents-foreign-W-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-foreign-W-base-"));
	const foreignBase = mkdtempSync(join(tmpdir(), "subagents-foreign-W-ws-"));
	let foreignPath;
	try {
		const setup = createJjWorktrees(source, "foreignW", 1, { baseDir });
		const wt = setup.worktrees[0];
		const wChange = wt.workspaceChangeId;
		const wCommit = wt.workspaceCommitId;
		assert.ok(wChange && wCommit);

		// Foreign child of owned W: new workspace parented on W's change.
		foreignPath = join(foreignBase, "foreign-child-of-W");
		const addForeign = sh(source, "jj", [
			"workspace",
			"add",
			"--name",
			"foreign-child-of-W",
			"-r",
			wChange,
			foreignPath,
		]);
		assert.equal(addForeign.status, 0, addForeign.stderr || addForeign.stdout);
		const foreignBefore = sh(foreignPath, "jj", [
			"--ignore-working-copy",
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			'change_id ++ "\\n" ++ commit_id ++ "\\n" ++ parents.map(|c| c.commit_id() ++ "\\n")',
		]).stdout;
		const foreignChangeBefore = foreignBefore.trim().split("\n")[0];
		const foreignCommitBefore = foreignBefore.trim().split("\n")[1];
		const foreignParentBefore = foreignBefore.trim().split("\n")[2];
		assert.ok(foreignChangeBefore && foreignCommitBefore);
		// Parent of foreign child should be the owned W commit.
		assert.equal(foreignParentBefore, wCommit);

		const wIdentityBefore = sh(wt.path, "jj", [
			"--ignore-working-copy",
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			'change_id ++ "\\n" ++ commit_id ++ "\\n" ++ parents.map(|c| c.commit_id() ++ "\\n")',
		]).stdout.trim();

		const report = cleanupJjWorktrees(setup, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(report.tasks[0].preserved, true, JSON.stringify(report.tasks[0]));
		assert.equal(report.tasks[0].worktreeRemoved, false);
		assert.ok(existsSync(wt.path), "owned W path must remain");
		assert.ok(
			(report.tasks[0].errors ?? []).some((e) => /live descendants/i.test(e)),
			JSON.stringify(report.tasks[0]),
		);

		// Owned W registration + identity unchanged.
		const names = sh(source, "jj", ["workspace", "list", "-T", 'name ++ "\\n"']).stdout;
		assert.ok(names.includes(wt.branch), names);
		assert.ok(names.includes("foreign-child-of-W"), names);
		const wIdentityAfter = sh(wt.path, "jj", [
			"--ignore-working-copy",
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			'change_id ++ "\\n" ++ commit_id ++ "\\n" ++ parents.map(|c| c.commit_id() ++ "\\n")',
		]).stdout.trim();
		assert.equal(wIdentityAfter, wIdentityBefore);

		// Foreign child IDs/parent/history unchanged (no rewrite/rebase).
		const foreignAfter = sh(foreignPath, "jj", [
			"--ignore-working-copy",
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			'change_id ++ "\\n" ++ commit_id ++ "\\n" ++ parents.map(|c| c.commit_id() ++ "\\n")',
		]).stdout.trim();
		assert.equal(foreignAfter, foreignBefore.trim());
		assert.equal(foreignAfter.split("\n")[2], wCommit);
	} finally {
		if (source) {
			sh(source, "jj", ["workspace", "forget", "foreign-child-of-W"]);
			if (foreignPath && existsSync(foreignPath)) {
				const cid = sh(foreignPath, "jj", [
					"--ignore-working-copy",
					"log",
					"-r",
					"@",
					"--no-graph",
					"-T",
					"change_id",
				]).stdout.trim();
				if (cid) sh(source, "jj", ["abandon", cid]);
			}
		}
		if (foreignPath) rmSync(foreignPath, { recursive: true, force: true });
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(foreignBase, { recursive: true, force: true });
	}
});

test("divergent sibling of owned D: cleanup must not abandon the external revision", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees, cleanupJjWorktrees } = mod;
	const source = createTempJjSource("subagents-divergent-clean-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-divergent-clean-base-"));
	try {
		const setup = createJjWorktrees(source, "divClean", 1, { baseDir });
		const wt = setup.worktrees[0];
		const D = wt.workspaceChangeId;
		const D0 = wt.workspaceCommitId;
		assert.ok(D && D0);

		writeFileSync(join(wt.path, "child-work.txt"), "owned-work\n");
		assert.equal(sh(wt.path, "jj", ["describe", "-m", "owned child work"]).status, 0);
		const currentBefore = sh(wt.path, "jj", [
			"--ignore-working-copy",
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			"commit_id",
		]).stdout.trim();
		assert.notEqual(currentBefore, D0, "current owned commit must differ from D0");

		const sibling = createExternalDivergentSibling(wt.path);
		assert.equal(sibling.ownedChange, D);
		assert.equal(sibling.ownedCommit, currentBefore);

		const report = cleanupJjWorktrees(setup, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(report.tasks[0].workspaceCommitId, D0, "workspaceCommitId must remain D0");
		assertDivergentSiblingSurvived(source, sibling.divergentCommit, sibling.uniqueName);

		if (report.tasks[0].preserved) {
			assert.equal(report.tasks[0].worktreeRemoved, false, JSON.stringify(report.tasks[0]));
			assert.ok(existsSync(wt.path), "fail-closed cleanup must keep the owned path");
		} else {
			assert.equal(report.state, "complete", JSON.stringify(report));
			assert.ok(!existsSync(wt.path), "owned path may be removed when only the exact commit is abandoned");
			const ownedVisible = sh(source, "jj", [
				"--ignore-working-copy",
				"log",
				"-r",
				`~hidden() & ${sibling.ownedCommit}`,
				"--no-graph",
				"-T",
				"commit_id",
			]).stdout.trim();
			assert.equal(ownedVisible, "", "cleanup may abandon only the exact owned commit");
		}
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("divergent sibling of owned D: setup-rollback must not abandon the external revision", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees, cleanupJjWorktrees } = mod;
	const source = createTempJjSource("subagents-divergent-rollback-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-divergent-rollback-base-"));
	try {
		const setup = createJjWorktrees(source, "divRb", 1, { baseDir });
		const wt = setup.worktrees[0];
		const D0 = wt.workspaceCommitId;
		assert.ok(wt.workspaceChangeId && D0);

		const sibling = createExternalDivergentSibling(wt.path, "rollback-divergent.txt");
		assert.equal(sibling.ownedChange, wt.workspaceChangeId);

		const report = cleanupJjWorktrees(setup, { kind: "setup-rollback" });
		assert.equal(report.tasks[0].workspaceCommitId, D0, "workspaceCommitId must remain D0");
		assertDivergentSiblingSurvived(source, sibling.divergentCommit, sibling.uniqueName);

		if (report.tasks[0].preserved) {
			assert.equal(report.tasks[0].worktreeRemoved, false, JSON.stringify(report.tasks[0]));
			assert.ok(existsSync(wt.path), "fail-closed rollback must keep the owned path");
		} else {
			assert.ok(!existsSync(wt.path) || report.tasks[0].worktreeRemoved, JSON.stringify(report.tasks[0]));
			const ownedVisible = sh(source, "jj", [
				"--ignore-working-copy",
				"log",
				"-r",
				`~hidden() & ${sibling.ownedCommit}`,
				"--no-graph",
				"-T",
				"commit_id",
			]).stdout.trim();
			assert.equal(ownedVisible, "", "rollback may abandon only the exact owned commit");
		}
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("same-process and reconstructed cleanup both abandon owned D", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees, cleanupJjWorktrees } = mod;
	const source = createTempJjSource("subagents-auth-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-auth-base-"));
	try {
		const S = sh(source, "jj", ["log", "-r", "@", "--no-graph", "-T", "commit_id"]).stdout.trim();
		const setup = createJjWorktrees(source, "auth1", 1, { baseDir });
		const D = setup.worktrees[0].workspaceChangeId;
		const D0 = setup.worktrees[0].workspaceCommitId;
		assert.ok(D && D0 && D0 !== S);

		const report = cleanupJjWorktrees(setup, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(report.state, "complete", JSON.stringify(report));
		assert.ok(!existsSync(setup.worktrees[0].path));
		const dVis = sh(source, "jj", [
			"--ignore-working-copy",
			"log",
			"-r",
			`~hidden() & ${D}`,
			"--no-graph",
			"-T",
			"change_id",
		]).stdout.trim();
		assert.equal(dVis, "", "same-process cleanup must abandon owned D");
		const sVis = sh(source, "jj", [
			"--ignore-working-copy",
			"log",
			"-r",
			S,
			"--no-graph",
			"-T",
			"commit_id",
		]).stdout.trim();
		assert.equal(sVis, S, "Source S must remain after D abandon");
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("reconstructed handoff cleans W+D; malicious empty manifests cannot abandon Source/history", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees, cleanupJjWorktrees } = mod;
	const source = createTempJjSource("subagents-mal-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-mal-base-"));
	const handoffDir = mkdtempSync(join(tmpdir(), "subagents-mal-man-"));
	let staging;
	try {
		const S = sh(source, "jj", ["log", "-r", "@", "--no-graph", "-T", "commit_id"]).stdout.trim();
		const setup = createJjWorktrees(source, "mal1", 1, { baseDir });
		const wt = setup.worktrees[0];
		const D = wt.workspaceChangeId;
		const D0 = wt.workspaceCommitId;

		// Unrelated leaf commit (user history) that must never be abandoned.
		writeFileSync(join(source, "user-leaf.txt"), "user-work\n");
		assert.equal(sh(source, "jj", ["describe", "-m", "user leaf"]).status, 0);
		const unrelatedLeaf = sh(source, "jj", [
			"--ignore-working-copy",
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			"commit_id",
		]).stdout.trim();
		assert.equal(sh(source, "jj", ["new"]).status, 0);
		assert.ok(unrelatedLeaf && unrelatedLeaf !== D0 && unrelatedLeaf !== S);

		// 1) Reconstructed setup object with W identity cleans W and abandons D.
		const reconstructed = {
			cwd: setup.cwd,
			baseCommit: setup.baseCommit,
			backend: "jj",
			worktrees: setup.worktrees.map((w) => ({ ...w })),
		};
		const recon = cleanupJjWorktrees(reconstructed, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		assert.equal(recon.state, "complete", JSON.stringify(recon));
		assert.ok(!existsSync(wt.path));
		const dAfterRecon = sh(source, "jj", [
			"--ignore-working-copy",
			"log",
			"-r",
			`~hidden() & ${D}`,
			"--no-graph",
			"-T",
			"change_id",
		]).stdout.trim();
		assert.equal(dAfterRecon, "", "reconstructed cleanup abandons owned D");

		// 2) Empty worktrees + baseCommit == Source — no-op, Source remains.
		const asSource = cleanupJjWorktrees(
			{ cwd: source, baseCommit: S, backend: "jj", worktrees: [] },
			{ kind: "discard", authorization: { kind: "policy" } },
		);
		assert.equal(asSource.state, "complete");
		assert.equal(
			sh(source, "jj", ["--ignore-working-copy", "log", "-r", S, "--no-graph", "-T", "commit_id"]).stdout.trim(),
			S,
		);

		// 3) Empty worktrees + baseCommit = unrelated leaf — no-op.
		const asLeaf = cleanupJjWorktrees(
			{ cwd: source, baseCommit: unrelatedLeaf, backend: "jj", worktrees: [] },
			{ kind: "discard", authorization: { kind: "policy" } },
		);
		assert.equal(asLeaf.state, "complete");
		assert.equal(
			sh(source, "jj", [
				"--ignore-working-copy",
				"log",
				"-r",
				unrelatedLeaf,
				"--no-graph",
				"-T",
				"commit_id",
			]).stdout.trim(),
			unrelatedLeaf,
		);

		// 4) Handoff discard cleans W+D completely using recorded Child identity.
		staging = mkdtempSync(join(tmpdir(), "subagents-mal-stage-"));
		const sharedDir = join(staging, "src/runs/shared");
		const sharedRoot = join(staging, "src/shared");
		const policyDir = join(staging, "src/policy");
		mkdirSync(sharedDir, { recursive: true });
		mkdirSync(sharedRoot, { recursive: true });
		mkdirSync(policyDir, { recursive: true });
		cpSync(
			join(root, "src/runs/shared/parallel-handoff.ts"),
			join(sharedDir, "parallel-handoff.ts"),
		);
		cpSync(overlaySource, join(sharedDir, "jj-worktree-backend.ts"));
		writeGetAgentDirStub(staging);
		writeFileSync(
			join(sharedDir, "worktree.ts"),
			`import { cleanupJjWorktrees } from "./jj-worktree-backend.ts";
export function cleanupWorktrees(setup, intent) {
  if (setup?.backend === "jj" || setup?.worktrees?.some((w) => w?.backend === "jj")) {
    return cleanupJjWorktrees(setup, intent);
  }
  throw new Error("expected JJ");
}
`,
		);
		writeFileSync(join(sharedRoot, "types.ts"), "export {};\n");
		writeFileSync(
			join(sharedRoot, "atomic-json.ts"),
			`import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
export function writeAtomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}
`,
		);
		writeFileSync(join(policyDir, "authority.ts"), "export function resolveAuthorityDecision(){return 'auto';}\n");
		const handoff = await import(
			pathToFileURL(join(sharedDir, "parallel-handoff.ts")).href + `?mal=${Date.now()}`
		);

		const liveSetup = createJjWorktrees(source, "mal2", 1, { baseDir });
		const liveWt = liveSetup.worktrees[0];
		const liveD = liveWt.workspaceChangeId;
		const goodPath = join(handoffDir, "handoff-good.json");
		handoff.writePendingParallelHandoff({
			manifestPath: goodPath,
			runId: "mal-good",
			mode: "parallel",
			source: "foreground",
			cwd: source,
			stepIndex: 0,
			flatStartIndex: 0,
			setup: liveSetup,
		});
		const goodManifest = JSON.parse(readFileSync(goodPath, "utf8"));
		assert.equal(goodManifest.groups[0].frozenBaseCommitId, undefined);
		assert.equal(goodManifest.groups[0].sourceBaseCommit, undefined);
		assert.equal(goodManifest.groups[0].cleanup.tasks[0].workspaceChangeId, liveD);
		const discarded = handoff.discardPreservedWorktrees(goodPath, { kind: "policy" });
		assert.ok(!existsSync(liveWt.path), "handoff must clean W");
		const dAfterHandoff = sh(source, "jj", [
			"--ignore-working-copy",
			"log",
			"-r",
			`~hidden() & ${liveD}`,
			"--no-graph",
			"-T",
			"change_id",
		]).stdout.trim();
		assert.equal(dAfterHandoff, "", "handoff discard abandons owned D");
		assert.equal(JSON.parse(readFileSync(goodPath, "utf8")).groups[0].cleanup.state, "complete");
		assert.match(discarded.text, /Discard processed 1/);

		// Malicious legacy source/frozen fields are ignored.
		const evilPath = join(handoffDir, "handoff-evil-source.json");
		writeFileSync(
			evilPath,
			JSON.stringify(
				{
					version: 1,
					runId: "evil",
					mode: "parallel",
					source: "foreground",
					cwd: source,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					groups: [
						{
							stepIndex: 0,
							baseCommit: S,
							repoRoot: source,
							frozenBaseCommitId: S,
							sourceBaseCommit: S,
							children: [],
							cleanup: { state: "partial", pruned: false, tasks: [], errors: ["simulated"] },
						},
					],
				},
				null,
				2,
			),
		);
		const evilDiscard = handoff.discardPreservedWorktrees(evilPath, { kind: "policy" });
		assert.match(evilDiscard.text, /No preserved worktrees remain/);
		assert.equal(
			sh(source, "jj", ["--ignore-working-copy", "log", "-r", S, "--no-graph", "-T", "commit_id"]).stdout.trim(),
			S,
		);
		assert.equal(
			sh(source, "jj", [
				"--ignore-working-copy",
				"log",
				"-r",
				unrelatedLeaf,
				"--no-graph",
				"-T",
				"commit_id",
			]).stdout.trim(),
			unrelatedLeaf,
		);
	} finally {
		if (staging) rmSync(staging, { recursive: true, force: true });
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(handoffDir, { recursive: true, force: true });
	}
});

test("abandon-after-forget failpoint: worktreeRemoved false while path exists; branchRemoved false", async () => {
	const bin = makeJjPathWrapper("fail-abandon");
	const prevPath = process.env.PATH;
	process.env.PATH = `${bin}:${prevPath}`;
	try {
		const mod = await loadBackend();
		const { createJjWorktrees, cleanupJjWorktrees } = mod;
		const source = createTempJjSource("subagents-abandon-fail-");
		const baseDir = mkdtempSync(join(tmpdir(), "subagents-abandon-base-"));
		try {
			const setup = createJjWorktrees(source, "abandonFail", 1, { baseDir });
			const wt = setup.worktrees[0];
			assert.ok(existsSync(wt.path));
			const report = cleanupJjWorktrees(setup, {
				kind: "discard",
				authorization: { kind: "policy" },
			});
			assert.equal(report.tasks[0].worktreeRemoved, false, JSON.stringify(report.tasks[0]));
			assert.equal(report.tasks[0].branchRemoved, false, JSON.stringify(report.tasks[0]));
			assert.equal(report.tasks[0].preserved, true);
			assert.match(report.tasks[0].reason ?? "", /abandon failed after forget/);
			assert.ok(existsSync(wt.path), "path retained after abandon fail");
			// Registration forgotten (forget succeeded) — name absent.
			const names = sh(source, "jj", ["workspace", "list", "-T", 'name ++ "\\n"']).stdout;
			assert.ok(!names.includes(wt.branch), names);

			// Cleanup for real without failpoint.
			process.env.PATH = prevPath;
			// Re-add workspace registration is gone; abandon still needs real jj — path left.
			// Manual path cleanup.
			rmSync(wt.path, { recursive: true, force: true });
		} finally {
			rmSync(source, { recursive: true, force: true });
			rmSync(baseDir, { recursive: true, force: true });
		}
	} finally {
		process.env.PATH = prevPath;
		rmSync(bin, { recursive: true, force: true });
	}
});

test("rm failpoint after forget+abandon: worktreeRemoved false, branchRemoved true, preserved true", async () => {
	const mod = await loadBackend();
	const { createJjWorktrees, cleanupJjWorktrees, setForcePathRemoveErrorForTests } = mod;
	assert.equal(typeof setForcePathRemoveErrorForTests, "function");
	const source = createTempJjSource("subagents-rm-fail-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-rm-base-"));
	try {
		const setup = createJjWorktrees(source, "rmFail", 1, { baseDir });
		const wt = setup.worktrees[0];
		setForcePathRemoveErrorForTests("forced path remove failure");
		try {
			const report = cleanupJjWorktrees(setup, {
				kind: "discard",
				authorization: { kind: "policy" },
			});
			assert.equal(report.tasks[0].worktreeRemoved, false, JSON.stringify(report.tasks[0]));
			assert.equal(report.tasks[0].branchRemoved, true, JSON.stringify(report.tasks[0]));
			assert.equal(report.tasks[0].preserved, true);
			assert.match(report.tasks[0].reason ?? "", /path remove failed/);
			assert.ok(existsSync(wt.path));
			// D already abandoned after forget; path remove failure only preserves path.
			assert.equal(report.state, "partial");
			const D = setup.worktrees[0].workspaceChangeId;
			const dVis = sh(source, "jj", [
				"--ignore-working-copy",
				"log",
				"-r",
				`~hidden() & ${D}`,
				"--no-graph",
				"-T",
				"change_id",
			]).stdout.trim();
			assert.equal(dVis, "", "D abandoned even when path remove fails");
		} finally {
			setForcePathRemoveErrorForTests(undefined);
		}
		// Complete cleanup without failpoint.
		const report2 = cleanupJjWorktrees(setup, {
			kind: "discard",
			authorization: { kind: "policy" },
		});
		// Workspace already forgotten/abandoned; path may still be removed.
		if (existsSync(wt.path)) rmSync(wt.path, { recursive: true, force: true });
		assert.ok(report2);
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("setup-rollback abandon/rm fail reporting matches discard flags", async () => {
	const bin = makeJjPathWrapper("fail-abandon");
	const prevPath = process.env.PATH;
	// Create with real jj first.
	const mod = await loadBackend();
	const { createJjWorktrees, cleanupJjWorktrees, setForcePathRemoveErrorForTests } = mod;
	const source = createTempJjSource("subagents-sr-flags-");
	const baseDir = mkdtempSync(join(tmpdir(), "subagents-sr-base-"));
	try {
		const setup = createJjWorktrees(source, "srFlags", 1, { baseDir });
		// Simulate setup-rollback with abandon failpoint.
		process.env.PATH = `${bin}:${prevPath}`;
		const report = cleanupJjWorktrees(setup, { kind: "setup-rollback" });
		assert.equal(report.tasks[0].worktreeRemoved, false, JSON.stringify(report.tasks[0]));
		assert.equal(report.tasks[0].branchRemoved, false, JSON.stringify(report.tasks[0]));
		assert.equal(report.tasks[0].preserved, true);
		assert.match(report.tasks[0].reason ?? "", /abandon failed after forget/);
		assert.ok(existsSync(setup.worktrees[0].path));
		process.env.PATH = prevPath;

		// Path-remove fail after successful forget+abandon on a fresh setup.
		const setup2 = createJjWorktrees(source, "srRm", 1, { baseDir });
		setForcePathRemoveErrorForTests("forced setup-rollback rm failure");
		try {
			const report2 = cleanupJjWorktrees(setup2, { kind: "setup-rollback" });
			assert.equal(report2.tasks[0].worktreeRemoved, false, JSON.stringify(report2.tasks[0]));
			assert.equal(report2.tasks[0].branchRemoved, true, JSON.stringify(report2.tasks[0]));
			assert.equal(report2.tasks[0].preserved, true);
			assert.match(report2.tasks[0].reason ?? "", /path remove failed/);
		} finally {
			setForcePathRemoveErrorForTests(undefined);
			if (existsSync(setup2.worktrees[0].path)) {
				rmSync(setup2.worktrees[0].path, { recursive: true, force: true });
			}
		}
		if (existsSync(setup.worktrees[0].path)) {
			rmSync(setup.worktrees[0].path, { recursive: true, force: true });
		}
	} finally {
		process.env.PATH = prevPath;
		rmSync(bin, { recursive: true, force: true });
		rmSync(source, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("JJ recovery text contains read-only inspection guidance", async () => {
	const handoffSrc = readFileSync(
		join(root, "src/runs/shared/parallel-handoff.ts"),
		"utf8",
	);
	const jjBranch = handoffSrc.split('if (task.backend === "jj")')[1]?.split("} else {")[0] ?? "";
	assert.match(jjBranch, /jj -R/);
	assert.match(jjBranch, /workspace list/);
	assert.match(jjBranch, / log -r /);
	assert.match(jjBranch, / show /);
	assert.match(jjBranch, /exact current commit/);
	assert.match(jjBranch, /workspace name\/root/);
	assert.match(jjBranch, /D0 parents/);
	assert.match(jjBranch, /no foreign descendants/);
	assert.doesNotMatch(jjBranch, /git -C/);
	assert.doesNotMatch(jjBranch, /workspace forget/);
	assert.doesNotMatch(jjBranch, /\babandon\b/);
	assert.doesNotMatch(jjBranch, /rm -rf/);
});
