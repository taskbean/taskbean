import { allRows } from '../data/store.js';
import { resolveProject } from '../data/project.js';

function getDateRange(range) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = today.toISOString().split('T')[0];

  switch (range) {
    case 'yesterday': {
      const y = new Date(today); y.setDate(y.getDate() - 1);
      const yStr = y.toISOString().split('T')[0];
      return { since: yStr, until: yStr, label: 'Yesterday' };
    }
    case 'week': {
      const w = new Date(today); w.setDate(w.getDate() - 7);
      return { since: w.toISOString().split('T')[0], until: todayStr, label: 'This Week' };
    }
    case 'all':
      return { since: '1970-01-01', until: '2099-12-31', label: 'All Time' };
    case 'today':
    default:
      return { since: todayStr, until: todayStr, label: 'Today' };
  }
}

export function reportCommand(opts) {
  const { since, until, label } = getDateRange(opts.date);

  let projectFilter = '';
  let params = [since, until];

  if (opts.project) {
    const project = resolveProject(opts.project);
    projectFilter = 'AND project = ?';
    params.push(project.name);
  }

  const tasks = allRows(`
    SELECT * FROM todos
    WHERE date(created_at) BETWEEN ? AND ?
    ${projectFilter}
    ORDER BY project, completed, created_at
  `, params);

  // --format json
  if (opts.format === 'json') {
    console.log(JSON.stringify({ period: label, since, until, tasks }, null, 2));
    return;
  }

  // --format csv
  if (opts.format === 'csv') {
    console.log('id,title,completed,project,source,created_at');
    for (const t of tasks) {
      const title = `"${t.title.replace(/"/g, '""')}"`;
      console.log(`${t.id},${title},${t.completed},${t.project || ''},${t.source},${t.created_at}`);
    }
    return;
  }

  // Default: markdown
  const byProject = {};
  for (const t of tasks) {
    const p = t.project || 'manual';
    if (!byProject[p]) byProject[p] = [];
    byProject[p].push(t);
  }

  const completed = tasks.filter(t => t.completed);
  const pending = tasks.filter(t => !t.completed);

  let md = `# 📋 taskbean report — ${label}\n\n`;
  md += `**Generated**: ${new Date().toLocaleString()}\n\n`;
  md += `## Summary\n`;
  md += `- **Completed**: ${completed.length}\n`;
  md += `- **Pending**: ${pending.length}\n`;
  md += `- **Total**: ${tasks.length}\n\n`;

  for (const [project, projectTasks] of Object.entries(byProject)) {
    md += `## 📁 ${project}\n\n`;

    const done = projectTasks.filter(t => t.completed);
    const pend = projectTasks.filter(t => !t.completed);

    if (done.length) {
      md += `### ✅ Completed\n`;
      md += `| Task | Source | Created |\n|------|--------|--------|\n`;
      for (const t of done) {
        md += `| ${t.title} | ${t.source} | ${t.created_at} |\n`;
      }
      md += '\n';
    }

    if (pend.length) {
      md += `### ⬚ Pending\n`;
      md += `| Task | Source | Created |\n|------|--------|--------|\n`;
      for (const t of pend) {
        md += `| ${t.title} | ${t.source} | ${t.created_at} |\n`;
      }
      md += '\n';
    }
  }

  if (tasks.length === 0) {
    md += `*No tasks found for this period.*\n`;
  }

  console.log(md);
}
