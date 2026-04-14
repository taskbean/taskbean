import { test, expect } from '@playwright/test';

test.describe('taskbean — Tabbed Sidebar', () => {

  test.describe('Tabbed Sidebar', () => {
    test('plus button on Todos tab opens Add Todo card', async ({ page }) => {
      await page.goto('/');
      // Should be on Todos tab by default
      await page.locator('#sidebarAddBtn').click();
      const card = page.locator('#add-todo-card');
      await expect(card).toBeVisible();
      await expect(card.locator('#addTodoText')).toBeVisible();
      await expect(card.locator('button', { hasText: 'Add with AI' })).toBeVisible();
    });

    test('eye toggle hides/shows completed todos', async ({ page }) => {
      await page.goto('/');
      // Create a completed todo via API
      await page.evaluate(async () => {
        const res = await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'E2E completed test', emoji: '✅' }) });
        const todo = await res.json();
        await fetch(`/api/todos/${todo.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completed: true }) });
      });
      await page.reload();
      await page.waitForTimeout(1000);
      // Initially completed todos are visible (eye is on by default)
      await expect(page.locator('.todo-item.completed')).toBeVisible();
      // Click eye to hide completed
      await page.locator('#sidebarEyeBtn').click();
      await expect(page.locator('.todo-item.completed')).not.toBeVisible();
      // Click eye again to show
      await page.locator('#sidebarEyeBtn').click();
      await expect(page.locator('.todo-item.completed')).toBeVisible();
    });
  });

});
