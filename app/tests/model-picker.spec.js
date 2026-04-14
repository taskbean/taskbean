import { test, expect } from '@playwright/test';

test.describe('taskbean — Model Picker', () => {

  test.describe('Model API', () => {
    test('GET /api/models returns models with required fields', async ({ page }) => {
      await page.goto('/');
      const data = await page.evaluate(async () => {
        const r = await fetch('/api/models');
        return await r.json();
      });
      expect(data.models).toBeDefined();
      expect(Array.isArray(data.models)).toBe(true);
      expect(data.models.length).toBeGreaterThan(0);
      expect(data.active).toBeTruthy();

      for (const m of data.models) {
        expect(m.alias).toBeTruthy();
        expect(m.modelId).toBeTruthy(); // critical: was empty for GPU/CPU variants
        expect(m.device).toBeTruthy();
        expect(typeof m.cached).toBe('boolean');
        expect(Array.isArray(m.tasks)).toBe(true);
      }
    });

    test('device field is normalized to NPU, GPU, CPU, or Unknown', async ({ page }) => {
      await page.goto('/');
      const devices = await page.evaluate(async () => {
        const r = await fetch('/api/models');
        const data = await r.json();
        return [...new Set(data.models.map(m => m.device))];
      });
      for (const d of devices) {
        expect(['NPU', 'GPU', 'CPU', 'Unknown']).toContain(d);
      }
    });

    test('same alias has distinct modelId per device variant', async ({ page }) => {
      await page.goto('/');
      const result = await page.evaluate(async () => {
        const r = await fetch('/api/models');
        const data = await r.json();
        // Group by alias, check for duplicate modelIds within each group
        const byAlias = {};
        for (const m of data.models) {
          (byAlias[m.alias] ??= []).push(m);
        }
        const duplicates = [];
        for (const [alias, models] of Object.entries(byAlias)) {
          const ids = models.map(m => m.modelId);
          const unique = new Set(ids);
          if (unique.size !== ids.length) duplicates.push({ alias, ids });
        }
        return { duplicates, aliasCount: Object.keys(byAlias).length };
      });
      expect(result.aliasCount).toBeGreaterThan(0);
      expect(result.duplicates).toHaveLength(0);
    });

    test('exactly one model is marked active', async ({ page }) => {
      await page.goto('/');
      const activeCount = await page.evaluate(async () => {
        const r = await fetch('/api/models');
        const data = await r.json();
        return data.models.filter(m => m.active).length;
      });
      expect(activeCount).toBe(1);
    });

    test('cached models exist for at least one variant', async ({ page }) => {
      await page.goto('/');
      const cachedCount = await page.evaluate(async () => {
        const r = await fetch('/api/models');
        const data = await r.json();
        return data.models.filter(m => m.cached).length;
      });
      expect(cachedCount).toBeGreaterThan(0);
    });

    test('multiple device variants exist (GPU/CPU/NPU coverage)', async ({ page }) => {
      await page.goto('/');
      const devices = await page.evaluate(async () => {
        const r = await fetch('/api/models');
        const data = await r.json();
        return [...new Set(data.models.map(m => m.device))];
      });
      // Should have at least 2 device types in the catalog
      expect(devices.length).toBeGreaterThanOrEqual(2);
    });
  });

  test.describe('Model Picker UI', () => {
    test('model picker opens and shows model cards', async ({ page }) => {
      await page.goto('/');
      await page.locator('#chipModel').click();
      const overlay = page.locator('#modelModalOverlay');
      await expect(overlay).toHaveClass(/open/, { timeout: 3000 });
      const cards = page.locator('.model-card');
      expect(await cards.count()).toBeGreaterThan(0);
    });

    test('active model card has active class and Active button', async ({ page }) => {
      await page.goto('/');
      await page.locator('#chipModel').click();
      await expect(page.locator('#modelModalOverlay')).toHaveClass(/open/);
      const activeCard = page.locator('.model-card.active');
      await expect(activeCard.first()).toBeVisible({ timeout: 3000 });
      const activeBtn = activeCard.first().locator('.model-use-btn.active-indicator');
      await expect(activeBtn).toBeVisible();
      await expect(activeBtn).toContainText('Active');
    });

    test('cached non-active models show Use button', async ({ page }) => {
      await page.goto('/');
      // Check via API if there are cached non-active models
      const hasCachedNonActive = await page.evaluate(async () => {
        const r = await fetch('/api/models');
        const data = await r.json();
        return data.models.some(m => m.cached && !m.active);
      });
      if (!hasCachedNonActive) return; // skip if only one model is cached

      await page.locator('#chipModel').click();
      await expect(page.locator('#modelModalOverlay')).toHaveClass(/open/);
      // Find a Use button (non-active, non-download)
      const useBtn = page.locator('.model-use-btn:not(.active-indicator):not(.download-btn):not(.loading-btn)');
      await expect(useBtn.first()).toBeVisible({ timeout: 3000 });
      await expect(useBtn.first()).toContainText('Use');
    });

    test('non-cached models show Download button', async ({ page }) => {
      await page.goto('/');
      await page.locator('#chipModel').click();
      await expect(page.locator('#modelModalOverlay')).toHaveClass(/open/);
      const downloadBtn = page.locator('.model-use-btn.download-btn');
      await expect(downloadBtn.first()).toBeVisible({ timeout: 3000 });
      await expect(downloadBtn.first()).toContainText('Download');
    });

    test('model cards show alias and device badge', async ({ page }) => {
      await page.goto('/');
      await page.locator('#chipModel').click();
      await expect(page.locator('#modelModalOverlay')).toHaveClass(/open/);
      const firstCard = page.locator('.model-card').first();
      await expect(firstCard.locator('.model-card-alias')).toBeVisible();
      await expect(firstCard.locator('.model-card-alias')).not.toBeEmpty();
      // Device badge should show GPU, NPU, or CPU
      const badge = firstCard.locator('.model-badge');
      await expect(badge.first()).toBeVisible();
      const badgeText = await badge.first().textContent();
      expect(badgeText).toMatch(/GPU|NPU|CPU/);
    });

    test('device filter tabs filter visible models', async ({ page }) => {
      await page.goto('/');
      await page.locator('#chipModel').click();
      await expect(page.locator('#modelModalOverlay')).toHaveClass(/open/);
      const allCount = await page.locator('.model-card:visible').count();
      // Click GPU filter
      const gpuTab = page.locator('.model-filter-chip:has-text("GPU")');
      if (await gpuTab.isVisible()) {
        await gpuTab.click();
        const gpuCount = await page.locator('.model-card:visible').count();
        expect(gpuCount).toBeLessThanOrEqual(allCount);
        expect(gpuCount).toBeGreaterThan(0);
      }
    });

    test('close button dismisses model picker', async ({ page }) => {
      await page.goto('/');
      await page.locator('#chipModel').click();
      await expect(page.locator('#modelModalOverlay')).toHaveClass(/open/);
      await page.locator('.model-modal-close').click();
      await expect(page.locator('#modelModalOverlay')).not.toHaveClass(/open/);
    });
  });

  test.describe('Model Picker — Badges & Footer', () => {
    test('cached models show disk badge', async ({ page }) => {
      await page.goto('/');
      await page.locator('#chipModel').click();
      await expect(page.locator('#modelModalOverlay')).toHaveClass(/open/, { timeout: 3000 });
      const activeCard = page.locator('.model-card.active');
      await expect(activeCard.first()).toBeVisible();
      const hasDiskBadge = await page.evaluate(() => {
        const card = document.querySelector('.model-card.active');
        return card?.innerHTML.includes('💾') || card?.innerHTML.includes('cached');
      });
      expect(hasDiskBadge).toBe(true);
    });

    test('model picker footer shows cached count and GB', async ({ page }) => {
      await page.goto('/');
      await page.locator('#chipModel').click();
      await expect(page.locator('#modelModalOverlay')).toHaveClass(/open/, { timeout: 3000 });
      const footerText = await page.locator('#modelFooterText').textContent();
      expect(footerText).toMatch(/\d+ of \d+ models/);
      expect(footerText).toMatch(/GB cached/);
    });
  });

});
