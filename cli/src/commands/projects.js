import { existsSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { allRows, getRow, run } from '../data/store.js';
import { resolveProject } from '../data/project.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findProject(name) {
  if (name) {
    return getRow('SELECT * FROM projects WHERE name = ?', [name]);
  }
  const { name: resolved } = resolveProject();
  return getRow('SELECT * FROM projects WHERE name = ?', [resolved]);
}

// ---------------------------------------------------------------------------
// bean projects [list]
// ---------------------------------------------------------------------------

export function projectsCommand(opts) {
  const conditions = ['p.tracked = 1'];
  const params = [];

  if (opts.hidden) {
    conditions.push('p.hidden = 1');
  } else if (!opts.all) {
    conditions.push('p.hidden = 0');
  }

  if (opts.category) {
    conditions.push('p.category = ?');
    params.push(opts.category);
  }

  const where = conditions.join(' AND ');
  const projects = allRows(`
    SELECT p.*,
      (SELECT COUNT(*) FROM todos t WHERE t.project = p.name) as total_tasks,
      (SELECT COUNT(*) FROM todos t WHERE t.project = p.name AND t.completed = 1) as done_tasks,
      (SELECT COUNT(*) FROM todos t WHERE t.project = p.name AND t.completed = 0) as pending_tasks
    FROM projects p
    WHERE ${where}
    ORDER BY p.created_at DESC
  `, params);

  if (opts.json) {
    console.log(JSON.stringify(projects));
    return;
  }

  if (projects.length === 0) {
    console.log('No projects found.');
    return;
  }

  console.log('Projects:\n');
  for (const p of projects) {
    const badges = [];
    if (p.category) badges.push(p.category);
    if (p.hidden) badges.push('[hidden]');
    const suffix = badges.length ? `  ${badges.join(' ')}` : '';

    console.log(`  📁 ${p.name}${suffix}`);
    console.log(`     ${p.path}`);
    console.log(`     ${p.done_tasks}/${p.total_tasks} done, ${p.pending_tasks} pending\n`);
  }
}

// ---------------------------------------------------------------------------
// bean projects hide [name]
// ---------------------------------------------------------------------------

export function hideCommand(name, opts) {
  const project = findProject(name);
  if (!project) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'Project not found' }));
    } else {
      console.error('Error: project not found.');
    }
    process.exitCode = 1;
    return;
  }

  run('UPDATE projects SET hidden = 1 WHERE name = ?', [project.name]);

  if (opts.json) {
    console.log(JSON.stringify({ name: project.name, hidden: true }));
  } else {
    console.log(`Project "${project.name}" is now hidden.`);
  }
}

// ---------------------------------------------------------------------------
// bean projects show [name]
// ---------------------------------------------------------------------------

export function showCommand(name, opts) {
  const project = findProject(name);
  if (!project) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'Project not found' }));
    } else {
      console.error('Error: project not found.');
    }
    process.exitCode = 1;
    return;
  }

  run('UPDATE projects SET hidden = 0 WHERE name = ?', [project.name]);

  if (opts.json) {
    console.log(JSON.stringify({ name: project.name, hidden: false }));
  } else {
    console.log(`Project "${project.name}" is now visible.`);
  }
}

// ---------------------------------------------------------------------------
// bean projects categorize [name] --category <label> | --clear
// ---------------------------------------------------------------------------

export function categorizeCommand(name, opts) {
  if (!opts.category && !opts.clear) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'Provide --category <label> or --clear' }));
    } else {
      console.error('Error: provide --category <label> or --clear.');
    }
    process.exitCode = 1;
    return;
  }

  const project = findProject(name);
  if (!project) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'Project not found' }));
    } else {
      console.error('Error: project not found.');
    }
    process.exitCode = 1;
    return;
  }

  const newCategory = opts.clear ? null : opts.category;
  run('UPDATE projects SET category = ? WHERE name = ?', [newCategory, project.name]);

  if (opts.json) {
    console.log(JSON.stringify({ name: project.name, category: newCategory }));
  } else if (newCategory) {
    console.log(`Project "${project.name}" categorized as "${newCategory}".`);
  } else {
    console.log(`Category cleared for project "${project.name}".`);
  }
}

// ---------------------------------------------------------------------------
// bean projects delete [name] --confirm [--keep-files]
// ---------------------------------------------------------------------------

export function deleteCommand(name, opts) {
  if (!opts.confirm) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'Pass --confirm to delete' }));
    } else {
      console.error('Warning: this permanently deletes the project record.');
      console.error('Re-run with --confirm to proceed.');
    }
    process.exitCode = 1;
    return;
  }

  const project = findProject(name);
  if (!project) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'Project not found' }));
    } else {
      console.error('Error: project not found.');
    }
    process.exitCode = 1;
    return;
  }

  run('DELETE FROM projects WHERE name = ?', [project.name]);

  const removed = [];
  if (!opts.keepFiles && project.path) {
    const projectDir = resolve(project.path);

    const configFile = join(projectDir, '.taskbean.json');
    if (existsSync(configFile)) {
      rmSync(configFile);
      removed.push(configFile);
    }

    const skillDirs = [
      join(projectDir, '.agents', 'skills', 'taskbean'),
      join(projectDir, '.github', 'skills', 'taskbean'),
      join(projectDir, '.claude', 'skills', 'taskbean'),
    ];
    for (const dir of skillDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ name: project.name, deleted: true, removed }));
  } else {
    console.log(`Project "${project.name}" deleted.`);
    if (removed.length) {
      for (const f of removed) console.log(`  removed ${f}`);
    }
  }
}
