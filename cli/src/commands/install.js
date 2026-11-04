import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, platform } from 'os';
import { delimiter } from 'path';
import { AGENT_REGISTRY, getAgent } from '../data/agents.js';

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
  '  Records outcome-level evidence of coding work in Taskbean for standups, weekly reports, 1-on-1s, and AI-value evidence. Use when a coding request will deliver a meaningful outcome the developer would report (fix, implement, debug, investigate, refactor, CI/CD): record one outcome and close or block it with `bean add`, `bean done`, or `bean block` --json. Also use to correct a captured record, for Taskbean reporting and standup or AI-value summaries, and for observe-only Chronicle evidence review or diagnostics with `bean chronicle doctor --json`. Commands, retries, branches, and sub-steps are evidence on an outcome, not separate tasks. Do NOT use for pure explanation, read-only inspection, brainstorming, non-code prose, code review with no changes, installing taskbean itself, plan-mode steps, or commitments that belong in Planner or Microsoft To Do.',
  'metadata:',
  '  taskbean_version: "0.7.0"',
  '---',
  '# taskbean — outcomes and evidence for the developer\'s reports',
  '',
  'Taskbean connects the outcomes of coding work to execution evidence, so the developer can explain what was delivered and what AI contributed in standups, weekly reports, 1-on-1s, and leadership updates. It is not a universal task system. The CLI is `bean` (also `taskbean`) — globally installed. Run it directly; do NOT look inside this skill directory. Always pass `--json`.',
  '',
  '## Who owns what',
  '',
  '| Source | Owns |',
  '|--------|------|',
  '| Planner and Microsoft To Do | Commitments, owners, due dates, assignments |',
  '| Durable priorities | Strategic outcomes |',
  '| Copilot sessions and plan mode | Execution evidence (ephemeral; not durable task storage) |',
  '| Taskbean | Outcomes connected to that evidence, for reports and review |',
  '',
  'Do not copy a Planner or To Do commitment into Taskbean, and do not set a competing owner or due date for it. Do not create Taskbean tasks for plan-mode steps.',
  '',
  '## Outcomes, not steps',
  '',
  'An outcome is one meaningful result the developer would name in a standup: "fix JWT refresh causing 401s after 15min", not "edit auth.js" or "rerun CI".',
  '',
  '- One request that delivers one result is one outcome, even if it touches docs, code, and tests.',
  '- Commands, retries, CI reruns, lint runs, branches, worktrees, and small sub-steps are evidence on the outcome, not separate tasks.',
  '- A request with clearly unrelated results can hold more than one outcome. Do not split one result into a task per ask.',
  '- Whether a standalone small fix with no surrounding outcome needs its own record is undecided; follow the developer\'s preference.',
  '',
  '## Recording an outcome',
  '',
  'Taskbean does not require a record before every request or every turn. Automatic capture through Copilot hooks (#115) is not shipped in this version, so do not assume hooks ran. When a request delivers a meaningful outcome and no record exists, record it once with a stable key:',
  '',
  '```bash',
  'bean add "fix JWT refresh causing 401s after 15min" --key "jwt-refresh-401" --json',
  '# → {"id":"6e3f...","status":"pending", ...}',
  'bean done 6e3f... --json        # when the outcome is delivered',
  'bean block 6e3f... --json       # when it waits on the developer or an external system',
  'bean start 6e3f... --json       # optional, for long-running outcomes',
  '```',
  '',
  'A repeated `bean add` with the same `--key` in the same project updates the record instead of duplicating it. Titles appear verbatim in reports, so make them specific and outcome-oriented:',
  '',
  '- ✅ "add OpenTelemetry tracing to API gateway endpoints"',
  '- ✅ "investigate CI docker build failure"',
  '- ❌ "fix bug" / "update code" / "run tests" / "changes"',
  '',
  '## Corrections',
  '',
  'Use manual commands to correct records, for example a wrong title, project, or status:',
  '',
  '```bash',
  'bean edit <id> --title "..." --priority high --notes "..." --tags "auth,bug" --json',
  'bean edit <id> --due-date 2026-05-01 --json      # or --due-date clear',
  'bean done <id> --json',
  'bean block <id> --json',
  'bean remove <id> --json                           # or `bean rm`',
  '```',
  '',
  '## Evidence review (observe only)',
  '',
  'Collect evidence from local Copilot session metadata without changing tasks:',
  '',
  '```bash',
  'bean chronicle doctor --json                      # read-only diagnostics; no raw prompts or responses are imported',
  'bean chronicle reconcile --observe --json         # proposals and a checkpoint only; never creates, links, or completes tasks',
  'bean chronicle suggestions --status pending --json',
  '```',
  '',
  'Pending Chronicle suggestions are review-only. Do **not** present them as completed work or accepted outcomes. Only the developer accepts them, and only when they ask:',
  '',
  '```bash',
  'bean chronicle approve <suggestion-id> --work-date 2026-04-20 --json',
  'bean chronicle link <suggestion-id> <todo-id> --json',
  'bean chronicle ignore <suggestion-id> --json',
  '```',
  '',
  '`bean chronicle reconcile` without `--observe` is review mode: it can auto-link exact session matches to existing tasks as evidence. Run it only when the developer explicitly asks to reconcile. Chronicle evidence is metadata and summaries only, dated by `occurred_at` work time. Taskbean does not store raw prompts, responses, tool output, command output, or credentials. If Chronicle data is unavailable or blocked by policy, continue with normal Taskbean records and report the limitation.',
  '',
  '## Reports and standups',
  '',
  '```bash',
  'bean report --date week --json                    # outcomes, status, and per-agent usage',
  'bean report --date week --include-chronicle --json',
  'bean list --json',
  'bean list --status blocked --json                 # pending | in_progress | done | blocked',
  'bean list --count --json',
  'bean list --all --by-project --json',
  '```',
  '',
  'Lead with delivered outcomes, then blockers, then evidence and AI usage. Do not count pending suggestions as done.',
  '',
  '## Pitfalls',
  '',
  '- **Do NOT log every turn, ask, command, or small fix.** Log outcomes.',
  '- **Do NOT trigger this skill** for pure explanation, read-only inspection, brainstorming, non-code prose, code review with no changes, plan-mode steps, Planner or To Do commitments, or installing or configuring taskbean itself.',
  '- **Do NOT accept suggestions** for the developer. Observe, then let them review.',
  '- **If an outcome was missed**, record it when you notice. A late record with evidence is better than none.',
  '',
  '## Project management and legacy commands (only when the developer asks)',
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
  'bean remind "deploy hotfix" "tomorrow 9am" --json          # legacy reminder; kept for compatibility',
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

export function detectAgents(env = process.env) {
  return AGENT_REGISTRY.filter(agent => isOnPath(agent.cliName, env)).map(agent => agent.id);
}

// Map an --agent value to the set of skill directories we should write into.
function skillTargetsFor(agent, base) {
  if (!agent) return [join(base, '.agents', 'skills', 'taskbean')];
  const dirs = agent === 'all'
    ? AGENT_REGISTRY.flatMap(entry => entry.projectSkillDirs)
    : getAgent(agent)?.projectSkillDirs || [];
  return [...new Set(dirs)].map(dir => join(base, dir));
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
  const agent = opts.agent;
  const base = isGlobal ? homedir() : process.cwd();

  if (agent && agent !== 'all' && agent !== 'auto' && !getAgent(agent)) {
    const message = `Unsupported agent: ${agent}`;
    if (opts.json) console.error(JSON.stringify({ error: 'invalid_agent', message }));
    else console.error(message);
    process.exitCode = 2;
    return;
  }

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
    const already = existsSync(targetFile);
    if (already && !force) {
      results.push({ status: 'already_installed', path: targetFile });
      continue;
    }
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetFile, SKILL_MD);
    results.push({ status: already ? 'updated' : 'installed', path: targetFile });
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
