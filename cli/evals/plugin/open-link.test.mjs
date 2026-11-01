import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CONTEXT, cliEntry, cliRoot, createSandbox, extensionDir, installFakeLauncher, loadExtension, rejectsWithCode, useEnv } from './support/harness.mjs';

const sandbox = createSandbox('open-link');
useEnv({ ...sandbox.env, TASKBEAN_CLI_ENTRY: cliEntry });
process.chdir(sandbox.dirs.project);

let calls = installFakeLauncher();
const { canvas, invoke } = await loadExtension();
const { rowActions } = await import(pathToFileURL(join(extensionDir, 'row-actions.mjs')).href);
const { runBean } = await import(pathToFileURL(join(extensionDir, 'bean-runner.mjs')).href);
const { buildLaunch, isLaunchableUrl, launchUrl, navigationSupport } = await import(pathToFileURL(join(extensionDir, 'link-launcher.mjs')).href);

const SESSION_ID = '4e0f6a52-1c3b-4d5e-8f90-a1b2c3d4e5f6';
const OTHER_SESSION = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const add = async (...args) => JSON.parse(await runBean(['add', ...args, '--json']));
const ledger = async () => JSON.parse(await runBean(['list', '--all', '--json']));

const sessionTask = await add('Resume me', '--agent', 'copilot', '--session-id', SESSION_ID);
const plainTask = await add('No session here');
const prTask = await add('Ship the PR');
await runBean(['edit', prTask.id, '--notes', 'Review https://github.com/octocat/hello-world/pull/42', '--json']);
await runBean(['done', prTask.id, '--json']);
let opened;

after(async () => {
  if (opened) await canvas.onClose({ ...CONTEXT });
  delete globalThis[Symbol.for('taskbean.dashboard.linkLauncher')];
  process.chdir(cliRoot);
  sandbox.cleanup();
});

function fresh(options) {
  calls = installFakeLauncher(options);
  return calls;
}

test('open_link session launches explorer with one ghapp argument and no shell', async () => {
  fresh();
  const before = await ledger();
  const result = await invoke('open_link', { target: 'session', taskId: sessionTask.id });
  assert.deepEqual(result, { opened: true, url: `ghapp://sessions/${SESSION_ID}` });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.command, join('C:\\Windows', 'explorer.exe'));
  assert.ok(Array.isArray(call.args));
  assert.deepEqual(call.args, [`ghapp://sessions/${SESSION_ID}`]);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.stdio, 'ignore');
  assert.equal(call.options.windowsHide, true);
  assert.deepEqual(await ledger(), before, 'opening a session does not change the ledger');
});

test('open_link session accepts a recorded session id without a task id', async () => {
  fresh();
  const result = await invoke('open_link', { target: 'session', sessionId: SESSION_ID });
  assert.equal(result.url, `ghapp://sessions/${SESSION_ID}`);
});

test('open_link rejects ids that are not trusted session UUIDs before any launch', async () => {
  fresh();
  const bad = [
    `${SESSION_ID}&calc`,
    'ghapp://sessions/x&calc',
    'x" & calc.exe & "',
    '$(calc)',
    '4e0f6a52-1c3b-0d5e-8f90-a1b2c3d4e5f6', // version 0
    '4e0f6a52-1c3b-6d5e-8f90-a1b2c3d4e5f6', // version 6
    '../../etc/passwd',
  ];
  for (const sessionId of bad) {
    await rejectsWithCode(invoke('open_link', { target: 'session', sessionId }), 'taskbean_link_unavailable');
  }
  await rejectsWithCode(invoke('open_link', { target: 'session', sessionId: OTHER_SESSION }), 'taskbean_link_unavailable');
  await rejectsWithCode(invoke('open_link', { target: 'session', taskId: plainTask.id }), 'taskbean_link_unavailable');
  await rejectsWithCode(invoke('open_link', { target: 'session', taskId: 'does-not-exist' }), 'taskbean_link_unavailable');
  await rejectsWithCode(invoke('open_link', { target: 'session', taskId: sessionTask.id, sessionId: OTHER_SESSION }), 'taskbean_link_unavailable');
  await rejectsWithCode(invoke('open_link', { target: 'url', url: 'https://evil.example' }), 'taskbean_link_unavailable');
  await rejectsWithCode(invoke('open_link', { target: 'session', url: `ghapp://sessions/${SESSION_ID}` }), 'taskbean_link_unavailable');
  assert.equal(calls.length, 0, 'nothing was launched');
});

test('open_link pull_request prefers ghapp and falls back to https without a handler', async () => {
  fresh();
  const app = await invoke('open_link', { target: 'pull_request', taskId: prTask.id });
  assert.equal(app.url, 'ghapp://github.com/octocat/hello-world/pull/42');
  fresh({ handler: (scheme) => scheme !== 'ghapp' });
  const web = await invoke('open_link', { target: 'pull_request', taskId: prTask.id });
  assert.equal(web.url, 'https://github.com/octocat/hello-world/pull/42');
  assert.deepEqual(calls.map((c) => c.args), [['https://github.com/octocat/hello-world/pull/42']]);
  await rejectsWithCode(invoke('open_link', { target: 'pull_request', taskId: plainTask.id }), 'taskbean_link_unavailable');
});

test('missing ghapp handler and spawn failures map to typed errors', async () => {
  fresh({ handler: false });
  await rejectsWithCode(invoke('open_link', { target: 'session', taskId: sessionTask.id }), 'taskbean_link_unavailable');
  assert.equal(calls.length, 0);
  fresh({ spawnError: 'ENOENT' });
  await rejectsWithCode(invoke('open_link', { target: 'session', taskId: sessionTask.id }), 'taskbean_link_failed');
});

test('HTTP open_link returns typed errors with status codes and never mutates tasks', async () => {
  fresh();
  opened = await canvas.open({ ...CONTEXT, input: {} });
  const before = await ledger();
  const post = (input) => fetch(new URL('/api/action', opened.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'open_link', input }),
  });
  const ok = await post({ target: 'session', taskId: sessionTask.id });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result.opened, true);

  const unavailable = await post({ target: 'session', taskId: plainTask.id });
  assert.equal(unavailable.status, 409);
  const body = (await unavailable.json()).error;
  assert.equal(body.code, 'taskbean_link_unavailable');
  assert.equal(body.retryable, false);

  fresh({ spawnError: 'EACCES' });
  const failed = await post({ target: 'session', taskId: sessionTask.id });
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).error.code, 'taskbean_link_failed');

  assert.deepEqual(await ledger(), before, 'link actions leave every task unchanged');
});

test('link launcher only allows canonical session and pull request URLs', async () => {
  const good = [
    `ghapp://sessions/${SESSION_ID}`,
    'ghapp://github.com/octocat/hello-world/pull/42',
    'https://github.com/octocat/hello-world/pull/42',
  ];
  for (const url of good) assert.ok(isLaunchableUrl(url), url);
  const bad = [
    `ghapp://sessions/${SESSION_ID.toUpperCase()}`,
    `ghapp://sessions/${SESSION_ID}&calc`,
    `ghapp://sessions/${SESSION_ID}/../x`,
    'ghapp://github.com/../hello-world/pull/42',
    'ghapp://github.com/octocat/../pull/42',
    'https://github.com/octocat/hello-world/pull/42?x=1',
    'http://github.com/octocat/hello-world/pull/42',
    'file:///C:/Windows/System32/calc.exe',
    'https://evil.example/octocat/hello-world/pull/42',
    'ghapp://github.com/octocat/hello world/pull/42',
  ];
  for (const url of bad) assert.equal(isLaunchableUrl(url), false, url);
  assert.throws(() => buildLaunch(bad[1]), { code: 'taskbean_link_unavailable' });
  assert.deepEqual(buildLaunch(good[0], { platform: 'darwin' }), { command: '/usr/bin/open', args: [good[0]] });
  assert.deepEqual(buildLaunch(good[0], { platform: 'linux' }), { command: 'xdg-open', args: [good[0]] });
  await assert.rejects(launchUrl(bad[1], { spawn: () => assert.fail('must not spawn') }), { code: 'taskbean_link_unavailable' });
});

test('non-Windows platforms report ghapp session links as unavailable instead of assuming a handler', async () => {
  for (const platform of ['darwin', 'linux']) {
    await assert.rejects(
      launchUrl(`ghapp://sessions/${SESSION_ID}`, { platform, spawn: () => assert.fail('must not spawn') }),
      { code: 'taskbean_link_unavailable', message: /only verified on Windows/ },
    );
    const nav = await navigationSupport({ platform });
    assert.equal(nav.sessions.available, false);
    assert.match(nav.sessions.reason, /only verified on Windows/);
    assert.equal(nav.pullRequests.fallback, 'https');
  }
  const win = await navigationSupport({ platform: 'win32', hasHandler: async () => true });
  assert.deepEqual(win.sessions, { available: true, reason: null });
});

test('dashboard and availability expose navigation support; rows degrade truthfully when unavailable', async () => {
  fresh({ handler: false });
  const dash = await invoke('get_dashboard', { period: 'all' });
  assert.equal(dash.navigation.sessions.available, false);
  const availability = await invoke('get_availability', {});
  assert.equal(availability.navigation.sessions.available, false);
  fresh();
  assert.equal((await invoke('get_dashboard', { period: 'all' })).navigation.sessions.available, true);

  const task = { id: 't1', status: 'blocked', origin: { session: { id: SESSION_ID, name: 'Fix auth' } } };
  const ok = rowActions(task, { sessions: { available: true } });
  assert.equal(ok.primary.kind, 'open');
  assert.equal(ok.primary.label, 'Review blocker');
  const degraded = rowActions(task, { sessions: { available: false, reason: 'No ghapp handler.' } });
  assert.equal(degraded.primary.kind, 'copy');
  assert.equal(degraded.primary.copy, 'session');
  assert.equal(degraded.primary.value, SESSION_ID);
  assert.equal(degraded.primary.label, 'Copy session ID');
  assert.match(degraded.primary.help, /Review blocker is unavailable: No ghapp handler\./);
  assert.ok(!degraded.secondary.some((x) => x.kind === 'open' && x.target === 'session'), 'no fake open-session items remain');
  const resume = rowActions({ ...task, status: 'in_progress' }, { sessions: { available: false, reason: 'x' } });
  assert.match(resume.primary.ariaLabel, /Resume is unavailable/);
});
