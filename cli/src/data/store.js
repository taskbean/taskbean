import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DB_DIR = join(homedir(), '.taskbean');
const DB_PATH = join(DB_DIR, 'taskbean.db');

let _db = null;

export function getDb() {
  if (_db) return _db;

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');

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
  try { _db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_upsert ON todos(project, upsert_key)'); } catch {}

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

// Ensure a project exists (for skill-install tracking), return its id
export function ensureProject(projectPath, projectName) {
  const existing = getRow('SELECT id FROM projects WHERE path = ?', [projectPath]);
  if (existing) return existing.id;

  const id = projectPath.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase().slice(-60);
  run('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)', [id, projectName, projectPath]);
  return id;
}
