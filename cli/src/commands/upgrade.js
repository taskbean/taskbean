// `bean upgrade` — self-update for both install channels.
//
// Channel detection:
//   1. Marker file ~/.taskbean/.install-channel (written by install.sh /
//      install.ps1 / postinstall.cjs). Authoritative.
//   2. Heuristics:
//      - process.versions.bun present AND process.execPath ends in bean* →
//        compiled standalone binary (Bun-compiled executable).
//      - process.execPath contains node_modules → npm global install.
//      - Otherwise: unknown (print guidance, exit 2).
//
// Windows rename-on-exit:
//   We cannot overwrite the running .exe on Windows. Download to
//   `<exe>.new.<pid>.<ts>`, spawn a detached, hidden PowerShell that:
//     1. Waits 0.5-10s for our process to exit (so the exe lock is released).
//     2. Moves the staging file over `<exe>` (atomic on same volume).
//     3. Cleans up its sidecar + itself.
//
// Security (rubber-duck — before this hardening these bugs were exploitable):
//   - The PS script body is a CONSTANT. Paths travel as a JSON sidecar on
//     disk, loaded via `ConvertFrom-Json` + `Move-Item -LiteralPath`, so no
//     path string is ever interpreted as PowerShell code.
//   - The sidecar path is passed via an env var (`TB_UPGRADE_CTX`), not
//     interpolated into argv.
//   - Artifacts live in an `fs.mkdtempSync` subdir so another local process
//     cannot swap them before the helper reads them.
//   - `-ExecutionPolicy Bypass` is NOT used — if policy blocks the helper we
//     want that to be loud, not silently overridden.
//   - Parent reports `upgrade_scheduled` (not success); ~/.taskbean/.upgrade-
//     pending lets the next `bean` invocation detect stranded upgrades.
//
// Linux/macOS: we can overwrite the running executable directly.
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, chmodSync,
  renameSync, unlinkSync, rmSync, statSync,
} from 'fs';
import { join, dirname, basename } from 'path';
import { homedir, platform, arch, tmpdir } from 'os';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { createInterface } from 'readline';
import { VERSION } from '../version.js';
import { writeCache as writeNotifierCache } from '../lib/update-notifier.js';

const REPO = 'taskbean/taskbean';
const RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const MARKER_FILE = join(homedir(), '.taskbean', '.install-channel');
const PENDING_FILE = join(homedir(), '.taskbean', '.upgrade-pending');

// Constant PowerShell helper body — NEVER embed user input here.
export const WINDOWS_SWAP_SCRIPT = `$ErrorActionPreference = 'Stop'
$ctxPath = $env:TB_UPGRADE_CTX
if (-not $ctxPath -or -not (Test-Path -LiteralPath $ctxPath)) { exit 2 }
$ctx = Get-Content -Raw -LiteralPath $ctxPath | ConvertFrom-Json
$src = $ctx.src
$dst = $ctx.dst
$ok = $false
$i = 0
while ($i -lt 20) {
  Start-Sleep -Milliseconds 500
  try {
    Move-Item -Force -LiteralPath $src -Destination $dst
    $ok = $true
    break
  } catch { $i++ }
}
if (-not $ok) {
  Remove-Item -Force -LiteralPath $src -ErrorAction SilentlyContinue
}
Remove-Item -Force -LiteralPath $ctxPath -ErrorAction SilentlyContinue
Remove-Item -Force -LiteralPath $PSCommandPath -ErrorAction SilentlyContinue
if ($ok) { exit 0 } else { exit 1 }
`;

function readChannelMarker() {
  try {
    const v = readFileSync(MARKER_FILE, 'utf-8').trim();
    if (v === 'npm' || v === 'binary') return v;
  } catch { /* ignore */ }
  return null;
}

// Best-effort channel detection. Returns 'npm' | 'binary' | 'unknown'.
export function detectChannel() {
  const marker = readChannelMarker();
  if (marker) return marker;

  const exe = process.execPath || '';
  const normalized = exe.replace(/\\/g, '/').toLowerCase();

  // Bun-compiled standalone: the running interpreter IS bun (process.versions.bun
  // is set) and the exe is NOT a normal `bun`/`node` binary — it's the user's
  // compiled `bean` exe.
  if (process.versions && process.versions.bun) {
    const base = basename(normalized);
    if (!base.startsWith('node') && !base.startsWith('bun')) return 'binary';
  }

  if (normalized.includes('/node_modules/') || normalized.includes('npm/')) return 'npm';

  // node_modules/.bin shims are rare for global installs on modern Node; fall
  // back to 'npm' if we're clearly running under Node and the script lives in
  // a node_modules dir.
  try {
    const scriptUrl = new URL(import.meta.url).pathname.toLowerCase();
    if (scriptUrl.includes('/node_modules/')) return 'npm';
  } catch { /* ignore */ }

  return 'unknown';
}

function platformTarget() {
  const p = platform();
  const a = arch();
  const archName = a === 'x64' ? 'x64' : a === 'arm64' ? 'arm64' : a;
  if (p === 'win32') return { file: 'bean-windows-x64.exe', target: 'windows-x64' };
  if (p === 'darwin') return { file: `bean-darwin-${archName}`, target: `darwin-${archName}` };
  if (p === 'linux') return { file: `bean-linux-${archName}`, target: `linux-${archName}` };
  return null;
}

async function fetchLatestRelease() {
  const res = await fetch(RELEASE_URL, {
    headers: { 'User-Agent': `taskbean-cli/${VERSION}`, 'Accept': 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  return res.json();
}

function sha256OfFile(path) {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

async function downloadTo(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${url}`);
  return res.text();
}

function parseShaSums(text, filename) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/i);
    if (m && m[2] === filename) return m[1].toLowerCase();
  }
  return null;
}

export function semverGreater(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function emit(opts, payload, humanFn) {
  if (opts.json) {
    console.log(JSON.stringify(payload));
  } else {
    humanFn();
  }
}

// Default interactive prompt. Returns true on y/yes (case-insensitive).
async function defaultPrompter(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer || '').trim()));
    });
  });
}

function isInteractiveTTY() {
  if (process.env.CI && process.env.CI !== '0' && process.env.CI !== 'false') return false;
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

// Factory form — see plan PR C. Keeps .action(commander) clean (no positional
// deps arg) and gives tests a clean injection surface.
export function makeUpgradeCommand(deps = {}) {
  const spawner = deps.spawner ?? spawn;
  const prompter = deps.prompter ?? defaultPrompter;
  const fetchRelease = deps.fetchRelease ?? fetchLatestRelease;
  const now = deps.now ?? (() => Date.now());

  return async function upgradeCommand(opts = {}) {
    const channel = detectChannel();
    let latestTag;
    let latestVersion;
    try {
      const release = await fetchRelease();
      latestTag = release.tag_name;
      latestVersion = String(latestTag || '').replace(/^v/, '');
    } catch (err) {
      const payload = { status: 'error', error: 'fetch_failed', message: String(err && err.message || err) };
      emit(opts, payload, () => console.error(`❌ Failed to check latest release: ${payload.message}`));
      process.exitCode = 1;
      return;
    }

    const upToDate = !semverGreater(latestVersion, VERSION);

    if (opts.check) {
      const payload = {
        status: upToDate ? 'up_to_date' : 'upgrade_available',
        channel,
        current: VERSION,
        latest: latestVersion,
      };
      try { writeNotifierCache({ lastCheckedAt: now(), latestVersion }); } catch { /* ignore */ }
      emit(opts, payload, () => {
        if (upToDate) console.log(`✅ taskbean ${VERSION} is up to date (channel: ${channel}).`);
        else console.log(`⬆️  taskbean ${latestVersion} is available (you have ${VERSION}, channel: ${channel}). Run \`bean upgrade\`.`);
      });
      return;
    }

    if (upToDate && !opts.force) {
      emit(opts, { status: 'up_to_date', channel, current: VERSION, latest: latestVersion },
        () => console.log(`✅ taskbean ${VERSION} is already the latest (channel: ${channel}).`));
      return;
    }

    // --dry-run short-circuits before any confirmation or network work.
    if (opts.dryRun) {
      emit(opts, {
        status: 'dry_run', channel, current: VERSION, latest: latestVersion, method: channel,
      }, () => console.log(`Would upgrade taskbean ${VERSION} → ${latestVersion} via ${channel}. (dry-run — no changes made)`));
      return;
    }

    // Confirmation gate (fix 3).
    if (!opts.yes) {
      if (!isInteractiveTTY()) {
        emit(opts, {
          status: 'error', error: 'confirmation_required',
          current: VERSION, latest: latestVersion, channel,
          hint: 'Re-run with --yes, or run in an interactive terminal.',
        }, () => {
          console.error(`❌ --yes is required for non-interactive upgrades.`);
          console.error(`   taskbean ${VERSION} → ${latestVersion} via ${channel}`);
        });
        process.exitCode = 2;
        return;
      }
      const confirmed = await prompter(`Upgrade taskbean ${VERSION} → ${latestVersion} via ${channel}? [y/N] `);
      if (!confirmed) {
        emit(opts, { status: 'cancelled', channel, current: VERSION, latest: latestVersion },
          () => console.log('Upgrade cancelled.'));
        return;
      }
    }

    if (channel === 'npm') {
      emit(opts, { status: 'upgrading', channel, current: VERSION, latest: latestVersion, method: 'npm' },
        () => console.log(`⬆️  Upgrading taskbean ${VERSION} → ${latestVersion} via npm…`));
      // Windows resolves `npm.cmd` via PATHEXT, so `shell: true` is unnecessary
      // here — and `shell: true` would re-expand argv through cmd.exe.
      const npmCmd = platform() === 'win32' ? 'npm.cmd' : 'npm';
      const child = spawner(npmCmd, ['install', '-g', 'taskbean@latest'], {
        stdio: opts.json ? 'ignore' : 'inherit',
      });
      await new Promise((resolve) => child.on('exit', resolve));
      if (child.exitCode !== 0) {
        emit(opts, { status: 'error', error: 'npm_failed', exit_code: child.exitCode },
          () => console.error(`❌ npm install failed (exit ${child.exitCode})`));
        process.exitCode = child.exitCode || 1;
        return;
      }
      emit(opts, { status: 'upgraded', channel, from: VERSION, to: latestVersion, method: 'npm' },
        () => console.log(`✅ Upgraded taskbean to ${latestVersion}.`));
      return;
    }

    if (channel === 'binary') {
      const pt = platformTarget();
      if (!pt) {
        emit(opts, { status: 'error', error: 'unsupported_platform', platform: platform(), arch: arch() },
          () => console.error(`❌ Unsupported platform: ${platform()}/${arch()}`));
        process.exitCode = 2;
        return;
      }
      const assetUrl = `https://github.com/${REPO}/releases/download/${latestTag}/${pt.file}`;
      const sumsUrl = `https://github.com/${REPO}/releases/download/${latestTag}/SHA256SUMS`;
      const exe = process.execPath;
      const tmpDir = tmpdir();
      const tmpFile = join(tmpDir, `taskbean-upgrade-${process.pid}-${pt.file}`);
      let renamed = false;

      try {
        emit(opts, { status: 'downloading', channel, from: VERSION, to: latestVersion, url: assetUrl },
          () => console.log(`⬇️  Downloading ${pt.file} ${latestTag}…`));
        try {
          await downloadTo(assetUrl, tmpFile);
        } catch (err) {
          emit(opts, { status: 'error', error: 'download_failed', message: String(err.message || err) },
            () => console.error(`❌ Download failed: ${err.message || err}`));
          process.exitCode = 1;
          return;
        }

        // Verify checksum BEFORE we make the file executable. An unverified
        // binary should never briefly carry the executable bit.
        try {
          const sumsText = await fetchText(sumsUrl);
          const expected = parseShaSums(sumsText, pt.file);
          if (!expected) {
            emit(opts, { status: 'error', error: 'checksum_missing', file: pt.file },
              () => console.error(`❌ SHA256SUMS does not list ${pt.file}`));
            process.exitCode = 1;
            return;
          }
          const actual = sha256OfFile(tmpFile);
          if (expected !== actual) {
            emit(opts, { status: 'error', error: 'checksum_mismatch', expected, actual },
              () => console.error(`❌ Checksum mismatch:\n   expected ${expected}\n   actual   ${actual}`));
            process.exitCode = 1;
            return;
          }
        } catch (err) {
          emit(opts, { status: 'error', error: 'checksum_fetch_failed', message: String(err.message || err) },
            () => console.error(`❌ Could not verify checksum: ${err.message || err}`));
          process.exitCode = 1;
          return;
        }

        // Verified — now safe to mark executable (no-op on Windows).
        try { chmodSync(tmpFile, 0o755); } catch { /* ignore */ }

        if (platform() === 'win32') {
          // Race-safe staging file name (fix per rubber-duck): embed pid +
          // timestamp so two concurrent upgrades don't collide on <exe>.new.
          const stagedPath = `${exe}.new.${process.pid}.${now()}`;
          try {
            renameSync(tmpFile, stagedPath);
            renamed = true;
          } catch {
            // cross-volume fallback: copy
            writeFileSync(stagedPath, readFileSync(tmpFile));
            renamed = true;
          }

          // Write sidecar + constant .ps1 script inside a fresh private tmp
          // subdir. No user-controlled bytes ever enter the PS script body.
          const workDir = mkdtempSync(join(tmpDir, 'taskbean-upgrade-'));
          const scriptPath = join(workDir, 'swap.ps1');
          const ctxPath = join(workDir, 'ctx.json');
          writeFileSync(scriptPath, WINDOWS_SWAP_SCRIPT, 'utf-8');
          writeFileSync(ctxPath, JSON.stringify({ src: stagedPath, dst: exe }), 'utf-8');

          // Parent-side pending marker so the next `bean` run can detect a
          // stranded upgrade and surface it.
          try {
            mkdirSync(join(homedir(), '.taskbean'), { recursive: true });
            writeFileSync(PENDING_FILE, JSON.stringify({
              staged: stagedPath, target: exe, from: VERSION, to: latestVersion, startedAt: now(),
            }));
          } catch { /* ignore */ }

          const child = spawner('powershell.exe', [
            '-NoProfile', '-WindowStyle', 'Hidden',
            '-File', scriptPath,
          ], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, TB_UPGRADE_CTX: ctxPath },
          });
          child.on('error', (err) => {
            // Parent-side spawn failure — clean up everything we wrote and
            // surface the stranded file so the user can recover manually.
            try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
            try { unlinkSync(stagedPath); } catch { /* ignore */ }
            try { unlinkSync(PENDING_FILE); } catch { /* ignore */ }
            const msg = `⚠️  Could not spawn PowerShell to finish the upgrade: ${err.message || err}\n`
              + `   The staged binary has been removed. Re-run \`bean upgrade\` to retry.`;
            try { console.error(msg); } catch { /* ignore */ }
          });
          child.unref();
          emit(opts, {
            status: 'upgrade_scheduled',
            channel,
            from: VERSION,
            to: latestVersion,
            method: 'binary',
            staged: stagedPath,
            note: 'Windows: the new binary will be swapped in on process exit. Re-run `bean --version` to verify.',
          }, () => {
            console.log(`✅ Downloaded taskbean ${latestVersion}. Upgrade scheduled.`);
            console.log(`   Windows will swap in the new binary momentarily. Re-run \`bean --version\` to verify.`);
          });
          process.exit(0);
        } else {
          // POSIX: overwrite directly. Use rename (atomic on same fs) if possible.
          try {
            renameSync(tmpFile, exe);
            renamed = true;
          } catch {
            // EXDEV (cross-device) — fall back to a copy + rename within dir.
            const parent = dirname(exe);
            const staging = join(parent, '.' + basename(exe) + '.new');
            writeFileSync(staging, readFileSync(tmpFile));
            try { chmodSync(staging, 0o755); } catch { /* ignore */ }
            renameSync(staging, exe);
            // tmpFile still exists and will be cleaned up in finally.
          }
          emit(opts, { status: 'upgraded', channel, from: VERSION, to: latestVersion, method: 'binary' },
            () => console.log(`✅ Upgraded taskbean to ${latestVersion}.`));
          return;
        }
      } finally {
        if (!renamed) {
          try { unlinkSync(tmpFile); } catch { /* ignore */ }
        }
      }
    }

    // Unknown channel
    const payload = {
      status: 'error',
      error: 'unknown_channel',
      current: VERSION,
      latest: latestVersion,
      hint: 'Could not determine whether taskbean was installed via npm or as a standalone binary. Reinstall with the official installer, or run `npm install -g taskbean@latest` manually.',
    };
    emit(opts, payload, () => {
      console.error(`❌ Could not determine install channel for \`bean\`.`);
      console.error(`   ${payload.hint}`);
    });
    process.exitCode = 2;
  };
}

// Back-compat export + production binding.
export const upgradeCommand = makeUpgradeCommand();
