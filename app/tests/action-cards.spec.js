import { test, expect } from '@playwright/test';

test.describe('taskbean — Action Cards', () => {

  test.describe('Action Cards', () => {
    test('action card has Done and Snooze buttons', async ({ page }) => {
      await page.goto('/');
      // Create a todo with past reminder via API
      const pastTime = new Date(Date.now() - 3600000).toISOString();
      await page.evaluate(async (pastTime) => {
        const res = await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'E2E overdue test', emoji: '⏰' }) });
        const todo = await res.json();
        await fetch(`/api/todos/${todo.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reminder: true, remindAt: pastTime, reminderFired: false }) });
      }, pastTime);
      // Trigger overdue check
      await page.evaluate(() => checkOverdueReminders());
      const card = page.locator('.action-card').first();
      await expect(card).toBeVisible({ timeout: 5000 });
      await expect(card.locator('.action-card-btn.primary')).toBeVisible();
      await expect(card.locator('.action-card-btn.warn').first()).toBeVisible();
    });

    test('clicking Done resolves action card', async ({ page }) => {
      await page.goto('/');
      const pastTime = new Date(Date.now() - 3600000).toISOString();
      await page.evaluate(async (pastTime) => {
        const res = await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'E2E done test', emoji: '✅' }) });
        const todo = await res.json();
        await fetch(`/api/todos/${todo.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reminder: true, remindAt: pastTime, reminderFired: false }) });
      }, pastTime);
      await page.evaluate(() => checkOverdueReminders());
      const card = page.locator('.action-card').last();
      await expect(card).toBeVisible({ timeout: 5000 });
      await card.locator('.action-card-btn.primary').click();
      await expect(card).toHaveClass(/resolved/, { timeout: 5000 });
      await expect(card.locator('.resolved-label')).toBeVisible();
    });

    test('clicking Snooze resolves action card with snoozed label', async ({ page }) => {
      await page.goto('/');
      const pastTime = new Date(Date.now() - 3600000).toISOString();
      await page.evaluate(async (pastTime) => {
        const res = await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'E2E snooze test', emoji: '⏰' }) });
        const todo = await res.json();
        await fetch(`/api/todos/${todo.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reminder: true, remindAt: pastTime, reminderFired: false }) });
      }, pastTime);
      await page.evaluate(() => checkOverdueReminders());
      const card = page.locator('.action-card').last();
      await expect(card).toBeVisible({ timeout: 5000 });
      await card.locator('.action-card-btn.warn').first().click();
      await expect(card).toHaveClass(/resolved/, { timeout: 5000 });
    });

    test('duplicate action cards are prevented', async ({ page }) => {
      await page.goto('/');
      const pastTime = new Date(Date.now() - 3600000).toISOString();
      const todoId = await page.evaluate(async (pastTime) => {
        const res = await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'E2E dedupe test', emoji: '🔁' }) });
        const todo = await res.json();
        await fetch(`/api/todos/${todo.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reminder: true, remindAt: pastTime, reminderFired: false }) });
        return todo.id;
      }, pastTime);
      // Call checkOverdueReminders twice
      await page.evaluate(() => checkOverdueReminders());
      await page.waitForTimeout(500);
      await page.evaluate(() => checkOverdueReminders());
      // Should only have one card for this todo
      const cards = page.locator(`#action-card-${todoId}`);
      expect(await cards.count()).toBe(1);
    });
  });

});
