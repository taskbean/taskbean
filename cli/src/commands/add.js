import { randomUUID } from 'crypto';
import { getRow, run, ensureProject, ensureProjectAlias } from '../data/store.js';
import { resolveProject } from '../data/project.js';
import { canonicalCwd, resolveAttribution } from '../data/attribution.js';
import { taskBelongsToProject } from '../data/project-tasks.js';
import { recordTaskCreation, recordTaskEvents } from '../data/task-events.js';

export function addCommand(title, opts) {
  const project = resolveProject(opts.project);
  // Register project so /api/projects, backfill joins, and the PWA see it.
  ensureProject(project.path, project.name);
  if (project.projectUuid) ensureProjectAlias(project.projectUuid, canonicalCwd(project.path));

  // Upsert via key if provided
  if (opts.key) {
    const existing = getRow(
      'SELECT * FROM todos WHERE project = ? AND upsert_key = ?',
      [project.name, opts.key]
    );
    if (existing) {
      if (!taskBelongsToProject(existing, project)) {
        const message = `Cannot use key "${opts.key}" in project "${project.name}": the existing task belongs to another or ambiguous project. Choose a different key.`;
        if (opts.json) console.log(JSON.stringify({ error: 'project_key_conflict', message, code: 1 }));
        else console.error(`[taskbean] ${message}`);
        process.exitCode = 1;
        return;
      }
      run('UPDATE todos SET title = ? WHERE id = ?', [title, existing.id]);
      const updated = getRow('SELECT * FROM todos WHERE id = ?', [existing.id]);
      recordTaskEvents(project, updated, [{
        type: 'task.update',
        payload: { taskId: updated.id, fields: { title }, upsertKey: opts.key },
      }]);
      if (opts.json) {
        console.log(JSON.stringify(updated));
      } else {
        console.log(`Updated task ${updated.id}: ${updated.title}`);
      }
      return;
    }
  }

  // Resolve the coding agent + native session id that created this task.
  const attribution = resolveAttribution({
    agent: opts.agent,
    sessionId: opts.sessionId,
    cwd: opts.project || process.cwd(),
    projectUuid: project.projectUuid,
  });
  const compositeSessionId = attribution.agent && attribution.nativeId
    ? `${attribution.agent}:${attribution.nativeId}`
    : null;

  const id = randomUUID();
  run(
    `INSERT INTO todos (id, title, completed, source, priority, tags, project, project_path, upsert_key,
                        session_id, agent, agent_session_id, status, created_at)
     VALUES (?, ?, 0, 'agent', 'none', '[]', ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      id, title, project.name, project.path, opts.key || null,
      opts.sessionId || attribution.nativeId || null,
      attribution.agent,
      compositeSessionId,
      new Date().toISOString(),
    ]
  );

  const task = getRow('SELECT * FROM todos WHERE id = ?', [id]);
  recordTaskCreation(project, task, { agent: attribution.agent, sessionId: attribution.nativeId });
  if (opts.json) {
    console.log(JSON.stringify(task));
  } else {
    console.log(`✅ Added task ${id}: ${title}`);
  }
}
