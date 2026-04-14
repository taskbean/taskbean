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

});
