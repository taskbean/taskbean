import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { resolve, basename, dirname, isAbsolute } from 'path';

/** Resolve existing paths and case-fold on Windows for identity matching. */
export function canonicalCwd(path) {
  if (!path) return null;
  let resolved;
  try {
    resolved = realpathSync(path);
  } catch {
    resolved = path;
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWindowsAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value);
}

function basenameAny(value) {
  const normalized = String(value || '').replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || basename(normalized);
}

function replaceProjectIdentity(source, target) {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)
          || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/**
 * Resolve the project identity for the current working directory.
 * Priority: --project flag > project identity > .taskbean.json > git root > cwd
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
      return { path: absPath, name: basenameAny(absPath), projectUuid: readProjectUuid(absPath) };
    }
    // Bare name: keep the current directory as the canonical path, rename it.
    const detected = _detectProjectIdentity();
    return { path: detected.path, name: projectOverride, projectUuid: detected.projectUuid };
  }
  return _detectProjectIdentity();
}

export function readProjectUuid(projectPath) {
  if (!projectPath || (process.platform !== 'win32' && isWindowsAbsolutePath(projectPath))) return null;
  const jsonPath = resolve(projectPath, '.taskbean', 'project.json');
  if (!existsSync(jsonPath)) return null;
  let config;
  try {
    config = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  } catch (error) {
    throw new Error(`Cannot read project identity at ${jsonPath}: ${error.message}`, { cause: error });
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Invalid project identity at ${jsonPath}`);
  }
  return typeof config.projectId === 'string' && config.projectId ? config.projectId : null;
}

export function ensureProjectUuid(projectPath) {
  const existing = readProjectUuid(projectPath);
  if (existing) return existing;

  const dir = resolve(projectPath, '.taskbean');
  const jsonPath = resolve(dir, 'project.json');
  mkdirSync(dir, { recursive: true });
  const lockPath = resolve(dir, 'project.json.lock');
  const deadline = Date.now() + 5000;
  let lock;
  while (lock === undefined) {
    try {
      lock = openSync(lockPath, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for project identity lock ${lockPath}; verify no tracking process is running before removing it`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  const tmpPath = resolve(dir, `project.json.${randomUUID()}.tmp`);
  try {
    const racedUuid = readProjectUuid(projectPath);
    if (racedUuid) return racedUuid;
    const config = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf-8')) : {};
    const uuid = randomUUID();
    writeFileSync(tmpPath, JSON.stringify({ ...config, projectId: uuid, version: 1 }, null, 2) + '\n', { flag: 'wx' });
    replaceProjectIdentity(tmpPath, jsonPath);
    return uuid;
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

export function resolveProjectUuid(cwd) {
  let dir = resolve(cwd || process.cwd());
  while (true) {
    const uuid = readProjectUuid(dir);
    if (uuid) return { projectPath: dir, uuid };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function _detectProjectIdentity() {
  // Walk up to the nearest identity or legacy configuration.
  let dir = process.cwd();
  while (true) {
    const uuid = readProjectUuid(dir);
    const configPath = resolve(dir, '.taskbean.json');
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        return { path: dir, name: config.name || basename(dir), projectUuid: uuid };
      } catch { /* ignore malformed config */ }
    }
    if (uuid) return { path: dir, name: basename(dir), projectUuid: uuid };
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
      const path = resolve(gitRoot);
      return { path, name: basename(path), projectUuid: readProjectUuid(path) };
    }
  } catch { /* not a git repo */ }

  // Fallback to cwd
  const cwd = process.cwd();
  return { path: cwd, name: basename(cwd), projectUuid: null };
}
