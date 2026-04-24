import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, platform } from 'os';
import { delimiter } from 'path';

// Absolute path (forward-slash form) to ~/.taskbean. TOML accepts forward
// slashes on Windows so we avoid backslash escaping.
function taskbeanDirForToml(home = homedir()) {
  return home.replace(/\\/g, '/') + '/.taskbean';
}

// Idempotently ensure ~/.codex/config.toml allows Codex's workspace-write
// sandbox to write to ~/.taskbean (so `bean add`/`bean done` can update the DB
// without --dangerously-bypass-approvals-and-sandbox).
//
// Codex reads [sandbox_workspace_write] writable_roots = [ ... ]. We preserve
// the rest of the file and only edit that one section.
//
// Implementation notes (per rubber-duck review):
//  - All edits are scoped to the span of the [sandbox_workspace_write] table.
//    We compute the section's start/end byte offsets first, then only look at
//    / rewrite that slice. Another section's writable_roots is untouched.
//  - Idempotency is decided by parsing the writable_roots array inside the
//    section (after stripping comments) — not by a global string search —
//    so comments containing the path don't false-positive.
//  - Line endings: detected from the existing file and preserved.
export function ensureCodexSandboxConfig(home = homedir()) {
  const configDir = join(home, '.codex');
  const configPath = join(configDir, 'config.toml');
  const wantPath = taskbeanDirForToml(home);
  const wantEntry = `"${wantPath}"`;

  let content = '';
  if (existsSync(configPath)) {
    content = readFileSync(configPath, 'utf-8');
  } else {
    mkdirSync(configDir, { recursive: true });
  }

  // Preserve dominant newline style (CRLF vs LF).
  const nl = /\r\n/.test(content) && !/(^|[^\r])\n/.test(content) ? '\r\n' : '\n';

  // Build a comment-stripped copy that is character-for-character aligned
  // with the original (so regex .index values from the analysis string can be
  // used to splice into the original). We walk the string once, replacing
  // only `#...` comment spans with spaces. Newlines and every other char are
  // preserved verbatim — CRLF included.
  const stripComments = (s) => {
    const out = s.split('');
    let inStr = false;
    let quote = '';
    let inComment = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\n' || c === '\r') {
        inComment = false; inStr = false; continue;
      }
      if (inComment) { out[i] = ' '; continue; }
      if (inStr) {
        if (c === '\\' && i + 1 < s.length) { i++; continue; }
        if (c === quote) inStr = false;
      } else if (c === '"' || c === "'") {
        inStr = true; quote = c;
      } else if (c === '#') {
        inComment = true; out[i] = ' ';
      }
    }
    return out.join('');
  };

  const analysis = stripComments(content);

  // Find [sandbox_workspace_write] header. Only top-level table (start of line,
  // no leading whitespace that would indicate a subtable under another context).
  const headerRe = /^[ \t]*\[sandbox_workspace_write\][ \t]*$/m;
  const headerMatch = analysis.match(headerRe);

  let updated;
  if (headerMatch) {
    // Compute section span in the ORIGINAL content. The comment-stripped and
    // original strings stay aligned character-for-character because we only
    // blanked characters within lines, never inserted/removed newlines.
    const sectionStart = headerMatch.index + headerMatch[0].length;
    const rest = analysis.slice(sectionStart);
    // Section ends at next top-level table header or EOF.
    const nextHeaderRe = /\r?\n[ \t]*\[[^\]]+\][ \t]*(?=\r?\n|$)/;
    const nextHeader = rest.match(nextHeaderRe);
    const sectionEnd = nextHeader ? sectionStart + nextHeader.index : content.length;

    const sectionBody = content.slice(sectionStart, sectionEnd);
    const sectionAnalysis = analysis.slice(sectionStart, sectionEnd);

    // Look for writable_roots within the section (single-line array only;
    // multi-line arrays fall through to replace-whole-array logic via regex
    // across the section span).
    const rootsRe = /^([ \t]*writable_roots[ \t]*=[ \t]*)\[([\s\S]*?)\]/m;
    const rootsInSection = sectionAnalysis.match(rootsRe);

    if (rootsInSection) {
      // Extract current entries from the analysis copy (no comments).
      const innerAnalysis = rootsInSection[2];
      const existingEntries = innerAnalysis
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      // Idempotency check: is our quoted path already one of the entries?
      if (existingEntries.includes(wantEntry)) {
        return { status: 'already_configured', path: configPath };
      }

      // Rewrite just this array inside the section.
      const newSectionBody = sectionBody.replace(rootsRe, (_m, prefix, inner) => {
        const trimmed = inner.trim();
        const sep = trimmed.length === 0 ? '' : (trimmed.endsWith(',') ? ' ' : ', ');
        return `${prefix}[${trimmed}${sep}${wantEntry}]`;
      });
      updated = content.slice(0, sectionStart) + newSectionBody + content.slice(sectionEnd);
    } else {
      // Section exists without writable_roots — insert the key right after
      // the header line.
      const insert = `${nl}writable_roots = [${wantEntry}]`;
      updated = content.slice(0, sectionStart) + insert + content.slice(sectionStart);
    }
  } else {
    // No section — append a fresh one with blank-line separation.
    const sep = content.length === 0 || content.endsWith('\n') || content.endsWith('\r\n') ? '' : nl;
    const pad = content.length === 0 ? '' : nl;
    updated = `${content}${sep}${pad}[sandbox_workspace_write]${nl}writable_roots = [${wantEntry}]${nl}`;
  }

  writeFileSync(configPath, updated);
  return { status: 'configured', path: configPath };
}

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
  'The user relies on taskbean to reconstruct what they accomplished each day and week.Every task you log here shows up in their reports — this is how they communicate their work to their manager. Missing a task means it\'s invisible.',
  '',
  '## When to log',
  '',
  'Call `taskbean add` when you begin any distinct unit of work:',
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
  '## Project Management',
  '',
  '```bash',
  '# List tracked projects (excludes hidden by default)',
  'bean projects --json',
  '',
  '# Include hidden projects',
  'bean projects --all --json',
  '',
  '# Filter by category',
  'bean projects --category work --json',
  '',
  '# Hide a project from default views (tasks still exist, just hidden from lists)',
  'bean projects hide [name] --json',
  '',
  '# Show a hidden project again',
  'bean projects show [name] --json',
  '',
  '# Set a category on a project (e.g. work, personal, oss)',
  'bean projects categorize [name] --category work --json',
  '',
  '# Remove a category',
  'bean projects categorize [name] --clear --json',
  '',
  '# Delete a project (removes DB entry + skill files, keeps tasks)',
  'bean projects delete [name] --confirm --json',
  '',
  '# Delete without cleaning up files on disk',
  'bean projects delete [name] --confirm --keep-files --json',
  '',
  '# Untrack a project (also removes installed skill files)',
  'bean untrack --json',
  '```',
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

// Scan process.env.PATH for an executable matching `name` (with Windows
// .exe/.cmd/.bat suffix fallback). Returns true if any PATH entry contains
// a file that exists with that name.
export function isOnPath(name, env = process.env) {
  const path = env.PATH || env.Path || '';
  if (!path) return false;
  const entries = path.split(delimiter).filter(Boolean);
  const isWin = platform() === 'win32';
  // On Windows, include '' so unsuffixed shims (e.g. npm bash shims) resolve,
  // and include .PS1 — a common extension for PowerShell CLIs on PATHEXT.
  const exts = isWin
    ? ['', ...((env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1').split(';').map((e) => e.toLowerCase()))]
    : [''];
  for (const entry of entries) {
    for (const ext of exts) {
      const candidate = join(entry, name + ext);
      try { if (existsSync(candidate)) return true; } catch { /* ignore */ }
    }
  }
  return false;
}

// Agent binary names to probe for `--agent auto`.
const AUTO_AGENTS = ['copilot', 'claude', 'codex', 'opencode'];

export function detectAgents(env = process.env) {
  return AUTO_AGENTS.filter((name) => isOnPath(name, env));
}

// Map an --agent value to the set of skill directories we should write into.
// Keep in sync with the block comment in installCommand() below.
function skillTargetsFor(agent, base) {
  const targets = [];
  if (!agent || agent === 'copilot' || agent === 'codex' || agent === 'opencode' || agent === 'all') {
    targets.push(join(base, '.agents', 'skills', 'taskbean'));
  }
  if (agent === 'copilot' || agent === 'all') {
    targets.push(join(base, '.github', 'skills', 'taskbean'));
  }
  if (agent === 'claude' || agent === 'all') {
    targets.push(join(base, '.claude', 'skills', 'taskbean'));
  }
  return [...new Set(targets)];
}

function installSkillForAgent(agent, base, force) {
  const targets = skillTargetsFor(agent, base);
  const results = [];
  for (const targetDir of targets) {
    const targetFile = join(targetDir, 'SKILL.md');
    const already = existsSync(targetFile);
    if (already && !force) {
      results.push({ status: 'already_installed', path: targetFile });
      continue;
    }
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetFile, SKILL_MD);
    results.push({ status: already ? 'updated' : 'installed', path: targetFile });
  }
  return results;
}

export function installCommand(opts) {
  const isGlobal = opts.global;
  const force = opts.force || false;
  let agent = opts.agent;
  const base = isGlobal ? homedir() : process.cwd();

  // --agent auto: probe PATH and install into every detected agent.
  if (agent === 'auto') {
    const detected = detectAgents();
    if (detected.length === 0) {
      const msg = 'No supported agent CLIs found on PATH. Install one of: copilot, claude, codex, opencode.';
      if (opts.json) {
        console.error(JSON.stringify({ error: 'no_agents_detected', message: msg }));
      } else {
        console.error(`❌ ${msg}`);
      }
      process.exitCode = 2;
      return;
    }
    const allResults = [];
    for (const detectedAgent of detected) {
      const perAgentResults = installSkillForAgent(detectedAgent, base, force);
      for (const r of perAgentResults) allResults.push({ ...r, agent: detectedAgent });
    }
    if (opts.codexSandbox && detected.includes('codex')) {
      allResults.push({ ...ensureCodexSandboxConfig(), agent: 'codex' });
    }
    if (opts.json) {
      console.log(JSON.stringify({ detected, results: allResults }));
    } else {
      console.log(`🔍 Detected agents on PATH: ${detected.join(', ')}`);
      for (const r of allResults) {
        const icon =
          r.status === 'already_installed' || r.status === 'already_configured' ? '✅'
          : r.status === 'updated' ? '🔄'
          : r.status === 'configured' ? '🔧'
          : '📋';
        console.log(`${icon} [${r.agent}] ${r.status}: ${r.path}`);
      }
    }
    return;
  }

  const uniqueTargets = skillTargetsFor(agent, base);

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

  // Optional: configure Codex sandbox to allow ~/.taskbean writes. Only
  // meaningful alongside --agent codex or --agent all. If --codex-sandbox was
  // passed with the wrong (or missing) --agent, surface that loudly instead of
  // silently no-op'ing.
  if (opts.codexSandbox) {
    if (agent === 'codex' || agent === 'all') {
      results.push(ensureCodexSandboxConfig());
    } else {
      const msg = `--codex-sandbox requires --agent codex or --agent all (got ${agent ? `--agent ${agent}` : 'no --agent flag'})`;
      if (opts.json) {
        console.error(JSON.stringify({ error: msg }));
      } else {
        console.error(`❌ ${msg}`);
      }
      process.exitCode = 2;
      // Fall through and still print any skill-install results below.
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(results.length === 1 ? results[0] : results));
  } else {
    for (const r of results) {
      const icon =
        r.status === 'already_installed' || r.status === 'already_configured' ? '✅'
        : r.status === 'updated' ? '🔄'
        : r.status === 'configured' ? '🔧'
        : '📋';
      console.log(`${icon} ${r.status}: ${r.path}`);
    }
  }
}
