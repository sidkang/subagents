import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorktrees, cleanupWorktrees, type WorktreeSetup } from "../../src/runs/shared/worktree.ts";

function jj(cwd: string, ...args: string[]): string {
 return execFileSync("jj", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function fixture() {
 const root = mkdtempSync(join(tmpdir(), "jj-options-"));
 const source = join(root, "source");
 jj(root, "git", "init", "--colocate", "source");
 writeFileSync(join(source, "base.txt"), "base");
 jj(source, "describe", "-m", "base");
 const base = jj(source, "log", "-r", "@", "--no-graph", "-T", "commit_id");
 jj(source, "new");
 writeFileSync(join(source, "tip.txt"), "tip");
 jj(source, "util", "snapshot");
 return { root, source, base, baseDir: join(root, "lanes") };
}
function discard(setup: WorktreeSetup | undefined) {
 if (setup) cleanupWorktrees(setup, { kind: "discard", authorization: { kind: "confirmed" } });
}

test("JJ baseRef selects one revision and journals the owned identity before returning", async () => {
 const f = fixture(); let setup: WorktreeSetup | undefined;
 try {
  let journal: WorktreeSetup | undefined;
  setup = await createWorktrees(f.source, "selected-base", 1, { baseDir: f.baseDir, baseRef: f.base, beforeCreate: (value) => { journal = value; } });
  assert.equal(setup.baseCommit, f.base);
  assert.equal(journal, setup);
  const lane = setup.worktrees[0]!;
  assert.ok(lane.workspaceChangeId); assert.ok(lane.workspaceCommitId);
  assert.ok(existsSync(join(lane.path, "base.txt")));
  assert.ok(!existsSync(join(lane.path, "tip.txt")));
  assert.ok(existsSync(join(f.source, "tip.txt")));
 } finally { discard(setup); rmSync(f.root, { recursive: true, force: true }); }
});

test("JJ rejects invalid baseRef without allocating a workspace", async () => {
 const f = fixture();
 try {
  const before = jj(f.source, "workspace", "list");
  await assert.rejects(() => createWorktrees(f.source, "invalid-base", 1, { baseDir: f.baseDir, baseRef: "missing-bookmark" }));
  assert.equal(jj(f.source, "workspace", "list"), before);
  assert.ok(!existsSync(f.baseDir));
 } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const mode of ["success", "callback-failure", "hook-failure"]) {
 test(`JJ journals identities before hooks (${mode})`, async () => {
  const f = fixture(); let setup: WorktreeSetup | undefined;
  const marker = join(f.root, "journal"); const invoked = join(f.root, "hook-ran");
  const hook = join(f.root, "hook.sh");
  writeFileSync(hook, `#!/bin/sh\ntest -f '${marker}' || exit 42\ntouch '${invoked}'\n${mode === "hook-failure" ? "exit 23" : "echo '{}'"}\n`);
  chmodSync(hook, 0o755);
  try {
   const create = async () => { setup = await createWorktrees(f.source, "journal-first", 2, {
    baseDir: f.baseDir, setupHook: { hookPath: hook },
    beforeCreate(value) {
     assert.equal(value.worktrees.length, 2);
     assert.ok(value.worktrees.every((lane) => lane.workspaceChangeId && lane.workspaceCommitId));
     assert.ok(!existsSync(invoked));
     if (mode === "callback-failure") throw new Error("journal unavailable");
     writeFileSync(marker, "owned identities recorded");
    },
   }); };
   if (mode === "success") await create(); else await assert.rejects(create);
   assert.equal(existsSync(invoked), mode !== "callback-failure");
   assert.equal(existsSync(marker), mode !== "callback-failure");
  } finally { discard(setup); rmSync(f.root, { recursive: true, force: true }); }
 });
}

test("upstream cleanup blockers preserve JJ workspace and exact identity", async () => {
 const f = fixture(); let setup: WorktreeSetup | undefined;
 try {
  setup = await createWorktrees(f.source, "cleanup-blocker", 1, { baseDir: f.baseDir });
  const lane = setup.worktrees[0]!;
  writeFileSync(join(lane.path, "business.txt"), "keep");
  const report = cleanupWorktrees(setup, { kind: "preserve", cleanupBlocker: "child still active" });
  assert.equal(report.state, "partial"); assert.equal(report.pruned, false);
  assert.equal(report.tasks[0]?.reason, "child still active");
  assert.equal(report.tasks[0]?.workspaceCommitId, lane.workspaceCommitId);
  assert.ok(existsSync(join(lane.path, "business.txt")));
  assert.ok(jj(f.source, "workspace", "list").includes(lane.branch));
 } finally { discard(setup); rmSync(f.root, { recursive: true, force: true }); }
});
