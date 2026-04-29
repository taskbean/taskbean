// One-shot helper to regenerate the SKILL_MD constant in cli/src/commands/install.js
// from the canonical .agents/skills/taskbean/SKILL.md on disk.
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

const skillMdPath = join(repoRoot, '.agents', 'skills', 'taskbean', 'SKILL.md');
const installJsPath = join(repoRoot, 'cli', 'src', 'commands', 'install.js');

const md = readFileSync(skillMdPath, 'utf-8').replace(/\r\n/g, '\n');
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

const newBlock = `const SKILL_MD = [\n${arrEntries.join('\n')}\n].join('\\n');`;

const js = readFileSync(installJsPath, 'utf-8');
const blockRegex = /const SKILL_MD = \[[\s\S]*?\]\.join\('\\n'\);/;
if (!blockRegex.test(js)) {
  console.error('FATAL: could not locate SKILL_MD constant in install.js');
  process.exit(1);
}
const updated = js.replace(blockRegex, newBlock);
writeFileSync(installJsPath, updated);
console.log(`Updated ${installJsPath}`);
console.log(`SKILL_MD now has ${arrEntries.length} array entries (${md.length} chars source).`);
