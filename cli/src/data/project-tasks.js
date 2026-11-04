import { allRows, getAliasPathsForUuid } from './store.js';

function pathKey(value) {
  if (!value) return value;
  return /^[A-Za-z]:[\\/]|^\\\\/.test(value)
    ? value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    : value.replace(/\/+$/, '') || '/';
}

function projectPaths(project) {
  const paths = [...new Set([project.path, ...(project.projectUuid
    ? getAliasPathsForUuid(project.projectUuid) : [])])];
  return { paths, pathKeys: new Set(paths.map(pathKey)) };
}

function hasConflictingProjectName(project, pathKeys) {
  return allRows('SELECT path, project_uuid FROM projects WHERE name = ?', [project.name])
    .some(row => !pathKeys.has(pathKey(row.path))
      && (!project.projectUuid || row.project_uuid !== project.projectUuid));
}

export function taskBelongsToProject(task, project) {
  const { pathKeys } = projectPaths(project);
  if (task.project_path) return pathKeys.has(pathKey(task.project_path));
  return task.project === project.name && !hasConflictingProjectName(project, pathKeys);
}

export function tasksForProject(project) {
  const { paths, pathKeys } = projectPaths(project);
  const placeholders = paths.map(() => '?').join(', ');
  const candidates = allRows(
    `SELECT * FROM todos WHERE project = ? OR project_path COLLATE NOCASE IN (${placeholders})`,
    [project.name, ...paths],
  );
  const legacy = candidates.filter(task => !task.project_path && task.project === project.name);
  if (legacy.length && hasConflictingProjectName(project, pathKeys)) {
    throw new Error(`Cannot assign legacy tasks for project "${project.name}": multiple projects share that name and some tasks have no project path`);
  }
  return candidates.filter(task => task.project_path
    ? pathKeys.has(pathKey(task.project_path))
    : task.project === project.name);
}
