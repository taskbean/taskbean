import { randomUUID } from 'crypto';
import { getRow, run, ensureProject } from '../data/store.js';
import { resolveProject } from '../data/project.js';
import { parseDate } from '../data/parse-date.js';

export function remindCommand(title, when, opts) {
  const project = resolveProject(opts.project);
  ensureProject(project.path, project.name);

  const remindAt = parseDate(when);
  if (!remindAt) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'invalid_date', message: `Could not parse date: ${when}`, code: 1 }));
    } else {
      console.error(`❌ Could not parse date: ${when}`);
    }
    process.exitCode = 1;
    return;
  }

  const id = randomUUID();
  run(
    `INSERT INTO todos (id, title, completed, source, priority, tags, project, project_path,
                        reminder, remind_at, status, created_at)
     VALUES (?, ?, 0, 'manual', 'none', '[]', ?, ?, 1, ?, 'pending', ?)`,
    [id, title, project.name, project.path, remindAt, new Date().toISOString()]
  );

  const task = getRow('SELECT * FROM todos WHERE id = ?', [id]);
  if (opts.json) {
    console.log(JSON.stringify(task));
  } else {
    console.log(`⏰ Reminder set: ${title} (${remindAt})`);
  }
}
