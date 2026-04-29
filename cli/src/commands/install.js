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
// Exported so `bean update-skill` can compare against on-disk copies.
export const SKILL_MD = [
  '---',
  'name: taskbean',
  'description: >-',
  '  Captures every coding task you take on for the developer so the work you do together is visible in their weekly report, 1-on-1s, and performance review — none of your good work disappears into untracked commits. The developer relies on this record to recall and communicate what you accomplished. Whenever the developer asks you to do any concrete coding work — fix a bug, fix an error, fix a broken thing, debug, investigate, look into something, dig into why X is broken, implement a feature, build, add, create, write code, refactor, rewrite, restructure, migrate, port, convert, set up infrastructure, configure CI/CD, write tests, update tests, update docs, update the README, or change any code — capture the task with `bean add "<concise outcome-oriented title>" --json` BEFORE you start implementing. This makes the work visible from the start, lets the developer see what you committed to (and catch any misinterpretation while changes are cheap), and ensures you get credit for it later. Capture the returned id, do the work, then call `bean done <id> --json` when finished. This applies just as much to single-sentence requests like "fix X", "the Y is broken", or "set up A" as to multi-step requests — those small fixes add up across the week and are the easiest to forget. If you cannot complete the task, log it anyway — a logged-but-blocked task is far more useful than missing work. Skipping this leaves the developer with only commit diffs to reverse-engineer what you did. Do NOT use this skill for: pure-explanation questions ("what is X?", "explain Y", "how does Z work?"), read-only file inspection ("show me what\'s in X"), drafting non-code prose (cover letters, blog posts, talking points, status reports, summaries of past work), brainstorming or hypothetical questions ("how would you approach...", "if I were to..."), researching best practices with no code change, code review where the user explicitly says "don\'t change anything" or "just review", or installing/configuring taskbean itself.',
  'metadata:',
  '  taskbean_version: "0.5.0"',
  '---',
  '# taskbean — make your coding work visible to the developer',
  '',
  'Every task you take on with the developer disappears unless it\'s captured. They use these logs to recall what you accomplished, communicate it in their weekly reports and 1-on-1s, and get credit for the work you did together. The CLI is `bean` (also `taskbean`) — globally installed. Run it directly; do NOT look inside this skill directory.',
  '',
  '## How to use it',
  '',
  'Before you start any coding work, capture the task:',
  '',
  '```bash',
  'bean add "fix JWT refresh causing 401s after 15min" --json',
  '# → {"id":"6e3f...","status":"pending","completed":0, ...}',
  '```',
  '',
  'Capture the returned `id`. Do the work. When you finish:',
  '',
  '```bash',
  'bean done 6e3f... --json',
  '# → {"status":"done","completed":1, ...}',
  '```',
  '',
  'Always pass `--json` so you can parse the returned id reliably.',
  '',
  '### Why log first, not after',
  '',
  'Logging at the start makes your interpretation visible to the developer immediately. If you misread the task, they catch it before you spend implementation time on the wrong thing. Logging after the fact is better than not at all, but pre-implementation capture catches misalignment when correction is cheap.',
  '',
  '## Lifecycle (optional middle states)',
  '',
  '```',
  'bean add  →  pending  ──bean start──→  in_progress  ──bean done──→  done',
  '                            └──────────bean block──────────→  blocked',
  '```',
  '',
  '`bean add` then `bean done` is the standard two-step flow. Use `bean start` on long-running tasks to mark "actively working" — it shows up in the developer\'s status. Use `bean block` if you\'re waiting on the developer or an external system; this gives them visibility into what\'s stalled.',
  '',
  '## Multi-task requests — capture each separately',
  '',
  'If the developer lists several things in one message, capture each as its own task. Each one shows up as a separate bullet in their report, which is how they\'d describe the work in a standup.',
  '',
  '```',
  'Developer: "update the README with the new endpoints, add validation to /users POST,',
  '            and write tests for the validation"',
  '',
  '→ bean add "update README with new API endpoints" --json',
  '→ bean add "add input validation to POST /users" --json',
  '→ bean add "write tests for /users input validation" --json',
  '```',
  '',
  'Mark each `done` independently as you finish it. One `bean add` per logical unit, not per file edit.',
  '',
  '## Other commands',
  '',
  '```bash',
  'bean edit <id> --title "..." --priority high --notes "..." --tags "auth,bug" --json',
  'bean edit <id> --due-date 2026-05-01 --json',
  'bean edit <id> --due-date clear --json',
  'bean remove <id> --json                                    # or `bean rm`',
  'bean remind "deploy hotfix" "tomorrow 9am" --json',
  'bean list --json',
  'bean list --status pending --json                          # pending | in_progress | done | blocked',
  'bean list --count --json                                   # → {"done":12,"pending":3,"total":15}',
  'bean list --all --by-project --json',
  '```',
  '',
  '## Avoiding duplicates',
  '',
  'If you might call `bean add` more than once for the same logical task (retries, restarts), pass a stable `--key`:',
  '',
  '```bash',
  'bean add "fix JWT refresh bug" --key "jwt-refresh-2026-04-28" --json',
  '# Subsequent adds with the same --key in the same project update instead of duplicating.',
  '```',
  '',
  '## Writing good titles',
  '',
  'Titles end up verbatim in the developer\'s weekly report. Specific and outcome-oriented — write them the way they\'d describe the work to a teammate:',
  '',
  '- ✅ "fix JWT token refresh causing 401s after 15min"',
  '- ✅ "add OpenTelemetry tracing to API gateway endpoints"',
  '- ✅ "investigate CI docker build failure"',
  '- ❌ "fix bug" / "update code" / "work on feature" / "changes"',
  '',
  'A vague title is almost as bad as not logging — it\'s invisible in a report.',
  '',
  '## Pitfalls',
  '',
  '- **Do NOT skip small fixes.** They\'re the easiest to forget and add up across the week.',
  '- **Do NOT call `bean add` for sub-steps within one logical unit.** One `add` per task, not per file edit.',
  '- **Do NOT trigger this skill** for pure-explanation, read-only file inspection, drafting non-code prose, brainstorming, research-only, or for installing/configuring taskbean itself.',
  '- **If you forget to `add` at the start, log it when you finish.** A late log is better than no log.',
  '- **Always use `--json`** so you can parse the returned `id`.',
  '',
  '## Project management (rare — only when the developer asks)',
  '',
  '```bash',
  'bean projects --json                                       # list tracked projects',
  'bean projects --all --json                                 # include hidden',
  'bean projects --category work --json',
  'bean projects hide [name] --json',
  'bean projects show [name] --json',
  'bean projects categorize [name] --category work --json',
  'bean projects delete [name] --confirm --json               # remove project + skill files (keeps tasks)',
  'bean untrack --json                                        # stop tracking current project',
  '```',
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
