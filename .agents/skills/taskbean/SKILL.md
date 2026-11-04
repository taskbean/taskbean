---
name: taskbean
description: >-
  Records outcome-level evidence of coding work in Taskbean for standups, weekly reports, 1-on-1s, and AI-value evidence. Use when a coding request will deliver a meaningful outcome the developer would report (fix, implement, debug, investigate, refactor, CI/CD): record one outcome and close or block it with `bean add`, `bean done`, or `bean block` --json. Also use to correct a captured record, for Taskbean reporting and standup or AI-value summaries, and for observe-only Chronicle evidence review or diagnostics with `bean chronicle doctor --json`. Commands, retries, branches, and sub-steps are evidence on an outcome, not separate tasks. Do NOT use for pure explanation, read-only inspection, brainstorming, non-code prose, code review with no changes, installing taskbean itself, plan-mode steps, or commitments that belong in Planner or Microsoft To Do.
metadata:
  taskbean_version: "0.7.0"
---
# taskbean — outcomes and evidence for the developer's reports

Taskbean connects the outcomes of coding work to execution evidence, so the developer can explain what was delivered and what AI contributed in standups, weekly reports, 1-on-1s, and leadership updates. It is not a universal task system. The CLI is `bean` (also `taskbean`) — globally installed. Run it directly; do NOT look inside this skill directory. Always pass `--json`.

## Who owns what

| Source | Owns |
|--------|------|
| Planner and Microsoft To Do | Commitments, owners, due dates, assignments |
| Durable priorities | Strategic outcomes |
| Copilot sessions and plan mode | Execution evidence (ephemeral; not durable task storage) |
| Taskbean | Outcomes connected to that evidence, for reports and review |

Do not copy a Planner or To Do commitment into Taskbean, and do not set a competing owner or due date for it. Do not create Taskbean tasks for plan-mode steps.

## Outcomes, not steps

An outcome is one meaningful result the developer would name in a standup: "fix JWT refresh causing 401s after 15min", not "edit auth.js" or "rerun CI".

- One request that delivers one result is one outcome, even if it touches docs, code, and tests.
- Commands, retries, CI reruns, lint runs, branches, worktrees, and small sub-steps are evidence on the outcome, not separate tasks.
- A request with clearly unrelated results can hold more than one outcome. Do not split one result into a task per ask.
- Whether a standalone small fix with no surrounding outcome needs its own record is undecided; follow the developer's preference.

## Recording an outcome

Taskbean does not require a record before every request or every turn. Automatic capture through Copilot hooks (#115) is not shipped in this version, so do not assume hooks ran. When a request delivers a meaningful outcome and no record exists, record it once with a stable key:

```bash
bean add "fix JWT refresh causing 401s after 15min" --key "jwt-refresh-401" --json
# → {"id":"6e3f...","status":"pending", ...}
bean done 6e3f... --json        # when the outcome is delivered
bean block 6e3f... --json       # when it waits on the developer or an external system
bean start 6e3f... --json       # optional, for long-running outcomes
```

A repeated `bean add` with the same `--key` in the same project updates the record instead of duplicating it. Titles appear verbatim in reports, so make them specific and outcome-oriented:

- ✅ "add OpenTelemetry tracing to API gateway endpoints"
- ✅ "investigate CI docker build failure"
- ❌ "fix bug" / "update code" / "run tests" / "changes"

## Corrections

Use manual commands to correct records, for example a wrong title, project, or status:

```bash
bean edit <id> --title "..." --priority high --notes "..." --tags "auth,bug" --json
bean edit <id> --due-date 2026-05-01 --json      # or --due-date clear
bean done <id> --json
bean block <id> --json
bean remove <id> --json                           # or `bean rm`
```

## Evidence review (observe only)

Collect evidence from local Copilot session metadata without changing tasks:

```bash
bean chronicle doctor --json                      # read-only diagnostics; no raw prompts or responses are imported
bean chronicle reconcile --observe --json         # proposals and a checkpoint only; never creates, links, or completes tasks
bean chronicle suggestions --status pending --json
```

Pending Chronicle suggestions are review-only. Do **not** present them as completed work or accepted outcomes. Only the developer accepts them, and only when they ask:

```bash
bean chronicle approve <suggestion-id> --work-date 2026-04-20 --json
bean chronicle link <suggestion-id> <todo-id> --json
bean chronicle ignore <suggestion-id> --json
```

`bean chronicle reconcile` without `--observe` is review mode: it can auto-link exact session matches to existing tasks as evidence. Run it only when the developer explicitly asks to reconcile. Chronicle evidence is metadata and summaries only, dated by `occurred_at` work time. Taskbean does not store raw prompts, responses, tool output, command output, or credentials. If Chronicle data is unavailable or blocked by policy, continue with normal Taskbean records and report the limitation.

## Reports and standups

```bash
bean report --date week --json                    # outcomes, status, and per-agent usage
bean report --date week --include-chronicle --json
bean list --json
bean list --status blocked --json                 # pending | in_progress | done | blocked
bean list --count --json
bean list --all --by-project --json
```

Lead with delivered outcomes, then blockers, then evidence and AI usage. Do not count pending suggestions as done.

## Pitfalls

- **Do NOT log every turn, ask, command, or small fix.** Log outcomes.
- **Do NOT trigger this skill** for pure explanation, read-only inspection, brainstorming, non-code prose, code review with no changes, plan-mode steps, Planner or To Do commitments, or installing or configuring taskbean itself.
- **Do NOT accept suggestions** for the developer. Observe, then let them review.
- **If an outcome was missed**, record it when you notice. A late record with evidence is better than none.

## Project management and legacy commands (only when the developer asks)

```bash
bean projects --json                                       # list tracked projects
bean projects --all --json                                 # include hidden
bean projects --category work --json
bean projects hide [name] --json
bean projects show [name] --json
bean projects categorize [name] --category work --json
bean projects delete [name] --confirm --json               # remove project + skill files (keeps tasks)
bean untrack --json                                        # stop tracking current project
bean remind "deploy hotfix" "tomorrow 9am" --json          # legacy reminder; kept for compatibility
```