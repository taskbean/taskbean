import { allRows } from '../data/store.js';
import { resolveProject } from '../data/project.js';

const AGENT_DISPLAY = {
  copilot: 'Copilot',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};
const AGENT_ORDER = ['copilot', 'claude-code', 'codex', 'opencode'];

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function collectUsage(since, until) {
  try {
    const enabled = allRows(
      'SELECT agent FROM agent_settings WHERE enabled = 1'
    ).map(r => r.agent);
    if (enabled.length === 0) return { byAgent: [], totals: zeroTotals() };

    const placeholders = enabled.map(() => '?').join(',');

    const turnStats = allRows(
      `SELECT agent,
              COUNT(*) AS turns,
              COUNT(DISTINCT session_id) AS sessions_with_turns,
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              COALESCE(SUM(total_tokens), 0) AS totalTokens,
              COALESCE(SUM(tool_calls), 0) AS toolCalls
         FROM agent_turns
        WHERE date(occurred_at) BETWEEN ? AND ?
          AND agent IN (${placeholders})
        GROUP BY agent`,
      [since, until, ...enabled]
    );

    const sessionStats = allRows(
      `SELECT agent, COUNT(*) AS sessions
         FROM agent_sessions
        WHERE date(started_at) BETWEEN ? AND ?
          AND agent IN (${placeholders})
        GROUP BY agent`,
      [since, until, ...enabled]
    );

    const byAgent = [];
    for (const agent of AGENT_ORDER) {
      if (!enabled.includes(agent)) continue;
      const t = turnStats.find(r => r.agent === agent);
      const s = sessionStats.find(r => r.agent === agent);
      const sessions = s ? Number(s.sessions) : 0;
      const turns = t ? Number(t.turns) : 0;
      if (sessions === 0 && turns === 0) continue;
      byAgent.push({
        agent,
        display: AGENT_DISPLAY[agent] || agent,
        sessions,
        turns,
        inputTokens: t ? Number(t.inputTokens) : 0,
        outputTokens: t ? Number(t.outputTokens) : 0,
        toolCalls: t ? Number(t.toolCalls) : 0,
        totalTokens: t ? Number(t.totalTokens) : 0,
      });
    }

    const totals = byAgent.reduce((acc, r) => {
      acc.sessions += r.sessions;
      acc.turns += r.turns;
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.toolCalls += r.toolCalls;
      acc.totalTokens += r.totalTokens;
      return acc;
    }, zeroTotals());

    return { byAgent, totals };
  } catch {
    return null;
  }
}

function zeroTotals() {
  return { sessions: 0, turns: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, totalTokens: 0 };
}

function renderUsageMd(usage) {
  let md = `## Usage\n`;
  if (!usage || usage.byAgent.length === 0) {
    md += `No coding agent activity in this period.\n\n`;
    return md;
  }
  md += `| Agent       | Sessions | Turns | Input tokens | Output tokens | Tool calls |\n`;
  md += `|-------------|---------:|------:|-------------:|--------------:|-----------:|\n`;
  for (const r of usage.byAgent) {
    md += `| ${r.display.padEnd(11)} | ${String(fmtNum(r.sessions)).padStart(8)} | ${String(fmtNum(r.turns)).padStart(5)} | ${String(fmtNum(r.inputTokens)).padStart(12)} | ${String(fmtNum(r.outputTokens)).padStart(13)} | ${String(fmtNum(r.toolCalls)).padStart(10)} |\n`;
  }
  md += '\n';
  return md;
}

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

  const usage = collectUsage(since, until);

  // --format json
  if (opts.format === 'json') {
    const payload = { period: label, since, until, tasks };
    if (usage) payload.usage = usage;
    console.log(JSON.stringify(payload, null, 2));
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
    md += `*No tasks found for this period.*\n\n`;
  }

  if (usage) {
    md += renderUsageMd(usage);
  }

  console.log(md);
}
