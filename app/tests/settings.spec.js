import { test, expect } from '@playwright/test';

test.describe('taskbean — Settings', () => {

  test.describe('Settings Panel', () => {
    test('settings modal opens and shows AI Suggestions section', async ({ page }) => {
      await page.goto('/');
      await page.locator('button[onclick="openSettings()"]').click();
      const overlay = page.locator('#settingsModalOverlay');
      await expect(overlay).toHaveClass(/open/);
      await expect(page.locator('#settingsNudgeEnabled')).toBeVisible();
      await expect(page.locator('#settingsNudgeFreq')).toBeVisible();
      await expect(page.locator('#settingsThematicEnabled')).toBeVisible();
      await expect(page.locator('#settingsOverdueEnabled')).toBeVisible();
    });

    test('nudge toggle persists to localStorage', async ({ page }) => {
      await page.goto('/');
      // Clear settings first
      await page.evaluate(() => localStorage.removeItem('nudge-settings'));
      await page.locator('button[onclick="openSettings()"]').click();
      const toggle = page.locator('#settingsNudgeEnabled');
      await expect(toggle).toBeVisible();
      // Click to disable
      await toggle.click();
      await expect(toggle).toHaveClass(/off/);
      // Check localStorage
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('nudge-settings') || '{}'));
      expect(saved.enabled).toBe(false);
    });

    test('frequency dropdown updates settings', async ({ page }) => {
      await page.goto('/');
      await page.locator('button[onclick="openSettings()"]').click();
      await page.locator('#settingsNudgeFreq').selectOption('eager');
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('nudge-settings') || '{}'));
      expect(saved.intervalMs).toBe(60000);
    });

    test('all settings toggles have ARIA switch role and labels', async ({ page }) => {
      await page.goto('/');
      await page.locator('button[onclick="openSettings()"]').click();
      const overlay = page.locator('#settingsModalOverlay');
      await expect(overlay).toHaveClass(/open/);

      const toggleIds = [
        { id: '#settingsHideIncompat', label: 'Hide incompatible models' },
        { id: '#settingsToolCallOnly', label: 'Only show tool-calling models' },
        { id: '#settingsStartup', label: 'Run on Windows startup' },
        { id: '#settingsNotif', label: 'Desktop notifications' },
        { id: '#settingsDnd', label: 'Do Not Disturb' },
        { id: '#settingsReminder', label: 'Reminder Hours' },
        { id: '#settingsAutoIcon', label: 'Auto-select icon' },
        { id: '#settingsNudgeEnabled', label: 'Proactive suggestions' },
        { id: '#settingsThematicEnabled', label: 'Thematic follow-ups' },
        { id: '#settingsOverdueEnabled', label: 'Overdue reminder cards' },
      ];

      for (const { id, label } of toggleIds) {
        const toggle = page.locator(id);
        await expect(toggle).toHaveAttribute('role', 'switch');
        await expect(toggle).toHaveAttribute('aria-label', label);
        // aria-checked should be either 'true' or 'false'
        const checked = await toggle.getAttribute('aria-checked');
        expect(['true', 'false']).toContain(checked);
      }
    });

    test('aria-checked updates when nudge toggle is clicked', async ({ page }) => {
      // Clear nudge settings first
      await page.evaluate(() => localStorage.removeItem('nudge-settings'));
      await page.goto('/');
      await page.locator('button[onclick="openSettings()"]').click();

      const toggle = page.locator('#settingsNudgeEnabled');
      const initialChecked = await toggle.getAttribute('aria-checked');
      await toggle.click();
      await page.waitForTimeout(300);
      const newChecked = await toggle.getAttribute('aria-checked');

      expect(newChecked).not.toBe(initialChecked);
      // Verify the class also changed
      if (initialChecked === 'true') {
        await expect(toggle).toHaveClass(/off/);
        expect(newChecked).toBe('false');
      } else {
        await expect(toggle).toHaveClass(/on/);
        expect(newChecked).toBe('true');
      }
    });

    test('save status message appears on settings change', async ({ page }) => {
      await page.goto('/');
      await page.locator('button[onclick="openSettings()"]').click();
      await page.waitForTimeout(1000); // let config load

      const status = page.locator('#settingsSaveStatus');
      // Click a server-backed toggle
      const toggle = page.locator('#settingsHideIncompat');
      await toggle.click();

      // Should show saving indicator then success
      // Use a generous timeout since it involves a network call
      await expect(status).toContainText(/Sav/, { timeout: 3000 });
    });
  });

  test.describe('Settings — Inference & System', () => {
    test('inference section shows all three controls', async ({ page }) => {
      await page.goto('/');
      await page.locator('button[onclick="openSettings()"]').click();
      await page.waitForTimeout(500);
      await expect(page.locator('#settingsInferenceClient')).toBeVisible();
      await expect(page.locator('#settingsParallelToolCalls')).toBeVisible();
      // Reasoning toggle may need scroll into view
      const reasoning = page.locator('#settingsShowReasoning');
      await reasoning.scrollIntoViewIfNeeded();
      await expect(reasoning).toBeVisible();
    });

    test('inference client dropdown persists to config', async ({ page }) => {
      await page.goto('/');
      await page.locator('button[onclick="openSettings()"]').click();
      await page.waitForTimeout(500);
      await page.locator('#settingsInferenceClient').selectOption('responses');
      await page.waitForTimeout(1000);
      const cfg = await page.evaluate(() => fetch('/api/config').then(r => r.json()));
      expect(cfg.inferenceClient).toBe('responses');
      // Reset
      await page.locator('#settingsInferenceClient').selectOption('auto');
      await page.waitForTimeout(500);
    });

    test('parallel tool calls dropdown persists to config', async ({ page }) => {
      await page.goto('/');
      await page.locator('button[onclick="openSettings()"]').click();
      await page.waitForTimeout(500);
      await page.locator('#settingsParallelToolCalls').selectOption('off');
      await page.waitForTimeout(1000);
      const cfg = await page.evaluate(() => fetch('/api/config').then(r => r.json()));
      expect(cfg.parallelToolCalls).toBe('off');
      // Reset
      await page.locator('#settingsParallelToolCalls').selectOption('auto');
      await page.waitForTimeout(500);
    });

    test('port input saves via API', async ({ page }) => {
      await page.goto('/');
      await page.locator('button[onclick="openSettings()"]').click();
      await page.waitForTimeout(500);
      const portInput = page.locator('#settingsPort');
      await portInput.fill('2326');
      await page.locator('button[onclick="savePortSetting()"]').click();
      await page.waitForTimeout(1000);
      const msgs = await page.evaluate(() => {
        const all = [...document.querySelectorAll('.chat-msg')];
        return all.slice(-2).map(m => m.textContent.trim().slice(0, 100));
      });
      expect(msgs.some(m => m.includes('Port set to'))).toBe(true);
    });
  });

  test.describe('Settings — Auto-Select Icon', () => {
    test('settings modal shows Reminders section with auto-icon toggle', async ({ page }) => {
      await page.goto('/');
      await page.locator('button[onclick="openSettings()"]').click();
      const overlay = page.locator('#settingsModalOverlay');
      await expect(overlay).toHaveClass(/open/);

      // Should have Reminders section
      await expect(page.locator('.settings-section-title', { hasText: 'Reminders' })).toBeVisible();
      await expect(page.locator('#settingsAutoIcon')).toBeVisible();
    });

    test('auto-icon toggle persists to localStorage', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => localStorage.removeItem('taskbean-auto-select-icon'));
      await page.locator('button[onclick="openSettings()"]').click();
      const toggle = page.locator('#settingsAutoIcon');
      await expect(toggle).toBeVisible();

      // Should default to on
      await expect(toggle).toHaveClass(/on/);

      // Click to disable
      await toggle.click();
      await expect(toggle).toHaveClass(/off/);

      const saved = await page.evaluate(() => localStorage.getItem('taskbean-auto-select-icon'));
      expect(saved).toBe('false');

      // Click to re-enable
      await toggle.click();
      await expect(toggle).toHaveClass(/on/);
      const savedOn = await page.evaluate(() => localStorage.getItem('taskbean-auto-select-icon'));
      expect(savedOn).toBe('true');
    });

    test('auto-icon toggle syncs with backend config', async ({ page }) => {
      await page.goto('/');
      await page.locator('button[onclick="openSettings()"]').click();
      const toggle = page.locator('#settingsAutoIcon');
      await toggle.click(); // toggle off

      // Wait for backend save
      await page.waitForTimeout(500);

      // Verify via API
      const config = await page.evaluate(async () => {
        const res = await fetch('/api/config');
        return res.json();
      });
      expect(config.autoSelectIcon).toBe(false);

      // Toggle back on
      await toggle.click();
      await page.waitForTimeout(500);
      const config2 = await page.evaluate(async () => {
        const res = await fetch('/api/config');
        return res.json();
      });
      expect(config2.autoSelectIcon).toBe(true);
    });

    test('settings reflect server-side autoSelectIcon value', async ({ page }) => {
      // Set config via API before loading
      await page.goto('/');
      await page.evaluate(async () => {
        await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autoSelectIcon: false })
        });
      });
      // Reload and check
      await page.reload();
      await page.locator('button[onclick="openSettings()"]').click();
      const toggle = page.locator('#settingsAutoIcon');
      await expect(toggle).toHaveClass(/off/);

      // Restore
      await page.evaluate(async () => {
        await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autoSelectIcon: true })
        });
      });
    });
  });

});
