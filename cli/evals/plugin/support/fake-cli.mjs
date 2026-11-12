// Fake Taskbean CLI entry. FAKE_BEAN_MODE selects the failure to simulate.
const mode = process.env.FAKE_BEAN_MODE || 'echo';
const args = process.argv.slice(2);
const home = process.env.USERPROFILE || process.env.HOME || '';

switch (mode) {
  case 'echo':
    process.stdout.write(JSON.stringify({ argv: args }));
    break;
  case 'usage':
    process.stderr.write(`error: too many arguments for 'add'. Expected 1 argument but got 4.\n`);
    process.exit(1);
    break;
  case 'crash':
    process.stderr.write(`Error: boom while reading ${home}\\private\\taskbean.db\n    at main (file.js:1:1)\n`);
    process.exit(3);
    break;
  case 'startup-error':
    process.stderr.write(`node:internal/modules/package_json_reader:343\n  throw new ERR_MODULE_NOT_FOUND();\n  ^\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'commander' at ${home}\\private; token=${process.env.TEST_API_TOKEN}; Authorization: Bearer test-bearer-secret\n    at main (file.js:1:1)\n`);
    process.exit(1);
    break;
  case 'garbage':
    process.stdout.write('this is not json');
    break;
  case 'json-error':
    process.stdout.write(JSON.stringify({ error: 'invalid_priority', message: 'Priority must be high, medium, low or none.', code: 1 }));
    process.exit(1);
    break;
  case 'locked':
    process.stderr.write('Error: database is locked\n');
    process.exit(1);
    break;
  default:
    process.stderr.write(`unknown FAKE_BEAN_MODE ${mode}\n`);
    process.exit(9);
}
