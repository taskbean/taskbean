// Observe-only Chronicle reconciliation: runtime guarantees.
// All data is isolated under a temporary HOME / TASKBEAN_HOME / TASKBEAN_DB.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const BEAN = join(process.cwd(), 'bin', 'taskbean.js');
const ROOT = join(tmpdir(), `taskbean-observe-test-${process.pid}-${Date.now()}`);
const SECRETS = [
  'OBSERVE-SECRET-USER-PROMPT',
  'OBSERVE-SECRET-ASSISTANT-RESPONSE',
  'OBSERVE-SECRET-TOOL-OUTPUT',
  'ghp_ObserveFakeCredential0000000000000000',
];

function isoDay(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const DAY = isoDay(-1);
const at = (hh) => `${DAY}T${hh}:00:00Z`;

function homeFor(name) {
  const home = join(ROOT, name);
  mkdirSync(join(home, '.copilot'), { recursive: true });
  mkdirSync(join(home, '.taskbean'), { recursive: true });
  return home;
}

function envFor(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, TASKBEAN_HOME: join(home, '.taskbean'), TASKBEAN_DB: join(home, '.taskbean', 'taskbean.db'), TASKBEAN_NO_UPGRADE_NOTICE: '1', ...extra };
  if (!('COPILOT_CLI_SESSION_ID' in extra)) delete env.COPILOT_CLI_SESSION_ID;
  if (!('TASKBEAN_NATIVE_SESSION_ID' in extra)) delete env.TASKBEAN_NATIVE_SESSION_ID;
  return env;
}

function bean(home, args, extraEnv) {
  const out = execFileSync(process.execPath, [BEAN, ...args, '--json'], { encoding: 'utf-8', cwd: home, env: envFor(home, extraEnv) });
  return JSON.parse(out.trim());
}

function sessionStore(home, sessions) {
  const db = new DatabaseSync(join(home, '.copilot', 'session-store.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS turns (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT, timestamp TEXT);
    CREATE TABLE IF NOT EXISTS forge_trajectory_events (id INTEGER PRIMARY KEY, session_id TEXT, event_type TEXT, command TEXT, output TEXT, created_at TEXT);
  `);
  const insert = db.prepare('INSERT OR REPLACE INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const s of sessions) {
    insert.run(s.id, join(home, 'work', 'taskbean'), 'taskbean/taskbean', s.branch || 'main', s.summary, s.created, s.updated);
    db.prepare('INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, 1, ?, ?, ?)')
      .run(s.id, `${SECRETS[0]} ${SECRETS[3]}`, SECRETS[1], s.created);
    db.prepare('INSERT INTO forge_trajectory_events (session_id, event_type, command, output, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(s.id, 'shell', 'echo hidden', SECRETS[2], s.created);
  }
  db.close();
}

function touchSession(home, id, updated, summary) {
  const db = new DatabaseSync(join(home, '.copilot', 'session-store.db'));
  db.prepare('UPDATE sessions SET updated_at = ?, summary = ? WHERE id = ?').run(updated, summary, id);
  db.close();
}

const THREE = [
  { id: 's1', summary: 'Fix dashboard add_task quoting', created: at('08'), updated: at('09') },
  { id: 's2', summary: 'Add observe-only reconciliation', created: at('10'), updated: at('11') },
  { id: 's3', summary: 'Align skill guidance with outcomes', created: at('12'), updated: at('13') },
];

function ledger(home) {
  return new DatabaseSync(join(home, '.taskbean', 'taskbean.db'));
}

function snapshotTodos(home) {
  const db = ledger(home);
  try { return JSON.stringify(db.prepare('SELECT * FROM todos ORDER BY id').all()); } finally { db.close(); }
}

describe('observe-only Chronicle reconciliation', () => {
  before(() => mkdirSync(ROOT, { recursive: true }));
  after(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch {} });

  it('never auto-links, creates, completes, or edits outcomes', () => {
    const home = homeFor('no-mutation');
    sessionStore(home, THREE);
    const task = bean(home, ['add', 'Already tracked outcome', '--agent', 'copilot', '--session-id', 's1']);
    const before = snapshotTodos(home);

    const result = bean(home, ['chronicle', 'reconcile', '--observe']);
    assert.equal(result.mode, 'observe');
    assert.equal(result.counts.discovered, 3);
    assert.equal(result.counts.linked, 0);
    assert.equal(result.counts.pending, 3);
    for (const s of result.suggestions) {
      assert.equal(s.state, 'pending');
      assert.equal(s.auto_linked, false);
      assert.equal(s.linked_todo_id, null);
    }
    assert.equal(snapshotTodos(home), before, 'todos must be byte-identical after observe');
    const db = ledger(home);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM task_evidence WHERE todo_id IS NOT NULL').get().c, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM todos').get().c, 1);
      assert.equal(db.prepare('SELECT status FROM todos WHERE id = ?').get(task.id).status, 'pending');
    } finally { db.close(); }

    // The same suggestion stays reviewable; a later explicit review run may still link it.
    const review = bean(home, ['chronicle', 'reconcile', '--since', DAY, '--until', isoDay(0)]);
    assert.equal(review.mode, 'review');
    assert.equal(review.counts.linked, 1);
  });

  it('advances a checkpoint incrementally and replays idempotently', () => {
    const home = homeFor('checkpoint');
    sessionStore(home, THREE);

    const first = bean(home, ['chronicle', 'reconcile', '--observe', '--limit', '2']);
    assert.equal(first.counts.discovered, 2);
    assert.equal(first.has_more, true);
    assert.equal(first.checkpoint.last_session_id, 's2');
    assert.equal(first.checkpoint.last_changed_at, at('11'));

    const second = bean(home, ['chronicle', 'reconcile', '--observe', '--limit', '2']);
    assert.equal(second.counts.discovered, 1);
    assert.equal(second.has_more, false);
    assert.equal(second.checkpoint.last_session_id, 's3');

    const idle = bean(home, ['chronicle', 'reconcile', '--observe']);
    assert.equal(idle.counts.discovered, 0);
    assert.equal(idle.counts.created, 0);
    assert.equal(idle.checkpoint.last_session_id, 's3');
    assert.equal(idle.checkpoint.runs, 3);

    // A session that keeps working after the checkpoint is re-read and refreshed, not duplicated.
    touchSession(home, 's1', at('14'), 'Fix dashboard add_task quoting and map exit codes');
    const refreshed = bean(home, ['chronicle', 'reconcile', '--observe']);
    assert.equal(refreshed.counts.discovered, 1);
    assert.equal(refreshed.counts.created, 0);
    assert.equal(refreshed.counts.updated, 1);
    assert.equal(refreshed.checkpoint.last_session_id, 's1');

    // Explicit full replay of the window changes nothing.
    const replay = bean(home, ['chronicle', 'reconcile', '--observe', '--since', DAY, '--until', isoDay(0)]);
    assert.equal(replay.counts.discovered, 3);
    assert.equal(replay.counts.created, 0);
    assert.equal(replay.counts.updated, 0);
    assert.equal(replay.checkpoint.last_session_id, 's1', 'replay must not move the checkpoint backwards');

    const db = ledger(home);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM reconciliation_suggestions').get().c, 3);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM task_evidence').get().c, 3);
    } finally { db.close(); }
  });

  it('rolls back an interrupted run so the next run recovers from the last commit', async () => {
    const home = homeFor('crash');
    sessionStore(home, THREE);
    const code = `
      const { reconcileChronicleSessions } = await import(${JSON.stringify(new URL('./reconcile.js', import.meta.url).href)});
      try {
        reconcileChronicleSessions({ home: process.env.HOME, observe: true, onPersistStep: ({ index }) => { if (index === 1) throw new Error('simulated crash'); } });
        console.log('no-crash');
      } catch (err) { console.log(err.message); }
    `;
    const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf-8', cwd: process.cwd(), env: envFor(home) });
    assert.match(crashed.stdout, /simulated crash/);

    const db = ledger(home);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM reconciliation_suggestions').get().c, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM task_evidence').get().c, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM reconciliation_checkpoints').get().c, 0);
    } finally { db.close(); }

    const recovered = bean(home, ['chronicle', 'reconcile', '--observe']);
    assert.equal(recovered.counts.created, 3);
    assert.equal(recovered.checkpoint.last_session_id, 's3');
  });

  it('keeps concurrent runs consistent without duplicates', async () => {
    const home = homeFor('concurrent');
    sessionStore(home, THREE);
    bean(home, ['list']);
    const run = () => new Promise((resolve) => {
      const child = spawn(process.execPath, [BEAN, 'chronicle', 'reconcile', '--observe', '--json'], { cwd: home, env: envFor(home) });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (status) => resolve({ status, out }));
    });
    const results = await Promise.all([run(), run(), run()]);
    for (const r of results) {
      assert.equal(r.status, 0, r.out);
      assert.equal(JSON.parse(r.out).available, true);
    }
    const db = ledger(home);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM reconciliation_suggestions').get().c, 3);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM task_evidence').get().c, 3);
      const cp = db.prepare('SELECT * FROM reconciliation_checkpoints').get();
      assert.equal(cp.last_session_id, 's3');
      assert.equal(cp.runs, 3);
    } finally { db.close(); }
  });

  it('excludes the observing session and explicit sessions but still advances past them', () => {
    const home = homeFor('self-exclusion');
    sessionStore(home, THREE);
    const result = bean(home, ['chronicle', 'reconcile', '--observe', '--exclude-session', 's3'], { COPILOT_CLI_SESSION_ID: 's2' });
    assert.equal(result.excluded, 2);
    assert.equal(result.counts.discovered, 1);
    assert.deepEqual(result.evidence.map(e => e.source_session_id), ['s1']);
    assert.equal(result.checkpoint.last_session_id, 's3');
  });

  it('stores metadata only: no raw prompts, responses, tool output, or credentials', () => {
    const home = homeFor('privacy');
    sessionStore(home, THREE);
    const raw = execFileSync(process.execPath, [BEAN, 'chronicle', 'reconcile', '--observe', '--json'], { encoding: 'utf-8', cwd: home, env: envFor(home) });
    for (const secret of SECRETS) assert.ok(!raw.includes(secret), `output leaked ${secret}`);

    const db = ledger(home);
    let dump = '';
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
      for (const t of tables) dump += JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all());
    } finally { db.close(); }
    for (const secret of SECRETS) assert.ok(!dump.includes(secret), `ledger stored ${secret}`);
    for (const file of ['taskbean.db', 'taskbean.db-wal']) {
      const p = join(home, '.taskbean', file);
      if (existsSync(p)) {
        const bytes = readFileSync(p).toString('latin1');
        for (const secret of SECRETS) assert.ok(!bytes.includes(secret), `${file} contains ${secret}`);
      }
    }
  });

  it('bounds the scan window and validates limits', () => {
    const home = homeFor('bounds');
    sessionStore(home, THREE);
    const wide = spawnSync(process.execPath, [BEAN, 'chronicle', 'reconcile', '--observe', '--since', isoDay(-60), '--json'], { encoding: 'utf-8', cwd: home, env: envFor(home) });
    assert.notEqual(wide.status, 0);
    assert.match(JSON.parse(wide.stdout).message, /at most 31 days/);
    const bad = spawnSync(process.execPath, [BEAN, 'chronicle', 'reconcile', '--observe', '--limit', '0', '--json'], { encoding: 'utf-8', cwd: home, env: envFor(home) });
    assert.notEqual(bad.status, 0);
    assert.match(JSON.parse(bad.stdout).message, /--limit/);
  });
});
