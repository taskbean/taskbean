---
name: taskbean
description: >-
  Captures concrete coding tasks in Taskbean so work appears in weekly reports, 1-on-1s, and performance reviews. Use when asked to fix, implement, debug, investigate, refactor, test, document, configure CI/CD, or change code: call `bean add "<outcome-oriented title>" --json` before work and `bean done <id> --json` when finished. Also use for Taskbean task management/reporting and for diagnosing local Copilot Chronicle/session data with `bean chronicle doctor --json`. Do NOT use for pure explanation, read-only inspection, brainstorming, non-code prose, code review with no changes, or installing taskbean itself.
metadata:
  taskbean_version: "0.6.0"
---
# taskbean — make your coding work visible to the developer

Every task you take on with the developer disappears unless it's captured. They use these logs to recall what you accomplished, communicate it in their weekly reports and 1-on-1s, and get credit for the work you did together. The CLI is `bean` (also `taskbean`) — globally installed. Run it directly; do NOT look inside this skill directory.

## How to use it

Before you start any coding work, capture the task:

```bash
bean add "fix JWT refresh causing 401s after 15min" --json
# → {"id":"6e3f...","status":"pending","completed":0, ...}
```

Capture the returned `id`. Do the work. When you finish:

```bash
bean done 6e3f... --json
# → {"status":"done","completed":1, ...}
```

Always pass `--json` so you can parse the returned id reliably.

### Why log first, not after

Logging at the start makes your interpretation visible to the developer immediately. If you misread the task, they catch it before you spend implementation time on the wrong thing. Logging after the fact is better than not at all, but pre-implementation capture catches misalignment when correction is cheap.

## Lifecycle (optional middle states)

```
bean add  →  pending  ──bean start──→  in_progress  ──bean done──→  done
                            └──────────bean block──────────→  blocked
```

`bean add` then `bean done` is the standard two-step flow. Use `bean start` on long-running tasks to mark "actively working" — it shows up in the developer's status. Use `bean block` if you're waiting on the developer or an external system; this gives them visibility into what's stalled.

## Multi-task requests — capture each separately

If the developer lists several things in one message, capture each as its own task. Each one shows up as a separate bullet in their report, which is how they'd describe the work in a standup.

```
Developer: "update the README with the new endpoints, add validation to /users POST,
            and write tests for the validation"

→ bean add "update README with new API endpoints" --json
→ bean add "add input validation to POST /users" --json
→ bean add "write tests for /users input validation" --json
```

Mark each `done` independently as you finish it. One `bean add` per logical unit, not per file edit.

## Other commands

```bash
bean edit <id> --title "..." --priority high --notes "..." --tags "auth,bug" --json
bean edit <id> --due-date 2026-05-01 --json
bean edit <id> --due-date clear --json
bean remove <id> --json                                    # or `bean rm`
bean remind "deploy hotfix" "tomorrow 9am" --json
bean list --json
bean list --status pending --json                          # pending | in_progress | done | blocked
bean list --count --json                                   # → {"done":12,"pending":3,"total":15}
bean list --all --by-project --json
bean chronicle doctor --json                               # diagnose local Copilot session data; no raw prompts/responses are imported
bean chronicle reconcile --json                            # create review-only suggestions when explicitly requested
bean chronicle suggestions --json                          # list pending reconciliation suggestions
bean report --date week --include-chronicle --json          # weekly report with review evidence
```

## Chronicle/session diagnostics

When the developer asks whether Taskbean can see local Copilot Chronicle/session data, or asks to prepare review/reconciliation setup, run:

```bash
bean chronicle doctor --json
```

This is diagnostic and read-only. Use it to report local session-state/session-store availability, schema compatibility, and privacy limitations. Do **not** create, complete, link, or reconcile tasks from Chronicle data unless a specific Taskbean command for that action exists and the developer explicitly asks you to use it.

## Chronicle-backed reviews (explicit only)

When the developer explicitly asks to reconcile Chronicle/session data or prepare a weekly review, use JSON-first commands:

```bash
bean chronicle reconcile --since 2026-04-20 --until 2026-04-26 --json
bean chronicle suggestions --status pending --json
bean chronicle approve <suggestion-id> --json
bean chronicle link <suggestion-id> <todo-id> --json
bean chronicle ignore <suggestion-id> --json
bean report --date week --include-chronicle --json
```

Pending Chronicle suggestions are review-only. Do **not** present them as completed work or canonical tasks until the developer approves or links them. Chronicle evidence is metadata/summary only: Taskbean does not import raw prompts, responses, tool outputs, or command output by default. If Chronicle data is unavailable or blocked by policy, continue with normal Taskbean tasks and report the limitation.

## Avoiding duplicates

If you might call `bean add` more than once for the same logical task (retries, restarts), pass a stable `--key`:

```bash
bean add "fix JWT refresh bug" --key "jwt-refresh-2026-04-28" --json
# Subsequent adds with the same --key in the same project update instead of duplicating.
```

## Writing good titles

Titles end up verbatim in the developer's weekly report. Specific and outcome-oriented — write them the way they'd describe the work to a teammate:

- ✅ "fix JWT token refresh causing 401s after 15min"
- ✅ "add OpenTelemetry tracing to API gateway endpoints"
- ✅ "investigate CI docker build failure"
- ❌ "fix bug" / "update code" / "work on feature" / "changes"

A vague title is almost as bad as not logging — it's invisible in a report.

## Pitfalls

- **Do NOT skip small fixes.** They're the easiest to forget and add up across the week.
- **Do NOT call `bean add` for sub-steps within one logical unit.** One `add` per task, not per file edit.
- **Do NOT trigger this skill** for pure-explanation, read-only file inspection, drafting non-code prose, brainstorming, research-only, or for installing/configuring taskbean itself.
- **If you forget to `add` at the start, log it when you finish.** A late log is better than no log.
- **Always use `--json`** so you can parse the returned `id`.

## Project management (rare — only when the developer asks)

```bash
bean projects --json                                       # list tracked projects
bean projects --all --json                                 # include hidden
bean projects --category work --json
bean projects hide [name] --json
bean projects show [name] --json
bean projects categorize [name] --category work --json
bean projects delete [name] --confirm --json               # remove project + skill files (keeps tasks)
bean untrack --json                                        # stop tracking current project
```
