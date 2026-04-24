import { getRow, run } from '../data/store.js';
import { resolveProject } from '../data/project.js';
import { resolveTask } from '../data/resolve-task.js';

export function editCommand(id, opts) {
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

  const sets = [];
  const params = [];

  if (opts.title) {
    sets.push('title = ?');
    params.push(opts.title);
  }
  if (opts.priority) {
    sets.push('priority = ?');
    params.push(opts.priority);
  }
  if (opts.notes !== undefined) {
    sets.push('notes = ?');
    params.push(opts.notes || null);
  }
  if (opts.dueDate !== undefined) {
    sets.push('due_date = ?');
    params.push(opts.dueDate || null);
  }
  if (opts.tags) {
    sets.push('tags = ?');
    params.push(JSON.stringify(opts.tags.split(',')));
  }

  if (sets.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'no_changes', message: 'No fields to update. Use --title, --priority, --notes, --due-date, or --tags.', code: 1 }));
    } else {
      console.error('❌ No fields to update. Use --title, --priority, --notes, --due-date, or --tags.');
    }
    process.exitCode = 1;
    return;
  }

  params.push(task.id);
  run(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`, params);

  const updated = getRow('SELECT * FROM todos WHERE id = ?', [task.id]);
  if (opts.json) {
    console.log(JSON.stringify(updated));
  } else {
    console.log(`✏️  Updated: ${updated.title}`);
  }
}
