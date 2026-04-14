import { allRows, getRow } from './store.js';

/**
 * Resolve a task by ID or positional index (#1, #2, 1, 2, etc.)
 * Positional = Nth task in the current project, ordered by created_at DESC
 */
export function resolveTask(idOrIndex, project) {
  // If it looks like a UUID or t_ id, look up directly
  if (idOrIndex.startsWith('t_') || idOrIndex.length > 10) {
    return getRow('SELECT * FROM todos WHERE id = ?', [idOrIndex]);
  }

  // Try as positional index
  const index = parseInt(idOrIndex.replace(/^#/, ''), 10);
  if (!isNaN(index) && index > 0 && project) {
    const tasks = allRows(
      'SELECT * FROM todos WHERE project = ? ORDER BY created_at DESC',
      [project]
    );
    if (index <= tasks.length) {
      return tasks[index - 1];
    }
  }

  // Fallback: try as raw ID
  return getRow('SELECT * FROM todos WHERE id = ?', [idOrIndex]);
}
