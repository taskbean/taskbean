import { existsSync, mkdirSync, symlinkSync, copyFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_SOURCE = join(__dirname, '..', '..', '.agents', 'skills', 'taskbean', 'SKILL.md');

export async function installCommand(opts) {
  const isGlobal = opts.global;

  let targetDir;
  if (isGlobal) {
    targetDir = join(homedir(), '.agents', 'skills', 'taskbean');
  } else {
    targetDir = join(process.cwd(), '.agents', 'skills', 'taskbean');
  }

  // Create directories if missing
  if (!existsSync(dirname(targetDir))) {
    mkdirSync(dirname(targetDir), { recursive: true });
  }
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const targetFile = join(targetDir, 'SKILL.md');

  if (existsSync(targetFile)) {
    if (opts.json) {
      console.log(JSON.stringify({ status: 'already_installed', path: targetFile }));
    } else {
      console.log(`✅ Agent skill already installed at ${targetDir}`);
    }
    return;
  }

  // Try symlink first, fall back to copy (Windows symlinks need admin/dev mode)
  try {
    symlinkSync(SKILL_SOURCE, targetFile);
    if (opts.json) {
      console.log(JSON.stringify({ status: 'installed', method: 'symlink', path: targetFile }));
    } else {
      console.log(`🔗 Agent skill linked at ${targetDir}`);
    }
  } catch {
    copyFileSync(SKILL_SOURCE, targetFile);
    if (opts.json) {
      console.log(JSON.stringify({ status: 'installed', method: 'copy', path: targetFile }));
    } else {
      console.log(`📋 Agent skill copied to ${targetDir}`);
    }
  }
}
