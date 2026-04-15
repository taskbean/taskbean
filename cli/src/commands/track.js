import { writeFileSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import { run, getRow, ensureProject } from '../data/store.js';
import { resolveProject } from '../data/project.js';
import { installCommand } from './install.js';

export function trackCommand(opts) {
  // --global: install skill globally and return
  if (opts.global) {
    installCommand({ json: opts.json, global: true });
    return;
  }

  const targetPath = opts.path || process.cwd();
  const project = resolveProject(targetPath);
  ensureProject(project.path, project.name);

  // Mark as tracked
  run('UPDATE projects SET tracked = 1 WHERE path = ?', [project.path]);

  // Auto-create .taskbean.json if missing
  const configPath = resolve(project.path, '.taskbean.json');
  if (!existsSync(configPath)) {
    const config = { name: opts.name || basename(project.path), version: 1 };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }

  // Auto-install agent skill into the project
  const originalCwd = process.cwd();
  try {
    process.chdir(project.path);
    installCommand({ json: opts.json, global: false });
    run('UPDATE projects SET skill_installed = 1 WHERE path = ?', [project.path]);
  } catch (e) {
    if (!opts.json) {
      console.error(`⚠️  Could not install agent skill: ${e.message}`);
    }
  } finally {
    process.chdir(originalCwd);
  }

  if (opts.json) {
    const proj = getRow('SELECT * FROM projects WHERE path = ?', [project.path]);
    console.log(JSON.stringify(proj));
  } else {
    console.log(`📍 Now tracking: ${project.name} (${project.path})`);
  }
}

export function untrackCommand(opts) {
  const targetPath = opts.path || process.cwd();
  const project = resolveProject(targetPath);

  const existing = getRow('SELECT * FROM projects WHERE path = ?', [project.path]);
  if (!existing) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'not_found', message: `Project not tracked: ${project.path}` }));
    } else {
      console.error(`❌ Project not tracked: ${project.path}`);
    }
    process.exitCode = 1;
    return;
  }

  run('UPDATE projects SET tracked = 0 WHERE id = ?', [existing.id]);

  if (opts.json) {
    console.log(JSON.stringify({ status: 'untracked', project: project.name }));
  } else {
    console.log(`📍 Stopped tracking: ${project.name}`);
  }
}
