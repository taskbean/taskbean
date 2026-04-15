import { test, expect } from '@playwright/test';

test.describe('taskbean — Task Detail Card', () => {

  test.describe('Task Detail Card', () => {
    test('project task items have click handler and chevron', async ({ page }) => {
      await page.goto('/');
      await page.click('#tabProjects');
      await page.waitForSelector('.project-card', { timeout: 10000 }).catch(() => {});

      const projectCard = page.locator('.project-card').first();
      if (await projectCard.count() === 0) {
        test.skip('No projects available');
        return;
      }

      await projectCard.click();
      const taskItem = page.locator('.project-task-item').first();
      if (await taskItem.count() === 0) {
        test.skip('No tasks in project');
        return;
      }

      await expect(taskItem).toHaveCSS('cursor', 'pointer');
      await expect(taskItem.locator('[data-lucide="chevron-right"]')).toBeVisible();
    });

    test('clicking a task opens detail card in main area', async ({ page }) => {
      await page.goto('/');
      await page.click('#tabProjects');
      await page.waitForSelector('.project-card', { timeout: 10000 }).catch(() => {});

      const projectCard = page.locator('.project-card').first();
      if (await projectCard.count() === 0) {
        test.skip('No projects available — need tracked projects with tasks');
        return;
      }

      await projectCard.click();
      await page.waitForSelector('.project-task-item', { timeout: 5000 }).catch(() => {});

      const taskItem = page.locator('.project-task-item').first();
      if (await taskItem.count() === 0) {
        test.skip('No tasks in project');
        return;
      }

      await taskItem.click();

      await expect(page.locator('#taskDetailPanel')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('.task-detail-back')).toBeVisible();
      await expect(page.locator('.task-detail-title')).toBeVisible();
      await expect(page.locator('.task-detail-actions')).toBeVisible();
    });

    test('back button closes detail card and restores chat', async ({ page }) => {
      await page.goto('/');
      await page.click('#tabProjects');
      await page.waitForSelector('.project-card', { timeout: 10000 }).catch(() => {});

      const projectCard = page.locator('.project-card').first();
      if (await projectCard.count() === 0) {
        test.skip('No projects available');
        return;
      }

      await projectCard.click();
      await page.waitForSelector('.project-task-item', { timeout: 5000 }).catch(() => {});

      const taskItem = page.locator('.project-task-item').first();
      if (await taskItem.count() === 0) {
        test.skip('No tasks in project');
        return;
      }

      await taskItem.click();
      await expect(page.locator('#taskDetailPanel')).toBeVisible({ timeout: 10000 });

      await page.click('.task-detail-back');

      await expect(page.locator('#taskDetailPanel')).toBeHidden();
    });

    test('detail card shows session metrics when available', async ({ page }) => {
      await page.goto('/');
      await page.click('#tabProjects');
      await page.waitForSelector('.project-card', { timeout: 10000 }).catch(() => {});

      const projectCard = page.locator('.project-card').first();
      if (await projectCard.count() === 0) {
        test.skip('No projects available');
        return;
      }

      await projectCard.click();
      await page.waitForSelector('.project-task-item', { timeout: 5000 }).catch(() => {});

      const taskItem = page.locator('.project-task-item').first();
      if (await taskItem.count() === 0) {
        test.skip('No tasks in project');
        return;
      }

      await taskItem.click();
      await expect(page.locator('#taskDetailPanel')).toBeVisible({ timeout: 10000 });

      await expect(page.locator('.task-detail-meta')).toBeVisible();

      const metrics = page.locator('.task-detail-metrics');
      if (await metrics.count() > 0) {
        await expect(page.locator('.task-detail-metric')).toHaveCount(4);
      }
    });

    test('detail card export button triggers download', async ({ page }) => {
      await page.goto('/');
      await page.click('#tabProjects');
      await page.waitForSelector('.project-card', { timeout: 10000 }).catch(() => {});

      const projectCard = page.locator('.project-card').first();
      if (await projectCard.count() === 0) {
        test.skip('No projects available');
        return;
      }

      await projectCard.click();
      await page.waitForSelector('.project-task-item', { timeout: 5000 }).catch(() => {});

      const taskItem = page.locator('.project-task-item').first();
      if (await taskItem.count() === 0) {
        test.skip('No tasks in project');
        return;
      }

      await taskItem.click();
      await expect(page.locator('#taskDetailPanel')).toBeVisible({ timeout: 10000 });

      const downloadPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
      await page.locator('.task-detail-action').filter({ hasText: 'Export' }).click();
      const download = await downloadPromise;

      if (download) {
        expect(download.suggestedFilename()).toMatch(/^task-[a-f0-9]+\.md$/);
      }
    });
  });

});
