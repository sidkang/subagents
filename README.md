<p>
  <img src="https://raw.githubusercontent.com/nicobailon/pi-subagents/main/banner.png" alt="pi-subagents" width="1100">
</p>

# pi-subagents

This fork snapshot is `pi-subagents@0.50.0+sid.2` on upstream `0.50.0` / `a14687b38761ba8e2d0fb41563401d0db12ec465`. See [Fork changes](./docs/fork-changes.md).

`pi-subagents` lets Pi delegate work to focused child agents. Use it for code review, scouting, implementation, parallel audits, saved workflows, background jobs, and anything else that benefits from a second or third set of model eyes.

<https://github.com/user-attachments/assets/702554ec-faaf-4635-80aa-fb5d6e292fd1>

## Install

This fork is not published as the npm package `pi-subagents`. `pi install npm:pi-subagents` installs upstream `pi-subagents`, not this fork.

Install the current fork `dev` branch directly as a Pi Git package:

```bash
pi install git:github.com/sidkang/subagents@dev
```

`dev` is a moving target. For a reproducible installation, pin a qualified full commit SHA instead:

```bash
pi install git:github.com/sidkang/subagents@<full-commit-sha>
```

Refresh the configured Git target with:

```bash
pi update --extension git:github.com/sidkang/subagents@dev
```

Do not load this package together with another extension that registers the same `subagent` surface.

## Try this first

You do not need to create agents, write config, or learn slash commands. After installing, ask Pi in plain language:

```text
Use reviewer to review this diff.
```

```text
Ask oracle for a second opinion on my current plan. Challenge assumptions and tell me what I might be missing.
```

```text
Use scout to understand this code based on our discussion, then ask me clarification questions.
```

```text
Run parallel reviewers: one for correctness, one for tests, and one for unnecessary complexity.
```

That is enough to start. Pi decides whether to call the `subagent` tool, which agent to use, and how to compose the work.

## How it works

Pi is the parent session. A subagent is a focused child Pi session with its own job.

When you ask for a subagent, Pi starts the child, gives it the task, and brings the result back. Foreground runs stream in the conversation. Background runs keep working and can be checked later.

Installing the extension does not start an automatic reviewer in the background. It gives Pi a delegation tool. If you want every implementation reviewed, say so in your prompt or project instructions:

```text
When you finish implementing, run a reviewer subagent before summarizing.
```

## Builtin agents

The extension ships with agents you can use immediately:

| Agent | Use it when you want... |
|-------|--------------------------|
| `scout` | Fast local codebase recon: relevant files, entry points, data flow, risks. |
| `researcher` | Web/docs research with sources and a concise research brief. |
| `worker` | Implementation work. Edits files, validates, escalates unapproved decisions instead of guessing. |
| `reviewer` | Code review and small fixes against the task/plan, tests, edge cases, and simplicity. |
| `oracle` | A second opinion before acting. Challenges assumptions without editing. |
| `delegate` | A lightweight general delegate that behaves close to the parent session. |

Rule of thumb: `scout` before you understand the code, `researcher` before you trust external facts, `worker` to implement, `reviewer` to check, and `oracle` when the decision itself feels risky.

## Common workflows

| Want | Ask naturally |
|------|---------------|
| Get a second opinion | "Ask oracle to review this plan and challenge assumptions." |
| Solve a hard problem | "Use oracle to investigate this bug before we edit." |
| Review a diff | "Use reviewer to review this diff." |
| Run parallel reviewers | "Run reviewers for correctness, tests, and cleanup." |
| Implement then review | "Implement this, then review it." |
| Review until clean | "Run a review loop on this change with a max of 3 rounds." |
| Execute a plan carefully | "Have worker implement this approved plan, then run reviewers and apply the feedback." |
| Scout before planning | "Use scout to inspect the auth flow before planning." |
| Run in the background | "Run this in the background." |
| Use a saved workflow | "Run the review chain on this branch." |
| Browse agents | "Show me the available subagents." |
| See running work | "Show active async runs." or "Show the subagent fleet." |
| Check setup | "Check whether subagents are configured correctly." |

For implementation work, the recommended loop is `clarify → scout → worker → fresh reviewers → worker`. Packaged prompt shortcuts like `/parallel-review` and `/review-loop` make these patterns repeatable — see [Workflows](./docs/workflows.md).

## Where running work shows up

Foreground runs stream progress in the conversation. Background runs keep working after control returns to you.

In the TUI, a persistent FleetView below the editor keeps active work visible. `/subagents-fleet` opens a live inspector where you can browse children, read transcripts, steer a running child, or stop a run. You can also just ask: "Show me the current async runs."

Details, keybindings, and the machine-readable run artifacts are in [Observability](./docs/observability.md).

For bounded orchestration, `maxSubagentSpawnsPerRun` limits cumulative logical children in one run tree. It defaults to 64 and stays separate from active concurrency and the session-wide cumulative spawn budget. See [Configuration](./docs/configuration.md#maxsubagentspawnsperrun).

## If something feels off

```text
/subagents-doctor
```

or ask: "Check whether subagents and intercom are set up correctly."

For installed-version help, use `/subagents-guide [topic]` or `subagent({ action: "guide", topic: "workflows" })`. The default topic is `overview`; available topics are `overview`, `workflows`, `agents`, `missions`, `observability`, `tool-reference`, `configuration`, `models`, `watchdog`, and `extension-api`.

## Documentation

The full reference lives in `docs/`:

| Doc | What's in it |
|-----|--------------|
| [Agents](./docs/agents.md) | Custom agents, frontmatter reference, overriding builtins, tools, extensions, skills, per-agent memory. |
| [Models](./docs/models.md) | Default models, per-role overrides, recommended tiering, fallbacks, thinking levels, model scope enforcement, profiles. |
| [Workflows](./docs/workflows.md) | Orchestration patterns, prompt shortcuts, scripted workflows, worktree isolation, child-to-parent coordination, the recursion guard. |
| [Watchdog](./docs/watchdog.md) | The opt-in adversarial change reviewer, scope monitoring, LSP checks, and child tool permissions. |
| [Tool reference](./docs/tool-reference.md) | Every `subagent` parameter, management actions, status/control actions, acceptance gates, external CLI runners. |
| [Observability](./docs/observability.md) | FleetView, the fleet inspector, lifecycle artifacts, events, logs, session sharing. |
| [Missions and schedules](./docs/missions.md) | Durable mission records, delivery receipts, timed and recurring runs. |
| [Configuration](./docs/configuration.md) | Every `config.json` key and environment variable. |
| [Extension API](./docs/extension-api.md) | The RPC, delegation API, preflight, capability ceilings, background-work providers, Herdr integration. |
| [Fork changes](./docs/fork-changes.md) | Current fork contract: JJ worktrees, Workflow Scratch, and rebase checkpoints. |
| [Fork validation](./docs/fork-validation.md) | Retained validation contract, focused test map, and superseded architecture evidence. |
