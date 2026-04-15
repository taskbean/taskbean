import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

// SKILL.md content — the canonical source of truth.
// Uses concatenation to avoid template literal backtick escaping issues.
const SKILL_MD = [
  '---',
  'name: taskbean',
  'description: Automatically log tasks as you work so the user has a complete record of everything accomplished across their projects. Use this skill whenever you fix a bug, implement a feature, refactor code, update docs, investigate an issue, write tests, set up infrastructure, review a PR, or do any other distinct unit of coding work. Call bean at the START and END of every task — even small fixes. This is how the user tracks their work for weekly reports and 1-on-1s. If the user asks you to do multiple things, log each separately. Always use this skill when doing real coding work, even if the user never mentions tracking or logging.',
  '---',
  '# taskbean — automatic work logging',
  '',
  '`bean` is a globally installed CLI command (installed via `npm install -g taskbean`). Run it directly — do NOT look for it inside this skill directory.',
  '',
  'The user relies on taskbean to reconstruct what they accomplished each day and week. Every task you log here shows up in their reports — this is how they communicate their work to their manager. Missing a task means it\'s invisible.',
  '',
  '## When to log',
  '',
  'Call `bean add` when you begin any distinct unit of work:',
  '- Fixing a bug',
  '- Implementing a feature',
  '- Refactoring code',
  '- Writing or updating docs',
  '- Reviewing a PR',
  '- Investigating an issue',
  '- Setting up infrastructure or configuration',
  '',
  'If you\'re doing multiple things in one session, log each separately. A good rule: if you\'d describe it as a separate bullet point in a standup, it\'s a separate task.',
  '',
  '## Commands',
  '',
  '```bash',
  '# At the START of work — log what you\'re about to do',
  'bean add "fix auth middleware token expiry bug" --json',
  '# Returns: {"id":"...", "completed":0, ...}',
  '',
  '# When you FINISH — mark it done using the returned id',
  'bean done <id> --json',
  '# Returns: {"id":"...", "completed":1, ...}',
  '',
  '# Check what\'s already logged (avoid duplicates)',
  'bean list --json',
  '```',
  '',
  'Always pass `--json` so you can read the returned `id`.',
  '',
  '## Writing good task titles',
  '',
  'Task titles end up in the user\'s weekly report. Write them the way you\'d describe the work to a colleague — specific and outcome-oriented.',
  '',
  '**Good titles** (specific, reportable):',
  '- "fix auth middleware token expiry causing 401s on refresh"',
  '- "add OpenTelemetry tracing to API gateway endpoints"',
  '- "migrate user service from REST to gRPC"',
  '- "update README with new local development setup"',
  '',
  '**Bad titles** (vague, not useful in a report):',
  '- "fix bug"',
  '- "update code"',
  '- "work on feature"',
  '- "changes"',
  '',
  '## Gotchas',
  '',
  '- Do NOT skip logging because a task seems small — small fixes still matter in a weekly summary',
  '- Do NOT call `bean add` for sub-steps within a single task. One `add` per logical unit of work, not per file edit',
  '- If you forget to `add` at the start, call it when you finish — a late log is better than no log',
  '- The `--key` flag prevents duplicates: `bean add "title" --key "auth-fix" --json` — same key in the same project won\'t create a second task',
  '',
].join('\n');

export function installCommand(opts) {
  const isGlobal = opts.global;
  const force = opts.force || false;
  const agent = opts.agent;
  const base = isGlobal ? homedir() : process.cwd();

  // Determine which skill directories to install into.
  // Default (no --agent flag): .agents/skills/ only (cross-client interop per Agent Skills spec).
  // --agent all: installs to all known agent-specific paths.
  // --agent <name>: installs to that agent's specific path.
  const targets = [];
  if (!agent || agent === 'copilot') {
    targets.push(join(base, '.agents', 'skills', 'taskbean'));
  }
  if (agent === 'copilot' || agent === 'all') {
    targets.push(join(base, '.github', 'skills', 'taskbean'));
  }
  if (agent === 'claude' || agent === 'all') {
    targets.push(join(base, '.claude', 'skills', 'taskbean'));
  }
  if (agent === 'codex' || agent === 'all') {
    targets.push(join(base, '.codex', 'skills', 'taskbean'));
  }
  if (agent === 'opencode') {
    targets.push(join(base, '.agents', 'skills', 'taskbean'));
  }
  if (agent === 'all') {
    targets.push(join(base, '.agents', 'skills', 'taskbean'));
  }
  const uniqueTargets = [...new Set(targets)];

  const results = [];
  for (const targetDir of uniqueTargets) {
    const targetFile = join(targetDir, 'SKILL.md');
    if (existsSync(targetFile) && !force) {
      results.push({ status: 'already_installed', path: targetFile });
      continue;
    }
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetFile, SKILL_MD);
    results.push({ status: force && existsSync(targetFile) ? 'updated' : 'installed', path: targetFile });
  }

  if (opts.json) {
    console.log(JSON.stringify(results.length === 1 ? results[0] : results));
  } else {
    for (const r of results) {
      const icon = r.status === 'already_installed' ? '✅' : r.status === 'updated' ? '🔄' : '📋';
      console.log(`${icon} ${r.status}: ${r.path}`);
    }
  }
}
