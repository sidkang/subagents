/**
 * Workflow Scratch scope and launch binding (Host-side).
 *
 * One Host mkdtemp per top-level native workflowScript execution. Unrelated to
 * JJ/VCS. Every leaf Child receives a binding to the same Host root through a
 * narrow per-launch field; parent/global process.env is never mutated.
 *
 * Mount authority is never ambient process.env. Proven sources only:
 * 1. Active AsyncLocalStorage Workflow Scratch Scope on the Host workflow body
 * 2. Runner-local Workflow Scratch Launch Binding installed from detached
 *    launchConfig after narrow validation
 *
 * Host temp base prefers the canonical realpath of `/tmp` when that path exists
 * and is a directory (e.g. `/private/tmp` on macOS, `/tmp` on Linux). This is
 * required for Microsandbox Host binds: macOS `os.tmpdir()` under `/var/folders`
 * is not MSB-bindable (BootStart ENOTDIR on the guest volume). Platforms without
 * a usable `/tmp` fall back to `os.tmpdir()`. Random mkdtemp suffix is retained;
 * the Host root stays Host-only and never enters model-facing content.
 *
 * Cleanup is non-blocking refcount: mark the scope closed, remove the exact root
 * only after all tracked launches settle. On uncertainty/crash leave it for OS
 * temp cleanup. Async/detached leaves disable eager cleanup for the whole scope.
 * Cleanup is not handoff/retained.
 *
 * Fork sync: this fork owns Workflow Scratch Scope, Launch Binding, and the
 * private Child Mount Adapter. Remove this module only when upstream provides
 * the same scoped authority, detached transport, and conservative cleanup.
 * Recheck foreground, async runner, and buildPiArgs wiring on every upstream sync.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Host-only env field that projects a proven Launch Binding into one Child spawn. */
export const WORKFLOW_SCRATCH_ROOT_ENV = "SUBAGENTS_WORKFLOW_SCRATCH_ROOT" as const;

/** Preferred portable Host temp base for MSB-bindable scratch roots. */
const PREFERRED_HOST_TEMP_CANDIDATE = "/tmp" as const;

/** mkdtemp basename prefix for package-created Workflow Scratch roots. */
const SCRATCH_BASENAME_PREFIX = "subagents-wf-scratch-" as const;

/** Optional dependencies for temp-root selection tests. */
export interface WorkflowScratchTempRootDeps {
	existsSync?: (path: string) => boolean;
	statSync?: (path: string) => { isDirectory(): boolean };
	realpathSync?: (path: string) => string;
	tmpdir?: () => string;
}

/**
 * Resolve a portable Host temp root for Workflow Scratch.
 *
 * Prefer canonical `/tmp` so Host binds work under Microsandbox. Fall back to
 * `os.tmpdir()` only when `/tmp` is missing or unusable.
 */
export function resolveWorkflowScratchTempRoot(
	deps: WorkflowScratchTempRootDeps = {},
): string {
	const exists = deps.existsSync ?? existsSync;
	const stat = deps.statSync ?? statSync;
	const realpath = deps.realpathSync ?? realpathSync;
	const osTmpdir = deps.tmpdir ?? tmpdir;
	try {
		if (exists(PREFERRED_HOST_TEMP_CANDIDATE)) {
			const st = stat(PREFERRED_HOST_TEMP_CANDIDATE);
			if (st.isDirectory()) return realpath(PREFERRED_HOST_TEMP_CANDIDATE);
		}
	} catch {
		// Missing/unreadable/not-a-dir: fall through to os.tmpdir().
	}
	return osTmpdir();
}

/** One top-level workflow's temporary cooperative file scope. */
export interface WorkflowScratchScope {
	/** Opaque scope id for diagnostics. */
	scopeId: string;
	/** Absolute Host root created by mkdtemp. */
	hostRoot: string;
	/** Number of in-flight tracked Child launches. */
	activeLaunches: number;
	/** True after the top-level workflowScript body finishes. */
	closed: boolean;
	/** True after successful exact-root removal. */
	removed: boolean;
	/** When true, leave the Host root for OS temp cleanup. */
	cleanupDisabled: boolean;
}

/** Trusted association between one Child launch and one Workflow Scratch root. */
export interface WorkflowScratchLaunchBinding {
	readonly hostRoot: string;
}

const storage = new AsyncLocalStorage<WorkflowScratchScope>();

/** Detached-runner-only binding installed from launchConfig, never ambient env. */
let runnerLocalScratchBinding: WorkflowScratchLaunchBinding | undefined;

/** Absolute path to the private Child Mount Adapter shipped in this package. */
export function workflowScratchMountAdapterPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "workflow-scratch-mount-adapter.ts");
}

function freezeLaunchBinding(hostRoot: string): WorkflowScratchLaunchBinding {
	return Object.freeze({ hostRoot });
}

function realPathSafe(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

function isUnderRoot(candidate: string, root: string): boolean {
	const realCandidate = realPathSafe(candidate);
	const realRoot = realPathSafe(root);
	return realCandidate === realRoot || realCandidate.startsWith(realRoot + sep);
}

function validateWorkflowScratchHostRoot(hostRoot: unknown): string | undefined {
	if (typeof hostRoot !== "string") return undefined;
	const trimmed = hostRoot.trim();
	if (!trimmed || !isAbsolute(trimmed)) return undefined;
	const leaf = basename(trimmed);
	if (!leaf.startsWith(SCRATCH_BASENAME_PREFIX)) return undefined;
	// Reject path tricks: basename alone must be the leaf component.
	if (leaf !== trimmed.split(/[/\\]/).pop()) return undefined;
	try {
		if (!existsSync(trimmed)) return undefined;
		const st = statSync(trimmed);
		if (!st.isDirectory()) return undefined;
		const realHostRoot = realpathSync(trimmed);
		if (!basename(realHostRoot).startsWith(SCRATCH_BASENAME_PREFIX)) return undefined;
		if (!isUnderRoot(realHostRoot, resolveWorkflowScratchTempRoot())) return undefined;
		return realHostRoot;
	} catch {
		return undefined;
	}
}

/**
 * Validate a detached runner's Launch Binding. Accept only the exact closed
 * shape `{ hostRoot }` pointing at an existing package-created temp directory.
 */
export function validateWorkflowScratchLaunchBinding(
	value: unknown,
): WorkflowScratchLaunchBinding | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const keys = Object.keys(value);
	if (keys.length !== 1 || keys[0] !== "hostRoot") return undefined;
	const hostRoot = validateWorkflowScratchHostRoot(
		(value as { hostRoot?: unknown }).hostRoot,
	);
	return hostRoot ? freezeLaunchBinding(hostRoot) : undefined;
}

/**
 * Install runner-local authority from detached launchConfig. Invalid bindings
 * fail closed: no install means no Mount Adapter injection and no mount env.
 */
export function installRunnerWorkflowScratchLaunchBinding(
	value: unknown,
): WorkflowScratchLaunchBinding | undefined {
	const binding = validateWorkflowScratchLaunchBinding(value);
	runnerLocalScratchBinding = binding;
	return binding;
}

/** Clear runner-local authority in tests. */
export function clearRunnerWorkflowScratchLaunchBindingForTests(): void {
	runnerLocalScratchBinding = undefined;
}

function createWorkflowScratchScope(): WorkflowScratchScope {
	const hostRoot = mkdtempSync(join(resolveWorkflowScratchTempRoot(), SCRATCH_BASENAME_PREFIX));
	return {
		scopeId: `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
		hostRoot,
		activeLaunches: 0,
		closed: false,
		removed: false,
		cleanupDisabled: false,
	};
}

function tryRemove(scope: WorkflowScratchScope): void {
	if (scope.removed || scope.cleanupDisabled || !scope.closed || scope.activeLaunches > 0) return;
	try {
		rmSync(scope.hostRoot, { recursive: true, force: true });
		scope.removed = true;
	} catch {
		// Uncertain/crash: leave for OS temp cleanup. Never throw into finalizers.
	}
}

/** Current Workflow Scratch Scope, if one is active. */
export function getActiveWorkflowScratchScope(): WorkflowScratchScope | undefined {
	return storage.getStore();
}

/**
 * Resolve the proven Launch Binding for the current process-local execution.
 * Prefer the active Host scope; otherwise use the validated detached binding.
 * Ambient process.env is never authority.
 */
export function getActiveWorkflowScratchLaunchBinding(): WorkflowScratchLaunchBinding | undefined {
	const scope = storage.getStore();
	if (scope && !scope.removed) return freezeLaunchBinding(scope.hostRoot);
	return runnerLocalScratchBinding;
}

/** Project the active Launch Binding into one Child spawn environment. */
export function getActiveWorkflowScratchLaunchEnv(): Record<string, string> | undefined {
	const binding = getActiveWorkflowScratchLaunchBinding();
	return binding ? { [WORKFLOW_SCRATCH_ROOT_ENV]: binding.hostRoot } : undefined;
}

/** Whether buildPiArgs must inject the private Child Mount Adapter. */
export function shouldInjectWorkflowScratchMountAdapter(): boolean {
	return getActiveWorkflowScratchLaunchBinding() !== undefined;
}

/** Disable eager Host-root deletion for an async/detached Child. */
export function disableWorkflowScratchCleanup(scope?: WorkflowScratchScope): void {
	const target = scope ?? storage.getStore();
	if (target) target.cleanupDisabled = true;
}

/** Track one Child launch under the active scope and return its settle callback. */
export function trackWorkflowScratchLaunch(): () => void {
	const scope = storage.getStore();
	if (!scope || scope.removed) return () => {};
	scope.activeLaunches += 1;
	let settled = false;
	return () => {
		if (settled) return;
		settled = true;
		scope.activeLaunches = Math.max(0, scope.activeLaunches - 1);
		tryRemove(scope);
	};
}

/** Close one scope and remove it when all tracked launches have settled. */
export function closeWorkflowScratchScope(scope: WorkflowScratchScope): void {
	scope.closed = true;
	tryRemove(scope);
}

/** Run one top-level workflow inside a new Workflow Scratch Scope. */
export async function withWorkflowScratchScope<T>(
	fn: (scope: WorkflowScratchScope) => Promise<T>,
): Promise<T> {
	const scope = createWorkflowScratchScope();
	return storage.run(scope, async () => {
		try {
			return await fn(scope);
		} finally {
			closeWorkflowScratchScope(scope);
		}
	});
}

/**
 * Open a scope for fire-and-forget workflow paths that cannot await the whole
 * body at construction time. Caller must dispose after the workflow settles.
 */
export function openWorkflowScratchScope(): {
	scope: WorkflowScratchScope;
	run: <T>(fn: () => Promise<T>) => Promise<T>;
	dispose: () => void;
} {
	const scope = createWorkflowScratchScope();
	return {
		scope,
		run: <T>(fn: () => Promise<T>) => storage.run(scope, fn),
		dispose: () => closeWorkflowScratchScope(scope),
	};
}

/** Test helper: force-remove one exact scope root. */
export function forceRemoveWorkflowScratchScopeForTests(scope: WorkflowScratchScope): void {
	scope.closed = true;
	scope.activeLaunches = 0;
	scope.cleanupDisabled = false;
	tryRemove(scope);
}
