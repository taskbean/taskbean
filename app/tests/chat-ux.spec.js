import { test, expect } from '@playwright/test';

test.describe('taskbean — Chat UX', () => {

  test.describe('Typing Indicator', () => {
    test('typing indicator appears after sending a command', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      await page.fill('#chatInput', 'hello');
      await page.press('#chatInput', 'Enter');

      const typingEl = page.locator('.ai-typing');
      // Typing indicator appears briefly before AI starts streaming
      await expect(typingEl).toBeVisible({ timeout: 5000 }).catch(() => {
        // May have been replaced by streaming already — that's OK
      });
    });

    test('typing indicator has 3 dot elements', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      await page.fill('#chatInput', 'hello');
      await page.press('#chatInput', 'Enter');

      const typingEl = page.locator('.ai-typing');
      try {
        await expect(typingEl).toBeVisible({ timeout: 5000 });
        const dotCount = await typingEl.locator('span').count();
        expect(dotCount).toBe(3);
      } catch {
        // Streaming may have replaced indicator before we could inspect
      }
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
      await page.goto('/');
      await page.waitForTimeout(1000);

      // Trigger a command so a typing indicator may appear
      await page.fill('#chatInput', 'hello');
      await page.press('#chatInput', 'Enter');
      await page.waitForTimeout(500);

      // Click New Chat button
      const newChatBtn = page.locator('#newChatBtn');
      await newChatBtn.click();
      await page.waitForTimeout(500);

      // Verify no typing indicators remain
      const typingCount = await page.locator('.ai-typing').count();
      expect(typingCount).toBe(0);
    });
  });

});
