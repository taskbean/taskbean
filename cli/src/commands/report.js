import { allRows } from '../data/store.js';
import { resolveProject } from '../data/project.js';
import { discoverChronicleCapabilities } from '../chronicle/adapter.js';
import { completionTimes } from '../data/completions.js';
import { getDateRange, inPeriod, parseInstant, formatLocal } from '../data/periods.js';

const AGENT_DISPLAY = {
  copilot: 'Copilot',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};
const AGENT_ORDER = ['copilot', 'claude-code', 'codex', 'opencode'];
const MINUTES_PER_TURN = 3;

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function collectUsage(start, end) {
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
        WHERE julianday(occurred_at) >= julianday(?) AND julianday(occurred_at) < julianday(?)
          AND agent IN (${placeholders})
        GROUP BY agent`,
      [start, end, ...enabled]
    );

    const sessionStats = allRows(
      `SELECT agent, COUNT(*) AS sessions
         FROM agent_sessions
        WHERE julianday(started_at) >= julianday(?) AND julianday(started_at) < julianday(?)
          AND agent IN (${placeholders})
        GROUP BY agent`,
      [start, end, ...enabled]
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

function collectEfficiency(start, end) {
  try {
    const enabled = allRows(
      'SELECT agent FROM agent_settings WHERE enabled = 1'
    ).map(r => r.agent);
    if (enabled.length === 0) {
      return { minutesPerTurn: MINUTES_PER_TURN, byAgent: [], totals: zeroEfficiencyTotals() };
    }

    const placeholders = enabled.map(() => '?').join(',');
    const sessions = allRows(
      `WITH period_turns AS (
         SELECT session_id,
                COUNT(*) AS turns,
                COALESCE(SUM(total_tokens), 0) AS totalTokens
           FROM agent_turns
          WHERE julianday(occurred_at) >= julianday(?) AND julianday(occurred_at) < julianday(?)
          GROUP BY session_id
       ),
       linked_tasks AS (
         SELECT agent_session_id AS session_id,
                COUNT(DISTINCT id) AS linkedTasks
           FROM todos
          WHERE agent_session_id IS NOT NULL
          GROUP BY agent_session_id
       )
       SELECT s.id AS sessionId,
              s.agent,
              COALESCE(pt.turns, 0) AS turns,
              COALESCE(pt.totalTokens, 0) AS totalTokens,
              COALESCE(lt.linkedTasks, 0) AS linkedTasks
         FROM agent_sessions s
         LEFT JOIN period_turns pt ON pt.session_id = s.id
         LEFT JOIN linked_tasks lt ON lt.session_id = s.id
        WHERE s.agent IN (${placeholders})
          AND (pt.session_id IS NOT NULL OR (julianday(s.started_at) >= julianday(?) AND julianday(s.started_at) < julianday(?)))`,
      [start, end, ...enabled, start, end]
    ).map(row => ({
      ...row,
      turns: Number(row.turns),
      totalTokens: Number(row.totalTokens),
      linkedTasks: Number(row.linkedTasks),
    }));

    const byAgent = [];
    for (const agent of AGENT_ORDER) {
      if (!enabled.includes(agent)) continue;
      const agentSessions = sessions.filter(row => row.agent === agent);
      if (agentSessions.length === 0) continue;

      const aggregate = agentSessions.reduce((acc, row) => {
        acc.sessions += 1;
        acc.turns += row.turns;
        acc.totalTokens += row.totalTokens;
        acc.linkedTasks += row.linkedTasks;
        if (row.linkedTasks > 0) acc.linkedSessionTokens += row.totalTokens;
        return acc;
      }, { ...zeroEfficiencyTotals(), linkedSessionTokens: 0 });

      const row = {
        agent,
        display: AGENT_DISPLAY[agent] || agent,
        sessions: aggregate.sessions,
        turns: aggregate.turns,
        totalTokens: aggregate.totalTokens,
        estimatedEffortMinutes: aggregate.turns * MINUTES_PER_TURN,
        linkedTasks: aggregate.linkedTasks,
      };
      if (aggregate.linkedTasks > 0) {
        row.tokensPerTask = aggregate.linkedSessionTokens / aggregate.linkedTasks;
      }
      byAgent.push(row);
    }

    const totals = byAgent.reduce((acc, row) => {
      acc.sessions += row.sessions;
      acc.turns += row.turns;
      acc.totalTokens += row.totalTokens;
      acc.estimatedEffortMinutes += row.estimatedEffortMinutes;
      acc.linkedTasks += row.linkedTasks;
      if (row.linkedTasks > 0) {
        acc.linkedSessionTokens += row.tokensPerTask * row.linkedTasks;
      }
      return acc;
    }, { ...zeroEfficiencyTotals(), linkedSessionTokens: 0 });

    if (totals.linkedTasks > 0) {
      totals.tokensPerTask = totals.linkedSessionTokens / totals.linkedTasks;
    }
    delete totals.linkedSessionTokens;

    return { minutesPerTurn: MINUTES_PER_TURN, byAgent, totals };
  } catch {
    return null;
  }
}

function zeroEfficiencyTotals() {
  return { sessions: 0, turns: 0, totalTokens: 0, estimatedEffortMinutes: 0, linkedTasks: 0 };
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function serializeEvidence(row, includeCommits = false) {
  const commits = parseJsonArray(row.commit_refs);
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
    ...(includeCommits && commits.length ? { commit_refs: commits } : {}),
    files_changed: parseJsonArray(row.files_changed),
    summary: row.summary,
    confidence: Number(row.confidence),
    occurred_at: row.occurred_at || row.created_at,
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
    auto_linked: Boolean(row.auto_linked),
    decision_reason: row.decision_reason,
    decision_details: parseJsonObject(row.decision_details),
    occurred_at: row.occurred_at || row.created_at,
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

function collectChronicleReport(range, tasks, scope = {}, includeCommits = false) {
  const capabilities = discoverChronicleCapabilities();
  const available = capabilities.localSessionStore.status === 'available';
  const taskIds = tasks.map(t => t.id);
  const evidenceRows = taskIds.length
    ? allRows(
      `SELECT * FROM task_evidence
        WHERE todo_id IN (${taskIds.map(() => '?').join(',')})
        ORDER BY todo_id, COALESCE(occurred_at, created_at), id`,
      taskIds
    )
    : [];

  // Period filtering happens in JS (inPeriod) so local-day boundaries match the rest of the report.
  const pendingConditions = ['s.state = \'pending\''];
  const pendingParams = [];
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
      ORDER BY COALESCE(s.occurred_at, s.created_at), s.id`,
    pendingParams
  ).filter(row => inPeriod(row.occurred_at || row.created_at, range));

  const autoLinkedConditions = [
    's.state = \'linked\'',
    's.auto_linked = 1',
  ];
  const autoLinkedParams = [];
  if (scope.project) {
    autoLinkedConditions.push(`(
      s.linked_todo_id IN (SELECT id FROM todos WHERE project = ? OR project_path = ?)
      OR EXISTS (
        SELECT 1 FROM task_evidence te
         WHERE te.suggestion_id = s.id
           AND te.project_path = ?
      )
    )`);
    autoLinkedParams.push(scope.project.name, scope.project.path, scope.project.path);
  } else {
    autoLinkedConditions.push(`(
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

  const autoLinkedRows = allRows(
    `SELECT s.* FROM reconciliation_suggestions s
      WHERE ${autoLinkedConditions.join(' AND ')}
      ORDER BY COALESCE(s.decided_at, s.occurred_at, s.created_at), s.id`,
    autoLinkedParams
  ).filter(row => inPeriod(row.decided_at || row.occurred_at || row.created_at, range));

  const evidence = evidenceRows.map(row => serializeEvidence(row, includeCommits));
  const pendingSuggestions = pendingRows.map(serializeSuggestion);
  const autoLinked = autoLinkedRows.map(serializeSuggestion);

  return {
    available,
    reason: available ? null : 'local session-store database not available',
    summary: {
      linkedEvidence: evidence.length,
      pendingSuggestions: pendingSuggestions.length,
      autoLinked: autoLinked.length,
    },
    evidence,
    autoLinked,
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
        if (ev.commit_refs?.length) details.push(`commit ${ev.commit_refs.join(', ')}`);
        if (ev.files_changed.length) details.push(`files ${ev.files_changed.slice(0, 3).join(', ')}`);
        const suffix = details.length ? ` (${details.join('; ')})` : '';
        md += `  - ${ev.summary || ev.source_session_id}${suffix}\n`;
      }
    }
    md += '\n';
  } else {
    md += 'No linked Chronicle/session evidence for canonical tasks in this period.\n\n';
  }

  if (chronicle.autoLinked?.length) {
    md += '## Auto-linked evidence\n\n';
    for (const suggestion of chronicle.autoLinked) {
      const task = tasksById.get(suggestion.linked_todo_id);
      md += `- ${task ? task.title : suggestion.linked_todo_id}: ${suggestion.decision_reason || 'auto-linked evidence'}\n`;
    }
    md += '\n';
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

function renderEfficiencyMd(efficiency) {
  let md = `## Effort & token efficiency\n`;
  if (!efficiency || efficiency.byAgent.length === 0) {
    md += `No coding agent activity in this period.\n\n`;
    return md;
  }
  md += `Estimated effort uses ${efficiency.minutesPerTurn} minutes per turn.\n\n`;
  md += `| Agent       | Sessions | Turns | Total tokens | Effort minutes | Linked tasks | Tokens / task |\n`;
  md += `|-------------|---------:|------:|-------------:|---------------:|-------------:|--------------:|\n`;
  for (const r of efficiency.byAgent) {
    const tokensPerTask = Object.hasOwn(r, 'tokensPerTask') ? fmtNum(r.tokensPerTask) : 'N/A';
    md += `| ${r.display.padEnd(11)} | ${String(fmtNum(r.sessions)).padStart(8)} | ${String(fmtNum(r.turns)).padStart(5)} | ${String(fmtNum(r.totalTokens)).padStart(12)} | ${String(fmtNum(r.estimatedEffortMinutes)).padStart(14)} | ${String(fmtNum(r.linkedTasks)).padStart(12)} | ${String(tokensPerTask).padStart(13)} |\n`;
  }
  md += '\n';
  return md;
}

function stateOf(task) {
  if (task.completed || task.status === 'done') return 'done';
  if (task.status === 'in_progress' || task.status === 'blocked') return task.status;
  return 'pending';
}

function collectEvidence(taskIds) {
  const byTask = new Map();
  if (!taskIds.length) return byTask;
  let rows = [];
  try {
    rows = allRows(
      `SELECT todo_id, pr_refs, issue_refs, commit_refs, branch, source_session_id FROM task_evidence
        WHERE todo_id IN (${taskIds.map(() => '?').join(',')})
        ORDER BY todo_id, COALESCE(occurred_at, created_at), id`,
      taskIds
    );
  } catch {
    return byTask;
  }
  for (const row of rows) {
    if (!byTask.has(row.todo_id)) {
      byTask.set(row.todo_id, { prs: new Set(), issues: new Set(), commits: new Set(), branches: new Set(), sessions: new Set() });
    }
    const ev = byTask.get(row.todo_id);
    parseJsonArray(row.pr_refs).forEach(v => ev.prs.add(String(v)));
    parseJsonArray(row.issue_refs).forEach(v => ev.issues.add(String(v)));
    parseJsonArray(row.commit_refs).forEach(v => ev.commits.add(String(v)));
    if (row.branch) ev.branches.add(row.branch);
    if (row.source_session_id) ev.sessions.add(row.source_session_id);
  }
  const result = new Map();
  for (const [id, ev] of byTask) {
    const out = {};
    for (const key of ['prs', 'issues', 'commits', 'branches', 'sessions']) {
      if (ev[key].size) out[key] = [...ev[key]];
    }
    if (Object.keys(out).length) result.set(id, out);
  }
  return result;
}

function evidenceText(ev) {
  if (!ev) return 'no evidence';
  const parts = [];
  if (ev.prs) parts.push(`PR ${ev.prs.join(', ')}`);
  if (ev.issues) parts.push(`issue ${ev.issues.join(', ')}`);
  if (ev.commits) parts.push(`commit ${ev.commits.join(', ')}`);
  if (ev.branches) parts.push(`branch ${ev.branches.join(', ')}`);
  if (ev.sessions) parts.push(`session ${ev.sessions.join(', ')}`);
  return parts.join('; ');
}

/**
 * Outcome view of the period: delivered by completion time, completed items
 * whose completion time is unknown, and items open at report time.
 */
function buildOutcomes(allTasks, range) {
  const completions = completionTimes(allTasks.map(t => ({ ...t, completed: stateOf(t) === 'done' })));
  const delivered = [];
  const completedTimeUnknown = [];
  const blocked = [];
  const inProgress = [];
  const pending = [];
  for (const task of allTasks) {
    const state = stateOf(task);
    if (state === 'done') {
      const info = completions.get(task.id) || { completed_at: null, completion_source: null };
      if (info.completed_at) {
        if (inPeriod(info.completed_at, range)) delivered.push({ task, ...info });
      } else if (inPeriod(task.created_at, range)) {
        completedTimeUnknown.push({ task, ...info });
      }
    } else if (state === 'blocked') blocked.push({ task });
    else if (state === 'in_progress') inProgress.push({ task });
    else pending.push({ task });
  }
  delivered.sort((a, b) => parseInstant(a.completed_at) - parseInstant(b.completed_at));
  const evidence = collectEvidence([...delivered, ...completedTimeUnknown].map(e => e.task.id));
  for (const entry of [...delivered, ...completedTimeUnknown]) entry.evidence = evidence.get(entry.task.id) || null;
  return { delivered, completedTimeUnknown, blocked, inProgress, pending };
}

function compactOutcomes(outcomes, range) {
  const base = ({ task }) => ({ id: task.id, title: task.title, project: task.project || null });
  return {
    period: range.label,
    since: range.since,
    until: range.until,
    counts: {
      delivered: outcomes.delivered.length,
      completedTimeUnknown: outcomes.completedTimeUnknown.length,
      blocked: outcomes.blocked.length,
      inProgress: outcomes.inProgress.length,
      pending: outcomes.pending.length,
    },
    delivered: outcomes.delivered.map(e => ({
      ...base(e), completedAt: e.completed_at, completionSource: e.completion_source, evidence: e.evidence,
    })),
    completedTimeUnknown: outcomes.completedTimeUnknown.map(e => ({ ...base(e), evidence: e.evidence })),
    blocked: outcomes.blocked.map(e => ({ ...base(e), reason: e.task.notes || null })),
    inProgress: outcomes.inProgress.map(base),
  };
}

function groupByProject(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.task.project || '(no project)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function renderSection(title, entries, line, emptyText) {
  let md = `## ${title} (${entries.length})\n`;
  if (!entries.length) return `${md}${emptyText}\n\n`;
  for (const [project, group] of groupByProject(entries)) {
    md += `\n### 📁 ${project}\n`;
    for (const entry of group) md += `- ${line(entry)}\n`;
  }
  return `${md}\n`;
}

function renderOutcomesMd(outcomes) {
  let md = '';
  md += renderSection('✅ Delivered', outcomes.delivered,
    e => `${e.task.title} — completed ${formatLocal(e.completed_at)}${e.completion_source === 'event-history' ? ' (from event history)' : ''} — evidence: ${evidenceText(e.evidence)}`,
    'No outcomes completed in this period.');
  if (outcomes.completedTimeUnknown.length) {
    md += renderSection('☑️ Completed, completion time unknown', outcomes.completedTimeUnknown,
      e => `${e.task.title} — created ${formatLocal(e.task.created_at)}; completion time not recorded — evidence: ${evidenceText(e.evidence)}`,
      '');
  }
  md += renderSection('🚫 Blocked (open now)', outcomes.blocked,
    e => `${e.task.title} — reason: ${e.task.notes ? e.task.notes : 'no reason recorded'}`,
    'Nothing blocked.');
  md += renderSection('🔄 In progress (open now)', outcomes.inProgress, e => e.task.title, 'Nothing in progress.');
  md += renderSection('⬚ Pending (open now)', outcomes.pending, e => e.task.title, 'Nothing pending.');
  return md;
}

export function reportCommand(opts) {
  // --json is shorthand for --format json
  if (opts.json) opts.format = 'json';

  const range = getDateRange(opts.date);
  const { since, until, label } = range;

  let projectFilter = '';
  let reportProject = null;
  const params = [];

  if (opts.project) {
    const project = resolveProject(opts.project);
    reportProject = project;
    projectFilter = 'AND project = ?';
    params.push(project.name);
  } else {
    projectFilter = 'AND (project IS NULL OR project NOT IN (SELECT name FROM projects WHERE hidden = 1))';
  }

  const scopedTasks = allRows(`
    SELECT * FROM todos
    WHERE 1=1
    ${projectFilter}
    ORDER BY project, completed, created_at
  `, params);
  // Tasks created in the period, compared as local-day instants.
  const tasks = scopedTasks.filter(t => inPeriod(t.created_at, range));

  if (opts.compact) {
    console.log(JSON.stringify(compactOutcomes(buildOutcomes(scopedTasks, range), range)));
    return;
  }

  const usage = collectUsage(range.start, range.end);
  const efficiency = collectEfficiency(range.start, range.end);
  const taskGroups = groupTasks(tasks);
  const chronicle = opts.includeChronicle
    ? collectChronicleReport(range, tasks, { project: reportProject }, opts.format !== 'json')
    : null;

  // --format json
  if (opts.format === 'json') {
    const payload = { period: label, since, until, tasks, taskGroups };
    if (usage) payload.usage = usage;
    if (efficiency) payload.efficiency = efficiency;
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
  const outcomes = buildOutcomes(scopedTasks, range);

  let md = `# 📋 taskbean report — ${label} (${since}${since === until ? '' : ` to ${until}`})\n\n`;
  md += `**Generated**: ${new Date().toLocaleString()}\n\n`;
  md += `## Summary\n`;
  md += `- **Delivered** (completed in period): ${outcomes.delivered.length}\n`;
  if (outcomes.completedTimeUnknown.length) {
    md += `- **Completed, time unknown** (created in period): ${outcomes.completedTimeUnknown.length}\n`;
  }
  md += `- **Blocked**: ${outcomes.blocked.length}\n`;
  md += `- **In progress**: ${outcomes.inProgress.length}\n`;
  md += `- **Pending**: ${outcomes.pending.length}\n\n`;
  md += `Open counts are as of report time, across the report scope.\n\n`;

  md += renderOutcomesMd(outcomes);

  if (usage) {
    md += renderUsageMd(usage);
  }

  if (efficiency) {
    md += renderEfficiencyMd(efficiency);
  }

  if (chronicle) {
    const tasksById = new Map(tasks.map(t => [t.id, t]));
    md += renderChronicleMd(chronicle, tasksById);
  }

  console.log(md);
}
