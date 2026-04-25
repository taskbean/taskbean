// `bean uninstall` — remove taskbean artifacts from the system.
//
// Removes: global skill dirs, per-project skill dirs (DB-known + scanned),
// codex config edits, Windows protocol handler, binaries (binary channel
// only), and ~/.taskbean/ (unless --keep-data).
//
// Safety:
//   - Interactive confirmation by default (aborts if not a TTY and no --force)
//   - --dry-run prints plan without removing anything
//   - --keep-data preserves ~/.taskbean/ (DB, config)
//   - Symlinks are detected and removed without following
//   - Every step is try/catch; partial failure still exits non-zero

import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir, platform } from 'os';
import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { PROJECT_SKILL_DIRS, GLOBAL_SKILL_DIRS } from '../data/skill-dirs.js';

export { PROJECT_SKILL_DIRS, GLOBAL_SKILL_DIRS };

// Dirs to skip during filesystem scan.
const SCAN_EXCLUDES = new Set([
  'node_modules', '.git', '.hg', '.svn', '.pnpm-store', '.cache',
  'library', 'appdata', '.trash', '$recycle.bin', '__pycache__',
  '.venv', 'venv', 'dist', 'build',
]);

// ── Helpers ──────────────────────────────────────────────────────────────

function isTaskbeanSkill(dir) {
  const skillFile = join(dir, 'SKILL.md');
  if (!existsSync(skillFile)) return false;
  try {
    const content = readFileSync(skillFile, 'utf-8').slice(0, 500);
    return /name:\s*taskbean/i.test(content);
  } catch { return false; }
}

function safeRemove(target) {
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      unlinkSync(target);
    } else {
      rmSync(target, { recursive: true, force: true });
    }
    return { path: target, status: 'removed' };
  } catch (e) {
    return { path: target, status: 'error', error: e.message };
  }
}

function getInstallChannel() {
  const marker = join(homedir(), '.taskbean', '.install-channel');
  try { return readFileSync(marker, 'utf-8').trim(); } catch { return 'unknown'; }
}

function scanForSkills(rootDir, maxDepth) {
  const found = [];

  // Check the root directory itself
  for (const skillRel of PROJECT_SKILL_DIRS) {
    const candidate = join(rootDir, skillRel);
    if (isTaskbeanSkill(candidate)) {
      found.push(candidate);
    }
  }

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip symlinks/junctions during traversal
      const fullPath = join(dir, entry.name);
      try { if (lstatSync(fullPath).isSymbolicLink()) continue; } catch { continue; }
      if (SCAN_EXCLUDES.has(entry.name.toLowerCase())) continue;

      // Check if this directory has any taskbean skill dirs under it
      for (const skillRel of PROJECT_SKILL_DIRS) {
        const candidate = join(fullPath, skillRel);
        if (isTaskbeanSkill(candidate)) {
          found.push(candidate);
        }
      }
      walk(fullPath, depth + 1);
    }
  }
  walk(rootDir, 0);
  return found;
}

function revertCodexConfig() {
  const configPath = join(homedir(), '.codex', 'config.toml');
  if (!existsSync(configPath)) return null;

  try {
    const content = readFileSync(configPath, 'utf-8');
    const taskbeanDir = homedir().replace(/\\/g, '/') + '/.taskbean';
    const quoted = `"${taskbeanDir}"`;

    if (!content.includes(quoted)) return null;

    // Remove the entry from writable_roots array
    const updated = content.replace(
      new RegExp(`(writable_roots\\s*=\\s*\\[)([^\\]]*)\\]`),
      (match, prefix, inner) => {
        const entries = inner.split(',')
          .map(s => s.trim())
          .filter(s => s.length > 0 && s !== quoted);
        if (entries.length === 0) return `${prefix}]`;
        return `${prefix}${entries.join(', ')}]`;
      }
    );

    if (updated !== content) {
      return { path: configPath, content: updated };
    }
  } catch { /* ignore */ }
  return null;
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ── Main command ─────────────────────────────────────────────────────────

export async function uninstallCommand(opts) {
  const home = homedir();
  const isWin = platform() === 'win32';
  const json = opts.json || false;
  const dryRun = opts.dryRun || false;
  const keepData = opts.keepData || false;
  const force = opts.force || opts.yes || false;
  const scanDir = opts.scan;
  const doScan = scanDir !== undefined;

  // Non-TTY guard
  if (!force && !dryRun && (!process.stdin.isTTY || !process.stderr.isTTY)) {
    const msg = 'Refusing to run interactively without a TTY. Use --force or --dry-run.';
    if (json) console.log(JSON.stringify({ error: 'no_tty', message: msg }));
    else console.error(`❌ ${msg}`);
    process.exitCode = 1;
    return;
  }

  const plan = { global: [], projects: [], scanned: [], system: [], data: null };
  const channel = getInstallChannel();

  // ── 1. Global skill dirs ──
  for (const rel of GLOBAL_SKILL_DIRS) {
    const dir = join(home, rel);
    if (isTaskbeanSkill(dir)) {
      plan.global.push(dir);
    }
  }

  // ── 2. DB-known projects ──
  // Only query if the DB file exists — avoid creating it during uninstall.
  const dbDir = process.env.TASKBEAN_HOME || join(home, '.taskbean');
  const dbPath = process.env.TASKBEAN_DB || join(dbDir, 'taskbean.db');
  let dbProjects = [];
  if (existsSync(dbPath)) {
    try {
      const { allRows } = await import('../data/store.js');
      dbProjects = allRows(
        'SELECT path FROM projects WHERE (tracked = 1 OR skill_installed = 1) AND path IS NOT NULL'
      );
    } catch { /* DB may be corrupt or schema may not match */ }
  }

  for (const proj of dbProjects) {
    for (const rel of PROJECT_SKILL_DIRS) {
      const dir = join(proj.path, rel);
      if (existsSync(dir)) {
        plan.projects.push(dir);
      }
    }
    const configFile = join(proj.path, '.taskbean.json');
    if (existsSync(configFile)) {
      plan.projects.push(configFile);
    }
  }

  // ── 3. Filesystem scan ──
  if (doScan) {
    const scanRoot = scanDir === true ? home : resolve(scanDir);
    const depth = scanDir === true ? 2 : 3;
    const dbPaths = new Set(plan.projects.map(p => resolve(p)));

    const scanned = scanForSkills(scanRoot, depth);
    for (const s of scanned) {
      if (!dbPaths.has(resolve(s))) {
        plan.scanned.push(s);
      }
    }
  }

  // ── 4. System artifacts ──
  const codexRevert = revertCodexConfig();
  if (codexRevert) plan.system.push({ type: 'codex_config', path: codexRevert.path });

  if (isWin) {
    // Check for protocol handler
    try {
      execSync('reg query "HKCU\\Software\\Classes\\taskbean" 2>nul', { stdio: 'pipe' });
      plan.system.push({ type: 'protocol_handler', path: 'HKCU:\\Software\\Classes\\taskbean' });
    } catch { /* not present */ }

    // Check for binary dir (only if binary install channel)
    if (channel === 'binary') {
      const binDir = join(process.env.LOCALAPPDATA || '', 'Programs', 'taskbean');
      if (existsSync(binDir)) {
        plan.system.push({ type: 'binary_dir', path: binDir });
      }
      // PATH entry
      try {
        const userPath = execSync('powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'PATH\', \'User\')"', { encoding: 'utf-8' }).trim();
        if (userPath.includes(binDir)) {
          plan.system.push({ type: 'path_entry', path: binDir });
        }
      } catch { /* ignore */ }
    }
  } else {
    // Linux/macOS binary cleanup (only if binary channel)
    if (channel === 'binary') {
      const localBin = join(home, '.local', 'bin');
      for (const name of ['bean', 'taskbean']) {
        const p = join(localBin, name);
        if (existsSync(p)) plan.system.push({ type: 'binary', path: p });
      }
    }
  }

  // ── 5. Data directory ──
  const dataDir = join(home, '.taskbean');
  if (!keepData && existsSync(dataDir)) {
    plan.data = dataDir;
  }

  // ── Display plan ──
  const totalItems = plan.global.length + plan.projects.length + plan.scanned.length
    + plan.system.length + (plan.data ? 1 : 0);

  if (totalItems === 0) {
    const msg = 'Nothing to remove. taskbean appears to be already uninstalled.';
    if (json) console.log(JSON.stringify({ status: 'nothing_to_do', message: msg }));
    else console.log(`✅ ${msg}`);
    return;
  }

  if (json && dryRun) {
    console.log(JSON.stringify({ dryRun: true, plan }, null, 2));
    return;
  }

  if (!json) {
    console.error('');
    console.error('taskbean uninstall');
    console.error('');
    if (plan.global.length) {
      console.error(`  ✓ ${plan.global.length} global skill director${plan.global.length === 1 ? 'y' : 'ies'}`);
    }
    if (plan.projects.length) {
      console.error(`  ✓ ${plan.projects.length} file${plan.projects.length === 1 ? '' : 's'} from DB-known projects`);
    }
    if (plan.scanned.length) {
      console.error(`  ✓ ${plan.scanned.length} manually installed skill director${plan.scanned.length === 1 ? 'y' : 'ies'} (from scan)`);
    }
    for (const s of plan.system) {
      switch (s.type) {
        case 'codex_config': console.error(`  ✓ Codex config edit (${s.path})`); break;
        case 'protocol_handler': console.error(`  ✓ Windows protocol handler (taskbean://)`); break;
        case 'binary_dir': console.error(`  ✓ Binary directory (${s.path})`); break;
        case 'path_entry': console.error(`  ✓ PATH entry (${s.path})`); break;
        case 'binary': console.error(`  ✓ Binary (${s.path})`); break;
      }
    }
    if (plan.data) {
      console.error(`  ✓ Data directory (${plan.data})`);
    }
    if (keepData) {
      console.error('');
      console.error(`  ℹ Keeping ${join(home, '.taskbean')} (--keep-data)`);
    }
    if (!doScan) {
      console.error('');
      console.error('  Tip: use --scan to also find manually installed skill files.');
    }
    console.error('');
  }

  if (dryRun) {
    if (!json) console.log('Dry run — nothing was removed.');
    return;
  }

  // ── Confirm ──
  if (!force && json) {
    console.log(JSON.stringify({ error: 'json_requires_force', message: 'Use --force or --yes with --json to skip confirmation.' }));
    process.exitCode = 1;
    return;
  }
  if (!force) {
    const answer = await prompt('Proceed? [y/N] ');
    if (answer !== 'y' && answer !== 'yes') {
      if (!json) console.error('Aborted.');
      process.exitCode = 1;
      return;
    }
  }

  // ── Execute removal ──
  const results = [];
  let hasErrors = false;

  // Global skills
  for (const dir of plan.global) {
    const r = safeRemove(dir);
    results.push(r);
    if (r.status === 'error') hasErrors = true;
  }

  // DB-known project files
  for (const path of plan.projects) {
    const r = safeRemove(path);
    results.push(r);
    if (r.status === 'error') hasErrors = true;
  }

  // Scanned files
  for (const path of plan.scanned) {
    const r = safeRemove(path);
    results.push(r);
    if (r.status === 'error') hasErrors = true;
  }

  // Codex config revert
  if (codexRevert) {
    try {
      writeFileSync(codexRevert.path, codexRevert.content);
      results.push({ path: codexRevert.path, status: 'reverted' });
    } catch (e) {
      results.push({ path: codexRevert.path, status: 'error', error: e.message });
      hasErrors = true;
    }
  }

  // System artifacts
  for (const s of plan.system) {
    if (s.type === 'codex_config') continue; // handled above
    if (s.type === 'protocol_handler') {
      try {
        execSync('reg delete "HKCU\\Software\\Classes\\taskbean" /f 2>nul', { stdio: 'pipe' });
        results.push({ path: s.path, status: 'removed' });
      } catch (e) {
        results.push({ path: s.path, status: 'error', error: e.message });
        hasErrors = true;
      }
    } else if (s.type === 'path_entry') {
      try {
        const cmd = `powershell -NoProfile -Command "$p = [Environment]::GetEnvironmentVariable('PATH', 'User'); $entries = $p -split ';' | Where-Object { $_ -ne '${s.path.replace(/'/g, "''")}' }; [Environment]::SetEnvironmentVariable('PATH', ($entries -join ';'), 'User')"`;
        execSync(cmd, { stdio: 'pipe' });
        results.push({ path: s.path, status: 'removed_from_path' });
      } catch (e) {
        results.push({ path: s.path, status: 'error', error: e.message });
        hasErrors = true;
      }
    } else if (s.type === 'binary_dir' || s.type === 'binary') {
      const r = safeRemove(s.path);
      results.push(r);
      if (r.status === 'error') hasErrors = true;
    }
  }

  // Data directory (last — DB was needed for project cleanup)
  if (plan.data) {
    // Close DB connection before deleting ~/.taskbean/ to release file locks
    try {
      const { getDb } = await import('../data/store.js');
      getDb().close();
    } catch { /* DB may not have been opened */ }
    const r = safeRemove(plan.data);
    results.push(r);
    if (r.status === 'error') hasErrors = true;
  }

  // ── Output ──
  if (json) {
    console.log(JSON.stringify({ status: hasErrors ? 'partial' : 'complete', results }, null, 2));
  } else {
    const removed = results.filter(r => r.status !== 'error').length;
    const errors = results.filter(r => r.status === 'error');
    console.log(`\n🧹 Removed ${removed} item${removed === 1 ? '' : 's'}.`);
    if (errors.length) {
      console.error(`\n⚠️  ${errors.length} error${errors.length === 1 ? '' : 's'}:`);
      for (const e of errors) console.error(`  ${e.path}: ${e.error}`);
    }

    // Final instructions for CLI removal
    if (channel === 'npm') {
      console.log('\nTo remove the CLI itself:\n  npm uninstall -g taskbean');
    } else if (channel === 'binary') {
      console.log('\nBinary files have been removed.');
    } else {
      console.log('\nTo remove the CLI:\n  npm uninstall -g taskbean          # if installed via npm\n  winget uninstall taskbean.taskbean # if installed via winget');
    }
  }

  if (hasErrors) process.exitCode = 1;
}
