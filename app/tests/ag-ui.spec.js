import { test, expect } from '@playwright/test';

test.describe('taskbean — AG-UI Action Cards', () => {

  test.describe('AG-UI Action Cards', () => {
    test('port conflict card renders with 3 buttons', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);
      await page.evaluate(() => {
        routeTelemetryEvent({ type: 'port.conflict', requested: 2326, actual: 2327 }, true);
      });
      await page.waitForTimeout(500);
      const btns = await page.evaluate(() => {
        return [...document.querySelectorAll('.inline-action-btn')].map(b => b.textContent.trim());
      });
      expect(btns.length).toBeGreaterThanOrEqual(3);
      expect(btns.some(b => b.includes('Save'))).toBe(true);
      expect(btns.some(b => b.includes('Keep'))).toBe(true);
      expect(btns.some(b => b.includes('Dismiss'))).toBe(true);
    });

    test('port conflict Save button calls API and shows confirmation', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);
      await page.evaluate(() => {
        routeTelemetryEvent({ type: 'port.conflict', requested: 2326, actual: 2327 }, true);
      });
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('.inline-action-btn')].find(b => b.textContent.includes('Save'));
        btn?.click();
      });
      await page.waitForTimeout(2000);
      // Check ANY chat message contains the confirmation (not just last — overdue reminders may appear after)
      const hasConfirmation = await page.evaluate(() => {
        const msgs = [...document.querySelectorAll('.chat-msg')];
        return msgs.some(m => m.textContent.includes('Port set to'));
      });
      expect(hasConfirmation).toBe(true);
      // Reset port
      await page.evaluate(() => fetch('/api/port', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: 2326 }) }));
    });

    test('port conflict Dismiss button hides card', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);
      await page.evaluate(() => {
        window._portConflictShown = false;
        routeTelemetryEvent({ type: 'port.conflict', requested: 2326, actual: 2327 }, true);
      });
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('.inline-action-btn')].find(b => b.textContent.includes('Dismiss'));
        btn?.click();
      });
      await page.waitForTimeout(300);
      const hidden = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('.inline-action-btn')].find(b => b.textContent.includes('Save'));
        return btn?.closest('.chat-msg')?.style.display === 'none';
      });
      expect(hidden).toBe(true);
    });

    test('parallel tool call failure card renders', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);
      await page.evaluate(() => {
        routeTelemetryEvent({ type: 'inference.suggestion', subtype: 'disable_parallel_tool_calls', failureCount: 3 }, true);
      });
      await page.waitForTimeout(500);
      const cardText = await page.evaluate(() => {
        const msgs = [...document.querySelectorAll('.chat-msg')];
        return msgs[msgs.length - 1]?.textContent?.trim().slice(0, 200);
      });
      expect(cardText).toContain('Parallel tool calls failed');
      expect(cardText).toContain('Disable');
      expect(cardText).toContain('Dismiss');
    });

    test('parallel tool call Disable button updates config', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);
      await page.evaluate(() => {
        window._parallelSuggestionShown = false;
        routeTelemetryEvent({ type: 'inference.suggestion', subtype: 'disable_parallel_tool_calls', failureCount: 3 }, true);
      });
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('.inline-action-btn')].find(b => b.textContent.includes('Disable'));
        btn?.click();
      });
      await page.waitForTimeout(2000);
      const cfg = await page.evaluate(() => fetch('/api/config').then(r => r.json()));
      expect(cfg.parallelToolCalls).toBe('off');
      // Reset
      await page.evaluate(() => fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parallelToolCalls: 'auto' }) }));
    });
  });

});
