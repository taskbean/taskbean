import { allRows } from '../data/store.js';
import { resolveProject } from '../data/project.js';
import { discoverChronicleCapabilities } from '../chronicle/adapter.js';

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

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function serializeEvidence(row) {
  return {
    id: row.id,
    todo_id: row.todo_id,
    suggestion_id: row.suggestion_id,
    source: row.source,
    source_session_id: row.source_session_id,
    repo: row.repo,
    project_path: row.project_path,
    branch: row.branch,
    pr_refs: parseJsonArray(row.pr_refs),
    issue_refs: parseJsonArray(row.issue_refs),
    files_changed: parseJsonArray(row.files_changed),
    summary: row.summary,
    confidence: Number(row.confidence),
    created_at: row.created_at,
  };
}

function serializeSuggestion(row) {
  return {
    id: row.id,
    evidence_key: row.evidence_key,
    suggested_title: row.suggested_title,
    suggested_project: row.suggested_project,
    suggested_status: row.suggested_status,
    source_session_ids: parseJsonArray(row.source_session_ids),
    evidence_summary: row.evidence_summary,
    confidence: Number(row.confidence),
    state: row.state,
    linked_todo_id: row.linked_todo_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    decided_at: row.decided_at,
  };
}

function groupTasks(tasks) {
  return {
    completed: tasks.filter(t => t.completed),
    in_progress: tasks.filter(t => !t.completed && t.status === 'in_progress'),
    blocked: tasks.filter(t => !t.completed && t.status === 'blocked'),
    pending: tasks.filter(t => !t.completed && (!t.status || t.status === 'pending')),
  };
}

function collectChronicleReport(since, until, tasks, scope = {}) {
  const capabilities = discoverChronicleCapabilities();
  const available = capabilities.localSessionStore.status === 'available';
  const taskIds = tasks.map(t => t.id);
  const evidenceRows = taskIds.length
    ? allRows(
      `SELECT * FROM task_evidence
        WHERE todo_id IN (${taskIds.map(() => '?').join(',')})
        ORDER BY todo_id, created_at, id`,
      taskIds
    )
    : [];

  const pendingConditions = ['s.state = \'pending\'', 'date(s.created_at) BETWEEN ? AND ?'];
  const pendingParams = [since, until];
  if (scope.project) {
    pendingConditions.push(`(
      s.suggested_project = ?
      OR EXISTS (
        SELECT 1 FROM task_evidence te
         WHERE te.suggestion_id = s.id
           AND te.project_path = ?
      )
    )`);
    pendingParams.push(scope.project.name, scope.project.path);
  } else {
    pendingConditions.push(`(
      (s.suggested_project IS NULL
       OR s.suggested_project NOT IN (SELECT name FROM projects WHERE hidden = 1))
      AND NOT EXISTS (
        SELECT 1 FROM task_evidence te
        JOIN projects p ON p.path = te.project_path
        WHERE te.suggestion_id = s.id
          AND p.hidden = 1
      )
    )`);
  }

  const pendingRows = allRows(
    `SELECT s.* FROM reconciliation_suggestions s
      WHERE ${pendingConditions.join(' AND ')}
      ORDER BY s.created_at, s.id`,
    pendingParams
  );

  const evidence = evidenceRows.map(serializeEvidence);
  const pendingSuggestions = pendingRows.map(serializeSuggestion);

  return {
    available,
    reason: available ? null : 'local session-store database not available',
    summary: {
      linkedEvidence: evidence.length,
      pendingSuggestions: pendingSuggestions.length,
    },
    evidence,
    pendingSuggestions,
    limitations: capabilities.limitations,
  };
}

function renderChronicleMd(chronicle, tasksById) {
  let md = '## Chronicle evidence\n\n';
  if (!chronicle.available) {
    md += `Chronicle/session evidence unavailable: ${chronicle.reason}.\n\n`;
  }

  if (chronicle.evidence.length) {
    const byTask = {};
    for (const ev of chronicle.evidence) {
      if (!byTask[ev.todo_id]) byTask[ev.todo_id] = [];
      byTask[ev.todo_id].push(ev);
    }
    for (const [todoId, rows] of Object.entries(byTask)) {
      const task = tasksById.get(todoId);
      md += `- ${task ? task.title : todoId}\n`;
      for (const ev of rows) {
        const details = [];
        if (ev.branch) details.push(`branch ${ev.branch}`);
        if (ev.pr_refs.length) details.push(`PR ${ev.pr_refs.join(', ')}`);
        if (ev.issue_refs.length) details.push(`issue ${ev.issue_refs.join(', ')}`);
        if (ev.files_changed.length) details.push(`files ${ev.files_changed.slice(0, 3).join(', ')}`);
        const suffix = details.length ? ` (${details.join('; ')})` : '';
        md += `  - ${ev.summary || ev.source_session_id}${suffix}\n`;
      }
    }
    md += '\n';
  } else {
    md += 'No linked Chronicle/session evidence for canonical tasks in this period.\n\n';
  }

  md += '## Needs review\n\n';
  if (!chronicle.pendingSuggestions.length) {
    md += 'No pending Chronicle reconciliation suggestions in this period.\n\n';
  } else {
    for (const suggestion of chronicle.pendingSuggestions) {
      md += `- ${suggestion.suggested_title} (confidence ${suggestion.confidence})\n`;
      md += `  - Evidence: ${suggestion.evidence_summary}\n`;
    }
    md += '\n';
  }

  return md;
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
  // --json is shorthand for --format json
  if (opts.json) opts.format = 'json';

  const { since, until, label } = getDateRange(opts.date);

  let projectFilter = '';
  let reportProject = null;
  let params = [since, until];

  if (opts.project) {
    const project = resolveProject(opts.project);
    reportProject = project;
    projectFilter = 'AND project = ?';
    params.push(project.name);
  } else {
    projectFilter = 'AND (project IS NULL OR project NOT IN (SELECT name FROM projects WHERE hidden = 1))';
  }

  const tasks = allRows(`
    SELECT * FROM todos
    WHERE date(created_at) BETWEEN ? AND ?
    ${projectFilter}
    ORDER BY project, completed, created_at
  `, params);

  const usage = collectUsage(since, until);
  const taskGroups = groupTasks(tasks);
  const chronicle = opts.includeChronicle
    ? collectChronicleReport(since, until, tasks, { project: reportProject })
    : null;

  // --format json
  if (opts.format === 'json') {
    const payload = { period: label, since, until, tasks, taskGroups };
    if (usage) payload.usage = usage;
    if (chronicle) payload.chronicle = chronicle;
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

  const completed = taskGroups.completed;
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

  if (chronicle) {
    const tasksById = new Map(tasks.map(t => [t.id, t]));
    md += renderChronicleMd(chronicle, tasksById);
  }

  console.log(md);
}
