// Tests for `bean install --agent auto`.
//
// We test `installCommand()` directly (not via execSync) so we can control
// PATH and probe detectAgents without shelling out.
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join, delimiter } from 'path';
import { tmpdir, platform } from 'os';

const TEST_ROOT = join(tmpdir(), 'taskbean-install-auto-' + Date.now());
mkdirSync(TEST_ROOT, { recursive: true });

const { installCommand, detectAgents, isOnPath } =
  await import('../commands/install.js');

const ORIG_PATH = process.env.PATH;
const ORIG_PATHEXT = process.env.PATHEXT;
const ORIG_CWD = process.cwd();

function makeFakeBin(dir, name, isWindows = platform() === 'win32') {
  mkdirSync(dir, { recursive: true });
  if (isWindows) {
    writeFileSync(join(dir, name + '.cmd'), '@echo off\r\necho fake\r\n');
  } else {
    const p = join(dir, name);
    writeFileSync(p, '#!/bin/sh\necho fake\n', { mode: 0o755 });
  }
}

function captureOutput(fn) {
  const origLog = console.log;
  const origErr = console.error;
  let stdout = '';
  let stderr = '';
  console.log = (...a) => { stdout += a.join(' ') + '\n'; };
  console.error = (...a) => { stderr += a.join(' ') + '\n'; };
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { stdout, stderr };
}

describe('install --agent auto', () => {
  let binDir;
  let projectDir;
  let caseCounter = 0;

  beforeEach(() => {
    caseCounter += 1;
    binDir = join(TEST_ROOT, 'bin-' + caseCounter);
    projectDir = join(TEST_ROOT, 'proj-' + caseCounter);
    mkdirSync(binDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    process.env.PATH = binDir; // isolated PATH with no real agents
    process.chdir(projectDir);
    process.exitCode = 0;
  });

  afterEach(() => {
    process.env.PATH = ORIG_PATH;
    if (ORIG_PATHEXT === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = ORIG_PATHEXT;
    process.chdir(ORIG_CWD);
  });

  it('with no agents on PATH: exitCode=2 and error logged', () => {
    const { stdout, stderr } = captureOutput(() => {
      installCommand({ agent: 'auto', json: true });
    });
    assert.equal(process.exitCode, 2);
    // In --json mode the error is emitted on stderr as JSON.
    const parsed = JSON.parse(stderr.trim());
    assert.equal(parsed.error, 'no_agents_detected');
    assert.equal(stdout, '');
    // Skill file NOT created.
    assert.ok(!existsSync(join(projectDir, '.agents', 'skills', 'taskbean', 'SKILL.md')));
  });

  it('with copilot on PATH: writes SKILL.md to .agents/skills/taskbean/', () => {
    makeFakeBin(binDir, 'copilot');
    assert.ok(detectAgents().includes('copilot'));
    const { stdout } = captureOutput(() => {
      installCommand({ agent: 'auto', json: true });
    });
    const parsed = JSON.parse(stdout.trim());
    assert.deepEqual(parsed.detected, ['copilot']);
    assert.ok(existsSync(join(projectDir, '.agents', 'skills', 'taskbean', 'SKILL.md')));
    // Copilot also writes to .github/skills/
    assert.ok(existsSync(join(projectDir, '.github', 'skills', 'taskbean', 'SKILL.md')));
  });

  it('with both copilot and claude on PATH: writes to .agents AND .claude', () => {
    makeFakeBin(binDir, 'copilot');
    makeFakeBin(binDir, 'claude');
    const detected = detectAgents();
    assert.ok(detected.includes('copilot'));
    assert.ok(detected.includes('claude'));
    const { stdout } = captureOutput(() => {
      installCommand({ agent: 'auto', json: true });
    });
    const parsed = JSON.parse(stdout.trim());
    assert.deepEqual(parsed.detected.sort(), ['claude', 'copilot']);
    assert.ok(existsSync(join(projectDir, '.agents', 'skills', 'taskbean', 'SKILL.md')),
      '.agents skill exists (from copilot)');
    assert.ok(existsSync(join(projectDir, '.claude', 'skills', 'taskbean', 'SKILL.md')),
      '.claude skill exists (from claude)');
  });

  it('isOnPath honours PATHEXT on Windows (detects .ps1 only)', (t) => {
    if (platform() !== 'win32') { t.skip('Windows-only PATHEXT behaviour'); return; }
    // Put only a .ps1 file on PATH and extend PATHEXT to include it.
    const ps1Dir = join(TEST_ROOT, 'ps1-' + caseCounter);
    mkdirSync(ps1Dir, { recursive: true });
    writeFileSync(join(ps1Dir, 'copilot.ps1'), '# fake\n');
    process.env.PATH = ps1Dir;
    process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD;.PS1';
    assert.ok(isOnPath('copilot'), 'copilot.ps1 detected via PATHEXT');
  });
});

after(() => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});
