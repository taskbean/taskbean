import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { cliEntry, cliRoot, createSandbox, extensionDir, repoRoot, useEnv } from './support/harness.mjs';

const suite = JSON.parse(readFileSync(new URL('./skill-cases.json', import.meta.url), 'utf8'));
const skill = readFileSync(join(repoRoot, suite.skill_path), 'utf8');
const description = skill.match(/^description: >-\r?\n([\s\S]*?)\r?\nmetadata:/m)?.[1].replace(/\s+/g, ' ') ?? '';

const sandbox = createSandbox('skill');
useEnv({ ...sandbox.env, TASKBEAN_CLI_ENTRY: cliEntry });
process.chdir(sandbox.dirs.project);
const { runBean } = await import(pathToFileURL(join(extensionDir, 'bean-runner.mjs')).href);

after(() => {
  process.chdir(cliRoot);
  sandbox.cleanup();
});

const positives = suite.cases.filter((c) => c.should_trigger);
const negatives = suite.cases.filter((c) => !c.should_trigger);

test('case file is well formed with balanced trigger and no-trigger coverage', () => {
  assert.equal(suite.skill_name, 'taskbean');
  assert.equal(new Set(suite.cases.map((c) => c.id)).size, suite.cases.length, 'unique ids');
  assert.ok(positives.length >= 8, 'at least 8 trigger cases');
  assert.ok(negatives.length >= 6, 'at least 6 no-trigger cases');
  for (const c of suite.cases) assert.ok(c.prompt.trim(), c.id);
  for (const c of negatives) assert.deepEqual(c.expected_commands, [], c.id);
  for (const c of positives) assert.ok(c.expected_commands.length > 0, c.id);
});

test('skill description advertises every trigger category and exclusion', () => {
  for (const verb of ['fix', 'implement', 'debug', 'investigate', 'refactor', 'CI/CD', 'reporting', 'chronicle doctor']) {
    assert.ok(description.includes(verb), `description mentions ${verb}`);
  }
  for (const exclusion of suite._meta.exclusions) {
    assert.ok(description.includes(exclusion), `description excludes ${exclusion}`);
  }
  for (const c of negatives) assert.ok(suite._meta.exclusions.includes(c.category), `${c.id} maps to a documented exclusion`);
});

test('code-change cases capture before work and close or block the task', () => {
  for (const c of positives.filter((x) => x.replay_title)) {
    assert.equal(c.expected_commands[0][0], 'add', `${c.id} starts with bean add`);
    assert.ok(['done', 'block'].includes(c.expected_commands.at(-1)[0]), `${c.id} ends with done or block`);
    for (const command of c.expected_commands) assert.equal(command.at(-1), '--json', `${c.id} uses --json`);
  }
});

test('every expected command is documented in the skill', () => {
  const subcommands = new Set(positives.flatMap((c) => c.expected_commands.map((cmd) => cmd[0])));
  for (const sub of subcommands) assert.match(skill, new RegExp(`bean ${sub}\\b`), `SKILL.md documents bean ${sub}`);
});

function substitute(command, title, id) {
  return command.map((part) => (part === '<title>' ? title : part === '<id>' ? id : part));
}

test('expected command sequences succeed against an isolated store', async () => {
  for (const c of positives) {
    let id = '';
    let last;
    for (const command of c.expected_commands) {
      const out = await runBean(substitute(command, c.replay_title, id));
      last = JSON.parse(out);
      if (command[0] === 'add') {
        assert.equal(last.title, c.replay_title, `${c.id}: title is stored exactly`);
        id ||= last.id;
      }
    }
    if (c.expected_commands.at(-1)[0] === 'done') assert.equal(last.status, 'done', c.id);
    if (c.expected_commands.at(-1)[0] === 'block') assert.equal(last.status, 'blocked', c.id);
    assert.ok(last !== undefined, c.id);
  }
});
