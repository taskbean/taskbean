import { run } from '../data/store.js';
import { resolveProject } from '../data/project.js';
import { resolveTask } from '../data/resolve-task.js';

export function removeCommand(id, opts) {
  const project = resolveProject(opts.project);
  const task = resolveTask(id, project.name);

  if (!task) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'not_found', message: `Task ${id} not found`, code: 1 }));
    } else {
      console.error(`❌ Task not found: ${id}`);
    }
    process.exitCode = 1;
    return;
  }

  run('DELETE FROM todos WHERE id = ?', [task.id]);

  if (opts.json) {
    console.log(JSON.stringify({ deleted: task.id, title: task.title }));
  } else {
    console.log(`🗑️  Removed: ${task.title}`);
  }
}
