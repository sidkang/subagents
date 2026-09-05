/**
 * Private native-session Mount Adapter. Authority is captured from a proven
 * launch binding, never from the shared hosting process's environment.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowScratchLaunchBinding } from "./workflow-scratch.ts";

const SANDBOX_SESSION_MOUNT_OVERRIDE_QUERY = "sandbox:session-mount-override:query";
const WORKFLOW_SCRATCH_GUEST_PATH = "/workflow-shared";

function isMountOverrideQuery(value: unknown): value is { provide: (override: unknown) => void } {
	return !!value && typeof value === "object" && typeof (value as { provide?: unknown }).provide === "function";
}

/** Capture per-session authority before any async extension loading can overlap. */
export function createWorkflowScratchMountAdapter(binding: WorkflowScratchLaunchBinding): (pi: ExtensionAPI) => void {
	const snapshot = Object.freeze({
		mounts: Object.freeze([Object.freeze({
			hostPath: binding.hostRoot,
			guestPath: WORKFLOW_SCRATCH_GUEST_PATH,
			access: "rw" as const,
		})]),
	});
	return (pi) => {
		// Register before Sandbox's session_start construction. Keep /workspace.
		pi.events.on(SANDBOX_SESSION_MOUNT_OVERRIDE_QUERY, (payload: unknown) => {
			if (isMountOverrideQuery(payload)) payload.provide(snapshot);
		});
	};
}
