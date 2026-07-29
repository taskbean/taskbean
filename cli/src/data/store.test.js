import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_HOME = join(tmpdir(), `taskbean-store-${Date.now()}`);
const DB_PATH = join(TEST_HOME, 'taskbean.db');
mkdirSync(TEST_HOME, { recursive: true });

const legacyDb = new DatabaseSync(DB_PATH);
legacyDb.exec(`
  CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    native_id TEXT NOT NULL,
    cwd TEXT,
    project_id TEXT,
    title TEXT,
    model TEXT,
    provider TEXT,
    cli_version TEXT,
    git_branch TEXT,
    source_path TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    UNIQUE (agent, native_id)
  );
  INSERT INTO agent_sessions (
    id, agent, native_id, source_path, started_at, updated_at, ingested_at
  ) VALUES (
    'copilot:legacy', 'copilot', 'legacy', 'events.jsonl',
    '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z'
  );
`);
legacyDb.close();

process.env.TASKBEAN_HOME = TEST_HOME;
process.env.TASKBEAN_DB = DB_PATH;

const { closeDb, getDb } = await import('./store.js');

after(() => {
  closeDb();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('agent_sessions migration adds nullable repository without losing rows', () => {
  const db = getDb();
  const columns = db.prepare("PRAGMA table_info('agent_sessions')").all();
  assert.ok(columns.some((column) => column.name === 'repository'));

  const row = db.prepare(
    "SELECT native_id, repository FROM agent_sessions WHERE id = 'copilot:legacy'"
  ).get();
  assert.equal(row.native_id, 'legacy');
  assert.equal(row.repository, null);
});
