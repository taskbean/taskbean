import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DB_DIR = path.join(os.homedir(), '.taskbean');
const DB_PATH = path.join(DB_DIR, 'taskbean.db');

// Ensure directory exists
fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// ── Schema ────────────────────────────────────────────────────────────────

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
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recurring_templates (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    emoji TEXT,
    description TEXT,
    interval_min INTEGER NOT NULL,
    interval_ms INTEGER,
    active INTEGER DEFAULT 1,
    last_fired INTEGER
);

CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    tool_calls TEXT,
    tool_call_id TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_thread ON conversations(thread_id, created_at);

CREATE TABLE IF NOT EXISTS telemetry_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    data TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    schema TEXT,
    enabled INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
);
`);

// ── Migrations ────────────────────────────────────────────────────────────
// Add project + upsert_key columns for CLI agent integration
try { db.exec('ALTER TABLE todos ADD COLUMN project TEXT'); } catch {}
try { db.exec('ALTER TABLE todos ADD COLUMN upsert_key TEXT'); } catch {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_upsert ON todos(project, upsert_key)'); } catch {}

// ── Config helpers ────────────────────────────────────────────────────────

const _getConfig = db.prepare('SELECT value FROM config WHERE key = ?');
const _setConfig = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
const _getAllConfig = db.prepare('SELECT key, value FROM config');
const _deleteConfig = db.prepare('DELETE FROM config WHERE key = ?');

export function getConfig(key, defaultValue = undefined) {
    const row = _getConfig.get(key);
    if (!row) return defaultValue;
    try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setConfig(key, value) {
    _setConfig.run(key, JSON.stringify(value));
}

export function getAllConfig() {
    const rows = _getAllConfig.all();
    const result = {};
    for (const { key, value } of rows) {
        try { result[key] = JSON.parse(value); } catch { result[key] = value; }
    }
    return result;
}

// ── Todo helpers ──────────────────────────────────────────────────────────

const _getAllTodos = db.prepare('SELECT * FROM todos ORDER BY created_at DESC');
const _getTodoById = db.prepare('SELECT * FROM todos WHERE id = ?');
const _insertTodo = db.prepare(`
    INSERT INTO todos (id, title, emoji, due_date, due_time, completed, reminder, remind_at, reminder_fired, source, priority, notes, tags, project, upsert_key, created_at)
    VALUES (@id, @title, @emoji, @due_date, @due_time, @completed, @reminder, @remind_at, @reminder_fired, @source, @priority, @notes, @tags, @project, @upsert_key, @created_at)
`);
const _updateTodo = db.prepare(`
    UPDATE todos SET title=@title, emoji=@emoji, due_date=@due_date, due_time=@due_time,
    completed=@completed, reminder=@reminder, remind_at=@remind_at, reminder_fired=@reminder_fired,
    priority=@priority, notes=@notes, tags=@tags
    WHERE id=@id
`);
const _deleteTodo = db.prepare('DELETE FROM todos WHERE id = ?');

function rowToTodo(row) {
    if (!row) return null;
    return {
        ...row,
        completed: !!row.completed,
        reminder: !!row.reminder,
        reminderFired: !!row.reminder_fired,
        dueDate: row.due_date,
        dueTime: row.due_time,
        remindAt: row.remind_at,
        tags: JSON.parse(row.tags || '[]'),
        project: row.project || null,
        upsertKey: row.upsert_key || null,
        createdAt: row.created_at,
    };
}

function todoToRow(todo) {
    return {
        id: todo.id,
        title: todo.title,
        emoji: todo.emoji || null,
        due_date: todo.dueDate || null,
        due_time: todo.dueTime || null,
        completed: todo.completed ? 1 : 0,
        reminder: todo.reminder ? 1 : 0,
        remind_at: todo.remindAt || null,
        reminder_fired: todo.reminderFired ? 1 : 0,
        source: todo.source || 'manual',
        priority: todo.priority || 'none',
        notes: todo.notes || null,
        tags: JSON.stringify(todo.tags || []),
        project: todo.project || null,
        upsert_key: todo.upsertKey || null,
        created_at: todo.createdAt || new Date().toISOString(),
    };
}

export function dbGetAllTodos() {
    return _getAllTodos.all().map(rowToTodo);
}

export function dbGetTodo(id) {
    return rowToTodo(_getTodoById.get(id));
}

const _getTodoByUpsertKey = db.prepare('SELECT * FROM todos WHERE project = ? AND upsert_key = ?');
export function dbGetTodoByUpsertKey(project, upsertKey) {
    return rowToTodo(_getTodoByUpsertKey.get(project, upsertKey));
}

export function dbInsertTodo(todo) {
    _insertTodo.run(todoToRow(todo));
    return todo;
}

export function dbUpdateTodo(todo) {
    _updateTodo.run(todoToRow(todo));
    return todo;
}

export function dbDeleteTodo(id) {
    return _deleteTodo.run(id);
}

// ── Recurring template helpers ────────────────────────────────────────────

const _getAllTemplates = db.prepare('SELECT * FROM recurring_templates');
const _getTemplateById = db.prepare('SELECT * FROM recurring_templates WHERE id = ?');
const _insertTemplate = db.prepare(`
    INSERT INTO recurring_templates (id, title, emoji, description, interval_min, interval_ms, active, last_fired)
    VALUES (@id, @title, @emoji, @description, @interval_min, @interval_ms, @active, @last_fired)
`);
const _updateTemplate = db.prepare(`
    UPDATE recurring_templates SET title=@title, emoji=@emoji, description=@description,
    interval_min=@interval_min, interval_ms=@interval_ms, active=@active, last_fired=@last_fired
    WHERE id=@id
`);
const _deleteTemplate = db.prepare('DELETE FROM recurring_templates WHERE id = ?');

function rowToTemplate(row) {
    if (!row) return null;
    return {
        ...row,
        active: !!row.active,
        intervalMin: row.interval_min,
        intervalMs: row.interval_ms,
        lastFired: row.last_fired,
    };
}

function templateToRow(t) {
    return {
        id: t.id,
        title: t.title,
        emoji: t.emoji || null,
        description: t.description || null,
        interval_min: t.intervalMin || t.interval_min,
        interval_ms: t.intervalMs || (t.intervalMin || t.interval_min) * 60_000,
        active: t.active ? 1 : 0,
        last_fired: t.lastFired || t.last_fired || Date.now(),
    };
}

export function dbGetAllTemplates() {
    return _getAllTemplates.all().map(rowToTemplate);
}

export function dbGetTemplate(id) {
    return rowToTemplate(_getTemplateById.get(id));
}

export function dbInsertTemplate(t) {
    _insertTemplate.run(templateToRow(t));
}

export function dbUpdateTemplate(t) {
    _updateTemplate.run(templateToRow(t));
}

export function dbDeleteTemplate(id) {
    _deleteTemplate.run(id);
}

// ── Telemetry helpers ─────────────────────────────────────────────────────

const TELEMETRY_MAX = 10_000;
const _insertTelemetry = db.prepare('INSERT INTO telemetry_events (type, data, created_at) VALUES (?, ?, ?)');
const _trimTelemetry = db.prepare(`DELETE FROM telemetry_events WHERE id NOT IN (SELECT id FROM telemetry_events ORDER BY id DESC LIMIT ${TELEMETRY_MAX})`);
const _getTelemetryRecent = db.prepare('SELECT * FROM telemetry_events ORDER BY id DESC LIMIT ?');
const _clearTelemetry = db.prepare('DELETE FROM telemetry_events');

export function dbInsertTelemetryEvent(type, data) {
    _insertTelemetry.run(type, JSON.stringify(data), new Date().toISOString());
    // Periodically trim (every ~100 inserts to avoid overhead)
    if (Math.random() < 0.01) _trimTelemetry.run();
}

export function dbGetRecentTelemetry(limit = 50) {
    return _getTelemetryRecent.all(limit).reverse().map(row => ({
        ...JSON.parse(row.data || '{}'),
        type: row.type,
        ts: row.created_at,
        _id: row.id,
    }));
}

export function dbClearTelemetry() {
    _clearTelemetry.run();
}

// ── Conversation helpers ──────────────────────────────────────────────────

const _insertMessage = db.prepare(`
    INSERT INTO conversations (id, thread_id, role, content, tool_calls, tool_call_id, created_at)
    VALUES (@id, @thread_id, @role, @content, @tool_calls, @tool_call_id, @created_at)
`);
const _getThread = db.prepare('SELECT * FROM conversations WHERE thread_id = ? ORDER BY created_at ASC');
const _deleteThread = db.prepare('DELETE FROM conversations WHERE thread_id = ?');

export function dbSaveMessage({ id, threadId, role, content, toolCalls, toolCallId }) {
    _insertMessage.run({
        id,
        thread_id: threadId,
        role,
        content: content || null,
        tool_calls: toolCalls ? JSON.stringify(toolCalls) : null,
        tool_call_id: toolCallId || null,
        created_at: new Date().toISOString(),
    });
}

export function dbGetThread(threadId) {
    return _getThread.all(threadId).map(row => ({
        id: row.id,
        threadId: row.thread_id,
        role: row.role,
        content: row.content,
        toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
        toolCallId: row.tool_call_id || undefined,
        createdAt: row.created_at,
    }));
}

export function dbDeleteThread(threadId) {
    _deleteThread.run(threadId);
}

// ── Config migration from JSON file ───────────────────────────────────────

export function migrateJsonConfig(configPath) {
    if (!fs.existsSync(configPath)) return false;
    try {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const insertMany = db.transaction((entries) => {
            for (const [key, value] of entries) {
                setConfig(key, value);
            }
        });
        insertMany(Object.entries(data));
        // Rename old file to indicate migration
        fs.renameSync(configPath, configPath + '.migrated');
        console.log('📦 Migrated config from JSON to SQLite');
        return true;
    } catch (err) {
        console.warn('⚠ Config migration failed:', err.message);
        return false;
    }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────

process.on('exit', () => { try { db.close(); } catch {} });
process.on('SIGTERM', () => { try { db.close(); } catch {} });
process.on('SIGINT', () => { try { db.close(); } catch {} });

export { db, DB_PATH };
