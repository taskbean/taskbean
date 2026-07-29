import { execFileSync, spawnSync } from 'child_process';
import { allRows } from '../data/store.js';
import { parseGitHubRepository, resolveGitRoot } from '../data/project.js';

const GRACE_PERIOD_DAYS = 7;
const GRACE_PERIOD_MS = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
const GIT_HISTORY_BUFFER_BYTES = 64 * 1024 * 1024;

class BrewError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function resolveRepository() {
  const gitRoot = resolveGitRoot();
  if (!gitRoot) {
    throw new BrewError(
      'brew_not_git_repository',
      'bean brew must be run from within a Git repository.'
    );
  }

  let remoteUrl;
  try {
    remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: gitRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new BrewError(
      'brew_origin_missing',
      'The current Git repository has no origin remote.'
    );
  }

  const repository = parseGitHubRepository(remoteUrl);
  if (!repository) {
    throw new BrewError(
      'brew_origin_unsupported',
      'The origin remote is not a recognizable GitHub HTTPS or SSH owner/repo URL.'
    );
  }
  return { gitRoot, repository };
}

function runGit(gitRoot, args) {
  const result = spawnSync('git', args, {
    cwd: gitRoot,
    encoding: 'utf-8',
    windowsHide: true,
    maxBuffer: GIT_HISTORY_BUFFER_BYTES,
  });
  if (result.error) {
    throw new BrewError('brew_git_failed', `Could not run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new BrewError(
      'brew_git_failed',
      `Git history search failed${detail ? `: ${detail}` : '.'}`
    );
  }
  return result.stdout;
}

function resolveBranchCommit(gitRoot, branch) {
  const result = spawnSync(
    'git',
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${branch}^{commit}`],
    {
      cwd: gitRoot,
      encoding: 'utf-8',
      windowsHide: true,
    }
  );
  if (result.error) {
    throw new BrewError('brew_git_failed', `Could not run git: ${result.error.message}`);
  }
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function readCommits(gitRoot, branch) {
  const args = ['log', '--format=%h%x00%aI'];
  if (branch) {
    const branchCommit = resolveBranchCommit(gitRoot, branch);
    if (!branchCommit) return [];
    args.push(branchCommit);
  } else {
    args.push('--all');
  }

  return runGit(gitRoot, args)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, timestamp] = line.split('\0');
      return { sha, timestamp, timestampMs: Date.parse(timestamp) };
    })
    .filter(commit => commit.sha && Number.isFinite(commit.timestampMs));
}

function sessionWindow(session) {
  const startMs = Date.parse(session.started_at);
  const endMs = Date.parse(session.updated_at);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new BrewError(
      'brew_invalid_session_time',
      `Copilot session ${session.id} has an invalid start or end timestamp.`
    );
  }
  if (endMs < startMs) {
    throw new BrewError(
      'brew_invalid_session_time',
      `Copilot session ${session.id} ends before it starts.`
    );
  }
  return { startMs, graceEndMs: endMs + GRACE_PERIOD_MS };
}

export function classifyBrewSessions(gitRoot, repository) {
  const sessions = allRows(
    `SELECT id, native_id, git_branch AS branch, repository, started_at, updated_at
       FROM agent_sessions
      WHERE agent = 'copilot'
        AND lower(repository) = lower(?)
      ORDER BY started_at, id`,
    [repository]
  );
  const commitCache = new Map();

  return sessions.map((session) => {
    const cacheKey = session.branch || '__all__';
    if (!commitCache.has(cacheKey)) {
      commitCache.set(cacheKey, readCommits(gitRoot, session.branch));
    }

    const { startMs, graceEndMs } = sessionWindow(session);
    const matchedCommit = commitCache.get(cacheKey)
      .filter(commit => commit.timestampMs >= startMs && commit.timestampMs <= graceEndMs)
      .sort((a, b) => a.timestampMs - b.timestampMs)[0] || null;

    return {
      session_id: session.id,
      branch: session.branch,
      repository,
      state: matchedCommit ? 'Brewed' : 'Went Cold',
      commit_sha: matchedCommit?.sha || null,
      commit_timestamp: matchedCommit?.timestamp || null,
    };
  });
}

function renderText(result) {
  if (result.sessions.length === 0) {
    return `No Copilot sessions found for ${result.repository}.`;
  }

  const lines = [
    `Brew results for ${result.repository}`,
    '',
    '| State | Session | Branch | Repository | Commit | Timestamp |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const session of result.sessions) {
    lines.push(
      `| ${session.state} | ${session.session_id} | ${session.branch || 'all branches'} | `
      + `${session.repository} | ${session.commit_sha || '-'} | ${session.commit_timestamp || '-'} |`
    );
  }
  return lines.join('\n');
}

export function brewCommand(opts) {
  try {
    const { gitRoot, repository } = resolveRepository();
    const sessions = classifyBrewSessions(gitRoot, repository);
    const result = {
      repository,
      grace_period_days: GRACE_PERIOD_DAYS,
      counts: {
        total: sessions.length,
        brewed: sessions.filter(session => session.state === 'Brewed').length,
        went_cold: sessions.filter(session => session.state === 'Went Cold').length,
      },
      sessions,
    };

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(renderText(result));
    }
  } catch (error) {
    const payload = {
      error: error.code || 'brew_failed',
      message: error.message,
    };
    if (opts.json) {
      console.log(JSON.stringify(payload));
    } else {
      console.error(`Error: ${payload.message}`);
    }
    process.exitCode = 1;
  }
}
