import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installSdkStub } from './sdk-hooks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..', '..', '..');
export const cliRoot = join(repoRoot, 'cli');
export const cliEntry = join(cliRoot, 'bin', 'taskbean.js');
export const extensionDir = join(repoRoot, 'extensions', 'taskbean-dashboard');
export const fakeCli = join(here, 'fake-cli.mjs');

// Titles from #119/#120 plus shell metacharacters that broke the cmd path.
export const REGRESSION_TITLES = [
  'Plain title',
  'Bug bash GHCP harness private preview scenarios',
  'Quote "x" test',
  '50% done & ^caret',
  'Curly \u2019 apostrophe',
  '%PATH% & echo pwned',
];

const realHome = homedir();

function systemPath() {
  if (process.platform === 'win32') return [join(process.env.SystemRoot || 'C:\\Windows', 'System32')];
  return ['/usr/bin', '/bin'];
}

// Builds throwaway HOME/USERPROFILE/COPILOT_HOME/TASKBEAN_HOME directories and an
// env built from scratch, so no vendor session variables or live installs leak in.
export function createSandbox(name = 'eval') {
  const root = mkdtempSync(join(tmpdir(), `taskbean-plugin-${name}-`));
  const home = join(root, 'home');
  const dirs = {
    root,
    home,
    copilot: join(home, '.copilot'),
    taskbean: join(home, '.taskbean'),
    bin: join(root, 'bin'),
    empty: join(root, 'empty'),
    project: join(root, 'projects', 'eval-project'),
    tmp: join(root, 'tmp'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

  const env = {
    PATH: [dirs.bin, dirname(process.execPath), ...systemPath()].join(delimiter),
    HOME: home,
    USERPROFILE: home,
    COPILOT_HOME: dirs.copilot,
    TASKBEAN_HOME: dirs.taskbean,
    TASKBEAN_DB: join(dirs.taskbean, 'taskbean.db'),
    TASKBEAN_NO_UPGRADE_NOTICE: '1',
    CI: '1',
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
    TMPDIR: dirs.tmp,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
  };
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot || 'C:\\Windows';
    env.windir = env.SystemRoot;
    env.ComSpec = process.env.ComSpec || join(env.SystemRoot, 'System32', 'cmd.exe');
    env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  }

  assert.notEqual(resolve(env.HOME), resolve(realHome), 'sandbox HOME must not be the real home');
  return {
    dirs,
    env,
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

// Replaces process.env in place. Each node --test file runs in its own process.
export function useEnv(env) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
}

// Fake npm-style global install: <bin>/bean(.cmd) next to node_modules/taskbean.
export function writeFakePackage(binDir, entrySource) {
  const pkg = join(binDir, 'node_modules', 'taskbean');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'taskbean', version: '0.0.0-eval', type: 'module' }));
  writeFileSync(join(pkg, 'bin', 'taskbean.js'), entrySource);
  writeShim(binDir, join(pkg, 'bin', 'taskbean.js'));
  return join(pkg, 'bin', 'taskbean.js');
}

export function writeShim(binDir, target) {
  if (process.platform === 'win32') {
    writeFileSync(join(binDir, 'bean.cmd'), `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`);
  } else {
    writeFileSync(join(binDir, 'bean'), `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n`, { mode: 0o755 });
  }
}

export const CONTEXT = {
  instanceId: 'taskbean-eval',
  extensionId: 'plugin:taskbean:taskbean-dashboard',
  canvasId: 'taskbean-dashboard',
};

export const LINK_LAUNCHER = Symbol.for('taskbean.dashboard.linkLauncher');

// Records launches instead of starting a real OS handler. Tests can replace it.
export function installFakeLauncher({ handler = true, spawnError = null } = {}) {
  const calls = [];
  globalThis[LINK_LAUNCHER] = {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    hasHandler: async (scheme) => (typeof handler === 'function' ? handler(scheme) : handler),
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const listeners = {};
      const child = {
        once(event, fn) { listeners[event] = fn; return child; },
        unref() { child.unrefed = true; },
      };
      queueMicrotask(() => (spawnError ? listeners.error?.(Object.assign(new Error('spawn failed'), { code: spawnError })) : listeners.spawn?.()));
      return child;
    },
  };
  return calls;
}

export async function loadExtension(dir = extensionDir) {
  installSdkStub();
  if (!globalThis[LINK_LAUNCHER]) installFakeLauncher();
  await import(pathToFileURL(join(dir, 'extension.mjs')).href);
  const captured = globalThis.__taskbeanEval;
  const canvas = captured.canvases.at(-1);
  assert.equal(canvas.id, 'taskbean-dashboard');
  const actions = new Map(canvas.actions.map((action) => [action.name, action]));
  const invoke = (name, input = {}) => {
    const action = actions.get(name);
    assert.ok(action, `canvas action ${name} is declared`);
    return action.handler({ ...CONTEXT, input });
  };
  return { canvas, actions, invoke, captured };
}

export async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'CanvasError', `expected CanvasError, got ${error.name}: ${error.message}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}
