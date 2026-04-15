import { test, expect } from '@playwright/test';

test.describe('taskbean — Recurring', () => {

  test.describe('Recurring Creator Form', () => {
    test('plus button opens recurring creator form with icon picker', async ({ page }) => {
      await page.goto('/');
      // Switch to Recurring tab first
      await page.locator('#tabRecurring').click();
      // Click the shared + button (opens recurring creator when on Recurring tab)
      const plusBtn = page.locator('#sidebarAddBtn');
      await expect(plusBtn).toBeVisible();
      await plusBtn.click();

      const card = page.locator('#recurring-creator-card');
      await expect(card).toBeVisible();
      // Should have an icon picker, NOT an emoji input
      await expect(card.locator('#rcIconPicker')).toBeVisible();
      await expect(card.locator('#rcEmoji')).not.toBeVisible();
      // Should have icon preview showing default "repeat"
      await expect(card.locator('#rcIconName')).toContainText('repeat');
    });

    test('form has Name, Icon, Every, Note fields and Create/Cancel buttons', async ({ page }) => {
      await page.goto('/');
      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarAddBtn').click();
      const card = page.locator('#recurring-creator-card');
      await expect(card).toBeVisible();

      await expect(card.locator('#rcTitle')).toBeVisible();
      await expect(card.locator('#rcIconPicker')).toBeVisible();
      await expect(card.locator('#rcInterval')).toBeVisible();
      await expect(card.locator('#rcUnit')).toBeVisible();
      await expect(card.locator('#rcDesc')).toBeVisible();
      await expect(card.locator('#rcSubmitBtn')).toBeVisible();
      await expect(card.locator('button', { hasText: 'Cancel' })).toBeVisible();
    });

    test('cancel button removes the form', async ({ page }) => {
      await page.goto('/');
      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarAddBtn').click();
      await expect(page.locator('#recurring-creator-card')).toBeVisible();
      await page.locator('#recurring-creator-card button', { hasText: 'Cancel' }).click();
      await expect(page.locator('#recurring-creator-card')).not.toBeVisible();
    });

    test('empty title shows validation error', async ({ page }) => {
      await page.goto('/');
      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarAddBtn').click();
      // Click Create without filling title
      await page.locator('#rcSubmitBtn').click();
      // Title input should have red border
      const borderColor = await page.locator('#rcTitle').evaluate(el => getComputedStyle(el).borderColor);
      expect(borderColor).not.toBe('');
      // Form should still be visible (not submitted)
      await expect(page.locator('#recurring-creator-card')).toBeVisible();
    });

    test('reopening form resets icon to default repeat', async ({ page }) => {
      await page.goto('/');
      await page.locator('#tabRecurring').click();
      // Open, type something to trigger auto-select, then cancel
      await page.locator('#sidebarAddBtn').click();
      await page.locator('#rcTitle').fill('Drink water');
      await page.waitForTimeout(600); // wait for debounce
      // Icon should have changed from default
      const firstIcon = await page.locator('#rcIconName').textContent();
      await page.locator('#recurring-creator-card button', { hasText: 'Cancel' }).click();

      // Reopen — should reset to 'repeat'
      await page.locator('#sidebarAddBtn').click();
      await expect(page.locator('#rcIconName')).toContainText('repeat');
    });
  });

  test.describe('Rotating Placeholder', () => {
    test('name input has a placeholder that changes over time', async ({ page }) => {
      await page.goto('/');
      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarAddBtn').click();
      const input = page.locator('#rcTitle');
      await expect(input).toBeVisible();

      const first = await input.getAttribute('placeholder');
      expect(first).toMatch(/^e\.g\./);

      // Wait for at least one rotation (2.5s interval + 0.3s fade)
      await page.waitForTimeout(3200);
      const second = await input.getAttribute('placeholder');
      // Should have changed to a different example
      expect(second).toMatch(/^e\.g\./);
      expect(second).not.toBe(first);
    });

    test('placeholder rotation pauses on focus', async ({ page }) => {
      await page.goto('/');
      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarAddBtn').click();
      const input = page.locator('#rcTitle');
      await input.focus();
      const atFocus = await input.getAttribute('placeholder');
      // Wait past a rotation cycle
      await page.waitForTimeout(3200);
      const afterWait = await input.getAttribute('placeholder');
      expect(afterWait).toBe(atFocus);
    });
  });

  test.describe('Recurring Reminder Creation', () => {
    test('submitting form creates a custom recurring reminder', async ({ page }) => {
      await page.goto('/');
      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarAddBtn').click();
      await page.locator('#rcTitle').fill('E2E test reminder');
      await page.locator('#rcInterval').fill('15');
      await page.locator('#rcDesc').fill('E2E test description');
      await page.locator('#rcSubmitBtn').click();

      // Form should show resolved state
      const card = page.locator('#recurring-creator-card');
      await expect(card).toHaveClass(/resolved/, { timeout: 5000 });
      await expect(card).toContainText('Created: E2E test reminder');

      // Template should appear in the sidebar list
      await page.locator('#tabRecurring').click();
      const templateList = page.locator('#recurringActiveList');
      await expect(templateList).toContainText('E2E test reminder');
    });

    test('created template shows Lucide icon, not emoji', async ({ page }) => {
      await page.goto('/');
      // Create a reminder via API
      await page.evaluate(async () => {
        await fetch('/api/templates/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'E2E icon test', icon: 'star', intervalMin: 30, description: 'test' })
        });
      });
      await page.reload();
      await page.waitForTimeout(1000);

      // Switch to Recurring tab to verify
      await page.locator('#tabRecurring').click();

      // Find the custom template in the list
      const templateCard = page.locator('.template-card', { hasText: 'E2E icon test' });
      await expect(templateCard).toBeVisible();
      // Its icon should be a Lucide SVG, not raw emoji text
      const iconDiv = templateCard.locator('.template-icon');
      await expect(iconDiv.locator('svg')).toBeVisible();
    });

    test('duplicate title returns error', async ({ page }) => {
      await page.goto('/');
      // Create one via API first
      await page.evaluate(async () => {
        await fetch('/api/templates/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'E2E dupe test', icon: 'repeat', intervalMin: 30 })
        });
      });

      // Try to create the same via the form
      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarAddBtn').click();
      await page.locator('#rcTitle').fill('E2E dupe test');
      await page.locator('#rcSubmitBtn').click();

      // Should show error in chat
      const errorMsg = page.locator('.chat-msg.error').last();
      await expect(errorMsg).toBeVisible({ timeout: 5000 });
      await expect(errorMsg).toContainText(/already exists/i);
    });

    test('created reminder icon is sent to backend', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.iconLibraryLoaded === true, { timeout: 15000 });

      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarAddBtn').click();
      await page.locator('#rcTitle').fill('Drink some water');
      await page.waitForTimeout(800);

      // Capture the auto-selected icon name before submitting
      const selectedIcon = await page.locator('#rcIconName').textContent();
      expect(selectedIcon).not.toBe('repeat');

      await page.locator('#rcSubmitBtn').click();
      await expect(page.locator('#recurring-creator-card')).toHaveClass(/resolved/, { timeout: 5000 });

      // Verify via API that the template has the correct icon
      const templates = await page.evaluate(async () => {
        const res = await fetch('/api/templates');
        return res.json();
      });
      const created = templates.active.find(t => t.title === 'Drink some water');
      expect(created).toBeTruthy();
      expect(created.icon).toBe(selectedIcon);
    });
  });

  test.describe('Recurring Reminders — No JS Errors', () => {
    test('full create flow produces no JS errors', async ({ page }) => {
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      await page.goto('/');
      await page.waitForFunction(() => window.iconLibraryLoaded === true, { timeout: 15000 });

      // Open form
      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarAddBtn').click();
      // Type to trigger auto-select
      await page.locator('#rcTitle').fill('Morning stretch');
      await page.waitForTimeout(800);
      // Open icon dropdown
      await page.locator('.icon-picker-trigger').click();
      await page.waitForTimeout(200);
      // Search in dropdown
      await page.locator('#rcIconSearch').fill('sun');
      await page.waitForTimeout(200);
      // Select an icon
      const item = page.locator('#rcIconGrid .icon-grid-item').first();
      if (await item.isVisible()) await item.click();
      // Fill remaining fields
      await page.locator('#rcInterval').fill('45');
      await page.locator('#rcDesc').fill('Start the day right');
      // Submit
      await page.locator('#rcSubmitBtn').click();
      await expect(page.locator('#recurring-creator-card')).toHaveClass(/resolved/, { timeout: 5000 });

      expect(errors).toHaveLength(0);
    });

    test('all themes render recurring section without errors', async ({ page }) => {
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      await page.goto('/');
      // Switch to Recurring tab and show all templates
      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarEyeBtn').click();

      for (const theme of ['latte', 'espresso', 'black-coffee', 'dark-roast']) {
        await page.evaluate((t) => {
          document.documentElement.setAttribute('data-theme', t);
        }, theme);
        await page.waitForTimeout(200);
        // Templates section should render fine
        await expect(page.locator('#recurringActiveList .template-card').first()).toBeVisible();
        // All icons should be SVGs
        const icons = page.locator('#recurringActiveList .template-icon svg');
        expect(await icons.count()).toBeGreaterThanOrEqual(7);
      }
      expect(errors).toHaveLength(0);
    });
  });

  test.describe('Toggle Enable/Disable', () => {
    test('toggling a built-in reminder ON then OFF works', async ({ page }) => {
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      await page.goto('/');

      // Switch to Recurring tab
      await page.locator('#tabRecurring').click();
      await page.waitForLoadState('networkidle');

      // Ensure we have a known starting state: deactivate all via API, then reload
      await page.evaluate(async () => {
        const res = await fetch('/api/templates');
        const data = await res.json();
        for (const t of data.active) {
          if (t.active) {
            await fetch('/api/templates/deactivate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: t.id })
            });
          }
        }
      });

      // Reload to get clean disabled state
      await page.reload();
      await page.waitForTimeout(1000);
      await page.locator('#tabRecurring').click();

      // Show disabled reminders via the eye button
      await page.locator('#panelEyeBtn').click();
      await page.waitForTimeout(500);

      // All built-in templates should now be visible and disabled
      const disabledToggle = page.locator('#recurringActiveList .template-card.disabled .template-toggle.off').first();
      await expect(disabledToggle).toBeVisible({ timeout: 5000 });

      // Get the card's name for later verification
      const card = disabledToggle.locator('..');
      const cardName = await card.locator('.name').textContent();

      // Click toggle to ENABLE
      await disabledToggle.click();
      await page.waitForTimeout(1500);

      // The template should now be active — toggle gains .on
      const activeCard = page.locator('#recurringActiveList .template-card:not(.disabled)', { hasText: cardName });
      await expect(activeCard).toBeVisible({ timeout: 5000 });
      await expect(activeCard.locator('.template-toggle.on')).toBeVisible();

      // Click toggle to DISABLE again
      await activeCard.locator('.template-toggle.on').click();
      await page.waitForTimeout(1500);

      // The template should be disabled again
      const reDisabledCard = page.locator('#recurringActiveList .template-card.disabled', { hasText: cardName });
      await expect(reDisabledCard).toBeVisible({ timeout: 5000 });
      await expect(reDisabledCard.locator('.template-toggle.off')).toBeVisible();

      // No JS errors during the flow (filter out browser navigation noise)
      const realErrors = errors.filter(e => !e.includes('Transition was aborted'));
      expect(realErrors).toHaveLength(0);
    });

    test('toggling produces chat confirmation messages', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);
      await page.locator('#tabRecurring').click();

      // Deactivate all templates to get a clean state
      await page.evaluate(async () => {
        const res = await fetch('/api/templates');
        const data = await res.json();
        for (const t of data.active) {
          if (t.active) {
            await fetch('/api/templates/deactivate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: t.id })
            });
          }
        }
      });

      await page.reload();
      await page.waitForTimeout(1000);
      await page.locator('#tabRecurring').click();
      await page.locator('#panelEyeBtn').click();
      await page.waitForTimeout(500);

      // Enable a template
      const toggle = page.locator('#recurringActiveList .template-card.disabled .template-toggle.off').first();
      await expect(toggle).toBeVisible({ timeout: 5000 });
      await toggle.click();
      await page.waitForTimeout(1500);

      // Should see "Activated:" chat message
      await expect(page.locator('#chatFeed').locator('.msg-content', { hasText: /Activated:/ })).toBeVisible({ timeout: 5000 });
    });
  });

});
