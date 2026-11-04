import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SKILL_MD } from '../commands/install.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const manifest = json('plugin.json');
const marketplace = json('.github/plugin/marketplace.json');
const cli = json('cli/package.json');

test('one legacy manifest discovers the existing skill and dashboard', () => {
  assert.equal(manifest.name, 'taskbean');
  assert.equal(manifest.$schema, undefined);
  assert.equal(manifest.skills, '.agents/skills');
  assert.ok(existsSync(join(root, manifest.skills, 'taskbean', 'SKILL.md')));
  assert.deepEqual(manifest.extensions, ['extensions/taskbean-dashboard']);
  assert.ok(existsSync(join(root, manifest.extensions[0], 'extension.mjs')));
  assert.equal(manifest.hooks, undefined);
  assert.equal(manifest.mcpServers, undefined);
  assert.equal(manifest.lspServers, undefined);
});

test('marketplace points to the complete plugin and active versions agree', () => {
  assert.equal(manifest.version, '0.7.0');
  assert.equal(cli.version, manifest.version);
  const lock = json('cli/package-lock.json');
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(marketplace.metadata.version, manifest.version);
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].source, './');
  assert.equal(marketplace.plugins[0].name, manifest.name);
  assert.equal(marketplace.plugins[0].version, manifest.version);
});

test('primary and compatibility marketplace catalogs stay identical', () => {
  assert.deepEqual(json('.claude-plugin/marketplace.json'), marketplace);
  assert.equal(marketplace.name, 'taskbean');
  assert.equal(typeof marketplace.owner.name, 'string');
  assert.equal(marketplace.plugins[0].source, './');
  assert.ok(existsSync(join(root, marketplace.plugins[0].source, 'plugin.json')));
});

test('source and generated skills carry the release version', () => {
  const marker = `taskbean_version: "${manifest.version}"`;
  const skill = readFileSync(join(root, '.agents', 'skills', 'taskbean', 'SKILL.md'), 'utf8');
  assert.ok(skill.includes(marker));
  assert.ok(SKILL_MD.includes(marker));
});

test('packaging diagnostic has no global configuration or runtime prerequisites', () => {
  const result = JSON.parse(execFileSync(process.execPath, [
    join(root, 'extensions', 'taskbean-dashboard', 'check-availability.mjs'),
  ], { encoding: 'utf8' }));
  assert.equal(result.ok, true);
  assert.equal(result.pluginVersion, manifest.version);
  assert.equal(result.extensionDeclared, true);
  assert.deepEqual(result.missingFiles, []);
  assert.equal(result.runtimeVerified, false);
  assert.equal(result.cliVerified, false);
  assert.equal(result.gitGlobalExcludesFile, undefined);
});

test('imported canvas helper tests and entrypoint syntax checks run with the CLI suite', () => {
  const dashboard = join(root, 'extensions', 'taskbean-dashboard');
  execFileSync(process.execPath, ['--check', join(dashboard, 'extension.mjs')], { encoding: 'utf8' });
  execFileSync(process.execPath, [
    '--test', join(dashboard, 'availability.test.mjs'), join(dashboard, 'session-links.test.mjs'),
  ], { encoding: 'utf8' });
});
