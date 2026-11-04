import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { detectHost } from './host.js';

export function resolveDbPaths(env = process.env, getHost = detectHost, home = homedir()) {
  if (env.TASKBEAN_DB) {
    return { dir: dirname(env.TASKBEAN_DB), path: env.TASKBEAN_DB, redirected: false };
  }
  if (env.TASKBEAN_HOME) {
    return { dir: env.TASKBEAN_HOME, path: join(env.TASKBEAN_HOME, 'taskbean.db'), redirected: false };
  }
  if (env.TASKBEAN_NO_WSL_REDIRECT === '1') {
    const dir = join(home, '.taskbean');
    return { dir, path: join(dir, 'taskbean.db'), redirected: false };
  }

  const host = getHost();
  if (host.isWSL && host.windowsTaskbeanFromWSL) {
    return {
      dir: host.windowsTaskbeanFromWSL,
      path: join(host.windowsTaskbeanFromWSL, 'taskbean.db'),
      redirected: true,
      windowsHome: host.windowsHomeFromWSL,
    };
  }
  const dir = join(home, '.taskbean');
  return { dir, path: join(dir, 'taskbean.db'), redirected: false };
}

const DB_LOCATION = resolveDbPaths();
const DB_PATH = DB_LOCATION.path;
let _db = null;

function maybeShowWslNotice() {
  if (!DB_LOCATION.redirected || process.env.TASKBEAN_QUIET === '1' || !process.stderr.isTTY) return;
  const marker = join(DB_LOCATION.dir, '.wsl-notice-shown');
  try {
    writeFileSync(marker, `${new Date().toISOString()}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return;
    console.error(`[taskbean] Could not save the WSL notice marker: ${error.message}`);
  }
  console.error(
    `taskbean: WSL is using ${DB_LOCATION.windowsHome || '<windows-home>'}/.taskbean/. ` +
    'Set TASKBEAN_NO_WSL_REDIRECT=1 to use the Linux home instead.'
  );
}

function addMissingColumns(db, table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

export function getDb() {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });

  const db = new DatabaseSync(DB_PATH);
  let inTransaction = false;
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;

    db.exec(`
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
        session_id TEXT,
        agent TEXT,
        agent_session_id TEXT,
        project_path TEXT,
        status TEXT DEFAULT 'pending',
        created_at TEXT NOT NULL
      )
    `);
    // Existing rows retain NULL status rather than being silently backfilled.
    addMissingColumns(db, 'todos', {
      project: 'TEXT',
      upsert_key: 'TEXT',
      session_id: 'TEXT',
      agent: 'TEXT',
      agent_session_id: 'TEXT',
      project_path: 'TEXT',
      status: 'TEXT',
    });

    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        tracked INTEGER DEFAULT 0,
        skill_installed INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        hidden INTEGER DEFAULT 0,
        category TEXT,
        project_uuid TEXT,
        tasks_db_path TEXT
      )
    `);
    addMissingColumns(db, 'projects', {
      hidden: 'INTEGER DEFAULT 0',
      category: 'TEXT DEFAULT NULL',
      project_uuid: 'TEXT',
      tasks_db_path: 'TEXT',
    });

    db.exec(`
      CREATE TABLE IF NOT EXISTS project_aliases (
        project_uuid TEXT NOT NULL,
        host TEXT,
        path TEXT NOT NULL,
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        PRIMARY KEY (project_uuid, path)
      );
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
        repository TEXT,
        source_path TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        UNIQUE (agent, native_id)
      );
    `);
    addMissingColumns(db, 'agent_sessions', { repository: 'TEXT' });

    db.exec(`
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
      );
      CREATE TABLE IF NOT EXISTS agent_sources (
        agent TEXT NOT NULL,
        source_path TEXT NOT NULL,
        last_offset INTEGER DEFAULT 0,
        last_mtime INTEGER DEFAULT 0,
        last_native_id TEXT,
        scanned_at TEXT NOT NULL,
        PRIMARY KEY (agent, source_path)
      );
      CREATE TABLE IF NOT EXISTS agent_settings (
        agent TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        detected_at TEXT,
        last_active_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS reconciliation_suggestions (
        id TEXT PRIMARY KEY,
        evidence_key TEXT NOT NULL UNIQUE,
        suggested_title TEXT NOT NULL,
        suggested_project TEXT,
        suggested_status TEXT DEFAULT 'pending',
        source_session_ids TEXT NOT NULL DEFAULT '[]',
        evidence_summary TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'pending',
        linked_todo_id TEXT REFERENCES todos(id) ON DELETE SET NULL,
        auto_linked INTEGER DEFAULT 0,
        decision_reason TEXT,
        decision_details TEXT,
        occurred_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT
      );
    `);
    addMissingColumns(db, 'reconciliation_suggestions', {
      occurred_at: 'TEXT',
      auto_linked: 'INTEGER DEFAULT 0',
      decision_reason: 'TEXT',
      decision_details: 'TEXT',
    });

    db.exec(`
      CREATE TABLE IF NOT EXISTS task_evidence (
        id TEXT PRIMARY KEY,
        todo_id TEXT REFERENCES todos(id) ON DELETE SET NULL,
        suggestion_id TEXT REFERENCES reconciliation_suggestions(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        repo TEXT,
        project_path TEXT,
        branch TEXT,
        pr_refs TEXT NOT NULL DEFAULT '[]',
        issue_refs TEXT NOT NULL DEFAULT '[]',
        commit_refs TEXT,
        files_changed TEXT NOT NULL DEFAULT '[]',
        summary TEXT,
        confidence REAL NOT NULL DEFAULT 0,
        occurred_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (source, source_session_id, suggestion_id)
      );
    `);
    addMissingColumns(db, 'task_evidence', { occurred_at: 'TEXT', commit_refs: 'TEXT' });

    db.exec(`
      CREATE TABLE IF NOT EXISTS todo_completions (
        todo_id TEXT PRIMARY KEY REFERENCES todos(id) ON DELETE CASCADE,
        completed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reconciliation_checkpoints (
        source TEXT PRIMARY KEY,
        last_changed_at TEXT,
        last_session_id TEXT,
        runs INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_upsert ON todos(project, upsert_key);
      CREATE INDEX IF NOT EXISTS idx_todos_agent_session ON todos(agent, agent_session_id);
      CREATE INDEX IF NOT EXISTS idx_todos_project_path ON todos(project_path);
      CREATE INDEX IF NOT EXISTS idx_projects_uuid ON projects(project_uuid);
      CREATE INDEX IF NOT EXISTS idx_aliases_path ON project_aliases(path);
      CREATE INDEX IF NOT EXISTS idx_sessions_agent_started ON agent_sessions(agent, started_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_project_started ON agent_sessions(project_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON agent_sessions(cwd);
      CREATE INDEX IF NOT EXISTS idx_turns_agent_when ON agent_turns(agent, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_turns_model ON agent_turns(model);
      CREATE INDEX IF NOT EXISTS idx_reconciliation_state_created ON reconciliation_suggestions(state, created_at);
      CREATE INDEX IF NOT EXISTS idx_reconciliation_state_occurred ON reconciliation_suggestions(state, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_reconciliation_updated ON reconciliation_suggestions(updated_at);
      CREATE INDEX IF NOT EXISTS idx_task_evidence_todo ON task_evidence(todo_id);
      CREATE INDEX IF NOT EXISTS idx_task_evidence_suggestion ON task_evidence(suggestion_id);
    `);

    db.exec('COMMIT');
    inTransaction = false;
    maybeShowWslNotice();
    _db = db;
    return db;
  } catch (error) {
    if (inTransaction) {
      try { db.exec('ROLLBACK'); } catch (rollbackError) {
        console.error(`[taskbean] Database initialization rollback failed: ${rollbackError.message}`);
      }
    }
    db.close();
    throw new Error(`Taskbean database initialization failed: ${error.message}`, { cause: error });
  }
}

export function getDbPath() {
  return DB_PATH;
}

export function closeDb() {
  if (!_db) return;
  _db.close();
  _db = null;
}

export function allRows(sql, params = []) {
  return getDb().prepare(sql).all(...params).map(normalizeTaskStatus);
}

export function getRow(sql, params = []) {
  return normalizeTaskStatus(getDb().prepare(sql).get(...params) || null);
}

export function normalizeTaskStatus(row) {
  if (!row || !Object.hasOwn(row, 'completed') || !Object.hasOwn(row, 'status')) return row;
  if (row.status == null || (row.completed && row.status === 'pending')) {
    row.status = row.completed ? 'done' : 'pending';
  }
  return row;
}

export function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}

export function ensureProject(projectPath, projectName) {
  const id = projectPath.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase().slice(-60);
  run('INSERT INTO projects (id, name, path, tracked) VALUES (?, ?, ?, 1) ON CONFLICT DO NOTHING',
    [id, projectName, projectPath]);
  const project = getRow('SELECT id, tracked FROM projects WHERE path = ?', [projectPath]);
  if (!project) {
    throw new Error(`Cannot register project ${projectPath}: its generated ID is already in use`);
  }
  if (!project.tracked) run('UPDATE projects SET tracked = 1 WHERE id = ?', [project.id]);
  return project.id;
}

export function ensureProjectAlias(projectUuid, projectPath, host = null) {
  run(`
    INSERT INTO project_aliases (project_uuid, host, path, last_seen_at)
    VALUES (?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT (project_uuid, path) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      host = COALESCE(excluded.host, host)
  `, [projectUuid, host, projectPath]);
}

export function getAliasPathsForUuid(projectUuid) {
  return allRows('SELECT path FROM project_aliases WHERE project_uuid = ?', [projectUuid])
    .map(row => row.path);
}
