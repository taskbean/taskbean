// One-shot helper to regenerate the SKILL_MD constant in cli/src/commands/install.js
// from the canonical .agents/skills/taskbean/SKILL.md on disk.
//
// Also stamps `metadata.taskbean_version` in the canonical SKILL.md frontmatter
// from cli/package.json so on-disk SKILL.md copies advertise the version they
// were installed with — used by `bean update-skill` for drift detection.
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

const skillMdPath = join(repoRoot, '.agents', 'skills', 'taskbean', 'SKILL.md');
const installJsPath = join(repoRoot, 'cli', 'src', 'commands', 'install.js');
const pkgPath = join(repoRoot, 'cli', 'package.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const version = pkg.version;
if (!version || typeof version !== 'string') {
  console.error('FATAL: cli/package.json has no version');
  process.exit(1);
}

// Step 1: read canonical SKILL.md and rewrite metadata.taskbean_version in
// frontmatter to match cli/package.json. The `metadata:` block lives between
// `description: >- ... <body>` and the closing `---`. We replace whatever
// taskbean_version line is there with the current package version, or insert a
// fresh metadata block right before the closing `---` if none exists.
let md = readFileSync(skillMdPath, 'utf-8').replace(/\r\n/g, '\n');

const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n/);
if (!fmMatch) {
  console.error('FATAL: canonical SKILL.md is missing YAML frontmatter');
  process.exit(1);
}
const fmStart = 0;
const fmEnd = fmMatch[0].length; // position of char after closing ---\n
const fm = fmMatch[1];
const body = md.slice(fmEnd);

let newFm;
if (/taskbean_version:/.test(fm)) {
  newFm = fm.replace(/taskbean_version:\s*"?[^"\n]*"?/, `taskbean_version: "${version}"`);
} else if (/^metadata:/m.test(fm)) {
  newFm = fm.replace(/^metadata:\n/m, `metadata:\n  taskbean_version: "${version}"\n`);
} else {
  newFm = `${fm.replace(/\s+$/, '')}\nmetadata:\n  taskbean_version: "${version}"`;
}

md = `---\n${newFm}\n---\n${body}`;
writeFileSync(skillMdPath, md);

// Step 2: propagate to install.js as before.
const lines = md.split('\n');

// Strip the trailing empty line from the file's final newline so the JS array
// matches the original format (last entry was empty + trailing comma).
if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

const arrEntries = lines.map((line) => {
  // Escape backslash, then single-quote, for a JS single-quoted string literal.
  const escaped = line.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `  '${escaped}',`;
});
// Preserve trailing empty entry to mirror the original (which ended with '',)
arrEntries.push("  '',");

const newBlock = `export const SKILL_MD = [\n${arrEntries.join('\n')}\n].join('\\n');`;

const js = readFileSync(installJsPath, 'utf-8');
const blockRegex = /(?:export )?const SKILL_MD = \[[\s\S]*?\]\.join\('\\n'\);/;
if (!blockRegex.test(js)) {
  console.error('FATAL: could not locate SKILL_MD constant in install.js');
  process.exit(1);
}
const updated = js.replace(blockRegex, newBlock);
writeFileSync(installJsPath, updated);
console.log(`Stamped taskbean_version: ${version}`);
console.log(`Updated ${skillMdPath}`);
console.log(`Updated ${installJsPath}`);
console.log(`SKILL_MD now has ${arrEntries.length} array entries (${md.length} chars source).`);
