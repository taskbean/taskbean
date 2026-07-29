import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const EXPECTED_TABLES = [
  'sessions',
  'checkpoints',
  'session_files',
  'session_refs',
  'turns',
  'forge_trajectory_events',
];

const RAW_MESSAGE_COLUMNS = new Set(['user_message', 'assistant_response']);

function statusForPath(path, expectedType) {
  if (!existsSync(path)) {
    return { status: 'missing', path };
  }
  try {
    const stat = statSync(path);
    const ok = expectedType === 'directory' ? stat.isDirectory() : stat.isFile();
    return ok
      ? { status: 'available', path }
      : { status: 'error', path, error: `Expected ${expectedType}` };
  } catch (err) {
    return { status: 'error', path, error: err.message };
  }
}

function tableMap(db) {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  ).all();
  const all = rows.map(r => r.name);
  const out = {};
  for (const name of EXPECTED_TABLES) {
    if (!all.includes(name)) {
      out[name] = { present: false, columns: [] };
      continue;
    }
    const quoted = `"${String(name).replaceAll('"', '""')}"`;
    const columns = db.prepare(`PRAGMA table_info(${quoted})`).all().map(c => c.name);
    out[name] = { present: true, columns };
  }
  return { all, expected: out };
}

function readSchemaVersion(db, allTables) {
  if (!allTables.includes('schema_version')) return null;
  try {
    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
    return row?.version ?? null;
  } catch {
    return null;
  }
}

function openReadOnly(path) {
  return new DatabaseSync(path, { readOnly: true });
}

function discoverSessionStore(storePath) {
  const base = statusForPath(storePath, 'file');
  if (base.status !== 'available') {
    return {
      ...base,
      schemaVersion: null,
      tables: {},
      allTables: [],
      rawMessageColumns: [],
      rawMessageColumnsIgnored: true,
    };
  }

  let db;
  try {
    db = openReadOnly(storePath);
    const tables = tableMap(db);
    const schemaVersion = readSchemaVersion(db, tables.all);
    const turnsColumns = tables.expected.turns?.columns || [];
    const rawMessageColumns = turnsColumns.filter(c => RAW_MESSAGE_COLUMNS.has(c));
    const missing = EXPECTED_TABLES.filter(name => !tables.expected[name]?.present);
    return {
      status: 'available',
      path: storePath,
      schemaVersion,
      tables: tables.expected,
      allTables: tables.all,
      rawMessageColumns,
      rawMessageColumnsIgnored: true,
      missingExpectedTables: missing,
    };
  } catch (err) {
    return {
      status: 'error',
      path: storePath,
      error: err.message,
      schemaVersion: null,
      tables: {},
      allTables: [],
      rawMessageColumns: [],
      rawMessageColumnsIgnored: true,
    };
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
}

function buildLimitations(sessionState, sessionStore) {
  const limitations = [];
  if (sessionState.status !== 'available') {
    limitations.push('local session-state directory not available');
  }
  if (sessionStore.status !== 'available') {
    limitations.push('local session-store database not available');
  } else if (sessionStore.missingExpectedTables?.length) {
    limitations.push(`session-store missing expected tables: ${sessionStore.missingExpectedTables.join(', ')}`);
  }
  limitations.push('no supported non-interactive Chronicle slash-command API verified');
  limitations.push('remote sync and enterprise policy state cannot be determined from local files');
  return limitations;
}

export function discoverChronicleCapabilities(opts = {}) {
  const home = opts.home || homedir();
  const copilotDir = opts.copilotDir || join(home, '.copilot');
  const sessionStatePath = opts.sessionStatePath || join(copilotDir, 'session-state');
  const sessionStorePath = opts.sessionStorePath || join(copilotDir, 'session-store.db');

  const localSessionState = statusForPath(sessionStatePath, 'directory');
  const localSessionStore = discoverSessionStore(sessionStorePath);
  const available = localSessionState.status === 'available'
    || localSessionStore.status === 'available';

  return {
    available,
    localSessionState,
    localSessionStore,
    chronicleSlashCommand: {
      status: 'unknown',
      reason: 'No supported non-interactive API verified',
    },
    remoteSync: {
      status: 'unknown',
      reason: 'Remote sync and enterprise policy state are not exposed by local session metadata',
    },
    privacy: {
      localOnly: true,
      storesRawMessages: false,
      rawMessageColumnsIgnored: true,
      ignoredColumns: ['turns.user_message', 'turns.assistant_response'],
    },
    limitations: buildLimitations(localSessionState, localSessionStore),
  };
}

