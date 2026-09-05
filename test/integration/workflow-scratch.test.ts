import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createEventBus, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { installAsyncExecutionHooks, mockPi, tempDir, createSubagentExecutor, waitForMockPiCall } from "../support/async-execution-fixture.ts";
import { childSessionFactory, setChildSessionFactory, setChildSessionFactoryModule } from "../../src/runs/shared/child-session.ts";
import { getActiveWorkflowScratchScope, type WorkflowScratchScope } from "../../src/runs/shared/workflow-scratch.ts";

async function waitForFile(file: string, timeout = 20_000) {
 const end = Date.now() + timeout;
 while (!existsSync(file)) {
  assert.ok(Date.now() < end, `timed out waiting for ${file}`);
  await new Promise((resolve) => setTimeout(resolve, 20));
 }
}

describe("Workflow Scratch through actual async executor", () => {
 installAsyncExecutionHooks();
 for (const baseRef of [undefined, "fork-base"]) {
  it(`executes a JJ workflow with ${baseRef ?? "default HEAD"}`, async () => {
   const source = join(tempDir, "source"); mkdirSync(source);
   const jj = (...args: string[]) => execFileSync("jj", args, { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
   jj("git", "init", "--colocate");
   writeFileSync(join(source, "base.txt"), "base"); jj("describe", "-m", "base");
   jj("bookmark", "create", "fork-base", "-r", "@"); jj("new");
   writeFileSync(join(source, "tip.txt"), "tip"); jj("util", "snapshot");
   mockPi.onCall({ output: "inspected" });
   const previous = childSessionFactory(); let observed = false;
   setChildSessionFactory({
    async create(launch) {
     assert.notEqual(launch.cwd, source);
     assert.ok(existsSync(join(launch.cwd, "base.txt")));
     assert.equal(existsSync(join(launch.cwd, "tip.txt")), baseRef === undefined);
     observed = true; return previous.create(launch);
    }, dispose: () => previous.dispose(),
   });
   const executor = createSubagentExecutor!({
    pi: { events: createEventBus(), getSessionName: () => undefined },
    state: { baseCwd: source, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
    config: { worktreeBaseDir: join(tempDir, "lanes") }, asyncByDefault: false,
    tempArtifactsDir: tempDir, getSubagentSessionRoot: () => tempDir, expandTilde: (p: string) => p,
    discoverAgents: () => ({ agents: [makeAgent("worker", { completionGuard: false })] }),
   });
   try {
    const params = { agent: "worker", task: "Read-only inspect the fixture", worktree: true, async: false, acceptance: false, output: false, ...(baseRef ? { baseRef } : {}) };
    const result = await executor.execute(`jj-public-${baseRef ?? "head"}`, {
     workflowScript: `return runs.run("inspect", ${JSON.stringify(params)});`, async: false, mission: false,
    }, new AbortController().signal, undefined, makeMinimalCtx(source));
    assert.ok(observed, JSON.stringify(result)); assert.ok(!result.isError, JSON.stringify(result));
    assert.ok(existsSync(join(source, "tip.txt")));
   } finally { setChildSessionFactory(previous); }
  });
 }
 it("keeps scratch after implicit-async abort until the detached runner can stop", async () => {
  assert.ok(createSubagentExecutor);
  mockPi.onCall({ waitForPath: join(mockPi.dir, "release-prompt") });
  setChildSessionFactoryModule(fileURLToPath(new URL("../support/scratch-delayed-runner-factory.ts", import.meta.url)));
  const state = { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null };
  let scope: WorkflowScratchScope | undefined;
  const executor = createSubagentExecutor({
   pi: { events: createEventBus(), getSessionName: () => undefined }, state,
   config: {}, asyncByDefault: true, tempArtifactsDir: tempDir,
   getSubagentSessionRoot: () => tempDir, expandTilde: (p: string) => p,
   discoverAgents: () => {
    scope = getActiveWorkflowScratchScope() ?? scope;
    return { agents: [makeAgent("worker", { completionGuard: false })] };
   },
  });
  const controller = new AbortController();
  const pending = executor.execute("scratch-abort", {
   workflowScript: 'return runs.run("child", {agent:"worker",task:"Wait for cancellation",acceptance:false,output:false});',
   async: false, mission: false, timeoutMs: 30_000,
  }, controller.signal, undefined, makeMinimalCtx(tempDir));
  let scratch: string | undefined;
  try {
   await waitForMockPiCall(mockPi, 0);
   const record = JSON.parse(readFileSync(join(mockPi.dir, "scratch-launch.json"), "utf8"));
   scratch = record.root;
   assert.equal(typeof scratch, "string"); assert.ok(existsSync(scratch!));
   controller.abort(new Error("workflow cancelled by test"));
   await pending;
   // Prove the runner received stop but is still unable to finish its abort.
   await waitForFile(join(mockPi.dir, "abort-requested"));
   const settleDeadline = Date.now() + 5_000;
   while (!scope?.closed || scope.activeLaunches !== 0) {
    assert.ok(Date.now() < settleDeadline, "workflow launch callback must settle while runner abort is held");
    await new Promise((resolve) => setTimeout(resolve, 10));
   }
   process.kill(record.pid, 0);
   assert.ok(existsSync(scratch!), "stop request is not terminal proof; retain scratch");
  } finally {
   controller.abort();
   writeFileSync(join(mockPi.dir, "release-abort"), "release");
   await pending.catch(() => {});
   for (const job of state.asyncJobs.values()) {
    await waitForFile(join(job.asyncDir, "process-terminal.json"));
   }
   if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
 });
});
