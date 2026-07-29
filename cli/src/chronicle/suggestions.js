import { randomUUID } from 'crypto';
import { basename, isAbsolute } from 'path';
import { allRows, ensureProject, getDb, getRow, run } from '../data/store.js';
import { resolveProject } from '../data/project.js';
import { resolveTask } from '../data/resolve-task.js';

const STATES = new Set(['pending', 'approved', 'linked', 'ignored']);
const TASK_STATUSES = new Set(['pending', 'in_progress', 'blocked', 'done']);

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
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

function serializeSuggestion(row, evidence = []) {
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
    occurred_at: row.occurred_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    decided_at: row.decided_at,
    evidence: evidence.map(serializeEvidence),
  };
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
    occurred_at: row.occurred_at,
    created_at: row.created_at,
  };
}

function evidenceForSuggestion(suggestionId) {
  return allRows(
    'SELECT * FROM task_evidence WHERE suggestion_id = ? ORDER BY COALESCE(occurred_at, created_at), id',
    [suggestionId]
  );
}

function evidenceForSuggestionFromDb(db, suggestionId) {
  return db.prepare(
    'SELECT * FROM task_evidence WHERE suggestion_id = ? ORDER BY COALESCE(occurred_at, created_at), id'
  ).all(suggestionId);
}

function suggestionWithEvidence(row) {
  return serializeSuggestion(row, evidenceForSuggestion(row.id));
}

function suggestionWithEvidenceFromDb(db, row) {
  return serializeSuggestion(row, evidenceForSuggestionFromDb(db, row.id));
}

function resolveSuggestionFromDb(db, idOrPrefix) {
  const exact = db.prepare('SELECT * FROM reconciliation_suggestions WHERE id = ?').get(idOrPrefix);
  if (exact) return exact;
  if (idOrPrefix.length < 8) {
    fail('suggestion_not_found', `Suggestion ${idOrPrefix} not found`);
  }
  const matches = db.prepare(
    'SELECT * FROM reconciliation_suggestions WHERE id LIKE ? ORDER BY id',
  ).all(`${idOrPrefix}%`);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    fail('ambiguous_suggestion', `Suggestion id ${idOrPrefix} is ambiguous`);
  }
  fail('suggestion_not_found', `Suggestion ${idOrPrefix} not found`);
}

function resolveSuggestion(idOrPrefix) {
  return resolveSuggestionFromDb(getDb(), idOrPrefix);
}

function requirePending(suggestion) {
  if (suggestion.state !== 'pending') {
    fail('suggestion_already_decided', `Suggestion ${suggestion.id} is already ${suggestion.state}`);
  }
}

function normalizeTags(tags) {
  if (!tags) return '[]';
  return JSON.stringify(tags.split(',').map(t => t.trim()).filter(Boolean));
}

function validateTaskStatus(status) {
  const value = status || 'pending';
  if (!TASK_STATUSES.has(value)) {
    fail('invalid_status', `Task status must be one of: ${[...TASK_STATUSES].join(', ')}`);
  }
  return value;
}

function projectForApproval(suggestion, opts, evidenceRows = null) {
  if (opts.project) return projectFromOverride(opts.project);
  const evidence = (evidenceRows || evidenceForSuggestion(suggestion.id))[0];
  if (evidence?.project_path) {
    return {
      path: evidence.project_path,
      name: suggestion.suggested_project || basename(evidence.project_path),
    };
  }
  if (suggestion.suggested_project) return projectFromName(suggestion.suggested_project);
  return resolveProject();
}

function projectFromOverride(value) {
  const looksLikePath = isAbsolute(value)
    || value.includes('/')
    || value.includes('\\')
    || value.startsWith('.');
  if (looksLikePath) return resolveProject(value);
  return projectFromName(value);
}

function projectFromName(name) {
  const row = getRow(
    'SELECT name, path FROM projects WHERE name = ? ORDER BY tracked DESC, created_at DESC LIMIT 1',
    [name]
  );
  return row || { name, path: null };
}

function parseWorkDate(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail('invalid_work_date', '--work-date must be YYYY-MM-DD');
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('invalid_work_date', '--work-date must be a valid calendar date');
  }
  return `${value}T00:00:00.000Z`;
}

function createdAtForApproval(suggestion, evidenceRows, opts) {
  return parseWorkDate(opts.workDate)
    || evidenceRows.find(e => e.occurred_at)?.occurred_at
    || suggestion.occurred_at
    || new Date().toISOString();
}

export function listSuggestions(opts = {}) {
  const status = opts.status || 'pending';
  if (status !== 'all' && !STATES.has(status)) {
    fail('invalid_status', 'Suggestion status must be pending, approved, linked, ignored, or all');
  }

  const rows = status === 'all'
    ? allRows('SELECT * FROM reconciliation_suggestions ORDER BY state, COALESCE(occurred_at, created_at), id')
    : allRows('SELECT * FROM reconciliation_suggestions WHERE state = ? ORDER BY COALESCE(occurred_at, created_at), id', [status]);

  return {
    status,
    count: rows.length,
    suggestions: rows.map(suggestionWithEvidence),
  };
}

export function approveSuggestion(suggestionId, opts = {}) {
  const todoId = randomUUID();
  const db = getDb();
  let suggestion;
  db.exec('BEGIN IMMEDIATE');
  try {
    suggestion = resolveSuggestionFromDb(db, suggestionId);
    requirePending(suggestion);

    const evidenceRows = evidenceForSuggestionFromDb(db, suggestion.id);
    const status = validateTaskStatus(opts.status || suggestion.suggested_status || 'pending');
    const project = projectForApproval(suggestion, opts, evidenceRows);
    if (project.path && project.name) ensureProject(project.path, project.name);

    const now = new Date().toISOString();
    const createdAt = createdAtForApproval(suggestion, evidenceRows, opts);
    const title = opts.title || suggestion.suggested_title;
    const priority = opts.priority || 'none';
    const notes = opts.notes !== undefined ? opts.notes || null : null;
    const tags = normalizeTags(opts.tags);
    const completed = status === 'done' ? 1 : 0;

    db.prepare(`
      INSERT INTO todos (
        id, title, completed, source, priority, notes, tags,
        project, project_path, status, created_at
      ) VALUES (?, ?, ?, 'chronicle', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      todoId,
      title,
      completed,
      priority,
      notes,
      tags,
      project.name,
      project.path,
      status,
      createdAt
    );
    db.prepare(`
      UPDATE reconciliation_suggestions
         SET state = 'approved',
             linked_todo_id = ?,
             auto_linked = 0,
             decision_reason = NULL,
             decision_details = NULL,
             decided_at = ?,
             updated_at = ?
              WHERE id = ? AND state = 'pending'
    `).run(todoId, now, now, suggestion.id);
    db.prepare('UPDATE task_evidence SET todo_id = ? WHERE suggestion_id = ?')
      .run(todoId, suggestion.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const task = getRow('SELECT * FROM todos WHERE id = ?', [todoId]);
  const updated = getRow('SELECT * FROM reconciliation_suggestions WHERE id = ?', [suggestion.id]);
  return {
    action: 'approve',
    suggestion: suggestionWithEvidence(updated),
    task,
  };
}

export function linkSuggestion(suggestionId, todoId, opts = {}) {
  const project = resolveProject(opts.project);
  const db = getDb();
  let suggestion;
  let task;
  db.exec('BEGIN IMMEDIATE');
  try {
    suggestion = resolveSuggestionFromDb(db, suggestionId);
    requirePending(suggestion);
    task = resolveTask(todoId, project.name);
    if (!task) {
      fail('task_not_found', `Task ${todoId} not found`);
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE reconciliation_suggestions
         SET state = 'linked',
             linked_todo_id = ?,
             auto_linked = 0,
             decision_reason = NULL,
             decision_details = NULL,
             decided_at = ?,
             updated_at = ?
              WHERE id = ? AND state = 'pending'
    `).run(task.id, now, now, suggestion.id);
    db.prepare('UPDATE task_evidence SET todo_id = ? WHERE suggestion_id = ?')
      .run(task.id, suggestion.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const updated = getRow('SELECT * FROM reconciliation_suggestions WHERE id = ?', [suggestion.id]);
  return {
    action: 'link',
    suggestion: suggestionWithEvidence(updated),
    task: getRow('SELECT * FROM todos WHERE id = ?', [task.id]),
  };
}

export function ignoreSuggestion(suggestionId) {
  const db = getDb();
  let suggestion;
  db.exec('BEGIN IMMEDIATE');
  try {
    suggestion = resolveSuggestionFromDb(db, suggestionId);
    requirePending(suggestion);

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE reconciliation_suggestions
         SET state = 'ignored',
             auto_linked = 0,
             decision_reason = NULL,
             decision_details = NULL,
             decided_at = ?,
             updated_at = ?
       WHERE id = ? AND state = 'pending'
    `).run(now, now, suggestion.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const updated = getRow('SELECT * FROM reconciliation_suggestions WHERE id = ?', [suggestion.id]);
  return {
    action: 'ignore',
    suggestion: suggestionWithEvidence(updated),
  };
}

export function undoAutoLinkSuggestion(suggestionId) {
  const db = getDb();
  let suggestion;
  db.exec('BEGIN IMMEDIATE');
  try {
    suggestion = resolveSuggestionFromDb(db, suggestionId);
    if (suggestion.state !== 'linked' || !suggestion.auto_linked) {
      fail('suggestion_not_auto_linked', `Suggestion ${suggestion.id} is not an auto-linked suggestion`);
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE reconciliation_suggestions
         SET state = 'pending',
             linked_todo_id = NULL,
             auto_linked = 0,
             decision_reason = NULL,
             decision_details = NULL,
             decided_at = NULL,
             updated_at = ?
       WHERE id = ? AND state = 'linked' AND auto_linked = 1
    `).run(now, suggestion.id);
    db.prepare('UPDATE task_evidence SET todo_id = NULL WHERE suggestion_id = ?')
      .run(suggestion.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const updated = getRow('SELECT * FROM reconciliation_suggestions WHERE id = ?', [suggestion.id]);
  return {
    action: 'undo-auto-link',
    suggestion: suggestionWithEvidence(updated),
  };
}
