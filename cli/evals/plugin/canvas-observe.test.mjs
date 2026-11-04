import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { cliEntry, cliRoot, createSandbox, extensionDir, loadExtension, useEnv } from './support/harness.mjs';

const sandbox = createSandbox('canvas-observe');
useEnv({ ...sandbox.env, TASKBEAN_CLI_ENTRY: cliEntry });
process.chdir(sandbox.dirs.project);

const { canvas, invoke } = await loadExtension();
const { runBean } = await import(pathToFileURL(join(extensionDir, 'bean-runner.mjs')).href);

const SECRET_PROMPT = 'raw-prompt-should-never-leave-chronicle';
const SECRET_OUTPUT = 'ghp_observeSecretToken1234567890';
const SESSION_ID = '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const ledger = async () => runBean(['list', '--all', '--json']);

after(() => {
  process.chdir(cliRoot);
  sandbox.cleanup();
});

function seedSessionStore() {
  const db = new DatabaseSync(join(sandbox.dirs.copilot, 'session-store.db'));
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT, timestamp TEXT);
    CREATE TABLE forge_trajectory_events (id INTEGER PRIMARY KEY, session_id TEXT, event_type TEXT, command TEXT, output TEXT, created_at TEXT);
  `);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(SESSION_ID, sandbox.dirs.project, 'taskbean/taskbean', 'observe-panel', 'Ship the observe-only evidence panel', now, now);
  db.prepare('INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, 1, ?, ?, ?)')
    .run(SESSION_ID, SECRET_PROMPT, 'assistant reply body', now);
  db.prepare('INSERT INTO forge_trajectory_events (session_id, event_type, command, output, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(SESSION_ID, 'shell', 'echo hidden', SECRET_OUTPUT, now);
  db.close();
}

test('observe_evidence is declared as a non-mutating action', () => {
  const action = canvas.actions.find((a) => a.name === 'observe_evidence');
  assert.ok(action, 'observe_evidence action is declared');
  assert.match(action.description, /Never creates, links, completes, or edits tasks/);
});

test('get_dashboard exposes pending suggestions separately from tasks', async () => {
  const dashboard = await invoke('get_dashboard', { period: 'all' });
  assert.deepEqual(dashboard.suggestedEvidence, { available: true, reason: null, count: 0, items: [] });
});

test('observe_evidence collects suggestions without changing the task ledger', async () => {
  await runBean(['add', 'Existing outcome that observe must not touch', '--json']);
  seedSessionStore();
  const before = await ledger();

  const result = await invoke('observe_evidence');
  assert.equal(result.mode, 'observe');
  assert.equal(result.available, true);
  assert.equal(result.tasksChanged, 0);
  assert.ok(result.counts.created >= 1, `expected new suggestions, got ${JSON.stringify(result.counts)}`);
  assert.equal(await ledger(), before, 'observe_evidence must not change any task');

  const dashboard = await invoke('get_dashboard', { period: 'all' });
  assert.equal(dashboard.tasks.length, 1);
  assert.ok(dashboard.suggestedEvidence.count >= 1);
  for (const item of dashboard.suggestedEvidence.items) assert.equal(item.state, 'suggestion');
  const payload = JSON.stringify({ result, dashboard });
  assert.ok(!payload.includes(SECRET_PROMPT), 'raw prompts stay out of canvas payloads');
  assert.ok(!payload.includes(SECRET_OUTPUT), 'tool output stays out of canvas payloads');
});

test('a second observe run is an idempotent replay', async () => {
  const before = await ledger();
  const result = await invoke('observe_evidence');
  assert.equal(result.counts.created || 0, 0);
  assert.equal(await ledger(), before);
});
