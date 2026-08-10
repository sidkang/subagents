/**
 * Companion Child extension for workflow-scoped Sandbox shared scratch.
 *
 * Always-loaded when SUBAGENTS_WORKFLOW_SHARED_SCRATCH is a non-empty Host path in
 * Child env. Registers Sandbox Session Mount Override at extension-factory time:
 *   Host path (from env) → Guest /workflow-shared (rw)
 *
 * Does NOT replace built-in ctx.cwd → /workspace.
 * Session Mount Override replaces Owner supplemental mounts and requires a sole
 * provider for that generation (0 → Owner mounts; 1 → override; >1 → fail closed).
 *
 * When env is absent, empty, or neutralized (""): no-op.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENV = "SUBAGENTS_WORKFLOW_SHARED_SCRATCH";
// Fixed Guest path (must match Host WORKFLOW_SHARED_SCRATCH_GUEST). Off /tmp: MSB tmpfs shadows /tmp/* binds.
const GUEST = "/workflow-shared";
const CHANNEL = "sandbox:session-mount-override:query";

const SYSTEM_HINT =
	"Workflow shared scratch is mounted at /workflow-shared (cooperative; use unique names/subdirectories). " +
	"Built-in project workspace remains at /workspace.";

function isMountOverrideQuery(value: unknown): value is { provide: (override: unknown) => void } {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as { provide?: unknown }).provide === "function"
	);
}

function freezeOverride(hostPath: string): {
	mounts: readonly { hostPath: string; guestPath: string; access: "rw" }[];
} {
	const mount = Object.freeze({
		hostPath: String(hostPath),
		guestPath: GUEST,
		access: "rw" as const,
	});
	return Object.freeze({
		mounts: Object.freeze([mount]),
	});
}

function appendSystemHint(base: unknown): string {
	const existing = typeof base === "string" ? base : "";
	if (!existing.trim()) return SYSTEM_HINT;
	return `${existing.trimEnd()}\n\n${SYSTEM_HINT}`;
}

export default function workflowSharedScratchChild(pi: ExtensionAPI): void {
	const hostPath = process.env[ENV];
	if (typeof hostPath !== "string" || !hostPath.trim()) {
		// Env absent / empty / neutralized: no-op (do not register provider or prompt hint).
		return;
	}
	const snapshot = freezeOverride(hostPath.trim());

	// Factory-time registration: must be present before Sandbox session_start query.
	// Sole provider contract: this extension must be the only Session Mount Override
	// provider for the Child generation when scratch is active.
	pi.events.on(CHANNEL, (payload: unknown) => {
		try {
			if (!isMountOverrideQuery(payload)) return;
			payload.provide(snapshot);
		} catch {
			// Never throw into EventBus emit.
		}
	});

	// Append short Child system-prompt hint only when active. Never replace base prompt
	// and never expose Host path.
	pi.on("before_agent_start", async (event: unknown) => {
		const systemPrompt =
			event && typeof event === "object" && "systemPrompt" in event
				? (event as { systemPrompt?: unknown }).systemPrompt
				: undefined;
		return { systemPrompt: appendSystemHint(systemPrompt) };
	});
}
