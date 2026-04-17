// Tests for `bean upgrade`.
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_HOME = join(tmpdir(), 'taskbean-upgrade-test-' + Date.now());
mkdirSync(TEST_HOME, { recursive: true });
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { detectChannel, semverGreater, upgradeCommand, makeUpgradeCommand, WINDOWS_SWAP_SCRIPT } =
  await import('./upgrade.js');
const { VERSION } = await import('../version.js');

const MARKER_DIR = join(TEST_HOME, '.taskbean');
const MARKER_FILE = join(MARKER_DIR, '.install-channel');
const CACHE_FILE = join(MARKER_DIR, '.upgrade-check.json');

function writeMarker(value) {
  mkdirSync(MARKER_DIR, { recursive: true });
  writeFileSync(MARKER_FILE, value);
}

function clearMarker() {
  try { rmSync(MARKER_FILE, { force: true }); } catch {}
}

describe('detectChannel()', () => {
  afterEach(() => clearMarker());

  it('returns "binary" when marker says binary', () => {
    writeMarker('binary');
    assert.equal(detectChannel(), 'binary');
  });

  it('returns "npm" when marker says npm', () => {
    writeMarker('npm');
    assert.equal(detectChannel(), 'npm');
  });

  it('trims whitespace around the marker value', () => {
    writeMarker('  binary\n');
    assert.equal(detectChannel(), 'binary');
  });

  it('ignores garbage marker values and falls back to heuristic', () => {
    writeMarker('something-else');
    const c = detectChannel();
    assert.ok(['npm', 'binary', 'unknown'].includes(c), `got ${c}`);
  });

  it('with no marker, returns one of npm/binary/unknown', () => {
    clearMarker();
    const c = detectChannel();
    assert.ok(['npm', 'binary', 'unknown'].includes(c), `got ${c}`);
  });
});

describe('semverGreater()', () => {
  it('mirrors isNewer numeric semantics', () => {
    assert.equal(semverGreater('0.6.0', '0.5.0'), true);
    assert.equal(semverGreater('0.5.0', '0.6.0'), false);
    assert.equal(semverGreater('0.5.0', '0.5.0'), false);
    assert.equal(semverGreater('0.5.10', '0.5.9'), true);
    assert.equal(semverGreater('1.0.0', '0.9.99'), true);
    assert.equal(semverGreater('v0.7.0', '0.6.0'), true);
  });
});

describe('upgradeCommand({check: true, json: true})', () => {
  const origFetch = globalThis.fetch;
  const origLog = console.log;
  const origErr = console.error;
  let stdout = '';
  let stderr = '';

  beforeEach(() => {
    stdout = ''; stderr = '';
    console.log = (...a) => { stdout += a.join(' ') + '\n'; };
    console.error = (...a) => { stderr += a.join(' ') + '\n'; };
    try { rmSync(CACHE_FILE, { force: true }); } catch {}
    // detectChannel's marker isn't required for --check; leave clear.
    clearMarker();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    console.error = origErr;
    process.exitCode = 0;
  });

  function mockFetchLatestTag(tag) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ tag_name: tag }),
    });
  }

  it('reports up_to_date when remote version matches current', async () => {
    mockFetchLatestTag('v' + VERSION);
    await upgradeCommand({ check: true, json: true });
    const payload = JSON.parse(stdout.trim());
    assert.equal(payload.status, 'up_to_date');
    assert.equal(payload.current, VERSION);
    assert.equal(payload.latest, VERSION);
  });

  it('reports upgrade_available when remote version is newer', async () => {
    mockFetchLatestTag('v999.0.0');
    await upgradeCommand({ check: true, json: true });
    const payload = JSON.parse(stdout.trim());
    assert.equal(payload.status, 'upgrade_available');
    assert.equal(payload.current, VERSION);
    assert.equal(payload.latest, '999.0.0');
  });

  it('emits error payload when fetch fails', async () => {
    globalThis.fetch = async () => { throw new Error('network down'); };
    await upgradeCommand({ check: true, json: true });
    const payload = JSON.parse(stdout.trim());
    assert.equal(payload.status, 'error');
    assert.equal(payload.error, 'fetch_failed');
    assert.match(payload.message, /network down/);
  });

  it('writes the notifier cache after a --check run (fix 8)', async () => {
    const before = Date.now();
    mockFetchLatestTag('v999.0.0');
    await upgradeCommand({ check: true, json: true });
    const after = Date.now();
    assert.ok(existsSync(CACHE_FILE), 'notifier cache file written after --check');
    const cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    assert.equal(cache.latestVersion, '999.0.0');
    assert.ok(typeof cache.lastCheckedAt === 'number');
    assert.ok(cache.lastCheckedAt >= before && cache.lastCheckedAt <= after,
      `lastCheckedAt ${cache.lastCheckedAt} not within [${before}, ${after}]`);
  });

  it('human output (no --json) prints a friendly line', async () => {
    mockFetchLatestTag('v999.0.0');
    await upgradeCommand({ check: true, json: false });
    assert.match(stdout, /taskbean 999\.0\.0 is available/);
  });
});

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  if (ORIG_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG_HOME;
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG_USERPROFILE;
});

// ========================================================================
// Regression tests for PR C hardening (review issues #1, #3, #5)
// ========================================================================

describe('upgrade confirmation gate (fix 3)', () => {
  const origFetch = globalThis.fetch;
  const origCI = process.env.CI;
  const origStdin = process.stdin.isTTY;
  const origStdout = process.stdout.isTTY;
  let stdout = '';
  let stderr = '';
  const origLog = console.log;
  const origErr = console.error;

  beforeEach(() => {
    stdout = ''; stderr = '';
    console.log = (...a) => { stdout += a.join(' ') + '\n'; };
    console.error = (...a) => { stderr += a.join(' ') + '\n'; };
    clearMarker();
    delete process.env.CI;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v999.0.0' }) });
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    console.error = origErr;
    if (origCI === undefined) delete process.env.CI; else process.env.CI = origCI;
    process.stdin.isTTY = origStdin;
    process.stdout.isTTY = origStdout;
    process.exitCode = 0;
  });

  it('non-TTY without --yes exits 2 with confirmation_required (json)', async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
    const spawned = [];
    const cmd = makeUpgradeCommand({ spawner: (...args) => { spawned.push(args); return { on: () => {}, unref: () => {} }; } });
    await cmd({ json: true });
    const payload = JSON.parse(stdout.trim());
    assert.equal(payload.status, 'error');
    assert.equal(payload.error, 'confirmation_required');
    assert.equal(process.exitCode, 2);
    assert.equal(spawned.length, 0, 'spawner must not be called without confirmation');
  });

  it('non-TTY + CI=1 refuses even with TTY flags set', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    process.env.CI = '1';
    const spawned = [];
    const cmd = makeUpgradeCommand({ spawner: (...args) => { spawned.push(args); return { on: () => {}, unref: () => {} }; } });
    await cmd({ json: true });
    const payload = JSON.parse(stdout.trim());
    assert.equal(payload.error, 'confirmation_required');
    assert.equal(spawned.length, 0);
  });

  it('--yes skips the prompt', async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
    let prompted = 0;
    let spawnedArgs = null;
    const cmd = makeUpgradeCommand({
      prompter: async () => { prompted++; return true; },
      spawner: (...args) => {
        spawnedArgs = args;
        const child = { exitCode: 0, on: (ev, fn) => { if (ev === 'exit') setImmediate(() => fn(0)); }, unref: () => {} };
        return child;
      },
    });
    writeMarker('npm');
    await cmd({ yes: true, json: true });
    assert.equal(prompted, 0, 'prompter must not be called when --yes is set');
    assert.ok(spawnedArgs, 'spawner must be called');
  });

  it('--dry-run emits dry_run event and skips spawn', async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
    const spawned = [];
    const cmd = makeUpgradeCommand({
      spawner: (...args) => { spawned.push(args); return { on: () => {}, unref: () => {} }; },
    });
    await cmd({ dryRun: true, json: true });
    const payload = JSON.parse(stdout.trim());
    assert.equal(payload.status, 'dry_run');
    assert.equal(payload.latest, '999.0.0');
    assert.equal(spawned.length, 0);
  });

  it('TTY + prompter answers "no" → cancelled, no spawn', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    const spawned = [];
    const cmd = makeUpgradeCommand({
      prompter: async () => false,
      spawner: (...args) => { spawned.push(args); return { on: () => {}, unref: () => {} }; },
    });
    await cmd({ json: true });
    const payload = JSON.parse(stdout.trim());
    assert.equal(payload.status, 'cancelled');
    assert.equal(spawned.length, 0);
  });

  it('TTY + prompter answers "yes" → proceeds to spawn', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    writeMarker('npm');
    let spawnedArgs = null;
    const cmd = makeUpgradeCommand({
      prompter: async () => true,
      spawner: (...args) => {
        spawnedArgs = args;
        return { on: (ev, fn) => { if (ev === 'exit') setImmediate(() => fn(0)); }, unref: () => {}, exitCode: 0 };
      },
    });
    await cmd({ json: true });
    assert.ok(spawnedArgs, 'spawner must be called after confirmation');
  });
});

describe('npm channel spawn (fix 1 — no shell:true)', () => {
  const origFetch = globalThis.fetch;
  const origLog = console.log;
  const origErr = console.error;

  beforeEach(() => {
    writeMarker('npm');
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v999.0.0' }) });
    console.log = () => {}; console.error = () => {};
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog; console.error = origErr;
    clearMarker();
    process.exitCode = 0;
  });

  it('spawns without shell:true on any platform', async () => {
    let capturedOpts = null;
    const cmd = makeUpgradeCommand({
      spawner: (cmd2, args, opts) => {
        capturedOpts = opts;
        return { on: (ev, fn) => { if (ev === 'exit') setImmediate(() => fn(0)); }, unref: () => {}, exitCode: 0 };
      },
    });
    await cmd({ yes: true, json: true });
    assert.ok(capturedOpts, 'spawner received opts');
    assert.notEqual(capturedOpts.shell, true, 'spawn opts must not include shell:true');
  });
});

describe('Windows swap script (fix 2 — no injection)', () => {
  it('script body is a constant, contains no interpolation markers', () => {
    // The script reads context from $env:TB_UPGRADE_CTX. It must not reference
    // any JavaScript template literal slot — if this test fails a regression
    // has re-introduced string concatenation.
    assert.equal(typeof WINDOWS_SWAP_SCRIPT, 'string');
    assert.ok(WINDOWS_SWAP_SCRIPT.includes('$env:TB_UPGRADE_CTX'));
    assert.ok(WINDOWS_SWAP_SCRIPT.includes('ConvertFrom-Json'));
    assert.ok(WINDOWS_SWAP_SCRIPT.includes('Move-Item -Force -LiteralPath $src'));
    // Inspect for suspicious dynamic constructs that should NEVER appear.
    assert.ok(!WINDOWS_SWAP_SCRIPT.includes('Invoke-Expression'));
    assert.ok(!WINDOWS_SWAP_SCRIPT.includes('iex '));
    // Nothing that looks like a JS placeholder.
    assert.ok(!WINDOWS_SWAP_SCRIPT.includes('${'));
    // No single-quoted literal paths that could have been user-interpolated.
    assert.ok(!/\$src\s*=\s*'/.test(WINDOWS_SWAP_SCRIPT));
    assert.ok(!/\$dst\s*=\s*'/.test(WINDOWS_SWAP_SCRIPT));
  });

  it('script reads src and dst from ctx as JSON, assigns as data', () => {
    // These patterns prove paths travel through the JSON boundary, not argv.
    assert.match(WINDOWS_SWAP_SCRIPT, /\$ctx\s*=\s*Get-Content\s+-Raw\s+-LiteralPath\s+\$ctxPath\s*\|\s*ConvertFrom-Json/);
    assert.match(WINDOWS_SWAP_SCRIPT, /\$src\s*=\s*\$ctx\.src/);
    assert.match(WINDOWS_SWAP_SCRIPT, /\$dst\s*=\s*\$ctx\.dst/);
  });

  it('script uses -LiteralPath so wildcards / $-expressions in paths are never re-parsed', () => {
    // Move-Item without -LiteralPath would interpret brackets / wildcards.
    assert.ok(WINDOWS_SWAP_SCRIPT.includes('-LiteralPath $src'));
    assert.ok(WINDOWS_SWAP_SCRIPT.includes('-LiteralPath $ctxPath'));
    assert.ok(WINDOWS_SWAP_SCRIPT.includes('-LiteralPath $PSCommandPath'));
  });

  it('script removes the staged src file on retry exhaustion (not a silent orphan)', () => {
    // Per rubber-duck: failure path must clean up $src so the next upgrade
    // doesn't collide.
    assert.ok(WINDOWS_SWAP_SCRIPT.includes('Remove-Item -Force -LiteralPath $src'));
  });
});
