# Taskbean Dashboard

This directory is the repository-owned source for the Taskbean Copilot plugin's
dashboard canvas. The root `plugin.json` loads it together with the Taskbean skill.
See [installation and migration](../../docs/copilot-plugin.md).

The CLI remains a separate prerequisite. The canvas uses `bean` for local task
reads and writes and serves its UI on an ephemeral loopback port. It does not
require the legacy PWA or Foundry Local.

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
Writes: `add_task`, `start_task`, `complete_task`, `block_task`.
Chronicle reconciliation is a CLI workflow, not a canvas action.

```powershell
node --test extensions/taskbean-dashboard/*.test.mjs
```

The imported mutation implementation still has the Windows reliability issues
tracked in [#119](https://github.com/taskbean/taskbean/issues/119) and
[#120](https://github.com/taskbean/taskbean/issues/120). Packaging checks do not
establish that task creation works. Do not use live tasks for reproduction.
