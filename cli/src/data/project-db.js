/**
 * Per-project derived SQLite cache — Phase 5.
 *
 * `<repo>/.taskbean/tasks.db` is derived from `events.jsonl` via
 * `bean rebuild --write`. It is ALWAYS gitignored (the .gitignore entry is
 * written by events.js when the first event fires).
 *
 * Lifecycle:
 *   1. Created by `bean rebuild --write` (explicit, idempotent).
 *   2. Kept current by mutation write-through (add/done/edit/block/start/remove/remind).
 *   3. Read by `bean list` (including `--count`) when present.
 *   4. Rebuilt from scratch via `bean rebuild --write` on demand (e.g., schema upgrade).
 *   5. Its path is registered in `projects.tasks_db_path` by `bean rebuild`.
 *
 * The per-project DB contains ONLY the `todos` table — no agent_sessions,
 * project_aliases, etc. Those live exclusively in the global DB.
 *
 * Write-through is best-effort: if tasks.db does not exist yet, no cache
 * needs updating. Failures for an existing cache are reported on stderr.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { normalizeTaskStatus } from './store.js';

// projectPath → DatabaseSync instance
const _cache = new Map();

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Absolute path to the project's derived tasks DB.
 */
export function getProjectDbPath(projectPath) {
  return resolve(projectPath, '.taskbean', 'tasks.db');
}

/**
 * Whether the project DB file exists on disk.
 */
export function projectDbExists(projectPath) {
  return existsSync(getProjectDbPath(projectPath));
}

/**
 * Open the per-project DB. Returns null if the file doesn't exist yet
 * (i.e., `bean rebuild --write` hasn't been run). Use `createProjectDb`
 * when you specifically need to create it.
 */
export function openProjectDb(projectPath) {
  if (_cache.has(projectPath)) return _cache.get(projectPath);
  const dbPath = getProjectDbPath(projectPath);
  if (!existsSync(dbPath)) return null;
  return _open(projectPath, dbPath);
}

/**
 * Open (or create) the per-project DB. Creates the file + directory if needed.
 * Closes any stale cached connection first.
 * Only call this from `bean rebuild --write` and `bean migrate-events`.
 */
export function createProjectDb(projectPath) {
  const cached = _cache.get(projectPath);
  if (cached) {
    cached.close();
    _cache.delete(projectPath);
  }
  const dbPath = getProjectDbPath(projectPath);
  const dbParent = dirname(dbPath);
  if (!existsSync(dbParent)) mkdirSync(dbParent, { recursive: true });
  return _open(projectPath, dbPath, true);
}

/**
 * Close and evict a cached project DB connection. Safe to call even if
 * nothing was opened. Used by tests and graceful shutdown.
 */
export function closeProjectDb(projectPath) {
  const db = _cache.get(projectPath);
  if (!db) return;
  db.close();
  _cache.delete(projectPath);
}

// ── Mutation helpers (best-effort write-through) ───────────────────────────────

/**
 * Upsert a todos row into the project DB. No-op if the DB doesn't exist.
 *
 * @param {string} projectPath
 * @param {object} row - A full todos row (same shape as the global todos table).
 */
export function upsertTaskToProjectDb(projectPath, row) {
  try {
    const db = openProjectDb(projectPath);
    if (!db) return;
    db.prepare(`
      INSERT INTO todos (
        id, title, emoji, due_date, due_time, completed, reminder, remind_at,
        reminder_fired, source, priority, notes, tags, project, project_path,
        upsert_key, session_id, agent, agent_session_id, status, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        title          = excluded.title,
        emoji          = excluded.emoji,
        completed      = excluded.completed,
        status         = excluded.status,
        priority       = excluded.priority,
        notes          = excluded.notes,
        due_date       = excluded.due_date,
        due_time       = excluded.due_time,
        remind_at      = excluded.remind_at,
        reminder       = excluded.reminder,
        reminder_fired = excluded.reminder_fired,
        tags           = excluded.tags,
        upsert_key     = excluded.upsert_key,
        source         = excluded.source,
        project        = excluded.project,
        project_path   = excluded.project_path,
        session_id     = excluded.session_id,
        agent          = excluded.agent,
        agent_session_id = excluded.agent_session_id,
        created_at     = excluded.created_at
    `).run(
      row.id,
      row.title,
      row.emoji ?? null,
      row.due_date ?? null,
      row.due_time ?? null,
      row.completed ?? 0,
      row.reminder ?? 0,
      row.remind_at ?? null,
      row.reminder_fired ?? 0,
      row.source ?? 'agent',
      row.priority ?? 'none',
      row.notes ?? null,
      row.tags ?? '[]',
      row.project ?? null,
      row.project_path ?? null,
      row.upsert_key ?? null,
      row.session_id ?? null,
      row.agent ?? null,
      row.agent_session_id ?? null,
      row.status ?? (row.completed ? 'done' : 'pending'),
      row.created_at,
    );
  } catch (e) {
    console.error(`[taskbean] Project cache upsert failed; the global task was already saved: ${e.message}`);
  }
}

/**
 * Update specific column values for a task. Best-effort.
 *
 * @param {string} projectPath
 * @param {string} taskId
 * @param {object} fields - Partial todos columns to update, e.g. `{ status: 'done', completed: 1 }`.
 */
export function updateTaskInProjectDb(projectPath, taskId, fields) {
  try {
    const db = openProjectDb(projectPath);
    if (!db) return;
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      params.push(v);
    }
    if (sets.length === 0) return;
    params.push(taskId);
    db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  } catch (e) {
    console.error(`[taskbean] Project cache update failed; the global task was already saved: ${e.message}`);
  }
}

/**
 * Delete a task from the project DB. Best-effort.
 */
export function deleteTaskFromProjectDb(projectPath, taskId) {
  try {
    const db = openProjectDb(projectPath);
    if (!db) return;
    db.prepare('DELETE FROM todos WHERE id = ?').run(taskId);
  } catch (e) {
    console.error(`[taskbean] Project cache delete failed; the global task was already removed: ${e.message}`);
  }
}

// ── Query helper ───────────────────────────────────────────────────────────────

/**
 * Return all todos from the project DB, ordered by created_at DESC.
 * Returns null if the DB doesn't exist (caller falls back to global DB).
 *
 * @param {string} projectPath
 * @param {{ status?: string }} [opts]
 * @returns {object[] | null}
 */
export function allTasksFromProjectDb(projectPath, opts = {}) {
  const dbPath = getProjectDbPath(projectPath);
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    let sql = 'SELECT * FROM todos';
    const params = [];
    if (opts.status) {
      if (opts.status === 'done') {
        sql += ' WHERE completed = 1';
      } else if (opts.status === 'pending') {
        sql += " WHERE completed = 0 AND (status = 'pending' OR status IS NULL)";
      } else {
        sql += ' WHERE status = ?';
        params.push(opts.status);
      }
    }
    sql += ' ORDER BY created_at DESC';
    return db.prepare(sql).all(...params).map(normalizeTaskStatus);
  } catch (error) {
    throw new Error(`Could not read project cache ${dbPath}: ${error.message}`, { cause: error });
  } finally {
    db.close();
  }
}

// ── Private ────────────────────────────────────────────────────────────────────

function _open(projectPath, dbPath, initialize = false) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    if (initialize) _ensureProjectDbSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }
  _cache.set(projectPath, db);
  return db;
}

/**
 * Create the todos table in the project DB. Declares all columns in one shot
 * — no incremental migrations needed because the project DB is always
 * rebuilt from scratch via `bean rebuild --write` when the schema changes.
 */
function _ensureProjectDbSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id               TEXT PRIMARY KEY,
      title            TEXT NOT NULL,
      emoji            TEXT,
      due_date         TEXT,
      due_time         TEXT,
      completed        INTEGER DEFAULT 0,
      reminder         INTEGER DEFAULT 0,
      remind_at        TEXT,
      reminder_fired   INTEGER DEFAULT 0,
      source           TEXT DEFAULT 'manual',
      priority         TEXT DEFAULT 'none',
      notes            TEXT,
      tags             TEXT DEFAULT '[]',
      project          TEXT,
      project_path     TEXT,
      upsert_key       TEXT,
      session_id       TEXT,
      agent            TEXT,
      agent_session_id TEXT,
      status           TEXT DEFAULT 'pending',
      created_at       TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_pdb_status ON todos(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_pdb_project ON todos(project)');
}
