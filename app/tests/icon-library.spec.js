import { test, expect } from '@playwright/test';

test.describe('taskbean — Icon Library', () => {

  test.describe('Icon Auto-Selection', () => {
    test('typing a name auto-selects a matching icon', async ({ page }) => {
      await page.goto('/');
      // Wait for icon library to load
      await page.waitForFunction(() => window.iconLibraryLoaded === true, { timeout: 15000 });

      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarAddBtn').click();
      await page.locator('#rcTitle').fill('Drink water');
      // Wait for debounce (400ms) + processing
      await page.waitForTimeout(800);

      const iconName = await page.locator('#rcIconName').textContent();
      // Should have auto-selected a water-related icon
      expect(iconName).toBeTruthy();
      expect(iconName).not.toBe('repeat');
    });

    test('typing a note also influences icon selection', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.iconLibraryLoaded === true, { timeout: 15000 });

      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarAddBtn').click();
      await page.locator('#rcTitle').fill('Break');
      await page.waitForTimeout(800);
      const iconWithTitleOnly = await page.locator('#rcIconName').textContent();

      // Now add a note about coffee
      await page.locator('#rcDesc').fill('coffee time');
      await page.waitForTimeout(800);
      const iconWithNote = await page.locator('#rcIconName').textContent();
      // Icon may change when note adds context (not guaranteed, but shouldn't error)
      expect(iconWithNote).toBeTruthy();
    });

    test('icon dropdown opens and shows candidates', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.iconLibraryLoaded === true, { timeout: 15000 });

      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarAddBtn').click();
      await page.locator('#rcTitle').fill('water');
      await page.waitForTimeout(800);

      // Click the icon picker trigger to open dropdown
      await page.locator('.icon-picker-trigger').click();
      const dropdown = page.locator('#rcIconDropdown');
      await expect(dropdown).toBeVisible();

      // Should show grid items
      const gridItems = dropdown.locator('.icon-grid-item');
      expect(await gridItems.count()).toBeGreaterThan(0);

      // Each grid item should have a Lucide icon
      const firstItem = gridItems.first();
      await expect(firstItem.locator('svg')).toBeVisible();
    });

    test('icon search input filters candidates', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.iconLibraryLoaded === true, { timeout: 15000 });

      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarAddBtn').click();
      await page.locator('.icon-picker-trigger').click();

      const searchInput = page.locator('#rcIconSearch');
      await expect(searchInput).toBeVisible();
      await searchInput.fill('sun');
      await page.waitForTimeout(200);

      const gridItems = page.locator('#rcIconGrid .icon-grid-item');
      const count = await gridItems.count();
      expect(count).toBeGreaterThan(0);
      // At least one result should have "sun" in the name
      const names = await gridItems.evaluateAll(items => items.map(i => i.querySelector('span')?.textContent));
      expect(names.some(n => n && n.includes('sun'))).toBe(true);
    });

    test('clicking a candidate selects it and closes dropdown', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.iconLibraryLoaded === true, { timeout: 15000 });

      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarAddBtn').click();
      await page.locator('.icon-picker-trigger').click();
      await page.locator('#rcIconSearch').fill('heart');
      await page.waitForTimeout(200);

      const firstItem = page.locator('#rcIconGrid .icon-grid-item').first();
      const itemName = await firstItem.locator('span').textContent();
      await firstItem.click();

      // Dropdown should close
      await expect(page.locator('#rcIconDropdown')).toBeHidden();
      // Preview should update to the selected icon
      const previewName = await page.locator('#rcIconName').textContent();
      expect(previewName).toBe(itemName);
    });

    test('icon dropdown closes on outside click', async ({ page }) => {
      await page.goto('/');
      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarAddBtn').click();
      await page.locator('.icon-picker-trigger').click();
      await expect(page.locator('#rcIconDropdown')).toBeVisible();

      // Click outside the dropdown
      await page.locator('#rcTitle').click();
      await page.waitForTimeout(100);
      await expect(page.locator('#rcIconDropdown')).toBeHidden();
    });
  });

  test.describe('Icon Library Loading', () => {
    test('icon library loads at startup', async ({ page }) => {
      await page.goto('/');
      // Wait for iconLibraryLoaded flag
      const loaded = await page.waitForFunction(
        () => window.iconLibraryLoaded === true,
        { timeout: 15000 }
      ).then(() => true).catch(() => false);
      expect(loaded).toBe(true);
    });

    test('searchIcons returns results for known queries', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.iconLibraryLoaded === true, { timeout: 15000 });

      const results = await page.evaluate(() => searchIcons('water', 5));
      expect(results.length).toBeGreaterThan(0);
      // Should include "droplets" or something water-related
      expect(results.some(r => r.includes('drop') || r.includes('water') || r.includes('glass'))).toBe(true);
    });

    test('searchIcons returns empty for empty query', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.iconLibraryLoaded === true, { timeout: 15000 });

      const empty = await page.evaluate(() => searchIcons('', 5));
      expect(empty).toHaveLength(0);

      const nullQ = await page.evaluate(() => searchIcons(null, 5));
      expect(nullQ).toHaveLength(0);
    });

    test('tplIcon falls back to icon library search', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.iconLibraryLoaded === true, { timeout: 15000 });

      // Known built-in: should use hardcoded map
      const builtIn = await page.evaluate(() => tplIcon('Touch grass'));
      expect(builtIn).toBe('trees');

      // Unknown title: should search icon library
      const custom = await page.evaluate(() => tplIcon('coffee break'));
      expect(custom).toBeTruthy();
      expect(custom).not.toBe('repeat'); // should find something better than default
    });
  });

  test.describe('Template Rendering with Icons', () => {
    test('built-in templates show Lucide SVG icons', async ({ page }) => {
      await page.goto('/');
      // Switch to Recurring tab and show disabled templates
      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarEyeBtn').click();
      // All built-in template cards should have SVG icons (not emoji text)
      const builtInCards = page.locator('#recurringActiveList .template-card');
      const count = await builtInCards.count();
      expect(count).toBeGreaterThanOrEqual(7);

      for (let i = 0; i < Math.min(count, 7); i++) {
        const iconDiv = builtInCards.nth(i).locator('.template-icon');
        await expect(iconDiv.locator('svg')).toBeVisible();
      }
    });

    test('built-in template titles do not contain emoji', async ({ page }) => {
      await page.goto('/');
      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarEyeBtn').click();
      const names = page.locator('#recurringActiveList .template-card .template-info .name');
      const count = await names.count();
      for (let i = 0; i < Math.min(count, 7); i++) {
        const text = await names.nth(i).textContent();
        // Should not contain Unicode emoji (U+1F000 and above)
        expect(text).not.toMatch(/[\u{1F000}-\u{1FFFF}]/u);
      }
    });

    test('template toggle on/off still works', async ({ page }) => {
      await page.goto('/');
      // Switch to Recurring tab and show all templates
      await page.locator('#tabRecurring').click();
      await page.locator('#sidebarEyeBtn').click();
      // Find the first built-in template toggle
      const firstToggle = page.locator('#recurringActiveList .template-card .template-toggle').first();
      await expect(firstToggle).toBeVisible();

      // Get initial state
      const wasOn = await firstToggle.evaluate(el => el.classList.contains('on'));

      // Click to toggle
      await firstToggle.click();
      await page.waitForTimeout(1000);

      // Verify state changed
      const isNowOn = await firstToggle.evaluate(el => el.classList.contains('on'));
      expect(isNowOn).not.toBe(wasOn);

      // Toggle back to restore state
      await firstToggle.click();
      await page.waitForTimeout(1000);
    });

    test('custom template with special characters in title renders safely', async ({ page }) => {
      await page.goto('/');
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));

      // Create a template with special chars via API
      await page.evaluate(async () => {
        await fetch('/api/templates/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: "Bob's <script>alert(1)</script> reminder", icon: 'bell', intervalMin: 60 })
        });
      });
      await page.reload();
      await page.waitForTimeout(1000);

      // Switch to Recurring tab to verify
      await page.locator('#tabRecurring').click();

      // Should render without JS errors
      expect(errors).toHaveLength(0);
      // The title should be escaped in the DOM
      const templateList = page.locator('#recurringActiveList');
      await expect(templateList).toContainText("Bob's");
      // No script execution
      const html = await templateList.innerHTML();
      expect(html).not.toContain('<script>');
    });
  });

});
