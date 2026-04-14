import { test, expect } from '@playwright/test';

test.describe('taskbean — Accessibility', () => {

  /* ───────────────────────────────────────────────────────────────────
     1. Skip navigation link
     ─────────────────────────────────────────────────────────────────── */
  test.describe('Skip Navigation Link', () => {
    test('skip link exists as first child of body', async ({ page }) => {
      await page.goto('/');
      const first = await page.evaluate(() => document.body.firstElementChild?.tagName + '.' + document.body.firstElementChild?.className);
      expect(first).toContain('a11y-skip-link');
    });

    test('skip link is hidden when not focused', async ({ page }) => {
      await page.goto('/');
      const link = page.locator('.a11y-skip-link');
      const box = await link.boundingBox();
      // Off-screen or 1×1 means visually hidden
      expect(box === null || box.width <= 1 || box.x < 0).toBeTruthy();
    });

    test('skip link is visible when focused via Tab', async ({ page }) => {
      await page.goto('/');
      await page.keyboard.press('Tab');
      const link = page.locator('.a11y-skip-link');
      await expect(link).toBeFocused();
      const box = await link.boundingBox();
      expect(box).not.toBeNull();
      expect(box.width).toBeGreaterThan(1);
      expect(box.height).toBeGreaterThan(1);
    });

    test('skip link navigates to #chatInput when activated', async ({ page }) => {
      await page.goto('/');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      const url = page.url();
      expect(url).toContain('#chatInput');
    });
  });

  /* ───────────────────────────────────────────────────────────────────
     2. Focus trapping in modals
     ─────────────────────────────────────────────────────────────────── */
  test.describe('Focus Trapping — Settings Modal', () => {
    test('focus starts inside modal when settings opens', async ({ page }) => {
      await page.goto('/');
      await page.locator('button[onclick="openSettings()"]').click();
      await expect(page.locator('#settingsModalOverlay')).toHaveClass(/open/);
      await page.waitForTimeout(200);
      const activeInModal = await page.evaluate(() => {
        const modal = document.querySelector('.settings-modal');
        return modal?.contains(document.activeElement) ?? false;
      });
      expect(activeInModal).toBe(true);
    });

    test('Tab cycles within settings modal', async ({ page }) => {
      await page.goto('/');
      await page.locator('button[onclick="openSettings()"]').click();
      await expect(page.locator('#settingsModalOverlay')).toHaveClass(/open/);
      await page.waitForTimeout(200);

      // Press Tab many times — focus should never leave the modal
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press('Tab');
      }
      const stillInModal = await page.evaluate(() => {
        const modal = document.querySelector('.settings-modal');
        return modal?.contains(document.activeElement) ?? false;
      });
      expect(stillInModal).toBe(true);
    });

    test('Escape closes settings modal', async ({ page }) => {
      await page.goto('/');
      await page.locator('button[onclick="openSettings()"]').click();
      await expect(page.locator('#settingsModalOverlay')).toHaveClass(/open/);
      await page.keyboard.press('Escape');
      await expect(page.locator('#settingsModalOverlay')).not.toHaveClass(/open/);
    });
  });

  test.describe('Focus Trapping — Model Picker Modal', () => {
    test('focus starts inside model picker when opened', async ({ page }) => {
      await page.goto('/');
      await page.locator('#chipModel').click();
      await expect(page.locator('#modelModalOverlay')).toHaveClass(/open/, { timeout: 3000 });
      await page.waitForTimeout(200);
      const activeInModal = await page.evaluate(() => {
        const modal = document.querySelector('.model-modal');
        return modal?.contains(document.activeElement) ?? false;
      });
      expect(activeInModal).toBe(true);
    });

    test('Escape closes model picker modal', async ({ page }) => {
      await page.goto('/');
      await page.locator('#chipModel').click();
      await expect(page.locator('#modelModalOverlay')).toHaveClass(/open/, { timeout: 3000 });
      await page.keyboard.press('Escape');
      await expect(page.locator('#modelModalOverlay')).not.toHaveClass(/open/);
    });
  });

  /* ───────────────────────────────────────────────────────────────────
     3. Keyboard navigation — todo items
     ─────────────────────────────────────────────────────────────────── */
  test.describe('Keyboard Navigation — Todos', () => {
    async function ensureTodoExists(page) {
      await page.goto('/');
      const count = await page.locator('.todo-item').count();
      if (count === 0) {
        // Create a todo via the chat input
        await page.locator('#chatInput').fill('add todo: accessibility test task');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(3000);
      }
      await expect(page.locator('.todo-item').first()).toBeVisible({ timeout: 10000 });
    }

    test('todo checkboxes have role="checkbox" and aria-checked', async ({ page }) => {
      await ensureTodoExists(page);
      const check = page.locator('.todo-check').first();
      await expect(check).toHaveAttribute('role', 'checkbox');
      const ariaChecked = await check.getAttribute('aria-checked');
      expect(['true', 'false']).toContain(ariaChecked);
    });

    test('todo items are focusable with tabindex="0"', async ({ page }) => {
      await ensureTodoExists(page);
      const item = page.locator('.todo-item').first();
      await expect(item).toHaveAttribute('tabindex', '0');
    });

    test('todo delete button has role="button" and aria-label', async ({ page }) => {
      await ensureTodoExists(page);
      const del = page.locator('.todo-delete').first();
      await expect(del).toHaveAttribute('role', 'button');
      await expect(del).toHaveAttribute('aria-label', 'Delete task');
    });

    test('Enter key on todo item expands detail panel', async ({ page }) => {
      await ensureTodoExists(page);
      const item = page.locator('.todo-item').first();
      await item.focus();
      await page.keyboard.press('Enter');
      await expect(item).toHaveClass(/expanded/);
    });
  });

  /* ───────────────────────────────────────────────────────────────────
     4. ARIA live regions
     ─────────────────────────────────────────────────────────────────── */
  test.describe('ARIA Live Regions', () => {
    test('#chatFeed has aria-live="polite" and aria-relevant="additions"', async ({ page }) => {
      await page.goto('/');
      const feed = page.locator('#chatFeed');
      await expect(feed).toHaveAttribute('aria-live', 'polite');
      await expect(feed).toHaveAttribute('aria-relevant', 'additions');
    });

    test('#statusText has aria-live="polite"', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#statusText')).toHaveAttribute('aria-live', 'polite');
    });

    test('.connection-banner has role="status"', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('.connection-banner').first()).toHaveAttribute('role', 'status');
    });
  });

  /* ───────────────────────────────────────────────────────────────────
     5. prefers-reduced-motion
     ─────────────────────────────────────────────────────────────────── */
  test.describe('Reduced Motion', () => {
    test('animations have near-zero duration when reduced motion is preferred', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/');
      // Sample multiple elements for animation/transition duration
      const durations = await page.evaluate(() => {
        const els = [document.body, document.querySelector('#chatFeed'), document.querySelector('header')].filter(Boolean);
        return els.map(el => {
          const s = getComputedStyle(el);
          return {
            animationDuration: s.animationDuration,
            transitionDuration: s.transitionDuration,
          };
        });
      });
      for (const d of durations) {
        // 0s or 0.01ms both count as near-zero
        const parseDur = (v) => parseFloat(v) || 0;
        expect(parseDur(d.animationDuration)).toBeLessThanOrEqual(0.01);
        expect(parseDur(d.transitionDuration)).toBeLessThanOrEqual(0.01);
      }
    });
  });

  /* ───────────────────────────────────────────────────────────────────
     6. Form label associations
     ─────────────────────────────────────────────────────────────────── */
  test.describe('Form Label Associations', () => {
    test('settings port input has a label with matching for/id', async ({ page }) => {
      await page.goto('/');
      await page.locator('button[onclick="openSettings()"]').click();
      await expect(page.locator('#settingsModalOverlay')).toHaveClass(/open/);
      const portInput = page.locator('#settingsPort');
      await expect(portInput).toBeVisible();
      const id = await portInput.getAttribute('id');
      const label = page.locator(`label[for="${id}"]`);
      await expect(label).toBeVisible();
      await expect(label).toContainText('Port');
    });

    test('settings timezone select has a label with matching for/id', async ({ page }) => {
      await page.goto('/');
      await page.locator('button[onclick="openSettings()"]').click();
      await expect(page.locator('#settingsModalOverlay')).toHaveClass(/open/);
      const tzSelect = page.locator('#settingsTimezone');
      await expect(tzSelect).toBeVisible();
      const id = await tzSelect.getAttribute('id');
      const label = page.locator(`label[for="${id}"]`);
      await expect(label).toBeVisible();
      await expect(label).toContainText('Timezone');
    });
  });

});
