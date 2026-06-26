import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverChronicleCapabilities } from '../chronicle/adapter.js';

const BEAN = join(process.cwd(), 'bin', 'taskbean.js');
const TEST_HOME = join(tmpdir(), 'taskbean-chronicle-test-' + Date.now());

function fixtureHome(name) {
  const home = join(TEST_HOME, name);
  mkdirSync(home, { recursive: true });
  return home;
}

function copilotPath(home, ...parts) {
  return join(home, '.copilot', ...parts);
}

function createSessionStore(home, opts = {}) {
  const dbPath = copilotPath(home, 'session-store.db');
  mkdirSync(copilotPath(home), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE schema_version (version INTEGER);
    INSERT INTO schema_version VALUES (7);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      repository TEXT,
      host_type TEXT,
      branch TEXT,
      summary TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      turn_index INTEGER,
      user_message TEXT,
      assistant_response TEXT,
      timestamp TEXT
    );
    CREATE TABLE checkpoints (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      checkpoint_number INTEGER,
      title TEXT,
      overview TEXT,
      history TEXT,
      work_done TEXT,
      technical_details TEXT,
      important_files TEXT,
      next_steps TEXT,
      created_at TEXT
    );
    CREATE TABLE session_files (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      file_path TEXT,
      tool_name TEXT,
      turn_index INTEGER,
      first_seen_at TEXT
    );
    CREATE TABLE session_refs (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      ref_type TEXT,
      ref_value TEXT,
      turn_index INTEGER,
      created_at TEXT
    );
    CREATE TABLE forge_trajectory_events (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      tool_call_id TEXT,
      turn_index INTEGER,
      event_type TEXT,
      command TEXT,
      output TEXT,
      exit_code INTEGER,
      event_key TEXT,
      event_value TEXT,
      created_at TEXT
    );
    INSERT INTO turns (
      session_id, turn_index, user_message, assistant_response, timestamp
    ) VALUES (
      's1', 1, 'DO-NOT-EXPORT-USER-PROMPT', 'DO-NOT-EXPORT-ASSISTANT-RESPONSE', '2026-01-01T00:00:00Z'
    );
    INSERT INTO forge_trajectory_events (
      session_id, tool_call_id, turn_index, event_type, command, output, exit_code, event_key, event_value, created_at
    ) VALUES (
      's1', 'tool-1', 1, 'shell', 'echo private', 'DO-NOT-EXPORT-TOOL-OUTPUT', 0, 'stdout', 'DO-NOT-EXPORT-EVENT-VALUE', '2026-01-01T00:01:00Z'
    );
  `);
  if (opts.withSession) {
    db.exec(`
      INSERT INTO sessions (
        id, cwd, repository, host_type, branch, summary, created_at, updated_at
      ) VALUES (
        's1',
        'C:\\\\dev\\\\taskbean',
        'taskbean/taskbean',
        'copilot-cli',
        'chronicle-weekly-reviews-prd',
        'Implemented Chronicle reconciliation review inbox',
        '2026-01-01T10:00:00Z',
        '2026-01-01T11:00:00Z'
      );
      INSERT INTO session_files (
        session_id, file_path, tool_name, turn_index, first_seen_at
      ) VALUES
        ('s1', 'cli/src/commands/chronicle.js', 'edit', 1, '2026-01-01T10:15:00Z'),
        ('s1', 'cli/src/chronicle/reconcile.js', 'create', 1, '2026-01-01T10:20:00Z');
      INSERT INTO session_refs (
        session_id, ref_type, ref_value, turn_index, created_at
      ) VALUES
        ('s1', 'issue', '#40', 1, '2026-01-01T10:05:00Z'),
        ('s1', 'pr', '#41', 1, '2026-01-01T10:06:00Z');
      INSERT INTO checkpoints (
        session_id, checkpoint_number, title, overview, work_done, created_at
      ) VALUES (
        's1',
        1,
        'Chronicle reconciliation slice',
        'Created the review-only reconciliation path',
        'Persisted suggestions and evidence',
        '2026-01-01T11:00:00Z'
      );
    `);
  }
  db.close();
  return dbPath;
}

function beanJson(args, home) {
  const output = execFileSync(process.execPath, [BEAN, ...args, '--json'], {
    encoding: 'utf-8',
    cwd: TEST_HOME,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  }).trim();
  return JSON.parse(output);
}

function taskbeanDb(home) {
  return new DatabaseSync(join(home, '.taskbean', 'taskbean.db'));
}

describe('Chronicle capability adapter', () => {
  before(() => mkdirSync(TEST_HOME, { recursive: true }));
  after(() => {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  });

  it('reports missing when Copilot local session data is absent', () => {
    const home = fixtureHome('missing');
    const result = discoverChronicleCapabilities({ home });
    assert.equal(result.available, false);
    assert.equal(result.localSessionState.status, 'missing');
    assert.equal(result.localSessionStore.status, 'missing');
    assert.equal(result.privacy.storesRawMessages, false);
  });

  it('detects session-state without requiring session-store', () => {
    const home = fixtureHome('state-only');
    mkdirSync(copilotPath(home, 'session-state'), { recursive: true });
    const result = discoverChronicleCapabilities({ home });
    assert.equal(result.available, true);
    assert.equal(result.localSessionState.status, 'available');
    assert.equal(result.localSessionStore.status, 'missing');
  });

  it('discovers session-store metadata schema without retaining raw text', () => {
    const home = fixtureHome('store');
    createSessionStore(home);
    const result = discoverChronicleCapabilities({ home });
    assert.equal(result.available, true);
    assert.equal(result.localSessionStore.status, 'available');
    assert.equal(result.localSessionStore.schemaVersion, 7);
    assert.equal(result.localSessionStore.tables.sessions.present, true);
    assert.equal(result.localSessionStore.tables.turns.present, true);
    assert.deepEqual(
      result.localSessionStore.rawMessageColumns,
      ['user_message', 'assistant_response']
    );
    assert.equal(result.localSessionStore.rawMessageColumnsIgnored, true);
    assert.equal(result.privacy.storesRawMessages, false);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('DO-NOT-EXPORT-USER-PROMPT'), false);
    assert.equal(serialized.includes('DO-NOT-EXPORT-ASSISTANT-RESPONSE'), false);
  });

  it('reports malformed session-store errors without throwing', () => {
    const home = fixtureHome('malformed');
    mkdirSync(copilotPath(home), { recursive: true });
    writeFileSync(copilotPath(home, 'session-store.db'), 'not sqlite');
    const result = discoverChronicleCapabilities({ home });
    assert.equal(result.available, false);
    assert.equal(result.localSessionStore.status, 'error');
    assert.match(result.localSessionStore.error, /database|file|SQLite/i);
  });
});

describe('bean chronicle doctor', () => {
  it('prints deterministic JSON capability output', () => {
    const home = fixtureHome('cli');
    createSessionStore(home);
    const result = beanJson(['chronicle', 'doctor'], home);
    assert.equal(result.available, true);
    assert.equal(result.localSessionStore.status, 'available');
    assert.equal(result.localSessionStore.tables.sessions.present, true);
    assert.equal(result.chronicleSlashCommand.status, 'unknown');
    assert.equal(result.privacy.rawMessageColumnsIgnored, true);
  });
});

describe('bean chronicle reconcile', () => {
  it('returns unavailable JSON when local session-store is missing', () => {
    const home = fixtureHome('reconcile-missing');
    const result = beanJson([
      'chronicle', 'reconcile',
      '--since', '2026-01-01',
      '--until', '2026-01-02',
    ], home);
    assert.equal(result.available, false);
    assert.equal(result.counts.discovered, 0);
    assert.deepEqual(result.suggestions, []);
  });

  it('creates deterministic review-only suggestions without mutating todos', () => {
    const home = fixtureHome('reconcile-store');
    createSessionStore(home, { withSession: true });

    const first = beanJson([
      'chronicle', 'reconcile',
      '--since', '2026-01-01',
      '--until', '2026-01-02',
    ], home);

    assert.equal(first.available, true);
    assert.equal(first.counts.discovered, 1);
    assert.equal(first.counts.created, 1);
    assert.equal(first.counts.updated, 0);
    assert.equal(first.counts.pending, 1);
    assert.equal(first.suggestions.length, 1);
    assert.equal(first.suggestions[0].state, 'pending');
    assert.equal(first.suggestions[0].suggested_title, 'Implemented Chronicle reconciliation review inbox');
    assert.equal(first.suggestions[0].suggested_project, 'taskbean');
    assert.equal(first.suggestions[0].source_session_ids[0], 'copilot-session-store:s1');
    assert.match(first.suggestions[0].evidence_summary, /issue #40/);
    assert.match(first.suggestions[0].evidence_summary, /PR #41/);
    assert.equal(JSON.stringify(first).includes('DO-NOT-EXPORT'), false);

    const db = taskbeanDb(home);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM todos').get().c, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM reconciliation_suggestions').get().c, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM task_evidence').get().c, 1);
      const persisted = JSON.stringify({
        suggestions: db.prepare('SELECT * FROM reconciliation_suggestions').all(),
        evidence: db.prepare('SELECT * FROM task_evidence').all(),
      });
      assert.equal(persisted.includes('DO-NOT-EXPORT-USER-PROMPT'), false);
      assert.equal(persisted.includes('DO-NOT-EXPORT-ASSISTANT-RESPONSE'), false);
      assert.equal(persisted.includes('DO-NOT-EXPORT-TOOL-OUTPUT'), false);
    } finally {
      db.close();
    }

    const second = beanJson([
      'chronicle', 'reconcile',
      '--since', '2026-01-01',
      '--until', '2026-01-02',
    ], home);

    assert.equal(second.counts.discovered, 1);
    assert.equal(second.counts.created, 0);
    assert.equal(second.counts.updated, 0);
    assert.equal(second.suggestions.length, 1);

    const after = taskbeanDb(home);
    try {
      assert.equal(after.prepare('SELECT COUNT(*) AS c FROM reconciliation_suggestions').get().c, 1);
      assert.equal(after.prepare('SELECT COUNT(*) AS c FROM task_evidence').get().c, 1);
      assert.equal(after.prepare('SELECT COUNT(*) AS c FROM todos').get().c, 0);
    } finally {
      after.close();
    }
  });

  it('handles malformed session-store without failing reconciliation', () => {
    const home = fixtureHome('reconcile-malformed');
    mkdirSync(copilotPath(home), { recursive: true });
    writeFileSync(copilotPath(home, 'session-store.db'), 'not sqlite');

    const result = beanJson([
      'chronicle', 'reconcile',
      '--since', '2026-01-01',
      '--until', '2026-01-02',
    ], home);

    assert.equal(result.available, false);
    assert.deepEqual(result.suggestions, []);
    assert.equal(result.counts.discovered, 0);
  });

  it('tolerates partial optional session-store tables', () => {
    const home = fixtureHome('reconcile-partial');
    const dbPath = copilotPath(home, 'session-store.db');
    mkdirSync(copilotPath(home), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        created_at TEXT
      );
      CREATE TABLE session_refs (
        session_id TEXT,
        value TEXT
      );
      INSERT INTO sessions (
        id, cwd, created_at
      ) VALUES (
        'partial-s1', 'C:\\\\dev\\\\taskbean', '2026-01-01T10:00:00Z'
      );
      INSERT INTO session_refs (session_id, value) VALUES ('partial-s1', '#40');
    `);
    db.close();

    const result = beanJson([
      'chronicle', 'reconcile',
      '--since', '2026-01-01',
      '--until', '2026-01-02',
    ], home);

    assert.equal(result.available, true);
    assert.equal(result.counts.discovered, 1);
    assert.equal(result.suggestions.length, 1);
  });
});
