import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve, basename, dirname, isAbsolute } from 'path';

function isWindowsAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value);
}

function basenameAny(value) {
  const normalized = String(value || '').replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || basename(normalized);
}

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
      || isWindowsAbsolutePath(projectOverride)
      || projectOverride.includes('/')
      || projectOverride.includes('\\')
      || projectOverride.startsWith('.');
    if (looksLikePath) {
      const absPath = isWindowsAbsolutePath(projectOverride)
        ? projectOverride
        : resolve(projectOverride);
      return { path: absPath, name: basenameAny(absPath) };
    }
    // Bare name: keep the current directory as the canonical path, rename it.
    const detected = _detectProjectIdentity();
    return { path: detected.path, name: projectOverride };
  }
  return _detectProjectIdentity();
}

export function resolveGitRoot(cwd = process.cwd()) {
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return gitRoot ? resolve(gitRoot) : null;
  } catch {
    return null;
  }
}

export function parseGitHubRepository(remoteUrl) {
  const value = String(remoteUrl || '').trim();
  const httpsMatch = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/i);
  const sshMatch = value.match(/^git@github\.com:([^/]+)\/([^/]+?)$/i);
  const match = httpsMatch || sshMatch;
  if (!match) return null;

  const owner = match[1];
  const repository = match[2].replace(/\.git$/i, '');
  if (!owner || !repository) return null;
  return `${owner}/${repository}`;
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
  const gitRoot = resolveGitRoot();
  if (gitRoot) return { path: gitRoot, name: basename(gitRoot) };

  // Fallback to cwd
  const cwd = process.cwd();
  return { path: cwd, name: basename(cwd) };
}
