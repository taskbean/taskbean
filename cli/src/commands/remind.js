import { randomBytes } from 'crypto';
import { getDb, saveDb, ensureProject, getRow } from '../data/store.js';
import { resolveProject } from '../data/project.js';
import { parseDate } from '../data/parse-date.js';

function shortId() {
  // Match the previous nanoid(8) shape with URL-safe base64.
  return randomBytes(6).toString('base64url').slice(0, 8);
}

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

  const id = 't_' + shortId();
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
