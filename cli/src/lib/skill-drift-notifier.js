// Once-per-day stale-SKILL.md notifier. Mirrors the design of
// `update-notifier.js` but checks for drift between the bundled SKILL.md and
// on-disk copies, instead of CLI version drift against GitHub releases.
//
// Why this exists: when a user upgrades the taskbean CLI (`npm i -g
// taskbean@latest`), the on-disk SKILL.md files in their 12 possible install
// locations don't auto-refresh. Today's failure mode (YAML frontmatter bug
// fixed in v0.5.0 but global copy still on the old broken version) is what
// this notifier prevents going forward.
//
// Behavior:
//   - Throttled to once per 24h via ~/.taskbean/.skill-drift-check.json.
//   - Fully suppressed in CI / non-TTY / when TASKBEAN_NO_UPGRADE_NOTICE=1.
//   - Suppressed when --json appears in argv (we don't pollute machine output).
//   - One stderr line. Never blocks. Never writes the SKILL.md itself.
//
// Wired into bin/taskbean.js as an `exit` handler so it prints AFTER the
// command's own output (matching update-notifier's pattern).
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { scanSkills, BUNDLED_VERSION } from '../commands/update-skill.js';

const TASKBEAN_DIR = join(homedir(), '.taskbean');
const CACHE_FILE = join(TASKBEAN_DIR, '.skill-drift-check.json');
const TTL_MS = 24 * 60 * 60 * 1000;

const CI_ENV_VARS = ['CI', 'GITHUB_ACTIONS', 'BUILDKITE', 'CIRCLECI', 'GITLAB_CI'];

function isCI() {
  return CI_ENV_VARS.some((v) => {
    const val = process.env[v];
    return val && val !== '' && val !== '0' && val !== 'false';
  });
}

function isSuppressed() {
  if (process.env.TASKBEAN_NO_UPGRADE_NOTICE === '1') return true;
  if (isCI()) return true;
  if (!process.stderr.isTTY) return true;
  // Don't pollute --json output that callers (agents) may be parsing.
  if (process.argv.includes('--json')) return true;
  return false;
}

// Commands where the notice is meaningful. Other commands (install,
// update-skill, uninstall, serve) either already speak to the user about the
// SKILL.md or aren't relevant.
const NOTIFY_COMMANDS = new Set(['add', 'done', 'list', 'ls', 'start', 'block', 'edit', 'remind', 'remove', 'rm', 'report']);

function commandFromArgv() {
  // process.argv = [node, taskbean.js, <cmd>, ...]
  return process.argv[2] || '';
}

function readCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf-8')); } catch { return null; }
}

function writeCache(obj) {
  try {
    mkdirSync(TASKBEAN_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(obj));
  } catch { /* ignore */ }
}

export function maybePrintSkillDriftNotice() {
  if (isSuppressed()) return;
  if (!NOTIFY_COMMANDS.has(commandFromArgv())) return;

  const cache = readCache();
  const now = Date.now();
  if (cache && typeof cache.lastCheckedAt === 'number' && now - cache.lastCheckedAt < TTL_MS) {
    // Honor cached "stale_count" so a previously-detected drift is still
    // surfaced once per day until the user runs `bean update-skill --apply`.
    if (cache.stale_count > 0 && cache.bundled_version === BUNDLED_VERSION) {
      printNotice(cache.stale_count);
    }
    return;
  }

  // Run a scan. This is filesystem-only, sub-millisecond on warm caches —
  // safe to do synchronously on the way out.
  let report;
  try {
    report = scanSkills({});
  } catch {
    writeCache({ lastCheckedAt: now, stale_count: 0, bundled_version: BUNDLED_VERSION });
    return;
  }
  writeCache({ lastCheckedAt: now, stale_count: report.stale_count, bundled_version: BUNDLED_VERSION });
  if (report.stale_count > 0) printNotice(report.stale_count);
}

function printNotice(staleCount) {
  const noun = staleCount === 1 ? 'copy is' : 'copies are';
  const msg = `\x1b[2m🫘 ${staleCount} taskbean SKILL.md ${noun} stale (bundled: v${BUNDLED_VERSION}). Run \`bean update-skill --apply\` to refresh.\x1b[0m`;
  try { process.stderr.write(msg + '\n'); } catch { /* ignore */ }
}
