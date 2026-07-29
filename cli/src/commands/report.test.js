import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_HOME = join(tmpdir(), `taskbean-report-${Date.now()}`);
mkdirSync(TEST_HOME, { recursive: true });
process.env.TASKBEAN_HOME = TEST_HOME;
process.env.TASKBEAN_DB = join(TEST_HOME, 'taskbean.db');

const { reportCommand } = await import('./report.js');
const { closeDb, getDb, run } = await import('../data/store.js');

getDb();

function captureReport(opts) {
  const lines = [];
  const originalLog = console.log;
  console.log = value => lines.push(String(value));
  try {
    reportCommand(opts);
  } finally {
    console.log = originalLog;
  }
  return lines.join('\n').trim();
}

function insertSession(id, agent) {
  run(
    `INSERT INTO agent_sessions
       (id, agent, native_id, source_path, started_at, updated_at, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, agent, id, '/fake/source', '2026-07-28T10:00:00Z', '2026-07-28T11:00:00Z', '2026-07-28T11:00:00Z']
  );
}

function insertTurn(sessionId, agent, seq, totalTokens) {
  run(
    `INSERT INTO agent_turns
       (id, session_id, agent, seq, occurred_at, total_tokens)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [`${sessionId}:${seq}`, sessionId, agent, seq, '2026-07-28T10:30:00Z', totalTokens]
  );
}

function seedReportData() {
  run("INSERT INTO agent_settings (agent, enabled) VALUES ('copilot', 1)");
  run("INSERT INTO agent_settings (agent, enabled) VALUES ('codex', 1)");

  insertSession('copilot:linked', 'copilot');
  insertSession('codex:unlinked', 'codex');

  insertTurn('copilot:linked', 'copilot', 1, 300);
  insertTurn('copilot:linked', 'copilot', 2, 600);
  insertTurn('copilot:linked', 'copilot', 3, 900);
  insertTurn('codex:unlinked', 'codex', 1, 400);
  insertTurn('codex:unlinked', 'codex', 2, 600);

  run(
    `INSERT INTO todos
       (id, title, source, project, agent, agent_session_id, status, created_at)
     VALUES (?, ?, 'agent', 'report-test', 'copilot', 'copilot:linked', 'done', ?)`,
    ['task-1', 'first linked task', '2026-07-28T10:45:00Z']
  );
  run(
    `INSERT INTO todos
       (id, title, source, project, agent, agent_session_id, status, created_at)
     VALUES (?, ?, 'agent', 'report-test', 'copilot', 'copilot:linked', 'done', ?)`,
    ['task-2', 'second linked task', '2026-07-28T10:50:00Z']
  );
}

beforeEach(() => {
  run('DELETE FROM agent_turns');
  run('DELETE FROM agent_sessions');
  run('DELETE FROM agent_settings');
  run('DELETE FROM todos');
  seedReportData();
});

after(() => {
  closeDb();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('report effort and token efficiency', () => {
  it('includes linked ratios, omits unlinked ratios, and computes effort in JSON', () => {
    const report = JSON.parse(captureReport({ date: 'all', format: 'json' }));

    assert.equal(report.efficiency.minutesPerTurn, 3);

    const copilot = report.efficiency.byAgent.find(row => row.agent === 'copilot');
    assert.equal(copilot.turns, 3);
    assert.equal(copilot.totalTokens, 1800);
    assert.equal(copilot.estimatedEffortMinutes, 9);
    assert.equal(copilot.linkedTasks, 2);
    assert.equal(copilot.tokensPerTask, 900);

    const codex = report.efficiency.byAgent.find(row => row.agent === 'codex');
    assert.equal(codex.turns, 2);
    assert.equal(codex.totalTokens, 1000);
    assert.equal(codex.estimatedEffortMinutes, 6);
    assert.equal(codex.linkedTasks, 0);
    assert.equal(Object.hasOwn(codex, 'tokensPerTask'), false);
  });

  it('renders the same metrics in Markdown without a ratio for unlinked work', () => {
    const markdown = captureReport({ date: 'all', format: 'markdown' });

    assert.match(markdown, /## Effort & token efficiency/);
    assert.match(markdown, /Estimated effort uses 3 minutes per turn\./);
    assert.match(markdown, /\| Copilot\s+\|\s+1\s+\|\s+3\s+\|\s+1,800\s+\|\s+9\s+\|\s+2\s+\|\s+900\s+\|/);
    assert.match(markdown, /\| Codex\s+\|\s+1\s+\|\s+2\s+\|\s+1,000\s+\|\s+6\s+\|\s+0\s+\|\s+N\/A\s+\|/);
  });
});
