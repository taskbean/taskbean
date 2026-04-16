import { test, expect } from '@playwright/test';

test.describe('taskbean — Status Bar', () => {

  test.describe('Status Bar — Offline/Online Transitions', () => {
    test('status bar shows Ready when server is reachable', async ({ page }) => {
      await page.goto('/');
      // Wait for initial load and health checks
      await page.waitForTimeout(2000);
      const statusText = await page.locator('#statusText').textContent();
      // Should be "Ready" or contain model info, not "Offline mode"
      expect(statusText).not.toContain('Offline');
    });

    test('Foundry chip shows ok state when server is up', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(2000);
      const dot = page.locator('#foundryDot');
      const label = page.locator('#foundryLabel');
      await expect(label).not.toHaveText('Offline');
      await expect(dot).toHaveClass(/ok/);
    });

    test('offline banner hidden when server is reachable', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(2000);
      const banner = page.locator('#offlineBanner');
      await expect(banner).not.toHaveClass(/show/);
    });

    test('simulated offline shows offline UI, recovery restores it', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      // Force offline state via JS
      await page.evaluate(() => {
        window.serverReachable = false;
        window.lastSuccessfulSyncAt = 0;
        window.setReachability(false);
      });
      await page.waitForTimeout(100);

      const banner = page.locator('#offlineBanner');
      await expect(banner).toHaveClass(/show/);
      const label = page.locator('#foundryLabel');
      await expect(label).toHaveText('Offline');

      // Recover
      await page.evaluate(() => {
        window.setReachability(true);
      });
      await page.waitForTimeout(100);

      await expect(banner).not.toHaveClass(/show/);
      await expect(label).toHaveText('Foundry');
      const statusText = await page.locator('#statusText').textContent();
      expect(statusText).not.toContain('Offline');
    });
  });

  test.describe('Status Bar — Details', () => {
    test('offline mode shows specific text', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);
      await page.evaluate(() => {
        window.lastSuccessfulSyncAt = 0;
        window.setReachability(false);
      });
      await page.waitForTimeout(200);
      const statusText = await page.locator('#statusText').textContent();
      expect(statusText).toContain('Offline');
      expect(statusText).toContain('cached data');
      // Restore
      await page.evaluate(() => window.setReachability(true));
    });

    test('hardware stats are visible in status bar', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(2000);
      const hasHwStats = await page.evaluate(() => {
        const bar = document.querySelector('.status-bar');
        return bar?.textContent?.includes('%') || bar?.textContent?.includes('GB');
      });
      expect(hasHwStats).toBe(true);
    });

    test('model name visible in status bar', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(2000);
      const hasModel = await page.evaluate(() => {
        const bar = document.querySelector('.status-bar');
        return bar?.textContent?.includes('qwen') || bar?.textContent?.includes('phi') || bar?.textContent?.includes('cpu');
      });
      expect(hasModel).toBe(true);
    });
  });

  test.describe('Status Bar — Responsive collapse (container queries)', () => {
    test('labels are visible at wide width and hidden at narrow width', async ({ page }) => {
      await page.setViewportSize({ width: 1400, height: 800 });
      await page.goto('/');
      await page.waitForTimeout(1500);
      // Wide: Foundry label visible.
      await expect(page.locator('#foundryLabel')).toBeVisible();

      // Narrow: Foundry label hidden (via container query, still in DOM).
      await page.setViewportSize({ width: 700, height: 800 });
      await page.waitForTimeout(300);
      const foundryDisplay = await page.locator('#foundryLabel').evaluate(el => getComputedStyle(el).display);
      expect(foundryDisplay).toBe('none');
    });

    test('hardware + model chips drop below 640px container width', async ({ page }) => {
      await page.setViewportSize({ width: 600, height: 800 });
      await page.goto('/');
      await page.waitForTimeout(1500);
      for (const id of ['#chipCpu', '#chipRam', '#chipModel']) {
        const d = await page.locator(id).evaluate(el => getComputedStyle(el).display);
        expect(d, `${id} should be hidden at 600px`).toBe('none');
      }
    });

    test('theme + nerd drop below 480px; clock survives', async ({ page }) => {
      await page.setViewportSize({ width: 440, height: 800 });
      await page.goto('/');
      await page.waitForTimeout(1500);
      const themeDisp = await page.locator('#themeChip').evaluate(el => getComputedStyle(el).display);
      const nerdDisp  = await page.locator('#statusLeftArea').evaluate(el => getComputedStyle(el).display);
      expect(themeDisp).toBe('none');
      expect(nerdDisp).toBe('none');
      await expect(page.locator('#chipClock')).toBeVisible();
    });
  });

  test.describe('Status Bar — Accessibility contract', () => {
    test('status bar has role=status and aria-label', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#statusBar')).toHaveAttribute('role', 'status');
      await expect(page.locator('#statusBar')).toHaveAttribute('aria-label', /status bar/i);
    });

    test('clock chip aria-expanded toggles with popover', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);
      const clock = page.locator('#chipClock');
      await expect(clock).toHaveAttribute('aria-expanded', 'false');
      await clock.click();
      await page.waitForTimeout(200);
      await expect(clock).toHaveAttribute('aria-expanded', 'true');
      // Close it via direct fn to avoid outside-click timing flake.
      await page.evaluate(() => window.closeClockPopover?.());
      await page.waitForTimeout(150);
      await expect(clock).toHaveAttribute('aria-expanded', 'false');
    });

    test('nerd toggle aria-pressed toggles with nerd mode', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);
      const nerd = page.locator('#statusLeftArea');
      const before = await nerd.getAttribute('aria-pressed');
      await page.evaluate(() => window.toggleNerdMode?.());
      await page.waitForTimeout(150);
      const after = await nerd.getAttribute('aria-pressed');
      expect(before).not.toBe(after);
      // Restore.
      await page.evaluate(() => window.toggleNerdMode?.());
    });
  });

  test.describe('Status Bar — Preferences', () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.removeItem('taskbean-statusbar-visible');
        localStorage.removeItem('taskbean-statusbar-items');
      });
    });

    test('toggling CPU off persists across reload', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);
      await page.evaluate(() => window.toggleStatusBarItem?.('cpu'));
      await page.waitForTimeout(150);
      let cpuDisp = await page.locator('#chipCpu').evaluate(el => getComputedStyle(el).display);
      expect(cpuDisp).toBe('none');
      await page.reload();
      await page.waitForTimeout(1500);
      cpuDisp = await page.locator('#chipCpu').evaluate(el => getComputedStyle(el).display);
      expect(cpuDisp).toBe('none');
    });

    test('master hide removes the bar and persists', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);
      await page.evaluate(() => window.setStatusBarVisible?.(false));
      await expect(page.locator('#statusBar')).toBeHidden();
      await page.reload();
      await page.waitForTimeout(1500);
      await expect(page.locator('#statusBar')).toBeHidden();
      // Restore for subsequent tests.
      await page.evaluate(() => window.resetStatusBarPrefs?.());
    });

    test('right-click opens quick-toggle popover', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);
      await page.locator('#statusBar').click({ button: 'right' });
      await page.waitForTimeout(200);
      await expect(page.locator('#statusBarPopover')).toBeVisible();
      // Contains a row per default item.
      const rowCount = await page.locator('#statusBarItemsList [role="menuitemcheckbox"]').count();
      expect(rowCount).toBe(7);
    });
  });

});
