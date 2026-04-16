import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureCodexSandboxConfig } from '../commands/install.js';

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

  it('--agent codex installs to .agents/skills/ (Codex does not scan .codex/skills)', () => {
    // Clean any prior state.
    try { rmSync(join(TEST_PROJECT, '.agents'), { recursive: true, force: true }); } catch {}
    try { rmSync(join(TEST_PROJECT, '.codex'), { recursive: true, force: true }); } catch {}
    const result = beanJson('install --agent codex');
    assert.equal(result.status, 'installed');
    assert.ok(result.path.includes('.agents'), `expected .agents path, got ${result.path}`);
    assert.ok(existsSync(join(TEST_PROJECT, '.agents', 'skills', 'taskbean', 'SKILL.md')));
    // Must NOT create .codex/skills — Codex ignores that path.
    assert.ok(!existsSync(join(TEST_PROJECT, '.codex', 'skills', 'taskbean', 'SKILL.md')));
  });

  it('--agent opencode installs to .agents/skills/', () => {
    try { rmSync(join(TEST_PROJECT, '.agents'), { recursive: true, force: true }); } catch {}
    const result = beanJson('install --agent opencode');
    assert.equal(result.status, 'installed');
    assert.ok(existsSync(join(TEST_PROJECT, '.agents', 'skills', 'taskbean', 'SKILL.md')));
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

  it('--agent all installs to .agents/, .github/, and .claude/ (not .codex)', () => {
    // Clean all
    for (const d of ['.agents', '.github', '.claude', '.codex']) {
      try { rmSync(join(TEST_PROJECT, d), { recursive: true, force: true }); } catch {}
    }
    const results = JSON.parse(bean('install --agent all --json'));
    assert.ok(Array.isArray(results));
    assert.ok(results.length >= 3, `should install to 3+ paths, got ${results.length}`);
    const paths = results.map(r => r.path);
    assert.ok(paths.some(p => p.includes('.agents')));
    assert.ok(paths.some(p => p.includes('.github')));
    assert.ok(paths.some(p => p.includes('.claude')));
    // .codex/skills/ is NOT a Codex skill discovery path.
    assert.ok(!paths.some(p => p.includes(join('.codex', 'skills'))),
      `must not write to .codex/skills, got ${paths.join(', ')}`);
  });

  it('--agent codex --codex-sandbox appends writable_roots to ~/.codex/config.toml', () => {
    // Clean the codex config dir under the per-test HOME.
    try { rmSync(join(TEST_HOME, '.codex'), { recursive: true, force: true }); } catch {}
    const results = JSON.parse(bean('install --agent codex --codex-sandbox --force --json'));
    const arr = Array.isArray(results) ? results : [results];
    const sandboxResult = arr.find(r => r.status === 'configured' || r.status === 'already_configured');
    assert.ok(sandboxResult, `expected a sandbox config result, got ${JSON.stringify(arr)}`);
    const configPath = join(TEST_HOME, '.codex', 'config.toml');
    assert.ok(existsSync(configPath), 'config.toml should exist');
    const content = readFileSync(configPath, 'utf-8');
    assert.ok(content.includes('[sandbox_workspace_write]'), 'should contain section header');
    assert.ok(content.includes('writable_roots'), 'should contain writable_roots key');
    assert.ok(content.includes('.taskbean'), 'should reference the taskbean dir');

    // Second run is idempotent — no duplicate entry.
    const second = JSON.parse(bean('install --agent codex --codex-sandbox --force --json'));
    const secondArr = Array.isArray(second) ? second : [second];
    const sandboxSecond = secondArr.find(r => r.status === 'configured' || r.status === 'already_configured');
    assert.equal(sandboxSecond.status, 'already_configured');
    const contentAfter = readFileSync(configPath, 'utf-8');
    const occurrences = contentAfter.split('.taskbean').length - 1;
    assert.equal(occurrences, 1, 'writable_roots entry should only appear once');
  });

  it('--codex-sandbox without --agent codex errors out (does not silently no-op)', () => {
    try { rmSync(join(TEST_HOME, '.codex'), { recursive: true, force: true }); } catch {}
    let threw = false;
    try {
      execSync(`${BEAN} install --codex-sandbox --force --json`, {
        encoding: 'utf-8',
        env: { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME },
        cwd: TEST_PROJECT,
      });
    } catch (e) {
      threw = true;
      const stderr = (e.stderr || '').toString();
      assert.match(stderr, /--codex-sandbox requires --agent codex/);
    }
    assert.ok(threw, 'expected non-zero exit when --codex-sandbox used without --agent codex');
    assert.ok(!existsSync(join(TEST_HOME, '.codex', 'config.toml')),
      'config.toml should not be created');
  });

  it('--global installs to home directory', () => {
    const result = beanJson('install --global');
    assert.equal(result.status, 'installed');
    assert.ok(result.path.startsWith(TEST_HOME), `path should be under home: ${result.path}`);
    assert.ok(existsSync(join(TEST_HOME, '.agents', 'skills', 'taskbean', 'SKILL.md')));
  });
});

// Direct unit tests for ensureCodexSandboxConfig's TOML editing branches.
// These cover the edge cases a CLI-level test can't easily exercise: comments
// that contain the target path, another section already having writable_roots,
// CRLF preservation, etc.
describe('ensureCodexSandboxConfig (direct)', () => {
  const BASE = join(tmpdir(), 'taskbean-sandbox-test-' + Date.now());
  const HOMES = [];

  function freshHome() {
    const home = join(BASE, 'h' + HOMES.length);
    mkdirSync(home, { recursive: true });
    HOMES.push(home);
    return home;
  }

  function seedConfig(home, content) {
    const dir = join(home, '.codex');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.toml'), content);
    return join(dir, 'config.toml');
  }

  function taskbeanPath(home) {
    return home.replace(/\\/g, '/') + '/.taskbean';
  }

  after(() => { try { rmSync(BASE, { recursive: true, force: true }); } catch {} });

  it('creates config.toml and section on empty dir', () => {
    const home = freshHome();
    const r = ensureCodexSandboxConfig(home);
    assert.equal(r.status, 'configured');
    const c = readFileSync(r.path, 'utf-8');
    assert.match(c, /\[sandbox_workspace_write\]/);
    assert.ok(c.includes(`"${taskbeanPath(home)}"`));
  });

  it('appends to existing writable_roots IN the sandbox section', () => {
    const home = freshHome();
    seedConfig(home, '[sandbox_workspace_write]\nwritable_roots = ["/tmp/existing"]\n');
    const r = ensureCodexSandboxConfig(home);
    assert.equal(r.status, 'configured');
    const c = readFileSync(r.path, 'utf-8');
    assert.ok(c.includes('"/tmp/existing"'), 'preserves existing entry');
    assert.ok(c.includes(`"${taskbeanPath(home)}"`), 'adds new entry');
  });

  it('does NOT edit writable_roots in a different section', () => {
    const home = freshHome();
    const seed =
      '[other]\n' +
      'writable_roots = ["/should/not/change"]\n' +
      '\n' +
      '[sandbox_workspace_write]\n' +
      'other_key = 1\n';
    seedConfig(home, seed);
    const r = ensureCodexSandboxConfig(home);
    assert.equal(r.status, 'configured');
    const c = readFileSync(r.path, 'utf-8');
    // [other] untouched
    assert.match(c, /\[other\][\s\S]*writable_roots = \["\/should\/not\/change"\]/);
    // sandbox section now has writable_roots with our entry
    const sandboxSlice = c.slice(c.indexOf('[sandbox_workspace_write]'));
    assert.ok(sandboxSlice.includes('writable_roots'), 'sandbox section got writable_roots');
    assert.ok(sandboxSlice.includes(`"${taskbeanPath(home)}"`), 'sandbox section got our path');
  });

  it('inserts writable_roots key when section exists without it', () => {
    const home = freshHome();
    seedConfig(home, '[sandbox_workspace_write]\nnetwork_access = false\n');
    const r = ensureCodexSandboxConfig(home);
    assert.equal(r.status, 'configured');
    const c = readFileSync(r.path, 'utf-8');
    assert.match(c, /\[sandbox_workspace_write\]\r?\nwritable_roots = \["[^"]+"\]/);
    assert.ok(c.includes('network_access = false'), 'other keys preserved');
  });

  it('idempotent: comment containing path does NOT false-positive', () => {
    const home = freshHome();
    const want = taskbeanPath(home);
    // Comment mentions the path, but no actual writable_roots entry exists.
    seedConfig(home, `# note: remember to add "${want}" later\n[sandbox_workspace_write]\nother = 1\n`);
    const r = ensureCodexSandboxConfig(home);
    assert.equal(r.status, 'configured', 'should configure, not short-circuit on comment');
    const c = readFileSync(r.path, 'utf-8');
    const sandboxSlice = c.slice(c.indexOf('[sandbox_workspace_write]'));
    assert.ok(sandboxSlice.includes('writable_roots'), 'writable_roots actually inserted');
  });

  it('idempotent: second call on same config is a no-op', () => {
    const home = freshHome();
    const r1 = ensureCodexSandboxConfig(home);
    assert.equal(r1.status, 'configured');
    const after1 = readFileSync(r1.path, 'utf-8');
    const r2 = ensureCodexSandboxConfig(home);
    assert.equal(r2.status, 'already_configured');
    const after2 = readFileSync(r2.path, 'utf-8');
    assert.equal(after1, after2, 'file unchanged on second call');
  });

  it('preserves CRLF line endings on an existing CRLF file', () => {
    const home = freshHome();
    seedConfig(home, '[other]\r\nkey = 1\r\n');
    const r = ensureCodexSandboxConfig(home);
    const c = readFileSync(r.path, 'utf-8');
    // The section we appended should use CRLF to match the file.
    const tail = c.slice(c.indexOf('[sandbox_workspace_write]'));
    assert.ok(tail.includes('\r\n'), 'new section uses CRLF');
    // Existing CRLFs preserved.
    assert.ok(c.startsWith('[other]\r\nkey = 1\r\n'));
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
