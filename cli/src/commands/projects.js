import { getDb, allRows } from '../data/store.js';

export async function projectsCommand(opts) {
  const db = await getDb();

  const projects = allRows(db, `
    SELECT p.*, 
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) as total_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') as done_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'pending') as pending_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'in_progress') as active_tasks
    FROM projects p
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
