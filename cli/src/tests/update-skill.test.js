import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractTaskbeanVersion,
  scanSkills,
  BUNDLED_VERSION,
} from '../commands/update-skill.js';
import { SKILL_MD } from '../commands/install.js';

const BEAN = 'node ' + join(process.cwd(), 'bin', 'taskbean.js');

function bean(args, env, cwd) {
  try {
    return execSync(`${BEAN} ${args}`, {
      encoding: 'utf-8',
      env,
      cwd,
    }).trim();
  } catch (e) {
    if (e.stdout) return e.stdout.trim();
    throw e;
  }
}

describe('extractTaskbeanVersion', () => {
  it('returns version from quoted metadata', () => {
    const md = `---\nname: taskbean\ndescription: x\nmetadata:\n  taskbean_version: "1.2.3"\n---\nbody\n`;
    assert.equal(extractTaskbeanVersion(md), '1.2.3');
  });
  it('returns version from unquoted metadata', () => {
    const md = `---\nname: taskbean\ndescription: x\nmetadata:\n  taskbean_version: 0.5.0\n---\nbody\n`;
    assert.equal(extractTaskbeanVersion(md), '0.5.0');
  });
  it('returns null for unstamped frontmatter', () => {
    const md = `---\nname: taskbean\ndescription: x\n---\nbody\n`;
    assert.equal(extractTaskbeanVersion(md), null);
  });
  it('returns null for missing frontmatter', () => {
    assert.equal(extractTaskbeanVersion('# just a body\n'), null);
  });
  it('does not match a version stamp inside the body', () => {
    const md = `---\nname: taskbean\ndescription: x\n---\nSee taskbean_version: "9.9.9" elsewhere.\n`;
    assert.equal(extractTaskbeanVersion(md), null);
  });
});

describe('BUNDLED_VERSION', () => {
  it('matches the version stamped in the bundled SKILL_MD', () => {
    assert.equal(BUNDLED_VERSION, extractTaskbeanVersion(SKILL_MD));
    assert.match(BUNDLED_VERSION, /^\d+\.\d+\.\d+/);
  });
});

describe('bean update-skill', () => {
  const TEST_HOME = join(tmpdir(), 'taskbean-update-skill-test-' + Date.now());
  const TEST_PROJECT = join(TEST_HOME, 'my-project');
  const env = { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME };

  before(() => {
    mkdirSync(TEST_PROJECT, { recursive: true });
  });
  after(() => {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  });

  it('reports up-to-date when nothing is installed', () => {
    const out = bean('update-skill --json --global', env, TEST_PROJECT);
    const r = JSON.parse(out);
    assert.equal(r.bundled_version, BUNDLED_VERSION);
    assert.equal(r.stale_count, 0);
    assert.equal(r.present_count, 0);
  });

  it('detects an unstamped on-disk SKILL.md as stale', () => {
    // Manually plant a SKILL.md without the version stamp.
    const dir = join(TEST_PROJECT, '.agents', 'skills', 'taskbean');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: taskbean\ndescription: old\n---\n# old body\n`
    );
    const out = bean('update-skill --json --project', env, TEST_PROJECT);
    const r = JSON.parse(out);
    assert.equal(r.stale_count, 1);
    assert.equal(r.on_disk[0].state, 'unstamped');
  });

  it('--apply rewrites stale copies and second run reports fresh', () => {
    bean('update-skill --apply --project', env, TEST_PROJECT);
    const after = JSON.parse(bean('update-skill --json --project', env, TEST_PROJECT));
    assert.equal(after.stale_count, 0);
    assert.equal(after.fresh_count, 1);
    const written = readFileSync(
      join(TEST_PROJECT, '.agents', 'skills', 'taskbean', 'SKILL.md'),
      'utf-8'
    );
    assert.equal(written, SKILL_MD);
    assert.equal(extractTaskbeanVersion(written), BUNDLED_VERSION);
  });

  it('errors on conflicting --project and --global', () => {
    let result;
    try {
      execSync(`${BEAN} update-skill --project --global --json`, { encoding: 'utf-8', env, cwd: TEST_PROJECT });
      assert.fail('expected non-zero exit');
    } catch (e) {
      result = (e.stderr || '') + (e.stdout || '');
      assert.equal(e.status, 2);
    }
    assert.match(result, /Cannot combine/);
  });
});

describe('scanSkills (in-process)', () => {
  it('classifies fresh, stale, and unstamped correctly', () => {
    const TEST_HOME = join(tmpdir(), 'taskbean-scanskills-' + Date.now());
    const TEST_PROJECT = join(TEST_HOME, 'p');
    const dir = join(TEST_PROJECT, '.agents', 'skills', 'taskbean');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), SKILL_MD);

    const r = scanSkills({ projectOnly: true, cwd: TEST_PROJECT, home: TEST_HOME });
    assert.equal(r.bundled_version, BUNDLED_VERSION);
    assert.equal(r.fresh_count, 1);
    assert.equal(r.stale_count, 0);

    rmSync(TEST_HOME, { recursive: true, force: true });
  });
});
