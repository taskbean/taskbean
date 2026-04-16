import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve, basename, dirname, isAbsolute, sep } from 'path';

/**
 * Resolve the project identity for the current working directory.
 * Priority: --project flag > .taskbean.json > git root > cwd
 *
 * --project accepts either a path (absolute or relative) OR a bare name.
 * A bare name (no path separator) is NOT joined with cwd — that would
 * create phantom nested paths like C:\dev\taskbean\taskbean. Instead we
 * fall through to the normal git-root/.taskbean.json detection and just
 * override the resulting name.
 */
export function resolveProject(projectOverride) {
  if (projectOverride) {
    const looksLikePath = isAbsolute(projectOverride)
      || projectOverride.includes('/')
      || projectOverride.includes('\\')
      || projectOverride.startsWith('.');
    if (looksLikePath) {
      const absPath = resolve(projectOverride);
      return { path: absPath, name: basename(absPath) };
    }
    // Bare name: keep the current directory as the canonical path, rename it.
    const detected = _detectProjectIdentity();
    return { path: detected.path, name: projectOverride };
  }
  return _detectProjectIdentity();
}

function _detectProjectIdentity() {
  // Walk up looking for .taskbean.json
  let dir = process.cwd();
  while (true) {
    const configPath = resolve(dir, '.taskbean.json');
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        return { path: dir, name: config.name || basename(dir) };
      } catch { /* ignore malformed config */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Try git root
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (gitRoot) {
      return { path: resolve(gitRoot), name: basename(gitRoot) };
    }
  } catch { /* not a git repo */ }

  // Fallback to cwd
  const cwd = process.cwd();
  return { path: cwd, name: basename(cwd) };
}
