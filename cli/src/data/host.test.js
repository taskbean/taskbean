import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { detectHost } from './host.js';
import { resolveDbPaths } from './store.js';

test('explicit data locations and disabled WSL redirect do not probe the host', () => {
  const noProbe = () => { throw new Error('host must not be probed'); };
  assert.equal(resolveDbPaths({ TASKBEAN_DB: join('fixture', 'custom.db') }, noProbe, 'home').path,
    join('fixture', 'custom.db'));
  assert.equal(resolveDbPaths({ TASKBEAN_HOME: 'fixture' }, noProbe, 'home').path,
    join('fixture', 'taskbean.db'));
  assert.equal(resolveDbPaths({ TASKBEAN_NO_WSL_REDIRECT: '1' }, noProbe, 'home').path,
    join('home', '.taskbean', 'taskbean.db'));
});

test('WSL event metadata detection does not discover Windows profiles', () => {
  const inspected = [];
  const host = detectHost({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'synthetic' },
    fs: {
      existsSync: path => { inspected.push(path); return false; },
      readFileSync: () => { throw new Error('unexpected read'); },
      readdirSync: () => { throw new Error('unexpected enumeration'); },
      statSync: () => { throw new Error('unexpected stat'); },
    },
    exec: () => { throw new Error('unexpected Windows profile lookup'); },
    resolveWindowsHome: false,
  });
  assert.equal(host.isWSL, true);
  assert.equal(host.windowsHomeFromWSL, null);
  assert.ok(!inspected.some(path => path.startsWith('/mnt/c/Users')));
});

test('WSL redirection and explicit overrides retain their precedence', () => {
  const wsl = () => ({
    isWSL: true,
    windowsTaskbeanFromWSL: '/synthetic/windows/.taskbean',
    windowsHomeFromWSL: '/synthetic/windows',
  });
  const redirected = resolveDbPaths({}, wsl, '/synthetic/linux');
  assert.equal(redirected.path, join('/synthetic/windows/.taskbean', 'taskbean.db'));
  assert.equal(redirected.redirected, true);
  const local = resolveDbPaths({ TASKBEAN_NO_WSL_REDIRECT: '1' }, wsl, '/synthetic/linux');
  assert.equal(local.path, join('/synthetic/linux', '.taskbean', 'taskbean.db'));
  assert.equal(local.redirected, false);
});
