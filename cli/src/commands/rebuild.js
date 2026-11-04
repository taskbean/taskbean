/**
 * `bean rebuild` — Phase 4/5 events replay command.
 *
 * Phase 4 (read-only): replays `<repo>/.taskbean/events.jsonl` into an
 * in-memory state and reports parity with the live global SQLite DB. Use
 * this to verify replay correctness before committing to the Phase 5 flow.
 *
 * Phase 5 (--write): replays events and writes the result to
 * `<repo>/.taskbean/tasks.db` (the per-project derived cache). Registers
 * the DB path in the global `projects.tasks_db_path` column. Refuses when
 * history differs from the ledger or cache data would be overwritten.
 */

import { findProjectByPath, run } from '../data/store.js';
import { resolveProject } from '../data/project.js';
import { readEvents } from '../data/events.js';
import { allTasksFromProjectDb, createProjectDb, getProjectDbPath, openProjectDb } from '../data/project-db.js';
import { tasksForProject } from '../data/project-tasks.js';

/**
 * Replay events into an in-memory `{taskId → state}` map.
 * Pure function for testability.
 *
 * Throws on a future-version event so a stale CLI can't silently
 * mis-interpret a newer log. Unknown event types are skipped (forward-
 * compatible additions of new types are safe within the same major
 * version).
 */
export const REPLAY_SCHEMA_VERSION = 1;

export function replayEvents(events) {
  const tasks = new Map();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (typeof ev.v === 'number' && ev.v > REPLAY_SCHEMA_VERSION) {
      throw new Error(
        `events.jsonl contains v${ev.v} events; this CLI only understands `
        + `v${REPLAY_SCHEMA_VERSION}. Upgrade taskbean (\`bean upgrade\`) to `
        + `read this project's history.`
      );
    }
    const p = ev.payload || {};
    const id = p.taskId;
    switch (ev.type) {
      case 'task.add':
      case 'task.remind': {
        if (!id) break;
        tasks.set(id, {
          id,
          title: p.title || '',
          status: 'pending',
          completed: 0,
          priority: p.priority || 'none',
          notes: null,
          notesKnown: false,
          dueDate: null,
          dueDateKnown: false,
          tags: [],
          tagsKnown: false,
          remindAt: ev.type === 'task.remind' ? p.remindAt : null,
          reminder: ev.type === 'task.remind',
          source: p.source,
          upsertKey: p.upsertKey,
          agent: p.agent ?? ev.actor?.agent,
          sessionId: p.sessionId ?? ev.actor?.sessionId,
          agentSessionId: p.agentSessionId,
          emoji: p.emoji,
          dueTime: p.dueTime,
          reminderFired: p.reminderFired,
          createdAt: ev.ts,
        });
        break;
      }
      case 'task.update': {
        if (!id) break;
        const t = tasks.get(id);
        if (!t) break;
        const f = p.fields || {};
        if (f.title !== undefined) t.title = f.title;
        if (f.priority !== undefined) t.priority = f.priority;
        if (f.notes !== undefined) { t.notes = f.notes; t.notesKnown = true; }
        if (f.dueDate !== undefined) { t.dueDate = f.dueDate; t.dueDateKnown = true; }
        if (f.tags !== undefined) { t.tags = f.tags; t.tagsKnown = true; }
        break;
      }
      case 'task.start': {
        const t = tasks.get(id);
        if (t) t.status = 'in_progress';
        break;
      }
      case 'task.block': {
        const t = tasks.get(id);
        if (t) t.status = 'blocked';
        break;
      }
      case 'task.complete': {
        const t = tasks.get(id);
        if (t) { t.status = 'done'; t.completed = 1; }
        break;
      }
      case 'task.reopen': {
        const t = tasks.get(id);
        if (t) { t.status = 'pending'; t.completed = 0; }
        break;
      }
      case 'task.remove': {
        tasks.delete(id);
        break;
      }
      case 'project.track':
      default:
        // No state change, or unknown — silently skip.
        break;
    }
  }
  return tasks;
}

export async function rebuildCommand(opts) {
  const project = resolveProject(opts.project);
  if (!project.projectUuid) {
    const msg = 'Project is not tracked (no .taskbean/project.json). '
      + 'Run `bean track` first.';
    if (opts.json) {
      console.log(JSON.stringify({ error: 'untracked', message: msg, code: 1 }));
    } else {
      console.error(`❌ ${msg}`);
    }
    process.exitCode = 1;
    return;
  }

  const events = await readEvents(project.path);
  const replayed = replayEvents(events);

  const liveRows = tasksForProject(project);
  const drift = compareHistory(replayed, liveRows);
  const report = {
    project: { name: project.name, path: project.path, uuid: project.projectUuid },
    events: events.length,
    replayedTasks: replayed.size,
    liveTasks: liveRows.length,
    drift,
    status: historyStatus(drift),
    cache: compareCache(project, liveRows),
  };

  if (opts.write) {
    const refuse = (error, message, cache = report.cache) => {
      if (opts.json) {
        console.log(JSON.stringify({
          error, message, code: 1,
          project: report.project, drift: report.drift, cache,
        }));
      }
      console.error(`❌ ${message}`);
      process.exitCode = 1;
    };

    if (report.status === 'drift') {
      const msg = 'Event history differs from the global ledger, so replay could omit, resurrect, '
        + 'or revert tasks. The project cache was not changed. Review `bean rebuild --json` '
        + 'and back up the project files before taking any recovery action.';
      refuse('replay_unsafe', msg);
      return;
    }
    if (report.cache.status === 'unreadable') {
      refuse('cache_unsafe', 'The project cache could not be read, so it was not changed. '
        + 'Review `bean rebuild --json` and back up the project files before taking any recovery action.');
      return;
    }

    let result;
    try {
      result = await rebuildProjectDb(project, replayed, liveRows);
    } catch (error) {
      if (!(error instanceof UnsafeCacheError)) throw error;
      refuse('cache_unsafe', error.message, error.cache);
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify({
        status: 'rebuilt',
        source: 'events',
        historyStatus: report.status,
        tasks: result.tasks,
        dbPath: result.dbPath,
        project: { name: project.name, uuid: project.projectUuid },
      }));
    } else {
      console.log(`✅ Rebuilt ${result.tasks} task(s) from the event history → ${result.dbPath}`);
    }
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`📜 Events: ${report.events}`);
  console.log(`🧮 Replay state: ${report.replayedTasks} task(s)`);
  console.log(`💾 Live DB:      ${report.liveTasks} task(s)`);
  if (report.status === 'in_sync') {
    console.log('✅ in sync — replay matches DB');
  } else {
    console.log('⚠️  drift detected:');
    if (report.drift.missingInReplay.length) {
      console.log(`   ${report.drift.missingInReplay.length} in DB not in events`);
    }
    if (report.drift.missingInLive.length) {
      console.log(`   ${report.drift.missingInLive.length} in events not in DB`);
    }
    if (report.drift.mismatched.length) {
      console.log(`   ${report.drift.mismatched.length} field mismatches`);
    }
  }
  if (report.cache.status === 'stale') {
    const stale = report.cache.missing.length + report.cache.extra.length + report.cache.mismatched.length;
    console.log(`⚠️  project cache differs from the global ledger for ${stale} task(s)`);
  } else if (report.cache.status === 'in_sync') {
    console.log('✅ project cache matches the global ledger');
  } else if (report.cache.status === 'unreadable') {
    console.log(`⚠️  project cache could not be read: ${report.cache.error}`);
  }
}

export function historyStatus(drift) {
  return drift.missingInReplay.length === 0
    && drift.missingInLive.length === 0
    && drift.mismatched.length === 0 ? 'in_sync' : 'drift';
}

/** Compare replayed history with the global ledger rows for one project. */
export function compareHistory(replayed, liveRows) {
  const live = new Map(liveRows.map(row => [row.id, row]));
  const missingInReplay = [];
  const missingInLive = [];
  const mismatched = [];
  for (const [id, lt] of live) {
    const rt = replayed.get(id);
    if (!rt) { missingInReplay.push(id); continue; }
    const liveStatus = lt.status || (lt.completed ? 'done' : 'pending');
    const fields = [];
    if (rt.title !== lt.title) fields.push('title');
    if (rt.status !== liveStatus) fields.push('status');
    if ((rt.completed ? 1 : 0) !== lt.completed) fields.push('completed');
    if (rt.priority !== (lt.priority || 'none')) fields.push('priority');
    if (rt.notesKnown && rt.notes !== lt.notes) fields.push('notes');
    if (rt.dueDateKnown && rt.dueDate !== lt.due_date) fields.push('due_date');
    if (rt.tagsKnown) {
      let tags;
      try {
        tags = JSON.parse(lt.tags || '[]');
      } catch (error) {
        throw new Error(`Task ${id} has invalid tags; history was not rebuilt`, { cause: error });
      }
      if (!Array.isArray(tags)) throw new Error(`Task ${id} has invalid tags; history was not rebuilt`);
      if (JSON.stringify(rt.tags) !== JSON.stringify(tags)) fields.push('tags');
    }
    if ((rt.reminder ? 1 : 0) !== (lt.reminder ? 1 : 0)) fields.push('reminder');
    if (rt.reminder && rt.remindAt !== lt.remind_at) fields.push('remind_at');
    if (fields.length) {
      const { id, title, status, completed, priority } = lt;
      mismatched.push({ id, live: { id, title, status, completed, priority }, replay: rt, fields });
    }
  }
  for (const id of replayed.keys()) {
    if (!live.has(id)) missingInLive.push(id);
  }

  return { missingInReplay: missingInReplay.filter(Boolean), missingInLive, mismatched };
}

const CACHE_COLUMNS = [
  'id', 'title', 'emoji', 'due_date', 'due_time', 'completed', 'reminder', 'remind_at',
  'reminder_fired', 'source', 'priority', 'notes', 'tags', 'project', 'project_path',
  'upsert_key', 'session_id', 'agent', 'agent_session_id', 'status', 'created_at',
];
const CACHE_SUMMARY_FIELDS = [
  'title', 'status', 'completed', 'priority', 'notes', 'due_date', 'tags', 'reminder', 'remind_at',
];
const CACHE_FIELDS = [
  ...CACHE_SUMMARY_FIELDS,
  ...CACHE_COLUMNS.filter(field => field !== 'id' && !CACHE_SUMMARY_FIELDS.includes(field)),
];

function comparable(row, field) {
  switch (field) {
    case 'status': return row.completed && row.status === 'pending'
      ? 'done' : row.status || (row.completed ? 'done' : 'pending');
    case 'completed':
    case 'reminder':
    case 'reminder_fired': return row[field] ? 1 : 0;
    case 'priority': return row.priority || 'none';
    case 'tags': {
      try { return JSON.stringify(JSON.parse(row.tags || '[]')); } catch { return row.tags; }
    }
    default: return row[field] ?? null;
  }
}

function compareCacheRows(path, cacheRows, liveRows) {
  const cache = new Map(cacheRows.map(row => [row.id, row]));
  const live = new Set(liveRows.map(row => row.id));
  const missing = [];
  const mismatched = [];
  for (const row of liveRows) {
    const cached = cache.get(row.id);
    if (!cached) { missing.push(row.id); continue; }
    const fields = CACHE_FIELDS.filter(field => comparable(row, field) !== comparable(cached, field));
    fields.push(...Object.keys(cached).filter(field => !CACHE_COLUMNS.includes(field) && cached[field] != null));
    if (fields.length) mismatched.push({ id: row.id, fields });
  }
  const extra = cacheRows.filter(row => !live.has(row.id)).map(row => row.id);
  const status = missing.length || extra.length || mismatched.length ? 'stale' : 'in_sync';
  return { path, status, missing, extra, mismatched };
}

/** Compare the project cache (if any) with the global ledger rows. Read-only. */
export function compareCache(project, liveRows) {
  const path = getProjectDbPath(project.path);
  let cacheRows;
  try {
    cacheRows = allTasksFromProjectDb(project.path);
  } catch (error) {
    return { path, status: 'unreadable', error: error.message, missing: [], extra: [], mismatched: [] };
  }
  if (cacheRows === null) return { path, status: 'missing', missing: [], extra: [], mismatched: [] };
  return compareCacheRows(path, cacheRows, liveRows);
}

class UnsafeCacheError extends Error {
  constructor(cache) {
    super('Rebuilding would overwrite data in the project cache. The cache was not changed. '
      + 'Review `bean rebuild --json` and back up the project files before taking any recovery action.');
    this.cache = cache;
  }
}

/** Recheck the cache under its write lock before adding missing rows. */
function writeProjectCache(project, rows) {
  const registeredProject = findProjectByPath(project.path);
  const dbPath = getProjectDbPath(project.path);
  const db = openProjectDb(project.path) ?? createProjectDb(project.path);
  db.exec('BEGIN IMMEDIATE');
  try {
    const cache = compareCacheRows(dbPath, db.prepare('SELECT * FROM todos').all(), rows);
    if (cache.extra.length || cache.mismatched.length) throw new UnsafeCacheError(cache);
    if (cache.missing.length) {
      const missing = new Set(cache.missing);
      const stmt = db.prepare(`INSERT INTO todos (${CACHE_COLUMNS.join(', ')})
        VALUES (${CACHE_COLUMNS.map(() => '?').join(', ')})`);
      for (const row of rows) {
        if (missing.has(row.id)) stmt.run(...CACHE_COLUMNS.map(column => row[column] ?? null));
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
  if (registeredProject) run('UPDATE projects SET tasks_db_path = ? WHERE id = ?', [dbPath, registeredProject.id]);
  return { tasks: rows.length, dbPath };
}

/**
 * Core write path: replay events → write tasks.db.
 * Refuses history drift or conflicting cache-only data.
 *
 * @param {{ path: string, name: string, projectUuid: string }} project
 * @param {Map} [replayed] Pre-computed replay map (optional; re-reads events if absent).
 * @returns {Promise<{ tasks: number, dbPath: string }>}
 */
export async function rebuildProjectDb(project, replayed, liveRows = null) {
  if (!replayed) {
    const events = await readEvents(project.path);
    replayed = replayEvents(events);
  }

  if (!liveRows) liveRows = tasksForProject(project);
  if (historyStatus(compareHistory(replayed, liveRows)) === 'drift') {
    throw new Error('Event history differs from the global ledger; the project cache was not changed.');
  }
  const liveById = new Map(liveRows.map(row => [row.id, row]));
  const rows = [...replayed.values()].map(t => {
    const live = liveById.get(t.id);
    const agent = live ? live.agent : t.agent ?? null;
    const sessionId = live ? live.session_id : t.sessionId ?? null;
    return {
      id: t.id,
      title: t.title,
      emoji: live ? live.emoji : t.emoji ?? null,
      due_date: t.dueDateKnown ? t.dueDate : live?.due_date ?? null,
      due_time: live ? live.due_time : t.dueTime ?? null,
      completed: t.completed ? 1 : 0,
      reminder: t.reminder ? 1 : (live?.reminder ?? 0),
      remind_at: t.remindAt ?? live?.remind_at ?? null,
      reminder_fired: live ? live.reminder_fired : t.reminderFired ?? 0,
      source: live ? live.source : t.source ?? 'agent',
      priority: t.priority ?? 'none',
      notes: t.notesKnown ? t.notes : live?.notes ?? null,
      tags: t.tagsKnown ? JSON.stringify(t.tags) : live?.tags ?? '[]',
      project: live ? live.project : project.name,
      project_path: live ? live.project_path : project.path,
      upsert_key: live ? live.upsert_key : t.upsertKey ?? null,
      session_id: sessionId,
      agent,
      agent_session_id: live ? live.agent_session_id : t.agentSessionId ?? (agent && sessionId ? `${agent}:${sessionId}` : null),
      status: t.status || 'pending',
      created_at: live ? live.created_at : t.createdAt,
    };
  });
  return writeProjectCache(project, rows);
}
