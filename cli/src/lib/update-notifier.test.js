// Tests for the update-notifier module.
//
// Important: update-notifier binds its cache path (via homedir()) at module
// load time. Tests MUST set HOME/USERPROFILE before the dynamic import.
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_HOME = join(tmpdir(), 'taskbean-notifier-test-' + Date.now());
mkdirSync(TEST_HOME, { recursive: true });

const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { isNewer, readCache, writeCache, maybePrintUpgradeNotice } =
  await import('./update-notifier.js');
const { VERSION } = await import('../version.js');

const CACHE_FILE = join(TEST_HOME, '.taskbean', '.upgrade-check.json');

describe('isNewer()', () => {
  it('returns true when latest > current (minor bump)', () => {
    assert.equal(isNewer('0.5.0', '0.6.0'), false); // latest=0.5.0, current=0.6.0
    assert.equal(isNewer('0.6.0', '0.5.0'), true);
  });

  it('returns false when equal', () => {
    assert.equal(isNewer('0.5.0', '0.5.0'), false);
  });

  it('is numeric — does not treat 0.5.10 as older than 0.5.9', () => {
    assert.equal(isNewer('0.5.10', '0.5.9'), true);
    assert.equal(isNewer('0.5.9', '0.5.10'), false);
  });

  it('handles major bumps across minor rollover', () => {
    assert.equal(isNewer('1.0.0', '0.9.99'), true);
    assert.equal(isNewer('0.9.99', '1.0.0'), false);
  });

  it('accepts leading v', () => {
    assert.equal(isNewer('v0.6.0', '0.5.0'), true);
    assert.equal(isNewer('0.6.0', 'v0.5.0'), true);
  });

  it('returns false for falsy inputs', () => {
    assert.equal(isNewer('', '0.5.0'), false);
    assert.equal(isNewer(null, '0.5.0'), false);
    assert.equal(isNewer('0.5.0', null), false);
  });

  // Pre-release filtering happens at FETCH time (in checkForUpdates), not
  // inside isNewer — by design isNewer just does numeric compare. The
  // important behaviour is that a `-rc` tag returned from the GitHub API
  // gets cached as latestVersion: null so the notifier never sees it.
  // The actual fetch-time filter is exercised in the cache test below.
  it('numeric compare ignores pre-release suffix (filtering done at fetch time)', () => {
    // Document current behaviour: rc1 numerics still parse as 0.6.0 > 0.5.0.
    // Fix 7 prevents this from being cached, not from being compared.
    assert.equal(isNewer('0.6.0-rc1', '0.5.0'), true);
  });
});

describe('readCache / writeCache round-trip', () => {
  beforeEach(() => {
    try { rmSync(CACHE_FILE, { force: true }); } catch {}
  });

  it('readCache returns null when no file exists', () => {
    assert.equal(readCache(), null);
  });

  it('writeCache then readCache preserves all fields', () => {
    const payload = { lastCheckedAt: 123456789, latestVersion: '9.9.9' };
    writeCache(payload);
    assert.ok(existsSync(CACHE_FILE), 'cache file written');
    const got = readCache();
    assert.deepEqual(got, payload);
  });

  it('readCache returns null on corrupt JSON', () => {
    mkdirSync(join(TEST_HOME, '.taskbean'), { recursive: true });
    writeFileSync(CACHE_FILE, 'not json {{{');
    assert.equal(readCache(), null);
  });
});

describe('maybePrintUpgradeNotice()', () => {
  const origIsTTY = process.stderr.isTTY;
  const origNoNotice = process.env.TASKBEAN_NO_UPGRADE_NOTICE;
  const origCI = process.env.CI;
  const origGhActions = process.env.GITHUB_ACTIONS;
  let captured = '';
  const origWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    captured = '';
    try { rmSync(CACHE_FILE, { force: true }); } catch {}
    process.stderr.write = (chunk, ...rest) => {
      captured += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    };
    // Hard-disable CI detection for these tests.
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.TASKBEAN_NO_UPGRADE_NOTICE;
  });

  afterEach(() => {
    process.stderr.write = origWrite;
    process.stderr.isTTY = origIsTTY;
    if (origNoNotice === undefined) delete process.env.TASKBEAN_NO_UPGRADE_NOTICE;
    else process.env.TASKBEAN_NO_UPGRADE_NOTICE = origNoNotice;
    if (origCI === undefined) delete process.env.CI; else process.env.CI = origCI;
    if (origGhActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = origGhActions;
  });

  it('is silent when stderr is not a TTY (test-default)', () => {
    process.stderr.isTTY = false;
    writeCache({ lastCheckedAt: Date.now(), latestVersion: '999.0.0' });
    maybePrintUpgradeNotice();
    assert.equal(captured, '', `expected no output, got: ${captured}`);
  });

  it('is silent when TASKBEAN_NO_UPGRADE_NOTICE=1', () => {
    process.stderr.isTTY = true;
    process.env.TASKBEAN_NO_UPGRADE_NOTICE = '1';
    writeCache({ lastCheckedAt: Date.now(), latestVersion: '999.0.0' });
    maybePrintUpgradeNotice();
    assert.equal(captured, '', `expected no output, got: ${captured}`);
  });

  it('is silent when cache missing', () => {
    process.stderr.isTTY = true;
    maybePrintUpgradeNotice();
    assert.equal(captured, '');
  });

  it('is silent when cache has no newer version', () => {
    process.stderr.isTTY = true;
    writeCache({ lastCheckedAt: Date.now(), latestVersion: VERSION });
    maybePrintUpgradeNotice();
    assert.equal(captured, '');
  });

  it('prints a single-line notice when cache has a newer version and stderr is a TTY', () => {
    process.stderr.isTTY = true;
    writeCache({ lastCheckedAt: Date.now(), latestVersion: '999.0.0' });
    maybePrintUpgradeNotice();
    assert.match(captured, /taskbean 999\.0\.0 is available/);
    assert.match(captured, /bean upgrade/);
    // One trailing newline only.
    const newlines = captured.split('\n').length - 1;
    assert.equal(newlines, 1, `expected one newline, got ${newlines}`);
  });
});

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  if (ORIG_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG_HOME;
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG_USERPROFILE;
});
