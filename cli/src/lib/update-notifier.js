// Once-per-day GitHub Releases check.
//
// Usage:
//   import { checkForUpdates, maybePrintUpgradeNotice } from '../lib/update-notifier.js';
//   checkForUpdates(); // fire-and-forget, triggered at CLI startup
//   process.on('exit', maybePrintUpgradeNotice); // printed after the command finishes
//
// Design notes (rubber-duck):
//   - The check is gated by TTY + CI detection so scripts / pipes never see
//     the banner. We check `process.stderr.isTTY` because we print to stderr.
//   - `TASKBEAN_NO_UPGRADE_NOTICE=1` is a hard opt-out (respected even during
//     the network fetch; we skip work entirely).
//   - The 24h TTL applies to BOTH positive and negative results so GitHub
//     rate-limit responses don't retry every command.
//   - Network / parse / FS errors are swallowed. We never throw from the
//     public API — worst case is the user misses a notice this run.
//   - The fetch is capped at ~500ms-2s so we don't delay CLI exit on slow
//     networks; if it doesn't return by process-exit time we just skip.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { VERSION } from '../version.js';

const TASKBEAN_DIR = join(homedir(), '.taskbean');
const CACHE_FILE = join(TASKBEAN_DIR, '.upgrade-check.json');
const TTL_MS = 24 * 60 * 60 * 1000;
const RELEASE_URL = 'https://api.github.com/repos/taskbean/taskbean/releases/latest';
const FETCH_TIMEOUT_MS = 2000;

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
  return false;
}

export function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeCache(obj) {
  try {
    mkdirSync(TASKBEAN_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(obj));
  } catch {
    // ignore
  }
}

// Compare "0.5.0" < "0.6.0" style semver strings. Ignores pre-release tags —
// good enough for update-notifier which is best-effort anyway.
export function isNewer(latest, current) {
  if (!latest || !current) return false;
  const a = String(latest).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(current).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] || 0;
    const bi = b[i] || 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

// Kicks off a background fetch if the cache is stale. Never throws.
export function checkForUpdates() {
  if (isSuppressed()) return;
  const cache = readCache();
  const now = Date.now();
  if (cache && typeof cache.lastCheckedAt === 'number' && now - cache.lastCheckedAt < TTL_MS) {
    return; // still fresh — nothing to do
  }

  if (typeof fetch !== 'function') return; // Node < 18 fallback — just skip

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  // Don't keep the event loop alive waiting on the timer.
  if (typeof timer.unref === 'function') timer.unref();

  Promise.resolve()
    .then(() => fetch(RELEASE_URL, {
      headers: { 'User-Agent': `taskbean-cli/${VERSION}`, 'Accept': 'application/vnd.github+json' },
      signal: controller.signal,
    }))
    .then(async (res) => {
      clearTimeout(timer);
      if (!res || !res.ok) {
        // Cache negative result so rate-limited users don't retry every command.
        writeCache({ lastCheckedAt: now, latestVersion: null });
        return;
      }
      const body = await res.json();
      const rawTag = body && typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : null;
      // Skip pre-release tags (e.g. "0.6.0-rc1") — we don't cache or notify
      // on them. Cache a null so we don't retry the same request for 24h.
      const tag = rawTag && !rawTag.includes('-') ? rawTag : null;
      writeCache({ lastCheckedAt: now, latestVersion: tag });
    })
    .catch(() => {
      clearTimeout(timer);
      writeCache({ lastCheckedAt: now, latestVersion: null });
    });
}

// Prints a single dim-colored line to stderr iff a newer version is cached.
// Safe to register as an `exit` handler.
export function maybePrintUpgradeNotice() {
  if (isSuppressed()) return;
  const cache = readCache();
  if (!cache || !cache.latestVersion) return;
  if (!isNewer(cache.latestVersion, VERSION)) return;
  const msg = `\x1b[2m🫘 taskbean ${cache.latestVersion} is available (you have ${VERSION}). Run \`bean upgrade\` to update.\x1b[0m`;
  try { process.stderr.write(msg + '\n'); } catch { /* ignore */ }
}
