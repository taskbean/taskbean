import { getDb, allRows } from '../data/store.js';
import { resolveProject } from '../data/project.js';

export async function exportCommand(opts) {
  const db = await getDb();

  let sql = `SELECT t.*, p.name as project_name, p.path as project_path FROM tasks t
             JOIN projects p ON t.project_id = p.id`;
  let params = [];

  if (opts.project) {
    const project = resolveProject(opts.project);
    sql += ' WHERE p.path = ?';
    params.push(project.path);
  }

  sql += ' ORDER BY p.name, t.created_at DESC';
  const tasks = allRows(db, sql, params);

  switch (opts.format) {
    case 'json':
      console.log(JSON.stringify(tasks, null, 2));
      break;

    case 'csv': {
      console.log('id,title,status,project,created_at,completed_at');
      for (const t of tasks) {
        const title = `"${t.title.replace(/"/g, '""')}"`;
        console.log(`${t.id},${title},${t.status},${t.project_name},${t.created_at},${t.completed_at || ''}`);
      }
      break;
    }

    case 'md':
    default: {
      const byProject = {};
      for (const t of tasks) {
        if (!byProject[t.project_name]) byProject[t.project_name] = [];
        byProject[t.project_name].push(t);
      }

      let md = `# taskbean export\n\n`;
      for (const [project, projectTasks] of Object.entries(byProject)) {
        md += `## ${project}\n\n`;
        md += `| ID | Task | Status | Created | Completed |\n`;
        md += `|----|------|--------|---------|----------|\n`;
        for (const t of projectTasks) {
          md += `| ${t.id} | ${t.title} | ${t.status} | ${t.created_at} | ${t.completed_at || '—'} |\n`;
        }
        md += '\n';
      }
      console.log(md);
      break;
    }
  }
}
