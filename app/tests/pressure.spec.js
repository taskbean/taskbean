import { test, expect } from '@playwright/test';

test.describe('taskbean — Pressure & Edge Cases', () => {

  test.describe('Pressure & Edge Cases', () => {
    test('100 todos render without JS errors', async ({ page }) => {
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      await page.goto('/');
      // Create 100 todos via API
      await page.evaluate(async () => {
        for (let i = 0; i < 100; i++) {
          await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: `Pressure test ${i}`, emoji: '🔨' }) });
        }
      });
      await page.evaluate(() => refreshTodos());
      await page.waitForTimeout(1000);
      const count = await page.locator('.todo-item').count();
      expect(count).toBeGreaterThanOrEqual(100);
      expect(errors).toHaveLength(0);
    });

    test('XSS in suggestion chip label is escaped', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => {
        addSuggestionChips([{ label: '<img src=x onerror=alert(1)>', message: 'safe' }]);
      });
      const chip = page.locator('.suggestion-chip').last();
      const html = await chip.innerHTML();
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img');
    });

    test('very long chip label is visually truncated', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => {
        addSuggestionChips([{ label: 'A'.repeat(200), message: 'test' }]);
      });
      const chip = page.locator('.suggestion-chip').last();
      const box = await chip.boundingBox();
      // Should not be wider than the chat feed
      const feedBox = await page.locator('#chatFeed').boundingBox();
      expect(box.width).toBeLessThanOrEqual(feedBox.width);
    });
  });

});
