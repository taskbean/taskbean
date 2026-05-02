---
name: taskbean
description: >-
  Captures every coding task the developer asks you to do so it shows up in their weekly report, 1-on-1s, and performance review — none of your work disappears into untracked commits. Whenever the developer asks for concrete coding work (fix a bug, debug, investigate, implement a feature, build, add, refactor, migrate, configure CI/CD, write tests, update docs, or change any code), call `bean add "<outcome-oriented title>" --json` BEFORE you start, capture the returned id, do the work, then call `bean done <id> --json` when finished. This applies to single-sentence requests like "fix X" or "Y is broken" as much as multi-step ones — small fixes are easiest to forget. If you can't complete the task, log it anyway. Do NOT use for: pure-explanation questions, read-only file inspection, non-code prose, brainstorming, research-only tasks, code review where the user says "don't change anything", or installing taskbean itself.
metadata:
  taskbean_version: "0.5.2"
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
```

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
