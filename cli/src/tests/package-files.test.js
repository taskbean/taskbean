import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf-8'));

function reachableModules(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf-8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), match[1]);
      if (existsSync(target)) queue.push(target);
    }
  }
  return [...seen].map(f => relative(CLI_ROOT, f).split('\\').join('/'));
}

describe('npm package files allowlist', () => {
  it('includes every module reachable from the CLI entry point', () => {
    const allowed = pkg.files;
    const covered = path => allowed.some(entry => entry.endsWith('/') ? path.startsWith(entry) : path === entry);
    const missing = reachableModules(join(CLI_ROOT, 'bin', 'taskbean.js')).filter(p => !covered(p));
    assert.deepEqual(missing, []);
  });
});
