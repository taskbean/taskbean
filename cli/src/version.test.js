// Tests for src/version.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Note on testing globalThis.TASKBEAN_VERSION precedence:
// version.js resolves VERSION at module-load time. Once the default import
// has evaluated, reassigning globalThis.TASKBEAN_VERSION has no effect on the
// already-exported binding. Using dynamic import with a cache-busting query
// string is fragile across Node versions and ESM loaders, so we only assert
// the default behaviour + format invariant here. The build-time injection
// path is exercised by the actual Bun compile pipeline, not unit tests.
const { VERSION } = await import('./version.js');

describe('VERSION', () => {
  it('is a non-empty string', () => {
    assert.equal(typeof VERSION, 'string');
    assert.ok(VERSION.length > 0);
  });

  it('matches a semver-like pattern (major.minor.patch)', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+/);
  });

  it('has no leading v', () => {
    assert.ok(!VERSION.startsWith('v'), `got ${VERSION}`);
  });
});
