# Issue tracker: GitHub

Issues and specs for this fork live as GitHub issues on `sidkang/subagents`. Use the `gh` CLI.

This repo tracks upstream `nicobailon/pi-subagents` and maintains the fork patch. Issues are for that work. Do not treat pull requests as a request or triage surface.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests

**PRs as a request surface: no.**

Do not list, label, or close PRs as if they were issues. A bare `#42` may be an issue or a PR; resolve with `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
