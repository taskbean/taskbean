// HostInfo — pure detection of the runtime environment shape.
//
// taskbean has to make different path decisions depending on whether it's
// running on bare Windows/macOS/Linux, inside WSL2, inside a dev container,
// inside a GitHub Codespace, or over SSH-remote. Concentrating that knowledge
// in one place (driven by env vars + a few file probes) makes every other
// module's path logic a pure function of an explicit `host` value — easy to
// test, easy to override.
//
// All inputs (env, fs probes, exec) are injectable for tests. Detection is
// memoized per-process; pass `{ fresh: true }` to bypass the cache.

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { homedir, platform } from 'os';

// WSL paths are always POSIX-style ("/mnt/c/Users/me"), so we deliberately
// use string concatenation rather than path.join — node:path on Windows
// would produce backslashes that won't resolve under WSL.
const posixJoin = (...parts) => parts.join('/').replace(/\/+/g, '/');

let _cached = null;

/**
 * @typedef {Object} HostInfo
 * @property {'windows'|'macos'|'linux'} os
 * @property {boolean} isWSL              Running inside WSL1 or WSL2.
 * @property {boolean} isDevcontainer     Running inside a dev container.
 * @property {boolean} isCodespaces       Running inside a GitHub Codespace.
 * @property {boolean} isSSHRemote        Connected via SSH (interactive remote).
 * @property {string|null} wslDistro      e.g. "Ubuntu" — null when not WSL.
 * @property {string|null} windowsHomeFromWSL  e.g. "/mnt/c/Users/me" — null when not WSL or unresolvable.
 * @property {string|null} windowsTaskbeanFromWSL  e.g. "/mnt/c/Users/me/.taskbean" — null when not WSL or parent unreachable.
 */

/**
 * Detect the host environment.
 * @param {Object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]   Defaults to process.env.
 * @param {Object} [opts.fs]               Test shim: { existsSync, readFileSync, readdirSync, statSync }.
 * @param {Function} [opts.exec]           Test shim for execSync(cmd, opts) → Buffer|string.
 * @param {string} [opts.platform]         Test shim for platform().
 * @param {boolean} [opts.fresh]           Bypass module-level cache.
 * @param {boolean} [opts.resolveWindowsHome] Resolve the Windows home for WSL (default true).
 * @returns {HostInfo}
 */
export function detectHost(opts = {}) {
  const cacheable = !opts.env && !opts.fs && !opts.exec && !opts.platform && opts.resolveWindowsHome !== false;
  if (_cached && !opts.fresh && cacheable) {
    return _cached;
  }

  const env = opts.env || process.env;
  const fs = opts.fs || { existsSync, readFileSync, readdirSync, statSync };
  const exec = opts.exec || execSync;
  const plat = opts.platform || platform();

  const os = plat === 'win32' ? 'windows' : plat === 'darwin' ? 'macos' : 'linux';

  const isWSL = _detectWSL(os, env, fs);
  const wslDistro = isWSL ? (env.WSL_DISTRO_NAME || null) : null;

  let windowsHomeFromWSL = null;
  let windowsTaskbeanFromWSL = null;
  if (isWSL && opts.resolveWindowsHome !== false) {
    windowsHomeFromWSL = _resolveWindowsHomeFromWSL(env, fs, exec);
    if (windowsHomeFromWSL) {
      const candidate = `${windowsHomeFromWSL}/.taskbean`;
      // Reachable iff the user dir itself exists. We don't require the
      // .taskbean folder to exist — the redirect creates it.
      if (_safeExists(fs, windowsHomeFromWSL)) {
        windowsTaskbeanFromWSL = candidate;
      }
    }
  }

  const isCodespaces = env.CODESPACES === 'true' || !!env.CODESPACE_NAME;
  const isDevcontainer =
    env.REMOTE_CONTAINERS === 'true'
    || env.DEVCONTAINER === 'true'
    || env.REMOTE_CONTAINERS_IPC != null
    || (os === 'linux' && _safeExists(fs, '/.dockerenv'));
  const isSSHRemote = !!(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);

  const info = {
    os,
    isWSL,
    isDevcontainer,
    isCodespaces,
    isSSHRemote,
    wslDistro,
    windowsHomeFromWSL,
    windowsTaskbeanFromWSL,
  };

  if (cacheable) {
    _cached = info;
  }
  return info;
}

/** Test-only: drop the module-level cache. */
export function _resetHostCache() { _cached = null; }

function _safeExists(fs, p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function _detectWSL(os, env, fs) {
  if (os !== 'linux') return false;
  // Strongest signal: WSL sets these by default on every shell.
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP || env.WSLENV != null) return true;
  // Fallback: kernel string.
  try {
    if (fs.existsSync('/proc/version')) {
      const v = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
      if (v.includes('microsoft') || v.includes('wsl')) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Resolve the Windows-side home directory from inside WSL.
 * Strategy (first hit wins):
 *   1. TASKBEAN_WINDOWS_HOME explicit override.
 *   2. `cmd.exe /C "echo %USERPROFILE%"` translated via `wslpath -u`.
 *   3. Enumerate /mnt/c/Users/ and pick the single non-system dir that
 *      contains a likely user marker (`.gitconfig`, `Desktop`, or `.taskbean`).
 * Returns the WSL POSIX path (e.g. "/mnt/c/Users/me") or null.
 */
function _resolveWindowsHomeFromWSL(env, fs, exec) {
  if (env.TASKBEAN_WINDOWS_HOME) return env.TASKBEAN_WINDOWS_HOME;

  // Strategy 2: ask Windows directly.
  try {
    const profile = exec('cmd.exe /C "echo %USERPROFILE%"', {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).toString().trim();
    if (profile && /^[A-Za-z]:\\/.test(profile)) {
      const posix = exec(`wslpath -u "${profile.replace(/"/g, '\\"')}"`, {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
      }).toString().trim();
      if (posix && _safeExists(fs, posix)) return posix;
    }
  } catch { /* fall through */ }

  // Strategy 3: enumerate /mnt/c/Users.
  const usersDir = '/mnt/c/Users';
  if (!_safeExists(fs, usersDir)) return null;
  const SYSTEM = new Set(['Public', 'Default', 'Default User', 'All Users', 'desktop.ini']);
  let candidates;
  try {
    candidates = fs.readdirSync(usersDir).filter((n) => !SYSTEM.has(n));
  } catch {
    return null;
  }

  // Prefer dirs that already have .taskbean.
  const withTaskbean = candidates.filter((n) => _safeExists(fs, posixJoin(usersDir, n, '.taskbean')));
  if (withTaskbean.length === 1) return posixJoin(usersDir, withTaskbean[0]);

  // Prefer dirs with typical user markers.
  const userish = candidates.filter((n) =>
    _safeExists(fs, posixJoin(usersDir, n, 'Desktop'))
    || _safeExists(fs, posixJoin(usersDir, n, '.gitconfig'))
  );
  if (userish.length === 1) return posixJoin(usersDir, userish[0]);

  return null;
}
