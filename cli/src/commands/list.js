import { allRows } from '../data/store.js';
import { resolveProject } from '../data/project.js';
import { allTasksFromProjectDb } from '../data/project-db.js';

const STATE_ICON = { done: '✅', in_progress: '🔄', blocked: '🚫', pending: '⬚' };

function stateOf(task) {
  if (task.completed || task.status === 'done') return 'done';
  if (task.status === 'in_progress' || task.status === 'blocked') return task.status;
  return 'pending';
}

function breakdown(tasks) {
  const c = { pending: 0, in_progress: 0, blocked: 0, done: 0 };
  for (const t of tasks) c[stateOf(t)]++;
  const open = c.pending + c.in_progress + c.blocked;
  return `${c.done} done, ${open} open (${c.pending} pending, ${c.in_progress} in progress, ${c.blocked} blocked)`;
}

export function listCommand(opts) {
  let sql, params;
  let tasks = null;

  if (opts.all) {
    sql = `SELECT * FROM todos WHERE (project IS NULL OR project NOT IN (SELECT name FROM projects WHERE hidden = 1))`;
    params = [];
  } else {
    const project = resolveProject(opts.project);
    tasks = allTasksFromProjectDb(project.path, { status: opts.status });
    sql = 'SELECT * FROM todos WHERE project = ?';
    params = [project.name];
  }

  if (tasks === null) {
    if (opts.status) {
      if (opts.status === 'done') {
        sql += ' AND completed = 1';
      } else if (opts.status === 'pending') {
        sql += " AND completed = 0 AND (status = 'pending' OR status IS NULL)";
      } else {
        sql += ' AND status = ?';
        params.push(opts.status);
      }
    }
    sql += ' ORDER BY created_at DESC';
    tasks = allRows(sql, params);
  }

  // --count mode (JSON keeps its {done, pending, total} shape; pending = all open)
  if (opts.count) {
    const done = tasks.filter(t => t.completed).length;
    const pending = tasks.filter(t => !t.completed).length;
    const counts = { done, pending, total: tasks.length };
    if (opts.json) {
      console.log(JSON.stringify(counts));
    } else {
      console.log(`🫘 ${counts.total} tasks: ${breakdown(tasks)}`);
    }
    return;
  }

  // --by-project mode
  if (opts.byProject) {
    const byProject = {};
    const grouped = {};
    for (const t of tasks) {
      const p = t.project || 'manual';
      if (!byProject[p]) { byProject[p] = { total: 0, done: 0, pending: 0 }; grouped[p] = []; }
      byProject[p].total++;
      grouped[p].push(t);
      if (t.completed) byProject[p].done++; else byProject[p].pending++;
    }
    if (opts.json) {
      console.log(JSON.stringify(byProject));
    } else {
      for (const [name, counts] of Object.entries(byProject)) {
        console.log(`  📁 ${name}`);
        console.log(`     ${counts.done}/${counts.total} done; ${breakdown(grouped[name]).replace(/^\d+ done, /, '')}\n`);
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
  const printTask = t => {
    const state = stateOf(t);
    const title = t.title.length > 60 ? t.title.slice(0, 57) + '...' : t.title;
    console.log(`${STATE_ICON[state]} ${t.id.slice(0, 8)}  ${title.padEnd(maxTitleLen)}  ${state.replace('_', ' ')}`);
    if (state === 'blocked') console.log(`             ↳ reason: ${t.notes ? t.notes.replace(/\s+/g, ' ') : 'no reason recorded'}`);
  };

  if (opts.all) {
    const groups = new Map();
    for (const t of tasks) {
      const key = t.project || '(no project)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    for (const [name, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`📁 ${name} — ${breakdown(group)}`);
      group.forEach(printTask);
      console.log('');
    }
  } else {
    tasks.forEach(printTask);
  }
  console.log(`Legend: ⬚ pending  🔄 in progress  🚫 blocked  ✅ done`);
}