import { writeFileSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import { resolveProject } from '../data/project.js';

export async function initCommand(opts) {
  const project = resolveProject(undefined); // auto-detect
  const configPath = resolve(project.path, '.taskbean.json');

  if (existsSync(configPath) && !opts.force) {
    if (opts.json) {
      console.log(JSON.stringify({ status: 'exists', path: configPath }));
    } else {
      console.log(`⚠️  .taskbean.json already exists at ${configPath}`);
      console.log(`   Use --force to overwrite.`);
    }
    return;
  }

  const config = {
    name: opts.name || basename(project.path),
    version: 1,
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  if (opts.json) {
    console.log(JSON.stringify({ status: 'created', path: configPath, config }));
  } else {
    console.log(`🫘 Created .taskbean.json in ${project.path}`);
  }
}
