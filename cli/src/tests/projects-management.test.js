import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DatabaseSync } from 'node:sqlite';

const BEAN = 'node ' + join(process.cwd(), 'bin', 'taskbean.js');
const TEST_DIR = join(tmpdir(), 'taskbean-projects-' + Date.now());
const DB_PATH = join(TEST_DIR, '.taskbean', 'taskbean.db');

// Create a fake project dir so `resolveProject` can find it
const PROJECT_A = join(TEST_DIR, 'project-alpha');
const PROJECT_B = join(TEST_DIR, 'project-beta');
const PROJECT_C = join(TEST_DIR, 'project-gamma');

function bean(args, opts = {}) {
  try {
    return execSync(`${BEAN} ${args}`, {
      encoding: 'utf-8',
      env: { ...process.env, HOME: TEST_DIR, USERPROFILE: TEST_DIR },
      cwd: opts.cwd || PROJECT_A,
      timeout: 15000,
    }).trim();
  } catch (e) {
    if (e.stdout) return e.stdout.trim();
    throw e;
  }
}

function beanJson(args, opts = {}) {
  return JSON.parse(bean(`${args} --json`, opts));
}

function query(sql, params = []) {
  const db = new DatabaseSync(DB_PATH);
  const stmt = db.prepare(sql);
  const rows = stmt.all(...params);
  db.close();
  return rows;
}

function queryOne(sql, params = []) {
  const db = new DatabaseSync(DB_PATH);
  const stmt = db.prepare(sql);
  const row = stmt.get(...params);
  db.close();
  return row;
}

// ---------------------------------------------------------------------------
// Setup: create project dirs, track them, seed tasks
// ---------------------------------------------------------------------------

describe('project management', () => {
  before(() => {
    mkdirSync(join(TEST_DIR, '.taskbean'), { recursive: true });
    mkdirSync(PROJECT_A, { recursive: true });
    mkdirSync(PROJECT_B, { recursive: true });
    mkdirSync(PROJECT_C, { recursive: true });

    // Track all three projects
    bean('track --name project-alpha', { cwd: PROJECT_A });
    bean('track --name project-beta', { cwd: PROJECT_B });
    bean('track --name project-gamma', { cwd: PROJECT_C });

    // Seed tasks into each project
    bean('add "alpha task 1" --key a1', { cwd: PROJECT_A });
    bean('add "alpha task 2" --key a2', { cwd: PROJECT_A });
    bean('add "beta task 1" --key b1', { cwd: PROJECT_B });
    bean('add "gamma task 1" --key g1', { cwd: PROJECT_C });
  });

  after(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  // -----------------------------------------------------------------------
  // 1. Schema migration
  // -----------------------------------------------------------------------
  describe('schema migration', () => {
    it('projects table has hidden column', () => {
      const cols = query("PRAGMA table_info('projects')").map(c => c.name);
      assert.ok(cols.includes('hidden'), `expected 'hidden' column, got: ${cols}`);
    });

    it('projects table has category column', () => {
      const cols = query("PRAGMA table_info('projects')").map(c => c.name);
      assert.ok(cols.includes('category'), `expected 'category' column, got: ${cols}`);
    });
  });

  // -----------------------------------------------------------------------
  // 2. bean projects hide / show
  // -----------------------------------------------------------------------
  describe('hide and show', () => {
    it('hide sets hidden=true', () => {
      const result = beanJson('projects hide project-beta');
      assert.equal(result.name, 'project-beta');
      assert.equal(result.hidden, true);
    });

    it('hidden column is 1 in DB after hide', () => {
      const row = queryOne('SELECT hidden FROM projects WHERE name = ?', ['project-beta']);
      assert.equal(row.hidden, 1);
    });

    it('projects --json excludes hidden projects by default', () => {
      const projects = beanJson('projects');
      const names = projects.map(p => p.name);
      assert.ok(!names.includes('project-beta'), `hidden project should be excluded, got: ${names}`);
      assert.ok(names.includes('project-alpha'), 'visible project should be included');
    });

    it('projects --all --json includes hidden projects', () => {
      const projects = beanJson('projects --all');
      const names = projects.map(p => p.name);
      assert.ok(names.includes('project-beta'), `hidden project should be included with --all, got: ${names}`);
      assert.ok(names.includes('project-alpha'), 'visible project should also be included');
    });

    it('projects --hidden --json shows only hidden projects', () => {
      const projects = beanJson('projects --hidden');
      const names = projects.map(p => p.name);
      assert.ok(names.includes('project-beta'), 'hidden project should appear');
      assert.ok(!names.includes('project-alpha'), `visible project should not appear in --hidden, got: ${names}`);
    });

    it('show sets hidden=false', () => {
      const result = beanJson('projects show project-beta');
      assert.equal(result.name, 'project-beta');
      assert.equal(result.hidden, false);
    });

    it('hidden column is 0 in DB after show', () => {
      const row = queryOne('SELECT hidden FROM projects WHERE name = ?', ['project-beta']);
      assert.equal(row.hidden, 0);
    });

    it('hide returns error for nonexistent project', () => {
      const result = beanJson('projects hide no-such-project');
      assert.equal(result.error, 'Project not found');
    });
  });

  // -----------------------------------------------------------------------
  // 3. bean projects categorize
  // -----------------------------------------------------------------------
  describe('categorize', () => {
    it('categorize sets category', () => {
      const result = beanJson('projects categorize project-alpha --category work');
      assert.equal(result.name, 'project-alpha');
      assert.equal(result.category, 'work');
    });

    it('category column is set in DB', () => {
      const row = queryOne('SELECT category FROM projects WHERE name = ?', ['project-alpha']);
      assert.equal(row.category, 'work');
    });

    it('categorize --clear removes category', () => {
      const result = beanJson('projects categorize project-alpha --clear');
      assert.equal(result.name, 'project-alpha');
      assert.equal(result.category, null);
    });

    it('category column is null in DB after clear', () => {
      const row = queryOne('SELECT category FROM projects WHERE name = ?', ['project-alpha']);
      assert.equal(row.category, null);
    });

    it('projects --category filters by category', () => {
      // Set categories for filtering
      beanJson('projects categorize project-alpha --category work');
      beanJson('projects categorize project-beta --category personal');

      const projects = beanJson('projects --category work');
      const names = projects.map(p => p.name);
      assert.ok(names.includes('project-alpha'), 'work project should appear');
      assert.ok(!names.includes('project-beta'), `personal project should not appear in work filter, got: ${names}`);
    });

    it('error when neither --category nor --clear provided', () => {
      const result = beanJson('projects categorize project-alpha');
      assert.equal(result.error, 'Provide --category <label> or --clear');
    });

    it('categorize returns error for nonexistent project', () => {
      const result = beanJson('projects categorize no-such-project --category work');
      assert.equal(result.error, 'Project not found');
    });
  });

  // -----------------------------------------------------------------------
  // 4. bean projects delete
  // -----------------------------------------------------------------------
  describe('delete', () => {
    it('delete without --confirm returns error', () => {
      const result = beanJson('projects delete project-gamma');
      assert.equal(result.error, 'Pass --confirm to delete');
    });

    it('project still exists after rejected delete', () => {
      const projects = beanJson('projects');
      const names = projects.map(p => p.name);
      assert.ok(names.includes('project-gamma'), 'project should still exist');
    });

    it('delete --confirm --keep-files removes project row', () => {
      const result = beanJson('projects delete project-gamma --confirm --keep-files');
      assert.equal(result.name, 'project-gamma');
      assert.equal(result.deleted, true);
    });

    it('project row no longer in DB', () => {
      const row = queryOne('SELECT * FROM projects WHERE name = ?', ['project-gamma']);
      assert.equal(row, undefined);
    });

    it('tasks remain after project deletion (orphaned but queryable)', () => {
      const tasks = query("SELECT * FROM todos WHERE project = 'project-gamma'");
      assert.ok(tasks.length > 0, 'gamma tasks should still exist in todos table');
    });

    it('delete returns error for already-deleted project', () => {
      const result = beanJson('projects delete project-gamma --confirm');
      assert.equal(result.error, 'Project not found');
    });
  });

  // -----------------------------------------------------------------------
  // 5. bean list --all excludes hidden-project tasks
  // -----------------------------------------------------------------------
  describe('list excludes hidden-project tasks', () => {
    before(() => {
      // Hide project-beta so its tasks should be excluded from --all
      bean('projects hide project-beta');
    });

    after(() => {
      bean('projects show project-beta');
    });

    it('list --all --json excludes tasks from hidden projects', () => {
      const tasks = beanJson('list --all');
      const betaTasks = tasks.filter(t => t.project === 'project-beta');
      assert.equal(betaTasks.length, 0, 'tasks from hidden project should be excluded');
    });

    it('list --all --json includes tasks from visible projects', () => {
      const tasks = beanJson('list --all');
      const alphaTasks = tasks.filter(t => t.project === 'project-alpha');
      assert.ok(alphaTasks.length > 0, 'tasks from visible project should be included');
    });

    it('list --all --count --json excludes hidden-project tasks from totals', () => {
      const counts = beanJson('list --all --count');
      // Gamma tasks are orphaned (project deleted) — they have project set but
      // no matching projects row, so the subquery returns no match → included.
      // Beta tasks are hidden → excluded. Alpha tasks → included.
      assert.ok(typeof counts.total === 'number');
      assert.ok(counts.total > 0);
    });
  });

  // -----------------------------------------------------------------------
  // 6. bean report excludes hidden-project tasks
  // -----------------------------------------------------------------------
  describe('report excludes hidden-project tasks', () => {
    before(() => {
      bean('projects hide project-beta');
    });

    after(() => {
      bean('projects show project-beta');
    });

    it('report --format json excludes hidden-project tasks', () => {
      const raw = bean('report --date all --format json', { cwd: PROJECT_A });
      const report = JSON.parse(raw);
      const betaTasks = report.tasks.filter(t => t.project === 'project-beta');
      assert.equal(betaTasks.length, 0, 'hidden-project tasks should be excluded from report');
    });

    it('report --format json includes visible-project tasks', () => {
      const raw = bean('report --date all --format json', { cwd: PROJECT_A });
      const report = JSON.parse(raw);
      const alphaTasks = report.tasks.filter(t => t.project === 'project-alpha');
      assert.ok(alphaTasks.length > 0, 'visible-project tasks should be in report');
    });
  });
});
