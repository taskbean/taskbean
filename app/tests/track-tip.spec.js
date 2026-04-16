import { test, expect } from '@playwright/test';

// Regression tests for the "Track a project" help card in the sidebar Projects tab.
// See app/public/index.html (#trackTip) and corresponding JS/CSS.

test.describe('taskbean — Track-a-project tip', () => {

  test.beforeEach(async ({ page, context }) => {
    // Grant clipboard so copy-to-clipboard assertions work.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  async function openProjectsTab(page) {
    await page.goto('/');
    await page.locator('#tabProjects').click();
    await expect(page.locator('#trackTip')).toBeVisible();
  }

  test('tip card is present with correct ARIA wiring', async ({ page }) => {
    await openProjectsTab(page);
    const tip = page.locator('#trackTip');
    const toggle = page.locator('#trackTipToggle');
    await expect(tip).toHaveAttribute('aria-labelledby', 'trackTipTitle');
    await expect(toggle).toHaveAttribute('aria-controls', 'trackTipBody');
    await expect(toggle).toHaveAttribute('aria-expanded', /true|false/);
  });

  test('toggle button opens and closes the tip body, keeping aria-expanded in sync', async ({ page }) => {
    await openProjectsTab(page);
    const toggle = page.locator('#trackTipToggle');
    const tip = page.locator('#trackTip');
    const body = page.locator('#trackTipBody');

    // Force-close first for a deterministic starting state.
    await page.evaluate(() => {
      document.getElementById('trackTip').dataset.open = 'false';
      document.getElementById('trackTipToggle').setAttribute('aria-expanded', 'false');
    });
    await expect(body).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(tip).toHaveAttribute('data-open', 'true');
    await expect(body).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(tip).toHaveAttribute('data-open', 'false');
    await expect(body).toBeHidden();
  });

  test('shows Windows PowerShell and WSL command examples with bean track', async ({ page }) => {
    await openProjectsTab(page);
    const body = page.locator('#trackTipBody');
    // Ensure it's open.
    await page.evaluate(() => {
      document.getElementById('trackTip').dataset.open = 'true';
      document.getElementById('trackTipToggle').setAttribute('aria-expanded', 'true');
    });
    await expect(body).toBeVisible();

    await expect(body).toContainText('Windows (PowerShell)');
    await expect(body).toContainText('WSL / Ubuntu');

    const cmdBlocks = body.locator('.track-tip-cmd');
    await expect(cmdBlocks).toHaveCount(3); // windows + wsl + npm install

    const winBlock = cmdBlocks.nth(0);
    await expect(winBlock).toContainText('C:\\Users\\you\\my-project');
    await expect(winBlock).toContainText('bean track');

    const wslBlock = cmdBlocks.nth(1);
    await expect(wslBlock).toContainText('cd ~/my-project');
    await expect(wslBlock).toContainText('bean track');

    await expect(body).toContainText('npm install -g taskbean');
  });

  test('copy buttons have distinct aria-labels and copy the expected payload', async ({ page }) => {
    await openProjectsTab(page);
    await page.evaluate(() => {
      document.getElementById('trackTip').dataset.open = 'true';
      document.getElementById('trackTipToggle').setAttribute('aria-expanded', 'true');
    });

    const copyBtns = page.locator('.track-tip-copy');
    await expect(copyBtns).toHaveCount(3);

    const labels = await copyBtns.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(new Set(labels).size).toBe(3);
    expect(labels).toEqual(expect.arrayContaining([
      'Copy Windows commands',
      'Copy WSL commands',
      'Copy install command',
    ]));

    await page.locator('.track-tip-copy[aria-label="Copy install command"]').click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe('npm install -g taskbean');

    // aria-live status region populated for screen readers.
    await expect(page.locator('#trackTipStatus')).toHaveText(/copied/i);

    // Windows and WSL copy buttons carry multiline payloads.
    const winPayload = await page.locator('.track-tip-copy[aria-label="Copy Windows commands"]').getAttribute('data-cmd');
    expect(winPayload).toContain('cd C:\\Users');
    expect(winPayload).toContain('bean track');
    const wslPayload = await page.locator('.track-tip-copy[aria-label="Copy WSL commands"]').getAttribute('data-cmd');
    expect(wslPayload).toContain('cd ~/my-project');
    expect(wslPayload).toContain('bean track');
  });

  test('"Other useful bean commands" disclosure uses a valid <dl> (guards against prior <ul><span> bug)', async ({ page }) => {
    await openProjectsTab(page);
    await page.evaluate(() => {
      document.getElementById('trackTip').dataset.open = 'true';
      document.getElementById('trackTipToggle').setAttribute('aria-expanded', 'true');
    });

    const details = page.locator('.track-tip-more');
    const summary = details.locator('summary');

    await expect(details).not.toHaveAttribute('open', '');
    await summary.click();
    await expect(details).toHaveAttribute('open', '');

    // <dl> with matched <dt>/<dd> pairs and zero stray children.
    const shape = await page.evaluate(() => {
      const dl = document.querySelector('.track-tip-cmds');
      if (!dl) return null;
      return {
        tag: dl.tagName,
        dts: dl.querySelectorAll(':scope > dt').length,
        dds: dl.querySelectorAll(':scope > dd').length,
        strays: dl.querySelectorAll(':scope > :not(dt):not(dd)').length,
      };
    });
    expect(shape).toEqual({ tag: 'DL', dts: 6, dds: 6, strays: 0 });

    for (const cmd of ['bean list', 'bean projects', 'bean report', 'bean serve', 'bean add', 'bean done']) {
      await expect(details).toContainText(cmd);
    }
  });

  test('WSL caveat explains the per-host database path', async ({ page }) => {
    await openProjectsTab(page);
    await page.evaluate(() => {
      document.getElementById('trackTip').dataset.open = 'true';
      document.getElementById('trackTipToggle').setAttribute('aria-expanded', 'true');
    });
    const note = page.locator('.track-tip-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText('~/.taskbean/taskbean.db');
    await expect(note).toContainText(/PowerShell/i);
    await expect(note).toContainText(/\\\\wsl\$/);
  });

  test('keyboard: toggle is focusable and activates with Enter and Space', async ({ page }) => {
    await openProjectsTab(page);
    const toggle = page.locator('#trackTipToggle');
    await page.evaluate(() => {
      document.getElementById('trackTip').dataset.open = 'false';
      document.getElementById('trackTipToggle').setAttribute('aria-expanded', 'false');
    });

    await toggle.focus();
    await expect(toggle).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('auto-opens on empty project list', async ({ page }) => {
    // Intercept /api/projects BEFORE navigation so the first render sees empty data.
    await page.route('**/api/projects', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    );

    await page.goto('/');
    await page.locator('#tabProjects').click();

    const tip = page.locator('#trackTip');
    const toggle = page.locator('#trackTipToggle');
    await expect(tip).toHaveAttribute('data-open', 'true');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.project-empty')).toContainText('No tracked projects yet');

    // User explicitly closes; subsequent renderProjects() calls must NOT reopen it.
    await toggle.click();
    await expect(tip).toHaveAttribute('data-open', 'false');

    await page.evaluate(() => window.renderProjects?.());
    // Give async render a moment; attribute should still be 'false'.
    await expect(tip).toHaveAttribute('data-open', 'false');
  });

});
