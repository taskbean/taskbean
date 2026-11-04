import { resolve } from 'path';
import { allRows } from './store.js';
import { resolveProject } from './project.js';
import { appendEvents } from './events.js';
import { deleteTaskFromProjectDb, upsertTaskToProjectDb } from './project-db.js';

function samePath(left, right) {
  if (!left || !right) return false;
  const normalize = value => {
    const path = resolve(value);
    return process.platform === 'win32' ? path.toLowerCase() : path;
  };
  return normalize(left) === normalize(right);
}

function taskProject(task, selectedProject) {
  if (task.project_path) {
    const project = samePath(task.project_path, selectedProject?.path)
      ? selectedProject
      : resolveProject(task.project_path);
    return { ...project, name: task.project || project.name };
  }
  if (selectedProject?.path && (!task.project || task.project === selectedProject.name)) {
    return selectedProject;
  }
  if (task.project) {
    const matches = allRows('SELECT path FROM projects WHERE name = ?', [task.project]);
    if (matches.length === 1) return { ...resolveProject(matches[0].path), name: task.project };
  }
  console.error(`[taskbean] Cannot determine the project for task ${task.id}; event history and cache were not updated.`);
  return null;
}

export function recordTaskEvents(project, task, events, { removed = false } = {}) {
  const target = taskProject(task, project);
  if (!target?.path) return;
  appendEvents({
    projectPath: target.path,
    projectUuid: target.projectUuid,
    projectName: target.name,
  }, events);
  if (removed) deleteTaskFromProjectDb(target.path, task.id);
  else upsertTaskToProjectDb(target.path, task);
}

export function recordTaskCreation(project, task, actor = undefined, { reopened = false } = {}) {
  const payload = {
    taskId: task.id,
    title: task.title,
    priority: task.priority || 'none',
    source: task.source,
    sessionId: task.session_id,
    agent: task.agent,
    agentSessionId: task.agent_session_id,
    emoji: task.emoji,
    dueTime: task.due_time,
    reminderFired: task.reminder_fired,
  };
  if (task.reminder) payload.remindAt = task.remind_at;
  else payload.upsertKey = task.upsert_key || null;

  const events = [{
    type: task.reminder ? 'task.remind' : 'task.add',
    payload,
    actor,
    ts: task.created_at,
  }];
  if (reopened) {
    events[0].payload.synthetic = true;
    events[0].payload.reason = 'reopen';
    events.unshift({ type: 'task.reopen', payload: { taskId: task.id } });
  }
  const fields = {};
  if (task.notes != null) fields.notes = task.notes;
  if (task.due_date != null) fields.dueDate = task.due_date;
  const tags = JSON.parse(task.tags || '[]');
  if (tags.length) fields.tags = tags;
  if (Object.keys(fields).length) {
    events.push({ type: 'task.update', payload: { taskId: task.id, fields } });
  }
  if (task.completed) {
    events.push({ type: 'task.complete', payload: { taskId: task.id } });
  }
  if (task.status === 'in_progress' || task.status === 'blocked') {
    events.push({
      type: task.status === 'blocked' ? 'task.block' : 'task.start',
      payload: { taskId: task.id },
    });
  }
  recordTaskEvents(project, task, events);
}
