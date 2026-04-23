---
name: taskbean
description: Automatically log tasks as you work so the user has a complete record of everything accomplished across their projects. Use this skill whenever you fix a bug, implement a feature, refactor code, update docs, investigate an issue, write tests, set up infrastructure, review a PR, or do any other distinct unit of coding work. Call bean at the START and END of every task — even small fixes. This is how the user tracks their work for weekly reports and 1-on-1s. If the user asks you to do multiple things, log each separately. Always use this skill when doing real coding work, even if the user never mentions tracking or logging.
---
# taskbean — automatic work logging

`bean` is a globally installed CLI command (installed via `npm install -g taskbean`). Run it directly — do NOT look for it inside this skill directory.

The user relies on taskbean to reconstruct what they accomplished each day and week.Every task you log here shows up in their reports — this is how they communicate their work to their manager. Missing a task means it's invisible.

## When to log

Call `taskbean add` when you begin any distinct unit of work:
- Fixing a bug
- Implementing a feature
- Refactoring code
- Writing or updating docs
- Reviewing a PR
- Investigating an issue
- Setting up infrastructure or configuration

If you're doing multiple things in one session, log each separately. A good rule: if you'd describe it as a separate bullet point in a standup, it's a separate task.

## Commands

```bash
# At the START of work — log what you're about to do
bean add "fix auth middleware token expiry bug" --json
# Returns: {"id":"...", "completed":0, ...}

# When you FINISH — mark it done using the returned id
bean done <id> --json
# Returns: {"id":"...", "completed":1, ...}

# Check what's already logged (avoid duplicates)
bean list --json
```

Always pass `--json` so you can read the returned `id`.

## Project Management

```bash
# List tracked projects (excludes hidden by default)
bean projects --json

# Include hidden projects
bean projects --all --json

# Filter by category
bean projects --category work --json

# Hide a project from default views (tasks still exist, just hidden from lists)
bean projects hide [name] --json

# Show a hidden project again
bean projects show [name] --json

# Set a category on a project (e.g. work, personal, oss)
bean projects categorize [name] --category work --json

# Remove a category
bean projects categorize [name] --clear --json

# Delete a project (removes DB entry + skill files, keeps tasks)
bean projects delete [name] --confirm --json

# Delete without cleaning up files on disk
bean projects delete [name] --confirm --keep-files --json

# Untrack a project (also removes installed skill files)
bean untrack --json
```

## Writing good task titles

Task titles end up in the user's weekly report. Write them the way you'd describe the work to a colleague — specific and outcome-oriented.

**Good titles** (specific, reportable):
- "fix auth middleware token expiry causing 401s on refresh"
- "add OpenTelemetry tracing to API gateway endpoints"
- "migrate user service from REST to gRPC"
- "update README with new local development setup"

**Bad titles** (vague, not useful in a report):
- "fix bug"
- "update code"
- "work on feature"
- "changes"

## Gotchas

- Do NOT skip logging because a task seems small — small fixes still matter in a weekly summary
- Do NOT call `taskbean add` for sub-steps within a single task. One `add` per logical unit of work, not per file edit
- If you forget to `add` at the start, call it when you finish — a late log is better than no log
- The `--key` flag prevents duplicates: `bean add "title" --key "auth-fix" --json` — same key in the same project won't create a second task
