import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { createWorkflowScratchMountAdapter } from "../../src/runs/shared/workflow-scratch-mount-adapter.ts";
import {
 WORKFLOW_SCRATCH_ROOT_ENV,
 clearRunnerWorkflowScratchLaunchBindingForTests,
 getActiveWorkflowScratchLaunchBinding,
 installRunnerWorkflowScratchLaunchBinding,
 openWorkflowScratchScope,
 resolveWorkflowScratchTempRoot,
 runWorkflowScriptWithScratch,
 trackWorkflowScratchLaunch,
 validateWorkflowScratchLaunchBinding,
 withWorkflowScratchScope,
} from "../../src/runs/shared/workflow-scratch.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const inheritedScratch = process.env[WORKFLOW_SCRATCH_ROOT_ENV];
afterEach(() => {
 clearRunnerWorkflowScratchLaunchBindingForTests();
 if (inheritedScratch === undefined) delete process.env[WORKFLOW_SCRATCH_ROOT_ENV];
 else process.env[WORKFLOW_SCRATCH_ROOT_ENV] = inheritedScratch;
});

function build(overrides: Partial<Parameters<typeof buildInProcessChildLaunch>[0]> = {}) {
 return buildInProcessChildLaunch({
  cwd: root, sessionEnabled: false, inheritProjectContext: false,
  inheritGlobalContext: false, inheritSkills: false, extensions: [],
  host: "parent", childAgentName: "worker", childIndex: 0, ...overrides,
 });
}

function mountFrom(launch: ReturnType<typeof build>): unknown {
 const hook = launch.session.hooks.find((candidate) => candidate.name === "workflow-scratch-mount");
 if (!hook) return undefined;
 const handlers = new Map<string, (payload: unknown) => void>();
 hook.factory({ events: { on: (name: string, fn: (payload: unknown) => void) => handlers.set(name, fn) } } as never);
 let provided: unknown;
 handlers.get("sandbox:session-mount-override:query")?.({ provide: (value: unknown) => { provided = value; } });
 return provided;
}
const expectedMount = (hostRoot: string) => ({ mounts: [{ hostPath: hostRoot, guestPath: "/workflow-shared", access: "rw" }] });

describe("Workflow Scratch", () => {
 it("prefers canonical /tmp and falls back only when unusable", () => {
  assert.equal(resolveWorkflowScratchTempRoot({ existsSync: () => true, statSync: () => ({ isDirectory: () => true }), realpathSync: () => "/canonical/tmp", tmpdir: () => "/unused" }), "/canonical/tmp");
  assert.equal(resolveWorkflowScratchTempRoot({ existsSync: () => false, tmpdir: () => "/fallback" }), "/fallback");
 });

 it("isolates scopes and defers cleanup until tracked launches settle", async () => {
  const paths = await Promise.all([withWorkflowScratchScope(async (s) => s.hostRoot), withWorkflowScratchScope(async (s) => s.hostRoot)]);
  assert.notEqual(paths[0], paths[1]);
  for (const path of paths) assert.ok(!existsSync(path));
  const handle = openWorkflowScratchScope();
  let settle = () => {};
  await handle.run(async () => { settle = trackWorkflowScratchLaunch(); });
  handle.dispose();
  assert.ok(existsSync(handle.scope.hostRoot));
  settle(); settle();
  assert.ok(!existsSync(handle.scope.hostRoot));
 });

 it("rejects ambient env authority and clears it only in runner launch env", () => {
  process.env[WORKFLOW_SCRATCH_ROOT_ENV] = "/poison";
  assert.equal(getActiveWorkflowScratchLaunchBinding(), undefined);
  const foreground = build();
  assert.equal(mountFrom(foreground), undefined);
  assert.equal(foreground.session.processEnv, undefined);
  const background = build({ host: "runner" });
  assert.equal(background.session.processEnv?.[WORKFLOW_SCRATCH_ROOT_ENV], undefined);
  assert.equal(mountFrom(background), undefined);
  assert.equal(process.env[WORKFLOW_SCRATCH_ROOT_ENV], "/poison");
 });

 it("captures native per-session mount bindings without mutating parent env", async () => {
  process.env[WORKFLOW_SCRATCH_ROOT_ENV] = "/poison";
  const handles = [openWorkflowScratchScope(), openWorkflowScratchScope()];
  try {
   const launches = await Promise.all(handles.map((handle) => handle.run(async () => build())));
   // Evaluate after leaving ALS: each hook must keep its own binding.
   launches.forEach((launch, i) => {
    assert.deepEqual(mountFrom(launch), expectedMount(handles[i].scope.hostRoot));
    assert.equal(launch.session.processEnv, undefined);
    assert.equal(launch.session.hooks.filter((h) => h.name === "workflow-scratch-mount").length, 1);
    assert.ok(!launch.session.appendSystemPrompt?.includes(handles[i].scope.hostRoot));
   });
   const runner = await handles[0].run(async () => build({ host: "runner" }));
   assert.equal(runner.session.processEnv?.[WORKFLOW_SCRATCH_ROOT_ENV], handles[0].scope.hostRoot);
   assert.equal(process.env[WORKFLOW_SCRATCH_ROOT_ENV], "/poison");
  } finally { for (const handle of handles) handle.dispose(); }
 });

 it("validates detached bindings with a closed shape and existing temp root", async () => {
  await withWorkflowScratchScope(async (scope) => {
   const binding = { hostRoot: scope.hostRoot };
   assert.deepEqual(validateWorkflowScratchLaunchBinding(binding), binding);
   for (const invalid of [scope.hostRoot, { ...binding, extra: true }, { hostPath: scope.hostRoot }, { hostRoot: "/missing/subagents-wf-scratch-123" }]) {
    assert.equal(validateWorkflowScratchLaunchBinding(invalid), undefined);
   }
  });
  const handle = openWorkflowScratchScope();
  try {
   installRunnerWorkflowScratchLaunchBinding({ hostRoot: handle.scope.hostRoot });
   assert.deepEqual(mountFrom(build({ host: "runner" })), expectedMount(handle.scope.hostRoot));
   installRunnerWorkflowScratchLaunchBinding("invalid");
   assert.equal(mountFrom(build({ host: "runner" })), undefined);
  } finally { handle.dispose(); }
 });

 it("rejects roots with the wrong prefix or outside the temp root", (t) => {
  const wrong = mkdtempSync(join(resolveWorkflowScratchTempRoot(), "not-scratch-"));
  try { assert.equal(validateWorkflowScratchLaunchBinding({ hostRoot: wrong }), undefined); }
  finally { rmSync(wrong, { recursive: true, force: true }); }
  const base = ["/var/tmp", "/private/var/tmp", homedir()].find((candidate) => {
   try {
    const rel = relative(realpathSync(resolveWorkflowScratchTempRoot()), realpathSync(candidate));
    return statSync(candidate).isDirectory() && (rel === ".." || rel.startsWith(`..${sep}`));
   } catch { return false; }
  });
  if (!base) { t.skip("no writable base outside scratch temp root"); return; }
  const outside = mkdtempSync(join(base, "subagents-wf-scratch-"));
  try { assert.equal(validateWorkflowScratchLaunchBinding({ hostRoot: outside }), undefined); }
  finally { rmSync(outside, { recursive: true, force: true }); }
 });

 it("registers a mount provider only, with an immutable binding snapshot", () => {
  const binding = { hostRoot: "/trusted/root" };
  const factory = createWorkflowScratchMountAdapter(binding);
  binding.hostRoot = "/changed";
  let handler: ((payload: unknown) => void) | undefined;
  factory({ events: { on: (name: string, callback: typeof handler) => {
   assert.equal(name, "sandbox:session-mount-override:query"); handler = callback;
  } } } as never);
  let value: unknown;
  handler?.({ provide: (override: unknown) => { value = override; } });
  assert.deepEqual(value, expectedMount("/trusted/root"));
  assert.ok(Object.isFrozen(value));
  handler?.(null);
 });

 it("runs A/B then C with shared scratch and isolates concurrent workflows", async () => {
  const roots: string[] = [];
  const run = () => runWorkflowScriptWithScratch({
   script: 'await runs.all([{key:"a",agent:"worker",task:"a"},{key:"b",agent:"worker",task:"b"}]); return runs.run("c",{agent:"worker",task:"c"});',
   async launch(key) {
    const binding = getActiveWorkflowScratchLaunchBinding()!;
    assert.ok(binding);
    if (key === "a") roots.push(binding.hostRoot);
    assert.deepEqual(mountFrom(build()), expectedMount(binding.hostRoot));
    if (key === "c") {
     assert.equal(readFileSync(join(binding.hostRoot, "a"), "utf8"), "a");
     assert.equal(readFileSync(join(binding.hostRoot, "b"), "utf8"), "b");
    } else writeFileSync(join(binding.hostRoot, key), key);
    return { key, ok: true, output: key, artifactPaths: [] };
   },
   async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
  });
  await Promise.all([run(), run()]);
  assert.equal(roots.length, 2); assert.notEqual(roots[0], roots[1]);
  for (const path of roots) assert.ok(!existsSync(path));
 });

 it("preserves scratch when a child detaches", async () => {
  let path: string | undefined;
  try {
   await assert.rejects(runWorkflowScriptWithScratch({
    script: 'return runs.run("child", {agent:"worker",task:"pause"});',
    async launch(key) {
     path = getActiveWorkflowScratchLaunchBinding()!.hostRoot;
     return { key, ok: false, detached: true, output: "paused", artifactPaths: [] };
    },
    async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
   }));
   assert.ok(path && existsSync(path));
  } finally { if (path) rmSync(path, { recursive: true, force: true }); }
 });

 it("cleans a failed synchronous launch but preserves uncertain explicit async launches", async () => {
  for (const async of [false, true]) {
   let path: string | undefined;
   try {
    await assert.rejects(runWorkflowScriptWithScratch({
     script: `return runs.run("child", {agent:"worker",task:"fail",async:${async}});`,
     async launch() { path = getActiveWorkflowScratchLaunchBinding()!.hostRoot; throw new Error("launch failed"); },
     async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
    }));
    assert.ok(path); assert.equal(existsSync(path), async);
   } finally { if (path) rmSync(path, { recursive: true, force: true }); }
  }
 });

 it("keeps both executor paths and detached transport connected", () => {
  const executor = readFileSync(join(root, "src/runs/foreground/subagent-executor.ts"), "utf8");
  assert.match(executor, /runWorkflowScriptWithScratch as runWorkflowScript/);
  const async = readFileSync(join(root, "src/runs/background/async-execution.ts"), "utf8");
  assert.match(async, /workflowScratchBinding/);
  assert.match(async, /delete runnerEnv\[WORKFLOW_SCRATCH_ROOT_ENV\]/);
  assert.match(readFileSync(join(root, "src/runs/background/subagent-runner.ts"), "utf8"), /installRunnerWorkflowScratchLaunchBinding\(config.workflowScratchBinding\)/);
 });
});
