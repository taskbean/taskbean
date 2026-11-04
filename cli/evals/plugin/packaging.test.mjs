import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { SKILL_MD } from '../../src/commands/install.js';
import { CONTEXT, cliEntry, cliRoot, createSandbox, loadExtension, repoRoot, useEnv } from './support/harness.mjs';

const json = (path) => JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
const manifest = json('plugin.json');
const sandbox = createSandbox('package');
after(() => {
  process.chdir(cliRoot);
  sandbox.cleanup();
});

function trackedFiles(paths) {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...paths], { cwd: repoRoot, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

test('plugin, marketplaces, CLI, lockfile and skill share one version', () => {
  const version = manifest.version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const marketplace = json('.github/plugin/marketplace.json');
  assert.deepEqual(json('.claude-plugin/marketplace.json'), marketplace, 'compatibility catalog is identical');
  assert.equal(marketplace.metadata.version, version);
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, manifest.name);
  assert.equal(marketplace.plugins[0].version, version);
  assert.equal(marketplace.plugins[0].source, './');
  assert.equal(json('cli/package.json').version, version);
  const lock = json('cli/package-lock.json');
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  const marker = `taskbean_version: "${version}"`;
  assert.ok(readFileSync(join(repoRoot, '.agents/skills/taskbean/SKILL.md'), 'utf8').includes(marker));
  assert.ok(SKILL_MD.includes(marker), 'bean install writes the same skill version');
});

test('manifest declares only the skill and the dashboard canvas', () => {
  assert.equal(manifest.skills, '.agents/skills');
  assert.deepEqual(manifest.extensions, ['extensions/taskbean-dashboard']);
  for (const key of ['hooks', 'mcpServers', 'lspServers', 'agents', 'commands']) assert.equal(manifest[key], undefined, key);
});

test('every runtime file the canvas imports is tracked in git', () => {
  const dir = manifest.extensions[0];
  const tracked = new Set(trackedFiles([dir]));
  const source = readFileSync(join(repoRoot, dir, 'extension.mjs'), 'utf8');
  const relative = [...source.matchAll(/from\s+["'](\.\/[^"']+)["']/g)].map((m) => m[1].slice(2));
  assert.ok(relative.includes('bean-runner.mjs'));
  for (const file of ['extension.mjs', ...relative]) {
    assert.ok(tracked.has(`${dir}/${file}`), `${dir}/${file} is tracked`);
  }
  assert.ok(trackedFiles([`${manifest.skills}/taskbean/SKILL.md`]).length === 1, 'skill is tracked');
});

test('a packaged copy of the plugin loads and serves actions from its install path', async () => {
  const install = join(sandbox.dirs.copilot, 'installed-plugins', 'taskbean', 'taskbean');
  const files = trackedFiles(['plugin.json', manifest.skills, ...manifest.extensions]);
  for (const file of files) {
    const target = join(install, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repoRoot, file), target);
  }
  const copied = join(install, manifest.extensions[0]);
  assert.ok(existsSync(join(copied, 'extension.mjs')));
  assert.ok(existsSync(join(install, manifest.skills, 'taskbean', 'SKILL.md')));

  const diagnostic = JSON.parse(execFileSync(process.execPath, [join(copied, 'check-availability.mjs')], { encoding: 'utf8' }));
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.pluginVersion, manifest.version);
  assert.deepEqual(diagnostic.missingFiles, []);

  useEnv({ ...sandbox.env, TASKBEAN_CLI_ENTRY: cliEntry });
  process.chdir(sandbox.dirs.project);
  const { invoke } = await loadExtension(copied);
  const availability = await invoke('get_availability');
  assert.equal(availability.installationPath, copied);
  assert.equal(availability.extensionId, CONTEXT.extensionId);
  const task = await invoke('add_task', { title: 'Installed copy works & 100%' });
  assert.equal(task.title, 'Installed copy works & 100%');
});
