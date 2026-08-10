/**
 * Workflow-scoped Sandbox shared scratch (Host-side).
 *
 * One Host mkdtemp per top-level native workflowScript execution. Unrelated to
 * JJ/VCS. Every leaf Child receives the same Host path via a narrow per-spawn
 * Host-only env field (never mutates parent/global process.env).
 *
 * Mount authority is never ambient process.env. Proven sources only:
 * 1. Active AsyncLocalStorage scope on the Host workflow body
 * 2. Runner-local value explicitly installed from detached launchConfig
 *    (workflowSharedScratchHostPath), validated narrowly before install
 *
 * Host temp base prefers the canonical realpath of `/tmp` when that path exists
 * and is a directory (e.g. `/private/tmp` on macOS, `/tmp` on Linux). This is
 * required for microsandbox Host binds: macOS `os.tmpdir()` under `/var/folders`
 * is not MSB-bindable (BootStart ENOTDIR on the guest volume). Platforms without
 * a usable `/tmp` fall back to `os.tmpdir()`. Random mkdtemp suffix is retained;
 * Host path stays Host-only (never model-facing).
 *
 * Cleanup is non-blocking refcount: mark workflow closed, remove exact mkdtemp
 * only after all tracked launches settle. On uncertainty/crash leave for OS temp.
 * Async/detached leaves disable eager cleanup for the whole scope (OS temp).
 * Cleanup is not handoff/retained.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Host-only env field injected into Child spawn env (never model-facing). */
export const WORKFLOW_SHARED_SCRATCH_ENV = "SUBAGENTS_WORKFLOW_SHARED_SCRATCH" as const;

/**
 * Fixed Guest path for the shared scratch mount. Does not replace /workspace.
 * Must stay off guest `/tmp/*`: microsandbox mounts tmpfs on `/tmp` and shadows nested binds.
 */
export const WORKFLOW_SHARED_SCRATCH_GUEST = "/workflow-shared" as const;

/** Preferred portable Host temp base for MSB-bindable scratch (not guest path). */
const PREFERRED_HOST_TEMP_CANDIDATE = "/tmp" as const;

/** mkdtemp basename prefix for package-created scratch directories. */
const SCRATCH_BASENAME_PREFIX = "subagents-wf-shared-" as const;

/** Optional deps for root selection tests (production uses node:fs / node:os). */
export interface WorkflowSharedScratchTempRootDeps {
	existsSync?: (path: string) => boolean;
	statSync?: (path: string) => { isDirectory(): boolean };
	realpathSync?: (path: string) => string;
	tmpdir?: () => string;
}

/**
 * Resolve a portable Host temp root for workflow shared scratch mkdtemp.
 *
 * Prefer canonical realpath of `/tmp` when it exists and is a directory so Host
 * binds work under microsandbox (macOS `os.tmpdir()` under `/var/folders` is not
 * MSB-bindable). Fall back to `os.tmpdir()` when `/tmp` is missing/unusable.
 */
export function resolveWorkflowSharedScratchTempRoot(
	deps: WorkflowSharedScratchTempRootDeps = {},
): string {
	const exists = deps.existsSync ?? existsSync;
	const stat = deps.statSync ?? statSync;
	const realpath = deps.realpathSync ?? realpathSync;
	const osTmpdir = deps.tmpdir ?? tmpdir;
	try {
		if (exists(PREFERRED_HOST_TEMP_CANDIDATE)) {
			const st = stat(PREFERRED_HOST_TEMP_CANDIDATE);
			if (st.isDirectory()) {
				return realpath(PREFERRED_HOST_TEMP_CANDIDATE);
			}
		}
	} catch {
		// Missing/unreadable/not-a-dir: fall through to os.tmpdir().
	}
	return osTmpdir();
}

export interface WorkflowSharedScratchScope {
	/** Opaque scope id (for diagnostics). */
	scopeId: string;
	/** Absolute Host path from mkdtemp. */
	hostPath: string;
	/** Number of in-flight tracked launches. */
	activeLaunches: number;
	/** True after the top-level workflowScript body has finished (success or failure). */
	closed: boolean;
	/** True after successful path removal. */
	removed: boolean;
	/**
	 * When true, never rm the Host path (async/detached leaf still needs it).
	 * Leave for OS temp cleanup.
	 */
	cleanupDisabled: boolean;
}

const storage = new AsyncLocalStorage<WorkflowSharedScratchScope>();

/**
 * Detached-runner-only mount authority. Installed from launchConfig JSON, never
 * from ambient process.env. Module-local so it cannot leak across processes.
 */
let runnerLocalScratchHostPath: string | undefined;

/** Absolute path to the companion Child extension (installed next to this overlay). */
export function companionExtensionPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "workflow-shared-scratch-child.ts");
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

/**
 * Narrow validation for runner-config scratch transport.
 * Accept only an existing absolute package-created temp directory under the
 * resolved scratch temp root with `subagents-wf-shared-` basename. Fail closed.
 */
export function validateWorkflowSharedScratchHostPath(hostPath: unknown): string | undefined {
	if (typeof hostPath !== "string") return undefined;
	const trimmed = hostPath.trim();
	if (!trimmed) return undefined;
	if (!isAbsolute(trimmed)) return undefined;
	const leaf = basename(trimmed);
	if (!leaf.startsWith(SCRATCH_BASENAME_PREFIX)) return undefined;
	// Reject path tricks: basename alone must be the leaf component.
	if (leaf !== trimmed.split(/[/\\]/).pop()) return undefined;
	try {
		if (!existsSync(trimmed)) return undefined;
		const st = statSync(trimmed);
		if (!st.isDirectory()) return undefined;
		const realHost = realpathSync(trimmed);
		const realLeaf = basename(realHost);
		if (!realLeaf.startsWith(SCRATCH_BASENAME_PREFIX)) return undefined;
		const tempRoot = resolveWorkflowSharedScratchTempRoot();
		if (!isUnderRoot(realHost, tempRoot)) return undefined;
		return realHost;
	} catch {
		return undefined;
	}
}

/**
 * Install runner-local scratch authority from detached launchConfig.
 * Invalid/arbitrary paths fail closed (no install → no companion / no mount env).
 * Returns the installed absolute path, or undefined when rejected.
 */
export function installRunnerWorkflowSharedScratchFromConfig(hostPath: unknown): string | undefined {
	const validated = validateWorkflowSharedScratchHostPath(hostPath);
	runnerLocalScratchHostPath = validated;
	return validated;
}

/** Clear runner-local authority (tests only). */
export function clearRunnerWorkflowSharedScratchForTests(): void {
	runnerLocalScratchHostPath = undefined;
}

function createScope(): WorkflowSharedScratchScope {
	const hostPath = mkdtempSync(join(resolveWorkflowSharedScratchTempRoot(), SCRATCH_BASENAME_PREFIX));
	return {
		scopeId: `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
		hostPath,
		activeLaunches: 0,
		closed: false,
		removed: false,
		cleanupDisabled: false,
	};
}

function tryRemove(scope: WorkflowSharedScratchScope): void {
	if (scope.removed) return;
	if (scope.cleanupDisabled) return;
	if (!scope.closed) return;
	if (scope.activeLaunches > 0) return;
	try {
		rmSync(scope.hostPath, { recursive: true, force: true });
		scope.removed = true;
	} catch {
		// Uncertain/crash: leave for OS temp cleanup. Never throw into workflow finalizers.
	}
}

/** Current scope if running under an open/closed-but-active workflow scratch. */
export function getActiveWorkflowSharedScratch(): WorkflowSharedScratchScope | undefined {
	return storage.getStore();
}

/**
 * Host-only spawn env fragment for the active proven scope.
 * - Prefer ALS scope when present (Host workflow body).
 * - Else runner-local value installed from detached launchConfig (validated).
 * - NEVER reads process.env (ambient env is not mount authority).
 * Returns undefined when neither proven source is available.
 */
export function getActiveWorkflowSharedScratchEnv(): Record<string, string> | undefined {
	const scope = storage.getStore();
	if (scope && !scope.removed) {
		return { [WORKFLOW_SHARED_SCRATCH_ENV]: scope.hostPath };
	}
	if (typeof runnerLocalScratchHostPath === "string" && runnerLocalScratchHostPath) {
		return { [WORKFLOW_SHARED_SCRATCH_ENV]: runnerLocalScratchHostPath };
	}
	return undefined;
}

/**
 * Whether buildPiArgs should inject the companion extension path.
 */
export function shouldInjectWorkflowSharedScratchCompanion(): boolean {
	return getActiveWorkflowSharedScratchEnv() !== undefined;
}

/**
 * Disable eager Host-path deletion for the active scope (or an explicit scope).
 * Used when a leaf is detached/async and may outlive the workflow body.
 * For explicit `async: true` launches, call before awaiting execute so a
 * successful spawn + later throw/cancel still leaves the path for the live job.
 */
export function disableWorkflowSharedScratchCleanup(scope?: WorkflowSharedScratchScope): void {
	const target = scope ?? storage.getStore();
	if (!target) return;
	target.cleanupDisabled = true;
}

/**
 * Track one Child launch under the active scope. Returns a settle callback.
 * Safe no-op when no active scope.
 */
export function trackWorkflowSharedScratchLaunch(): () => void {
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

/**
 * Mark the workflow body closed and attempt cleanup when no launches remain.
 */
export function closeWorkflowSharedScratch(scope: WorkflowSharedScratchScope): void {
	scope.closed = true;
	tryRemove(scope);
}

/**
 * Open one scratch scope and run `fn` inside AsyncLocalStorage.
 * Concurrent top-level workflows get distinct Host paths (separate ALS entries).
 * Multiple workflows in one/different Pi sessions do not cross.
 */
export async function withWorkflowSharedScratch<T>(fn: (scope: WorkflowSharedScratchScope) => Promise<T>): Promise<T> {
	const scope = createScope();
	return storage.run(scope, async () => {
		try {
			return await fn(scope);
		} finally {
			closeWorkflowSharedScratch(scope);
		}
	});
}

/**
 * Synchronous enter for fire-and-forget async workflow paths that cannot await
 * the whole body at open time. Caller must invoke the returned `dispose` once
 * the workflow body settles (success or failure).
 */
export function openWorkflowSharedScratch(): {
	scope: WorkflowSharedScratchScope;
	run: <T>(fn: () => Promise<T>) => Promise<T>;
	dispose: () => void;
} {
	const scope = createScope();
	return {
		scope,
		run: <T>(fn: () => Promise<T>) => storage.run(scope, fn),
		dispose: () => closeWorkflowSharedScratch(scope),
	};
}

/** Test helper: force-remove a scope path (does not touch other scopes). */
export function forceRemoveWorkflowSharedScratchForTests(scope: WorkflowSharedScratchScope): void {
	scope.closed = true;
	scope.activeLaunches = 0;
	scope.cleanupDisabled = false;
	tryRemove(scope);
}
