import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('local marketplace installs, refreshes and removes the complete plugin without deleting tasks', {
  skip: !process.env.TASKBEAN_TEST_COPILOT,
}, () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'taskbean-plugin-test-'));
  const repo = join(sandbox, 'repository');
  const home = join(sandbox, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  try {
    for (const path of ['plugin.json', '.github/plugin', '.claude-plugin', '.agents/skills', 'extensions']) {
      cpSync(join(root, path), join(repo, path), { recursive: true });
    }
    const dbPath = join(home, 'taskbean.db');
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT); INSERT INTO todos VALUES ('preserved', 'Example task');");
    db.close();
    const before = readFileSync(dbPath);
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      HOME: home,
      USERPROFILE: home,
      COPILOT_HOME: join(home, 'copilot'),
      COPILOT_CACHE_HOME: join(home, 'cache'),
      COPILOT_AUTO_UPDATE: 'false',
      TASKBEAN_HOME: home,
      TASKBEAN_DB: dbPath,
      TASKBEAN_NO_UPGRADE_NOTICE: '1',
    };
    const run = (...args) => execFileSync(process.env.TASKBEAN_TEST_COPILOT, ['plugin', ...args], {
      cwd: home, env, encoding: 'utf8', timeout: 120_000, windowsHide: true,
    });
    run('marketplace', 'add', repo);
    const catalog = JSON.parse(run('marketplace', 'browse', 'taskbean', '--json'));
    assert.ok(catalog.some((entry) => entry.name === 'taskbean'));
    run('install', 'taskbean@taskbean');
    const installed = () => JSON.parse(run('list', '--json')).find((entry) => entry.name === 'taskbean');
    assert.equal(installed().version, '0.7.0');
    assert.equal(installed().enabled, true);
    const installedRoot = installed().installedFrom;
    assert.equal(installedRoot, repo);
    assert.ok(existsSync(join(installedRoot, 'extensions', 'taskbean-dashboard', 'extension.mjs')));
    assert.ok(existsSync(join(installedRoot, '.agents', 'skills', 'taskbean', 'SKILL.md')));

    for (const path of ['plugin.json', '.github/plugin/marketplace.json', '.claude-plugin/marketplace.json']) {
      const file = join(repo, path);
      const content = JSON.parse(readFileSync(file, 'utf8'));
      if (path === 'plugin.json') content.version = '0.7.1';
      else {
        content.metadata.version = '0.7.1';
        content.plugins[0].version = '0.7.1';
      }
      writeFileSync(file, JSON.stringify(content, null, 2));
    }
    run('marketplace', 'update', 'taskbean');
    run('update', 'taskbean');
    assert.equal(installed().version, '0.7.1');
    assert.ok(existsSync(join(installed().installedFrom, 'extensions', 'taskbean-dashboard', 'extension.mjs')));
    run('uninstall', 'taskbean');
    assert.equal(installed()?.enabled ?? false, false);
    assert.deepEqual(readFileSync(dbPath), before);
    run('marketplace', 'remove', 'taskbean');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
