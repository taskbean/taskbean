import assert from 'node:assert/strict';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { cliEntry, cliRoot, createSandbox, fakeCli, loadExtension, rejectsWithCode, useEnv } from './support/harness.mjs';

const sandbox = createSandbox('errors');
const base = { ...sandbox.env, TASKBEAN_CLI_ENTRY: cliEntry };
useEnv(base);
process.chdir(sandbox.dirs.project);
const { invoke, captured } = await loadExtension();

after(() => {
  useEnv(base);
  process.chdir(cliRoot);
  sandbox.cleanup();
});

function withFake(mode) {
  useEnv({ ...base, TASKBEAN_CLI_ENTRY: fakeCli, FAKE_BEAN_MODE: mode });
}

async function canvasError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the canvas action to fail');
}

test('missing CLI maps to taskbean_cli_unavailable', async () => {
  const { TASKBEAN_CLI_ENTRY, ...rest } = base;
  useEnv({ ...rest, PATH: [sandbox.dirs.empty, ...base.PATH.split(delimiter).slice(2)].join(delimiter) });
  await rejectsWithCode(invoke('get_dashboard', { period: 'all' }), 'taskbean_cli_unavailable');
  useEnv({ ...base, TASKBEAN_CLI_ENTRY: join(sandbox.dirs.root, 'missing.js'), PATH: process.env.PATH });
  await rejectsWithCode(invoke('add_task', { title: 'nothing here' }), 'taskbean_cli_unavailable');
});

test('commander usage errors map to taskbean_cli_usage with the CLI reason', async () => {
  withFake('usage');
  const error = await canvasError(invoke('add_task', { title: 'a b c' }));
  assert.equal(error.code, 'taskbean_cli_usage');
  assert.match(error.message, /too many arguments for 'add'/);
  assert.doesNotMatch(error.message, /runtime error/);
});

test('unexpected CLI failures map to taskbean_cli_failed with exit code and redacted paths', async () => {
  withFake('crash');
  const error = await canvasError(invoke('get_dashboard', {}));
  assert.equal(error.code, 'taskbean_cli_failed');
  assert.match(error.message, /exit 3/);
  assert.match(error.message, /boom while reading ~/);
  assert.ok(!error.message.includes(sandbox.dirs.home), 'home path is redacted');
  assert.ok(!error.message.includes(' at main'), 'stack frames are not surfaced');
});

test('non-JSON output and JSON error payloads map to specific codes', async () => {
  withFake('garbage');
  await rejectsWithCode(invoke('generate_report', {}), 'taskbean_bad_response');
  withFake('json-error');
  const error = await canvasError(invoke('start_task', { id: 'abc' }));
  assert.equal(error.code, 'taskbean_cli_rejected');
  assert.match(error.message, /Priority must be/);
  withFake('locked');
  await rejectsWithCode(invoke('block_task', { id: 'abc' }), 'taskbean_busy');
});

test('a real locked database maps to taskbean_busy', async () => {
  useEnv(base);
  await invoke('add_task', { title: 'Create the schema' });
  const db = new DatabaseSync(base.TASKBEAN_DB);
  db.exec('PRAGMA busy_timeout = 0');
  db.exec('BEGIN EXCLUSIVE');
  try {
    await rejectsWithCode(invoke('add_task', { title: 'Blocked by exclusive lock' }), 'taskbean_busy');
  } finally {
    db.exec('ROLLBACK');
    db.close();
  }
  const board = await invoke('get_dashboard', { period: 'all' });
  assert.deepEqual(board.tasks.map((t) => t.title), ['Create the schema']);
});

test('failures are logged to the session, not swallowed', () => {
  assert.ok(captured.logs.some((log) => log.level === 'error' && /canvas action add_task/.test(log.message)));
});
