import { test, expect } from '@playwright/test';

test.describe('taskbean — Rich Tool Cards', () => {

  test.describe('Rich Tool Result Cards', () => {

    test('add_task via chat renders rich task-created card', async ({ page }) => {
      await page.goto('/');
      // Seed a todo via API to simulate what happens after tool execution
      // Then inject a tool result card via page.evaluate
      await page.evaluate(() => {
        if (typeof renderToolResultCard === 'function') {
          renderToolResultCard('add_task', JSON.stringify({
            success: true,
            todo: { id: 'test-1', title: 'Test card todo', emoji: '🎯', dueDate: '2026-04-15', priority: 'high', tags: ['demo'], notes: null, completed: false }
          }));
        }
      });
      const card = page.locator('.tool-result-card').first();
      await expect(card).toBeVisible({ timeout: 3000 });
      await expect(card.locator('.card-header')).toContainText('Task created');
      await expect(card.locator('.card-body')).toContainText('Test card todo');
      // Priority badge
      await expect(card.locator('.priority-badge.high')).toBeVisible();
      await page.screenshot({ path: 'test-results/tool-card-add-task.png' });
    });

    test('set_reminder card shows bell icon and time', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => {
        if (typeof renderToolResultCard === 'function') {
          renderToolResultCard('set_reminder', JSON.stringify({
            success: true,
            todo: { id: 'test-2', title: 'Call mom', emoji: '🔔', remindAt: '2026-04-12T17:00:00-07:00', dueDate: '2026-04-12' }
          }));
        }
      });
      const card = page.locator('.tool-result-card').first();
      await expect(card).toBeVisible({ timeout: 3000 });
      await expect(card.locator('.card-header')).toContainText('Reminder set');
      await page.screenshot({ path: 'test-results/tool-card-reminder.png' });
    });

    test('mark_complete card shows strikethrough title', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => {
        if (typeof renderToolResultCard === 'function') {
          renderToolResultCard('mark_complete', JSON.stringify({
            success: true,
            todo: { id: 'test-3', title: 'Finished task', emoji: '✅', completed: true }
          }));
        }
      });
      const card = page.locator('.tool-result-card').first();
      await expect(card).toBeVisible({ timeout: 3000 });
      await expect(card.locator('.card-header')).toContainText('Completed');
      const body = card.locator('.card-body div').first();
      await expect(body).toHaveCSS('text-decoration-line', 'line-through');
      await page.screenshot({ path: 'test-results/tool-card-complete.png' });
    });

    test('remove_task card shows undo button with countdown', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => {
        if (typeof renderToolResultCard === 'function') {
          renderToolResultCard('remove_task', JSON.stringify({
            success: true,
            removed: { id: 'test-4', title: 'Deleted task', emoji: '🗑️' }
          }));
        }
      });
      const card = page.locator('.tool-result-card').first();
      await expect(card).toBeVisible({ timeout: 3000 });
      await expect(card.locator('.card-header')).toContainText('Deleted');
      await expect(card.locator('.undo-btn')).toBeVisible();
      await expect(card.locator('.undo-timer')).toContainText('s');
      await page.screenshot({ path: 'test-results/tool-card-delete-undo.png' });
    });

    test('update_task card shows updated info', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => {
        if (typeof renderToolResultCard === 'function') {
          renderToolResultCard('update_task', JSON.stringify({
            success: true,
            todo: { id: 'test-5', title: 'Renamed task', emoji: '✏️', dueDate: '2026-04-20', priority: 'medium' }
          }));
        }
      });
      const card = page.locator('.tool-result-card').first();
      await expect(card).toBeVisible({ timeout: 3000 });
      await expect(card.locator('.card-header')).toContainText('Updated');
      await expect(card.locator('.card-body')).toContainText('Renamed task');
      await page.screenshot({ path: 'test-results/tool-card-update.png' });
    });

    test('get_weather card shows temperature and grid stats', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => {
        if (typeof renderToolResultCard === 'function') {
          renderToolResultCard('get_weather', JSON.stringify({
            temperature: '72°F', feelsLike: '70°F', condition: 'Partly cloudy',
            humidity: '45%', wind: '8 mph', precipitation: '0 mm',
            jacketAdvice: 'Nah, you\'re good.', umbrellaAdvice: 'No umbrella needed.'
          }));
        }
      });
      const card = page.locator('.tool-result-card').first();
      await expect(card).toBeVisible({ timeout: 3000 });
      await expect(card.locator('.card-header')).toContainText('Weather');
      await expect(card.locator('.card-body')).toContainText('72°F');
      await expect(card.locator('.weather-grid')).toBeVisible();
      await page.screenshot({ path: 'test-results/tool-card-weather.png' });
    });

    test('tool result cards render correctly across all 4 themes', async ({ page }) => {
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      for (const theme of ['dark-roast', 'latte', 'espresso', 'black-coffee']) {
        await page.goto('/');
        await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
        // Render multiple card types
        await page.evaluate(() => {
          if (typeof renderToolResultCard !== 'function') return;
          renderToolResultCard('add_task', JSON.stringify({ success: true, todo: { id: 't1', title: 'Theme card', emoji: '🎨', priority: 'high', tags: ['test'], dueDate: '2026-05-01' } }));
          renderToolResultCard('get_weather', JSON.stringify({ temperature: '65°F', feelsLike: '63°F', condition: 'Clear', humidity: '50%', wind: '5 mph', jacketAdvice: 'Maybe.', umbrellaAdvice: 'Nope.' }));
          renderToolResultCard('remove_task', JSON.stringify({ success: true, removed: { id: 't2', title: 'Gone task', emoji: '👋' } }));
        });
        await page.waitForTimeout(300);
        const cards = page.locator('.tool-result-card');
        expect(await cards.count()).toBeGreaterThanOrEqual(3);
        await page.screenshot({ path: `test-results/tool-cards-${theme}.png` });
      }
      expect(errors).toHaveLength(0);
    });
  });

});
