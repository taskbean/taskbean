import { test, expect } from '@playwright/test';

test.describe('taskbean — Todo Enrichment', () => {

  test.describe('Todo Enrichment — Priority, Tags, Notes, Inline Edit', () => {

    test('todo with priority shows colored priority dot', async ({ page }) => {
      await page.goto('/');
      // Create a high-priority todo via API
      await page.evaluate(async () => {
        await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'E2E priority test', priority: 'high', tags: ['work', 'urgent'] }) });
      });
      await page.reload();
      await page.waitForTimeout(500);
      const dot = page.locator('.priority-dot.high').first();
      await expect(dot).toBeVisible({ timeout: 5000 });
    });

    test('todo with tags shows tag pills', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(async () => {
        await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'E2E tags test', tags: ['work', 'personal'] }) });
      });
      await page.reload();
      await page.waitForTimeout(500);
      const pills = page.locator('.tag-pill');
      expect(await pills.count()).toBeGreaterThanOrEqual(2);
      await expect(pills.first()).toBeVisible();
    });

    test('clicking todo expands detail panel with priority chips', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(async () => {
        await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'E2E expand test', priority: 'medium' }) });
      });
      await page.reload();
      await page.waitForTimeout(500);
      // Click the todo body to expand
      await page.locator('.todo-body').first().click();
      const detail = page.locator('.todo-detail').first();
      await expect(detail).toBeVisible({ timeout: 3000 });
      // Priority chips should be visible
      const chips = detail.locator('.priority-chip');
      expect(await chips.count()).toBe(4); // high, medium, low, none
      // Medium should be active
      await expect(detail.locator('.priority-chip.medium.active')).toBeVisible();
    });

    test('priority chip click updates todo priority via API', async ({ page }) => {
      await page.goto('/');
      const todoId = await page.evaluate(async () => {
        const res = await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'E2E priority click', priority: 'low' }) });
        return (await res.json()).id;
      });
      await page.reload();
      await page.waitForTimeout(500);
      // Expand the todo
      await page.locator('.todo-body').first().click();
      await page.waitForTimeout(200);
      // Click the "high" chip
      await page.locator('.priority-chip.high').first().click();
      await page.waitForTimeout(500);
      // Verify via API
      const updated = await page.evaluate(async (id) => {
        const res = await fetch('/api/todos');
        const todos = await res.json();
        return todos.find(t => t.id === id);
      }, todoId);
      expect(updated.priority).toBe('high');
    });

    test('double-click todo title enables inline editing', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(async () => {
        await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'E2E inline edit test' }) });
      });
      await page.reload();
      await page.waitForTimeout(500);
      // Double-click the title
      await page.locator('.todo-title').first().dblclick();
      const input = page.locator('.todo-title-input');
      await expect(input).toBeVisible({ timeout: 2000 });
      await expect(input).toHaveValue('E2E inline edit test');
      // Edit and press Enter
      await input.fill('E2E inline edit UPDATED');
      await input.press('Enter');
      await page.waitForTimeout(500);
      // Verify via API
      const todos = await page.evaluate(async () => {
        const res = await fetch('/api/todos');
        return await res.json();
      });
      expect(todos.some(t => t.title === 'E2E inline edit UPDATED')).toBe(true);
    });

    test('Escape key cancels inline title edit', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(async () => {
        await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'E2E escape cancel' }) });
      });
      await page.reload();
      await page.waitForTimeout(500);
      await page.locator('.todo-title').first().dblclick();
      const input = page.locator('.todo-title-input');
      await input.fill('SHOULD NOT SAVE');
      await input.press('Escape');
      await page.waitForTimeout(300);
      // Title should revert
      await expect(page.locator('.todo-title').first()).toContainText('E2E escape cancel');
    });

    test('notes section shows in expanded detail and is editable', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(async () => {
        await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'E2E notes test', notes: '# Header\n- bullet' }) });
      });
      await page.reload();
      await page.waitForTimeout(500);
      // Expand todo
      await page.locator('.todo-body').first().click();
      const notesEl = page.locator('.todo-detail-notes').first();
      await expect(notesEl).toBeVisible({ timeout: 3000 });
      await expect(notesEl).toContainText('# Header');
      // Click to edit
      await notesEl.click();
      const textarea = page.locator('.todo-detail-notes-edit');
      await expect(textarea).toBeVisible({ timeout: 2000 });
    });

    test('overdue todo shows overdue badge', async ({ page }) => {
      await page.goto('/');
      // Create a todo with a past due date
      await page.evaluate(async () => {
        await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'E2E overdue task', dueDate: '2020-01-01' }) });
      });
      await page.reload();
      await page.waitForTimeout(500);
      const overdue = page.locator('.overdue-badge').first();
      await expect(overdue).toBeVisible({ timeout: 5000 });
      await expect(overdue).toContainText('overdue');
    });

    test('priority dots, tags, detail panel work across all 4 themes', async ({ page }) => {
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      await page.goto('/');
      await page.evaluate(async () => {
        await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Theme test todo', priority: 'high', tags: ['theme-test'] }) });
      });
      for (const theme of ['dark-roast', 'latte', 'espresso', 'black-coffee']) {
        await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
        await page.reload();
        await page.waitForTimeout(500);
        await expect(page.locator('.priority-dot.high').first()).toBeVisible({ timeout: 5000 });
        await expect(page.locator('.tag-pill').first()).toBeVisible();
        // Expand and check detail panel
        await page.locator('.todo-body').first().click();
        await expect(page.locator('.todo-detail').first()).toBeVisible({ timeout: 3000 });
        await page.screenshot({ path: `test-results/todo-enrichment-${theme}.png` });
      }
      expect(errors).toHaveLength(0);
    });
  });

});
