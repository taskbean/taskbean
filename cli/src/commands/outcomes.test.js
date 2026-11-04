import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'taskbean.js');

let root;
let projectDir;

function env(extra = {}) {
  return {
    ...process.env,
    HOME: root, USERPROFILE: root, APPDATA: join(root, 'AppData'), LOCALAPPDATA: join(root, 'Local'),
    COPILOT_HOME: join(root, '.copilot'),
    TASKBEAN_HOME: join(root, '.taskbean'), TASKBEAN_DB: join(root, '.taskbean', 'taskbean.db'),
    TASKBEAN_NO_WSL_REDIRECT: '1', TASKBEAN_NO_UPGRADE_NOTICE: '1', CI: '1',
    ...extra,
  };
}

function bean(args, extra) {
  return execFileSync(process.execPath, [CLI, ...args], { cwd: projectDir, env: env(extra), encoding: 'utf-8' });
}

function beanJson(args, extra) {
  return JSON.parse(bean([...args, '--json'], extra));
}

function db() {
  return new DatabaseSync(join(root, '.taskbean', 'taskbean.db'));
}

function sql(statement, params = []) {
  const handle = db();
  try { return handle.prepare(statement).run(...params); } finally { handle.close(); }
}

function rows(statement, params = []) {
  const handle = db();
  try { return handle.prepare(statement).all(...params); } finally { handle.close(); }
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'taskbean-outcomes-'));
  projectDir = join(root, 'repo-a');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(root, '.taskbean'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: projectDir });
  bean(['track', '--json']);
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('completion time (AC3)', () => {
  it('records completion on done, keeps JSON shape, and clears it on reopen through serve semantics', () => {
    const task = beanJson(['add', 'deliver completion time']);
    const done = beanJson(['done', task.id]);
    assert.equal(Object.hasOwn(done, 'completed_at'), false, 'done --json shape is unchanged');
    const [row] = rows('SELECT completed_at FROM todo_completions WHERE todo_id = ?', [task.id]);
    assert.ok(row && !Number.isNaN(Date.parse(row.completed_at)));
    const compact = JSON.parse(bean(['report', '--date', 'today', '--compact']));
    const delivered = compact.delivered.find(d => d.id === task.id);
    assert.equal(delivered.completionSource, 'recorded');
    assert.equal(delivered.completedAt, row.completed_at);
  });

  it('shows a completed task with no recorded time and no history as unknown, never guessed', () => {
    const task = beanJson(['add', 'legacy completed row']);
    sql("UPDATE todos SET completed = 1, status = 'done' WHERE id = ?", [task.id]);
    const compact = JSON.parse(bean(['report', '--date', 'today', '--compact']));
    assert.equal(compact.delivered.some(d => d.id === task.id), false);
    const unknown = compact.completedTimeUnknown.find(d => d.id === task.id);
    assert.ok(unknown, 'unknown-time completion is listed, not dropped');
    const md = bean(['report', '--date', 'today']);
    assert.match(md, /legacy completed row — created .*completion time not recorded/);
  });

  it('uses event history only for a real, non-synthetic completion transition', () => {
    const real = beanJson(['add', 'history real completion']);
    const synthetic = beanJson(['add', 'history synthetic completion']);
    sql("UPDATE todos SET completed = 1, status = 'done' WHERE id IN (?, ?)", [real.id, synthetic.id]);
    const ts = new Date(Date.now() - 60_000).toISOString();
    const events = [
      { ts, type: 'task.complete', payload: { taskId: real.id } },
      { ts, type: 'task.complete', payload: { taskId: synthetic.id, synthetic: true } },
    ].map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(projectDir, '.taskbean', 'events.jsonl'), events, { flag: 'a' });
    const compact = JSON.parse(bean(['report', '--date', 'today', '--compact']));
    const fromHistory = compact.delivered.find(d => d.id === real.id);
    assert.equal(fromHistory.completionSource, 'event-history');
    assert.equal(fromHistory.completedAt, ts);
    assert.ok(compact.completedTimeUnknown.find(d => d.id === synthetic.id));
  });

  it('removes the completion row when a task is removed', () => {
    const task = beanJson(['add', 'removed after done']);
    beanJson(['done', task.id]);
    beanJson(['remove', task.id]);
    assert.equal(rows('SELECT 1 FROM todo_completions WHERE todo_id = ?', [task.id]).length, 0);
  });
});

describe('status fidelity, evidence and grouping (AC1, AC4, AC5)', () => {
  it('separates the four states in list, --count and report, and shows blocked reasons', () => {
    const p = beanJson(['add', 'state pending item']);
    const ip = beanJson(['add', 'state in progress item']);
    const bl = beanJson(['add', 'state blocked item']);
    beanJson(['start', ip.id]);
    beanJson(['block', bl.id]);
    beanJson(['edit', bl.id, '--notes', 'waiting on security review']);
    const list = bean(['list']);
    assert.match(list, /⬚ \w+\s+state pending item\s+pending/);
    assert.match(list, /🔄 \w+\s+state in progress item\s+in progress/);
    assert.match(list, /🚫 \w+\s+state blocked item\s+blocked\n\s+↳ reason: waiting on security review/);
    assert.match(bean(['list', '--count']), /\d+ done, \d+ open \(\d+ pending, 1 in progress, 1 blocked\)/);
    const counts = beanJson(['list', '--count']);
    assert.deepEqual(Object.keys(counts), ['done', 'pending', 'total'], '--count --json shape is unchanged');
    const md = bean(['report', '--date', 'today']);
    assert.match(md, /- \*\*Blocked\*\*: 1/);
    assert.match(md, /- \*\*In progress\*\*: 1/);
    assert.match(md, /state blocked item — reason: waiting on security review/);
    assert.ok(p.id);
  });

  it('shows linked evidence for delivered items and "no evidence" otherwise', () => {
    const withEv = beanJson(['add', 'evidence delivered item']);
    const without = beanJson(['add', 'evidence missing item']);
    beanJson(['done', withEv.id]);
    beanJson(['done', without.id]);
    sql(`INSERT INTO task_evidence (id, todo_id, source, source_session_id, branch, pr_refs, issue_refs, files_changed, summary, confidence, occurred_at, created_at)
         VALUES ('ev-1', ?, 'chronicle', 'session-123', 'fix/branch', '["org/repo#42"]', '[]', '[]', 'metadata only', 1, ?, ?)`,
    [withEv.id, new Date().toISOString(), new Date().toISOString()]);
    const md = bean(['report', '--date', 'today']);
    assert.match(md, /evidence delivered item — completed .* — evidence: PR org\/repo#42; branch fix\/branch; session session-123/);
    assert.match(md, /evidence missing item — completed .* — evidence: no evidence/);
    const compact = JSON.parse(bean(['report', '--date', 'today', '--compact']));
    assert.deepEqual(compact.delivered.find(d => d.id === withEv.id).evidence, { prs: ['org/repo#42'], branches: ['fix/branch'], sessions: ['session-123'] });
    assert.equal(compact.delivered.find(d => d.id === without.id).evidence, null);
  });

  it('groups --all and the report by repository (project field)', () => {
    const other = join(root, 'repo-b');
    mkdirSync(other, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: other });
    execFileSync(process.execPath, [CLI, 'track', '--json'], { cwd: other, env: env(), encoding: 'utf-8' });
    execFileSync(process.execPath, [CLI, 'add', 'work in second repo', '--json'], { cwd: other, env: env(), encoding: 'utf-8' });
    const all = bean(['list', '--all']);
    assert.match(all, /📁 repo-a — /);
    assert.match(all, /📁 repo-b — 0 done, 1 open/);
    const md = bean(['report', '--date', 'today']);
    assert.match(md, /### 📁 repo-b\n- work in second repo/);
  });

  it('keeps the existing report --json keys', () => {
    const report = beanJson(['report', '--date', 'today']);
    assert.deepEqual(Object.keys(report).filter(k => !['usage', 'efficiency', 'chronicle'].includes(k)), ['period', 'since', 'until', 'tasks', 'taskGroups']);
    assert.deepEqual(Object.keys(report.taskGroups), ['completed', 'in_progress', 'blocked', 'pending']);
  });

  it('keeps task, list, count and report JSON keys with recorded completion and commit evidence', () => {
    const task = beanJson(['add', 'legacy JSON contract fixture']);
    const taskKeys = Object.keys(task).sort();
    const completed = beanJson(['done', task.id]);
    sql(`INSERT INTO task_evidence (id, todo_id, source, source_session_id, commit_refs, confidence, created_at)
         VALUES ('contract-commit', ?, 'chronicle', 'synthetic-session', '["abc1234"]', 1, ?)`,
    [task.id, new Date().toISOString()]);
    assert.deepEqual(Object.keys(completed).sort(), taskKeys);
    for (const args of [['list'], ['list', '--all']]) {
      const listed = beanJson(args).find(t => t.id === task.id);
      assert.deepEqual(Object.keys(listed).sort(), taskKeys);
    }
    assert.deepEqual(Object.keys(beanJson(['list', '--all', '--count'])).sort(), ['done', 'pending', 'total']);
    for (const counts of Object.values(beanJson(['list', '--all', '--by-project']))) {
      assert.deepEqual(Object.keys(counts).sort(), ['done', 'pending', 'total']);
    }
    for (const args of [['report', '--date', 'all'], ['report', '--date', 'all', '--include-chronicle']]) {
      const report = beanJson(args);
      assert.deepEqual(Object.keys(report.tasks.find(t => t.id === task.id)).sort(), taskKeys);
      assert.deepEqual(Object.keys(report.taskGroups.completed.find(t => t.id === task.id)).sort(), taskKeys);
      assert.equal(JSON.stringify(report).includes('abc1234'), false, 'legacy JSON does not expose commit evidence');
    }
    const compact = JSON.parse(bean(['report', '--date', 'all', '--compact']));
    assert.deepEqual(compact.delivered.find(t => t.id === task.id).evidence.commits, ['abc1234']);
  });
});

describe('local-day report boundaries (AC2)', () => {
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo']) {
    it(`assigns tasks to local days in ${tz}`, () => {
      const script = `
        import { getDateRange, inPeriod } from ${JSON.stringify(new URL('../data/periods.js', import.meta.url).href)};
        const now = new Date(2026, 4, 1, 23, 30); // local 2026-05-01 23:30
        const today = getDateRange('today', now);
        const lateLocal = new Date(2026, 4, 1, 22, 0).toISOString();
        const earlyLocal = new Date(2026, 4, 1, 0, 30).toISOString();
        const yesterdayLate = new Date(2026, 3, 30, 23, 59).toISOString();
        const tomorrowEarly = new Date(2026, 4, 2, 0, 1).toISOString();
        console.log(JSON.stringify({
          since: today.since, until: today.until,
          late: inPeriod(lateLocal, today), early: inPeriod(earlyLocal, today),
          yesterday: inPeriod(yesterdayLate, today), tomorrow: inPeriod(tomorrowEarly, today),
          utcDateOfLate: lateLocal.slice(0, 10), utcDateOfEarly: earlyLocal.slice(0, 10),
          week: getDateRange('week', now).since,
        }));`;
      const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf-8' }));
      assert.equal(out.since, '2026-05-01');
      assert.equal(out.until, '2026-05-01');
      assert.equal(out.week, '2026-04-24');
      assert.equal(out.late, true);
      assert.equal(out.early, true);
      assert.equal(out.yesterday, false);
      assert.equal(out.tomorrow, false);
      // The old date(created_at) filter compared these UTC prefixes; prove the offset matters here.
      if (tz === 'America/Los_Angeles') assert.equal(out.utcDateOfLate, '2026-05-02');
      if (tz === 'Asia/Tokyo') assert.equal(out.utcDateOfEarly, '2026-04-30');
    });
  }

  it('includes an evening task in "today" for a negative UTC offset end to end', () => {
    const tz = 'America/Los_Angeles';
    const task = beanJson(['add', 'evening negative offset task'], { TZ: tz });
    // Created at 23:30 local today — after UTC midnight.
    const script = `const n=new Date(); console.log(new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 30).toISOString())`;
    const lateIso = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf-8' }).trim();
    sql('UPDATE todos SET created_at = ? WHERE id = ?', [lateIso, task.id]);
    const report = beanJson(['report', '--date', 'today'], { TZ: tz });
    assert.ok(report.tasks.some(t => t.id === task.id), 'evening task is in today');
  });
});
