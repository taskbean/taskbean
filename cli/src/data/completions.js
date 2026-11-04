// Delivery time for completed outcomes.
//
// Stored in its own table (todo_completions) instead of a todos column so that
// every existing `SELECT * FROM todos` JSON contract keeps its shape.
// A missing time stays unknown: older rows fall back to event history only
// when that history has a real, non-synthetic completion transition.
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { allRows, run } from './store.js';

export function recordCompletion(todoId, at = new Date().toISOString()) {
  run(
    `INSERT INTO todo_completions (todo_id, completed_at) VALUES (?, ?)
     ON CONFLICT (todo_id) DO UPDATE SET completed_at = excluded.completed_at`,
    [todoId, at]
  );
}

export function clearCompletion(todoId) {
  run('DELETE FROM todo_completions WHERE todo_id = ?', [todoId]);
}

function readHistory(projectPath, cache) {
  if (!projectPath) return null;
  if (cache.has(projectPath)) return cache.get(projectPath);
  let byTask = null;
  const file = resolve(projectPath, '.taskbean', 'events.jsonl');
  if (existsSync(file)) {
    byTask = new Map();
    try {
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        const taskId = event?.payload?.taskId;
        if (!taskId) continue;
        if (!byTask.has(taskId)) byTask.set(taskId, []);
        byTask.get(taskId).push(event);
      }
    } catch {
      byTask = null; // Malformed history is not evidence of a completion time.
    }
  }
  cache.set(projectPath, byTask);
  return byTask;
}

// Returns { at, reopenedAfter } from a task's own events, or null when the
// history has no real completion transition (synthetic migration events and
// completions written together with an approved Chronicle record do not count).
function completionFromHistory(events) {
  let completedAt = null;
  let lastReopenAt = null;
  let creationBatch = false;
  for (const event of events) {
    const payload = event.payload || {};
    if (event.type === 'task.add' || event.type === 'task.remind') {
      creationBatch = payload.source === 'chronicle';
      continue;
    }
    if (event.type === 'task.update') continue;
    if (event.type === 'task.reopen') {
      lastReopenAt = event.ts || lastReopenAt;
      completedAt = null;
      creationBatch = false;
      continue;
    }
    if (event.type === 'task.complete') {
      if (!payload.synthetic && !creationBatch && event.ts) completedAt = event.ts;
      creationBatch = false;
      continue;
    }
    creationBatch = false;
  }
  return { at: completedAt, lastReopenAt };
}

/**
 * Attach completion time to completed tasks without mutating the stored rows.
 * Returns Map<todoId, { completed_at: string|null, completion_source: 'recorded'|'event-history'|null }>.
 */
export function completionTimes(tasks) {
  const result = new Map();
  const done = tasks.filter(t => t.completed);
  if (!done.length) return result;
  const recorded = new Map(
    allRows(
      `SELECT todo_id, completed_at FROM todo_completions
        WHERE todo_id IN (${done.map(() => '?').join(',')})`,
      done.map(t => t.id)
    ).map(row => [row.todo_id, row.completed_at])
  );
  const historyCache = new Map();
  for (const task of done) {
    const history = readHistory(task.project_path, historyCache)?.get(task.id) || null;
    const derived = history ? completionFromHistory(history) : null;
    const rec = recorded.get(task.id);
    // A recorded time is stale if an older CLI reopened the task after it.
    const stale = rec && derived?.lastReopenAt && Date.parse(derived.lastReopenAt) > Date.parse(rec);
    if (rec && !stale) {
      result.set(task.id, { completed_at: rec, completion_source: 'recorded' });
    } else if (derived?.at) {
      result.set(task.id, { completed_at: derived.at, completion_source: 'event-history' });
    } else {
      result.set(task.id, { completed_at: null, completion_source: null });
    }
  }
  return result;
}
