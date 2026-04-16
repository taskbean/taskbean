import { test, expect } from '@playwright/test';

// Covers the Projects-first reflow:
//   R1  — Projects is the default-active tab.
//   R2  — The left panel is resizable via pointer + keyboard with persistence.
//   R3  — Collapsing the nav rail widens the left panel on wide viewports.
test.describe('left-panel reflow', () => {

  test.beforeEach(async ({ page, context }) => {
    // Fresh test: clear saved panel width once before first navigation.
    await context.addInitScript(() => {
      if (!sessionStorage.getItem('__panel_resize_test_cleared')) {
        try { localStorage.removeItem('taskbean.leftPanelW'); } catch {}
        sessionStorage.setItem('__panel_resize_test_cleared', '1');
      }
    });
  });

  test('Projects is default-active tab', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#tabProjects')).toHaveClass(/active/);
    await expect(page.locator('#tabContentProjects')).toHaveClass(/active/);
  });

  test('resize handle is keyboard-operable and persists width', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const panel = page.locator('.left-panel');
    await expect(panel).toBeVisible();

    const handle = page.locator('#panelResizer');
    await handle.waitFor();
    // Wait until the resizer IIFE has actually attached its keydown listener.
    await page.waitForFunction(() => {
      const h = document.getElementById('panelResizer');
      return !!h && h.getAttribute('aria-valuenow');
    });

    const widthBefore = await panel.evaluate(el => el.getBoundingClientRect().width);

    // Dispatch keydowns directly on the handle to guarantee the listener fires
    // regardless of which element has focus in the test harness.
    await handle.evaluate((el) => {
      for (let i = 0; i < 3; i++) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      }
    });

    const widthAfter = await panel.evaluate(el => el.getBoundingClientRect().width);
    expect(Math.round(widthAfter - widthBefore)).toBe(48);

    // Reload and confirm persistence.
    await page.reload();
    const widthRestored = await page.locator('.left-panel').evaluate(el => el.getBoundingClientRect().width);
    expect(Math.round(widthRestored)).toBe(Math.round(widthAfter));
  });

  test('pointer drag clamps within min/max', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const handle = page.locator('#panelResizer');
    await handle.waitFor();
    await page.waitForFunction(() => !!document.getElementById('panelResizer')?.getAttribute('aria-valuenow'));
    const box = await handle.boundingBox();
    if (!box) throw new Error('handle not visible');

    // Drag far right — should clamp to max (560).
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(1000, box.y + box.height / 2, { steps: 5 });
    await page.mouse.move(1400, box.y + box.height / 2, { steps: 5 });
    await page.mouse.move(1800, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(100);

    const w = await page.locator('.left-panel').evaluate(el => el.getBoundingClientRect().width);
    expect(Math.round(w)).toBe(560);
  });

  test('collapsing nav rail widens left panel on wide viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.locator('.left-panel').waitFor();

    // Ensure rail is expanded to start.
    await page.evaluate(() => {
      const rail = document.getElementById('navRail');
      if (rail && !rail.classList.contains('expanded')) rail.classList.add('expanded');
    });
    const before = await page.locator('.left-panel').evaluate(el => el.getBoundingClientRect().width);

    // Collapse rail via the toggle.
    await page.locator('button.nav-rail-toggle').click();
    await page.waitForTimeout(500);
    const after = await page.locator('.left-panel').evaluate(el => el.getBoundingClientRect().width);

    expect(after).toBeGreaterThan(before);
  });

  test('Tasks and Recurring share the same panel width as Projects', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.locator('#panelResizer').waitFor();
    await page.waitForFunction(() => !!document.getElementById('panelResizer')?.getAttribute('aria-valuenow'));

    const widthOf = () => page.locator('.left-panel').evaluate(el => Math.round(el.getBoundingClientRect().width));

    const wProjects = await widthOf();
    await page.locator('#tabTodos').click();
    await page.waitForTimeout(700);
    const wTodos = await widthOf();
    await page.locator('#tabRecurring').click();
    await page.waitForTimeout(700);
    const wRecurring = await widthOf();

    expect(wTodos).toBe(wProjects);
    expect(wRecurring).toBe(wProjects);
  });

  test('double-click active tab collapses rail; clicking another tab while collapsed keeps rail collapsed', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.locator('#panelResizer').waitFor();

    const rail = page.locator('#navRail');
    await expect(rail).toHaveClass(/expanded/);

    // Click-twice on active Projects → collapse.
    await page.locator('#tabProjects').click();
    await page.waitForTimeout(700);
    await expect(rail).not.toHaveClass(/expanded/);

    // Now click Tasks while collapsed → rail STAYS collapsed, tab switches.
    await page.locator('#tabTodos').click();
    await page.waitForTimeout(900);
    await expect(rail).not.toHaveClass(/expanded/);
    await expect(page.locator('#tabTodos')).toHaveClass(/active/);
    await expect(page.locator('#tabContentTodos')).toHaveClass(/active/);
  });
});
