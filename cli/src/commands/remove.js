import { getDb, saveDb, ensureProject } from '../data/store.js';
import { resolveProject } from '../data/project.js';
import { resolveTask } from '../data/resolve-task.js';

export async function removeCommand(id, opts) {
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

  db.run('DELETE FROM tasks WHERE id = ?', [task.id]);
  saveDb();

  if (opts.json) {
    console.log(JSON.stringify({ deleted: task.id, title: task.title }));
  } else {
    console.log(`🗑️  Removed: ${task.title}`);
  }
}
