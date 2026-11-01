#!/usr/bin/env node
// Target-behavior gap report. Exits 0 by default; --strict exits 1 on any fail or drift.
// Flags: --json, --html <path>, --strict.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliEntry, createSandbox, loadExtension, repoRoot, useEnv } from '../support/harness.mjs';
import { checks } from './checks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const htmlPath = args.includes('--html') ? resolve(args[args.indexOf('--html') + 1]) : null;

const data = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));
const originalPath = process.env.PATH;
const sb = createSandbox('target');
useEnv({ ...sb.env, TASKBEAN_CLI_ENTRY: cliEntry });
process.chdir(sb.dirs.project);

const skill = readFileSync(join(repoRoot, '.agents', 'skills', 'taskbean', 'SKILL.md'), 'utf8');
const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill)?.[1] || '';
const description = (/^description:\s*(?:>-?|\|-?)?\s*\r?\n((?:[ \t]+.*\r?\n?)+)/m.exec(fm)?.[1] || /^description:\s*(.*)$/m.exec(fm)?.[1] || '').replace(/\s+/g, ' ').trim();
const { actions, invoke } = await loadExtension();

let projectN = 0;
const ctx = {
  sb,
  skill,
  description,
  actions,
  invoke,
  project(name) {
    const dir = join(sb.dirs.root, 'projects', `${name}-${++projectN}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  bean(argv, { cwd = sb.dirs.project, env = {}, allowFail = false } = {}) {
    try {
      const out = execFileSync(process.execPath, [cliEntry, ...argv], { cwd, env: { ...sb.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return JSON.parse(out);
    } catch (error) {
      if (!allowFail) throw new Error(`bean ${argv[0]} failed: ${(error.stdout || error.message).slice(0, 300)}`);
      try { return JSON.parse(error.stdout); } catch { return { error: error.message }; }
    }
  },
  help(argv) {
    return execFileSync(process.execPath, [cliEntry, ...argv, '--help'], { env: sb.env, encoding: 'utf8' });
  },
  git(argv, cwd) {
    return execFileSync('git', argv, { cwd, env: { ...sb.env, PATH: originalPath }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  },
};

const rows = [];
for (const c of data.cases) {
  let measured = 'not_testable';
  let detail = 'no automated check yet';
  if (c.check) {
    const fn = checks[c.check];
    if (!fn) {
      measured = 'fail';
      detail = `missing check ${c.check}`;
    } else {
      try {
        const r = await fn(ctx);
        measured = r.pass ? 'pass' : 'fail';
        detail = r.detail;
      } catch (error) {
        measured = 'fail';
        detail = `check error: ${String(error.message).split('\n')[0].slice(0, 200)}`;
      }
    }
  }
  rows.push({ ...c, measured, detail, drift: measured !== c.current });
}

process.chdir(repoRoot);
sb.cleanup();

const count = (k) => rows.filter((r) => r.measured === k).length;
const summary = { total: rows.length, pass: count('pass'), fail: count('fail'), not_testable: count('not_testable'), drift: rows.filter((r) => r.drift).length };
const byArea = {};
for (const r of rows) {
  byArea[r.area] ??= { pass: 0, fail: 0, not_testable: 0 };
  byArea[r.area][r.measured]++;
}

if (htmlPath) {
  writeFileSync(htmlPath, renderHtml(data, rows, summary, byArea));
}

if (flag('--json')) {
  console.log(JSON.stringify({ summary, byArea, cases: rows.map(({ id, area, issues, check, method, current, measured, detail, drift }) => ({ id, area, issues, check, method, current, measured, detail, drift })) }, null, 2));
} else {
  console.log('TARGET BEHAVIOR gap report (failures are the expected gap, not regressions)\n');
  for (const r of rows) {
    const mark = { pass: 'PASS', fail: 'GAP ', not_testable: 'N/T ' }[r.measured];
    console.log(`${mark} ${r.id.padEnd(6)} ${r.title}${r.drift ? `  [DRIFT: recorded ${r.current}]` : ''}`);
    console.log(`       ${r.detail}`);
  }
  console.log('\nBy area:');
  for (const [area, n] of Object.entries(byArea)) console.log(`  ${area.padEnd(28)} pass ${n.pass}  gap ${n.fail}  n/t ${n.not_testable}`);
  console.log(`\n${summary.total} cases: ${summary.pass} pass, ${summary.fail} gap, ${summary.not_testable} not testable, ${summary.drift} drift`);
}

process.exit(flag('--strict') && (summary.fail || summary.drift) ? 1 : 0);

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

function renderHtml(data, rows, summary, byArea) {
  const issueLink = (i) => `<a href="https://github.com/taskbean/taskbean/issues/${i.slice(1)}">${esc(i)}</a>`;
  const badge = (s) => `<span class="b ${s}">${{ pass: 'pass', fail: 'gap', not_testable: 'not testable' }[s]}</span>`;
  const areas = [...new Set(rows.map((r) => r.area))];
  const sections = areas.map((area) => {
    const n = byArea[area];
    const trs = rows.filter((r) => r.area === area).map((r) => `
      <tr>
        <td class="id">${esc(r.id)}</td>
        <td><strong>${esc(r.title)}</strong>${r.open_question ? `<div class="q">Open question: ${esc(r.open_question)}</div>` : ''}</td>
        <td>${r.issues.map(issueLink).join(' ')}</td>
        <td>${esc(r.input)}</td>
        <td>${esc(r.expected)}</td>
        <td>${esc(r.method)}</td>
        <td>${badge(r.measured)}<div class="d">${esc(r.detail)}</div></td>
      </tr>`).join('');
    return `<h2>${esc(area)} <small>${n.pass} pass · ${n.fail} gap · ${n.not_testable} not testable</small></h2>
    <table><thead><tr><th>ID</th><th>Case</th><th>Issues</th><th>Input</th><th>Expected (target)</th><th>Method</th><th>Current</th></tr></thead><tbody>${trs}</tbody></table>`;
  }).join('\n');
  const questions = [
    ...rows.filter((r) => r.open_question).map((r) => `<li><strong>${esc(r.id)}</strong>: ${esc(r.open_question)}</li>`),
    ...(data.open_questions || []).map((q) => `<li>${esc(typeof q === 'string' ? q : q.question || JSON.stringify(q))}</li>`),
  ].join('');
  const pct = (k) => ((summary[k] / summary.total) * 100).toFixed(1);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Taskbean target eval catalog</title>
<style>
  body{font:14px/1.45 "Segoe UI",system-ui,sans-serif;margin:24px auto;max-width:1400px;padding:0 20px;color:#1f1d1a;background:#faf8f5}
  .banner{background:#fff4d6;border:1px solid #e0b84d;border-radius:8px;padding:12px 16px;margin-bottom:16px}
  .model{background:#fff;border:1px solid #ddd5c8;border-radius:8px;padding:12px 16px}
  .stats{display:flex;gap:12px;margin:16px 0}
  .stat{flex:1;background:#fff;border:1px solid #ddd5c8;border-radius:8px;padding:10px 14px}
  .stat b{font-size:24px;display:block}
  .bar{display:flex;height:10px;border-radius:5px;overflow:hidden;margin:8px 0 20px}
  .bar .pass{background:#3f8f5a}.bar .fail{background:#c0582f}.bar .not_testable{background:#9a9186}
  table{border-collapse:collapse;width:100%;background:#fff;margin-bottom:24px}
  th,td{border:1px solid #e5ddd1;padding:6px 8px;vertical-align:top;text-align:left}
  th{background:#f1ebe2}
  td.id{font-family:Consolas,monospace;white-space:nowrap}
  h2 small{font-weight:normal;color:#6b6258;font-size:13px;margin-left:8px}
  .b{display:inline-block;padding:1px 8px;border-radius:10px;color:#fff;font-size:12px}
  .b.pass{background:#3f8f5a}.b.fail{background:#c0582f}.b.not_testable{background:#9a9186}
  .d{color:#6b6258;font-size:12px;margin-top:4px}
  .q{color:#8a5a00;font-size:12px;margin-top:4px}
  code{background:#f1ebe2;padding:1px 4px;border-radius:3px}
</style></head><body>
<h1>Taskbean target eval catalog</h1>
<div class="banner"><strong>Target behavior, draft for review.</strong> These cases describe where Taskbean should go. A gap is expected, not a regression. Release gates stay in <code>npm run eval:plugin</code>. Run this report with <code>npm run eval:target</code> from <code>cli/</code>.</div>
<div class="model"><strong>Operating model.</strong> ${esc(data._meta.model)}</div>
<div class="stats">
  <div class="stat"><b>${summary.total}</b>cases</div>
  <div class="stat"><b>${summary.pass}</b>pass today</div>
  <div class="stat"><b>${summary.fail}</b>gap (fail today)</div>
  <div class="stat"><b>${summary.not_testable}</b>not yet testable</div>
</div>
<div class="bar"><div class="pass" style="width:${pct('pass')}%"></div><div class="fail" style="width:${pct('fail')}%"></div><div class="not_testable" style="width:${pct('not_testable')}%"></div></div>
<p>Methods: <strong>runtime</strong> runs the CLI and canvas in an isolated sandbox; <strong>static</strong> is a proxy check on shipped skill or manifest text (model behavior still needs a live agent run); <strong>none</strong> is not yet testable.</p>
${sections}
<h2>Open questions</h2><ul>${questions}</ul>
<p class="d">Generated by cli/evals/plugin/target/run-target.mjs.</p>
</body></html>
`;
}
