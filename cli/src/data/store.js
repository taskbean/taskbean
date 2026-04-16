import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const DB_DIR = process.env.TASKBEAN_HOME || join(homedir(), '.taskbean');
const DB_PATH = process.env.TASKBEAN_DB || join(DB_DIR, 'taskbean.db');

let _db = null;

export function getDb() {
  if (_db) return _db;

  // Ensure parent directory of the DB file exists
  const dbParent = dirname(DB_PATH);
  if (!existsSync(dbParent)) {
    mkdirSync(dbParent, { recursive: true });
  }

  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  _db.exec('PRAGMA busy_timeout = 5000');

  // Ensure todos table exists (same schema as the main PWA app)
  _db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      emoji TEXT,
      due_date TEXT,
      due_time TEXT,
      completed INTEGER DEFAULT 0,
      reminder INTEGER DEFAULT 0,
      remind_at TEXT,
      reminder_fired INTEGER DEFAULT 0,
      source TEXT DEFAULT 'manual',
      priority TEXT DEFAULT 'none',
      notes TEXT,
      tags TEXT DEFAULT '[]',
      project TEXT,
      upsert_key TEXT,
      created_at TEXT NOT NULL
    )
  `);
  // Add project/upsert_key columns if missing (migration for existing DBs)
  try { _db.exec('ALTER TABLE todos ADD COLUMN project TEXT'); } catch {}
  try { _db.exec('ALTER TABLE todos ADD COLUMN upsert_key TEXT'); } catch {}
  try { _db.exec('ALTER TABLE todos ADD COLUMN session_id TEXT'); } catch {}
  // Multi-agent attribution: which coding agent created the task and its native session id
  try { _db.exec('ALTER TABLE todos ADD COLUMN agent TEXT'); } catch {}
  try { _db.exec('ALTER TABLE todos ADD COLUMN agent_session_id TEXT'); } catch {}
  // Stable project identity: canonical path set at write-time. `project`
  // (the name) is not unique — two "app" repos would collide in backfill —
  // so the Python backfill prefers this column when present.
  try { _db.exec('ALTER TABLE todos ADD COLUMN project_path TEXT'); } catch {}
  try { _db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_upsert ON todos(project, upsert_key)'); } catch {}
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_todos_agent_session ON todos(agent, agent_session_id)'); } catch {}
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_todos_project_path ON todos(project_path)'); } catch {}

  // One-time backfill of project_path for existing rows where project name
  // resolves unambiguously to a single projects row. Leave NULL on collision.
  try {
    _db.exec(`
      UPDATE todos
         SET project_path = (
           SELECT p.path FROM projects p WHERE p.name = todos.project
         )
       WHERE project_path IS NULL
         AND project IS NOT NULL
         AND (SELECT COUNT(*) FROM projects p WHERE p.name = todos.project) = 1
    `);
  } catch {}

  // Keep projects table for skill-install tracking (CLI-only metadata)
  _db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      tracked INTEGER DEFAULT 0,
      skill_installed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  // ── Multi-agent usage tracking ──────────────────────────────────────────
  // One row per detected session across all coding agents (Copilot, Claude
  // Code, Codex, OpenCode). Written by the Python ingester and read by both
  // halves of taskbean.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
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
    )
  `);
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_agent_started ON agent_sessions(agent, started_at)'); } catch {}
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project_started ON agent_sessions(project_id, started_at)'); } catch {}
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON agent_sessions(cwd)'); } catch {}

  // One row per "turn" — an assistant response with usage attached.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS agent_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      agent TEXT NOT NULL,
      seq INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      model TEXT,
      provider TEXT,
      input_tokens INTEGER DEFAULT 0,
      cached_input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      tool_calls INTEGER DEFAULT 0,
      finish_reason TEXT,
      UNIQUE (session_id, seq)
    )
  `);
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_turns_agent_when ON agent_turns(agent, occurred_at)'); } catch {}
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_turns_model ON agent_turns(model)'); } catch {}

  // Bookkeeping for incremental, resumable ingestion. Forward-only: on first
  // scan of a new source, last_offset/last_mtime/last_native_id is pinned to
  // the current state so we never backfill old history.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sources (
      agent TEXT NOT NULL,
      source_path TEXT NOT NULL,
      last_offset INTEGER DEFAULT 0,
      last_mtime INTEGER DEFAULT 0,
      last_native_id TEXT,
      scanned_at TEXT NOT NULL,
      PRIMARY KEY (agent, source_path)
    )
  `);

  // Per-agent settings: { enabled, detected_at, last_active_at }.
  // Auto-populated on first detection; user can toggle enabled via Settings UI.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS agent_settings (
      agent TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      detected_at TEXT,
      last_active_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  return _db;
}

export function getDbPath() {
  return DB_PATH;
}

// Query helpers
export function allRows(sql, params = []) {
  const db = getDb();
  return db.prepare(sql).all(...params);
}

export function getRow(sql, params = []) {
  const db = getDb();
  return db.prepare(sql).get(...params) || null;
}

export function run(sql, params = []) {
  const db = getDb();
  return db.prepare(sql).run(...params);
}

// Ensure a project exists and is tracked (so PWA + backfill see it), return its id
export function ensureProject(projectPath, projectName) {
  const existing = getRow('SELECT id, tracked FROM projects WHERE path = ?', [projectPath]);
  if (existing) {
    if (!existing.tracked) {
      run('UPDATE projects SET tracked = 1 WHERE id = ?', [existing.id]);
    }
    return existing.id;
  }

  const id = projectPath.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase().slice(-60);
  run('INSERT INTO projects (id, name, path, tracked) VALUES (?, ?, ?, 1)', [id, projectName, projectPath]);
  return id;
}
