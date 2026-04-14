import { test, expect } from '@playwright/test';

test.describe('taskbean — Service Worker', () => {

  test.describe('Service Worker Cache', () => {
    test('taskbean-only.png is precached by service worker', async ({ page }) => {
      await page.goto('/');
      // Wait for SW to install
      await page.waitForTimeout(2000);

      const cached = await page.evaluate(async () => {
        const cache = await caches.open('taskbean-v5');
        const keys = await cache.keys();
        return keys.some(r => r.url.includes('taskbean-only.png'));
      });
      expect(cached).toBe(true);
    });

    test('spinning bean image loads on startup screen', async ({ page }) => {
      await page.goto('/');
      // The bean image should be loadable
      const response = await page.request.get('/icons/taskbean-only.png');
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('image/png');
    });
  });

});
