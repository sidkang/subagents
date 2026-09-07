/** Offline real-Pi smoke: native sessions + JJ A/B -> C + mount-query binding.
 * Set PI_SUBAGENTS_SMOKE_PI_MODULE to the installed Pi dist/index.js.
 * This tests the Sandbox query protocol, not a running Sandbox guest.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.PI_SUBAGENTS_SMOKE_PI_MODULE;
if (!modulePath) throw new Error("Set PI_SUBAGENTS_SMOKE_PI_MODULE to a real installed Pi module (dist/index.js).");
const temp = mkdtempSync(join(tmpdir(), "subagents-native-fork-"));
process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
process.env.PI_OFFLINE = "1";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const { createDefaultChildSessionFactory } = await import("../../src/runs/shared/child-session.ts");
const { buildInProcessChildLaunch } = await import("../../src/runs/shared/child-launch.ts");
const { runWorkflowScriptWithScratch, getActiveWorkflowScratchLaunchBinding, WORKFLOW_SCRATCH_ROOT_ENV } = await import("../../src/runs/shared/workflow-scratch.ts");
const { createWorktrees, diffWorktrees, cleanupWorktrees } = await import("../../src/runs/shared/worktree.ts");
const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: () => import(pathToFileURL(resolve(modulePath)).href) });
const source = join(temp, "source");
const jj = (...args: string[]) => execFileSync("jj", args, { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
mkdirSync(source);
jj("git", "init", "--colocate");
writeFileSync(join(source, "base.txt"), "source"); jj("describe", "-m", "base"); jj("new");
const sourceBefore = jj("log", "-r", "@", "--no-graph", "-T", "commit_id");
process.env[WORKFLOW_SCRATCH_ROOT_ENV] = "/poison-ambient";
const setups: Awaited<ReturnType<typeof createWorktrees>>[] = [];
const sessions: string[] = [];
let scratchRoot = "";
try {
 const result = await runWorkflowScriptWithScratch({
  script: 'await runs.all([{key:"a",agent:"worker",task:"a"},{key:"b",agent:"worker",task:"b"}]); return runs.run("c",{agent:"worker",task:"c"});',
  async launch(key) {
   const setup = await createWorktrees(source, `native-${key}`, 1, { baseDir: join(temp, "worktrees") });
   setups.push(setup);
   const lane = setup.worktrees[0]!;
   const binding = getActiveWorkflowScratchLaunchBinding()!;
   if (scratchRoot) assert.equal(binding.hostRoot, scratchRoot); else scratchRoot = binding.hostRoot;
   const launch = buildInProcessChildLaunch({
    cwd: lane.path, sessionEnabled: true, sessionDir: join(temp, "sessions", key),
    inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
    extensions: [], tools: ["read"], host: "parent", childAgentName: key, childIndex: 0,
   });
   let started = false; let shutdown = false; let inputHandled = false;
   launch.session.hooks.push({ name: "smoke-observer", factory(pi) {
    pi.on("session_start", (_event, ctx) => {
     assert.equal(ctx.cwd, lane.path);
     let override: unknown;
     pi.events.emit("sandbox:session-mount-override:query", { provide: (value: unknown) => { override = value; } });
     assert.deepEqual(override, { mounts: [{ hostPath: scratchRoot, guestPath: "/workflow-shared", access: "rw" }] });
     assert.equal(process.env[WORKFLOW_SCRATCH_ROOT_ENV], "/poison-ambient");
     started = true;
    });
    pi.on("input", () => { inputHandled = true; return { action: "handled" }; });
    pi.on("session_shutdown", () => { shutdown = true; });
   } });
   const errors: unknown[] = [];
   const child = await factory.create({ ...launch.session, onExtensionError: (error) => errors.push(error) });
   try {
    assert.ok(started); assert.equal(errors.length, 0);
    sessions.push(child.sessionId);
    await child.prompt("offline lifecycle probe"); assert.ok(inputHandled);
    if (key === "c") {
     assert.equal(readFileSync(join(scratchRoot, "a"), "utf8"), "a");
     assert.equal(readFileSync(join(scratchRoot, "b"), "utf8"), "b");
     assert.ok(!existsSync(join(lane.path, "a.txt")) && !existsSync(join(lane.path, "b.txt")));
    } else writeFileSync(join(scratchRoot, key), key);
    writeFileSync(join(lane.path, `${key}.txt`), key);
    const [diff] = diffWorktrees(setup, [key], join(temp, "patches", key));
    assert.equal(diff?.error, undefined);
    const patch = readFileSync(diff!.patchPath, "utf8");
    assert.ok(patch.includes(`${key}.txt`));
    for (const other of ["a", "b", "c"].filter((name) => name !== key)) assert.ok(!patch.includes(`${other}.txt`));
   } finally { await child.dispose(); }
   assert.ok(shutdown); assert.equal(errors.length, 0);
   const cleaned = cleanupWorktrees(setup, { kind: "discard", authorization: { kind: "confirmed" } });
   assert.equal(cleaned.state, "complete");
   return { key, ok: true, output: key, artifactPaths: [] };
  },
  async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
 });
 assert.equal(result.children.length, 3);
 assert.equal(new Set(sessions).size, 3);
 assert.ok(scratchRoot && !existsSync(scratchRoot));
 assert.equal(jj("log", "-r", "@", "--no-graph", "-T", "commit_id"), sourceBefore);
 assert.ok(!existsSync(join(source, "a.txt")));
 console.log("PASS: real Pi native sessions, A/B -> C, independent JJ patches, shared mount binding, shutdown, cleanup, unchanged source and parent env. No model calls or Sandbox guest used.");
} finally {
 await factory.dispose();
 for (const setup of setups) cleanupWorktrees(setup, { kind: "discard", authorization: { kind: "confirmed" } });
 rmSync(temp, { recursive: true, force: true });
}
