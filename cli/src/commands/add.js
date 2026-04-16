import { randomUUID } from 'crypto';
import { getRow, run, allRows, ensureProject } from '../data/store.js';
import { resolveProject } from '../data/project.js';
import { resolveAttribution } from '../data/attribution.js';

export function addCommand(title, opts) {
  const project = resolveProject(opts.project);
  // Register project so /api/projects, backfill joins, and the PWA see it.
  ensureProject(project.path, project.name);

  // Upsert via key if provided
  if (opts.key) {
    const existing = getRow(
      'SELECT * FROM todos WHERE project = ? AND upsert_key = ?',
      [project.name, opts.key]
    );
    if (existing) {
      run('UPDATE todos SET title = ? WHERE id = ?', [title, existing.id]);
      const updated = getRow('SELECT * FROM todos WHERE id = ?', [existing.id]);
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
  });
  const compositeSessionId = attribution.agent && attribution.nativeId
    ? `${attribution.agent}:${attribution.nativeId}`
    : null;

  const id = randomUUID();
  run(
    `INSERT INTO todos (id, title, completed, source, priority, tags, project, project_path, upsert_key,
                        session_id, agent, agent_session_id, created_at)
     VALUES (?, ?, 0, 'agent', 'none', '[]', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, title, project.name, project.path, opts.key || null,
      opts.sessionId || attribution.nativeId || null,
      attribution.agent,
      compositeSessionId,
      new Date().toISOString(),
    ]
  );

  const task = getRow('SELECT * FROM todos WHERE id = ?', [id]);
  if (opts.json) {
    console.log(JSON.stringify(task));
  } else {
    console.log(`✅ Added task ${id}: ${title}`);
  }
}
