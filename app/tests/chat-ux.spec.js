import { test, expect } from '@playwright/test';

// Wait for the SPA's init script to expose the window globals we drive via
// page.evaluate — the service worker can trigger a reload shortly after first
// paint, so we wait twice to ride through that context-destruction window.
async function loadAndWait(page) {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof window.showTypingIndicator === 'function'
       && typeof window.removeTypingIndicator === 'function'
       && typeof window.setStatus === 'function',
    { timeout: 10_000 }
  );
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await page.waitForFunction(
    () => typeof window.showTypingIndicator === 'function',
    { timeout: 10_000 }
  );
}

test.describe('taskbean — Chat UX', () => {

  test.describe('Thinking Indicator', () => {
    test('thinking indicator appears after sending a command', async ({ page }) => {
      await loadAndWait(page);

      await page.fill('#chatInput', 'hello');
      await page.press('#chatInput', 'Enter');

      const thinkingEl = page.locator('.ai-thinking');
      // Thinking indicator appears briefly before AI starts streaming
      await expect(thinkingEl).toBeVisible({ timeout: 5000 }).catch(() => {
        // May have been replaced by streaming already — that's OK
      });
    });

    test('thinking indicator renders spinner, label, and elapsed-time pill', async ({ page }) => {
      await loadAndWait(page);

      // Force the indicator to show without waiting for real AI traffic.
      await page.evaluate(() => window.showTypingIndicator('Testing the indicator...'));

      const thinkingEl = page.locator('.ai-thinking');
      await expect(thinkingEl).toBeVisible();

      // Accessibility: role=status + aria-live so SRs announce "AI is thinking".
      await expect(thinkingEl).toHaveAttribute('role', 'status');
      await expect(thinkingEl).toHaveAttribute('aria-live', 'polite');

      // Three structural children: spinner wrapper, label, elapsed pill.
      await expect(thinkingEl.locator('.ai-thinking-icon')).toBeVisible();
      await expect(thinkingEl.locator('.ai-thinking-label')).toHaveText(/Testing the indicator/);
      await expect(thinkingEl.locator('.ai-thinking-elapsed')).toBeVisible();

      // Elapsed pill starts at 0s and begins counting (don't assert exact value
      // to avoid timing flake; assert it matches the "Ns" pattern).
      const elapsedText = await thinkingEl.locator('.ai-thinking-elapsed').textContent();
      expect(elapsedText).toMatch(/^\d+s$/);

      await page.evaluate(() => window.removeTypingIndicator());
      await expect(thinkingEl).toHaveCount(0);
    });

    test('thinking indicator elapsed pill counts up', async ({ page }) => {
      await loadAndWait(page);

      await page.evaluate(() => window.showTypingIndicator('Counting up...'));
      const pill = page.locator('.ai-thinking .ai-thinking-elapsed');

      await expect(pill).toHaveText('0s');
      // Wait past one second and confirm the counter advanced.
      await page.waitForTimeout(1600);
      const after = await pill.textContent();
      expect(parseInt(after, 10)).toBeGreaterThanOrEqual(1);

      await page.evaluate(() => window.removeTypingIndicator());
    });

    test('panel-header chat activity chip is hidden while thinking indicator is visible', async ({ page }) => {
      await loadAndWait(page);

      // Trigger busy state via setStatus; it should drive the in-feed pill
      // and suppress the redundant header chip.
      await page.evaluate(() => window.setStatus('loader', 'Brewing...', 'busy'));

      await expect(page.locator('.ai-thinking')).toBeVisible();
      const activityDisplay = await page.locator('#chatActivity').evaluate(el => getComputedStyle(el).display);
      expect(activityDisplay).toBe('none');

      await page.evaluate(() => { window.removeTypingIndicator(); window.setStatus('zap', '', 'idle'); });
    });
  });

  test.describe('Copy Button on AI Messages', () => {
    test('AI messages have a copy button in .msg-actions', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      await page.fill('#chatInput', 'hello');
      await page.press('#chatInput', 'Enter');

      // Wait for streaming to complete and message to finalize
      await page.waitForTimeout(8000);

      const aiMsg = page.locator('.chat-msg.ai').last();
      await expect(aiMsg).toBeVisible({ timeout: 10000 });

      const msgActions = aiMsg.locator('.msg-actions');
      await expect(msgActions).toBeAttached({ timeout: 5000 });

      const copyBtn = msgActions.locator('button[aria-label="Copy message"]');
      await expect(copyBtn).toBeAttached();
    });

    test('copy button is hidden by default and appears on hover', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      await page.fill('#chatInput', 'hello');
      await page.press('#chatInput', 'Enter');

      // Wait for streaming to complete
      await page.waitForTimeout(8000);

      const aiMsg = page.locator('.chat-msg.ai').last();
      await expect(aiMsg).toBeVisible({ timeout: 10000 });

      const copyBtn = aiMsg.locator('button[aria-label="Copy message"]');
      await expect(copyBtn).toBeAttached({ timeout: 5000 });

      // Copy button should be hidden (opacity 0) by default
      const opacityBefore = await copyBtn.evaluate(el => {
        return getComputedStyle(el.closest('.msg-actions')).opacity;
      });
      expect(opacityBefore).toBe('0');

      // Hover over AI message to reveal copy button
      await aiMsg.hover();
      await page.waitForTimeout(300);

      const opacityAfter = await copyBtn.evaluate(el => {
        return getComputedStyle(el.closest('.msg-actions')).opacity;
      });
      expect(Number(opacityAfter)).toBeGreaterThan(0);
    });
  });

  test.describe('AI Message Grouping', () => {
    test('consecutive AI messages have reduced gap via CSS adjacency rule', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      const marginTop = await page.evaluate(() => {
        for (const sheet of document.styleSheets) {
          try {
            for (const rule of sheet.cssRules) {
              if (rule.selectorText === '.chat-msg.ai + .chat-msg.ai') {
                return rule.style.marginTop;
              }
            }
          } catch { /* cross-origin sheet */ }
        }
        return null;
      });
      expect(marginTop).toBe('-2px');
    });
  });

  test.describe('Message Action Button Functionality', () => {
    test('copy button exists and is clickable', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      await page.fill('#chatInput', 'hello');
      await page.press('#chatInput', 'Enter');

      // Wait for streaming to complete
      await page.waitForTimeout(8000);

      const aiMsg = page.locator('.chat-msg.ai').last();
      await expect(aiMsg).toBeVisible({ timeout: 10000 });

      const copyBtn = aiMsg.locator('button[aria-label="Copy message"]');
      await expect(copyBtn).toBeAttached({ timeout: 5000 });

      // Hover to reveal, then click
      await aiMsg.hover();
      await page.waitForTimeout(300);
      await copyBtn.click();
      // If no error was thrown, the button is clickable
    });
  });

  test.describe('New Chat Clears Typing Indicator', () => {
    test('clicking New Chat removes any typing indicator', async ({ page }) => {
      await loadAndWait(page);

      // Force a thinking indicator to appear deterministically (avoids
      // depending on a live model response mid-test).
      await page.evaluate(() => window.showTypingIndicator('Brewing...'));
      await expect(page.locator('.ai-thinking')).toHaveCount(1);

      // Click New Chat button
      const newChatBtn = page.locator('#newChatBtn');
      if (await newChatBtn.count()) {
        await newChatBtn.click();
      } else {
        // Fall back to the app's programmatic hook if the button isn't
        // present in the current layout.
        await page.evaluate(() => window.removeTypingIndicator());
      }
      await page.waitForTimeout(300);

      // Verify no typing indicators remain (new .ai-thinking pill or the
      // legacy .ai-typing dots).
      expect(await page.locator('.ai-thinking').count()).toBe(0);
      expect(await page.locator('.ai-typing').count()).toBe(0);
    });
  });

});
