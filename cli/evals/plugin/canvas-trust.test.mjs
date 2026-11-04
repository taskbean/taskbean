import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, test } from 'node:test';
import { CONTEXT, canvasRequestHeaders, cliEntry, cliRoot, createSandbox, installFakeLauncher, loadExtension, useEnv } from './support/harness.mjs';

const sandbox = createSandbox('canvas-trust');
useEnv({ ...sandbox.env, TASKBEAN_CLI_ENTRY: cliEntry });
process.chdir(sandbox.dirs.project);
const calls = installFakeLauncher();
const { canvas, invoke } = await loadExtension();
const opened = await canvas.open({ ...CONTEXT, input: {} });
const endpoint = new URL('/api/action', opened.url);
const headers = canvasRequestHeaders(opened.url);
const snapshot = async () => (await invoke('get_dashboard', { period: 'all' })).tasks;
const post = (extra = {}, action = 'add_task', input = { title: 'Must not be created' }) =>
  fetch(endpoint, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ action, input }) });

after(async () => {
  await canvas.onClose(CONTEXT);
  delete globalThis[Symbol.for('taskbean.dashboard.linkLauncher')];
  process.chdir(cliRoot);
  sandbox.cleanup();
});

test('authorized canvas JSON and native SDK actions still work', async () => {
  // The host embeds this page cross-site; only its own action fetches are same-origin.
  const page = await fetch(opened.url, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const response = await post({ 'Sec-Fetch-Site': 'same-origin' }, 'add_task', { title: 'Authorized browser outcome' });
  assert.equal(response.status, 200);
  const task = (await response.json()).result;
  assert.equal(task.title, 'Authorized browser outcome');
  assert.equal((await invoke('complete_task', { id: task.id })).status, 'done');
});

test('cross-origin, opaque-origin, rebinding and missing capabilities cannot invoke actions', async () => {
  const before = await snapshot();
  const cases = [
    { Origin: 'https://attacker.example' },
    { Origin: 'null' },
    { Origin: 'http://127.0.0.1:1' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'X-Taskbean-Token': '' },
    { 'X-Taskbean-Token': 'wrong' },
  ];
  for (const extra of cases) {
    for (const action of ['add_task', 'open_link', 'observe_evidence']) {
      const response = await post(extra, action);
      assert.equal(response.status, 403, `${JSON.stringify(extra)}: ${action}`);
      assert.equal((await response.json()).error.code, 'taskbean_request_forbidden');
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
    // fetch rewrites Host; use a raw HTTP request to exercise DNS-rebinding protection.
    const rebinding = await new Promise((resolve, reject) => {
      const req = request(endpoint, { method: 'POST', headers: { ...headers, Host: 'attacker.example' } }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end('{"action":"add_task","input":{"title":"Rebinding attack"}}');
    });
    assert.equal(rebinding, 403);
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(calls.length, 0);
});

test('simple forms, text/plain and preflights are rejected without side effects', async () => {
  const before = await snapshot();
  for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=test', 'text/plain', '']) {
    const response = await post({ 'Content-Type': type });
    assert.equal(response.status, 415);
    assert.equal((await response.json()).error.code, 'taskbean_json_required');
  }
  const simple = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: 'https://attacker.example' }, body: '{"action":"add_task","input":{"title":"Attack"}}' });
  assert.equal(simple.status, 403);
  const preflight = await fetch(endpoint, { method: 'OPTIONS', headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await snapshot(), before);
});

test('page bootstrap requires its per-server capability and tokens cannot cross servers', async () => {
  const denied = await fetch(new URL('/', opened.url));
  assert.equal(denied.status, 403);
  const secondContext = { ...CONTEXT, instanceId: 'second-trust-canvas' };
  const second = await canvas.open({ ...secondContext, input: {} });
  try {
    assert.notEqual(new URL(second.url).searchParams.get('token'), new URL(opened.url).searchParams.get('token'));
    const response = await fetch(new URL('/api/action', second.url), {
      method: 'POST',
      headers: { ...headers, Origin: new URL(second.url).origin },
      body: '{"action":"get_dashboard"}',
    });
    assert.equal(response.status, 403);
  } finally {
    await canvas.onClose(secondContext);
  }
});
