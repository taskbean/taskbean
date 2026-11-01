# Taskbean plugin evals

Repeatable, offline checks for the Taskbean Copilot plugin: the Agent Skill, the
Dashboard canvas, and the plugin/marketplace packaging.

```powershell
cd cli
npm run eval:plugin
```

## Isolation

Every case runs in a temp sandbox from `support/harness.mjs`. The sandbox builds
its environment from scratch: `HOME`, `USERPROFILE`, `COPILOT_HOME`,
`TASKBEAN_HOME`, `TASKBEAN_DB`, `TEMP` and `PATH` point into the sandbox. The
harness refuses to run if the sandbox home is the real home. The canvas runs with
a stub `@github/copilot-sdk` (`support/sdk-stub.mjs`), so no Copilot host,
network or live `~/.taskbean` data is used. `TASKBEAN_CLI_ENTRY` points the
canvas at this repository's `bin/taskbean.js`.

## Coverage

| File | Checks |
|---|---|
| `skill.test.mjs` + `skill-cases.json` | 11 trigger and 6 no-trigger prompts with expected `bean` commands. Each sequence starts with `bean add` and ends with `done`/`block`, uses only commands documented in `SKILL.md`, and replays against an isolated store. |
| `canvas-actions.test.mjs` | All 7 actions: `get_availability`, `get_dashboard` (period/status/search/project filters), `add_task` (6 hostile titles, project + key), `start_task`, `block_task`, `complete_task`, `generate_report`. Also the HTTP routes, session/PR link output, and that the inline UI script parses. |
| `canvas-errors.test.mjs` | Missing CLI, usage error, crash, unreadable output, JSON rejection, locked DB (fake CLI and a real `BEGIN EXCLUSIVE` lock), and home-path redaction. |
| `bean-runner.test.mjs` | Entry discovery, `TASKBEAN_CLI_ENTRY`, Node runtime selection when the host is `copilot.exe`, direct and cmd-fallback round-trip of the hostile titles, and failure classification. |
| `packaging.test.mjs` | Version parity across `plugin.json`, both `marketplace.json` files, `cli/package.json`, the lockfile and the skill. Manifest keys, tracked relative imports, and a git-tracked install copy that loads and runs `get_availability` + `add_task`. |

The hostile `add_task` titles: `Plain title`,
`Bug bash GHCP harness private preview scenarios`, `Quote "x" test`,
`50% done & ^caret`, `Curly ’ apostrophe`, `%PATH% & echo pwned`.

## Results

40/40 checks pass on Windows (Node 22+). The real-lock busy case takes about
30 seconds because the CLI waits on SQLite `busy_timeout` for several statements.

## Out of scope here

- Model trigger rates. These need a live agent; see `../evals.json`,
  `../trigger-eval.json` and the manual runs in `../README.md`.
- The live Copilot marketplace install/update flow. It is opt-in:
  `$env:TASKBEAN_TEST_COPILOT='<path to copilot>'; node --test src/tests/plugin-lifecycle.test.js`.
- Opening the canvas in the GitHub Copilot app and `ghapp://` navigation.
