import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { REGRESSION_TITLES, createSandbox, extensionDir, writeFakePackage, writeShim } from './support/harness.mjs';

const runner = await import(pathToFileURL(join(extensionDir, 'bean-runner.mjs')).href);
const { buildInvocation, classifyFailure, resolveCliEntry, resolveNodeRuntime, runBean } = runner;

const sandbox = createSandbox('runner');
after(() => sandbox.cleanup());

const ECHO = 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));\n';
const isWindows = process.platform === 'win32';

function envWith(pathDirs, extra = {}) {
  return { ...sandbox.env, PATH: [...pathDirs, ...sandbox.env.PATH.split(delimiter).slice(1)].join(delimiter), ...extra };
}

test('resolves the taskbean entry next to an npm-style bean shim', () => {
  const bin = join(sandbox.dirs.root, 'npm-global');
  mkdirSync(bin);
  const entry = writeFakePackage(bin, ECHO);
  assert.equal(resolveCliEntry({ env: envWith([bin]) }), entry);
});

test('ignores node_modules/taskbean without a bean shim and packages with another name', () => {
  const noShim = join(sandbox.dirs.root, 'no-shim');
  mkdirSync(noShim);
  writeFakePackage(noShim, ECHO);
  rmSync(join(noShim, isWindows ? 'bean.cmd' : 'bean'));
  assert.equal(resolveCliEntry({ env: { ...sandbox.env, PATH: noShim } }), null);
  const impostor = join(sandbox.dirs.root, 'impostor');
  mkdirSync(impostor);
  const entry = writeFakePackage(impostor, ECHO);
  writeFileSync(join(dirname(dirname(entry)), 'package.json'), JSON.stringify({ name: 'not-taskbean' }));
  const env = { ...sandbox.env, PATH: [impostor, sandbox.dirs.empty].join(delimiter) };
  assert.equal(resolveCliEntry({ env }), null);
});

test('TASKBEAN_CLI_ENTRY overrides discovery and is ignored when the file is missing', () => {
  const entry = join(sandbox.dirs.root, 'override.mjs');
  writeFileSync(entry, ECHO);
  assert.equal(resolveCliEntry({ env: { ...sandbox.env, TASKBEAN_CLI_ENTRY: entry } }), entry);
  assert.equal(resolveCliEntry({ env: { ...sandbox.env, TASKBEAN_CLI_ENTRY: join(sandbox.dirs.root, 'nope.js') } }), null);
});

test('uses PATH node when the host process is copilot.exe, not Node', () => {
  const host = isWindows ? 'C:\\Program Files\\copilot\\copilot.exe' : '/opt/copilot/copilot';
  const runtime = resolveNodeRuntime({ execPath: host, env: sandbox.env, platform: process.platform });
  assert.equal(runtime, process.execPath);
  assert.equal(resolveNodeRuntime({ execPath: process.execPath, env: {}, platform: process.platform }), process.execPath);
  assert.equal(resolveNodeRuntime({ execPath: host, env: { PATH: sandbox.dirs.empty }, platform: process.platform }), null);
});

test('direct mode runs node with the entry and no shell', () => {
  const bin = join(sandbox.dirs.root, 'direct-bin');
  mkdirSync(bin);
  const entry = writeFakePackage(bin, ECHO);
  const invocation = buildInvocation(['add', 'x'], { env: envWith([bin]), execPath: process.execPath });
  assert.equal(invocation.mode, 'direct');
  assert.equal(invocation.file, process.execPath);
  assert.deepEqual(invocation.args, [entry, 'add', 'x']);
  assert.equal(invocation.options.shell, undefined);
});

test('direct mode passes every regression title through unchanged', async () => {
  const bin = join(sandbox.dirs.root, 'roundtrip-direct');
  mkdirSync(bin);
  writeFakePackage(bin, ECHO);
  const env = envWith([bin]);
  for (const title of REGRESSION_TITLES) {
    const out = JSON.parse(await runBean(['add', title, '--json'], { env, execPath: 'copilot.exe' }));
    assert.deepEqual(out.argv, ['add', title, '--json'], `direct: ${title}`);
  }
});

test('cmd fallback (no resolvable entry) passes every regression title through unchanged', { skip: !isWindows && 'Windows-only fallback' }, async () => {
  const bin = join(sandbox.dirs.root, 'roundtrip-cmd');
  mkdirSync(bin);
  const script = join(sandbox.dirs.root, 'echo-args.mjs');
  writeFileSync(script, ECHO);
  writeShim(bin, script);
  const env = { ...sandbox.env, PATH: [bin, ...sandbox.env.PATH.split(delimiter).slice(1)].join(delimiter) };
  assert.equal(buildInvocation(['list'], { env }).mode, 'cmd');
  for (const title of REGRESSION_TITLES) {
    const out = JSON.parse(await runBean(['add', title, '--json'], { env }));
    assert.deepEqual(out.argv, ['add', title, '--json'], `cmd: ${title}`);
  }
});

test('classifies CLI failures into specific kinds', () => {
  const cases = [
    [{ error: { code: 'ENOENT' }, mode: 'direct' }, 'cli_unavailable'],
    [{ error: { code: 1 }, stderr: "'bean' is not recognized as an internal or external command", mode: 'cmd' }, 'cli_unavailable'],
    [{ error: { code: null, killed: true, signal: 'SIGTERM' }, mode: 'direct' }, 'interrupted'],
    [{ error: { code: 1 }, stderr: 'Error: database is locked', mode: 'direct' }, 'busy'],
    [{ error: { code: 1 }, stdout: '{"error":"not_found","message":"Task abc not found","code":1}', mode: 'direct' }, 'task_not_found'],
    [{ error: { code: 1 }, stdout: '{"error":"invalid","message":"bad"}', mode: 'direct' }, 'cli_rejected'],
    [{ error: { code: 1 }, stderr: "error: too many arguments for 'add'. Expected 1 argument but got 4.", mode: 'direct' }, 'cli_usage'],
    [{ error: { code: 1 }, stderr: "error: unknown option '--nope'", mode: 'direct' }, 'cli_usage'],
    [{ error: { code: 7 }, stderr: 'Error: something else\n  at x', mode: 'direct' }, 'cli_failed'],
    [{ error: { code: 1 }, stderr: 'Task not found: is not recognized', mode: 'direct' }, 'task_not_found'],
  ];
  for (const [input, kind] of cases) {
    const failure = classifyFailure({ args: ['x'], ...input });
    assert.equal(failure.kind, kind, JSON.stringify(input));
    assert.equal(failure.name, 'BeanCommandError');
  }
  assert.equal(classifyFailure({ error: { code: 7 }, stderr: 'Error: boom', mode: 'direct' }).exitCode, 7);
});
