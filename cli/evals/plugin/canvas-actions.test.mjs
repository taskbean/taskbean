import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CONTEXT, REGRESSION_TITLES, cliEntry, cliRoot, createSandbox, extensionDir, loadExtension, rejectsWithCode, useEnv } from './support/harness.mjs';

const sandbox = createSandbox('canvas');
useEnv({ ...sandbox.env, TASKBEAN_CLI_ENTRY: cliEntry });
process.chdir(sandbox.dirs.project);

const { canvas, invoke } = await loadExtension();
const { runBean } = await import(pathToFileURL(join(extensionDir, 'bean-runner.mjs')).href);

const SESSION_ID = '4e0f6a52-1c3b-4d5e-8f90-a1b2c3d4e5f6';
const created = new Map();
let secondProject;
let opened;

before(() => {
  secondProject = join(sandbox.dirs.root, 'projects', 'second-project');
  mkdirSync(secondProject, { recursive: true });
});

after(async () => {
  if (opened) await canvas.onClose({ ...CONTEXT });
  process.chdir(cliRoot);
  sandbox.cleanup();
});

test('declares exactly the seven documented canvas actions', () => {
  assert.deepEqual(canvas.actions.map((a) => a.name).sort(), [
    'add_task', 'block_task', 'complete_task', 'generate_report', 'get_availability', 'get_dashboard', 'start_task',
  ]);
});

test('get_availability reports the plugin-scoped installation', async () => {
  const result = await invoke('get_availability');
  assert.equal(result.available, true);
  assert.equal(result.scope, 'plugin');
  assert.equal(result.canvasId, 'taskbean-dashboard');
  assert.equal(result.globallyAvailableLocally, true);
  assert.ok(result.entrypoint.endsWith('extension.mjs'));
});

test('add_task stores every regression title exactly', async () => {
  for (const title of REGRESSION_TITLES) {
    const task = await invoke('add_task', { title });
    assert.equal(task.title, title);
    assert.equal(task.status, 'pending');
    assert.match(task.id, /\S/);
    created.set(title, task);
  }
});

test('add_task honors project and key, and the key upserts', async () => {
  const first = await invoke('add_task', { title: 'Keyed task & 100%', project: secondProject, key: 'eval-key' });
  assert.equal(first.title, 'Keyed task & 100%');
  assert.equal(first.project_path, secondProject);
  const again = await invoke('add_task', { title: 'Keyed task & 100%', project: secondProject, key: 'eval-key' });
  assert.equal(again.id, first.id);
  created.set('keyed', first);
});

test('add_task rejects an empty title before calling the CLI', async () => {
  await rejectsWithCode(invoke('add_task', { title: '   ' }), 'missing_title');
});

test('get_dashboard returns every task and applies status, search and project filters', async () => {
  const all = await invoke('get_dashboard', { period: 'all' });
  const titles = all.tasks.map((t) => t.title);
  for (const title of REGRESSION_TITLES) assert.ok(titles.includes(title), title);
  assert.equal(all.allTaskCount, REGRESSION_TITLES.length + 1);
  assert.equal(all.summary.byStatus.pending, REGRESSION_TITLES.length + 1);

  const search = await invoke('get_dashboard', { period: 'all', search: 'caret' });
  assert.deepEqual(search.tasks.map((t) => t.title), ['50% done & ^caret']);

  const keyed = all.tasks.find((t) => t.id === created.get('keyed').id);
  const byProject = await invoke('get_dashboard', { period: 'all', project: keyed.origin.key });
  assert.deepEqual(byProject.tasks.map((t) => t.id), [keyed.id]);
  assert.ok(all.workspaces.some((w) => w.key === keyed.origin.key));

  const week = await invoke('get_dashboard', { period: 'week', status: 'done' });
  assert.equal(week.tasks.length, 0);
  assert.equal(week.filters.period, 'week');
});

test('start_task, block_task and complete_task move tasks between lanes', async () => {
  const [a, b, c] = REGRESSION_TITLES.map((t) => created.get(t).id);
  assert.equal((await invoke('start_task', { id: a })).status, 'in_progress');
  assert.equal((await invoke('block_task', { id: b })).status, 'blocked');
  const done = await invoke('complete_task', { id: c });
  assert.equal(done.status, 'done');

  const board = await invoke('get_dashboard', { period: 'all' });
  assert.deepEqual(board.lanes.in_progress.map((t) => t.id), [a]);
  assert.deepEqual(board.lanes.blocked.map((t) => t.id), [b]);
  assert.deepEqual(board.lanes.done.map((t) => t.id), [c]);
  assert.ok(board.needsYou.some((t) => t.id === b), 'blocked task needs the user');
});

test('task mutations map missing and unknown ids to specific errors', async () => {
  await rejectsWithCode(invoke('start_task', {}), 'missing_task_id');
  await rejectsWithCode(invoke('complete_task', { id: 'does-not-exist' }), 'task_not_found');
});

test('generate_report returns JSON that includes completed work', async () => {
  const report = await invoke('generate_report', { period: 'all' });
  assert.equal(typeof report, 'object');
  assert.ok(JSON.stringify(report).includes(REGRESSION_TITLES[2].replaceAll('"', '\\"')));
});

test('Copilot session tasks get a validated ghapp session link and no raw anchors', async () => {
  const raw = await runBean(['add', 'Session linked task', '--agent', 'copilot', '--session-id', SESSION_ID, '--json']);
  const task = JSON.parse(raw);
  const board = await invoke('get_dashboard', { period: 'all', search: 'Session linked' });
  const view = board.tasks.find((t) => t.id === task.id);
  assert.equal(view.origin.session?.id, SESSION_ID);
  const group = board.outcomeGroups.find((g) => g.tasks.some((t) => t.id === task.id));
  assert.equal(group.sessionHref, `ghapp://sessions/${SESSION_ID}`);
});

test('HTTP surface serves the UI and routes actions with safe errors', async () => {
  opened = await canvas.open({ ...CONTEXT, input: {} });
  assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const html = await (await fetch(opened.url)).text();
  assert.match(html, /Taskbean/);
  assert.doesNotMatch(html, /href="ghapp:/, 'no custom-scheme anchors in the canvas UI');
  assert.match(html, /data-copy-link/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0, 'UI ships an inline script');
  for (const script of scripts) assert.doesNotThrow(() => new Function(script), 'inline UI script parses');

  const post = (body) => fetch(new URL('/api/action', opened.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const ok = await post(JSON.stringify({ action: 'add_task', input: { title: '%PATH% & echo pwned via http' } }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result.title, '%PATH% & echo pwned via http');

  const unknown = await post(JSON.stringify({ action: 'drop_tables', input: {} }));
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, 'unknown_action');

  const invalid = await post('{not json');
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'invalid_request');
});
