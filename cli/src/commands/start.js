import { getRow, run } from '../data/store.js';
import { resolveProject } from '../data/project.js';
import { resolveTask } from '../data/resolve-task.js';

export function startCommand(id, opts) {
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

  if (task.status === 'in_progress') {
    if (opts.json) {
      console.log(JSON.stringify(task));
    } else {
      console.log(`🔄 Already in progress: ${task.title}`);
    }
    return;
  }

  run(
    `UPDATE todos SET status = 'in_progress' WHERE id = ?`,
    [task.id]
  );

  const updated = getRow('SELECT * FROM todos WHERE id = ?', [task.id]);
  if (opts.json) {
    console.log(JSON.stringify(updated));
  } else {
    console.log(`🔄 Started: ${updated.title}`);
  }
}
