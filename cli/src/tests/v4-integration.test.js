import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const BEAN = 'node ' + join(process.cwd(), 'bin', 'taskbean.js');
const TEST_DIR = join(tmpdir(), 'taskbean-v4-' + Date.now());

function bean(args) {
  try {
    return execSync(`${BEAN} ${args}`, {
      encoding: 'utf-8',
      env: { ...process.env, HOME: TEST_DIR, USERPROFILE: TEST_DIR },
      cwd: TEST_DIR,
    }).trim();
  } catch (e) {
    if (e.stdout) return e.stdout.trim();
    throw e;
  }
}

function beanJson(args) {
  return JSON.parse(bean(`${args} --json`));
}

describe('v0.4 CLI → todos table integration', () => {
  before(() => { mkdirSync(TEST_DIR, { recursive: true }); });
  after(() => { try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {} });

  it('add writes to todos table with source=agent', () => {
    const task = beanJson('add "fix auth middleware"');
    assert.ok(task.id, 'should have UUID id');
    assert.equal(task.title, 'fix auth middleware');
    assert.equal(task.completed, 0);
    assert.equal(task.source, 'agent');
    assert.ok(task.created_at);
  });

  it('add sets project from cwd basename', () => {
    const task = beanJson('add "test project detection"');
    assert.ok(task.project, 'should have project set');
  });

  it('add with --key does upsert (same id, updated title)', () => {
    const t1 = beanJson('add "original title" --key upsert-test');
    const t2 = beanJson('add "updated title" --key upsert-test');
    assert.equal(t1.id, t2.id, 'upsert should keep same id');
    assert.equal(t2.title, 'updated title');
  });

  it('done sets completed=1', () => {
    const task = beanJson('add "task to complete"');
    const done = beanJson(`done ${task.id}`);
    assert.equal(done.completed, 1);
  });

  it('done is idempotent', () => {
    const task = beanJson('add "idempotent test"');
    beanJson(`done ${task.id}`);
    const again = beanJson(`done ${task.id}`);
    assert.equal(again.completed, 1);
  });

  it('done by positional index works', () => {
    const task = beanJson('add "positional task"');
    const done = beanJson('done 1');
    assert.equal(done.id, task.id);
    assert.equal(done.completed, 1);
  });

  it('done with bad id returns error', () => {
    const result = beanJson('done nonexistent-id-12345');
    assert.equal(result.error, 'not_found');
  });

  it('list returns JSON array from todos table', () => {
    const tasks = beanJson('list');
    assert.ok(Array.isArray(tasks));
    assert.ok(tasks.length > 0);
    assert.ok(tasks[0].source, 'should have source field (from todos table)');
  });

  it('list --count returns totals', () => {
    const counts = beanJson('list --count');
    assert.ok(typeof counts.total === 'number');
    assert.ok(typeof counts.done === 'number');
    assert.ok(typeof counts.pending === 'number');
  });

  it('report --format json returns structured data', () => {
    const raw = bean('report --date all --format json');
    const report = JSON.parse(raw);
    assert.ok(report.period);
    assert.ok(Array.isArray(report.tasks));
    assert.ok(report.tasks.length > 0);
  });

  it('report --format csv returns csv with header', () => {
    const csv = bean('report --date all --format csv');
    const lines = csv.split('\n');
    assert.equal(lines[0], 'id,title,completed,project,source,created_at');
    assert.ok(lines.length > 1);
  });
});

describe('v0.4 agent workflow E2E', () => {
  const DIR2 = join(tmpdir(), 'taskbean-e2e-' + Date.now());
  before(() => { mkdirSync(DIR2, { recursive: true }); });
  after(() => { try { rmSync(DIR2, { recursive: true, force: true }); } catch {} });

  function b(args) {
    try {
      return execSync(`${BEAN} ${args}`, {
        encoding: 'utf-8',
        env: { ...process.env, HOME: DIR2, USERPROFILE: DIR2 },
        cwd: DIR2,
      }).trim();
    } catch (e) { if (e.stdout) return e.stdout.trim(); throw e; }
  }
  function bj(args) { return JSON.parse(b(`${args} --json`)); }

  it('full agent session: add 3, done 2, verify counts + report', () => {
    const t1 = bj('add "fix JWT refresh" --key auth');
    const t2 = bj('add "update README" --key readme');
    const t3 = bj('add "add validation" --key validation');

    bj(`done ${t1.id}`);
    bj(`done ${t2.id}`);

    const counts = bj('list --count');
    assert.equal(counts.done, 2);
    assert.equal(counts.pending, 1);
    assert.equal(counts.total, 3);

    const raw = b('report --date all --format json');
    const report = JSON.parse(raw);
    assert.equal(report.tasks.length, 3);
  });

  it('upsert prevents duplicates', () => {
    bj('add "deploy staging" --key deploy');
    bj('add "deploy staging" --key deploy');
    bj('add "deploy staging" --key deploy');

    const tasks = bj('list');
    const deploys = tasks.filter(t => t.upsert_key === 'deploy');
    assert.equal(deploys.length, 1);
  });
});
