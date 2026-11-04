/**
 * `bean migrate-events` — Phase 5 migration tool.
 *
 * Synthesizes `task.add` (and optional state-change) events for todos that
 * exist in the global DB but predate `events.jsonl` (i.e., tasks created
 * before Phase 4 was deployed). Ordered by `created_at` to preserve
 * chronology.
 *
 * IDEMPOTENT: tasks whose id already appears in a `task.add` or `task.remind`
 * event are skipped. Safe to run multiple times.
 *
 * Workflow:
 *   1. `bean track`             — initialize project UUID + events.jsonl
 *   2. `bean migrate-events`    — backfill events for existing DB rows
 *   3. `bean rebuild --write`   — create/refresh tasks.db from events
 */

import { resolveProject } from '../data/project.js';
import { readEvents, appendEvents } from '../data/events.js';
import { tasksForProject } from '../data/project-tasks.js';
import { compareHistory, historyStatus, replayEvents } from './rebuild.js';

export async function migrateEventsCommand(opts) {
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

  // Collect task ids already present in events so we don't duplicate them.
  const events = await readEvents(project.path);
  replayEvents(events);
  const existingTaskIds = new Set(
    events
      .filter(e => e.payload && e.payload.taskId
               && (e.type === 'task.add' || e.type === 'task.remind'))
      .map(e => e.payload.taskId),
  );

  // Fetch all todos for this project, oldest first, so events are appended
  // in chronological order (replay is order-dependent).
  const todos = tasksForProject(project)
    .sort((left, right) => left.created_at.localeCompare(right.created_at));

  const missing = todos.filter(t => !existingTaskIds.has(t.id));
  let synthesized = 0;

  for (const todo of missing) {
    const isReminder = todo.reminder === 1;

    const synthesizedEvents = [{
      type: isReminder ? 'task.remind' : 'task.add',
      ts: todo.created_at,
      payload: {
        taskId: todo.id,
        title: todo.title,
        priority: todo.priority || 'none',
        upsertKey: todo.upsert_key,
        source: todo.source,
        sessionId: todo.session_id,
        agent: todo.agent,
        agentSessionId: todo.agent_session_id,
        emoji: todo.emoji,
        dueTime: todo.due_time,
        reminderFired: todo.reminder_fired,
        ...(isReminder && todo.remind_at ? { remindAt: todo.remind_at } : {}),
        synthetic: true,
      },
      actor: { agent: todo.agent || null, sessionId: todo.session_id || null },
    }];

    const fields = {};
    if (todo.notes != null) fields.notes = todo.notes;
    if (todo.due_date != null) fields.dueDate = todo.due_date;
    const tags = JSON.parse(todo.tags || '[]');
    if (tags.length) fields.tags = tags;
    if (Object.keys(fields).length) {
      synthesizedEvents.push({
        type: 'task.update',
        payload: { taskId: todo.id, fields, synthetic: true },
      });
    }

    // Synthesize a terminal state-change event if the task isn't pending.
    const status = todo.status || (todo.completed ? 'done' : 'pending');
    if (status === 'done' || todo.completed) {
      synthesizedEvents.push({
        type: 'task.complete',
        payload: { taskId: todo.id, synthetic: true },
      });
    }
    if (status === 'in_progress') {
      synthesizedEvents.push({
        type: 'task.start',
        payload: { taskId: todo.id, synthetic: true },
      });
    } else if (status === 'blocked') {
      synthesizedEvents.push({
        type: 'task.block',
        payload: { taskId: todo.id, synthetic: true },
      });
    }
    const written = appendEvents({
      projectPath: project.path,
      projectUuid: project.projectUuid,
      projectName: project.name,
    }, synthesizedEvents);
    if (!written) throw new Error(`Could not migrate events for task ${todo.id}; review the history before retrying`);
    synthesized += written.length;
  }

  // Migration synthesizes snapshots only for tasks without creation events.
  // Report other gaps instead of implying that they were repaired.
  const remaining = compareHistory(replayEvents(await readEvents(project.path)), todos);
  const complete = historyStatus(remaining) === 'in_sync';
  const result = {
    project: { name: project.name, path: project.path, uuid: project.projectUuid },
    todosInDb: todos.length,
    alreadyInEvents: existingTaskIds.size,
    migrated: missing.length,
    eventsSynthesized: synthesized,
    status: complete ? 'ok' : 'incomplete',
    ...(complete ? {} : {
      unreconstructed: {
        missingInReplay: remaining.missingInReplay,
        missingInLive: remaining.missingInLive,
        mismatched: remaining.mismatched.map(({ id, fields }) => ({ id, fields })),
      },
    }),
  };

  if (opts.json) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(`📋 ${todos.length} task(s) in DB — ${existingTaskIds.size} already in events`);
  if (missing.length === 0) {
    console.log('✅ Nothing to migrate — all current tasks have creation events.');
  } else {
    console.log(`✅ Migrated ${missing.length} task(s) (${synthesized} event(s) synthesized)`);
  }
  if (complete) {
    console.log(`\n💡 Run \`bean rebuild --json\` to review the project cache before rebuilding.`);
  } else {
    const gaps = result.unreconstructed;
    console.log(`⚠️  History still differs from the global ledger: ${gaps.mismatched.length} changed, `
      + `${gaps.missingInLive.length} removed, ${gaps.missingInReplay.length} missing task(s).`);
    console.log('   Taskbean does not invent missing history. `bean rebuild --write` will refuse.');
    console.log('   Review the history, ledger, and project cache before taking any recovery action.');
  }
}
