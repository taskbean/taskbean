// `bean update-skill` — detect and refresh stale on-disk SKILL.md copies.
//
// Compares the version stamped in each on-disk SKILL.md's
// `metadata.taskbean_version` frontmatter field against the version baked into
// this build of the CLI (read from the bundled SKILL_MD constant).
//
// Default mode: list stale copies + tell the user how to fix. No writes.
// With --apply: rewrite stale copies in place via writeFileSync.
//
// This solves the demo-day failure mode where a user upgrades the CLI but
// forgets that on-disk SKILL.md files (project + global, across 12 directories)
// don't auto-refresh and may still contain bugs (e.g., bad YAML frontmatter)
// that have already been fixed in the bundled version.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { SKILL_MD } from './install.js';
import { PROJECT_SKILL_DIRS, GLOBAL_SKILL_DIRS } from '../data/skill-dirs.js';

// Extract `metadata.taskbean_version` from a SKILL.md text. Returns null if
// the file doesn't have a recognizable version stamp (e.g., installed by an
// older taskbean release that pre-dates the version-stamp feature).
//
// Deliberately simple regex — we own the format on the producing side
// (sync-skill-md.mjs) so we can rely on it being one-line `taskbean_version:
// "<x.y.z>"` (with or without quotes).
export function extractTaskbeanVersion(text) {
  if (!text || typeof text !== 'string') return null;
  // Only look inside the YAML frontmatter to avoid matching a stray mention in
  // the body. Frontmatter is delimited by --- on its own line at the top.
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  const m = fmMatch[1].match(/^\s*taskbean_version:\s*"?([^\s"]+)"?\s*$/m);
  return m ? m[1] : null;
}

// Version of the SKILL.md bundled with this CLI build. This is computed once
// at module load — the bundled SKILL_MD is constant for the lifetime of the
// process.
export const BUNDLED_VERSION = extractTaskbeanVersion(SKILL_MD);

// Build the list of (path, scope) tuples to scan. By default both project +
// global. --project skips global; --global skips project.
function buildTargets({ projectOnly, globalOnly, cwd = process.cwd(), home = homedir() }) {
  const targets = [];
  if (!globalOnly) {
    for (const rel of PROJECT_SKILL_DIRS) {
      targets.push({ scope: 'project', path: join(cwd, rel, 'SKILL.md') });
    }
  }
  if (!projectOnly) {
    for (const rel of GLOBAL_SKILL_DIRS) {
      targets.push({ scope: 'global', path: join(home, rel, 'SKILL.md') });
    }
  }
  return targets;
}

// Inspect a single on-disk SKILL.md. Returns one of:
//   { state: 'absent', path, scope }
//   { state: 'unstamped', path, scope }   — file exists but no version line
//   { state: 'fresh',     path, scope, version }
//   { state: 'stale',     path, scope, version, bundled }
//   { state: 'newer',     path, scope, version, bundled }   — defensive
//   { state: 'error',     path, scope, error }
export function inspectTarget(target, bundled = BUNDLED_VERSION) {
  if (!existsSync(target.path)) {
    return { state: 'absent', path: target.path, scope: target.scope };
  }
  let text;
  try {
    text = readFileSync(target.path, 'utf-8');
  } catch (err) {
    return { state: 'error', path: target.path, scope: target.scope, error: err.message };
  }
  const version = extractTaskbeanVersion(text);
  if (!version) {
    // Treat unstamped as stale — installed by a CLI predating the stamp, must
    // be refreshed to pick up the version stamp going forward.
    return { state: 'unstamped', path: target.path, scope: target.scope, bundled };
  }
  if (version === bundled) {
    return { state: 'fresh', path: target.path, scope: target.scope, version };
  }
  // semver comparison would be nicer but `bundled` is the source of truth in a
  // single CLI build — anything not equal is treated as stale (downgrade or
  // upgrade). Tag explicitly so the report is honest.
  const cmp = compareSemverLoose(version, bundled);
  if (cmp > 0) {
    return { state: 'newer', path: target.path, scope: target.scope, version, bundled };
  }
  return { state: 'stale', path: target.path, scope: target.scope, version, bundled };
}

// Loose semver compare. Returns -1 if a<b, 0 if equal, 1 if a>b. Anything
// non-numeric falls back to string compare on the segment.
function compareSemverLoose(a, b) {
  const pa = String(a).split('-')[0].split('.');
  const pb = String(b).split('-')[0].split('.');
  for (let i = 0; i < 3; i++) {
    const na = parseInt(pa[i] ?? '0', 10);
    const nb = parseInt(pb[i] ?? '0', 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const sa = pa[i] ?? ''; const sb = pb[i] ?? '';
      if (sa < sb) return -1; if (sa > sb) return 1;
      continue;
    }
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

// Run a scan and produce the structured report used by both the CLI command
// and the PWA `/api/skill-status` endpoint (via `bean update-skill --json`).
export function scanSkills(opts = {}) {
  const targets = buildTargets(opts);
  const results = targets.map((t) => inspectTarget(t));
  const stale = results.filter((r) => r.state === 'stale' || r.state === 'unstamped');
  const fresh = results.filter((r) => r.state === 'fresh');
  const present = results.filter((r) => r.state !== 'absent');
  return {
    bundled_version: BUNDLED_VERSION,
    stale_count: stale.length,
    fresh_count: fresh.length,
    present_count: present.length,
    on_disk: results.filter((r) => r.state !== 'absent'),
    absent: results.filter((r) => r.state === 'absent').map((r) => r.path),
  };
}

// Apply (rewrite) a single stale SKILL.md with the bundled content.
function applyOne(targetPath) {
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, SKILL_MD);
}

export function updateSkillCommand(opts) {
  const apply = !!opts.apply;
  const projectOnly = !!opts.project;
  const globalOnly = !!opts.global;

  if (projectOnly && globalOnly) {
    const msg = 'Cannot combine --project and --global; pick one or omit both.';
    if (opts.json) console.error(JSON.stringify({ error: msg }));
    else console.error(`❌ ${msg}`);
    process.exitCode = 2;
    return;
  }

  const report = scanSkills({ projectOnly, globalOnly });

  if (apply) {
    const applied = [];
    const failed = [];
    for (const r of report.on_disk) {
      if (r.state === 'stale' || r.state === 'unstamped') {
        try {
          applyOne(r.path);
          applied.push({ path: r.path, scope: r.scope, from: r.version || null, to: report.bundled_version });
        } catch (err) {
          failed.push({ path: r.path, scope: r.scope, error: err.message });
        }
      }
    }
    if (opts.json) {
      console.log(JSON.stringify({ bundled_version: report.bundled_version, applied, failed, fresh: report.fresh_count }));
    } else {
      if (applied.length === 0 && failed.length === 0) {
        console.log(`✅ All ${report.fresh_count} on-disk SKILL.md copies are already at v${report.bundled_version}.`);
      } else {
        for (const a of applied) {
          console.log(`🔄 [${a.scope}] ${a.from || 'unstamped'} → ${a.to}: ${a.path}`);
        }
        for (const f of failed) {
          console.log(`❌ [${f.scope}] ${f.path}: ${f.error}`);
        }
        if (failed.length > 0) process.exitCode = 1;
      }
    }
    return;
  }

  // List-only mode (default).
  if (opts.json) {
    console.log(JSON.stringify(report));
    return;
  }

  if (report.stale_count === 0) {
    console.log(`✅ All ${report.fresh_count} on-disk SKILL.md copies are at v${report.bundled_version}.`);
    return;
  }

  console.log(`⚠️  ${report.stale_count} of ${report.present_count} on-disk SKILL.md copies are stale (bundled: v${report.bundled_version}):`);
  for (const r of report.on_disk) {
    if (r.state === 'stale') {
      console.log(`   • [${r.scope}] v${r.version} → v${report.bundled_version}: ${r.path}`);
    } else if (r.state === 'unstamped') {
      console.log(`   • [${r.scope}] (unstamped) → v${report.bundled_version}: ${r.path}`);
    }
  }
  console.log('');
  console.log('To apply updates, run:');
  console.log('   bean update-skill --apply');
  process.exitCode = 1;
}
