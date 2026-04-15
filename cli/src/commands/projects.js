import { allRows } from '../data/store.js';

export function projectsCommand(opts) {
  const projects = allRows(`
    SELECT p.*,
      (SELECT COUNT(*) FROM todos t WHERE t.project = p.name) as total_tasks,
      (SELECT COUNT(*) FROM todos t WHERE t.project = p.name AND t.completed = 1) as done_tasks,
      (SELECT COUNT(*) FROM todos t WHERE t.project = p.name AND t.completed = 0) as pending_tasks
    FROM projects p
    WHERE p.tracked = 1
    ORDER BY p.created_at DESC
  `);

  if (opts.json) {
    console.log(JSON.stringify(projects));
    return;
  }

  if (projects.length === 0) {
    console.log('No projects tracked yet.');
    return;
  }

  console.log('Projects:\n');
  for (const p of projects) {
    console.log(`  📁 ${p.name}`);
    console.log(`     ${p.path}`);
    console.log(`     ${p.done_tasks}/${p.total_tasks} done, ${p.active_tasks} active, ${p.pending_tasks} pending\n`);
  }
}
