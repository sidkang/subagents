import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import createRunnerChildSessionFactory from "./runner-child-session-factory.ts";
import { WORKFLOW_SCRATCH_ROOT_ENV } from "../../src/runs/shared/workflow-scratch.ts";
import type { ChildSessionFactory } from "../../src/runs/shared/child-session.ts";

/** Hold real detached runner abort until the integration test releases it. */
export default function delayedScratchRunner(): ChildSessionFactory {
 const factory = createRunnerChildSessionFactory();
 const dir = process.env.MOCK_PI_QUEUE_DIR!;
 return {
  async create(launch) {
   const child = await factory.create(launch);
   writeFileSync(join(dir, "scratch-launch.json"), JSON.stringify({ root: launch.processEnv?.[WORKFLOW_SCRATCH_ROOT_ENV], pid: process.pid }));
   return {
    ...child,
    async abort() {
     writeFileSync(join(dir, "abort-requested"), "requested");
     while (!existsSync(join(dir, "release-abort"))) await new Promise((resolve) => setTimeout(resolve, 10));
     await child.abort();
    },
   };
  },
  dispose: () => factory.dispose(),
 };
}
