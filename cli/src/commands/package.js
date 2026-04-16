import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { DatabaseSync } from 'node:sqlite';
import { allRows, getRow } from '../data/store.js';
import { resolveProject } from '../data/project.js';

const COPILOT_DB = join(homedir(), '.copilot', 'session-store.db');
const SESSION_STATE = join(homedir(), '.copilot', 'session-state');

function getDateRange(range) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = today.toISOString().split('T')[0];

  switch (range) {
    case 'yesterday': {
      const y = new Date(today); y.setDate(y.getDate() - 1);
      return { since: y.toISOString().split('T')[0], until: y.toISOString().split('T')[0], label: 'Yesterday' };
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

function openCopilotDb() {
  if (!existsSync(COPILOT_DB)) return null;
  try {
    const db = new DatabaseSync(COPILOT_DB);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  } catch {
    return null;
  }
}

function findCorrelatedSession(copilotDb, task) {
  if (!copilotDb) return null;

  const projectName = task.project || '';
  const taskTime = new Date(task.created_at).getTime();
  const windowMs = 30 * 60 * 1000; // ±30 minutes

  // Find sessions where cwd contains the project name and created_at is within range
  try {
    const sessions = copilotDb.prepare(`
      SELECT * FROM sessions
      WHERE created_at IS NOT NULL
      ORDER BY created_at DESC
    `).all();

    for (const s of sessions) {
      const sessionTime = new Date(s.created_at).getTime();
      const cwdMatch = s.cwd && projectName && s.cwd.toLowerCase().includes(projectName.toLowerCase());
      const repoMatch = s.repository && projectName && s.repository.toLowerCase().includes(projectName.toLowerCase());
      const sessionIdMatch = task.session_id && s.id === task.session_id;

      if (sessionIdMatch || ((cwdMatch || repoMatch) && Math.abs(sessionTime - taskTime) <= windowMs)) {
        return s;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function getSessionEnrichment(copilotDb, session) {
  const enrichment = {
    sessionId: session.id,
    branch: session.branch || null,
    summary: session.summary || null,
    repository: session.repository || null,
    checkpoints: [],
    files: [],
    refs: [],
    model: null,
    turns: 0,
    tokens: 0,
    tools: {},
    taskCompleteSummary: null,
  };

  // Fetch checkpoints
  try {
    enrichment.checkpoints = copilotDb.prepare(
      'SELECT * FROM checkpoints WHERE session_id = ? ORDER BY checkpoint_number'
    ).all(session.id);
  } catch {}

  // Fetch session_files
  try {
    enrichment.files = copilotDb.prepare(
      'SELECT file_path, tool_name, turn_index FROM session_files WHERE session_id = ? ORDER BY turn_index'
    ).all(session.id);
  } catch {}

  // Fetch session_refs
  try {
    enrichment.refs = copilotDb.prepare(
      'SELECT ref_type, ref_value FROM session_refs WHERE session_id = ?'
    ).all(session.id);
  } catch {}

  // Parse events.jsonl for telemetry
  const evPath = join(SESSION_STATE, session.id, 'events.jsonl');
  if (existsSync(evPath)) {
    try {
      const lines = readFileSync(evPath, 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'session.start') {
            enrichment.model = ev.data?.selectedModel || enrichment.model;
          }
          if (ev.type === 'user.message') {
            enrichment.turns++;
          }
          if (ev.type === 'assistant.message' && ev.data?.outputTokens) {
            enrichment.tokens += ev.data.outputTokens;
          }
          if (ev.type === 'tool.execution_complete' || ev.type === 'tool.execution') {
            const toolName = ev.data?.tool || ev.data?.name || 'unknown';
            enrichment.tools[toolName] = (enrichment.tools[toolName] || 0) + 1;
          }
          if (ev.type === 'session.task_complete') {
            enrichment.taskCompleteSummary = ev.data?.summary || ev.data?.message || null;
          }
        } catch {}
      }
    } catch {}
  }

  return enrichment;
}

function formatToolsSummary(tools) {
  return Object.entries(tools)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ×${count}`)
    .join(', ');
}

function formatDateLabel() {
  return new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function renderMarkdown(packages, label) {
  let md = `# 📦 taskbean Work Package — ${label || formatDateLabel()}\n\n`;

  if (packages.length === 0) {
    md += '*No tasks found for this period.*\n';
    return md;
  }

  for (const pkg of packages) {
    const task = pkg.task;
    const s = pkg.session;
    const status = task.completed ? '✅' : '⬚';

    md += `## ${status} ${task.title}\n\n`;
    md += `**Project**: ${task.project || 'unknown'}`;

    if (s) {
      if (s.branch) md += ` · **Branch**: ${s.branch}`;
      if (s.model) md += `\n**AI Model**: ${s.model}`;
      if (s.turns) md += ` · **Turns**: ${s.turns}`;
      if (s.tokens) md += ` · **Tokens**: ${s.tokens.toLocaleString()}`;
    }
    md += '\n\n';

    // Summary from session
    const summary = s?.taskCompleteSummary
      || s?.checkpoints?.[s.checkpoints.length - 1]?.overview
      || s?.summary
      || null;

    if (summary) {
      md += `### Summary\n${summary}\n\n`;
    }

    // Files changed
    if (s?.files?.length) {
      md += `### Files Changed\n`;
      md += `| File | Action | Turn |\n|------|--------|------|\n`;
      for (const f of s.files) {
        md += `| ${f.file_path} | ${f.tool_name || 'unknown'} | ${f.turn_index ?? ''} |\n`;
      }
      md += '\n';
    }

    // Tools used
    if (s && Object.keys(s.tools).length > 0) {
      md += `### Tools Used\n${formatToolsSummary(s.tools)}\n\n`;
    }

    // Refs (PRs, commits, issues)
    if (s?.refs?.length) {
      md += `### References\n`;
      for (const r of s.refs) {
        md += `- **${r.ref_type}**: ${r.ref_value}\n`;
      }
      md += '\n';
    }

    md += `---\n\n`;
  }

  return md;
}

function renderJson(packages) {
  return JSON.stringify(packages.map(pkg => ({
    task: pkg.task,
    session: pkg.session ? {
      id: pkg.session.sessionId,
      branch: pkg.session.branch,
      repository: pkg.session.repository,
      summary: pkg.session.summary,
      model: pkg.session.model,
      turns: pkg.session.turns,
      tokens: pkg.session.tokens,
      taskCompleteSummary: pkg.session.taskCompleteSummary,
      tools: pkg.session.tools,
      files: pkg.session.files,
      refs: pkg.session.refs,
      checkpoints: pkg.session.checkpoints,
    } : null,
  })), null, 2);
}

export function packageCommand(taskId, opts) {
  const format = opts.json ? 'json' : (opts.format || 'md');
  const copilotDb = openCopilotDb();

  let tasks;
  if (taskId) {
    // Single task mode
    const task = getRow('SELECT * FROM todos WHERE id = ?', [taskId]);
    if (!task) {
      console.error(`Task not found: ${taskId}`);
      process.exitCode = 1;
      return;
    }
    tasks = [task];
  } else {
    // Batch mode with date/project filters
    const { since, until } = getDateRange(opts.date);
    let projectFilter = '';
    let params = [since, until];

    if (opts.project) {
      const project = resolveProject(opts.project);
      projectFilter = 'AND project = ?';
      params.push(project.name);
    }

    tasks = allRows(`
      SELECT * FROM todos
      WHERE date(created_at) BETWEEN ? AND ?
      ${projectFilter}
      ORDER BY created_at DESC
    `, params);
  }

  // Build work packages with session enrichment
  const packages = tasks.map(task => {
    const session = findCorrelatedSession(copilotDb, task);
    return {
      task,
      session: session ? getSessionEnrichment(copilotDb, session) : null,
    };
  });

  // Close the copilot DB
  if (copilotDb) {
    try { copilotDb.close(); } catch {}
  }

  // Output
  if (format === 'json') {
    console.log(renderJson(packages));
  } else {
    const label = taskId ? formatDateLabel() : getDateRange(opts.date).label;
    console.log(renderMarkdown(packages, label));
  }
}
