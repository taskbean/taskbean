import { getDb, allRows, ensureProject } from '../data/store.js';
import { resolveProject } from '../data/project.js';

export async function countCommand(opts) {
  const db = await getDb();

  let where = '';
  let params = [];

  if (!opts.all) {
    const project = resolveProject(opts.project);
    const projectId = ensureProject(db, project.path, project.name);
    where = 'WHERE t.project_id = ?';
    params = [projectId];
  }

  const counts = {
    pending: 0,
    in_progress: 0,
    done: 0,
    blocked: 0,
    total: 0,
  };

  const rows = allRows(db,
    `SELECT t.status, COUNT(*) as count FROM tasks t ${where} GROUP BY t.status`,
    params
  );

  for (const r of rows) {
    counts[r.status] = r.count;
    counts.total += r.count;
  }

  if (opts.json) {
    console.log(JSON.stringify(counts));
    return;
  }

  console.log(`🫘 ${counts.total} tasks: ${counts.done} done, ${counts.in_progress} active, ${counts.pending} pending, ${counts.blocked} blocked`);
}
