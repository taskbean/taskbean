import { createHash } from 'crypto';
import { basename } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { discoverChronicleCapabilities } from './adapter.js';
import { getDb } from '../data/store.js';

const SOURCE = 'copilot-session-store';

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

function projectNameFor(session) {
  if (session.repository) {
    const repo = String(session.repository).split(/[\\/]/).filter(Boolean).pop();
    if (repo) return repo.replace(/\.git$/, '');
  }
  if (session.cwd) return basename(session.cwd);
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

function readSessions(db, since, until) {
  if (!hasTable(db, 'sessions')) return [];
  const cols = tableColumns(db, 'sessions');
  const when = timeExpr(cols);
  if (!when) return [];

  const rows = readRows(
    db,
    `SELECT ${selectExpr(cols, ['id', 'native_id', 'session_id'], 'sessionId')},
            ${selectExpr(cols, ['cwd', 'project_path'], 'cwd')},
            ${selectExpr(cols, ['repository', 'repo'], 'repository')},
            ${selectExpr(cols, ['branch', 'git_branch'], 'branch')},
            ${selectExpr(cols, ['title'], 'title')},
            ${selectExpr(cols, ['summary'], 'summary')},
            ${when} AS occurred_at
       FROM sessions
      WHERE date(${when}) BETWEEN ? AND ?
      ORDER BY occurred_at, sessionId`,
    [since, until]
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

  return {
    id: suggestionId,
    evidence_key: evidenceKey,
    suggested_title: suggestionTitle(session, summary),
    suggested_project: projectNameFor(session),
    suggested_status: 'pending',
    source_session_ids: [sourceSessionId],
    evidence_summary: evidenceSummary(session, refs, files, summary),
    confidence,
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
  };
}

function sameSuggestion(existing, suggestion) {
  return existing.suggested_title === suggestion.suggested_title
    && existing.suggested_project === suggestion.suggested_project
    && existing.suggested_status === suggestion.suggested_status
    && existing.source_session_ids === JSON.stringify(suggestion.source_session_ids)
    && existing.evidence_summary === suggestion.evidence_summary
    && Number(existing.confidence) === suggestion.confidence;
}

function sameEvidence(existing, evidence) {
  return existing.repo === evidence.repo
    && existing.project_path === evidence.project_path
    && existing.branch === evidence.branch
    && existing.pr_refs === JSON.stringify(evidence.pr_refs)
    && existing.issue_refs === JSON.stringify(evidence.issue_refs)
    && existing.files_changed === JSON.stringify(evidence.files_changed)
    && existing.summary === evidence.summary
    && Number(existing.confidence) === evidence.confidence;
}

function persistSuggestions(suggestions) {
  const taskbean = getDb();
  const now = new Date().toISOString();
  const counts = { created: 0, updated: 0 };
  const ids = [];

  taskbean.exec('BEGIN IMMEDIATE');
  try {
    for (const suggestion of suggestions) {
      const existing = taskbean.prepare(
        'SELECT * FROM reconciliation_suggestions WHERE evidence_key = ?'
      ).get(suggestion.evidence_key);

      const suggestionChanged = !existing || !sameSuggestion(existing, suggestion);
      const suggestionId = existing?.id || suggestion.id;

      if (!existing) {
        counts.created += 1;
      } else if (suggestionChanged) {
        counts.updated += 1;
      }

      if (!existing) {
        taskbean.prepare(`
          INSERT INTO reconciliation_suggestions (
            id, evidence_key, suggested_title, suggested_project, suggested_status,
            source_session_ids, evidence_summary, confidence, state,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `).run(
          suggestion.id,
          suggestion.evidence_key,
          suggestion.suggested_title,
          suggestion.suggested_project,
          suggestion.suggested_status,
          JSON.stringify(suggestion.source_session_ids),
          suggestion.evidence_summary,
          suggestion.confidence,
          now,
          now
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
                 updated_at = ?
           WHERE id = ?
        `).run(
          suggestion.suggested_title,
          suggestion.suggested_project,
          suggestion.suggested_status,
          JSON.stringify(suggestion.source_session_ids),
          suggestion.evidence_summary,
          suggestion.confidence,
          now,
          suggestionId
        );
      }

      const e = suggestion.evidence;
      const existingEvidence = taskbean.prepare(
        'SELECT * FROM task_evidence WHERE source = ? AND source_session_id = ? AND suggestion_id = ?'
      ).get(e.source, e.source_session_id, suggestionId);

      if (!existingEvidence) {
        taskbean.prepare(`
          INSERT INTO task_evidence (
            id, suggestion_id, source, source_session_id, repo, project_path, branch,
            pr_refs, issue_refs, files_changed, summary, confidence, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          e.id,
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
                 confidence = ?
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
          existingEvidence.id
        );
      }

      ids.push(suggestionId);
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
  return { ...counts, suggestions: rows.map(serializeSuggestion) };
}

export function reconcileChronicleSessions(opts = {}) {
  const { since, until } = dateWindow(opts);
  const capabilities = discoverChronicleCapabilities(opts);
  const unavailable = (reason) => ({
    available: false,
    reason,
    since,
    until,
    counts: { discovered: 0, created: 0, updated: 0, pending: 0 },
    suggestions: [],
    evidence: [],
    limitations: capabilities.limitations,
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
    const sessions = readSessions(sessionDb, since, until);
    const suggestions = sessions.map(session => buildSuggestion(sessionDb, session));
    const persisted = persistSuggestions(suggestions);
    const pending = persisted.suggestions.filter(s => s.state === 'pending').length;
    return {
      available: true,
      reason: null,
      since,
      until,
      counts: {
        discovered: sessions.length,
        created: persisted.created,
        updated: persisted.updated,
        pending,
      },
      suggestions: persisted.suggestions,
      evidence: suggestions.map(s => s.evidence),
      limitations: capabilities.limitations,
    };
  } finally {
    if (sessionDb) {
      try { sessionDb.close(); } catch {}
    }
  }
}
