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
Observe only (no task change): `observe_evidence` runs
`bean chronicle reconcile --observe --json`. It writes only pending
suggestions, unlinked evidence and a checkpoint, and returns `tasksChanged: 0`.
`get_dashboard` includes `suggestedEvidence` (pending suggestions, labelled
"Suggestion", not accepted outcomes). Approve, link and ignore stay in the CLI.

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
(`ghapp://sessions/<uuid>` or a validated `https://github.com/<o>/<r>/pull/<n>`
PR URL) to the OS: `explorer.exe` on Windows, `open` on macOS, `xdg-open`
elsewhere. It uses an argument array, no shell, and checks that a `ghapp`
handler is registered first. Errors are `taskbean_link_unavailable` (409) and
`taskbean_link_failed` (502). Dispatching a link never sends a message or changes
a task. The action returns `{launcherStarted:true, navigationConfirmed:false, url}`
when the launcher process spawns; it cannot confirm that a handler accepted the
link or that the app or browser
opened the target. Feedback tells the user to check the destination.
PRs always use validated HTTPS, not a native PR route.
Bare repository and issue links are not
allowlisted (clone prompt and mark-as-read side effects). Older installed copies
render Resume and Review blocker as detail toggles; those never navigate.

## Browser-to-loopback boundary

Each canvas server binds only to `127.0.0.1` on a random port and generates a
256-bit token, valid until that server closes. The SDK receives a bootstrap URL
with that token; the page requires it and sends it in `X-Taskbean-Token` on each
action request. Native SDK actions call their handlers directly and do not use
this HTTP boundary.

`/api/action` requires the exact loopback Host, the token and JSON content type.
An Origin, when present, must match the canvas origin (including the port);
opaque and cross-origin requests and `Sec-Fetch-Site: cross-site` are rejected.
There is no CORS opt-in. Simple-form posts and cross-origin preflights cannot
invoke actions. The tokenized page may be embedded by the SDK from another
origin; its own action fetches are same-origin. Responses use `no-store`,
`no-referrer` and `nosniff` to limit caching and capability leakage.

This protects against browser CSRF and DNS rebinding, not malicious local
processes, compromised host/SDK code, or script injection in the authorized
page. Anyone who obtains the bootstrap URL has the capability; do not share it.
The token is not ledger data and is regenerated on a fresh server. This boundary
does not add user confirmation or authentication to native SDK actions.

## Row layout

Each row has a left chevron for details, at most one primary action, and a
menu with zero or more other actions (`row-actions.mjs`):

| Row | Primary |
| --- | --- |
| pending | **Start** (filled; the only status change used as a primary) |
| in progress with a session | **Resume** (outline, starts the session link launcher) |
| blocked with a session | **Review blocker** (outline, starts the session link launcher) |
| PR ready for review, or done with a PR | **Open PR** (outline) |
| other | none |

The menu lists "Change status" items in lifecycle order, a divider, then Open
session or Open PR when it is not the primary, and Copy task ID. The trigger is
hidden when the menu is empty. A failed open shows an inline alert with a Copy
session ID fallback. Reopen is not available yet because the CLI has no reopen
command.

Do not use live tasks for reproduction.
