# Install the Taskbean Copilot plugin

Taskbean 0.7 packages the Agent Skill and Dashboard canvas together. It requires
Node.js >=22.13.0, npm, the separately installed Taskbean CLI, and a local Copilot
host with legacy plugin extension and canvas support. Cloud sessions and other
clients are not supported canvas hosts by this package.

## Install and update

After 0.7.0 is published to npm and this plugin is available in the repository:

```powershell
npm install -g taskbean@0.7.0
bean --version
copilot plugin marketplace add taskbean/taskbean
copilot plugin install taskbean@taskbean
copilot plugin list --json
```

The manifest loads the skill and canvas, **not the CLI**. No hook installs npm
packages or captures tasks automatically. In the app, use **Customize** to add
the Taskbean marketplace and install its plugin. Adding a marketplace alone does
not install or enable a plugin. Open a new session, check the Taskbean skill and
`taskbean-dashboard` canvas, and invoke `get_availability` to check its provider.
Activation depends on host policy and session settings.

To refresh the catalog and update both plugin components:

```powershell
copilot plugin marketplace update taskbean
copilot plugin update taskbean
```

Optional session-start updates use `autoUpdate: true` on the Taskbean entry in
your user `extraKnownMarketplaces` settings. Repository settings cannot opt in;
SDK/server sessions do not auto-update. Update the CLI separately through its
installation channel. Keep `bean --version` and the installed plugin aligned.

## Migration and removal

Installation leaves existing user/project extensions, customized skills and
task data untouched. Older copies can expose duplicate providers: check the
extension ID before invoking actions. Back up and review custom copies before
manually disabling or removing them. Do not copy the dashboard into every repo
or change global Git excludes.

Use `copilot plugin disable taskbean` to return to an older reviewed provider,
or `copilot plugin uninstall taskbean` to remove the plugin. Neither operation
uninstalls the separate CLI or deletes `~/.taskbean/taskbean.db`. Do not use a
Taskbean data-removal command for plugin rollback.

## Compatibility and development

The primary catalog is `.github/plugin/marketplace.json`; the identical
`.claude-plugin/marketplace.json` remains for compatibility. Release the manifest,
catalog entry and `metadata.version` together; tests enforce catalog and version
parity.

This uses the [legacy Copilot manifest](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
for explicit skill and extension paths. Agent Plugins 1.0/1.1 instead use fixed
skill locations and an `extensions` namespace object, not a portable canvas
loader. The documented namespace component table does not establish desktop
canvas loading. Do not change formats without host-loader verification.

For development, install dependencies in `cli` with `npm ci --ignore-scripts`,
then run `copilot --plugin-dir .` from the repository root. The dashboard still
needs `bean` on PATH. Use disposable home, cache, `COPILOT_HOME`, `TASKBEAN_HOME`
and `TASKBEAN_DB` paths; never test mutations against live tasks.

`node extensions/taskbean-dashboard/check-availability.mjs` checks packaging,
not runtime loading. From `cli`, run `npm test`; the marketplace lifecycle test
is opt-in via `TASKBEAN_TEST_COPILOT` set to the Copilot executable path.
Run `npm run eval:plugin` from `cli` for the isolated plugin eval suite
(skill cases, every canvas action, error mapping, links and packaging); see
`cli/evals/plugin/README.md`.

**Release gaps:** canvas loading in the Copilot app still requires isolated host
verification. The canvas now runs the CLI without a shell, which fixes the
Windows `add_task` failures in
[#119](https://github.com/taskbean/taskbean/issues/119) and
[#120](https://github.com/taskbean/taskbean/issues/120) for this packaged copy;
older user-extension copies keep the bug until replaced. The canvas iframe cannot
open `ghapp://` links and the canvas SDK has no navigation API, so session links
are copy buttons and pull requests open as https links. The canvas exposes
dashboard/report reads and explicit add/start/block/complete actions. Chronicle
reconciliation remains a review-first CLI workflow, not a canvas action.
