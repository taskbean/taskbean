# 🫘 taskbean

Task management CLI designed for AI coding agents. Tasks are **pushed** by the agent as it works — not pulled from session data.

Both `taskbean` and `bean` commands are available — same tool, shorter name.

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
bean export --format json             # export as JSON
bean export --format csv              # export as CSV
```

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

taskbean is a **dumb, reliable local store**. AI coding agents call simple CLI commands as they work — taskbean just stores what they tell it.

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

taskbean ships as an [Agent Skill](https://agentskills.io) — AI agents auto-discover it:

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

## Agent attribution

When the desktop app is running, taskbean detects sessions from Copilot CLI, Claude Code, Codex, and OpenCode and stamps each `bean add` with the agent + session that created it. Resolution order:

1. `--agent=<name> --session-id=<native>` flags
2. `TASKBEAN_AGENT` + `TASKBEAN_NATIVE_SESSION_ID` env vars (preferred for skill wrappers)
3. Vendor env vars (`CLAUDECODE`/`CLAUDE_SESSION_ID`, `CODEX_SESSION_ID`, `OPENCODE_SESSION`, `COPILOT_CLI_SESSION_ID`)
4. CWD + ±30 min heuristic against recently-seen sessions

If the signal is ambiguous, attribution is left empty rather than guessing. `bean report` includes a `## Usage` section (Markdown) / `usage` key (JSON) summarizing sessions, turns, tokens, and tool calls per agent.

Note: the CLI only **reads** `agent_sessions` / `agent_turns`. Those tables are written exclusively by the Python backend's scanners in `app/agent/usage/`.

## Storage

SQLite database at `~/.taskbean/taskbean.db`. All data stays local. Usage tracking stores only session metadata and aggregate token counts — prompts, responses, and tool outputs are never copied into the database.

## License

MIT
