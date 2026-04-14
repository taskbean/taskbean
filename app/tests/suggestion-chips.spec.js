import { test, expect } from '@playwright/test';

test.describe('taskbean — Suggestion Chips', () => {

  test.describe('Suggestion Chips', () => {
    test('onboarding chips appear when todo list is empty', async ({ page }) => {
      await page.goto('/');
      // Wait for onboarding flow (2s timeout + fetch)
      const chips = page.locator('.suggestion-chips');
      await expect(chips.first()).toBeVisible({ timeout: 20000 });
      const chipButtons = chips.first().locator('.suggestion-chip');
      expect(await chipButtons.count()).toBeGreaterThan(0);
    });

    test('clicking chip sends message to chat', async ({ page }) => {
      await page.goto('/');
      // Wait for chips
      const chip = page.locator('.suggestion-chip').first();
      await expect(chip).toBeVisible({ timeout: 20000 });
      const chipText = await chip.getAttribute('data-msg');
      await chip.click();
      // Chat input should have been populated and sent
      // Wait for user message to appear in chat
      await expect(page.locator('.chat-msg.user').first()).toBeVisible({ timeout: 5000 });
    });

    test('chips fade out after click', async ({ page }) => {
      await page.goto('/');
      const chips = page.locator('.suggestion-chips').first();
      await expect(chips).toBeVisible({ timeout: 20000 });
      await chips.locator('.suggestion-chip').first().click();
      // Should have fade-out class
      await expect(chips).toHaveClass(/fade-out/, { timeout: 2000 });
    });

    test('chip click while processing is ignored', async ({ page }) => {
      await page.goto('/');
      // Type a message to start processing
      await page.locator('#chatInput').fill('hello');
      await page.locator('#chatInput').press('Enter');
      // Immediately try to click a chip if one exists
      const chip = page.locator('.suggestion-chip').first();
      if (await chip.isVisible({ timeout: 2000 }).catch(() => false)) {
        await chip.click();
        // Should not create a second user message while processing
        const userMsgs = page.locator('.chat-msg.user');
        expect(await userMsgs.count()).toBeLessThanOrEqual(1);
      }
    });
  });

});
