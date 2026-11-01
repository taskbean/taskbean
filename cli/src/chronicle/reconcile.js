import { createHash } from 'crypto';
import { basename } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { discoverChronicleCapabilities } from './adapter.js';
import { getDb } from '../data/store.js';

const SOURCE = 'copilot-session-store';
const VERY_HIGH_CONFIDENCE = 0.88;
const RUNNER_UP_MARGIN = 0.12;

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function normalizeDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
    throw new Error(`${label} must be a date in YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || isoDate(parsed) !== value) {
    throw new Error(`${label} must be a valid calendar date`);
  }
  return value;
}

function dateWindow(opts) {
  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);
  const since = normalizeDate(opts.since || isoDate(weekAgo), '--since');
  const until = normalizeDate(opts.until || isoDate(today), '--until');
  if (since > until) {
    throw new Error('--since must be on or before --until');
  }
  return { since, until };
}

function hashId(prefix, parts) {
  const hash = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
  return `${prefix}_${hash}`;
}

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function tableColumns(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map(c => c.name);
  } catch {
    return [];
  }
}

function hasTable(db, table) {
  const row = db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(table);
  return Boolean(row);
}

function selectExpr(columns, names, alias) {
  const found = names.find(name => columns.includes(name));
  return found ? `${quoteIdent(found)} AS ${quoteIdent(alias)}` : `NULL AS ${quoteIdent(alias)}`;
}

function timeExpr(columns) {
  const candidates = ['started_at', 'created_at', 'timestamp', 'updated_at'];
  const found = candidates.filter(name => columns.includes(name));
  if (!found.length) return null;
  if (found.length === 1) return quoteIdent(found[0]);
  return `COALESCE(${found.map(quoteIdent).join(', ')})`;
}

// Latest-change time, used as the observe-mode cursor so sessions that keep
// working after a previous run are re-read and their evidence refreshed.
function changeExpr(columns) {
  const candidates = ['updated_at', 'timestamp', 'created_at', 'started_at'];
  const found = candidates.filter(name => columns.includes(name));
  if (!found.length) return null;
  if (found.length === 1) return quoteIdent(found[0]);
  return `COALESCE(${found.map(quoteIdent).join(', ')})`;
}

function orderByExisting(columns, candidates) {
  return candidates
    .filter(name => columns.includes(name))
    .map(quoteIdent)
    .join(', ');
}

function openSessionStore(opts = {}) {
  const home = opts.home || homedir();
  const path = opts.sessionStorePath || join(opts.copilotDir || join(home, '.copilot'), 'session-store.db');
  return new DatabaseSync(path, { readOnly: true });
}

function readRows(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

function refsForSession(db, sessionId) {
  if (!hasTable(db, 'session_refs')) return { prRefs: [], issueRefs: [] };
  const cols = tableColumns(db, 'session_refs');
  if (!cols.includes('session_id')) return { prRefs: [], issueRefs: [] };
  if (!['ref_value', 'value', 'ref'].some(name => cols.includes(name))) {
    return { prRefs: [], issueRefs: [] };
  }
  const order = orderByExisting(cols, ['created_at', 'ref_type', 'type', 'ref_value', 'value', 'ref']);
  const orderClause = order ? ` ORDER BY ${order}` : '';
  let rows;
  try {
    rows = readRows(
      db,
      `SELECT ${selectExpr(cols, ['ref_type', 'type'], 'type')},
              ${selectExpr(cols, ['ref_value', 'value', 'ref'], 'value')}
         FROM session_refs
        WHERE session_id = ?${orderClause}`,
      [sessionId]
    );
  } catch {
    return { prRefs: [], issueRefs: [] };
  }
  const prRefs = [];
  const issueRefs = [];
  for (const row of rows) {
    const type = String(row.type || '').toLowerCase();
    const value = String(row.value || '').trim();
    if (!value) continue;
    if (type.includes('pr') || type.includes('pull')) prRefs.push(value);
    else if (type.includes('issue')) issueRefs.push(value);
  }
  return { prRefs: [...new Set(prRefs)], issueRefs: [...new Set(issueRefs)] };
}

function filesForSession(db, sessionId) {
  if (!hasTable(db, 'session_files')) return [];
  const cols = tableColumns(db, 'session_files');
  if (!cols.includes('session_id') || !cols.includes('file_path')) return [];
  const order = orderByExisting(cols, ['first_seen_at', 'file_path']);
  const orderClause = order ? ` ORDER BY ${order}` : '';
  let rows;
  try {
    rows = readRows(
      db,
      `SELECT file_path FROM session_files WHERE session_id = ?${orderClause}`,
      [sessionId]
    );
  } catch {
    return [];
  }
  return [...new Set(rows.map(r => String(r.file_path || '').trim()).filter(Boolean))];
}

function checkpointSummaryForSession(db, sessionId) {
  if (!hasTable(db, 'checkpoints')) return null;
  const cols = tableColumns(db, 'checkpoints');
  if (!cols.includes('session_id')) return null;
  const summaryCols = ['title', 'overview', 'work_done', 'next_steps'].filter(c => cols.includes(c));
  if (!summaryCols.length) return null;
  const order = cols.includes('created_at') ? 'created_at DESC' : cols.includes('checkpoint_number') ? 'checkpoint_number DESC' : 'rowid DESC';
  let row;
  try {
    row = db.prepare(
      `SELECT ${summaryCols.map(c => quoteIdent(c)).join(', ')}
         FROM checkpoints
        WHERE session_id = ?
        ORDER BY ${order}
        LIMIT 1`
    ).get(sessionId);
  } catch {
    return null;
  }
  if (!row) return null;
  return summaryCols.map(c => row[c]).find(v => typeof v === 'string' && v.trim())?.trim() || null;
}

function compactText(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3).trimEnd()}...`;
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function basenameAny(value) {
  const normalized = String(value || '').replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || basename(normalized);
}

function normalizeToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();
}

function wordSet(value) {
  return new Set(normalizeToken(value).split(/\s+/).filter(w => w.length > 2 || w.startsWith('#')));
}

function textOverlap(a, b) {
  const left = wordSet(a);
  const right = wordSet(b);
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return common / Math.max(left.size, right.size);
}

function normPath(value) {
  return String(value || '').replaceAll('\\', '/').toLowerCase();
}

function arrayOverlap(a, b, normalizer = v => String(v || '').toLowerCase()) {
  const left = new Set((a || []).map(normalizer).filter(Boolean));
  const right = new Set((b || []).map(normalizer).filter(Boolean));
  const values = [...left].filter(v => right.has(v));
  return values;
}

function hoursApart(a, b) {
  const left = Date.parse(a || '');
  const right = Date.parse(b || '');
  if (Number.isNaN(left) || Number.isNaN(right)) return null;
  return Math.abs(left - right) / 36e5;
}

function evidenceRowsForTask(db, todoId) {
  try {
    return db.prepare('SELECT * FROM task_evidence WHERE todo_id = ?').all(todoId);
  } catch {
    return [];
  }
}

function taskCandidatesForSuggestion(db, suggestion) {
  const e = suggestion.evidence;
  const clauses = [];
  const params = [];
  if (e.project_path) {
    clauses.push('project_path = ?');
    params.push(e.project_path);
  }
  if (suggestion.suggested_project) {
    clauses.push('project = ?');
    params.push(suggestion.suggested_project);
  }
  if (e.project_path) {
    clauses.push('project = ?');
    params.push(basenameAny(e.project_path));
    clauses.push('project = ?');
    params.push(e.project_path);
  }
  if (!clauses.length) return [];
  return db.prepare(`
    SELECT * FROM todos
     WHERE ${clauses.join(' OR ')}
     ORDER BY created_at, id
  `).all(...params);
}

function scoreTaskCandidate(db, suggestion, task) {
  const e = suggestion.evidence;
  const linkedEvidence = evidenceRowsForTask(db, task.id);
  const taskRefs = linkedEvidence.flatMap(row => [
    ...parseJsonArray(row.pr_refs),
    ...parseJsonArray(row.issue_refs),
  ]);
  const evidenceRefs = [...e.pr_refs, ...e.issue_refs];
  const taskFiles = linkedEvidence.flatMap(row => parseJsonArray(row.files_changed));
  const taskBranches = linkedEvidence.map(row => row.branch).filter(Boolean);
  const matchedSignals = ['same project'];
  const missingSignals = [];
  let score = 0.35;

  const titleScore = textOverlap(
    `${suggestion.suggested_title} ${e.summary || ''}`,
    `${task.title || ''} ${linkedEvidence.map(row => row.summary || '').join(' ')}`
  );
  if (titleScore >= 0.55) {
    score += 0.2;
    matchedSignals.push('title overlap');
  } else if (titleScore >= 0.35) {
    score += 0.15;
    matchedSignals.push('partial title overlap');
  } else {
    missingSignals.push('title overlap');
  }

  const sharedRefs = arrayOverlap(evidenceRefs, taskRefs, v => String(v || '').toLowerCase());
  if (sharedRefs.length) {
    score += 0.25;
    matchedSignals.push(`${sharedRefs.length} shared ref${sharedRefs.length === 1 ? '' : 's'}`);
  } else {
    missingSignals.push('shared refs');
  }

  const sharedFiles = arrayOverlap(e.files_changed, taskFiles, normPath);
  if (sharedFiles.length) {
    score += 0.25;
    matchedSignals.push(`${sharedFiles.length} shared file${sharedFiles.length === 1 ? '' : 's'}`);
  } else {
    missingSignals.push('file overlap');
  }

  if (e.branch && taskBranches.map(normalizeToken).includes(normalizeToken(e.branch))) {
    score += 0.18;
    matchedSignals.push('same branch');
  } else if (e.branch) {
    missingSignals.push('same branch');
  }

  const hours = hoursApart(e.occurred_at || suggestion.occurred_at, task.created_at);
  if (hours !== null && hours <= 24) {
    score += 0.1;
    matchedSignals.push('close work time');
  } else if (hours !== null && hours <= 168) {
    score += 0.05;
    matchedSignals.push('nearby work time');
  } else {
    missingSignals.push('close work time');
  }

  const confidence = Math.min(0.99, Math.round(score * 100) / 100);
  return {
    todoId: task.id,
    title: task.title,
    confidence,
    matchedSignals,
    missingSignals,
    titleScore: Math.round(titleScore * 100) / 100,
  };
}

function compactAutoLinkReason(match) {
  const signals = match.matchedSignals.join(', ');
  const runner = match.runnerUp ? `; runner-up: ${match.runnerUp.title || match.runnerUp.todoId}` : '';
  return `${signals}${runner}`;
}

function findExactTaskForSession(db, nativeSessionId) {
  const native = String(nativeSessionId || '').trim();
  if (!native) return null;
  return db.prepare(`
    SELECT * FROM todos
     WHERE session_id = ?
        OR agent_session_id IN (?, ?)
     ORDER BY created_at
     LIMIT 1
  `).get(native, `copilot:${native}`, `${SOURCE}:${native}`) || null;
}

function findAutoLinkForSuggestion(db, suggestion) {
  const exact = findExactTaskForSession(db, suggestion.evidence.source_session_id);
  if (exact) {
    return {
      todoId: exact.id,
      confidence: 1,
      reason: 'exact session id match',
      details: {
        kind: 'exact-session',
        confidence: 1,
        threshold: 1,
        matchedSignals: ['exact session id'],
        missingSignals: [],
        runnerUp: null,
      },
    };
  }

  const candidates = taskCandidatesForSuggestion(db, suggestion)
    .map(task => scoreTaskCandidate(db, suggestion, task))
    .sort((a, b) => b.confidence - a.confidence || a.todoId.localeCompare(b.todoId));
  const top = candidates[0];
  if (!top || top.confidence < VERY_HIGH_CONFIDENCE) return null;
  const runnerUp = candidates[1] || null;
  const margin = runnerUp ? Math.round((top.confidence - runnerUp.confidence) * 100) / 100 : null;
  if (runnerUp && margin < RUNNER_UP_MARGIN) return null;
  const match = { ...top, runnerUp };
  return {
    todoId: top.todoId,
    confidence: top.confidence,
    reason: compactAutoLinkReason(match),
    details: {
      kind: 'very-high-confidence',
      confidence: top.confidence,
      threshold: VERY_HIGH_CONFIDENCE,
      runnerUpMargin: RUNNER_UP_MARGIN,
      margin,
      matchedSignals: top.matchedSignals,
      missingSignals: top.missingSignals,
      titleScore: top.titleScore,
      runnerUp: runnerUp ? {
        todoId: runnerUp.todoId,
        title: runnerUp.title,
        confidence: runnerUp.confidence,
        matchedSignals: runnerUp.matchedSignals,
      } : null,
    },
  };
}

function projectNameFor(session) {
  if (session.repository) {
    const repo = String(session.repository).split(/[\\/]/).filter(Boolean).pop();
    if (repo) return repo.replace(/\.git$/, '');
  }
  if (session.cwd) return basenameAny(session.cwd);
  return null;
}

function confidenceFor(session, refs, files, summary) {
  let score = 0.4;
  if (session.cwd || session.repository) score += 0.15;
  if (session.branch) score += 0.1;
  if (refs.prRefs.length || refs.issueRefs.length) score += 0.15;
  if (files.length) score += 0.1;
  if (summary) score += 0.1;
  return Math.min(0.95, Math.round(score * 100) / 100);
}

function evidenceSummary(session, refs, files, summary) {
  const parts = [];
  const project = projectNameFor(session);
  if (project) parts.push(`Project ${project}`);
  if (session.branch) parts.push(`branch ${session.branch}`);
  if (refs.prRefs.length) parts.push(`PR ${refs.prRefs.join(', ')}`);
  if (refs.issueRefs.length) parts.push(`issue ${refs.issueRefs.join(', ')}`);
  if (files.length) {
    const shown = files.slice(0, 3).join(', ');
    const suffix = files.length > 3 ? ` and ${files.length - 3} more` : '';
    parts.push(`files ${shown}${suffix}`);
  }
  if (summary) parts.push(compactText(summary, 160));
  return parts.length ? parts.join('; ') : `Copilot session ${session.sessionId}`;
}

function suggestionTitle(session, summary) {
  const title = compactText(session.title || summary, 120);
  return title || `Review Copilot session ${String(session.sessionId).slice(0, 8)}`;
}

function readSessions(db, since, until, options = {}) {
  if (!hasTable(db, 'sessions')) return [];
  const cols = tableColumns(db, 'sessions');
  const when = timeExpr(cols);
  if (!when) return [];
  const idCol = ['id', 'native_id', 'session_id'].find(name => cols.includes(name));
  const changed = changeExpr(cols) || when;
  const observe = Boolean(options.observe);
  const windowExpr = observe ? changed : when;
  const where = [`date(${windowExpr}) BETWEEN ? AND ?`];
  const params = [since, until];
  if (observe && options.cursor?.last_changed_at && idCol) {
    where.push(`(${changed} > ? OR (${changed} = ? AND ${quoteIdent(idCol)} > ?))`);
    params.push(options.cursor.last_changed_at, options.cursor.last_changed_at, options.cursor.last_session_id || '');
  }
  const order = observe ? 'changed_at, sessionId' : 'occurred_at, sessionId';
  let limitSql = '';
  if (Number.isInteger(options.limit)) {
    limitSql = ' LIMIT ?';
    params.push(options.limit);
  }

  const rows = readRows(
    db,
    `SELECT ${selectExpr(cols, ['id', 'native_id', 'session_id'], 'sessionId')},
            ${selectExpr(cols, ['cwd', 'project_path'], 'cwd')},
            ${selectExpr(cols, ['repository', 'repo'], 'repository')},
            ${selectExpr(cols, ['branch', 'git_branch'], 'branch')},
            ${selectExpr(cols, ['title'], 'title')},
            ${selectExpr(cols, ['summary'], 'summary')},
            ${when} AS occurred_at,
            ${changed} AS changed_at
       FROM sessions
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}${limitSql}`,
    params
  );

  return rows
    .map(row => ({ ...row, sessionId: String(row.sessionId || '').trim() }))
    .filter(row => row.sessionId);
}

function buildSuggestion(db, session) {
  const refs = refsForSession(db, session.sessionId);
  const files = filesForSession(db, session.sessionId);
  const checkpointSummary = checkpointSummaryForSession(db, session.sessionId);
  const summary = compactText(session.summary || checkpointSummary, 500) || null;
  const confidence = confidenceFor(session, refs, files, summary);
  const sourceSessionId = `${SOURCE}:${session.sessionId}`;
  const evidenceKey = `${SOURCE}:${session.sessionId}`;
  const suggestionId = hashId('rec', [evidenceKey]);
  const evidenceId = hashId('ev', [evidenceKey]);
  const occurredAt = session.occurred_at || new Date().toISOString();

  return {
    id: suggestionId,
    evidence_key: evidenceKey,
    suggested_title: suggestionTitle(session, summary),
    suggested_project: projectNameFor(session),
    suggested_status: 'pending',
    source_session_ids: [sourceSessionId],
    evidence_summary: evidenceSummary(session, refs, files, summary),
    confidence,
    occurred_at: occurredAt,
    evidence: {
      id: evidenceId,
      suggestion_id: suggestionId,
      source: SOURCE,
      source_session_id: session.sessionId,
      repo: session.repository || null,
      project_path: session.cwd || null,
      branch: session.branch || null,
      pr_refs: refs.prRefs,
      issue_refs: refs.issueRefs,
      files_changed: files,
      summary,
      confidence,
      occurred_at: occurredAt,
    },
  };
}

function serializeSuggestion(row) {
  return {
    id: row.id,
    evidence_key: row.evidence_key,
    suggested_title: row.suggested_title,
    suggested_project: row.suggested_project,
    suggested_status: row.suggested_status,
    source_session_ids: JSON.parse(row.source_session_ids || '[]'),
    evidence_summary: row.evidence_summary,
    confidence: Number(row.confidence),
    state: row.state,
    linked_todo_id: row.linked_todo_id,
    auto_linked: Boolean(row.auto_linked),
    decision_reason: row.decision_reason,
    decision_details: row.decision_details ? JSON.parse(row.decision_details) : null,
    occurred_at: row.occurred_at,
  };
}

function sameSuggestion(existing, suggestion) {
  return existing.suggested_title === suggestion.suggested_title
    && existing.suggested_project === suggestion.suggested_project
    && existing.suggested_status === suggestion.suggested_status
    && existing.source_session_ids === JSON.stringify(suggestion.source_session_ids)
    && existing.evidence_summary === suggestion.evidence_summary
    && Number(existing.confidence) === suggestion.confidence
    && (existing.occurred_at || null) === (suggestion.occurred_at || null);
}

function sameEvidence(existing, evidence) {
  return existing.repo === evidence.repo
    && existing.project_path === evidence.project_path
    && existing.branch === evidence.branch
    && existing.pr_refs === JSON.stringify(evidence.pr_refs)
    && existing.issue_refs === JSON.stringify(evidence.issue_refs)
    && existing.files_changed === JSON.stringify(evidence.files_changed)
    && existing.summary === evidence.summary
    && Number(existing.confidence) === evidence.confidence
    && (existing.occurred_at || null) === (evidence.occurred_at || null);
}

function compareCursor(a, b) {
  const at = String(a?.last_changed_at || '');
  const bt = String(b?.last_changed_at || '');
  if (at !== bt) return at < bt ? -1 : 1;
  const ai = String(a?.last_session_id || '');
  const bi = String(b?.last_session_id || '');
  if (ai === bi) return 0;
  return ai < bi ? -1 : 1;
}

function readCheckpoint(taskbean) {
  return taskbean.prepare(
    'SELECT source, last_changed_at, last_session_id, runs, last_run_at, updated_at FROM reconciliation_checkpoints WHERE source = ?'
  ).get(SOURCE) || null;
}

function serializeCheckpoint(row) {
  if (!row) return null;
  return {
    source: row.source,
    last_changed_at: row.last_changed_at,
    last_session_id: row.last_session_id,
    runs: Number(row.runs || 0),
    last_run_at: row.last_run_at,
  };
}

function persistSuggestions(suggestions, options = {}) {
  const taskbean = getDb();
  const now = new Date().toISOString();
  const counts = { created: 0, updated: 0, linked: 0 };
  const ids = [];
  const observe = Boolean(options.observe);
  let checkpoint = null;

  taskbean.exec('BEGIN IMMEDIATE');
  try {
    for (const [index, suggestion] of suggestions.entries()) {
      // Observe-only runs never decide anything: no auto-link, no todo writes.
      const autoLink = observe ? null : findAutoLinkForSuggestion(taskbean, suggestion);
      const autoLinkedTodoId = autoLink?.todoId || null;
      const existing = taskbean.prepare(
        'SELECT * FROM reconciliation_suggestions WHERE evidence_key = ?'
      ).get(suggestion.evidence_key);

      const suggestionChanged = !existing || !sameSuggestion(existing, suggestion);
      const suggestionId = existing?.id || suggestion.id;
      const shouldAutoLink = autoLinkedTodoId && (!existing || existing.state === 'pending');
      const allowedAutoLinkedTodoId = shouldAutoLink ? autoLinkedTodoId : null;

      if (!existing) {
        counts.created += 1;
      } else if (suggestionChanged) {
        counts.updated += 1;
      }
      if (shouldAutoLink) counts.linked += 1;

      if (!existing) {
        taskbean.prepare(`
          INSERT INTO reconciliation_suggestions (
            id, evidence_key, suggested_title, suggested_project, suggested_status,
            source_session_ids, evidence_summary, confidence, state, linked_todo_id,
            auto_linked, decision_reason, decision_details, occurred_at, created_at, updated_at, decided_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          suggestion.id,
          suggestion.evidence_key,
          suggestion.suggested_title,
          suggestion.suggested_project,
          suggestion.suggested_status,
          JSON.stringify(suggestion.source_session_ids),
          suggestion.evidence_summary,
          suggestion.confidence,
          allowedAutoLinkedTodoId ? 'linked' : 'pending',
          allowedAutoLinkedTodoId,
          allowedAutoLinkedTodoId ? 1 : 0,
          allowedAutoLinkedTodoId ? autoLink.reason : null,
          allowedAutoLinkedTodoId ? JSON.stringify(autoLink.details) : null,
          suggestion.occurred_at,
          now,
          now,
          allowedAutoLinkedTodoId ? now : null
        );
      } else if (suggestionChanged) {
        taskbean.prepare(`
          UPDATE reconciliation_suggestions
             SET suggested_title = ?,
                 suggested_project = ?,
                 suggested_status = ?,
                 source_session_ids = ?,
                 evidence_summary = ?,
                 confidence = ?,
                 occurred_at = ?,
                 updated_at = ?
           WHERE id = ?
        `).run(
          suggestion.suggested_title,
          suggestion.suggested_project,
          suggestion.suggested_status,
          JSON.stringify(suggestion.source_session_ids),
          suggestion.evidence_summary,
          suggestion.confidence,
          suggestion.occurred_at,
          now,
          suggestionId
        );
      }

      if (shouldAutoLink && existing) {
        taskbean.prepare(`
          UPDATE reconciliation_suggestions
             SET state = 'linked',
                 linked_todo_id = ?,
                 auto_linked = 1,
                 decision_reason = ?,
                 decision_details = ?,
                 decided_at = COALESCE(decided_at, ?),
                 updated_at = ?
           WHERE id = ? AND state = 'pending'
        `).run(autoLinkedTodoId, autoLink.reason, JSON.stringify(autoLink.details), now, now, suggestionId);
      }

      const e = suggestion.evidence;
      const existingEvidence = taskbean.prepare(
        'SELECT * FROM task_evidence WHERE source = ? AND source_session_id = ? AND suggestion_id = ?'
      ).get(e.source, e.source_session_id, suggestionId);

      if (!existingEvidence) {
        taskbean.prepare(`
          INSERT INTO task_evidence (
            id, todo_id, suggestion_id, source, source_session_id, repo, project_path, branch,
            pr_refs, issue_refs, files_changed, summary, confidence, occurred_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          e.id,
          allowedAutoLinkedTodoId,
          suggestionId,
          e.source,
          e.source_session_id,
          e.repo,
          e.project_path,
          e.branch,
          JSON.stringify(e.pr_refs),
          JSON.stringify(e.issue_refs),
          JSON.stringify(e.files_changed),
          e.summary,
          e.confidence,
          e.occurred_at,
          now
        );
      } else if (!sameEvidence(existingEvidence, e)) {
        if (existing && !suggestionChanged) counts.updated += 1;
        taskbean.prepare(`
          UPDATE task_evidence
             SET repo = ?,
                 project_path = ?,
                 branch = ?,
                 pr_refs = ?,
                 issue_refs = ?,
                 files_changed = ?,
                 summary = ?,
                 confidence = ?,
                 occurred_at = ?
           WHERE id = ?
        `).run(
          e.repo,
          e.project_path,
          e.branch,
          JSON.stringify(e.pr_refs),
          JSON.stringify(e.issue_refs),
          JSON.stringify(e.files_changed),
          e.summary,
          e.confidence,
          e.occurred_at,
          existingEvidence.id
        );
      }
      if (allowedAutoLinkedTodoId && existingEvidence?.todo_id !== allowedAutoLinkedTodoId) {
        taskbean.prepare('UPDATE task_evidence SET todo_id = ? WHERE id = ?')
          .run(allowedAutoLinkedTodoId, existingEvidence?.id || e.id);
      }

      ids.push(suggestionId);
      options.onPersistStep?.({ index, suggestionId });
    }

    if (options.cursor) {
      const current = readCheckpoint(taskbean);
      const advance = !current || compareCursor(options.cursor, current) > 0;
      taskbean.prepare(`
        INSERT INTO reconciliation_checkpoints (source, last_changed_at, last_session_id, runs, last_run_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(source) DO UPDATE SET
          last_changed_at = CASE WHEN ? THEN excluded.last_changed_at ELSE last_changed_at END,
          last_session_id = CASE WHEN ? THEN excluded.last_session_id ELSE last_session_id END,
          runs = runs + 1,
          last_run_at = excluded.last_run_at,
          updated_at = excluded.updated_at
      `).run(
        SOURCE,
        options.cursor.last_changed_at,
        options.cursor.last_session_id,
        now,
        now,
        advance ? 1 : 0,
        advance ? 1 : 0
      );
      checkpoint = readCheckpoint(taskbean);
    }

    taskbean.exec('COMMIT');
  } catch (err) {
    taskbean.exec('ROLLBACK');
    throw err;
  }

  const rows = ids.length
    ? taskbean.prepare(
      `SELECT * FROM reconciliation_suggestions
        WHERE id IN (${ids.map(() => '?').join(',')})
        ORDER BY created_at, id`
    ).all(...ids)
    : [];
  return { ...counts, suggestions: rows.map(serializeSuggestion), checkpoint: serializeCheckpoint(checkpoint) };
}

const OBSERVE_DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const OBSERVE_MAX_WINDOW_DAYS = 31;
const SELF_SESSION_ENV = ['COPILOT_CLI_SESSION_ID', 'TASKBEAN_NATIVE_SESSION_ID'];

function parseLimit(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new Error(`--limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return n;
}

function parseExcludes(value, observe) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  const ids = raw.flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean);
  if (observe) {
    // Never treat the run that is doing the observing as evidence of work.
    for (const name of SELF_SESSION_ENV) {
      const id = String(process.env[name] || '').trim();
      if (id) ids.push(id);
    }
  }
  return new Set(ids);
}

function daysBetween(since, until) {
  return Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86400000);
}

function shiftDate(value, days) {
  const d = new Date(`${value}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function observeWindow(opts, checkpoint, notes) {
  if (opts.since) {
    const window = dateWindow(opts);
    if (daysBetween(window.since, window.until) > OBSERVE_MAX_WINDOW_DAYS) {
      throw new Error(`observe mode scans at most ${OBSERVE_MAX_WINDOW_DAYS} days; narrow --since/--until`);
    }
    return { ...window, useCursor: false };
  }
  const base = dateWindow({ until: opts.until });
  const cursorDate = String(checkpoint?.last_changed_at || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cursorDate)) return { ...base, useCursor: false };
  const floor = shiftDate(base.until, -OBSERVE_MAX_WINDOW_DAYS);
  if (cursorDate < floor) {
    notes.push(`checkpoint is older than ${OBSERVE_MAX_WINDOW_DAYS} days; changes before ${floor} were not scanned`);
    return { since: floor, until: base.until, useCursor: false };
  }
  if (cursorDate > base.until) return { since: base.until, until: base.until, useCursor: true };
  return { since: cursorDate, until: base.until, useCursor: true };
}

export function reconcileChronicleSessions(opts = {}) {
  const observe = Boolean(opts.observe);
  const mode = observe ? 'observe' : 'review';
  const limit = parseLimit(opts.limit, observe ? OBSERVE_DEFAULT_LIMIT : undefined);
  const excludes = parseExcludes(opts.excludeSession, observe);
  const notes = [];
  const priorCheckpoint = observe ? serializeCheckpoint(readCheckpoint(getDb())) : null;
  const { since, until, useCursor } = observe ? observeWindow(opts, priorCheckpoint, notes) : { ...dateWindow(opts), useCursor: false };
  const capabilities = discoverChronicleCapabilities(opts);
  const observeFields = observe
    ? { window_basis: 'change_time', checkpoint: priorCheckpoint, has_more: false, excluded: 0, notes }
    : {};
  const unavailable = (reason) => ({
    available: false,
    reason,
    mode,
    since,
    until,
    counts: { discovered: 0, created: 0, updated: 0, linked: 0, pending: 0 },
    suggestions: [],
    evidence: [],
    limitations: capabilities.limitations,
    ...observeFields,
  });

  if (capabilities.localSessionStore.status !== 'available') {
    return unavailable('local session-store database not available');
  }
  if (!capabilities.localSessionStore.tables?.sessions?.present) {
    return unavailable('local session-store sessions table not available');
  }

  let sessionDb;
  try {
    sessionDb = openSessionStore(opts);
    const scanned = readSessions(sessionDb, since, until, {
      observe,
      cursor: useCursor ? priorCheckpoint : null,
      limit: Number.isInteger(limit) ? limit + 1 : undefined,
    });
    const hasMore = Number.isInteger(limit) && scanned.length > limit;
    const window = hasMore ? scanned.slice(0, limit) : scanned;
    const sessions = window.filter(s => !excludes.has(s.sessionId));
    const suggestions = sessions.map(session => buildSuggestion(sessionDb, session));
    const last = window[window.length - 1];
    const cursor = !observe
      ? null
      : last
        ? { last_changed_at: last.changed_at, last_session_id: last.sessionId }
        : priorCheckpoint;
    const persisted = persistSuggestions(suggestions, {
      observe,
      cursor,
      onPersistStep: opts.onPersistStep,
    });
    const pending = persisted.suggestions.filter(s => s.state === 'pending').length;
    const result = {
      available: true,
      reason: null,
      mode,
      since,
      until,
      counts: {
        discovered: sessions.length,
        created: persisted.created,
        updated: persisted.updated,
        linked: persisted.linked,
        pending,
      },
      suggestions: persisted.suggestions,
      evidence: suggestions.map(s => s.evidence),
      limitations: capabilities.limitations,
    };
    if (observe) {
      Object.assign(result, {
        window_basis: 'change_time',
        checkpoint: persisted.checkpoint || priorCheckpoint,
        has_more: hasMore,
        excluded: window.length - sessions.length,
        notes,
      });
    } else if (hasMore) {
      result.has_more = true;
    }
    return result;
  } finally {
    if (sessionDb) {
      try { sessionDb.close(); } catch {}
    }
  }
}
