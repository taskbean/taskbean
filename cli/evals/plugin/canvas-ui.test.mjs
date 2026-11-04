import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { findBrowser, launchBrowser } from './support/cdp.mjs';
import { CONTEXT, cliEntry, cliRoot, createSandbox, extensionDir, installFakeLauncher, loadExtension, useEnv } from './support/harness.mjs';

const browserPath = findBrowser();
const browserEnv = { ...process.env };
const screenshotDir = process.env.TASKBEAN_EVAL_SCREENSHOT_DIR || '';
const skip = browserPath ? false : 'no Edge or Chrome executable found (set TASKBEAN_EVAL_BROWSER)';

const sandbox = createSandbox('canvas-ui');
useEnv({ ...sandbox.env, TASKBEAN_CLI_ENTRY: cliEntry });
process.chdir(sandbox.dirs.project);

const calls = installFakeLauncher();
const { canvas, invoke } = await loadExtension();
const { runBean } = await import(pathToFileURL(join(extensionDir, 'bean-runner.mjs')).href);

const RESUME_SESSION = '4e0f6a52-1c3b-4d5e-8f90-a1b2c3d4e5f6';
const BLOCKED_SESSION = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const add = async (...args) => JSON.parse(await runBean(['add', ...args, '--json']));
const ledger = async () => JSON.parse(await runBean(['list', '--all', '--json']));

const ids = {};
let browser;
let url;

before(async () => {
  if (skip) return;
  ids.pending = (await add('Draft the plugin release notes')).id;
  ids.resume = (await add('Wire canvas deeplinks through open_link', '--agent', 'copilot', '--session-id', RESUME_SESSION)).id;
  await runBean(['start', ids.resume, '--json']);
  ids.blocked = (await add('Waiting on host protocol approval before the real click test can run in the app', '--agent', 'copilot', '--session-id', BLOCKED_SESSION)).id;
  await runBean(['block', ids.blocked, '--json']);
  // Groups that need attention hide done rows, so the done task gets its own project group.
  const archive = join(sandbox.dirs.project, 'archive');
  mkdirSync(archive, { recursive: true });
  ids.done = (await add('Archive the old copy-link buttons', '--project', archive)).id;
  await runBean(['done', ids.done, '--json']);
  ({ url } = await canvas.open({ ...CONTEXT, input: {} }));
  browser = await launchBrowser(browserPath, { env: browserEnv });
});

after(async () => {
  await browser?.close();
  if (url) await canvas.onClose({ ...CONTEXT });
  delete globalThis[Symbol.for('taskbean.dashboard.linkLauncher')];
  process.chdir(cliRoot);
  sandbox.cleanup();
});

const rowExpr = (id) => `document.getElementById(${JSON.stringify(`detail-${id}`)}).closest('article')`;
const expandAll = 'document.querySelectorAll("details.outcome").forEach(d => d.open = true); true';

async function load(width, dark = false) {
  await browser.viewport(width, 1200, dark);
  await browser.goto(url);
  await browser.evaluate(expandAll);
}

async function inspectRow(id) {
  return browser.evaluate(`(() => {
    const row = ${rowExpr(id)};
    const p = row.querySelector('.rowactions > .row-primary');
    const menu = row.querySelector('.action-menu');
    return {
      primary: p ? { text: p.textContent.trim(), open: p.dataset.openLink || null, action: p.dataset.action || null, aria: p.getAttribute('aria-label') } : null,
      menu: menu ? [...menu.querySelectorAll('[role=menuitem]')].map((b) => b.textContent.trim()) : null,
      disclosure: !!row.querySelector(':scope > button.disclosure[data-disclosure][aria-controls]'),
    };
  })()`);
}

test('rows render one real primary and a non-duplicate menu', { skip }, async () => {
  await load(760);
  assert.deepEqual(browser.errors, [], 'the canvas script runs without exceptions');

  const pending = await inspectRow(ids.pending);
  assert.equal(pending.primary.text, 'Start');
  assert.equal(pending.primary.action, 'start_task');
  assert.ok(!pending.menu.includes('Mark in progress'));

  const resume = await inspectRow(ids.resume);
  assert.equal(resume.primary.text, 'Resume');
  assert.equal(resume.primary.open, 'session');
  assert.match(resume.primary.aria, /^Resume in Copilot session/);
  assert.deepEqual(resume.menu, ['Mark blocked', 'Mark done', 'Copy task ID']);

  const blocked = await inspectRow(ids.blocked);
  assert.equal(blocked.primary.text, 'Review blocker');
  assert.equal(blocked.primary.open, 'session');
  assert.ok(!blocked.menu.includes('Mark blocked'));

  const done = await inspectRow(ids.done);
  assert.equal(done.primary, null, 'no placeholder primary');
  assert.equal(done.menu, null, 'no menu trigger when the menu is empty');

  for (const row of [pending, resume, blocked, done]) assert.ok(row.disclosure, 'every row has a left disclosure');
  const noDetails = await browser.evaluate('document.querySelectorAll("[data-primary=details], button[data-action=details]").length');
  assert.equal(noDetails, 0);
});

test('the chevron toggles the details panel with aria-expanded', { skip }, async () => {
  const state = () => browser.evaluate(`(() => { const b = ${rowExpr(ids.done)}.querySelector('button.disclosure'); const d = document.getElementById(b.getAttribute('aria-controls')); return { expanded: b.getAttribute('aria-expanded'), hidden: d.hidden, label: b.getAttribute('aria-label'), text: d.textContent }; })()`);
  assert.deepEqual((await state()).expanded, 'false');
  assert.equal((await state()).hidden, true);
  await browser.evaluate(`${rowExpr(ids.done)}.querySelector('button.disclosure').click(); true`);
  const open = await state();
  assert.equal(open.expanded, 'true');
  assert.equal(open.hidden, false);
  assert.match(open.label, /^Hide details for /);
  assert.match(open.text, /\S/);
  await browser.evaluate(`(() => { const b = ${rowExpr(ids.done)}.querySelector('button.disclosure'); b.focus(); return true; })()`);
  await browser.key('Enter', 'Enter', 13);
  assert.equal((await state()).hidden, true, 'Enter on the focused chevron collapses the details');
});

test('the menu opens from the keyboard, focuses the first item and closes on Escape', { skip }, async () => {
  await browser.evaluate(`${rowExpr(ids.resume)}.querySelector('.action-menu > summary').focus(); true`);
  await browser.key('Enter', 'Enter', 13);
  await new Promise((r) => setTimeout(r, 100));
  const opened = await browser.evaluate(`(() => { const m = ${rowExpr(ids.resume)}.querySelector('.action-menu'); return { open: m.open, focused: document.activeElement.textContent.trim() }; })()`);
  assert.deepEqual(opened, { open: true, focused: 'Mark blocked' });
  await browser.key('End', 'End', 35);
  assert.equal(await browser.evaluate('document.activeElement.textContent.trim()'), 'Copy task ID');
  await browser.key('Escape', 'Escape', 27);
  const closed = await browser.evaluate(`(() => { const m = ${rowExpr(ids.resume)}.querySelector('.action-menu'); return { open: m.open, summary: document.activeElement === m.querySelector('summary') }; })()`);
  assert.deepEqual(closed, { open: false, summary: true });
});

test('Resume and Review blocker open the trusted session and never change tasks', { skip }, async () => {
  const before = await ledger();
  calls.length = 0;
  for (const [id, session] of [[ids.resume, RESUME_SESSION], [ids.blocked, BLOCKED_SESSION]]) {
    await browser.evaluate(`${rowExpr(id)}.querySelector('.row-primary').click(); true`);
    let text = '';
    for (let i = 0; i < 40 && !/unchanged|could not|not/i.test(text); i++) {
      await new Promise((r) => setTimeout(r, 100));
      text = await browser.evaluate(`${rowExpr(id)}.querySelector('.row-feedback').textContent`);
    }
    assert.equal(text, 'Link launcher started. Confirm the session opened in the Copilot app. Task status unchanged.');
    assert.deepEqual(calls.at(-1).args, [`ghapp://sessions/${session}`]);
    assert.equal(calls.at(-1).options.shell, false);
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(await ledger(), before, 'opening sessions does not mutate the ledger');
});

test('a failed launch shows an inline error in the row', { skip }, async () => {
  const launcher = globalThis[Symbol.for('taskbean.dashboard.linkLauncher')];
  const saved = launcher.hasHandler;
  launcher.hasHandler = async () => false;
  try {
    await browser.evaluate(`${rowExpr(ids.resume)}.querySelector('.row-primary').click(); true`);
    let fb = {};
    for (let i = 0; i < 40 && fb.kind !== 'error'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      fb = await browser.evaluate(`(() => { const f = ${rowExpr(ids.resume)}.querySelector('.row-feedback'); const c = f.querySelector('button[data-copy-session]'); const d = document.getElementById(${JSON.stringify(`detail-${ids.resume}`)}); return { kind: f.dataset.kind, role: f.getAttribute('role'), text: f.textContent, copy: c ? c.dataset.copySession : null, detailsHidden: d.hidden }; })()`);
    }
    assert.equal(fb.kind, 'error');
    assert.match(fb.text, /not registered for ghapp/);
    assert.equal(fb.role, 'alert');
    assert.equal(fb.copy, RESUME_SESSION, 'the error offers a Copy session ID fallback');
    assert.equal(fb.detailsHidden, true, 'a failed open never expands details instead');
  } finally {
    launcher.hasHandler = saved;
  }
});

test('suggested evidence renders as not accepted and observe never changes tasks', { skip }, async () => {
  await load(760);
  const panel = await browser.evaluate(`(() => {
    const h = document.getElementById('suggestionsHead');
    const s = h && h.closest('section');
    const b = document.getElementById('observe');
    return { heading: h ? h.textContent.trim() : null, text: s ? s.textContent : '', button: b ? b.textContent.trim() : null, approve: s ? [...s.querySelectorAll('button')].filter((x) => /approve|accept|link/i.test(x.textContent)).length : -1 };
  })()`);
  assert.equal(panel.heading, 'Suggested evidence');
  assert.match(panel.text, /Not accepted outcomes/);
  assert.equal(panel.button, 'Collect evidence (observe only)');
  assert.equal(panel.approve, 0, 'the canvas never accepts or links suggestions');

  const before = await ledger();
  await browser.evaluate(`document.getElementById('observe').click(); true`);
  let fb = {};
  for (let i = 0; i < 80 && !/No tasks changed/.test(fb.text || ''); i++) {
    await new Promise((r) => setTimeout(r, 100));
    fb = await browser.evaluate(`(() => { const f = document.getElementById('observeFeedback'); return f ? { text: f.textContent, kind: f.dataset.kind } : {}; })()`);
  }
  assert.match(fb.text, /No tasks changed/);
  assert.deepEqual(await ledger(), before);
  assert.deepEqual(browser.errors, []);
});

async function hoverColors(selector) {
  const box = await browser.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await new Promise((r) => setTimeout(r, 50));
  const c = await browser.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); const s = getComputedStyle(b); return { hover: b.matches(':hover'), fg: s.color, bg: s.backgroundColor }; })()`);
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  return c;
}

function contrast(a, b) {
  const lum = (c) => { const [r, g, bl] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

test('primary buttons keep their fill and contrast on hover in light and dark', { skip }, async () => {
  for (const dark of [false, true]) {
    await load(560, dark);
    for (const selector of ['#refresh', '.row-primary.start', '.row-primary.nav']) {
      const c = await hoverColors(selector);
      assert.ok(c.hover, `${selector} is hovered`);
      assert.ok(contrast(c.fg, c.bg) >= 4.495, `${selector} hover contrast ${contrast(c.fg, c.bg).toFixed(2)} in ${dark ? 'dark' : 'light'} (${c.fg} on ${c.bg})`);
    }
  }
});

test('narrow and dark layouts do not clip rows and keep accessible names', { skip }, async () => {
  const shots = [];
  let rendered = '';
  for (const [width, dark] of [[560, false], [560, true], [360, false], [360, true]]) {
    await load(width, dark);
    if (!dark) await browser.evaluate(`(() => { ${rowExpr(ids.blocked)}.querySelector('button.disclosure').click(); ${rowExpr(ids.resume)}.querySelector('.action-menu').open = true; return true; })()`);
    const layout = await browser.evaluate(`(() => {
      const doc = document.documentElement;
      const rows = [...document.querySelectorAll('.taskrow')].filter((r) => r.offsetParent);
      const clipped = rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length;
      const unnamed = [...document.querySelectorAll('.row-primary, .disclosure, .action-menu > summary')].filter((b) => !(b.getAttribute('aria-label') || b.textContent.trim())).length;
      return { overflow: doc.scrollWidth - doc.clientWidth, clipped, unnamed, rows: rows.length };
    })()`);
    assert.ok(layout.rows >= 4, `${width}px shows the seeded rows`);
    assert.ok(layout.overflow <= 0, `${width}px has no horizontal page overflow (${layout.overflow}px)`);
    assert.equal(layout.clipped, 0, `${width}px rows are not clipped`);
    assert.equal(layout.unnamed, 0, 'every control has an accessible name');
    shots.push([`${width}-${dark ? 'dark' : 'light'}`, await browser.screenshot()]);
    if (screenshotDir && width === 560 && !dark) rendered = (await browser.evaluate('"<!doctype html>" + document.documentElement.outerHTML')).replaceAll(new URL(url).searchParams.get('token'), 'REDACTED_CANVAS_TOKEN');
  }
  assert.deepEqual(browser.errors, []);
  if (screenshotDir) {
    mkdirSync(screenshotDir, { recursive: true });
    for (const [name, png] of shots) writeFileSync(join(screenshotDir, `taskbean-dashboard-rows-${name}.png`), png);
    // Rendered DOM for static design detectors, which cannot parse HTML inside the JS template.
    if (rendered) writeFileSync(join(screenshotDir, 'taskbean-dashboard-rendered.html'), rendered);
  }
});

test('action menus stay readable inside 320 and 360 px viewports', { skip }, async () => {
  for (const width of [320, 360]) {
    await load(width);
    await browser.evaluate(`${rowExpr(ids.resume)}.querySelector('.action-menu').open = true; true`);
    const menu = await browser.evaluate(`(() => {
      const m = ${rowExpr(ids.resume)}.querySelector('.menu');
      const rect = m.getBoundingClientRect();
      return { width: rect.width, left: rect.left, right: rect.right,
        items: [...m.querySelectorAll('[role=menuitem]')].map(b => ({
          text: b.textContent.trim(), height: b.getBoundingClientRect().height,
          overflow: b.scrollWidth - b.clientWidth
        })) };
    })()`);
    assert.ok(menu.width >= 220, `${width}px menu is comfortably wide (${menu.width}px)`);
    assert.ok(menu.left >= 0 && menu.right <= width, `${width}px menu fits the viewport`);
    assert.ok(menu.items.some(b => b.text === 'Mark blocked'));
    for (const item of menu.items) {
      assert.ok(item.height <= 32, `${item.text} stays on one line at ${width}px`);
      assert.ok(item.overflow <= 1, `${item.text} is not clipped at ${width}px`);
    }
  }
});

test('PR feedback reports only a started launcher and targets validated HTTPS', { skip }, async () => {
  const task = await add('Review the plugin PR');
  const edited = JSON.parse(await runBean(['edit', task.id, '--notes', 'https://github.com/octocat/hello-world/pull/42', '--tags', 'review-required', '--json']));
  assert.match(edited.notes, /github\.com/);
  const pr = (await invoke('get_dashboard', { period: 'all' })).tasks.find((t) => t.id === task.id);
  assert.equal(pr.pullRequest?.href, 'https://github.com/octocat/hello-world/pull/42', JSON.stringify({ notes: pr.notes, tags: pr.tags }));
  await load(760);
  const before = await ledger();
  calls.length = 0;
  const row = await inspectRow(task.id);
  assert.equal(row.primary?.open, 'pull_request', `the PR is a primary action: ${JSON.stringify(row)}`);
  await browser.evaluate(`${rowExpr(task.id)}.querySelector('[data-open-link="pull_request"]').click(); true`);
  let text = '';
  for (let i = 0; i < 40 && !text.includes('Task status unchanged'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    text = await browser.evaluate(`${rowExpr(task.id)}.querySelector('.row-feedback').textContent`);
  }
  assert.equal(text, 'Link launcher started. Confirm the pull request opened in your browser. Task status unchanged.');
  assert.deepEqual(calls.map((call) => call.args), [['https://github.com/octocat/hello-world/pull/42']]);
  assert.deepEqual(await ledger(), before);
});

test('a cross-site host can embed the canvas, but its own form and preflight cannot mutate tasks', { skip }, async () => {
  let hostRequests = 0;
  const host = createServer((req, res) => {
    hostRequests++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><iframe sandbox="allow-scripts allow-same-origin allow-forms" src="${url}"></iframe>`);
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  try {
    const navigation = await browser.send('Page.navigate', { url: `http://localhost:${host.address().port}/` });
    let iframeSession;
    let targets;
    for (let i = 0; i < 80 && !iframeSession; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      targets = (await browser.send('Target.getTargets')).result.targetInfos;
      const frame = targets.find((t) => t.type === 'iframe' && t.url.startsWith(new URL(url).origin));
      if (frame) iframeSession = (await browser.send('Target.attachToTarget', { targetId: frame.targetId, flatten: true })).result?.sessionId;
    }
    const targetOrigins = targets.map((t) => {
      try { return `${t.type}:${new URL(t.url).origin}`; } catch { return t.type; }
    });
    assert.ok(iframeSession, `the cross-site canvas iframe loaded (host requests: ${hostRequests}, navigation: ${navigation.result?.errorText || 'ok'}, targets: ${targetOrigins})`);
    await browser.send('Runtime.enable', {}, iframeSession);
    const inFrame = async (expression) => {
      const result = await browser.send('Runtime.evaluate', { expression, returnByValue: true }, iframeSession);
      if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text);
      return result.result?.result?.value;
    };
    let state;
    for (let i = 0; i < 80; i++) {
      state = await inFrame(`({
        ready: !!document.querySelector('#content .taskrow, #content .empty'),
        error: document.getElementById('errorMessage')?.textContent || ''
      })`);
      if (state.ready || state.error) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(state.error, '', 'the embedded canvas may load its dashboard');
    assert.equal(state.ready, true, 'the embedded canvas renders its dashboard');
    await inFrame(`document.getElementById('newTitle').value = 'Cross-site iframe test outcome';
      document.querySelector('#addForm button').click(); true`);
    let task;
    for (let i = 0; i < 40 && !task; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      task = (await ledger()).find((t) => t.title === 'Cross-site iframe test outcome');
    }
    assert.ok(task, 'a legitimate iframe action reaches the isolated ledger');
    assert.equal((await inFrame("document.getElementById('errorMessage').textContent")), '');

    const before = await ledger();
    const launchesBefore = calls.length;
    const attacks = await browser.evaluate(`(async () => {
      const endpoint = ${JSON.stringify(new URL('/api/action', url).href)};
      const token = ${JSON.stringify(new URL(url).searchParams.get('token'))};
      const sink = document.createElement('iframe');
      sink.name = 'attack-sink';
      sink.src = 'about:blank';
      document.body.appendChild(sink);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const form = document.createElement('form');
      form.action = endpoint;
      form.method = 'POST';
      form.enctype = 'text/plain';
      form.target = sink.name;
      const field = document.createElement('input');
      field.name = '{"action":"add_task","input":{"title":"Cross-site form attack","padding":"';
      field.value = '"}}';
      form.appendChild(field);
      document.body.appendChild(form);
      const formLoaded = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000);
        sink.onload = () => { clearTimeout(timer); resolve(true); };
      });
      form.submit();
      const submitted = await formLoaded;
      let preflightBlocked = false;
      try {
        await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Taskbean-Token': token },
          body: JSON.stringify({ action: 'add_task', input: { title: 'Cross-site preflight attack' } }) });
      } catch {
        preflightBlocked = true;
      }
      return { submitted, preflightBlocked };
    })()`);
    assert.equal(attacks.submitted, true, 'the browser sent the cross-site simple form');
    assert.equal(attacks.preflightBlocked, true, 'the browser blocks the cross-site JSON request at preflight');
    assert.deepEqual(await ledger(), before, 'neither browser attack changes the isolated ledger');
    assert.equal(calls.length, launchesBefore);
  } finally {
    await new Promise((resolve, reject) => host.close((error) => error ? reject(error) : resolve()));
  }
});
