import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const CLI_ROOT = process.cwd();
const BEAN = join(CLI_ROOT, 'bin', 'taskbean.js');
const TEST_ROOT = join(tmpdir(), `taskbean-brew-test-${process.pid}-${Date.now()}`);

function git(repo, args, options = {}) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function createRepo(name, origin) {
  const repo = join(TEST_ROOT, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Taskbean Test']);
  git(repo, ['config', 'user.email', 'taskbean@example.com']);
  git(repo, ['checkout', '-b', 'main']);
  if (origin) git(repo, ['remote', 'add', 'origin', origin]);
  return repo;
}

function commit(repo, name, timestamp) {
  writeFileSync(join(repo, `${name}.txt`), `${name}\n`);
  git(repo, ['add', `${name}.txt`]);
  git(repo, ['commit', '-m', name], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp,
    },
  });
}

function commandEnv(dbPath) {
  return {
    ...process.env,
    TASKBEAN_DB: dbPath,
    TASKBEAN_NO_UPGRADE_NOTICE: '1',
  };
}

function initializeDb(repo, dbPath) {
  execFileSync(process.execPath, [BEAN, 'list', '--json'], {
    cwd: repo,
    env: commandEnv(dbPath),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function insertSession(dbPath, session) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT INTO agent_sessions (
        id, agent, native_id, git_branch, repository, source_path,
        started_at, updated_at, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.agent || 'copilot',
      session.nativeId || session.id.replace(/^copilot:/, ''),
      session.branch ?? null,
      session.repository,
      '/fixture/session-store.db',
      session.startedAt,
      session.updatedAt,
      session.updatedAt
    );
  } finally {
    db.close();
  }
}

function runBrew(cwd, dbPath, json = true) {
  const args = [BEAN, 'brew'];
  if (json) args.push('--json');
  return spawnSync(process.execPath, args, {
    cwd,
    env: commandEnv(dbPath),
    encoding: 'utf-8',
  });
}

function brewJson(cwd, dbPath) {
  const result = runBrew(cwd, dbPath);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function brewJsonError(cwd, dbPath) {
  const result = runBrew(cwd, dbPath);
  assert.notEqual(result.status, 0);
  return JSON.parse(result.stdout);
}

before(() => mkdirSync(TEST_ROOT, { recursive: true }));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe('bean brew', () => {
  it('classifies only matching Copilot sessions as Brewed within the 7-day grace period', () => {
    const repo = createRepo(
      'https-brewed',
      'https://github.com/acme/coffee.git'
    );
    commit(repo, 'brewed', '2026-01-09T11:00:00Z');
    const dbPath = join(TEST_ROOT, 'https-brewed.db');
    initializeDb(repo, dbPath);

    const base = {
      startedAt: '2026-01-01T10:00:00Z',
      updatedAt: '2026-01-02T11:00:00Z',
      branch: 'main',
    };
    insertSession(dbPath, {
      ...base,
      id: 'copilot:brewed',
      repository: 'acme/coffee',
    });
    insertSession(dbPath, {
      ...base,
      id: 'codex:ignored',
      agent: 'codex',
      repository: 'acme/coffee',
    });
    insertSession(dbPath, {
      ...base,
      id: 'copilot:other-repo',
      repository: 'acme/tea',
    });

    const result = brewJson(repo, dbPath);
    assert.equal(result.repository, 'acme/coffee');
    assert.equal(result.grace_period_days, 7);
    assert.deepEqual(result.counts, { total: 1, brewed: 1, went_cold: 0 });
    assert.equal(result.sessions[0].session_id, 'copilot:brewed');
    assert.equal(result.sessions[0].state, 'Brewed');
    assert.match(result.sessions[0].commit_sha, /^[0-9a-f]+$/);
    assert.equal(
      Date.parse(result.sessions[0].commit_timestamp),
      Date.parse('2026-01-09T11:00:00Z')
    );
  });

  it('classifies a session as Went Cold when no author-date is in its window', () => {
    const repo = createRepo('went-cold', 'https://github.com/acme/cold.git');
    commit(repo, 'too-late', '2026-02-10T00:00:01Z');
    const dbPath = join(TEST_ROOT, 'went-cold.db');
    initializeDb(repo, dbPath);
    insertSession(dbPath, {
      id: 'copilot:cold',
      branch: 'main',
      repository: 'acme/cold',
      startedAt: '2026-02-01T00:00:00Z',
      updatedAt: '2026-02-02T00:00:00Z',
    });

    const result = brewJson(repo, dbPath);
    assert.equal(result.sessions[0].state, 'Went Cold');
    assert.equal(result.sessions[0].commit_sha, null);
    assert.equal(result.sessions[0].commit_timestamp, null);
  });

  it('scopes set branches and searches all branches only for null branches', () => {
    const repo = createRepo('branch-scope', 'https://github.com/acme/branches.git');
    commit(repo, 'old-main', '2025-12-01T00:00:00Z');
    git(repo, ['checkout', '-b', 'other']);
    commit(repo, 'other-branch', '2026-03-02T00:00:00Z');
    git(repo, ['checkout', 'main']);
    const dbPath = join(TEST_ROOT, 'branch-scope.db');
    initializeDb(repo, dbPath);

    const base = {
      repository: 'acme/branches',
      startedAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T12:00:00Z',
    };
    insertSession(dbPath, { ...base, id: 'copilot:scoped', branch: 'main' });
    insertSession(dbPath, { ...base, id: 'copilot:all', branch: null });

    const result = brewJson(repo, dbPath);
    const scoped = result.sessions.find(session => session.session_id === 'copilot:scoped');
    const all = result.sessions.find(session => session.session_id === 'copilot:all');
    assert.equal(scoped.state, 'Went Cold');
    assert.equal(all.state, 'Brewed');
    assert.equal(all.branch, null);
  });

  it('parses an SSH GitHub origin and renders human-readable rows', () => {
    const repo = createRepo('ssh-origin', 'git@github.com:acme/ssh-coffee.git');
    commit(repo, 'ssh-brewed', '2026-04-02T00:00:00Z');
    const dbPath = join(TEST_ROOT, 'ssh-origin.db');
    initializeDb(repo, dbPath);
    insertSession(dbPath, {
      id: 'copilot:ssh',
      branch: 'main',
      repository: 'acme/ssh-coffee',
      startedAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T12:00:00Z',
    });

    const json = brewJson(repo, dbPath);
    assert.equal(json.repository, 'acme/ssh-coffee');
    const text = runBrew(repo, dbPath, false);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Brew results for acme\/ssh-coffee/);
    assert.match(text.stdout, /\| Brewed \| copilot:ssh \| main \|/);
  });

  it('returns clear repository errors', () => {
    const outside = join(TEST_ROOT, 'not-a-repo');
    mkdirSync(outside, { recursive: true });
    assert.equal(
      brewJsonError(outside, join(TEST_ROOT, 'not-a-repo.db')).error,
      'brew_not_git_repository'
    );

    const noOrigin = createRepo('no-origin');
    assert.equal(
      brewJsonError(noOrigin, join(TEST_ROOT, 'no-origin.db')).error,
      'brew_origin_missing'
    );

    const unsupported = createRepo(
      'unsupported-origin',
      'https://secret-token@gitlab.com/acme/coffee.git'
    );
    const unsupportedResult = runBrew(
      unsupported,
      join(TEST_ROOT, 'unsupported-origin.db')
    );
    assert.notEqual(unsupportedResult.status, 0);
    const unsupportedError = JSON.parse(unsupportedResult.stdout);
    assert.equal(unsupportedError.error, 'brew_origin_unsupported');
    assert.equal(unsupportedResult.stdout.includes('secret-token'), false);
  });
});
