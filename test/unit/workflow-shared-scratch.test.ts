import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import workflowSharedScratchChild from "../../src/runs/shared/workflow-shared-scratch-child.ts";
import {
	WORKFLOW_SHARED_SCRATCH_ENV,
	WORKFLOW_SHARED_SCRATCH_GUEST,
	clearRunnerWorkflowSharedScratchForTests,
	companionExtensionPath,
	disableWorkflowSharedScratchCleanup,
	getActiveWorkflowSharedScratchEnv,
	installRunnerWorkflowSharedScratchFromConfig,
	openWorkflowSharedScratch,
	resolveWorkflowSharedScratchTempRoot,
	shouldInjectWorkflowSharedScratchCompanion,
	trackWorkflowSharedScratchLaunch,
	validateWorkflowSharedScratchHostPath,
	withWorkflowSharedScratch,
} from "../../src/runs/shared/workflow-shared-scratch.ts";
import { buildPiArgs, cleanupTempDir } from "../../src/runs/shared/pi-args.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const inheritedScratch = process.env[WORKFLOW_SHARED_SCRATCH_ENV];
const hadInheritedScratch = Object.prototype.hasOwnProperty.call(
	process.env,
	WORKFLOW_SHARED_SCRATCH_ENV,
);

function restoreScratchEnv(): void {
	if (hadInheritedScratch) process.env[WORKFLOW_SHARED_SCRATCH_ENV] = inheritedScratch;
	else delete process.env[WORKFLOW_SHARED_SCRATCH_ENV];
}

afterEach(() => {
	clearRunnerWorkflowSharedScratchForTests();
	restoreScratchEnv();
});

function buildMinimalPiArgs() {
	return buildPiArgs({
		baseArgs: ["-p"],
		task: "scratch test",
		sessionEnabled: false,
		inheritProjectContext: false,
		inheritSkills: false,
	});
}

describe("workflow shared scratch", () => {
	it("prefers canonical /tmp and falls back only when /tmp is unusable", () => {
		if (existsSync("/tmp") && statSync("/tmp").isDirectory()) {
			assert.equal(typeof resolveWorkflowSharedScratchTempRoot(), "string");
		}
		assert.equal(
			resolveWorkflowSharedScratchTempRoot({
				existsSync: (value) => value === "/tmp",
				statSync: () => ({ isDirectory: () => true }),
				realpathSync: () => "/canonical/tmp",
				tmpdir: () => "/unused",
			}),
			"/canonical/tmp",
		);
		assert.equal(
			resolveWorkflowSharedScratchTempRoot({
				existsSync: () => false,
				tmpdir: () => "/fallback",
			}),
			"/fallback",
		);
	});

	it("scopes scratch per workflow and defers removal until tracked launches settle", async () => {
		const paths = await Promise.all([
			withWorkflowSharedScratch(async (first) => {
				const settle = trackWorkflowSharedScratchLaunch();
				assert.deepEqual(getActiveWorkflowSharedScratchEnv(), {
					[WORKFLOW_SHARED_SCRATCH_ENV]: first.hostPath,
				});
				assert.ok(existsSync(first.hostPath));
				settle();
				return first.hostPath;
			}),
			withWorkflowSharedScratch(async (second) => second.hostPath),
		]);
		assert.notEqual(paths[0], paths[1]);
		assert.ok(!existsSync(paths[0]));
		assert.ok(!existsSync(paths[1]));

		const handle = openWorkflowSharedScratch();
		const heldPath = handle.scope.hostPath;
		let settle: (() => void) | undefined;
		await handle.run(async () => {
			settle = trackWorkflowSharedScratchLaunch();
		});
		handle.dispose();
		assert.ok(existsSync(heldPath));
		settle?.();
		assert.ok(!existsSync(heldPath));
	});

	it("does not accept ambient scratch as mount authority and neutralizes it for Child spawn", () => {
		const poison = mkdtempSync(join(tmpdir(), "subagents-ambient-poison-"));
		try {
			process.env[WORKFLOW_SHARED_SCRATCH_ENV] = poison;
			assert.equal(getActiveWorkflowSharedScratchEnv(), undefined);
			assert.equal(shouldInjectWorkflowSharedScratchCompanion(), false);

			const built = buildMinimalPiArgs();
			try {
				assert.equal(built.env[WORKFLOW_SHARED_SCRATCH_ENV], "");
				assert.ok(!built.args.includes(companionExtensionPath()));
			} finally {
				cleanupTempDir(built.tempDir);
			}
		} finally {
			rmSync(poison, { recursive: true, force: true });
		}
	});

	it("injects only the active scope's Host path and Companion into Child launch arguments", async () => {
		await withWorkflowSharedScratch(async (scope) => {
			const built = buildMinimalPiArgs();
			try {
				assert.equal(built.env[WORKFLOW_SHARED_SCRATCH_ENV], scope.hostPath);
				assert.ok(built.args.includes("--extension"));
				assert.ok(built.args.includes(companionExtensionPath()));
			} finally {
				cleanupTempDir(built.tempDir);
			}
		});
	});

	it("validates detached-runner scratch authority and leaves async scratch for OS cleanup", async () => {
		const valid = mkdtempSync(
			join(resolveWorkflowSharedScratchTempRoot(), "subagents-wf-shared-"),
		);
		try {
			assert.equal(validateWorkflowSharedScratchHostPath(valid), valid);
			assert.equal(installRunnerWorkflowSharedScratchFromConfig(valid), valid);
			assert.deepEqual(getActiveWorkflowSharedScratchEnv(), {
				[WORKFLOW_SHARED_SCRATCH_ENV]: valid,
			});
		} finally {
			clearRunnerWorkflowSharedScratchForTests();
			rmSync(valid, { recursive: true, force: true });
		}

		const handle = openWorkflowSharedScratch();
		const heldPath = handle.scope.hostPath;
		await handle.run(async () => disableWorkflowSharedScratchCleanup());
		handle.dispose();
		assert.ok(existsSync(heldPath));
		rmSync(heldPath, { recursive: true, force: true });
	});

	it("Companion supplies one rw /workflow-shared override and only appends its prompt hint", async () => {
		const hostPath = mkdtempSync(join(tmpdir(), "subagents-companion-"));
		const previous = process.env[WORKFLOW_SHARED_SCRATCH_ENV];
		try {
			process.env[WORKFLOW_SHARED_SCRATCH_ENV] = hostPath;
			const events = new Map<string, (payload: unknown) => void>();
			const handlers = new Map<string, (payload: unknown) => unknown>();
			const fakePi = {
				events: {
					on(channel: string, handler: (payload: unknown) => void) {
						events.set(channel, handler);
						return () => events.delete(channel);
					},
				},
				on(channel: string, handler: (payload: unknown) => unknown) {
					handlers.set(channel, handler);
					return () => handlers.delete(channel);
				},
			};
			workflowSharedScratchChild(fakePi as never);

			let provided: unknown;
			events.get("sandbox:session-mount-override:query")?.({
				provide(value: unknown) {
					provided = value;
				},
			});
			assert.deepEqual(provided, {
				mounts: [{ hostPath, guestPath: WORKFLOW_SHARED_SCRATCH_GUEST, access: "rw" }],
			});
			const prompt = await handlers.get("before_agent_start")?.({ systemPrompt: "Base prompt" }) as {
				systemPrompt?: string;
			};
			assert.match(prompt.systemPrompt ?? "", /Base prompt/);
			assert.match(prompt.systemPrompt ?? "", /\/workflow-shared/);
			assert.ok(!(prompt.systemPrompt ?? "").includes(hostPath));
		} finally {
			if (previous === undefined) delete process.env[WORKFLOW_SHARED_SCRATCH_ENV];
			else process.env[WORKFLOW_SHARED_SCRATCH_ENV] = previous;
			rmSync(hostPath, { recursive: true, force: true });
		}
	});

	it("wires scope, Child env, and detached transport through the fork source", () => {
		const executor = readFileSync(join(root, "src/runs/foreground/subagent-executor.ts"), "utf8");
		const piArgs = readFileSync(join(root, "src/runs/shared/pi-args.ts"), "utf8");
		const asyncExecution = readFileSync(join(root, "src/runs/background/async-execution.ts"), "utf8");
		const runner = readFileSync(join(root, "src/runs/background/subagent-runner.ts"), "utf8");

		assert.match(executor, /openWorkflowSharedScratch/);
		assert.match(executor, /withWorkflowSharedScratch/);
		assert.match(executor, /trackWorkflowSharedScratchLaunch/);
		assert.match(executor, /disableWorkflowSharedScratchCleanup/);
		assert.match(piArgs, /companionExtensionPath/);
		assert.match(piArgs, /WORKFLOW_SHARED_SCRATCH_ENV\] = ""/);
		assert.match(asyncExecution, /workflowSharedScratchHostPath/);
		assert.match(asyncExecution, /delete runnerEnv\[WORKFLOW_SHARED_SCRATCH_ENV\]/);
		assert.match(runner, /installRunnerWorkflowSharedScratchFromConfig/);
	});
});
