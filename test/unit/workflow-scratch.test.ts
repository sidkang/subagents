import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import workflowScratchMountAdapter from "../../src/runs/shared/workflow-scratch-mount-adapter.ts";
import {
	WORKFLOW_SCRATCH_ROOT_ENV,
	clearRunnerWorkflowScratchLaunchBindingForTests,
	disableWorkflowScratchCleanup,
	getActiveWorkflowScratchLaunchBinding,
	getActiveWorkflowScratchLaunchEnv,
	installRunnerWorkflowScratchLaunchBinding,
	openWorkflowScratchScope,
	resolveWorkflowScratchTempRoot,
	shouldInjectWorkflowScratchMountAdapter,
	trackWorkflowScratchLaunch,
	validateWorkflowScratchLaunchBinding,
	withWorkflowScratchScope,
	workflowScratchMountAdapterPath,
} from "../../src/runs/shared/workflow-scratch.ts";
import { buildPiArgs, cleanupTempDir } from "../../src/runs/shared/pi-args.ts";
import { runWorkflowScript } from "../../src/workflows/scripted-workflow.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const inheritedScratch = process.env[WORKFLOW_SCRATCH_ROOT_ENV];
const hadInheritedScratch = Object.prototype.hasOwnProperty.call(
	process.env,
	WORKFLOW_SCRATCH_ROOT_ENV,
);

function restoreScratchEnv(): void {
	if (hadInheritedScratch) process.env[WORKFLOW_SCRATCH_ROOT_ENV] = inheritedScratch;
	else delete process.env[WORKFLOW_SCRATCH_ROOT_ENV];
}

function isInsideResolvedRoot(candidate: string, root: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Writable base that is not the Host temp root and not inside it. */
function resolveOutsideScratchBase(tempRoot: string): string | undefined {
	let realTemp: string;
	try {
		realTemp = realpathSync(tempRoot);
	} catch {
		return undefined;
	}
	const candidates = ["/var/tmp", "/private/var/tmp", homedir()];
	for (const candidate of candidates) {
		try {
			if (!existsSync(candidate) || !statSync(candidate).isDirectory()) continue;
			const realBase = realpathSync(candidate);
			if (isInsideResolvedRoot(realBase, realTemp)) continue;
			return realBase;
		} catch {
			// Unreadable/unusable candidate.
		}
	}
	return undefined;
}

afterEach(() => {
	clearRunnerWorkflowScratchLaunchBindingForTests();
	restoreScratchEnv();
});

function buildMinimalPiArgs(overrides: Parameters<typeof buildPiArgs>[0] = {}) {
	return buildPiArgs({
		baseArgs: ["-p"],
		task: "scratch test",
		sessionEnabled: false,
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	});
}

describe("Workflow Scratch", () => {
	it("prefers canonical /tmp and falls back only when /tmp is unusable", () => {
		if (existsSync("/tmp") && statSync("/tmp").isDirectory()) {
			assert.equal(typeof resolveWorkflowScratchTempRoot(), "string");
		}
		assert.equal(
			resolveWorkflowScratchTempRoot({
				existsSync: (value) => value === "/tmp",
				statSync: () => ({ isDirectory: () => true }),
				realpathSync: () => "/canonical/tmp",
				tmpdir: () => "/unused",
			}),
			"/canonical/tmp",
		);
		assert.equal(
			resolveWorkflowScratchTempRoot({
				existsSync: () => false,
				tmpdir: () => "/fallback",
			}),
			"/fallback",
		);
	});

	it("scopes scratch per workflow and defers removal until tracked launches settle", async () => {
		const paths = await Promise.all([
			withWorkflowScratchScope(async (first) => {
				const settle = trackWorkflowScratchLaunch();
				assert.deepEqual(getActiveWorkflowScratchLaunchBinding(), {
					hostRoot: first.hostRoot,
				});
				assert.deepEqual(getActiveWorkflowScratchLaunchEnv(), {
					[WORKFLOW_SCRATCH_ROOT_ENV]: first.hostRoot,
				});
				assert.ok(existsSync(first.hostRoot));
				settle();
				return first.hostRoot;
			}),
			withWorkflowScratchScope(async (second) => second.hostRoot),
		]);
		assert.notEqual(paths[0], paths[1]);
		assert.ok(!existsSync(paths[0]));
		assert.ok(!existsSync(paths[1]));

		const handle = openWorkflowScratchScope();
		const heldPath = handle.scope.hostRoot;
		let settle: (() => void) | undefined;
		await handle.run(async () => {
			settle = trackWorkflowScratchLaunch();
		});
		handle.dispose();
		assert.ok(existsSync(heldPath));
		settle?.();
		assert.ok(!existsSync(heldPath));
	});

	it("does not accept ambient scratch as mount authority and neutralizes it for Child spawn", () => {
		const poison = mkdtempSync(join(tmpdir(), "subagents-ambient-poison-"));
		try {
			process.env[WORKFLOW_SCRATCH_ROOT_ENV] = poison;
			assert.equal(getActiveWorkflowScratchLaunchBinding(), undefined);
			assert.equal(getActiveWorkflowScratchLaunchEnv(), undefined);
			assert.equal(shouldInjectWorkflowScratchMountAdapter(), false);

			const built = buildMinimalPiArgs();
			try {
				assert.equal(built.env[WORKFLOW_SCRATCH_ROOT_ENV], "");
				assert.ok(!built.args.includes(workflowScratchMountAdapterPath()));
			} finally {
				cleanupTempDir(built.tempDir);
			}
		} finally {
			rmSync(poison, { recursive: true, force: true });
		}
	});

	it("injects only the active binding's Host root and Mount Adapter into Child launch arguments", async () => {
		await withWorkflowScratchScope(async (scope) => {
			const built = buildMinimalPiArgs();
			try {
				assert.equal(built.env[WORKFLOW_SCRATCH_ROOT_ENV], scope.hostRoot);
				assert.ok(built.args.includes("--extension"));
				assert.ok(built.args.includes(workflowScratchMountAdapterPath()));
				assert.equal(
					built.args.filter((arg) => arg === workflowScratchMountAdapterPath()).length,
					1,
				);
			} finally {
				cleanupTempDir(built.tempDir);
			}

			// Ambient extension disable must not drop the package-private adapter.
			const noAmbient = buildMinimalPiArgs({ extensions: [] });
			try {
				assert.ok(noAmbient.args.includes("--no-extensions"));
				assert.ok(noAmbient.args.includes(workflowScratchMountAdapterPath()));
				assert.equal(noAmbient.env[WORKFLOW_SCRATCH_ROOT_ENV], scope.hostRoot);
			} finally {
				cleanupTempDir(noAmbient.tempDir);
			}
		});
	});

	it("suppresses exact Mount Adapter path duplicates when already listed in extensions", async () => {
		await withWorkflowScratchScope(async () => {
			const adapterPath = workflowScratchMountAdapterPath();
			const built = buildMinimalPiArgs({ extensions: [adapterPath] });
			try {
				// Hits toolPlan.extensionArgs.includes(path): path is already present,
				// so the post --no-extensions injection must not re-add it.
				assert.ok(built.args.includes("--no-extensions"));
				assert.equal(
					built.args.filter((arg) => arg === adapterPath).length,
					1,
				);
			} finally {
				cleanupTempDir(built.tempDir);
			}
		});
	});

	it("validates detached Launch Binding strictly and leaves async scratch for OS cleanup", async () => {
		const valid = mkdtempSync(
			join(resolveWorkflowScratchTempRoot(), "subagents-wf-scratch-"),
		);
		try {
			const binding = { hostRoot: valid };
			assert.deepEqual(validateWorkflowScratchLaunchBinding(binding), {
				hostRoot: valid,
			});
			assert.equal(validateWorkflowScratchLaunchBinding(valid), undefined);
			assert.equal(
				validateWorkflowScratchLaunchBinding({ hostRoot: valid, extra: true }),
				undefined,
			);
			assert.equal(validateWorkflowScratchLaunchBinding({ hostPath: valid }), undefined);
			assert.deepEqual(installRunnerWorkflowScratchLaunchBinding(binding), {
				hostRoot: valid,
			});
			assert.deepEqual(getActiveWorkflowScratchLaunchBinding(), {
				hostRoot: valid,
			});
			assert.deepEqual(getActiveWorkflowScratchLaunchEnv(), {
				[WORKFLOW_SCRATCH_ROOT_ENV]: valid,
			});

			// Bare string and ambient-style values fail closed.
			clearRunnerWorkflowScratchLaunchBindingForTests();
			assert.equal(installRunnerWorkflowScratchLaunchBinding(valid), undefined);
			assert.equal(getActiveWorkflowScratchLaunchBinding(), undefined);
		} finally {
			clearRunnerWorkflowScratchLaunchBindingForTests();
			rmSync(valid, { recursive: true, force: true });
		}

		const handle = openWorkflowScratchScope();
		const heldPath = handle.scope.hostRoot;
		await handle.run(async () => disableWorkflowScratchCleanup());
		handle.dispose();
		assert.ok(existsSync(heldPath));
		rmSync(heldPath, { recursive: true, force: true });
	});

	it("rejects Launch Binding roots with the wrong basename prefix", () => {
		const tempRoot = resolveWorkflowScratchTempRoot();
		const wrongPrefix = mkdtempSync(join(tempRoot, "subagents-not-wf-scratch-"));
		try {
			assert.equal(
				validateWorkflowScratchLaunchBinding({ hostRoot: wrongPrefix }),
				undefined,
			);
		} finally {
			rmSync(wrongPrefix, { recursive: true, force: true });
		}
	});

	it("rejects Launch Binding roots outside the temp root", (t) => {
		const tempRoot = resolveWorkflowScratchTempRoot();
		const outsideBase = resolveOutsideScratchBase(tempRoot);
		if (!outsideBase) {
			t.skip("no writable directory outside the Workflow Scratch temp root");
			return;
		}
		const outsideCorrectPrefix = mkdtempSync(join(outsideBase, "subagents-wf-scratch-"));
		try {
			assert.equal(
				validateWorkflowScratchLaunchBinding({ hostRoot: outsideCorrectPrefix }),
				undefined,
			);
		} finally {
			rmSync(outsideCorrectPrefix, { recursive: true, force: true });
		}
	});

	it("Mount Adapter supplies one rw /workflow-shared override and registers no prompt hooks", async () => {
		const hostRoot = mkdtempSync(join(tmpdir(), "subagents-scratch-adapter-"));
		const previous = process.env[WORKFLOW_SCRATCH_ROOT_ENV];
		try {
			process.env[WORKFLOW_SCRATCH_ROOT_ENV] = hostRoot;
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
			workflowScratchMountAdapter(fakePi as never);

			let provided: unknown;
			events.get("sandbox:session-mount-override:query")?.({
				provide(value: unknown) {
					provided = value;
				},
			});
			assert.deepEqual(provided, {
				mounts: [
					{
						hostPath: hostRoot,
						guestPath: "/workflow-shared",
						access: "rw",
					},
				],
			});
			// Pure mount adapter: no model-facing prompt mutation.
			assert.equal(handlers.has("before_agent_start"), false);
			assert.equal(handlers.size, 0);
		} finally {
			if (previous === undefined) delete process.env[WORKFLOW_SCRATCH_ROOT_ENV];
			else process.env[WORKFLOW_SCRATCH_ROOT_ENV] = previous;
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("is a no-op when the private env is absent or neutralized", () => {
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

		delete process.env[WORKFLOW_SCRATCH_ROOT_ENV];
		workflowScratchMountAdapter(fakePi as never);
		assert.equal(events.size, 0);
		assert.equal(handlers.size, 0);

		process.env[WORKFLOW_SCRATCH_ROOT_ENV] = "";
		workflowScratchMountAdapter(fakePi as never);
		assert.equal(events.size, 0);
		assert.equal(handlers.size, 0);
	});

	it("Worker launch callback sees the active Workflow Scratch binding", async () => {
		await withWorkflowScratchScope(async (scope) => {
			let seenBinding: ReturnType<typeof getActiveWorkflowScratchLaunchBinding>;
			let seenEnv: ReturnType<typeof getActiveWorkflowScratchLaunchEnv>;
			let launchInvoked = false;
			const result = await runWorkflowScript({
				script: `return await runs.run("scratch-child", { agent: "worker", task: "touch scratch" });`,
				async launch(key) {
					launchInvoked = true;
					seenBinding = getActiveWorkflowScratchLaunchBinding();
					seenEnv = getActiveWorkflowScratchLaunchEnv();
					return { key, ok: true, output: "done", artifactPaths: [] };
				},
				async status(key) {
					return { key, ok: true, output: "ok", artifactPaths: [] };
				},
			});
			assert.equal(launchInvoked, true);
			assert.equal(result.children[0]?.ok, true);
			assert.deepEqual(seenBinding, { hostRoot: scope.hostRoot });
			assert.deepEqual(seenEnv, { [WORKFLOW_SCRATCH_ROOT_ENV]: scope.hostRoot });
		});

		const handle = openWorkflowScratchScope();
		try {
			let seenBinding: ReturnType<typeof getActiveWorkflowScratchLaunchBinding>;
			const result = await handle.run(async () => runWorkflowScript({
				script: `return await runs.run("open-scope-child", { agent: "worker", task: "touch scratch" });`,
				async launch(key) {
					seenBinding = getActiveWorkflowScratchLaunchBinding();
					return { key, ok: true, output: "done", artifactPaths: [] };
				},
				async status(key) {
					return { key, ok: true, output: "ok", artifactPaths: [] };
				},
			}));
			assert.equal(result.children[0]?.ok, true);
			assert.deepEqual(seenBinding, { hostRoot: handle.scope.hostRoot });
		} finally {
			handle.dispose();
		}
	});

	it("wires scope, Child env, and detached transport through the fork source", () => {
		const executor = readFileSync(join(root, "src/runs/foreground/subagent-executor.ts"), "utf8");
		const piArgs = readFileSync(join(root, "src/runs/shared/pi-args.ts"), "utf8");
		const asyncExecution = readFileSync(join(root, "src/runs/background/async-execution.ts"), "utf8");
		const runner = readFileSync(join(root, "src/runs/background/subagent-runner.ts"), "utf8");
		const adapter = readFileSync(join(root, "src/runs/shared/workflow-scratch-mount-adapter.ts"), "utf8");

		assert.match(executor, /openWorkflowScratchScope/);
		assert.match(executor, /withWorkflowScratchScope/);
		assert.match(executor, /trackWorkflowScratchLaunch/);
		assert.match(executor, /disableWorkflowScratchCleanup/);
		assert.match(piArgs, /workflowScratchMountAdapterPath/);
		assert.match(piArgs, /WORKFLOW_SCRATCH_ROOT_ENV\] = ""/);
		assert.match(asyncExecution, /workflowScratchBinding/);
		assert.match(asyncExecution, /delete runnerEnv\[WORKFLOW_SCRATCH_ROOT_ENV\]/);
		assert.match(runner, /installRunnerWorkflowScratchLaunchBinding/);
		assert.match(adapter, /sandbox:session-mount-override:query/);
		assert.doesNotMatch(adapter, /before_agent_start/);
	});
});
