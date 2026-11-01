// Target-behavior checks. Each returns { pass, detail }. A failing check is the
// expected gap for a target case, not a regression. Static checks are proxies on
// shipped text; model behavior still needs a live agent run.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cliRoot, extensionDir, fakeCli, repoRoot } from '../support/harness.mjs';

const MUTATIONS = ['add_task', 'start_task', 'block_task', 'complete_task'];
const result = (pass, detail) => ({ pass: Boolean(pass), detail });

function walk(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (ext.some((e) => name.endsWith(e)) && !/\.test\.m?js$/.test(name)) out.push(full);
  }
  return out;
}

async function rejection(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

export const checks = {
  // Static proxies on the shipped skill.
  skill_no_split_per_ask: ({ skill }) => {
    const m = /capture each (?:separately|as its own task)/i.exec(skill);
    return result(!m, m ? `SKILL.md still says "${m[0]}"` : 'no per-ask split guidance');
  },
  skill_names_evidence_not_tasks: ({ skill }) => {
    const m = /(?:commands?|retries|reruns|branch(?:es)?|sub-steps?)[^.\n]{0,80}\bevidence\b/i.exec(skill);
    return result(m, m ? `found: "${m[0]}"` : 'SKILL.md does not name commands/retries/branches as evidence');
  },
  skill_names_planner_authority: ({ skill }) =>
    result(/Planner|Microsoft To Do/.test(skill), /Planner/.test(skill) ? 'names Planner/To Do' : 'no Planner/To Do authority guidance'),
  skill_plan_mode_ephemeral: ({ skill }) =>
    result(/plan mode/i.test(skill), /plan mode/i.test(skill) ? 'mentions plan mode' : 'no plan-mode guidance'),
  skill_excludes_explanation: ({ description }) =>
    result(/pure explanation/i.test(description), 'description excludes pure explanation'),
  skill_no_log_every_small_fix: ({ skill }) => {
    const m = /Do NOT skip small fixes/i.test(skill);
    return result(!m, m ? 'SKILL.md says "Do NOT skip small fixes"' : 'no log-every-fix guidance');
  },
  skill_add_not_mandatory: ({ skill }) => {
    const m = /before (?:you start )?(?:any )?(?:coding )?work/i.exec(skill);
    return result(!m, m ? `SKILL.md requires capture "${m[0]}"` : 'capture is not a mandatory pre-step');
  },
  skill_manual_is_correction: ({ skill }) => {
    const ok = /\bhooks?\b/i.test(skill) && /\bcorrect(?:ion|ions|ing)?\b/i.test(skill);
    return result(ok, ok ? 'mentions hooks and corrections' : 'manual add/done is still the primary capture path');
  },
  skill_triggers_standup_ai_value: ({ description }) => {
    const missing = [!/standup/i.test(description) && 'standup', !/AI[- ]value/i.test(description) && 'AI value'].filter(Boolean);
    return result(missing.length === 0, missing.length ? `description lacks: ${missing.join(', ')}` : 'description names standup and AI value');
  },
  skill_pending_review_only: ({ skill }) =>
    result(/Pending Chronicle suggestions are review-only/i.test(skill), 'pending suggestions are review-only'),

  // Static proxies on manifest and source.
  static_no_planner_writes: () => {
    const files = [...walk(join(cliRoot, 'src'), ['.js']), ...walk(extensionDir, ['.mjs'])];
    const hits = files.filter((f) => /graph\.microsoft\.com|tasks\.office\.com|\/planner\//i.test(readFileSync(f, 'utf8')));
    return result(hits.length === 0, hits.length ? `Planner/Graph calls in ${hits.length} file(s)` : 'no Planner/Graph calls');
  },
  static_manifest_hooks: () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'plugin.json'), 'utf8'));
    return result(manifest.hooks, manifest.hooks ? 'plugin.json declares hooks' : 'plugin.json has no hooks');
  },
  static_canvas_mutation_confirmation: ({ actions }) => {
    const ungated = MUTATIONS.filter((name) => {
      const props = actions.get(name)?.inputSchema?.properties || {};
      return !('confirm' in props || 'confirmed' in props || 'approved' in props);
    });
    return result(ungated.length === 0, ungated.length ? `no confirmation input on: ${ungated.join(', ')}` : 'all mutations are gated');
  },
  static_versions_aligned: ({ skill }) => {
    const read = (p) => JSON.parse(readFileSync(join(repoRoot, p), 'utf8'));
    const versions = { plugin: read('plugin.json').version, cli: read('cli/package.json').version };
    for (const p of ['.github/plugin/marketplace.json', '.claude-plugin/marketplace.json']) {
      const m = read(p);
      versions[`${p}:metadata`] = m.metadata?.version;
      for (const entry of m.plugins || []) versions[`${p}:${entry.name}`] = entry.version;
    }
    versions.skill = /taskbean_version:\s*"([^"]+)"/.exec(skill)?.[1];
    const distinct = [...new Set(Object.values(versions))];
    return result(distinct.length === 1, distinct.length === 1 ? `all ${distinct[0]}` : JSON.stringify(versions));
  },

  // Runtime checks in the isolated sandbox.
  runtime_key_upsert: ({ bean, project }) => {
    const cwd = project('upsert');
    const a = bean(['add', 'Retry-safe outcome', '--key', 'retry-k', '--json'], { cwd });
    const b = bean(['add', 'Retry-safe outcome (retry)', '--key', 'retry-k', '--json'], { cwd });
    const list = bean(['list', '--json'], { cwd });
    const n = (list.tasks || list).filter((t) => t.upsert_key === 'retry-k').length;
    return result(a.id === b.id && n === 1, `ids ${a.id === b.id ? 'match' : 'differ'}, ${n} row(s)`);
  },
  runtime_cross_worktree_identity: ({ bean, git, sb }) => {
    const repo = join(sb.dirs.root, 'worktree-repo');
    const wt = join(sb.dirs.root, 'worktree-repo-b');
    git(['init', '-q', repo], sb.dirs.root);
    git(['-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], repo);
    git(['worktree', 'add', '-q', '-b', 'continue', wt], repo);
    bean(['add', 'Ship worktree outcome', '--key', 'wt-k', '--json'], { cwd: repo });
    bean(['add', 'Ship worktree outcome', '--key', 'wt-k', '--json'], { cwd: wt });
    const list = bean(['list', '--all', '--json'], { cwd: repo });
    const n = (list.tasks || list).filter((t) => t.upsert_key === 'wt-k').length;
    return result(n === 1, `${n} unit(s) for one outcome across two worktrees`);
  },
  runtime_done_requires_evidence: ({ bean, project }) => {
    const cwd = project('done-evidence');
    const t = bean(['add', 'Outcome without evidence', '--json'], { cwd });
    const d = bean(['done', t.id, '--json'], { cwd, allowFail: true });
    const gated = d.error || d.status !== 'done' || 'evidence' in d || d.needs_review;
    return result(gated, gated ? 'done is gated on evidence' : 'done succeeded with no evidence');
  },
  runtime_commitment_link_option: ({ help }) => {
    const m = /--(commitment|planner|todo|ref|external[-\w]*)\b/.exec(help(['add']));
    return result(m, m ? `bean add has ${m[0]}` : 'bean add has no commitment reference option');
  },
  runtime_session_attribution: ({ bean, project }) => {
    const id = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
    const t = bean(['add', 'Attributed outcome', '--agent', 'copilot', '--session-id', id, '--json'], { cwd: project('attrib') });
    const ok = t.agent === 'copilot' && [id, `copilot:${id}`].includes(t.agent_session_id);
    return result(ok, `agent=${t.agent} session=${t.agent_session_id}`);
  },
  runtime_pr_evidence_option: ({ help }) => {
    const text = help(['add']) + help(['done']);
    const m = /--(pr|commit|evidence)\b/.exec(text);
    return result(m, m ? `has ${m[0]}` : 'no PR/commit evidence option on add or done');
  },
  runtime_multi_session_evidence: ({ bean, project }) => {
    const cwd = project('multi-session');
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    bean(['add', 'Multi-session outcome', '--key', 'ms-k', '--agent', 'copilot', '--session-id', a, '--json'], { cwd });
    bean(['add', 'Multi-session outcome', '--key', 'ms-k', '--agent', 'copilot', '--session-id', b, '--json'], { cwd });
    const text = JSON.stringify(bean(['list', '--json'], { cwd }));
    const both = text.includes(a) && text.includes(b);
    return result(both, both ? 'both sessions retained' : `only ${text.includes(b) ? 'the latest' : 'one'} session retained`);
  },
  runtime_interrupted_not_done: ({ bean, project }) => {
    const cwd = project('interrupted');
    const t = bean(['add', 'Interrupted outcome', '--json'], { cwd });
    bean(['start', t.id, '--json'], { cwd });
    const list = bean(['list', '--json'], { cwd });
    const row = (list.tasks || list).find((x) => x.id === t.id) || {};
    return result(row.status && row.status !== 'done', `status=${row.status}`);
  },
  runtime_report_outcomes: async ({ invoke }) => {
    const rep = await invoke('generate_report', { period: 'all' });
    return result(Array.isArray(rep.outcomes), `report keys: ${Object.keys(rep).join(', ')}`);
  },
  runtime_report_item_evidence: async ({ invoke }) => {
    const rep = await invoke('generate_report', { period: 'all' });
    const items = rep.outcomes || rep.tasks || [];
    const ok = items.length > 0 && items.every((i) => Array.isArray(i.evidence));
    return result(ok, ok ? 'items carry evidence lists' : `${items.length} item(s) without an evidence list`);
  },
  runtime_block_reason_option: ({ help }) => {
    const m = /--(reason|hitl|waiting-on)\b/.exec(help(['block']));
    return result(m, m ? `bean block has ${m[0]}` : 'bean block takes no reason/HITL state');
  },
  runtime_report_usage: async ({ invoke }) => {
    const rep = await invoke('generate_report', { period: 'all' });
    return result('usage' in rep, 'usage' in rep ? 'report has usage' : 'no usage section');
  },
  runtime_schema_no_raw_content: ({ bean, project, sb }) => {
    bean(['add', 'Schema probe', '--json'], { cwd: project('schema') });
    const db = new DatabaseSync(sb.env.TASKBEAN_DB, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      const bad = [];
      for (const t of tables) {
        for (const c of db.prepare(`PRAGMA table_info("${t}")`).all()) {
          if (/^(prompt|response|raw_\w+|tool_output|transcript|message_body|assistant_content|user_content)$/i.test(c.name)) bad.push(`${t}.${c.name}`);
        }
      }
      return result(bad.length === 0, bad.length ? `raw columns: ${bad.join(', ')}` : `${tables.length} tables, no raw-content columns`);
    } finally {
      db.close();
    }
  },
  runtime_env_secret_not_stored: ({ bean, project, sb }) => {
    const secret = 'tbevalsecret_9f8e7d6c5b4a';
    const extra = { GH_TOKEN: secret, GITHUB_TOKEN: secret, OPENAI_API_KEY: secret };
    bean(['add', 'Secret env probe', '--json'], { cwd: project('secret'), env: extra });
    const found = ['', '-wal', '-shm'].some((s) => existsSync(sb.env.TASKBEAN_DB + s) && readFileSync(sb.env.TASKBEAN_DB + s).includes(secret));
    return result(!found, found ? 'credential value found in database' : 'no credential value in database');
  },
  runtime_error_redaction: async ({ invoke, sb }) => {
    const saved = { entry: process.env.TASKBEAN_CLI_ENTRY, mode: process.env.FAKE_BEAN_MODE };
    process.env.TASKBEAN_CLI_ENTRY = fakeCli;
    process.env.FAKE_BEAN_MODE = 'crash';
    try {
      const { error } = await rejection(invoke('add_task', { title: 'Redaction probe' }));
      const msg = String(error?.message || '');
      return result(error && !msg.includes(sb.dirs.home), error ? `code=${error.code}` : 'no error raised');
    } finally {
      process.env.TASKBEAN_CLI_ENTRY = saved.entry;
      if (saved.mode === undefined) delete process.env.FAKE_BEAN_MODE;
      else process.env.FAKE_BEAN_MODE = saved.mode;
    }
  },
  runtime_availability_versions: async ({ invoke }) => {
    const a = await invoke('get_availability', {});
    const keys = Object.keys(a).filter((k) => /version|compat/i.test(k));
    return result(keys.length >= 2, keys.length ? `version keys: ${keys.join(', ')}` : 'no version or compatibility fields');
  },
  runtime_old_cli_skew_error: async ({ invoke, sb }) => {
    const old = join(sb.dirs.tmp, 'old-cli.mjs');
    writeFileSync(old, [
      "const a = process.argv.slice(2);",
      "if (a.includes('--version') || a.includes('-V')) { console.log('0.5.2'); process.exit(0); }",
      "console.log(JSON.stringify({ id: 'old-cli-id', title: a[1] || 'x', status: 'pending', completed: 0 }));",
    ].join('\n'));
    const saved = process.env.TASKBEAN_CLI_ENTRY;
    process.env.TASKBEAN_CLI_ENTRY = old;
    try {
      const avail = await rejection(invoke('get_availability', {}));
      const add = await rejection(invoke('add_task', { title: 'Skew probe' }));
      const errs = [avail.error, add.error].filter(Boolean);
      const flagged = errs.some((e) => /version|skew/i.test(`${e.code} ${e.message}`)) || avail.value?.compatible === false;
      return result(flagged, flagged ? 'skew reported' : 'CLI 0.5.2 accepted silently');
    } finally {
      process.env.TASKBEAN_CLI_ENTRY = saved;
    }
  },
};
