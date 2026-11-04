import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'taskbean-compatibility-'));
const ENTRY = resolve('bin', 'taskbean.js');
let sequence = 0;

after(() => rmSync(ROOT, { recursive: true, force: true }));

function fixture() {
  const root = join(ROOT, String(++sequence));
  const project = join(root, 'project');
  const home = join(root, 'home');
  const temp = join(root, 'temp');
  const data = join(home, '.taskbean');
  for (const dir of [project, home, temp, data]) mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    COPILOT_HOME: join(home, '.copilot'),
    TASKBEAN_HOME: data,
    TASKBEAN_DB: join(data, 'taskbean.db'),
    TASKBEAN_NO_WSL_REDIRECT: '1',
    TASKBEAN_NO_UPGRADE_NOTICE: '1',
    TEMP: temp,
    TMP: temp,
    CI: '1',
    NODE_NO_WARNINGS: '1',
  };
  for (const key of [
    'TASKBEAN_AGENT', 'TASKBEAN_NATIVE_SESSION_ID', 'CLAUDECODE',
    'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID', 'OPENCODE_SESSION', 'COPILOT_CLI_SESSION_ID',
  ]) delete env[key];
  return { root, project, home, db: env.TASKBEAN_DB, env };
}

function execute(f, args, { cwd = f.project, allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd, env: f.env, encoding: 'utf8', timeout: 30000,
  });
  if (result.error) throw result.error;
  if (!allowFailure) assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result;
}

function json(f, args, options) {
  const result = execute(f, [...args, '--json'], options);
  return JSON.parse(result.stdout.trim());
}

function database(path, callback) {
  const db = new DatabaseSync(path);
  try { return callback(db); } finally { db.close(); }
}

function rows(path, sql, params = []) {
  return database(path, db => db.prepare(sql).all(...params).map(row => ({ ...row })));
}

function task(path, id) {
  return rows(path, 'SELECT * FROM todos WHERE id = ?', [id])[0] || null;
}

function events(project) {
  const path = join(project, '.taskbean', 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function trackedProject(path) {
  mkdirSync(join(path, '.taskbean'), { recursive: true });
  writeFileSync(join(path, '.taskbean', 'project.json'), JSON.stringify({ projectId: randomUUID(), version: 1 }));
}

function seed(f, project = f.project) {
  trackedProject(project);
  const baseline = json(f, ['add', 'Synthetic baseline', '--project', project]);
  json(f, ['rebuild', '--write', '--project', project]);
  return baseline;
}

function assertCacheMatches(f, id, project = f.project) {
  assert.deepEqual(task(join(project, '.taskbean', 'tasks.db'), id), task(f.db, id));
}

function runAsync(f, args, { cwd = f.project } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd, env: f.env, stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(30000),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolvePromise({ code, stdout, stderr }));
  });
}

test('all task mutations write events and the cache, with idempotent repeats and replay', () => {
  const f = fixture();
  const baseline = seed(f);
  const keyed = json(f, ['add', 'Synthetic keyed outcome', '--key', 'stable']);
  assertCacheMatches(f, keyed.id);
  const updated = json(f, ['add', 'Updated keyed outcome', '--key', 'stable']);
  assert.equal(updated.id, keyed.id);
  assertCacheMatches(f, keyed.id);

  const edited = json(f, [
    'edit', keyed.id, '--title', 'Edited outcome', '--priority', 'high',
    '--notes', 'Synthetic note', '--tags', 'one,two', '--due-date', '2035-01-02',
  ]);
  assert.equal(edited.title, 'Edited outcome');
  assertCacheMatches(f, keyed.id);

  for (const [command, type] of [['start', 'task.start'], ['block', 'task.block'], ['done', 'task.complete']]) {
    const before = events(f.project).length;
    json(f, [command, keyed.id]);
    assertCacheMatches(f, keyed.id);
    json(f, [command, keyed.id]);
    assert.deepEqual(events(f.project).slice(before).map(event => event.type), [type]);
  }

  const removed = json(f, ['add', 'Synthetic removable outcome']);
  json(f, ['remove', removed.id]);
  assertCacheMatches(f, removed.id);
  const reminder = json(f, ['remind', 'Synthetic reminder', '2035-01-02T09:00:00Z']);
  assertCacheMatches(f, reminder.id);
  assert.equal(events(f.project).at(-1).type, 'task.remind');

  const drift = json(f, ['rebuild']);
  assert.equal(drift.status, 'in_sync');
  json(f, ['rebuild', '--write']);
  for (const id of [baseline.id, keyed.id, removed.id, reminder.id]) assertCacheMatches(f, id);
});

test('task IDs route cross-project changes to the task project history and cache', () => {
  const f = fixture();
  seed(f);
  const other = join(f.root, 'other');
  mkdirSync(other, { recursive: true });
  const foreign = seed(f, other);
  const before = readFileSync(join(f.project, '.taskbean', 'events.jsonl'), 'utf8');
  json(f, ['block', foreign.id, '--project', f.project]);
  json(f, ['edit', foreign.id, '--title', 'Correct project', '--project', f.project]);
  assert.equal(readFileSync(join(f.project, '.taskbean', 'events.jsonl'), 'utf8'), before);
  assert.deepEqual(events(other).slice(-2).map(event => event.type), ['task.block', 'task.update']);
  assertCacheMatches(f, foreign.id, other);
  assert.equal(json(f, ['rebuild', '--project', other]).status, 'in_sync');
});

test('project histories do not absorb tasks from another project with the same name', () => {
  const f = fixture();
  const other = join(f.root, 'second', basename(f.project));
  mkdirSync(other, { recursive: true });
  const first = seed(f);
  const second = seed(f, other);
  assert.equal(json(f, ['rebuild', '--project', f.project]).status, 'in_sync');
  const migrated = json(f, ['migrate-events', '--project', f.project]);
  assert.equal(migrated.migrated, 0);
  assert.ok(!events(f.project).some(event => event.payload.taskId === second.id));
  json(f, ['rebuild', '--write', '--project', f.project]);
  assert.ok(task(join(f.project, '.taskbean', 'tasks.db'), first.id));
  assert.equal(task(join(f.project, '.taskbean', 'tasks.db'), second.id), null);

  database(f.db, db => db.prepare('UPDATE todos SET project_path = NULL WHERE id = ?').run(first.id));
  const ambiguous = execute(f, ['migrate-events', '--project', f.project, '--json'], { allowFailure: true });
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /multiple projects share that name/i);
});

test('keyed adds reject another or ambiguous project without changing its task', () => {
  const f = fixture();
  const other = join(f.root, 'second', basename(f.project));
  mkdirSync(other, { recursive: true });
  seed(f);
  seed(f, other);
  const original = json(f, ['add', 'Original task', '--key', 'shared', '--project', f.project]);
  const firstEvents = events(f.project);
  const secondEvents = events(other);

  const collision = execute(f, [
    'add', 'Wrong project title', '--key', 'shared', '--project', other, '--json',
  ], { allowFailure: true });
  assert.notEqual(collision.status, 0);
  assert.equal(JSON.parse(collision.stdout).error, 'project_key_conflict');
  assert.equal(task(f.db, original.id).title, 'Original task');
  assertCacheMatches(f, original.id);
  assert.deepEqual(events(f.project), firstEvents);
  assert.deepEqual(events(other), secondEvents);

  database(f.db, db => db.prepare('UPDATE todos SET project_path = NULL WHERE id = ?').run(original.id));
  const ambiguous = execute(f, [
    'add', 'Ambiguous title', '--key', 'shared', '--project', f.project, '--json',
  ], { allowFailure: true });
  assert.notEqual(ambiguous.status, 0);
  assert.equal(JSON.parse(ambiguous.stdout).error, 'project_key_conflict');
  assert.equal(task(f.db, original.id).title, 'Original task');
  assert.deepEqual(events(f.project), firstEvents);
});

test('keyed adds accept registered paths for the same project identity', () => {
  const f = fixture();
  seed(f);
  const original = json(f, ['add', 'Original task', '--key', 'shared']);
  const alias = join(f.root, 'second', basename(f.project));
  mkdirSync(join(alias, '.taskbean'), { recursive: true });
  writeFileSync(join(alias, '.taskbean', 'project.json'),
    readFileSync(join(f.project, '.taskbean', 'project.json')));
  const uuid = JSON.parse(readFileSync(join(alias, '.taskbean', 'project.json'), 'utf8')).projectId;
  database(f.db, db => db.prepare(
    'INSERT INTO project_aliases (project_uuid, path) VALUES (?, ?)',
  ).run(uuid, alias));
  const updated = json(f, ['add', 'Updated through alias', '--key', 'shared', '--project', alias]);
  assert.equal(updated.id, original.id);
  assert.equal(task(f.db, original.id).title, 'Updated through alias');
  assertCacheMatches(f, original.id);
});

for (const suffix of ['short', 'long'.repeat(20)]) {
  test(`filesystem aliases preserve project identity and replay with a ${suffix === 'short' ? 'short' : 'long'} path suffix`, () => {
    const f = fixture();
    const realRoot = join(f.root, 'real');
    const aliasRoot = join(f.root, 'alias');
    const project = join(realRoot, suffix, 'project');
    const alias = join(aliasRoot, suffix, 'project');
    mkdirSync(project, { recursive: true });
    symlinkSync(realRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');

    seed(f, alias);
    const original = json(f, ['add', 'Original via alias', '--key', 'shared', '--project', alias]);
    database(f.db, db => db.prepare('DELETE FROM project_aliases WHERE path = ?').run(alias));
    const updated = json(f, ['add', 'Updated through real path', '--key', 'shared'], { cwd: project });
    assert.equal(updated.id, original.id);
    assert.equal(updated.project_path, alias, 'existing task path is not rewritten');
    assert.equal(rows(f.db, 'SELECT * FROM projects').length, 1, 'filesystem aliases do not create duplicate projects');
    assert.equal(json(f, ['rebuild', '--project', project]).status, 'in_sync');
    assert.equal(json(f, ['rebuild', '--project', alias]).status, 'in_sync');
    json(f, ['rebuild', '--write', '--project', project]);
    assertCacheMatches(f, original.id, project);
    const registered = rows(f.db, 'SELECT path, tasks_db_path FROM projects')[0];
    assert.equal(registered.path, alias, 'registered path is not rewritten');
    assert.equal(registered.tasks_db_path, join(project, '.taskbean', 'tasks.db'));
  });
}

test('tracking and project management use the existing row through a filesystem alias', () => {
  const f = fixture();
  const aliasRoot = join(f.root, 'alias');
  symlinkSync(f.root, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const alias = join(aliasRoot, 'project');
  execute(f, ['track', '--path', alias]);
  const original = rows(f.db, 'SELECT * FROM projects')[0];
  execute(f, ['track', '--path', f.project]);
  const projects = rows(f.db, 'SELECT * FROM projects');
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, original.id);
  assert.equal(projects[0].path, alias);
  assert.ok(projects[0].project_uuid);
  assert.equal(projects[0].skill_installed, 1);
  assert.equal(json(f, ['projects', 'hide'], { cwd: f.project }).hidden, true);
  assert.equal(json(f, ['projects', 'show'], { cwd: f.project }).hidden, false);
  assert.equal(json(f, ['untrack', '--path', f.project]).status, 'untracked');
  assert.equal(rows(f.db, 'SELECT tracked FROM projects')[0].tracked, 0);
});

test('concurrent registration through filesystem aliases creates one project', async () => {
  const f = fixture();
  const aliasRoot = join(f.root, 'alias');
  symlinkSync(f.root, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const alias = join(aliasRoot, 'project');
  trackedProject(f.project);
  json(f, ['list', '--all']);
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    runAsync(f, [ENTRY, 'add', `Aliased outcome ${index}`, '--project', index % 2 ? alias : f.project, '--json'])));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(rows(f.db, 'SELECT COUNT(*) AS n FROM projects')[0].n, 1);
  assert.equal(rows(f.db, 'SELECT COUNT(*) AS n FROM todos')[0].n, 10);
  assert.equal(json(f, ['rebuild', '--project', f.project]).status, 'in_sync');
});

test('waiting alias registrations recheck identity after acquiring the database write lock', async () => {
  const f = fixture();
  const aliasRoot = join(f.root, 'alias');
  symlinkSync(f.root, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const alias = join(aliasRoot, 'project');
  json(f, ['list', '--all']);
  const gate = join(f.root, 'registration-gate');
  const ready = Array.from({ length: 6 }, (_, index) => join(f.root, `registration-ready-${index}`));
  const moduleUrl = pathToFileURL(resolve('src', 'data', 'store.js')).href;
  const script = `
    const { existsSync, writeFileSync } = await import('node:fs');
    const { ensureProject, getDb } = await import(${JSON.stringify(moduleUrl)});
    getDb();
    writeFileSync(process.argv[2], '');
    while (!existsSync(process.argv[3])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    console.log(ensureProject(process.argv[1], 'project'));
  `;
  const children = ready.map((marker, index) =>
    runAsync(f, ['--input-type=module', '-e', script, index % 2 ? alias : f.project, marker, gate]));
  const deadline = Date.now() + 15000;
  while (!ready.every(existsSync) && Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  if (!ready.every(existsSync)) {
    writeFileSync(gate, '');
    await Promise.all(children);
    assert.fail('Registration workers did not become ready');
  }
  const lock = new DatabaseSync(f.db);
  try {
    lock.exec('BEGIN IMMEDIATE');
    writeFileSync(gate, '');
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
    lock.exec('COMMIT');
  } finally {
    lock.close();
  }
  const results = await Promise.all(children);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(new Set(results.map(result => result.stdout.trim())).size, 1);
  assert.equal(rows(f.db, 'SELECT COUNT(*) AS n FROM projects')[0].n, 1);
});

test('colliding project IDs for different directories are rejected', () => {
  const f = fixture();
  const suffix = 'long'.repeat(20);
  const first = join(f.root, 'first', suffix, 'project');
  const second = join(f.root, 'second', suffix, 'project');
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  seed(f, first);
  trackedProject(second);
  const result = execute(f, ['add', 'Different physical project', '--project', second, '--json'], { allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /generated ID is already in use/);
  assert.equal(rows(f.db, 'SELECT * FROM projects').length, 1);
});

test('ambiguous registered filesystem aliases fail without changing projects or tasks', () => {
  const f = fixture();
  const aliases = ['first', 'second', 'third'].map(name => join(f.root, name));
  for (const alias of aliases) {
    symlinkSync(f.project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  }
  json(f, ['list', '--all']);
  database(f.db, db => {
    const insert = db.prepare('INSERT INTO projects (id, name, path, tracked) VALUES (?, ?, ?, 1)');
    insert.run('first', 'project', aliases[0]);
    insert.run('second', 'project', aliases[1]);
  });
  const before = rows(f.db, 'SELECT * FROM projects ORDER BY id');
  const result = execute(f, ['add', 'Ambiguous project', '--project', aliases[2], '--json'], { allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /multiple registered paths point to the same directory/);
  assert.deepEqual(rows(f.db, 'SELECT * FROM projects ORDER BY id'), before);
  assert.equal(rows(f.db, 'SELECT COUNT(*) AS n FROM todos')[0].n, 0);
});

test('list prefers a read-only project cache; all-project status filters use the ledger', () => {
  const f = fixture();
  const baseline = seed(f);
  const second = json(f, ['add', 'Second outcome']);
  json(f, ['block', second.id]);
  const cache = join(f.project, '.taskbean', 'tasks.db');
  database(f.db, db => db.prepare('UPDATE todos SET title = ? WHERE id = ?').run('Ledger title', baseline.id));
  database(cache, db => db.prepare('UPDATE todos SET title = ? WHERE id = ?').run('Portable cache title', baseline.id));
  const modeBefore = database(cache, db => db.prepare('PRAGMA journal_mode').get().journal_mode);
  assert.equal(json(f, ['list']).find(row => row.id === baseline.id).title, 'Portable cache title');
  assert.equal(json(f, ['list', '--all']).find(row => row.id === baseline.id).title, 'Ledger title');
  assert.deepEqual(json(f, ['list', '--all', '--status', 'blocked']).map(row => row.id), [second.id]);
  assert.equal(database(cache, db => db.prepare('PRAGMA journal_mode').get().journal_mode), modeBefore);
});

test('approved Chronicle suggestions write a replayable event and cache state', () => {
  const f = fixture();
  seed(f);
  database(f.db, db => db.prepare(`
    INSERT INTO reconciliation_suggestions
      (id, evidence_key, suggested_title, evidence_summary, created_at, updated_at)
    VALUES ('synthetic-suggestion', 'synthetic-evidence', 'Synthetic suggestion', 'Metadata only',
            '2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z')
  `).run());
  const approved = json(f, [
    'chronicle', 'approve', 'synthetic-suggestion', '--project', f.project,
    '--title', 'Reviewed outcome', '--notes', 'Reviewed note', '--status', 'done',
  ]);
  assert.equal(approved.task.completed, 1);
  assertCacheMatches(f, approved.task.id);
  assert.deepEqual(events(f.project).slice(-3).map(event => event.type),
    ['task.add', 'task.update', 'task.complete']);
  assert.equal(json(f, ['rebuild']).status, 'in_sync');
  json(f, ['rebuild', '--write']);
  assertCacheMatches(f, approved.task.id);
});

test('legacy API completion and reopen emit compatible state and cache changes', () => {
  const f = fixture();
  const baseline = seed(f);
  json(f, ['edit', baseline.id, '--notes', 'Keep this note']);
  const serveUrl = pathToFileURL(resolve('src', 'commands', 'serve.js')).href;
  const script = `
    const { serveCommand } = await import(${JSON.stringify(serveUrl)});
    const server = serveCommand({ port: '0' });
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const url = 'http://127.0.0.1:' + server.address().port + '/api/tasks/' + process.argv[1];
    const results = [];
    for (const completed of [true, false]) {
      const response = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ completed }) });
      results.push({ code: response.status, task: await response.json() });
    }
    await new Promise(resolve => server.close(resolve));
    console.log('RESULT:' + JSON.stringify(results));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, baseline.id], {
    cwd: f.project, env: f.env, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.split('\n').find(line => line.startsWith('RESULT:')).slice(7));
  assert.deepEqual(result.map(row => [row.code, row.task.completed, row.task.status]),
    [[200, 1, 'done'], [200, 0, 'pending']]);
  assert.deepEqual(events(f.project).slice(-4).map(event => event.type),
    ['task.complete', 'task.reopen', 'task.add', 'task.update']);
  assert.equal(events(f.project).at(-2).payload.reason, 'reopen');
  assertCacheMatches(f, baseline.id);
  assert.equal(json(f, ['rebuild']).status, 'in_sync');
});

function cacheRows(f, project = f.project) {
  return rows(join(project, '.taskbean', 'tasks.db'), 'SELECT * FROM todos ORDER BY id');
}

test('rebuild refuses to replay missing transitions or removed tasks over the cache', () => {
  const f = fixture();
  const baseline = seed(f);
  const removed = json(f, ['add', 'Removed by an older version']);
  database(f.db, db => {
    db.prepare("UPDATE todos SET completed = 1, status = 'done' WHERE id = ?").run(baseline.id);
    db.prepare('DELETE FROM todos WHERE id = ?').run(removed.id);
    db.prepare(`
      INSERT INTO todos (id, title, project, project_path, status, created_at)
      VALUES ('legacy-task', 'Missing creation event', ?, ?, 'pending', '2026-01-01T00:00:00Z')
    `).run(basename(f.project), f.project);
  });
  const migrated = json(f, ['migrate-events']);
  assert.equal(migrated.migrated, 1);
  assert.equal(migrated.status, 'incomplete');
  assert.deepEqual(migrated.unreconstructed.missingInLive, [removed.id]);
  assert.deepEqual(migrated.unreconstructed.mismatched.map(row => row.id), [baseline.id]);
  assert.ok(migrated.unreconstructed.mismatched[0].fields.includes('status'));
  const again = json(f, ['migrate-events']);
  assert.equal(again.migrated, 0);
  assert.equal(again.status, 'incomplete');
  const human = execute(f, ['migrate-events']);
  assert.match(human.stdout, /all current tasks have creation events/i);
  assert.match(human.stdout, /history still differs/i);
  assert.ok(!events(f.project).some(event => event.payload.taskId === baseline.id && event.type === 'task.complete'));

  const report = json(f, ['rebuild']);
  assert.equal(report.status, 'drift');
  assert.equal(report.cache.status, 'stale');
  assert.deepEqual(report.cache.missing, ['legacy-task']);
  assert.deepEqual(report.cache.extra, [removed.id]);
  assert.deepEqual(report.cache.mismatched.map(row => row.id), [baseline.id]);

  const historyPath = join(f.project, '.taskbean', 'events.jsonl');
  const cachePath = join(f.project, '.taskbean', 'tasks.db');
  const historyBefore = readFileSync(historyPath, 'utf8');
  const cacheBefore = cacheRows(f);
  const cacheBytes = readFileSync(cachePath);
  const refused = execute(f, ['rebuild', '--write', '--json'], { allowFailure: true });
  assert.equal(refused.status, 1);
  const error = JSON.parse(refused.stdout.trim());
  assert.equal(error.error, 'replay_unsafe');
  assert.deepEqual(error.drift.missingInLive, [removed.id]);
  assert.match(refused.stderr, /cache was not changed/i);
  assert.deepEqual(cacheRows(f), cacheBefore);
  assert.deepEqual(readFileSync(cachePath), cacheBytes);
  assert.equal(readFileSync(historyPath, 'utf8'), historyBefore);
});

test('rebuild refuses metadata drift and leaves the cache unchanged', () => {
  const f = fixture();
  const baseline = seed(f);
  json(f, ['edit', baseline.id, '--priority', 'high', '--notes', 'Earlier note',
    '--due-date', '2035-01-02', '--tags', 'earlier,tag']);
  database(f.db, db => db.prepare(`
    UPDATE todos SET priority = 'low', notes = 'Newer note', due_date = '2035-02-03',
                     tags = '["newer","tag"]' WHERE id = ?
  `).run(baseline.id));
  const drift = json(f, ['rebuild']);
  assert.equal(drift.status, 'drift');
  assert.deepEqual(drift.drift.mismatched[0].fields, ['priority', 'notes', 'due_date', 'tags']);
  assert.deepEqual(drift.cache.mismatched[0].fields, ['priority', 'notes', 'due_date', 'tags']);
  const cacheBefore = cacheRows(f);
  const write = execute(f, ['rebuild', '--write', '--json'], { allowFailure: true });
  assert.equal(write.status, 1);
  assert.equal(JSON.parse(write.stdout.trim()).error, 'replay_unsafe');
  assert.deepEqual(cacheRows(f), cacheBefore);
  assert.equal(task(f.db, baseline.id).notes, 'Newer note');
});

test('rebuild preserves a cache-only row even when history is in sync', () => {
  const f = fixture();
  seed(f);
  const cache = join(f.project, '.taskbean', 'tasks.db');
  database(cache, db => db.prepare(`
    INSERT INTO todos (id, title, project, project_path, status, created_at)
    VALUES ('cache-only', 'Cache-only outcome', ?, ?, 'pending', '2026-01-01T00:00:00Z')
  `).run(basename(f.project), f.project));
  const report = json(f, ['rebuild']);
  assert.equal(report.status, 'in_sync');
  assert.equal(report.cache.status, 'stale');
  assert.deepEqual(report.cache.extra, ['cache-only']);
  assert.deepEqual(report.cache.mismatched, []);

  const cacheBefore = readFileSync(cache);
  const historyPath = join(f.project, '.taskbean', 'events.jsonl');
  const historyBefore = readFileSync(historyPath);
  const refused = execute(f, ['rebuild', '--write', '--json'], { allowFailure: true });
  assert.equal(refused.status, 1);
  const error = JSON.parse(refused.stdout.trim());
  assert.equal(error.error, 'cache_unsafe');
  assert.deepEqual(error.cache.extra, ['cache-only']);
  assert.match(refused.stderr, /cache was not changed/i);
  assert.deepEqual(readFileSync(cache), cacheBefore);
  assert.deepEqual(readFileSync(historyPath), historyBefore);
  assert.equal(task(cache, 'cache-only').title, 'Cache-only outcome');
});

test('rebuild rechecks cache-only rows after waiting for a concurrent writer', async () => {
  const f = fixture();
  const baseline = seed(f);
  const cache = join(f.project, '.taskbean', 'tasks.db');
  const projectAlias = join(f.root, 'cache-project-alias');
  symlinkSync(f.project, projectAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const preload = join(f.root, 'cache-lock-observer.cjs');
  const signal = join(f.root, 'cache-lock-attempt');
  writeFileSync(preload, `
    const { DatabaseSync } = require('node:sqlite');
    const { realpathSync, writeFileSync } = require('node:fs');
    const exec = DatabaseSync.prototype.exec;
    const pathKey = path => {
      const realPath = realpathSync(path);
      return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
    };
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === 'BEGIN IMMEDIATE') {
        const file = this.prepare('PRAGMA database_list').get()?.file;
        if (file && pathKey(file) === pathKey(process.env.TASKBEAN_TEST_CACHE_PATH)) {
          writeFileSync(process.env.TASKBEAN_TEST_LOCK_SIGNAL, 'waiting');
        }
      }
      return exec.call(this, sql);
    };
  `);
  f.env.TASKBEAN_TEST_CACHE_PATH = join(projectAlias, '.taskbean', 'tasks.db');
  f.env.TASKBEAN_TEST_LOCK_SIGNAL = signal;
  const db = new DatabaseSync(cache);
  let transactionOpen = false;
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    db.prepare(`
      INSERT INTO todos (id, title, project, project_path, status, created_at)
      VALUES ('concurrent-only', 'Concurrent outcome', ?, ?, 'pending', '2026-01-01T00:00:00Z')
    `).run(basename(f.project), f.project);

    let childResult;
    const rebuild = runAsync(f, ['--require', preload, ENTRY, 'rebuild', '--write', '--json'])
      .then(result => { childResult = result; return result; }, error => { childResult = { error }; return childResult; });
    const deadline = Date.now() + 10000;
    while (!existsSync(signal) && !childResult && Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    }
    if (!existsSync(signal)) {
      db.exec('ROLLBACK');
      transactionOpen = false;
      const result = await rebuild;
      assert.fail(`Rebuild did not reach the cache write lock: ${result.error || result.stderr}`);
    }
    db.exec('COMMIT');
    transactionOpen = false;
    const result = await rebuild;
    assert.equal(result.code, 1, result.stderr);
    const error = JSON.parse(result.stdout.trim());
    assert.equal(error.error, 'cache_unsafe');
    assert.deepEqual(error.cache.extra, ['concurrent-only']);
    assertCacheMatches(f, baseline.id);
    assert.equal(task(cache, 'concurrent-only').title, 'Concurrent outcome');
  } finally {
    if (transactionOpen) db.exec('ROLLBACK');
    db.close();
  }
});

test('rebuild preserves differing cache-only fields even when history is in sync', () => {
  const f = fixture();
  const baseline = seed(f);
  const cache = join(f.project, '.taskbean', 'tasks.db');
  database(cache, db => {
    db.prepare("UPDATE todos SET title = 'Cache-only title', status = 'blocked', agent = 'local-agent' WHERE id = ?")
      .run(baseline.id);
  });
  const report = json(f, ['rebuild']);
  assert.equal(report.status, 'in_sync');
  assert.equal(report.cache.status, 'stale');
  assert.deepEqual(report.cache.extra, []);
  assert.deepEqual(report.cache.mismatched, [{ id: baseline.id, fields: ['title', 'status', 'agent'] }]);
  const cacheBefore = readFileSync(cache);
  const refused = execute(f, ['rebuild', '--write', '--json'], { allowFailure: true });
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout.trim()).error, 'cache_unsafe');
  assert.deepEqual(readFileSync(cache), cacheBefore);
  assert.equal(task(cache, baseline.id).agent, 'local-agent');
});

test('rebuild preserves populated cache columns it cannot replay', () => {
  const f = fixture();
  const baseline = seed(f);
  const cache = join(f.project, '.taskbean', 'tasks.db');
  database(cache, db => {
    db.exec('ALTER TABLE todos ADD COLUMN additional_evidence TEXT');
    db.prepare('UPDATE todos SET additional_evidence = ? WHERE id = ?').run('Cache-only evidence', baseline.id);
  });
  const report = json(f, ['rebuild']);
  assert.equal(report.status, 'in_sync');
  assert.deepEqual(report.cache.mismatched, [{ id: baseline.id, fields: ['additional_evidence'] }]);
  const cacheBefore = readFileSync(cache);
  const refused = execute(f, ['rebuild', '--write', '--json'], { allowFailure: true });
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout.trim()).error, 'cache_unsafe');
  assert.deepEqual(readFileSync(cache), cacheBefore);
  assert.equal(task(cache, baseline.id).additional_evidence, 'Cache-only evidence');
});

test('rebuild rejects the removed ledger override without changing data', () => {
  const f = fixture();
  seed(f);
  const cache = join(f.project, '.taskbean', 'tasks.db');
  database(cache, db => db.prepare(`
    INSERT INTO todos (id, title, project, project_path, status, created_at)
    VALUES ('cache-only', 'Protected outcome', ?, ?, 'pending', '2026-01-01T00:00:00Z')
  `).run(basename(f.project), f.project));
  const historyPath = join(f.project, '.taskbean', 'events.jsonl');
  const cacheBefore = readFileSync(cache);
  const historyBefore = readFileSync(historyPath);
  const ledgerBefore = rows(f.db, 'SELECT * FROM todos ORDER BY id');
  for (const args of [
    ['rebuild', '--from-ledger', '--json'],
    ['rebuild', '--write', '--from-ledger', '--json'],
  ]) {
    const result = execute(f, args, { allowFailure: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown option.*--from-ledger/i);
    assert.deepEqual(readFileSync(cache), cacheBefore);
    assert.deepEqual(readFileSync(historyPath), historyBefore);
    assert.deepEqual(rows(f.db, 'SELECT * FROM todos ORDER BY id'), ledgerBefore);
  }
  assert.equal(task(cache, 'cache-only').title, 'Protected outcome');
  assert.doesNotMatch(execute(f, ['rebuild', '--help']).stdout, /from-ledger/);
});

test('rebuild restores missing cache rows when existing data is safe', () => {
  const f = fixture();
  const baseline = seed(f);
  const other = json(f, ['add', 'Synthetic missing cache row']);
  const cache = join(f.project, '.taskbean', 'tasks.db');
  database(cache, db => db.prepare('DELETE FROM todos WHERE id = ?').run(other.id));
  const report = json(f, ['rebuild']);
  assert.equal(report.status, 'in_sync');
  assert.equal(report.cache.status, 'stale');
  assert.deepEqual(report.cache.missing, [other.id]);
  assert.deepEqual(report.cache.extra, []);
  assert.deepEqual(report.cache.mismatched, []);
  const write = json(f, ['rebuild', '--write']);
  assert.equal(write.source, 'events');
  assertCacheMatches(f, baseline.id);
  assertCacheMatches(f, other.id);
  assert.equal(json(f, ['rebuild']).cache.status, 'in_sync');
});

test('a safe rebuild preserves data that depends on existing cache rows', () => {
  const f = fixture();
  const baseline = seed(f);
  const cache = join(f.project, '.taskbean', 'tasks.db');
  database(cache, db => {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE local_evidence (
        task_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
        evidence TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO local_evidence (task_id, evidence) VALUES (?, ?)')
      .run(baseline.id, 'Cache-local evidence');
  });
  assert.equal(json(f, ['rebuild', '--write']).source, 'events');
  assert.deepEqual(rows(cache, 'SELECT * FROM local_evidence'), [
    { task_id: baseline.id, evidence: 'Cache-local evidence' },
  ]);
  assertCacheMatches(f, baseline.id);
});

test('rebuild preserves ledger-only metadata and original creation time', () => {
  const f = fixture();
  trackedProject(f.project);
  const baseline = json(f, ['add', 'Synthetic baseline']);
  database(f.db, db => db.prepare(`
    UPDATE todos SET emoji = 'x', due_time = '09:00', reminder_fired = 1,
      source = 'manual', agent = 'copilot', session_id = 'session',
      agent_session_id = 'copilot:session', created_at = '2020-01-01T00:00:00Z' WHERE id = ?
  `).run(baseline.id));
  const before = json(f, ['rebuild']);
  assert.equal(before.status, 'in_sync');
  assert.equal(before.cache.status, 'missing');
  assert.equal(json(f, ['rebuild', '--write']).source, 'events');
  assertCacheMatches(f, baseline.id);
  assert.equal(json(f, ['rebuild', '--write']).source, 'events');
  assertCacheMatches(f, baseline.id);
});

test('failed event and cache writes are visible and do not masquerade as cache reads', () => {
  const f = fixture();
  trackedProject(f.project);
  mkdirSync(join(f.project, '.taskbean', 'events.jsonl'));
  const failedEvent = execute(f, ['add', 'Event write failure', '--json']);
  assert.match(failedEvent.stderr, /Event history append failed/);
  assert.ok(task(f.db, JSON.parse(failedEvent.stdout).id));

  const g = fixture();
  trackedProject(g.project);
  writeFileSync(join(g.project, '.taskbean', 'tasks.db'), 'not a sqlite database');
  const failedCache = execute(g, ['add', 'Cache write failure', '--json']);
  assert.match(failedCache.stderr, /Project cache upsert failed/);
  assert.equal(events(g.project).at(-1).type, 'task.add');
  const failedRead = execute(g, ['list', '--json'], { allowFailure: true });
  assert.notEqual(failedRead.status, 0);
  assert.match(failedRead.stderr, /Could not read project cache/);
  const unreadableCache = join(g.project, '.taskbean', 'tasks.db');
  const before = readFileSync(unreadableCache);
  const refused = execute(g, ['rebuild', '--write', '--json'], { allowFailure: true });
  assert.equal(refused.status, 1);
  const result = JSON.parse(refused.stdout.trim());
  assert.equal(result.error, 'cache_unsafe');
  assert.equal(result.cache.status, 'unreadable');
  assert.deepEqual(readFileSync(unreadableCache), before);
});

test('malformed or future event histories fail closed before migration or cache replacement', () => {
  for (const tail of ['{broken', JSON.stringify({ v: 2, type: 'task.add', payload: {} })]) {
    const f = fixture();
    const baseline = seed(f);
    const cache = join(f.project, '.taskbean', 'tasks.db');
    const before = task(cache, baseline.id);
    const historyPath = join(f.project, '.taskbean', 'events.jsonl');
    appendFileSync(historyPath, `${tail}\n`);
    const historyBefore = readFileSync(historyPath, 'utf8');
    const result = execute(f, ['rebuild', '--write', '--json'], { allowFailure: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid event|only understands/i);
    assert.deepEqual(task(cache, baseline.id), before);
    const migration = execute(f, ['migrate-events', '--json'], { allowFailure: true });
    assert.notEqual(migration.status, 0);
    assert.match(migration.stderr, /Invalid event|only understands/i);
    assert.equal(readFileSync(historyPath, 'utf8'), historyBefore);
  }
});

test('initialization preserves rows, references, timestamps, and DELETE or WAL journal mode', () => {
  for (const journal of ['delete', 'wal']) {
    const f = fixture();
    const baseline = json(f, ['add', 'Legacy status']);
    database(f.db, db => {
      db.exec(`PRAGMA journal_mode = ${journal.toUpperCase()}`);
      db.prepare('UPDATE todos SET completed = 1, status = NULL WHERE id = ?').run(baseline.id);
      db.prepare(`
        INSERT INTO projects (id, name, path, tracked, hidden, category, project_uuid, tasks_db_path, created_at)
        VALUES ('other-project', ?, ?, 1, 1, 'synthetic', 'other-uuid', 'other-cache', '2020-01-01')
      `).run(basename(f.project), join(f.root, 'other'));
      db.prepare(`
        INSERT INTO reconciliation_suggestions
          (id, evidence_key, suggested_title, evidence_summary, occurred_at, created_at, updated_at, linked_todo_id)
        VALUES ('s1', 'e1', 'Synthetic', 'Metadata only', NULL, '2026-01-01', '2026-01-02', ?)
      `).run(baseline.id);
      db.prepare(`
        INSERT INTO task_evidence
          (id, todo_id, suggestion_id, source, source_session_id, occurred_at, created_at)
        VALUES ('e1', ?, 's1', 'synthetic', 'session', NULL, '2026-01-03')
      `).run(baseline.id);
    });
    const snapshot = () => ({
      todos: rows(f.db, 'SELECT * FROM todos ORDER BY id'),
      projects: rows(f.db, 'SELECT * FROM projects ORDER BY id'),
      suggestions: rows(f.db, 'SELECT * FROM reconciliation_suggestions ORDER BY id'),
      evidence: rows(f.db, 'SELECT * FROM task_evidence ORDER BY id'),
      journal: database(f.db, db => db.prepare('PRAGMA journal_mode').get().journal_mode),
    });
    const before = snapshot();
    assert.equal(before.journal.toLowerCase(), journal);
    const listed = json(f, ['list', '--project', f.project]);
    assert.equal(listed.find(row => row.id === baseline.id).status, 'done');
    assert.equal(json(f, ['done', baseline.id]).status, 'done');
    assert.equal(json(f, ['chronicle', 'suggestions']).suggestions[0].occurred_at, '2026-01-01');
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(database(f.db, db => db.prepare('PRAGMA foreign_key_check').all()), []);
  }
});

test('a legacy table without status returns compatible JSON without backfilling stored rows', () => {
  const f = fixture();
  database(f.db, db => db.exec(`
    CREATE TABLE todos (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, emoji TEXT, due_date TEXT, due_time TEXT,
      completed INTEGER DEFAULT 0, reminder INTEGER DEFAULT 0, remind_at TEXT,
      reminder_fired INTEGER DEFAULT 0, source TEXT DEFAULT 'manual', priority TEXT DEFAULT 'none',
      notes TEXT, tags TEXT DEFAULT '[]', created_at TEXT NOT NULL
    );
    INSERT INTO todos(id,title,completed,created_at) VALUES
      ('legacy-done', 'Done', 1, '2026-01-01'), ('legacy-pending', 'Pending', 0, '2026-01-01');
  `));
  const listed = json(f, ['list', '--all']);
  assert.equal(listed.find(row => row.id === 'legacy-done').status, 'done');
  assert.equal(listed.find(row => row.id === 'legacy-pending').status, 'pending');
  assert.equal(json(f, ['done', 'legacy-done']).status, 'done');
  assert.deepEqual(rows(f.db, 'SELECT status FROM todos ORDER BY id').map(row => row.status), [null, null]);
});

test('duplicate upsert keys roll back all schema initialization without changing data', () => {
  const f = fixture();
  database(f.db, db => db.exec(`
    CREATE TABLE todos (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, completed INTEGER DEFAULT 0,
      project TEXT, upsert_key TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO todos(id,title,project,upsert_key,created_at) VALUES
      ('a','First','same','duplicate','2026-01-01'), ('b','Second','same','duplicate','2026-01-02');
  `));
  const beforeSchema = rows(f.db, "SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
  const beforeRows = rows(f.db, 'SELECT * FROM todos ORDER BY id');
  const result = execute(f, ['list', '--all', '--json'], { allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UNIQUE constraint failed/i);
  assert.deepEqual(rows(f.db, "SELECT type, name, sql FROM sqlite_master ORDER BY type, name"), beforeSchema);
  assert.deepEqual(rows(f.db, 'SELECT * FROM todos ORDER BY id'), beforeRows);
});

test('concurrent initialization and project registration remain consistent', async () => {
  const f = fixture();
  trackedProject(f.project);
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    runAsync(f, [ENTRY, 'add', `Concurrent outcome ${index}`, '--json'])));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(rows(f.db, 'SELECT COUNT(*) AS n FROM projects')[0].n, 1);
  assert.equal(rows(f.db, 'SELECT COUNT(*) AS n FROM todos')[0].n, 8);
  assert.equal(events(f.project).filter(event => event.type === 'task.add').length, 8);
  assert.equal(database(f.db, db => db.prepare('PRAGMA integrity_check').get().integrity_check), 'ok');
});

test('concurrent project identity creation is atomic and preserves existing fields', async () => {
  for (const existing of [false, true]) {
    const f = fixture();
    const dir = join(f.project, '.taskbean');
    mkdirSync(dir, { recursive: true });
    if (existing) writeFileSync(join(dir, 'project.json'), JSON.stringify({ custom: 'preserved' }));
    const url = pathToFileURL(resolve('src', 'data', 'project.js')).href;
    const script = `const { ensureProjectUuid } = await import(${JSON.stringify(url)}); console.log(ensureProjectUuid(process.argv[1]));`;
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      runAsync(f, ['--input-type=module', '-e', script, f.project])));
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const ids = new Set(results.map(result => result.stdout.trim()));
    assert.equal(ids.size, 1);
    const config = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    assert.equal(config.projectId, [...ids][0]);
    if (existing) assert.equal(config.custom, 'preserved');
    assert.ok(!existsSync(join(dir, 'project.json.lock')));
  }
});
