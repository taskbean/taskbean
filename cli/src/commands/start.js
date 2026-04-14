import { getDb, saveDb, getRow, ensureProject } from '../data/store.js';
import { resolveProject } from '../data/project.js';
import { resolveTask } from '../data/resolve-task.js';

export async function startCommand(id, opts) {
  const db = await getDb();
  const project = resolveProject(opts.project);
  const projectId = ensureProject(db, project.path, project.name);
  const task = resolveTask(db, id, projectId);

  if (!task) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'not_found', message: `Task ${id} not found`, code: 1 }));
    } else {
      console.error(`❌ Task not found: ${id}`);
    }
    process.exitCode = 1;
    return;
  }

  // Idempotent: already in_progress → no-op success
  if (task.status === 'in_progress') {
    if (opts.json) {
      console.log(JSON.stringify(task));
    } else {
      console.log(`🔄 Already in progress: ${task.title}`);
    }
    return;
  }

  db.run(
    `UPDATE tasks SET status = 'in_progress', updated_at = datetime('now', 'localtime') WHERE id = ?`,
    [task.id]
  );
  saveDb();

  const updated = getRow(db, 'SELECT * FROM tasks WHERE id = ?', [task.id]);
  if (opts.json) {
    console.log(JSON.stringify(updated));
  } else {
    console.log(`🔄 Started: ${updated.title}`);
  }
}
