# 🫘 taskbean

Task management CLI for AI coding agents. Agents push tasks as they work. No session scraping, no post-hoc extraction.

Both `taskbean` and `bean` work. Same tool, shorter name.

## Install

```bash
# npm (requires Node.js)
npm install -g taskbean

# macOS / Linux
curl -fsSL https://taskbean.ai/install | bash

# Windows PowerShell
iwr -useb https://taskbean.ai/install.ps1 | iex

# Homebrew
brew install taskbean

# Winget
winget install taskbean.taskbean
```

## Quick Start

```bash
bean add "fix auth bug before standup"
bean add "refactor database layer"
bean start 1                          # start first task (by position)
bean done 1                           # complete first task
bean list                             # show all tasks
bean count                            # quick status counts
bean report                           # daily markdown report
bean chronicle doctor --json          # diagnose local Copilot session data
bean chronicle reconcile --json       # create review-only work suggestions
```

## All Commands

### Task Management
```bash
bean add "title"                      # create a task
bean add "title" --key dedup-1        # upsert (won't duplicate)
bean done <id|#>                      # mark complete (idempotent)
bean start <id|#>                     # mark in-progress
bean block <id|#>                     # mark blocked
bean edit <id|#> "new title"          # rename a task
bean remove <id|#>                    # delete a task (alias: bean rm)
bean remind "title" tomorrow          # task with due date
bean remind "standup" "friday 9am"    # natural language dates
```

### Queries
```bash
bean list                             # tasks in current project
bean list --all                       # tasks across all projects
bean list --status done               # filter by status
bean count                            # counts by status
bean projects                         # list all projects
```

### Reports & Export
```bash
bean report                           # today's report (markdown)
bean report --date week               # this week
bean report --date week --include-chronicle --json
bean export --format json             # export as JSON
bean export --format csv              # export as CSV
```

The plain report is canonical Taskbean data only. `--include-chronicle` adds linked evidence and pending review suggestions for weekly review workflows.

### Chronicle Diagnostics
```bash
bean chronicle doctor                 # local session-data capability check
bean chronicle doctor --json          # machine-readable diagnostics
bean chronicle reconcile --json       # generate review-only suggestions
bean chronicle suggestions --json     # list pending suggestions
bean chronicle approve <id> --json    # create a task from a suggestion
bean chronicle link <id> <todo> --json # attach evidence to an existing task
bean chronicle ignore <id> --json     # dismiss a suggestion
```

`chronicle doctor` inspects only local Copilot session metadata/schema availability. It does not copy raw prompts, responses, or tool outputs into taskbean.

Chronicle reconciliation turns local session metadata into a review inbox. Pending suggestions are not Taskbean tasks and do not appear in canonical task reports until you approve or link them. Exact session matches to existing tasks are auto-linked as evidence and suppressed from the pending inbox; fuzzy matches stay pending for review.

Daily reconciliation:

```bash
bean chronicle reconcile --since 2026-04-20 --until 2026-04-20 --json
bean chronicle suggestions --status pending --json
```

Decision commands:

```bash
bean chronicle approve <suggestion-id> --status done --tags weekly-review --json
bean chronicle approve <suggestion-id> --title "ship Chronicle report preview" --project "taskbean" --json
bean chronicle approve <suggestion-id> --work-date 2026-04-20 --json
bean chronicle link <suggestion-id> <todo-id> --json
bean chronicle ignore <suggestion-id> --json
```

Weekly report automation:

```bash
bean report --date week --json
bean report --date week --include-chronicle --json
```

Prefer JSON for scripts. Useful automation fields include `counts.discovered`, `counts.created`, `counts.updated`, `counts.linked`, `counts.pending`, `count`, `suggestions`, `taskGroups`, `chronicle.summary`, and `chronicle.pendingSuggestions`. Do not scrape Markdown report text. Suggestions and evidence carry `occurred_at` work time; reports filter pending suggestions by that work time, and approval defaults the created task's date to it unless `--work-date` overrides it. For monthly improvement reviews, keep weekly JSON reports as artifacts or use `--date all` and filter the JSON downstream.

Unavailable states are expected on some machines. If session data is missing, blocked by policy, not synced from a cloud agent, or outside the requested date range, reconciliation returns no pending suggestions and reports still work from Taskbean's task database. Run `bean chronicle doctor --json` before setting up automation to verify local data availability.

Privacy defaults: Taskbean stores metadata and summaries needed for review, including source session ids, timestamps, branch/ref/file-path signals, confidence, and decision status. It does not copy raw prompts, assistant responses, tool outputs, or command output into its database by default. Treat `--include-chronicle` output as review evidence, not as a raw transcript. When Chronicle schemas evolve, keep reconciliation's metadata/summary allowlist and doctor diagnostics' raw-content denylist in sync.

### Project Management
```bash
bean track                            # track current project + install skill
bean track --path ~/projects/myapp    # track another project
bean untrack                          # stop tracking
bean install                          # install agent skill into project
bean install --global                 # install for all projects
bean init --name "My App"             # create .taskbean.json
```

### PWA Dashboard
```bash
bean serve                            # open at http://localhost:3333
bean serve --port 8080                # custom port
```

## How It Works

taskbean is a **dumb, reliable local store**. AI coding agents call CLI commands as they work. taskbean stores what they tell it.

```
Agent (Copilot/Claude/etc)     bean CLI              taskbean PWA
         │                         │                      │
         ├── bean add "..." ─────▶ │                      │
         │◀── { id: "t_abc" } ────│                      │
         │                         │── writes ──▶ SQLite  │
         ├── bean done t_abc ────▶ │                      │
         │                         │                      │
         │                         │◀── bean serve ─────▶ │
```

## Agent Skill

taskbean ships as an [Agent Skill](https://agentskills.io). AI agents auto-discover it:

```bash
bean install --global     # all projects (recommended)
bean install              # current project only
bean track                # track + install in one step
```

The SKILL.md is intentionally tiny (~100 tokens) so local models with small context windows can use it.

## Positional Addressing

Reference tasks by position instead of ID:

```bash
bean list
# ⬚ t_abc123  fix auth bug
# ⬚ t_def456  refactor DB

bean done 1              # completes "fix auth bug" (1st in list)
bean start 2             # starts "refactor DB" (2nd in list)
```

## Project Detection

Tasks auto-group by project. Detection order:
1. `--project` flag
2. `.taskbean.json` in parent dirs
3. Git repository root
4. Current directory

## Agent Attribution

When the desktop app is running, taskbean detects sessions from Copilot CLI, Claude Code, Codex, and OpenCode and stamps each `bean add` with the agent and session that created it.

If the signal is ambiguous, attribution is left empty rather than guessing. `bean report` includes a usage section with per-agent sessions, turns, tokens, and tool calls.

## Storage

SQLite database at `~/.taskbean/taskbean.db`. All data stays local. Usage tracking stores session metadata and aggregate token counts only. Prompts, responses, and tool outputs are never copied into the database.

## Uninstall

```bash
# Remove skill files + system artifacts (keeps your task data)
bean uninstall --keep-data

# Also scan for manually installed skill files
bean uninstall --keep-data --scan ~/projects

# Full removal including task database
bean uninstall

# Preview what would be removed
bean uninstall --dry-run
```

Then remove the CLI itself:

```bash
npm uninstall -g taskbean          # if installed via npm
winget uninstall taskbean.taskbean # if installed via winget
```

## License

MIT
