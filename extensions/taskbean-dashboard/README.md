# Taskbean Dashboard

This directory is the repository-owned source for the Taskbean Copilot plugin's
dashboard canvas. The root `plugin.json` loads it together with the Taskbean skill.
See [installation and migration](../../docs/copilot-plugin.md).

The CLI remains a separate prerequisite. The canvas uses `bean` for local task
reads and writes and serves its UI on an ephemeral loopback port.

## Availability

Run the packaging check from the repository root:

```powershell
node extensions/taskbean-dashboard/check-availability.mjs
```

This checks files and manifest wiring, not CLI installation or runtime loading.
The canvas `get_availability` action reports the current provider's actual scope.
Plugin activation and host policy can limit availability between sessions.

Existing user or project copies can produce duplicate providers. Do not copy
this directory into other repositories or overwrite a customized user extension.
Select the intended provider by extension ID. Migration is manual; installing
this plugin does not remove older copies or change global Git excludes.

## Contract and checks

Reads: `get_dashboard`, `get_availability`, `generate_report`.
Navigation (no task change): `open_link`.
Writes: `add_task`, `start_task`, `complete_task`, `block_task`.
Chronicle reconciliation is a CLI workflow, not a canvas action.

```powershell
node --test extensions/taskbean-dashboard/*.test.mjs
cd cli; npm run eval:plugin   # full isolated plugin eval suite
```

`bean-runner.mjs` runs `taskbean/bin/taskbean.js` with Node directly and no
shell (`TASKBEAN_CLI_ENTRY` overrides the entry). The extension host process is
`copilot.exe`, so the runner finds `node` on PATH instead of using
`process.execPath`. If no entry is found it falls back to the `bean` shim with
cross-spawn style cmd escaping. This fixes the quoting failures in
[#119](https://github.com/taskbean/taskbean/issues/119) and
[#120](https://github.com/taskbean/taskbean/issues/120). CLI failures map to
`taskbean_cli_unavailable`, `taskbean_cli_usage`, `taskbean_cli_rejected`,
`taskbean_cli_failed`, `taskbean_busy` and `taskbean_task_not_found` with
home-directory paths redacted.

## Links

The canvas iframe cannot open `ghapp://` URLs and the SDK has no navigation
API. `open_link` takes `{target:"session", taskId|sessionId}` or
`{target:"pull_request", taskId}`, never a URL. The server re-resolves the
target from trusted task data and `link-launcher.mjs` hands an allowlisted URL
(`ghapp://sessions/<uuid>`, `ghapp://github.com/<o>/<r>/pull/<n>`, or the https
PR URL) to the OS: `explorer.exe` on Windows, `open` on macOS, `xdg-open`
elsewhere. It uses an argument array, no shell, and checks that a `ghapp`
handler is registered first. Errors are `taskbean_link_unavailable` (409) and
`taskbean_link_failed` (502). Opening a link never changes a task.

## Row layout

Each row has a left chevron for details, at most one primary action, and a
menu with zero or more other actions (`row-actions.mjs`):

| Row | Primary |
| --- | --- |
| pending | **Start** (filled; the only status change used as a primary) |
| in progress with a session | **Resume** (outline, opens the session) |
| blocked with a session | **Review blocker** (outline, opens the session) |
| PR ready for review, or done with a PR | **Open PR** (outline) |
| other | none |

The menu lists "Change status" items in lifecycle order, a divider, then Open
session or Open PR when it is not the primary, and Copy task ID. The trigger is
hidden when the menu is empty. A failed open shows an inline alert with a Copy
session ID fallback. Reopen is not available yet because the CLI has no reopen
command.

Do not use live tasks for reproduction.
