/**
 * Private Child Mount Adapter for Workflow Scratch.
 *
 * When the Child launch environment contains a non-empty proven scratch root,
 * project it into Sandbox as one construction-time mount:
 *
 *   Host scratch root → Guest /workflow-shared (rw)
 *
 * The adapter does not own scratch lifecycle, Agent selection, prompts, JJ/VCS,
 * delegation, or cleanup. It does not replace the built-in `/workspace` mount.
 * Absent or neutralized env is a no-op.
 *
 * Fork sync: this adapter is the Child-process seam between the fork-owned
 * Workflow Scratch Launch Binding and Sandbox Session Mount Override. Remove it
 * only when upstream supplies the same private projection. Recheck Sandbox's
 * query channel and construction-time provider timing on every upstream sync.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Local process-seam copy of the Host env field name; keep in sync with Host export. */
const SUBAGENTS_WORKFLOW_SCRATCH_ROOT = "SUBAGENTS_WORKFLOW_SCRATCH_ROOT" as const;
/** Fixed Guest path projected by this adapter. */
const WORKFLOW_SCRATCH_GUEST_PATH = "/workflow-shared" as const;

const SANDBOX_SESSION_MOUNT_OVERRIDE_QUERY = "sandbox:session-mount-override:query";

function isMountOverrideQuery(value: unknown): value is { provide: (override: unknown) => void } {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as { provide?: unknown }).provide === "function"
	);
}

function freezeOverride(hostRoot: string): {
	mounts: readonly { hostPath: string; guestPath: string; access: "rw" }[];
} {
	const mount = Object.freeze({
		hostPath: hostRoot,
		guestPath: WORKFLOW_SCRATCH_GUEST_PATH,
		access: "rw" as const,
	});
	return Object.freeze({ mounts: Object.freeze([mount]) });
}

export default function workflowScratchMountAdapter(pi: ExtensionAPI): void {
	const hostRoot = process.env[SUBAGENTS_WORKFLOW_SCRATCH_ROOT];
	if (typeof hostRoot !== "string" || !hostRoot.trim()) return;
	const snapshot = freezeOverride(hostRoot.trim());

	// Factory-time registration is required before Sandbox handles session_start.
	// This must be the sole Session Mount Override provider for the generation.
	pi.events.on(SANDBOX_SESSION_MOUNT_OVERRIDE_QUERY, (payload: unknown) => {
		try {
			if (isMountOverrideQuery(payload)) payload.provide(snapshot);
		} catch {
			// Never throw into EventBus emit.
		}
	});
}
