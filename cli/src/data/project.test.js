import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProject } from './project.js';
import { resolve, basename } from 'path';

test('--project with bare name does NOT join with cwd (regression: duplicate project rows)', () => {
  const cwdName = basename(process.cwd());
  const doubled = resolve(process.cwd(), cwdName);
  // The old buggy behavior was resolve(bareName) → <cwd>/<bareName>.
  // We just need to assert the path is NOT that phantom doubled path.
  const result = resolveProject(cwdName);
  assert.notEqual(result.path, doubled, 'path must not be doubled <cwd>/<name>');
  assert.equal(result.name, cwdName);
});

test('--project with bare name overrides the detected name only', () => {
  const result = resolveProject('my-custom-name');
  assert.equal(result.name, 'my-custom-name');
  // Path should still be a real directory (cwd or git root), not cwd/my-custom-name
  assert.notEqual(result.path, resolve(process.cwd(), 'my-custom-name'));
});

test('--project with absolute path still uses that path verbatim', () => {
  const abs = process.platform === 'win32' ? 'C:\\tmp\\foo' : '/tmp/foo';
  const result = resolveProject(abs);
  assert.equal(result.path, resolve(abs));
  assert.equal(result.name, 'foo');
});

test('--project with relative path containing separator resolves against cwd', () => {
  const rel = process.platform === 'win32' ? '.\\sub\\proj' : './sub/proj';
  const result = resolveProject(rel);
  assert.equal(result.path, resolve(process.cwd(), 'sub', 'proj'));
  assert.equal(result.name, 'proj');
});

test('no override falls back to auto-detection (returns a real directory)', () => {
  const result = resolveProject();
  assert.ok(result.path && result.name, 'should return both path and name');
  assert.equal(result.path, resolve(result.path), 'path should be absolute');
});
