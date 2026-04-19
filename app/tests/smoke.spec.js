import { test, expect } from '@playwright/test';

test.describe('taskbean — Smoke Tests', () => {

  test.describe('Smoke Tests', () => {
    test('page loads without errors', async ({ page }) => {
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      await page.goto('/');
      // Page title must contain the brand name.
      await expect(page).toHaveTitle(/taskbean/i);
      await expect(page.locator('#chatFeed')).toBeVisible();
      await expect(page.locator('#chatInput')).toBeVisible();
      expect(errors).toHaveLength(0);
    });

    test('greeting message appears with time-of-day text', async ({ page }) => {
      await page.goto('/');
      const greeting = page.locator('#greetingMsg .msg-content');
      await expect(greeting).toBeVisible();
      const text = await greeting.textContent();
      // Should contain one of the time greetings or the default
      expect(text).toMatch(/taskbean/i);
    });
  });

});
