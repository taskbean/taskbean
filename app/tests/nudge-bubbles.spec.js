import { test, expect } from '@playwright/test';

test.describe('taskbean — Nudge Bubbles', () => {

  test.describe('Nudge Bubbles', () => {
    test('nudge bubble can be dismissed', async ({ page }) => {
      await page.goto('/');
      // Manually inject a nudge
      await page.evaluate(() => addNudgeBubble('Test nudge', [{ label: '📋 Test', message: 'test' }]));
      const nudge = page.locator('.chat-msg.nudge');
      await expect(nudge).toBeVisible();
      await nudge.locator('.nudge-dismiss').click();
      await expect(nudge).not.toBeVisible();
    });

    test('dismissing nudge also removes associated chips', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => addNudgeBubble('Test nudge with chips', [{ label: '📋 Chip A', message: 'a' }, { label: '🔔 Chip B', message: 'b' }]));
      const nudge = page.locator('.chat-msg.nudge').last();
      const chips = page.locator('.suggestion-chips').last();
      await expect(nudge).toBeVisible();
      await expect(chips).toBeVisible();
      await nudge.locator('.nudge-dismiss').click();
      await expect(nudge).not.toBeVisible();
      await expect(chips).not.toBeVisible();
    });
  });

});
