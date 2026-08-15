# Fork 验证合同与历史证据处置

本文保留 `sidkang/subagents` fork 需要长期维护的验证结论。它从早期 Pi-Stuff 的
Subagents + JJ + Sandbox 研究中提炼，但不复制已经失效的 delivery wrapper 路径、临时证据目录、
源码 hash 或专用 profile 安装记录。

产品与维护边界以 [`fork-changes.md`](./fork-changes.md) 为准；本文回答两个问题：

1. M1/M2 每次 port、rebase 或行为修改后必须证明什么；
2. 哪些旧设计和旧证据已经被取代，不得重新作为当前架构依据。

## 1. 当前需要保留的结论

### M1：per-Child JJ worktree backend

当调用方使用 `worktree: true` 时：

- JJ repo 中每个 Child 获得独立 JJ workspace 和独立 owned change；
- 同一批 Child 从稳定 Source snapshot 派生，不共享可变 Source working-copy parent；
- capture 只包含该 Child 的业务 patch；
- cleanup 在 snapshot、workspace path/name、owned change、parent topology 和当前
  owned commit 的 foreign descendants 都可证明时才执行；destructive abandon 只针对
  该精确 commit，不按 change id 删除可能 divergent 的外部 revision；
- 身份漂移、forget 失败或未知 descendant 必须 fail closed，保留 workspace 与磁盘数据；
- 验证与 destructive 调用之间的外部并发 FS/JJ 变化是 fail-closed / best-effort，不是原子安全保证；
- `worktree: false` 不执行 JJ；非 JJ repo 保持原有 Git worktree backend。

### M2：Workflow Scratch

每个顶层 native `workflowScript` 拥有一个与 VCS 无关的 Host scratch root：

- 同一 workflow 的 leaf Child 共享同一 scratch root；不同 workflow 彼此隔离；
- Sandbox Guest 固定通过 `/workflow-shared` 访问它，同时保留自己的 `/workspace`；
- Host path authority 来自 active workflow scope 或已验证的 detached launch binding，不能来自
  ambient `process.env`；
- workflow body 结束后必须等待 tracked launches settle，再清理该精确 root；
- async/detached Child 仍可能使用 scratch 时不得 eager cleanup；
- scratch 不自动合并 patch，不进入 JJ capture，也不承担 durable artifact、WAL 或 recovery ledger。

### Fork-only compatibility seams

还需保留：

- structural delegation terminal response 对实际 Child `sessionFile` 的可选投影；
- async terminal proof 已持久化后，只忽略 Pi 明确的 stale-extension-context 通知错误；其他
  subscriber/emit 错误仍须抛出。

## 2. 可重复验证顺序

从干净 checkout 安装依赖：

```bash
npm ci
```

先运行静态和聚焦测试：

```bash
npm run typecheck
node --experimental-strip-types --test test/unit/jj-worktree-backend.test.ts
node --experimental-strip-types --test test/unit/workflow-scratch.test.ts
node --experimental-strip-types --test test/unit/async-execution.test.ts
node --experimental-strip-types --test test/unit/delegation-api.test.ts
```

再运行完整 package suites：

```bash
npm run test:unit
npm run test:integration
npm run test:e2e
```

等价的总入口是：

```bash
npm run test:all
```

JJ 聚焦测试要求 `jj` 在 `PATH` 中。真实 Sandbox + JJ 场景还要求对应的 Sandbox/Pi
运行环境；缺少该环境时，不能把 unit-only 结果表述为完整 Host/Guest E2E。

## 3. 测试责任地图

| 合同 | 主要入口 |
| --- | --- |
| JJ backend 选择、D topology、capture、身份验证与保守 cleanup | `test/unit/jj-worktree-backend.test.ts` |
| Workflow Scratch scope、binding、Mount Adapter 与 cleanup | `test/unit/workflow-scratch.test.ts` |
| stale async terminal context 只吞明确错误 | `test/unit/async-execution.test.ts` |
| delegation `sessionFile` 投影 | `test/unit/delegation-api.test.ts` |
| foreground/background 生命周期、状态与真实执行接线 | `test/integration/single-execution.test.ts`, `test/integration/async-execution.test.ts` |
| 实际 Pi child session 行为 | `test/e2e/real-session-subagent.test.ts` |

新增 fork-only 行为时，应扩展拥有该合同的最窄测试文件；不要把所有验证塞进一个不可定位的
全栈脚本。

## 4. 关键组合场景

对涉及 M1/M2 接线的修改，完整环境下至少覆盖 A/B → C：

1. A、B 并行运行，均为 `worktree: true`；
2. A、B 在不同 JJ workspace 中写各自业务文件；
3. A、B 向同一 `/workflow-shared` 写入协作结果；
4. C 在新的独立 workspace 中启动，初始不自动拥有 A/B 的源码修改；
5. C 显式读取 scratch 或结构化结果并决定如何组合；
6. A/B/C capture 互不污染，Source workspace 不被自动 integrate；
7. 三个 Child 结束后，owned JJ workspace 与 scratch root 均按合同清理；
8. poisoned ambient scratch env 不得成为 mount authority。

这验证的是“隔离代码 workspace + 显式结果 fan-in”，不是自动 merge/apply。

## 5. 已被取代的方案

以下设计已经明确否决，不得在后续 rebase 时因旧研究或旧 patch 再次引入：

- workflow-level shared JJ workspace、全局 lease 或 writer gate；
- 强制所有 leaf Child 共享 cwd，或强制覆盖 `context`、`worktree`、`artifacts` 等调用参数；
- 自动把 A/B patch merge/apply/cherry-pick 到 C 或 Source；
- 长期 frozen base、全局 retained/capture projection 或 workflow recovery ledger；
- 由模型提供任意 Host path/Guest path 的 mount API；
- 把 Workflow Scratch 当作 durable artifact store、文件锁或安全隔离边界。

这些方案改变了原有 workflowScript、Child 并发或 handoff 产品语义，净复杂度大于已经证明的需求。

## 6. 不迁入 fork 的旧文档

以下 Pi-Stuff 文档继续只作为其原仓的历史研究，不属于 fork 的运行时权威文档：

- 旧 autonomous/tintinweb Subagents 与 Quintin 的写入原型；
- 针对旧 runtime 的外部 Sandbox wrapper 可行性评估；
- 通用 Pi Workflow package 横向比较；
- Pi-Stuff delivery bundle 的安装身份、provenance 和 immutable pin ADR；
- 绑定旧 `pi-subagents@0.44.0` patch/overlay hash、专用 profile 和临时目录的执行报告。

这些材料可以解释决策来源，但不能替代当前 fork source、当前测试和
[`fork-changes.md`](./fork-changes.md) 的合同。

## 7. 维护规则

- 上游同步后先让聚焦测试指出真实行为差异，再修改 fork seam；不要照搬旧 patch hunk。
- 文档中的版本、文件落点和命令必须随 fork source 一起更新。
- 任何 destructive cleanup 都遵循“身份可证明才删除，否则保留”。
- unit、integration 和 E2E 的结论必须按实际运行层级表述，不能用浅层测试替代真实运行证明。
- 安装说明必须指向这个 fork；不要让 fork README 的功能文档跳回 upstream `main`。
- 未完成的计划写在 GitHub Issues，不写进合同文档。
