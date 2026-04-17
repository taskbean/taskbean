// Single source of truth for the `bean` CLI version.
//
// Resolution order:
//   1. Build-time injected `globalThis.TASKBEAN_VERSION` (used when `bun build
//      --compile --define 'globalThis.TASKBEAN_VERSION="0.5.0"'` produces the
//      standalone binary — the package.json is not packaged in that case).
//   2. Read `../../package.json` at runtime (npm / source checkout).
//   3. Fallback string so the CLI never crashes if both paths fail.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

function resolveVersion() {
  if (typeof globalThis !== 'undefined' && typeof globalThis.TASKBEAN_VERSION === 'string' && globalThis.TASKBEAN_VERSION.length > 0) {
    return globalThis.TASKBEAN_VERSION.replace(/^v/, '');
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    if (pkg && typeof pkg.version === 'string') return pkg.version;
  } catch {
    // fall through
  }
  return '0.0.0-dev';
}

export const VERSION = resolveVersion();
