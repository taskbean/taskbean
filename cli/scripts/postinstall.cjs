#!/usr/bin/env node
// taskbean npm postinstall hook.
//
// - Writes ~/.taskbean/.install-channel = "npm" so `bean upgrade` knows to
//   route through `npm install -g taskbean@latest`.
// - Prints a short first-run banner iff stdout is a TTY AND we're not in CI
//   AND TASKBEAN_SKIP_POSTINSTALL is not set. npm builds in pipelines would
//   otherwise get noise.
// - Never fails: any error is swallowed and we exit 0 so `npm install -g`
//   never breaks because of the banner.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CI_ENV_VARS = ['CI', 'GITHUB_ACTIONS', 'BUILDKITE', 'CIRCLECI', 'GITLAB_CI'];

function isCI() {
  return CI_ENV_VARS.some((v) => {
    const val = process.env[v];
    return val && val !== '' && val !== '0' && val !== 'false';
  });
}

try {
  const dir = path.join(os.homedir(), '.taskbean');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.install-channel'), 'npm');
} catch { /* ignore */ }

try {
  const quiet = process.env.TASKBEAN_SKIP_POSTINSTALL === '1' || isCI() || !process.stdout.isTTY;
  if (!quiet) {
    process.stdout.write([
      '',
      '🫘 taskbean installed.',
      '   Next: `bean install --agent auto` to enable the skill for your coding agents.',
      '   Docs: https://taskbean.ai',
      '',
    ].join('\n') + '\n');
  }
} catch { /* ignore */ }

process.exit(0);
