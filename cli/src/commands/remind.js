import { nanoid } from 'nanoid';
import { getDb, saveDb, ensureProject, getRow } from '../data/store.js';
import { resolveProject } from '../data/project.js';
import { parseDate } from '../data/parse-date.js';

export async function remindCommand(title, when, opts) {
  const db = await getDb();
  const project = resolveProject(opts.project);
  const projectId = ensureProject(db, project.path, project.name);

  const dueAt = parseDate(when);
  if (!dueAt) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'invalid_input', message: `Could not parse date: ${when}`, code: 1 }));
    } else {
      console.error(`❌ Could not parse date: ${when}`);
    }
    process.exitCode = 1;
    return;
  }

  const id = 't_' + nanoid(8);
  db.run(
    `INSERT INTO tasks (id, title, status, project_id, due_at) VALUES (?, ?, 'pending', ?, ?)`,
    [id, title, projectId, dueAt]
  );
  saveDb();

  const task = getRow(db, 'SELECT * FROM tasks WHERE id = ?', [id]);
  if (opts.json) {
    console.log(JSON.stringify(task));
  } else {
    console.log(`⏰ Reminder set: ${title} (due ${dueAt})`);
  }
}
