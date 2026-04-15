import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const BEAN = 'node ' + join(process.cwd(), 'bin', 'taskbean.js');
const TEST_HOME = join(tmpdir(), 'taskbean-install-test-' + Date.now());
const TEST_PROJECT = join(TEST_HOME, 'my-project');

function bean(args, cwd = TEST_PROJECT) {
  try {
    return execSync(`${BEAN} ${args}`, {
      encoding: 'utf-8',
      env: { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME },
      cwd,
    }).trim();
  } catch (e) {
    if (e.stdout) return e.stdout.trim();
    throw e;
  }
}

function beanJson(args, cwd = TEST_PROJECT) {
  return JSON.parse(bean(`${args} --json`, cwd));
}

describe('bean install', () => {
  before(() => {
    mkdirSync(TEST_PROJECT, { recursive: true });
  });
  after(() => {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  });

  it('default installs to .agents/skills/taskbean/SKILL.md only', () => {
    const result = beanJson('install');
    assert.equal(result.status, 'installed');
    assert.ok(result.path.includes('.agents'));
    assert.ok(existsSync(join(TEST_PROJECT, '.agents', 'skills', 'taskbean', 'SKILL.md')));
    // Should NOT create .claude, .codex, .github by default
    assert.ok(!existsSync(join(TEST_PROJECT, '.claude', 'skills', 'taskbean', 'SKILL.md')));
    assert.ok(!existsSync(join(TEST_PROJECT, '.codex', 'skills', 'taskbean', 'SKILL.md')));
  });

  it('installed SKILL.md has valid frontmatter', () => {
    const content = readFileSync(join(TEST_PROJECT, '.agents', 'skills', 'taskbean', 'SKILL.md'), 'utf-8');
    assert.ok(content.startsWith('---\nname: taskbean\n'));
    assert.ok(content.includes('description:'));
    assert.ok(content.includes('---\n# taskbean'));
  });

  it('installed SKILL.md has proper markdown (no escaped backticks)', () => {
    const content = readFileSync(join(TEST_PROJECT, '.agents', 'skills', 'taskbean', 'SKILL.md'), 'utf-8');
    assert.ok(!content.includes('\\`'), 'should not contain escaped backticks');
    assert.ok(content.includes('```bash'), 'should contain code fence');
    assert.ok(content.includes('`bean`'), 'should contain inline code');
    assert.ok(content.includes('`--json`'), 'should contain --json inline code');
  });

  it('idempotent — second install returns already_installed', () => {
    const result = beanJson('install');
    assert.equal(result.status, 'already_installed');
  });

  it('--force overwrites existing SKILL.md', () => {
    const result = beanJson('install --force');
    assert.ok(result.status === 'installed' || result.status === 'updated');
  });

  it('--agent claude installs to .claude/skills/', () => {
    const result = beanJson('install --agent claude');
    assert.equal(result.status, 'installed');
    assert.ok(result.path.includes('.claude'));
    assert.ok(existsSync(join(TEST_PROJECT, '.claude', 'skills', 'taskbean', 'SKILL.md')));
  });

  it('--agent codex installs to .codex/skills/', () => {
    const result = beanJson('install --agent codex');
    assert.equal(result.status, 'installed');
    assert.ok(result.path.includes('.codex'));
    assert.ok(existsSync(join(TEST_PROJECT, '.codex', 'skills', 'taskbean', 'SKILL.md')));
  });

  it('--agent copilot installs to .agents/ and .github/', () => {
    // Clean first
    try { rmSync(join(TEST_PROJECT, '.github'), { recursive: true, force: true }); } catch {}
    const results = JSON.parse(bean('install --agent copilot --force --json'));
    assert.ok(Array.isArray(results), 'should return array for multi-target');
    const paths = results.map(r => r.path);
    assert.ok(paths.some(p => p.includes('.agents')));
    assert.ok(paths.some(p => p.includes('.github')));
  });

  it('--agent all installs to all 4 directories', () => {
    // Clean all
    for (const d of ['.agents', '.github', '.claude', '.codex']) {
      try { rmSync(join(TEST_PROJECT, d), { recursive: true, force: true }); } catch {}
    }
    const results = JSON.parse(bean('install --agent all --json'));
    assert.ok(Array.isArray(results));
    assert.ok(results.length >= 4, `should install to 4+ paths, got ${results.length}`);
    const paths = results.map(r => r.path);
    assert.ok(paths.some(p => p.includes('.agents')));
    assert.ok(paths.some(p => p.includes('.github')));
    assert.ok(paths.some(p => p.includes('.claude')));
    assert.ok(paths.some(p => p.includes('.codex')));
  });

  it('--global installs to home directory', () => {
    const result = beanJson('install --global');
    assert.equal(result.status, 'installed');
    assert.ok(result.path.startsWith(TEST_HOME), `path should be under home: ${result.path}`);
    assert.ok(existsSync(join(TEST_HOME, '.agents', 'skills', 'taskbean', 'SKILL.md')));
  });
});

describe('bean add/done/list with TASKBEAN_DB override', () => {
  const DB_HOME = join(tmpdir(), 'taskbean-db-test-' + Date.now());
  const DB_PROJECT = join(DB_HOME, 'db-project');
  const DB_PATH = join(DB_HOME, 'custom-db', 'test.db');

  before(() => {
    mkdirSync(DB_PROJECT, { recursive: true });
    mkdirSync(join(DB_HOME, 'custom-db'), { recursive: true });
  });
  after(() => { try { rmSync(DB_HOME, { recursive: true, force: true }); } catch {} });

  function beanWithDb(args) {
    const env = Object.assign({}, process.env, {
      HOME: DB_HOME,
      USERPROFILE: DB_HOME,
      TASKBEAN_DB: DB_PATH,
    });
    try {
      return execSync(`${BEAN} ${args}`, {
        encoding: 'utf-8',
        env,
        cwd: DB_PROJECT,
      }).trim();
    } catch (e) { if (e.stdout) return e.stdout.trim(); throw e; }
  }

  it('TASKBEAN_DB overrides default DB path', () => {
    const result = JSON.parse(beanWithDb('add custom-db-test --json'));
    assert.ok(result.id);
    assert.ok(existsSync(DB_PATH), 'DB should be created at custom path');
  });

  it('tasks are in the custom DB, not the default', () => {
    const tasks = JSON.parse(beanWithDb('list --json'));
    assert.ok(tasks.some(t => t.title === 'custom-db-test'));
  });
});

describe('JSON output contract', () => {
  const JSON_HOME = join(tmpdir(), 'taskbean-json-test-' + Date.now());
  const JSON_PROJECT = join(JSON_HOME, 'json-project');

  before(() => { mkdirSync(JSON_PROJECT, { recursive: true }); });
  after(() => { try { rmSync(JSON_HOME, { recursive: true, force: true }); } catch {} });

  function b(args) {
    try {
      return execSync(`${BEAN} ${args}`, {
        encoding: 'utf-8',
        env: { ...process.env, HOME: JSON_HOME, USERPROFILE: JSON_HOME },
        cwd: JSON_PROJECT,
      }).trim();
    } catch (e) { if (e.stdout) return e.stdout.trim(); throw e; }
  }

  it('bean add --json returns exactly one JSON object', () => {
    const raw = b('add "json test" --json');
    const parsed = JSON.parse(raw);
    assert.equal(typeof parsed, 'object');
    assert.ok(!Array.isArray(parsed));
    assert.ok(parsed.id);
  });

  it('bean list --json returns a JSON array', () => {
    const raw = b('list --json');
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed));
  });

  it('bean install --json returns valid JSON', () => {
    const raw = b('install --json');
    const parsed = JSON.parse(raw);
    assert.ok(parsed.status);
  });
});
