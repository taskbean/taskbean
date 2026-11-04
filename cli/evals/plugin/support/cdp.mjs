import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = {
  win32: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ],
  darwin: [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ],
  linux: ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

export function findBrowser(env = process.env) {
  if (env.TASKBEAN_EVAL_BROWSER && existsSync(env.TASKBEAN_EVAL_BROWSER)) return env.TASKBEAN_EVAL_BROWSER;
  return (CANDIDATES[process.platform] || CANDIDATES.linux).find((p) => existsSync(p)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal Chrome DevTools Protocol client for headless UI checks.
export async function launchBrowser(executable, { port = 9300 + Math.floor(Math.random() * 500), env } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'taskbean-cdp-'));
  const proc = spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: 'ignore', env });
  let targets = [];
  for (let i = 0; i < 75 && !targets.some((t) => t.type === 'page'); i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { /* starting */ }
    if (!targets.some((t) => t.type === 'page')) await sleep(200);
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) { proc.kill(); throw new Error('browser did not expose a page target'); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  let next = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    else if (msg.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve) => { const id = ++next; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  await send('Runtime.enable');
  await send('Page.enable');

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  return {
    send,
    evaluate,
    errors,
    async viewport(width, height = 1100, dark = false) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    },
    async goto(url) {
      await send('Page.navigate', { url });
      for (let i = 0; i < 80; i++) {
        await sleep(250);
        const state = await evaluate('document.readyState === "complete" && !document.querySelector("#content .loading") && !!document.querySelector("#content .taskrow, #content .empty")');
        if (state) return;
      }
      const content = await evaluate('(document.querySelector("#errorMessage")?.textContent || "") + " | " + (document.querySelector("#content")?.textContent?.slice(0, 200) || "")').catch(() => '');
      throw new Error(`dashboard did not finish loading${errors.length ? `; page errors: ${errors.join(' | ')}` : ''}; content: ${content}`);
    },
    async key(key, code = key, keyCode = 0) {
      const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined;
      await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, ...(text ? { text, unmodifiedText: text } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    },
    async screenshot() {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      return Buffer.from(r.result.data, 'base64');
    },
    async close() {
      try { ws.close(); } catch { /* closed */ }
      proc.kill();
      await sleep(400);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser still releasing files */ }
    },
  };
}
