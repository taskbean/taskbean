import { allRows } from '../data/store.js';
import { resolveProject } from '../data/project.js';

export function listCommand(opts) {
  let sql, params;

  if (opts.all) {
    sql = `SELECT * FROM todos WHERE (project IS NULL OR project NOT IN (SELECT name FROM projects WHERE hidden = 1))`;
    params = [];
  } else {
    const project = resolveProject(opts.project);
    sql = 'SELECT * FROM todos WHERE project = ?';
    params = [project.name];
  }

  if (opts.status) {
    sql += params.length ? ' AND' : ' WHERE';
    if (opts.status === 'done') {
      sql += ' completed = 1';
    } else if (opts.status === 'pending') {
      sql += " (status = 'pending' OR (status IS NULL AND completed = 0))";
    } else {
      // in_progress, blocked, or any future status value
      sql += ' status = ?';
      params.push(opts.status);
    }
  }

  sql += ' ORDER BY created_at DESC';
  const tasks = allRows(sql, params);

  // --count mode
  if (opts.count) {
    const done = tasks.filter(t => t.completed).length;
    const pending = tasks.filter(t => !t.completed).length;
    const counts = { done, pending, total: tasks.length };
    if (opts.json) {
      console.log(JSON.stringify(counts));
    } else {
      console.log(`🫘 ${counts.total} tasks: ${counts.done} done, ${counts.pending} pending`);
    }
    return;
  }

  // --by-project mode
  if (opts.byProject) {
    const byProject = {};
    for (const t of tasks) {
      const p = t.project || 'manual';
      if (!byProject[p]) byProject[p] = { total: 0, done: 0, pending: 0 };
      byProject[p].total++;
      if (t.completed) byProject[p].done++; else byProject[p].pending++;
    }
    if (opts.json) {
      console.log(JSON.stringify(byProject));
    } else {
      for (const [name, counts] of Object.entries(byProject)) {
        console.log(`  📁 ${name}`);
        console.log(`     ${counts.done}/${counts.total} done, ${counts.pending} pending\n`);
      }
    }
    return;
  }

  // Default: list tasks
  if (opts.json) {
    console.log(JSON.stringify(tasks));
    return;
  }

  if (tasks.length === 0) {
    console.log('No tasks found.');
    return;
  }

  const maxTitleLen = Math.min(60, Math.max(...tasks.map(t => t.title.length)));
  for (const t of tasks) {
    const icon = t.completed ? '✅' : '⬚';
    const title = t.title.length > 60 ? t.title.slice(0, 57) + '...' : t.title;
    const project = opts.all && t.project ? ` [${t.project}]` : '';
    console.log(`${icon} ${t.id.slice(0, 8)}  ${title.padEnd(maxTitleLen)}${project}`);
  }
}
