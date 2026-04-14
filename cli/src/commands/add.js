import { randomUUID } from 'crypto';
import { getRow, run, allRows } from '../data/store.js';
import { resolveProject } from '../data/project.js';

export function addCommand(title, opts) {
  const project = resolveProject(opts.project);

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

  const id = randomUUID();
  run(
    `INSERT INTO todos (id, title, completed, source, priority, tags, project, upsert_key, created_at)
     VALUES (?, ?, 0, 'agent', 'none', '[]', ?, ?, ?)`,
    [id, title, project.name, opts.key || null, new Date().toISOString()]
  );

  const task = getRow('SELECT * FROM todos WHERE id = ?', [id]);
  if (opts.json) {
    console.log(JSON.stringify(task));
  } else {
    console.log(`✅ Added task ${id}: ${title}`);
  }
}
