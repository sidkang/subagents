# Fork 改造说明：JJ workspace 与 Workflow Scratch

> **适用仓库：** `sidkang/subagents`
>
> **Fork version:** `0.49.0+sid.1`
>
> **Upstream version:** `0.49.0`
>
> **Upstream base:** `a660ea30621272e163187d34e45763c5b51bdc0f`
>
> **状态：** M1/M2 已迁入这个 fork 的 source tree；本文是其产品合同、维护边界和未来 rebase 指南。
>
> **验证合同：** 可重复验证矩阵、聚焦测试入口和被淘汰方案见
> [`fork-validation.md`](./fork-validation.md)。

本 fork 已把原先在外部 delivery bundle 中以 `patch-package` 与独立 overlay 实现的能力，
迁入可正常审阅、测试和提交的 source tree。后续开发和上游 rebase 不需要在
`node_modules` 中重新手工应用一组跨文件补丁。

本文记录的是已经验证过的产品合同，而不是要求原样复制旧补丁。旧实现以
`pi-subagents@0.44.0`、上游 commit
`96c3fec9b502c61295e244c3fce4d97ff22b13b3` 为基线；本 fork 现为 `0.49.0+sid.1`（上游 0.49.0），移植时
必须以当前源代码的职责边界重新实现和测试，不能盲目 cherry-pick 旧 patch。

## 1. 改造范围

改造由两个相互独立的模块组成：

| 模块 | 解决的问题 | 不解决的问题 |
|---|---|---|
| **M1：per-Child JJ worktree backend** | 在 JJ 仓库中让每个 `worktree:true` Child 有独立代码 workspace | workflow 级共享 workspace、自动合并、自动 integrate |
| **M2：Workflow Scratch** | 让同一 native `workflowScript` 的 leaf Child 共享一个 Host 临时协作目录（经 Sandbox 挂载到 Guest） | VCS 传输、长期 artifact、访问控制或文件锁 |

上游仍应拥有：

- `subagent` 工具、`workflowScript` VM、`runs.run` / `runs.all` 调度语义；
- Child 参数、并发、foreground/background lifecycle、Abort/cancel；
- 原有 Git worktree 路径、handoff/capture/cleanup 的外部时机；
- Child 输出、structured output、artifact 和 mission 行为。

本 fork **不得**借此引入新的 workflowScript 参数、强制 `context: "fresh"`、writer/read-only
准入门、共享 workflow cwd、全局 retained/capture projection，或伪造其他产品的 runner
registry 协议。

## 2. 为什么从 patch 迁到 fork

原 delivery bundle 为了控制上游漂移，使用了精确版本 pin、一个仅接线的 patch，以及
三个 first-class overlay。这个方式在小改动时合理，但现在的改造已跨越：

- worktree backend 选择、JJ 创建、capture 与保守 cleanup；
- Workflow Scratch Scope 生命周期；
- Child spawn env、Mount Adapter 注入；
- foreground 与 detached async runner 的 Launch Binding 传递；
- handoff 的 JJ cleanup identity；
- delegation terminal `sessionFile` 投影。

这些行为都应在正常 source tree 中演进、code review 和测试。迁入 fork 后，Pi-Stuff
应逐步变成该 fork 的薄交付/安装层，而不是继续维护同一份 patch 与 overlay 副本。

## 3. M1：每个 Child 一个 JJ workspace

### 3.1 可观察合同

| 条件 | 结果 |
|---|---|
| `worktree: false` | **零 JJ 介入**；不改变 cwd 或 Child 参数 |
| `worktree: true`，effective cwd 不是 JJ repo | 保持当前 Git worktree 实现 |
| `worktree: true`，effective cwd 是 JJ repo | 每个 stock worktree/task slot 创建一个独立 JJ workspace |

JJ 是 backend 内部选择；模型和 workflow 作者继续使用原有 `worktree` 参数，不需要传 JJ
路径、workspace 名或 base revision。

### 3.2 稳定的 Child 拓扑

同一批 Child 必须从一次 Source snapshot 派生，而不能从一个会持续变化的 Source working
copy 直接派生：

```text
Source snapshot → S0

每个 Child：
  jj duplicate -r S0 → D0（内容基线、独立 change）
  jj workspace add -r D0
  jj edit <owned D>  → Child 的 @ 是其拥有的 working-copy change

capture：jj diff --from D0 --to @
```

`S0` 是本批任务的 Source snapshot；`D0` 是该 Child 的内容基线；`D` 是该 Child 拥有的
working-copy change。这样 Source 后续 snapshot、兄弟 Child 的创建和 `.pi-subagents` 运行时
写入不会把其他 Child 的 working copy 变成 stale。

### 3.3 Capture 与 cleanup 的安全不变量

实现必须保留以下约束：

1. **snapshot-first：** 在确认 workspace name、canonical path 和 Child change 属于记录对象后，
   capture 和 cleanup 的工作副本检查先执行 `jj util snapshot`；在第一次 snapshot 成功前不得
   执行 `jj workspace update-stale`。否则外部 rewrite 后的未 snapshot 文件可能丢失。
2. **精确身份：** cleanup 记录并验证 workspace name、canonical path、Child change id 和
   base commit id；不能只按 name 删除。snapshot 后还必须重新验证完整拓扑，才可删除 synthetic
   path、forget workspace 或 abandon change。
3. **拓扑检查：** destructive cleanup 前确认当前 `@` 仍是记录的 Child change、其 parents
   与 `D0` 对应，且没有 live foreign descendants。
4. **保守失败：** path 缺失、name 被重绑、snapshot/forget 失败、change 不匹配或出现未知
   descendant 时，保留 workspace 与磁盘数据，不删除未知对象。
5. **正确顺序：** 仅在验证后执行 `jj workspace forget`、abandon owned change、删除记录的
   路径；路径删除必须以 inventory 中已确认 forget 为前提。

这些检查只保护一个 `worktree:true` Child；它们不是 workflow recovery ledger，也不改变
上游的并发或 handoff 产品语义。

### 3.4 0.49.0 的 source-owned 实现落点

当前 fork 的 Git backend 集中在 `src/runs/shared/worktree.ts`，并由
`src/runs/shared/parallel-handoff.ts` 重建 cleanup。M1 已按以下边界实现：

- 在 `worktree.ts` 内形成明确的 Git/JJ backend seam，而不是把 JJ 命令散落到 executor；
- 给 `WorktreeInfo` / cleanup task 增加可序列化、可区分 backend 的 identity；保留已有
  handoff manifest 的向后读取能力；
- 把 JJ create/diff/cleanup 放在独立模块，例如
  `src/runs/shared/jj-worktree-backend.ts`；
- 保留 `setupHook`、`agents`、timeout、`syntheticPaths` 和 tracked-path 验证的既有合同；
- 在 `parallel-handoff.ts` 中根据记录的 backend 重建 JJ discard，绝不把 JJ workspace
  当作 Git branch/worktree 删除。

## 4. M2：Workflow Scratch

### 4.1 Host/Guest 合同

**Workflow Scratch** 是每个顶层 native `workflowScript` 的一份 package 创建 Host 临时协作目录。
它与 Git/JJ/VCS 无关，也不替代 Child 的 `/workspace`：

```text
Host：唯一的 subagents-wf-scratch-* 临时目录（Workflow Scratch Scope）
Guest：固定 /workflow-shared（rw）
```

同一 workflow 的所有 leaf Child 绑定到同一个 Host root；不同 workflow 得到不同 root。
Sandbox Child 仍保留其原有的代码路径：

```text
/workspace        当前 Child 自己的 cwd（通常是其 Git/JJ worktree）
/workflow-shared  当前 workflow 的合作临时目录（Workflow Scratch）
```

`/workflow-shared` 不是 `/workspace` 的替代品，也不是自动 patch merge 机制。A/B 可把报告、
测试输出或待处理资料写入 scratch，C 必须显式读取、应用或重建结果。

### 4.2 authority、Launch Binding 与 Mount Adapter

`subagents` 拥有三层 fork 边界：

1. **Workflow Scratch Scope** — Host root 创建、ALS 作用域、tracked launch、精确 root 清理；
2. **Workflow Scratch Launch Binding** — `{ hostRoot }` 的受信任关联；env 与 detached
   launchConfig 只是 transport，不是 authority；
3. **Workflow Scratch Mount Adapter** — 仅在存在 proven binding 时动态注入 Child 的
   package-private 扩展，只做一次 Sandbox Session Mount Override 映射。

Host root 不进入模型 prompt 或 workflowScript 参数。Child spawn 仅投影私有 env：

```text
SUBAGENTS_WORKFLOW_SCRATCH_ROOT=<proven host root>
```

Host 侧用 `AsyncLocalStorage` 保存当前 scope，不能修改全局 `process.env`。`buildPiArgs`
必须先中和该私有 env，再只从 active ALS 或已校验的 runner-local binding 覆盖。对 detached
async Child，closed binding 写入 runner launchConfig JSON；runner 清除 ambient env 后，
仅安装通过严格校验的 `{ hostRoot }`（存在、绝对路径、package 前缀、位于选定 temp root 下）。
无效或缺失 binding fail closed：不注入 adapter、不挂载。

Child 侧的 **Mount Adapter** 只做一件事：

```text
{ mounts: [{ hostPath: binding.hostRoot, guestPath: "/workflow-shared", access: "rw" }] }
```

1. env 不存在、为空或被中和时是 no-op；
2. env 有效时在 extension factory 阶段注册 `sandbox:session-mount-override:query`；
3. 不注册 `before_agent_start`、不改 prompt、不碰 Agent/JJ/orchestration/cleanup。

Sandbox 的 override 是 construction-time、每 generation 的唯一 provider 合同：0 个 provider
使用 Owner mounts；1 个合法 provider 使用 override；多于 1 个或 payload 不合法必须 fail
closed。Mount Adapter 因此不能与另一个 Session Mount Override provider 并行注册。

Guest path 不使用 `/tmp/...`：Microsandbox 会在 Guest `/tmp` 使用 tmpfs，可能遮蔽嵌套 bind。
Host 临时根优先使用 canonical `/tmp`（macOS 常为 `/private/tmp`）；只有 `/tmp` 不可用时才回退
到 `os.tmpdir()`，因为 macOS `/var/folders/...` 不能稳定作为 Microsandbox bind source。

### 4.3 生命周期

- workflow body 结束后，等所有已追踪的 Child launch settle，再删除该精确 scratch root；
- `async: true` 必须在 execute 前禁用 eager cleanup；返回 async job / detached Child 是后备检查；
- 无法确认、Parent crash 或 hard kill 时保留目录给 OS 临时目录治理；
- 不发明 durable terminal ref ledger、token file、marker、protocol version、GC 或兼容 shim；
- scratch 不进入 JJ patch，不承担 handoff/retained/recovery 语义。

### 4.4 0.49.0 的 source-owned 实现落点

当前版本相较旧 0.44 已扩展了 workflow mission、async 和 Child execution 路径。M2 已在以下位置接线；未来 rebase 至少复查这些位置：

| 责任 | 当前候选文件 |
|---|---|
| Workflow Scratch Scope、foreground/async `runWorkflowScript` 包裹 | `src/runs/foreground/subagent-executor.ts` |
| Child argv、env、Mount Adapter 注入 | `src/runs/shared/pi-args.ts` |
| 真正 Child launch 对 `buildPiArgs` 的调用 | `src/runs/foreground/execution.ts` |
| detached launchConfig binding 写入与 runner env scrub | `src/runs/background/async-execution.ts` |
| detached runner 的 validated Launch Binding install | `src/runs/background/subagent-runner.ts` |
| Host Scope / Launch Binding | 新增 `src/runs/shared/workflow-scratch.ts` |
| Child Mount Adapter | 新增 `src/runs/shared/workflow-scratch-mount-adapter.ts` |

旧版 `subagent-executor.ts` 的少量 hunk 不能直接当作未来 rebase 的来源：0.49.0 的 workflow launch
还会记录 mission、heartbeat、async child、output-path claims、live-card progress 和 launch observers。
上游已删除 `patchMissionObjective`；M2 不得恢复该调用。M2 只包裹现有 `launch`，不会跳过或复制
这些职责。

## 5. delegation `sessionFile`

旧 0.44 delivery bundle 额外把实际 Child `sessionFile` 投影到公开的 structural delegation
terminal response，供 Host integration 验证 Child session cwd。

本 fork 已将 `sessionFile?: string` 加入 `src/api/delegation.ts` 的
`SubagentDelegationTerminalResponse`，并由 `src/slash/delegation-adapters.ts` 投影实际 Child
sessionFile。该字段保持为可选的结构化兼容字段；它不改变 M1/M2 的生命周期或调度语义。

## 5.1 Fork-only：async terminal 的 stale context 防护

上游 `pi-subagents@0.49.0` 的 detached runner close callback 会直接通过启动时捕获的
`ctx.pi.events.emit(SUBAGENT_PROCESS_TERMINAL_EVENT, proof)` 发送通知。如果 Pi 在 Child
结束前已 reload 或替换 session，该 context 会失效；此时一个仅用于 UI 通知的 emit 会在 durable
`process-terminal.json` 已落盘后抛出并使宿主崩溃。

fork 在 `src/runs/background/async-execution.ts` 以明确的 `Fork sync` 注释包裹这两个 callback：

- 只吞掉 Pi 的 stale-extension-context error；其他 emit error 必须继续抛出；
- 不把旧 session 的事件转发给 replacement context；磁盘 proof 才是权威记录；
- 上游同步时复查两条 async runner spawn path。上游若提供语义等价的 stale-only 防护，应删除本
  fork helper、调用点注释和对应 regression test，而不是叠加第二层 guard。

这不是 M1 或 M2 的生命周期改造；它只确保已持久化的 terminal proof 不会因为过期的 advisory
notification 而杀死 Pi。

## 6. 推荐的提交顺序

不要创建一个无法审阅的大型 fork diff。推荐分层提交：

1. **docs(fork):** 本文，明确目标、边界和移植基线；
2. **feat(delegation):** 如仍需要，独立完成 `sessionFile` 公共 projection；
3. **feat(worktree):** 定义 backend seam、保留 Git backend，并添加 JJ backend 的 create/diff/
   cleanup 与 focused unit tests；
4. **feat(scratch):** 添加 Workflow Scratch Scope、Mount Adapter、foreground workflow wiring；
5. **feat(scratch):** 添加 detached Launch Binding transport、env scrub 和 runner-local validation；
6. **test(e2e):** 以真实 Pi + Sandbox + JJ 验证 A/B 并行、C 顺序、mount、cleanup 和 canary
   isolation；
7. **build(pi-stuff):** 在 fork runtime 验证后，才把外部 delivery bundle 从 patch/overlay 切换为
   指向一个不可变 fork commit 或正式发布版本的薄安装层。

第 3 与第 4 步的实现可以并行设计，但不应合并为依赖隐藏的不可分割提交。

## 7. 验收要求

执行顺序和聚焦测试入口见 [`fork-validation.md`](./fork-validation.md)。每次 port 或 rebase 后，至少验证：

- 上游 unit/typecheck 全绿；
- `worktree:false` 不执行 JJ；
- 非 JJ repo 的 `worktree:true` 仍走 Git；
- JJ repo 中 A/B 并行、C 随后运行，三者是独立 workspace；
- A/B/C Sandbox 中都保留 `/workspace`，且共享同一个 `/workflow-shared`；
- 父进程的 poisoned scratch env 不会成为 Child mount authority；
- A/B/C 的业务 patch 各自独立，C 起步时不自动看到 A/B 源码；
- scratch 正常完成后删除；async/detached 情况不提前删除；
- JJ cleanup 只删除已证明属于该 Child 的 workspace，失败时保留；
- Source 工作区不自动应用 Child 业务改动。

## 8. 明确非目标

本 fork 不承诺：

- workflow-level shared JJ workspace、lease 或 writer gate；
- 自动 Git/JJ merge、`git apply`、cherry-pick 或 Source integration；
- 全局 scratch、模型传入的任意 Host path / Guest path mount API；
- hard-kill / OOM / Parent-crash 的精确恢复或 WAL；
- 用 Nico native `workflowScript` 冒充其他包的 runner registry；
- 与另一个同样提供 native `subagent` surface 的 wrapper 同时加载。

## 9. 维护规则

- 后续上游同步先 rebase/merge 到 fork，再让 M1/M2 测试指出真正的行为差异；不要重新生成一个
  不透明的 `node_modules` patch。
- M1 与 M2 分别拥有自己的测试和模块边界；JJ 代码不得依赖 Sandbox，Mount Adapter 也不得改变
  Git/JJ backend 选择。
- 任何会删除 workspace、abandon change 或移除 scratch 的新逻辑都要遵循“身份可证明才删除，
  否则保留”的原则。
- 只有在 fork 的 source runtime 完成验证后，才更新其他仓库的依赖、provenance 和安装方式。
