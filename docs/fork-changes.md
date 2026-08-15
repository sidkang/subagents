# Fork 合同：JJ workspace 与 Workflow Scratch

> **仓库：** `sidkang/subagents`
>
> **Fork version:** `0.50.0+sid.1`
>
> **Upstream version:** `0.50.0`
>
> **Upstream base:** `81fb6894acd1d2b70570e2184731fe028385dc4c`
>
> **验证：** [`fork-validation.md`](./fork-validation.md)

本 fork 在上游 `pi-subagents` 之上维护一组 source-owned 能力。上游 rebase 以当前源码职责边界重测和重接，不要回 cherry-pick 已淘汰的 overlay / `node_modules` patch。

## 1. 范围

两个独立模块，外加两条窄兼容缝：

| 模块 | 解决的问题 | 不解决的问题 |
|---|---|---|
| **M1：per-Child JJ worktree backend** | 在 JJ 仓库中让每个 `worktree:true` Child 有独立代码 workspace | workflow 级共享 workspace、自动合并、自动 integrate |
| **M2：Workflow Scratch** | 同一 native `workflowScript` 的 leaf Child 共享一个 Host 临时目录（经 Sandbox 挂到 Guest） | VCS 传输、长期 artifact、访问控制或文件锁 |
| **delegation `sessionFile`** | 把实际 Child session 路径投影到公开 terminal response | 不改变 M1/M2 生命周期 |
| **stale async terminal guard** | 磁盘 proof 已落后，只忽略 Pi 的 stale-extension-context 通知错误 | 不是 M1/M2，也不转发旧 session 事件 |

上游仍拥有：`subagent` 工具、`workflowScript` VM、`runs.run` / `runs.all`、Child 参数与并发、foreground/background lifecycle、原有 Git worktree 时机、输出 / artifact / mission。

本 fork **不得**借此引入新的 workflowScript 参数、强制 `context: "fresh"`、writer/read-only 准入门、共享 workflow cwd、全局 retained/capture projection，或伪造其他产品的 runner registry。

## 2. M1：每个 Child 一个 JJ workspace

### 2.1 可观察合同

| 条件 | 结果 |
|---|---|
| `worktree: false` | 零 JJ 介入；不改变 cwd 或 Child 参数 |
| `worktree: true`，effective cwd 不是 JJ repo | 保持当前 Git worktree 实现 |
| `worktree: true`，effective cwd 是 JJ repo | 每个 stock worktree/task slot 创建一个独立 JJ workspace |

JJ 是 backend 内部选择。模型和 workflow 作者继续用原有 `worktree` 参数。

### 2.2 Child 拓扑

同一批 Child 必须从一次 Source snapshot 派生：

```text
Source snapshot → S0

每个 Child：
  jj duplicate -r S0 → D0（内容基线、独立 change）
  jj workspace add -r D0
  jj edit <owned D>  → Child 的 @ 是其拥有的 working-copy change

capture：jj diff --from D0 --to @
```

### 2.3 Capture 与 cleanup

1. **snapshot-first：** 确认 workspace name、canonical path 和 Child change 后，capture/cleanup 先 `jj util snapshot`；第一次 snapshot 成功前不得 `jj workspace update-stale`。
2. **synthetic 排除：** 第一次 snapshot 成功后删除 hook/`node_modules` 等 `syntheticPaths`，再 `jj util snapshot` 一次，让删除进入权威 WC commit，然后才允许 `--ignore-working-copy` 的 diff/work 检查。
3. **精确身份：** cleanup 校验 workspace name、canonical path、Child change id 和 D0（`workspaceCommitId`）；不能只按 name 删除。destructive descendant 查询和 abandon 必须使用最终 snapshot 后读到的当前 workspace 完整 commit id，不得使用可能对应多个 divergent revision 的 change id。`workspaceCommitId` 只表示 D0，不改成当前 commit。
4. **拓扑检查：** destructive cleanup 前确认 `@` 仍是记录的 Child change、parents 对应 `D0`、当前 owned commit 没有 live foreign descendants。
5. **保守失败：** path 缺失、name 被重绑、snapshot/forget 失败、change 不匹配、精确 owned commit 无法证明，或出现未知 descendant 时，保留 workspace 与磁盘数据。
6. **正确顺序：** 仅在验证后 `jj workspace forget`、abandon 该精确 owned commit、删除已确认 forget 的路径。

这些检查只保护一个 `worktree:true` Child，不是 workflow recovery ledger。cleanup 在已追踪 Child launch settle 之后运行。验证与 destructive forget / abandon / rm 之间若有外部并发文件系统或 JJ 状态变化，结果是 fail-closed 或 best-effort，不是原子安全保证。

### 2.4 Rebase 检查表

| 责任 | 文件 |
|---|---|
| Git/JJ backend 分派 | `src/runs/shared/worktree.ts` |
| JJ create / diff / cleanup | `src/runs/shared/jj-worktree-backend.ts` |
| handoff 按 backend 重建 discard | `src/runs/shared/parallel-handoff.ts` |
| 聚焦测试 | `test/unit/jj-worktree-backend.test.ts` |

保留 `setupHook`、`agents`、timeout、`syntheticPaths` 和 tracked-path 验证。绝不能把 JJ workspace 当 Git branch/worktree 删除。extensions-dir（含 symlink alias）必须像上游 Git backend 一样拒绝。

## 3. M2：Workflow Scratch

### 3.1 Host/Guest

```text
Host：唯一的 subagents-wf-scratch-* 临时目录（Workflow Scratch Scope）
Guest：固定 /workflow-shared（rw）

/workspace        当前 Child 自己的 cwd（通常是其 Git/JJ worktree）
/workflow-shared  当前 workflow 的合作临时目录
```

同一 workflow 的 leaf Child 共享一个 Host root；不同 workflow 得到不同 root。`/workflow-shared` 不替代 `/workspace`，也不自动 merge patch。

### 3.2 Authority

1. **Scope** — Host root 创建、ALS、tracked launch、精确 root 清理。
2. **Launch Binding** — `{ hostRoot }` 是受信任关联；env 与 detached launchConfig 只是 transport。
3. **Mount Adapter** — 仅在 proven binding 时注入 package-private 扩展，做一次 Session Mount Override。

Host root 不进模型 prompt 或 workflowScript 参数。Child 只投影：

```text
SUBAGENTS_WORKFLOW_SCRATCH_ROOT=<proven host root>
```

Host 用 `AsyncLocalStorage`，不改全局 `process.env`。`buildPiArgs` 先中和该 env，再只从 active ALS 或已校验的 runner-local binding 覆盖。detached Child 的 closed binding 写入 launchConfig；runner 清 ambient env 后只安装通过校验的 `{ hostRoot }`。无效或缺失 binding fail closed。

Mount Adapter 只注册：

```text
{ mounts: [{ hostPath: binding.hostRoot, guestPath: "/workflow-shared", access: "rw" }] }
```

Guest path 不用 `/tmp/...`（Guest `/tmp` 可能是 tmpfs）。Host 临时根优先 canonical `/tmp`（macOS 常为 `/private/tmp`）；`/tmp` 不可用才回退 `os.tmpdir()`。

### 3.3 生命周期

- workflow body 结束后，等已追踪 launch settle，再删该精确 scratch root。
- `async: true` 在 execute 前禁用 eager cleanup。
- 无法确认、Parent crash 或 hard kill 时保留目录，交给 OS 临时目录治理。
- 验证与 rm 之间的外部并发文件系统变化同样是 fail-closed / best-effort，不是原子安全保证。
- 不发明 durable ledger、token file、GC 或兼容 shim。
- scratch 不进 JJ patch，不承担 handoff / retained / recovery。

### 3.4 Rebase 检查表

| 责任 | 文件 |
|---|---|
| Scope 与 `runWorkflowScript` 包裹 | `src/runs/foreground/subagent-executor.ts` |
| argv / env / Mount Adapter 注入 | `src/runs/shared/pi-args.ts` |
| 真正 Child launch 调 `buildPiArgs` | `src/runs/foreground/execution.ts` |
| detached binding 写入与 env scrub | `src/runs/background/async-execution.ts` |
| runner-local binding install | `src/runs/background/subagent-runner.ts` |
| Host Scope / Launch Binding | `src/runs/shared/workflow-scratch.ts` |
| Child Mount Adapter | `src/runs/shared/workflow-scratch-mount-adapter.ts` |
| 聚焦测试 | `test/unit/workflow-scratch.test.ts` |

M2 只包裹现有 `launch`。上游已删除 `patchMissionObjective`；不得恢复该调用。

## 4. 兼容缝

### 4.1 `sessionFile`

`src/api/delegation.ts` 的 `SubagentDelegationTerminalResponse` 有可选 `sessionFile?: string`，由 `src/slash/delegation-adapters.ts` 投影实际 Child session file。测试：`test/unit/delegation-api.test.ts`。

### 4.2 stale async terminal guard

`src/runs/background/async-execution.ts` 里两条 detached runner close path：

- 只吞 Pi 的 stale-extension-context error；其他 emit error 继续抛。
- 不把旧 session 事件转给 replacement context；磁盘 proof 是权威记录。
- 上游若提供语义等价防护，删除本 helper、调用点注释和 `test/unit/async-execution.test.ts` 对应用例，不要叠第二层。

## 5. 非目标

- workflow-level shared JJ workspace、lease 或 writer gate
- 自动 Git/JJ merge、`git apply`、cherry-pick 或 Source integration
- 全局 scratch、模型传入的任意 Host/Guest mount API
- hard-kill / OOM / Parent-crash 的精确恢复或 WAL
- 用 native `workflowScript` 冒充其他包的 runner registry
- 与另一个同样提供 native `subagent` surface 的 wrapper 同时加载

## 6. 维护规则

- 先把上游合进 fork，再用 M1/M2 测试指出真实差异；不要重新生成不透明 patch。
- M1 与 M2 分测试、分模块。JJ 不得依赖 Sandbox；Mount Adapter 不得改变 Git/JJ backend 选择。
- 删除 workspace、abandon 精确 commit 或移除 scratch 时：身份可证明才删，否则保留。不得按可能 divergent 的 change id 做 destructive descendant/abandon。
- 只有 fork source runtime 验证通过后，才更新其他仓库的依赖和安装方式。
- 未完成的计划（历史整形、E2E 缺口、外部安装层）写在 GitHub Issues，不写进本文。
