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

function createSessionStore(home) {
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
  `);
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
