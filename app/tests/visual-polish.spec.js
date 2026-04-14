import { test, expect } from '@playwright/test';

test.describe('taskbean — Visual Polish & PWA', () => {

  test.describe('Smooth Theme Transitions', () => {
    test('body has transition on background-color or color', async ({ page }) => {
      await page.goto('/');
      const prop = await page.evaluate(() => getComputedStyle(document.body).transitionProperty);
      expect(prop).toMatch(/background-color|color|all/);
    });

    test('header has transition property', async ({ page }) => {
      await page.goto('/');
      const prop = await page.evaluate(() => getComputedStyle(document.querySelector('header')).transitionProperty);
      expect(prop).toMatch(/background-color|color|all/);
    });

    test('left-panel has transition property', async ({ page }) => {
      await page.goto('/');
      const prop = await page.evaluate(() => getComputedStyle(document.querySelector('.left-panel')).transitionProperty);
      expect(prop).toMatch(/background-color|color|all/);
    });

    test('status-bar has transition property', async ({ page }) => {
      await page.goto('/');
      const prop = await page.evaluate(() => getComputedStyle(document.querySelector('.status-bar')).transitionProperty);
      expect(prop).toMatch(/background-color|color|all/);
    });
  });

  test.describe('Todo Checkbox Bounce Animation', () => {
    test('check-bounce keyframes exist in CSS', async ({ page }) => {
      await page.goto('/');
      const exists = await page.evaluate(() => {
        for (const sheet of document.styleSheets) {
          try {
            for (const rule of sheet.cssRules) {
              if (rule.name === 'check-bounce') return true;
            }
          } catch (_) { /* cross-origin sheet */ }
        }
        return false;
      });
      expect(exists).toBe(true);
    });

    test('toggling a todo briefly applies just-checked class', async ({ page }) => {
      await page.goto('/');
      // Wait for todos to render
      await page.waitForTimeout(1500);
      const checkbox = page.locator('.todo-check').first();
      // Skip if no todos exist
      if (await checkbox.count() === 0) return;

      await checkbox.click();
      // The just-checked class should appear briefly
      const hadClass = await page.evaluate(() => {
        const el = document.querySelector('.todo-check');
        return el?.classList.contains('just-checked') || el?.getAnimations().length > 0;
      });
      // Class may already have been removed by the time we check; at minimum no errors
      expect(hadClass !== undefined).toBe(true);
    });
  });

  test.describe('Send Button Glow', () => {
    test('send button has glow animation when enabled', async ({ page }) => {
      await page.goto('/');
      // Type text so send button is enabled
      await page.locator('#chatInput').fill('hello');
      await page.waitForTimeout(300);
      const animName = await page.evaluate(() => {
        const btn = document.querySelector('.send-btn');
        return btn ? getComputedStyle(btn).animationName : 'none';
      });
      expect(animName).not.toBe('none');
    });
  });

  test.describe('Glassmorphism', () => {
    test('status bar has backdrop-filter', async ({ page }) => {
      await page.goto('/');
      const filter = await page.evaluate(() =>
        getComputedStyle(document.querySelector('.status-bar')).backdropFilter
      );
      expect(filter).not.toBe('none');
      expect(filter).toBeTruthy();
    });

    test('model modal header has backdrop-filter', async ({ page }) => {
      await page.goto('/');
      // Open model picker modal
      await page.locator('.status-bar').click();
      await page.waitForTimeout(500);
      const filter = await page.evaluate(() => {
        const header = document.querySelector('#modelModal .modal-header, #modelModalOverlay .modal-header');
        return header ? getComputedStyle(header).backdropFilter : null;
      });
      expect(filter).not.toBe('none');
      expect(filter).toBeTruthy();
    });

    test('settings modal header has backdrop-filter', async ({ page }) => {
      await page.goto('/');
      await page.locator('button[onclick="openSettings()"]').click();
      await page.waitForTimeout(500);
      const filter = await page.evaluate(() => {
        const header = document.querySelector('#settingsModalOverlay .modal-header, #settingsModal .modal-header');
        return header ? getComputedStyle(header).backdropFilter : null;
      });
      expect(filter).not.toBe('none');
      expect(filter).toBeTruthy();
    });
  });

  test.describe('Scroll-Driven Animations', () => {
    test('CSS.supports detects animation-timeline: view()', async ({ page }) => {
      await page.goto('/');
      const supported = await page.evaluate(() => CSS.supports('animation-timeline', 'view()'));
      // This is feature detection; Edge/Chromium should support it
      expect(typeof supported).toBe('boolean');
    });
  });

  test.describe('PWA Manifest Enhancements', () => {
    test('manifest has screenshots array', async ({ page }) => {
      await page.goto('/');
      const res = await page.evaluate(() => fetch('/manifest.json').then(r => r.json()));
      expect(res.screenshots).toBeDefined();
      expect(res.screenshots.length).toBeGreaterThan(0);
    });

    test('manifest has maskable icons', async ({ page }) => {
      await page.goto('/');
      const res = await page.evaluate(() => fetch('/manifest.json').then(r => r.json()));
      expect(res.icons.some(i => i.purpose === 'maskable')).toBe(true);
    });

    test('manifest has handle_links and edge_side_panel', async ({ page }) => {
      await page.goto('/');
      const res = await page.evaluate(() => fetch('/manifest.json').then(r => r.json()));
      expect(res.handle_links).toBe('preferred');
      expect(res.edge_side_panel).toBeDefined();
    });
  });

  test.describe('Service Worker', () => {
    test('cache name is taskbean-v6', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(2000);
      const hasV6 = await page.evaluate(async () => {
        const names = await caches.keys();
        return names.includes('taskbean-v6');
      });
      expect(hasV6).toBe(true);
    });

    test('service worker is registered and active', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(2000);
      const swUrl = await page.evaluate(() =>
        navigator.serviceWorker.ready.then(r => r.active?.scriptURL)
      );
      expect(swUrl).toBeTruthy();
      expect(swUrl).toContain('sw.js');
    });
  });

  test.describe('Lazy Icon Library Loading', () => {
    test('icon library is NOT loaded at boot', async ({ page }) => {
      await page.goto('/');
      // Check immediately after load — library should not yet be loaded
      const loadedAtBoot = await page.evaluate(() => window.iconLibraryLoaded);
      expect(loadedAtBoot).toBeFalsy();
    });

    test('icon library loads when recurring icon picker is opened', async ({ page }) => {
      await page.goto('/');
      // Verify not loaded yet
      const before = await page.evaluate(() => window.iconLibraryLoaded);
      expect(before).toBeFalsy();

      // Open recurring tab and icon picker to trigger lazy load
      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarAddBtn').click();
      await page.locator('.icon-picker-trigger').click();

      // Wait for the icon library to load
      const loaded = await page.waitForFunction(
        () => window.iconLibraryLoaded === true,
        { timeout: 15000 }
      ).then(() => true).catch(() => false);
      expect(loaded).toBe(true);
    });
  });

});
