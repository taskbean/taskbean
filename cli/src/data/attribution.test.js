import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Set TASKBEAN_HOME before importing the modules — store.js reads it at
// module-load time to pick the DB path.
const TEST_HOME = join(tmpdir(), 'taskbean-attribution-' + Date.now());
mkdirSync(TEST_HOME, { recursive: true });
process.env.TASKBEAN_HOME = TEST_HOME;
process.env.TASKBEAN_DB = join(TEST_HOME, 'taskbean.db');

const { resolveAttribution, canonicalCwd, AGENTS } = await import('./attribution.js');
const { getDb, run } = await import('./store.js');

// Force table creation.
getDb();

function clearAgentTables() {
  run('DELETE FROM agent_sessions');
  run('DELETE FROM agent_settings');
}

function insertSession({ agent, nativeId, cwd, updatedAt, startedAt }) {
  const now = updatedAt || new Date().toISOString();
  run(
    `INSERT INTO agent_sessions
       (id, agent, native_id, cwd, source_path, started_at, updated_at, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `${agent}-${nativeId}-${Math.random()}`,
      agent,
      nativeId,
      cwd,
      '/fake/source',
      startedAt || now,
      now,
      now,
    ]
  );
}

// An env object that deliberately has no vendor/taskbean vars set.
const EMPTY_ENV = {};

describe('attribution: AGENTS constant', () => {
  it('exports the four known agents', () => {
    assert.deepEqual([...AGENTS].sort(), ['claude-code', 'codex', 'copilot', 'opencode']);
  });
});

describe('attribution: canonicalCwd()', () => {
  it('returns null for falsy input', () => {
    assert.equal(canonicalCwd(null), null);
    assert.equal(canonicalCwd(''), null);
  });

  it('resolves realpath for existing paths', () => {
    const real = realpathSync(TEST_HOME);
    const expected = process.platform === 'win32' ? real.toLowerCase() : real;
    assert.equal(canonicalCwd(TEST_HOME), expected);
  });

  it('tolerates non-existent paths (returns input, possibly lowercased)', () => {
    const bogus = join(TEST_HOME, 'does', 'not', 'exist-xyz');
    const result = canonicalCwd(bogus);
    const expected = process.platform === 'win32' ? bogus.toLowerCase() : bogus;
    assert.equal(result, expected);
  });

  if (process.platform === 'win32') {
    it('lowercases on win32', () => {
      const result = canonicalCwd(TEST_HOME);
      assert.equal(result, result.toLowerCase());
    });
  }
});

describe('attribution: Tier 1 (flags)', () => {
  it('--agent and --session-id → source=flag', () => {
    const r = resolveAttribution({
      agent: 'claude-code',
      sessionId: 'xyz',
      env: EMPTY_ENV,
      cwd: TEST_HOME,
    });
    assert.deepEqual(r, { agent: 'claude-code', nativeId: 'xyz', source: 'flag' });
  });

  it('--agent alone → nativeId null, source=flag', () => {
    const r = resolveAttribution({ agent: 'claude-code', env: EMPTY_ENV, cwd: TEST_HOME });
    assert.deepEqual(r, { agent: 'claude-code', nativeId: null, source: 'flag' });
  });

  it('invalid --agent falls through to lower tiers', () => {
    clearAgentTables();
    const r = resolveAttribution({ agent: 'bogus', env: EMPTY_ENV, cwd: TEST_HOME });
    assert.equal(r.source, 'none');
    assert.equal(r.agent, null);
  });

  it('legacy: --session-id without --agent → copilot + flag-legacy', () => {
    const r = resolveAttribution({ sessionId: 'sess-123', env: EMPTY_ENV, cwd: TEST_HOME });
    assert.deepEqual(r, { agent: 'copilot', nativeId: 'sess-123', source: 'flag-legacy' });
  });

  it('all four agents accepted via --agent', () => {
    for (const a of AGENTS) {
      const r = resolveAttribution({ agent: a, env: EMPTY_ENV, cwd: TEST_HOME });
      assert.equal(r.agent, a);
      assert.equal(r.source, 'flag');
    }
  });
});

describe('attribution: Tier 3 (TASKBEAN env)', () => {
  it('TASKBEAN_AGENT + TASKBEAN_NATIVE_SESSION_ID → source=taskbean-env', () => {
    const r = resolveAttribution({
      env: { TASKBEAN_AGENT: 'codex', TASKBEAN_NATIVE_SESSION_ID: 'n-1' },
      cwd: TEST_HOME,
    });
    assert.deepEqual(r, { agent: 'codex', nativeId: 'n-1', source: 'taskbean-env' });
  });

  it('TASKBEAN_AGENT only (no native) → nativeId null', () => {
    const r = resolveAttribution({
      env: { TASKBEAN_AGENT: 'opencode' },
      cwd: TEST_HOME,
    });
    assert.deepEqual(r, { agent: 'opencode', nativeId: null, source: 'taskbean-env' });
  });

  it('invalid TASKBEAN_AGENT falls through', () => {
    clearAgentTables();
    const r = resolveAttribution({
      env: { TASKBEAN_AGENT: 'nope' },
      cwd: TEST_HOME,
    });
    assert.equal(r.source, 'none');
  });
});

describe('attribution: Tier 4 (vendor env)', () => {
  it('claude-code via CLAUDECODE=1 (+ CLAUDE_SESSION_ID)', () => {
    const r = resolveAttribution({
      env: { CLAUDECODE: '1', CLAUDE_SESSION_ID: 'cs-1' },
      cwd: TEST_HOME,
    });
    assert.deepEqual(r, { agent: 'claude-code', nativeId: 'cs-1', source: 'vendor-env' });
  });

  it('claude-code via CLAUDE_CODE', () => {
    const r = resolveAttribution({ env: { CLAUDE_CODE: 'yes' }, cwd: TEST_HOME });
    assert.equal(r.agent, 'claude-code');
    assert.equal(r.source, 'vendor-env');
    assert.equal(r.nativeId, null);
  });

  it('claude-code via ANTHROPIC_CLI', () => {
    const r = resolveAttribution({ env: { ANTHROPIC_CLI: '1' }, cwd: TEST_HOME });
    assert.equal(r.agent, 'claude-code');
    assert.equal(r.source, 'vendor-env');
  });

  it('codex via CODEX_SESSION_ID', () => {
    const r = resolveAttribution({ env: { CODEX_SESSION_ID: 'cx-1' }, cwd: TEST_HOME });
    assert.deepEqual(r, { agent: 'codex', nativeId: 'cx-1', source: 'vendor-env' });
  });

  it('codex via CODEX_HOME (no native id)', () => {
    const r = resolveAttribution({ env: { CODEX_HOME: '/x' }, cwd: TEST_HOME });
    assert.equal(r.agent, 'codex');
    assert.equal(r.nativeId, null);
    assert.equal(r.source, 'vendor-env');
  });

  it('opencode via OPENCODE_SESSION', () => {
    const r = resolveAttribution({ env: { OPENCODE_SESSION: 'oc-1' }, cwd: TEST_HOME });
    assert.deepEqual(r, { agent: 'opencode', nativeId: 'oc-1', source: 'vendor-env' });
  });

  it('opencode via OPENCODE_SESSION_ID', () => {
    const r = resolveAttribution({ env: { OPENCODE_SESSION_ID: 'oc-2' }, cwd: TEST_HOME });
    assert.deepEqual(r, { agent: 'opencode', nativeId: 'oc-2', source: 'vendor-env' });
  });

  it('copilot via COPILOT_CLI_SESSION_ID', () => {
    const r = resolveAttribution({ env: { COPILOT_CLI_SESSION_ID: 'cp-1' }, cwd: TEST_HOME });
    assert.deepEqual(r, { agent: 'copilot', nativeId: 'cp-1', source: 'vendor-env' });
  });

  it('copilot via COPILOT_SESSION_ID', () => {
    const r = resolveAttribution({ env: { COPILOT_SESSION_ID: 'cp-2' }, cwd: TEST_HOME });
    assert.deepEqual(r, { agent: 'copilot', nativeId: 'cp-2', source: 'vendor-env' });
  });

  it('multiple vendor envs → ambiguous-vendor-env', () => {
    const r = resolveAttribution({
      env: { CLAUDECODE: '1', CODEX_SESSION_ID: 'cx-1' },
      cwd: TEST_HOME,
    });
    assert.deepEqual(r, { agent: null, nativeId: null, source: 'ambiguous-vendor-env' });
  });
});

describe('attribution: Tier 5 (cwd heuristic)', () => {
  // Create a real child dir to exercise ancestor matching with canonicalized paths.
  const PARENT = canonicalCwd(TEST_HOME);
  const CHILD_DIR = join(TEST_HOME, 'child-project');
  before(() => mkdirSync(CHILD_DIR, { recursive: true }));
  const CHILD = canonicalCwd(CHILD_DIR);

  beforeEach(() => clearAgentTables());

  it('matches ancestor cwd within ±30min → cwd-heuristic', () => {
    insertSession({
      agent: 'codex',
      nativeId: 'cx-abc',
      cwd: PARENT,
      updatedAt: new Date().toISOString(),
    });
    const r = resolveAttribution({ env: EMPTY_ENV, cwd: CHILD });
    assert.deepEqual(r, { agent: 'codex', nativeId: 'cx-abc', source: 'cwd-heuristic' });
  });

  it('exact cwd match works too', () => {
    insertSession({
      agent: 'claude-code',
      nativeId: 'cc-1',
      cwd: PARENT,
      updatedAt: new Date().toISOString(),
    });
    const r = resolveAttribution({ env: EMPTY_ENV, cwd: PARENT });
    assert.equal(r.agent, 'claude-code');
    assert.equal(r.source, 'cwd-heuristic');
  });

  it('session 60 minutes ago → out of window → source=none', () => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    insertSession({ agent: 'codex', nativeId: 'stale', cwd: PARENT, updatedAt: old });
    const r = resolveAttribution({ env: EMPTY_ENV, cwd: CHILD });
    assert.deepEqual(r, { agent: null, nativeId: null, source: 'none' });
  });

  it('two agents within window at same cwd → ambiguous-cwd', () => {
    const now = new Date().toISOString();
    insertSession({ agent: 'codex', nativeId: 'a', cwd: PARENT, updatedAt: now });
    insertSession({ agent: 'claude-code', nativeId: 'b', cwd: PARENT, updatedAt: now });
    const r = resolveAttribution({ env: EMPTY_ENV, cwd: CHILD });
    assert.deepEqual(r, { agent: null, nativeId: null, source: 'ambiguous-cwd' });
  });

  it('multiple sessions, same agent → picks most recent, source=cwd-heuristic', () => {
    const recent = new Date().toISOString();
    const older = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    insertSession({ agent: 'codex', nativeId: 'older', cwd: PARENT, updatedAt: older });
    insertSession({ agent: 'codex', nativeId: 'newer', cwd: PARENT, updatedAt: recent });
    const r = resolveAttribution({ env: EMPTY_ENV, cwd: CHILD });
    assert.equal(r.agent, 'codex');
    assert.equal(r.nativeId, 'newer');
    assert.equal(r.source, 'cwd-heuristic');
  });

  it('disabled agent (agent_settings.enabled=0) is excluded', () => {
    const now = new Date().toISOString();
    insertSession({ agent: 'codex', nativeId: 'a', cwd: PARENT, updatedAt: now });
    insertSession({ agent: 'claude-code', nativeId: 'b', cwd: PARENT, updatedAt: now });
    // Disable codex — only claude-code should surface.
    run(
      `INSERT INTO agent_settings (agent, enabled, updated_at) VALUES (?, 0, datetime('now'))`,
      ['codex']
    );
    const r = resolveAttribution({ env: EMPTY_ENV, cwd: CHILD });
    assert.deepEqual(r, { agent: 'claude-code', nativeId: 'b', source: 'cwd-heuristic' });
  });

  it('unrelated cwd does not match → source=none', () => {
    insertSession({
      agent: 'codex',
      nativeId: 'x',
      cwd: '/some/other/path',
      updatedAt: new Date().toISOString(),
    });
    const r = resolveAttribution({ env: EMPTY_ENV, cwd: CHILD });
    assert.equal(r.source, 'none');
  });
});

describe('attribution: precedence', () => {
  const PARENT = canonicalCwd(TEST_HOME);

  beforeEach(() => clearAgentTables());

  it('flag beats everything', () => {
    insertSession({
      agent: 'codex',
      nativeId: 'heur',
      cwd: PARENT,
      updatedAt: new Date().toISOString(),
    });
    const r = resolveAttribution({
      agent: 'claude-code',
      sessionId: 'flag-id',
      env: { TASKBEAN_AGENT: 'copilot', CLAUDECODE: '1' },
      cwd: PARENT,
    });
    assert.deepEqual(r, { agent: 'claude-code', nativeId: 'flag-id', source: 'flag' });
  });

  it('TASKBEAN env beats vendor env and cwd heuristic', () => {
    insertSession({
      agent: 'codex',
      nativeId: 'heur',
      cwd: PARENT,
      updatedAt: new Date().toISOString(),
    });
    const r = resolveAttribution({
      env: {
        TASKBEAN_AGENT: 'opencode',
        TASKBEAN_NATIVE_SESSION_ID: 'tb-1',
        CLAUDECODE: '1',
      },
      cwd: PARENT,
    });
    assert.deepEqual(r, { agent: 'opencode', nativeId: 'tb-1', source: 'taskbean-env' });
  });

  it('vendor env beats cwd heuristic', () => {
    insertSession({
      agent: 'codex',
      nativeId: 'heur',
      cwd: PARENT,
      updatedAt: new Date().toISOString(),
    });
    const r = resolveAttribution({
      env: { CLAUDECODE: '1', CLAUDE_SESSION_ID: 'cc-99' },
      cwd: PARENT,
    });
    assert.deepEqual(r, { agent: 'claude-code', nativeId: 'cc-99', source: 'vendor-env' });
  });
});

after(() => {
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {}
});
