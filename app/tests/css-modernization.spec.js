import { test, expect } from '@playwright/test';

test.describe('taskbean — CSS Modernization', () => {

  test.describe('prefers-color-scheme auto-detection', () => {
    test('dark color scheme sets dark-roast theme', async ({ page }) => {
      await page.addInitScript(() => localStorage.removeItem('taskbean-theme'));
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto('/');
      const theme = await page.evaluate(() =>
        document.documentElement.getAttribute('data-theme')
      );
      expect(theme).toBe('dark-roast');
    });

    test('light color scheme sets latte theme', async ({ page }) => {
      await page.addInitScript(() => localStorage.removeItem('taskbean-theme'));
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto('/');
      const theme = await page.evaluate(() =>
        document.documentElement.getAttribute('data-theme')
      );
      expect(theme).toBe('latte');
    });
  });

  test.describe('CSS :has() empty state hiding', () => {
    test('empty state is hidden when todo items exist', async ({ page }) => {
      await page.goto('/');
      // Ensure at least one todo item exists
      const hasTodos = await page.evaluate(() =>
        document.querySelectorAll('.todo-item').length > 0
      );
      if (!hasTodos) {
        // Add a todo so the list is not empty
        await page.evaluate(() => {
          if (typeof addTodo === 'function') {
            addTodo('Test task for CSS :has()');
          }
        });
        await page.waitForSelector('.todo-item');
      }
      const display = await page.evaluate(() => {
        const el = document.querySelector('.todo-list-container .empty-state');
        return el ? getComputedStyle(el).display : 'no-element';
      });
      expect(display).toBe('none');
    });
  });

  test.describe('Popover API', () => {
    test('clock popover has popover attribute', async ({ page }) => {
      await page.goto('/');
      const hasPopover = await page.evaluate(() =>
        document.getElementById('clockPopover')?.hasAttribute('popover') ?? false
      );
      expect(hasPopover).toBe(true);
    });

    test('mic popover has popover attribute', async ({ page }) => {
      await page.goto('/');
      const hasPopover = await page.evaluate(() =>
        document.getElementById('micPopover')?.hasAttribute('popover') ?? false
      );
      expect(hasPopover).toBe(true);
    });

    test('quick model popover has popover attribute', async ({ page }) => {
      await page.goto('/');
      const hasPopover = await page.evaluate(() =>
        document.getElementById('quickModelPopover')?.hasAttribute('popover') ?? false
      );
      expect(hasPopover).toBe(true);
    });
  });

  test.describe('View Transitions API', () => {
    test('document.startViewTransition is available', async ({ page }) => {
      await page.goto('/');
      const available = await page.evaluate(() =>
        typeof document.startViewTransition === 'function'
      );
      expect(available).toBe(true);
    });

    test('theme switch via View Transitions works', async ({ page }) => {
      await page.goto('/');
      const newTheme = await page.evaluate(() => {
        if (typeof setTheme === 'function') {
          setTheme('espresso');
        }
        return document.documentElement.getAttribute('data-theme');
      });
      expect(newTheme).toBe('espresso');
    });
  });

  test.describe('Container queries', () => {
    test('nerd panel has container-type: inline-size', async ({ page }) => {
      await page.goto('/');
      const containerType = await page.evaluate(() =>
        getComputedStyle(document.querySelector('.nerd-panel')).containerType
      );
      expect(containerType).toBe('inline-size');
    });

    test('left panel has container-type: inline-size', async ({ page }) => {
      await page.goto('/');
      const containerType = await page.evaluate(() =>
        getComputedStyle(document.querySelector('.left-panel')).containerType
      );
      expect(containerType).toBe('inline-size');
    });
  });

  test.describe('CSS nesting renders correctly', () => {
    const themes = ['latte', 'dark-roast', 'espresso', 'matcha'];

    for (const theme of themes) {
      test(`${theme} theme renders without JS errors`, async ({ page }) => {
        const errors = [];
        page.on('pageerror', err => errors.push(err.message));
        await page.goto('/');
        await page.evaluate(t => {
          if (typeof setTheme === 'function') setTheme(t);
        }, theme);
        // Allow any transitions / re-paints to settle
        await page.waitForTimeout(500);
        expect(errors).toHaveLength(0);
        await page.screenshot({
          path: `test-results/css-nesting-${theme}.png`,
          fullPage: true,
        });
      });
    }
  });

});
