<div align="center">

# 🫘 taskbean

**Task management for AI coding agents — and the humans who use them.**

No cloud. No subscription. No data leaves your machine.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?logo=windows)](https://www.microsoft.com/windows)
[![PWA](https://img.shields.io/badge/install-PWA-5A0FC8?logo=pwa)](https://web.dev/progressive-web-apps/)
[![Foundry Local](https://img.shields.io/badge/AI-Foundry%20Local-742774?logo=microsoft)](https://github.com/microsoft/foundry-local)

</div>

---

## What is taskbean?

taskbean is a **local-first task manager** built for developers who work with AI coding agents. It has two halves:

| | CLI (`cli/`) | Desktop App (`app/`) |
|---|---|---|
| **For** | AI agents (Copilot, Claude, etc.) | You, the developer |
| **Does** | Logs tasks as the agent works | Dashboard, AI chat, reminders, reports |
| **How** | `bean add "fix auth bug"` → `bean done` | PWA with Foundry Local on-device inference |
| **Tech** | Node.js, commander, SQLite | FastAPI + Express, Foundry Local SDK, vanilla JS PWA |

Both halves read and write the same local SQLite database at `~/.taskbean/taskbean.db`. The CLI is the **mechanism** — Copilot tracks your work automatically. The app is the **experience** — you see everything in a beautiful local dashboard.

```
Agent (Copilot/Claude)          CLI                    Desktop App (PWA)
       │                         │                          │
       ├── bean add "fix bug" ──▶│                          │
       ├── bean done t_abc ────▶ │                          │
       │                         │── writes ──▶ SQLite ◀── reads ──│
       │                         │                          │
       │                         │    bean serve ──▶ mini dashboard │
       │                         │                          │
       │                         │         Foundry Local ──▶│ AI chat, voice,
       │                         │                          │ reminders, themes
```

## Quick Start

### CLI (Agent Skill)

```bash
# Install globally
npm install -g taskbean

# Or via platform binary
curl -fsSL https://taskbean.ai/install | bash          # macOS / Linux
iwr -useb https://taskbean.ai/install.ps1 | iex        # Windows PowerShell

# Use it
bean add "fix auth bug before standup"
bean done 1
bean list
bean report
```

### Desktop App

```bash
cd app

# Python backend (primary)
pip install -r agent/requirements.txt
python agent/main.py

# Or Node.js backend (legacy)
npm install
npm start

# Open http://localhost:2326
```

## Project Structure

```
taskbean/
├── cli/                    # Agent-facing CLI tool
│   ├── bin/taskbean.js     # Entry point (aliased as `bean`)
│   ├── src/commands/       # 16 commands: add, done, start, list, report...
│   ├── src/data/           # SQLite store, date parsing, project detection
│   ├── pwa/                # Minimal dashboard for `bean serve`
│   ├── scripts/            # Install scripts (curl|bash, PowerShell)
│   ├── evals/              # Agent skill evaluation scenarios
│   └── package.json        # npm: "taskbean"
│
├── app/                    # Human-facing desktop PWA
│   ├── agent/              # Python backend (FastAPI + Foundry Local)
│   ├── public/             # Single-file vanilla JS PWA
│   ├── tests/              # Playwright test suite (21 specs)
│   ├── server.js           # Node.js backend (Express, legacy)
│   ├── db.js               # SQLite schema + CRUD
│   └── package.json        # "taskbean-app" (not published to npm)
│
├── .agents/skills/taskbean/SKILL.md   # Agent skill manifest
├── .github/
│   ├── copilot-instructions.md
│   └── workflows/release.yml
├── LICENSE
└── README.md               # ← you are here
```

## How It Works

The CLI ships as a [Copilot Agent Skill](https://agentskills.io). When installed, AI agents auto-discover taskbean and call `bean add` / `bean done` as they work — no prompting required.

```bash
bean install --global     # enable for all projects
bean track                # track current project + install skill
```

The desktop app runs entirely on your device using [Microsoft Foundry Local](https://github.com/microsoft/foundry-local) for AI inference (NPU, GPU, or CPU). Features include:

- 💬 Natural language task management
- ⏰ Smart reminders with Windows notifications
- 🔄 Recurring tasks
- 🧠 Multi-model support (Phi-4, Qwen, etc.)
- 🎤 Voice input
- 📎 File extraction (meeting notes → tasks)
- 🎨 4 themes (Dark, Light, Java Cream, High Contrast)
- 🤓 Nerd mode with live telemetry

## Storage

All data stays local in a single SQLite database:

```
~/.taskbean/taskbean.db
```

Both the CLI and the desktop app read and write to this file. No cloud sync, no accounts, no telemetry.

## License

[MIT](LICENSE) — free forever.
