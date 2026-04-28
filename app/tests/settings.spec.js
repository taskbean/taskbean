import { test, expect } from '@playwright/test';

// Helper: open settings modal and wait for it to be visible
async function openSettings(page) {
  // The settings button may be in collapsed nav-rail (icon only) or expanded
  const settingsBtn = page.locator('button[onclick="openSettings()"]');
  await settingsBtn.waitFor({ state: 'visible', timeout: 5000 });
  await settingsBtn.click();
  await expect(page.locator('#settingsModalOverlay')).toHaveClass(/open/, { timeout: 5000 });
  // Wait for Lucide icons and config to load
  await page.waitForTimeout(800);
}

// Helper: switch to a settings tab and wait for panel
async function switchTab(page, tabId) {
  const tab = page.locator(`.settings-tab[data-panel="${tabId}"]`);
  await tab.click();
  await expect(page.locator(`#stgPanel-${tabId}`)).toHaveClass(/active/, { timeout: 3000 });
  await page.waitForTimeout(200);
}

test.describe('Settings Modal — UI Overhaul', () => {

  // ═══════════════════════════════════════════════════════════════
  // Modal Shell & Navigation
  // ═══════════════════════════════════════════════════════════════

  test.describe('Modal Shell', () => {
    test('settings modal opens and shows tabbed layout', async ({ page }) => {
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      await page.goto('/');
      await openSettings(page);

      // Verify modal structure
      await expect(page.locator('.settings-modal')).toBeVisible();
      await expect(page.locator('.settings-sidebar')).toBeVisible();
      await expect(page.locator('.settings-content')).toBeVisible();
      await expect(page.locator('.settings-search')).toBeVisible();

      // Verify 6 sidebar tabs exist (Inference & Voice merged)
      const tabs = page.locator('.settings-sidebar .settings-tab');
      await expect(tabs).toHaveCount(6);

      // No console errors
      expect(errors.filter(e => !e.includes('ExperimentalWarning'))).toHaveLength(0);
    });

    test('Escape closes settings modal', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await page.keyboard.press('Escape');
      await expect(page.locator('#settingsModalOverlay')).not.toHaveClass(/open/);
    });

    test('clicking overlay backdrop closes modal', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      // Click the overlay (not the modal content)
      await page.locator('#settingsModalOverlay').click({ position: { x: 10, y: 10 } });
      await expect(page.locator('#settingsModalOverlay')).not.toHaveClass(/open/);
    });

    test('footer shows coffee link and version', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await expect(page.locator('.coffee-btn')).toBeVisible();
      await expect(page.locator('.settings-footer')).toContainText('Foundry Local');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Tab Navigation
  // ═══════════════════════════════════════════════════════════════

  test.describe('Tab Navigation', () => {
    test('General tab is active by default', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      const generalTab = page.locator('.settings-tab[data-panel="general"]');
      await expect(generalTab).toHaveClass(/active/);
      await expect(page.locator('#stgPanel-general')).toHaveClass(/active/);
    });

    test('clicking each tab shows its panel', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);

      const tabIds = ['general', 'ai', 'inference', 'schedule', 'notifications', 'system'];
      for (const id of tabIds) {
        await switchTab(page, id);
        // Previous panel should be hidden
        for (const otherId of tabIds) {
          if (otherId !== id) {
            await expect(page.locator(`#stgPanel-${otherId}`)).not.toHaveClass(/active/);
          }
        }
      }
    });

    test('tab selection persists across modal close/reopen', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'system');
      // Close and reopen
      await page.keyboard.press('Escape');
      await openSettings(page);
      await expect(page.locator('.settings-tab[data-panel="system"]')).toHaveClass(/active/);
      await expect(page.locator('#stgPanel-system')).toHaveClass(/active/);
    });

    test('ARIA roles are correct on tabs and panels', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);

      // Sidebar has tablist role
      const sidebar = page.locator('.settings-sidebar');
      await expect(sidebar).toHaveAttribute('role', 'tablist');

      // Each tab has tab role and aria-selected
      const tabs = page.locator('.settings-sidebar .settings-tab');
      const count = await tabs.count();
      for (let i = 0; i < count; i++) {
        const tab = tabs.nth(i);
        await expect(tab).toHaveAttribute('role', 'tab');
        const selected = await tab.getAttribute('aria-selected');
        expect(['true', 'false']).toContain(selected);
      }

      // Each panel has tabpanel role
      const panels = page.locator('.settings-panel');
      const panelCount = await panels.count();
      for (let i = 0; i < panelCount; i++) {
        await expect(panels.nth(i)).toHaveAttribute('role', 'tabpanel');
      }
    });

    test('arrow keys navigate between tabs', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      const generalTab = page.locator('.settings-tab[data-panel="general"]');
      await generalTab.focus();
      // Press down to go to AI tab
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('.settings-tab[data-panel="ai"]')).toHaveClass(/active/);
      await expect(page.locator('#stgPanel-ai')).toHaveClass(/active/);
      // Press up to go back to General
      await page.keyboard.press('ArrowUp');
      await expect(page.locator('.settings-tab[data-panel="general"]')).toHaveClass(/active/);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // General Tab
  // ═══════════════════════════════════════════════════════════════

  test.describe('General Tab', () => {
    test('theme swatches are visible and one is active', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      const swatches = page.locator('.theme-swatch-btn');
      await expect(swatches).toHaveCount(4);
      // Exactly one should be active
      const activeSwatches = page.locator('.theme-swatch-btn.active');
      await expect(activeSwatches).toHaveCount(1);
    });

    test('clicking a theme swatch changes theme and updates active state', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      // Click latte
      await page.locator('.theme-swatch-btn[data-theme="latte"]').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'latte');
      await expect(page.locator('.theme-swatch-btn[data-theme="latte"]')).toHaveClass(/active/);
      // Dark roast should no longer be active
      await expect(page.locator('.theme-swatch-btn[data-theme="dark-roast"]')).not.toHaveClass(/active/);
      // Switch back
      await page.locator('.theme-swatch-btn[data-theme="dark-roast"]').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark-roast');
    });

    test('timezone dropdown is populated', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      const tz = page.locator('#settingsTimezone');
      await expect(tz).toBeVisible();
      const optionCount = await tz.locator('option').count();
      expect(optionCount).toBeGreaterThanOrEqual(10);
    });

    test('custom clock format input works', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      const input = page.locator('#settingsClockCustom');
      await expect(input).toBeVisible();
      await input.fill('YYYY-MM-DD HH:mm');
      // Verify the clock in status bar updates (it uses oninput)
      await page.waitForTimeout(500);
      const clockText = await page.locator('#clockValue').textContent();
      // Should match YYYY-MM-DD HH:mm pattern
      expect(clockText).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
      // Clear it back
      await input.fill('');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // AI Tab
  // ═══════════════════════════════════════════════════════════════

  test.describe('AI Tab', () => {
    test('hardware info card is visible', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'ai');
      const hwInfo = page.locator('#settingsHardwareInfo');
      await expect(hwInfo).toBeVisible();
      // Should have CPU, RAM, GPU, NPU labels
      await expect(hwInfo).toContainText('CPU');
      await expect(hwInfo).toContainText('RAM');
    });

    test('model preferences selects are visible', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'ai');
      await page.waitForTimeout(1000); // wait for model list to populate
      await expect(page.locator('#settingsModel')).toBeVisible();
      await expect(page.locator('#settingsPermission')).toBeVisible();
      await expect(page.locator('#settingsDevice')).toBeVisible();
    });

    test('hide incompatible toggle works and persists', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'ai');
      const toggle = page.locator('#settingsHideIncompat');
      await expect(toggle).toBeVisible();
      const initial = await toggle.getAttribute('aria-checked');

      await toggle.click();
      await page.waitForTimeout(800);
      const after = await toggle.getAttribute('aria-checked');
      expect(after).not.toBe(initial);

      // Verify persisted to server
      const cfg = await page.evaluate(() => fetch('/api/config').then(r => r.json()));
      expect(String(cfg.hideIncompatibleModels)).toBe(after);

      // Revert
      await toggle.click();
      await page.waitForTimeout(500);
    });

    test('tool-call-only toggle works', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'ai');
      const toggle = page.locator('#settingsToolCallOnly');
      const initial = await toggle.getAttribute('aria-checked');
      await toggle.click();
      await page.waitForTimeout(800);
      expect(await toggle.getAttribute('aria-checked')).not.toBe(initial);
      // Revert
      await toggle.click();
      await page.waitForTimeout(500);
    });

    test('preferred device dropdown persists to config', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'ai');
      await page.locator('#settingsDevice').selectOption('gpu');
      await page.waitForTimeout(800);
      const cfg = await page.evaluate(() => fetch('/api/config').then(r => r.json()));
      expect(cfg.preferredDevice).toBe('gpu');
      // Reset
      await page.locator('#settingsDevice').selectOption('auto');
      await page.waitForTimeout(500);
    });

    test('info-tip tooltips are present', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'ai');
      const tips = page.locator('#stgPanel-ai .info-tip');
      expect(await tips.count()).toBeGreaterThanOrEqual(2);
      // Hover to see tooltip
      await tips.first().hover();
      await expect(tips.first().locator('.tip-text')).toBeVisible();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Inference Tab
  // ═══════════════════════════════════════════════════════════════

  test.describe('Inference & Voice Tab', () => {
    test('all inference and voice controls are visible', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'inference');
      await expect(page.locator('#settingsInferenceClient')).toBeVisible();
      await expect(page.locator('#settingsParallelToolCalls')).toBeVisible();
      await expect(page.locator('#settingsShowReasoning')).toBeVisible();
      // Voice controls in same tab
      await expect(page.locator('#settingsSpeechEngine')).toBeVisible();
      await expect(page.locator('#settingsSpeechFallback')).toBeVisible();
      await expect(page.locator('#settingsMicDevice')).toBeVisible();
    });

    test('inference client dropdown persists', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'inference');
      await page.locator('#settingsInferenceClient').selectOption('responses');
      await page.waitForTimeout(1200);
      const cfg = await page.evaluate(() => fetch('/api/config').then(r => r.json()));
      expect(cfg.inferenceClient).toBe('responses');
      // Reset
      await page.locator('#settingsInferenceClient').selectOption('auto');
      await page.waitForTimeout(800);
    });

    test('show reasoning traces toggle uses unified stg-toggle', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'inference');
      const toggle = page.locator('#settingsShowReasoning');
      // Should be a button with stg-toggle class (not the old broken toggle-switch)
      await expect(toggle).toHaveAttribute('role', 'switch');
      const tagName = await toggle.evaluate(el => el.tagName.toLowerCase());
      expect(tagName).toBe('button');
      // Click and verify
      const initial = await toggle.getAttribute('aria-checked');
      await toggle.click();
      await page.waitForTimeout(800);
      expect(await toggle.getAttribute('aria-checked')).not.toBe(initial);
      // Revert
      await toggle.click();
      await page.waitForTimeout(500);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Voice Tab
  // ═══════════════════════════════════════════════════════════════

  // Voice controls are now in Inference & Voice tab (tested above)

  // ═══════════════════════════════════════════════════════════════
  // Schedule Tab
  // ═══════════════════════════════════════════════════════════════

  test.describe('Schedule Tab', () => {
    test('DND and Reminder Hours blocks are visible', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'schedule');
      await expect(page.locator('#settingsDnd')).toBeVisible();
      await expect(page.locator('#settingsReminder')).toBeVisible();
      await expect(page.locator('#settingsDndStart')).toBeVisible();
      await expect(page.locator('#settingsDndEnd')).toBeVisible();
      await expect(page.locator('#settingsReminderStart')).toBeVisible();
      await expect(page.locator('#settingsReminderEnd')).toBeVisible();
    });

    test('DND toggle updates aria-checked', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'schedule');
      const dndToggle = page.locator('#settingsDnd');
      const initial = await dndToggle.getAttribute('aria-checked');
      await dndToggle.click();
      await page.waitForTimeout(500);
      expect(await dndToggle.getAttribute('aria-checked')).not.toBe(initial);
      // Revert
      await dndToggle.click();
      await page.waitForTimeout(500);
    });

    test('day chips are rendered for both schedule blocks', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'schedule');
      // Wait for chips to render
      await page.waitForTimeout(500);
      const dndChips = page.locator('#settingsDndDays .settings-day-chip');
      const reminderChips = page.locator('#settingsReminderDays .settings-day-chip');
      await expect(dndChips).toHaveCount(7);
      await expect(reminderChips).toHaveCount(7);
    });

    test('clicking a day chip toggles its state', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'schedule');
      await page.waitForTimeout(800);
      const chip = page.locator('#settingsDndDays .settings-day-chip').first();
      await chip.waitFor({ state: 'visible', timeout: 3000 });
      const wasOn = await chip.evaluate(el => el.classList.contains('on'));
      await chip.click();
      await page.waitForTimeout(300);
      const isOn = await chip.evaluate(el => el.classList.contains('on'));
      expect(isOn).not.toBe(wasOn);
      // Revert
      await chip.click();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Notifications Tab
  // ═══════════════════════════════════════════════════════════════

  test.describe('Notifications Tab', () => {
    test('notification and nudge controls are visible', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'notifications');
      await expect(page.locator('#settingsNotif')).toBeVisible();
      await expect(page.locator('#settingsNudgeEnabled')).toBeVisible();
      await expect(page.locator('#settingsNudgeFreq')).toBeVisible();
      await expect(page.locator('#settingsThematicEnabled')).toBeVisible();
      await expect(page.locator('#settingsOverdueEnabled')).toBeVisible();
      await expect(page.locator('#settingsAutoIcon')).toBeVisible();
    });

    test('nudge toggle persists to localStorage', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => localStorage.removeItem('nudge-settings'));
      await openSettings(page);
      await switchTab(page, 'notifications');
      const toggle = page.locator('#settingsNudgeEnabled');
      // Click to disable
      await toggle.click();
      await page.waitForTimeout(300);
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('nudge-settings') || '{}'));
      expect(saved.enabled).toBe(false);
      // Re-enable
      await toggle.click();
    });

    test('frequency dropdown updates localStorage', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'notifications');
      await page.locator('#settingsNudgeFreq').selectOption('eager');
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('nudge-settings') || '{}'));
      expect(saved.intervalMs).toBe(60000);
      // Reset
      await page.locator('#settingsNudgeFreq').selectOption('normal');
    });

    test('thematic and overdue toggles persist', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => localStorage.removeItem('nudge-settings'));
      await openSettings(page);
      await switchTab(page, 'notifications');

      // Toggle thematic off
      await page.locator('#settingsThematicEnabled').click();
      await page.waitForTimeout(200);
      let saved = await page.evaluate(() => JSON.parse(localStorage.getItem('nudge-settings') || '{}'));
      expect(saved.thematic).toBe(false);

      // Toggle overdue off
      await page.locator('#settingsOverdueEnabled').click();
      await page.waitForTimeout(200);
      saved = await page.evaluate(() => JSON.parse(localStorage.getItem('nudge-settings') || '{}'));
      expect(saved.overdue).toBe(false);

      // Re-enable both
      await page.locator('#settingsThematicEnabled').click();
      await page.locator('#settingsOverdueEnabled').click();
    });

    test('auto-icon toggle syncs with server', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'notifications');
      const toggle = page.locator('#settingsAutoIcon');
      const initial = await toggle.getAttribute('aria-checked');
      await toggle.click();
      await page.waitForTimeout(800);

      const cfg = await page.evaluate(() => fetch('/api/config').then(r => r.json()));
      expect(String(cfg.autoSelectIcon)).toBe(await toggle.getAttribute('aria-checked'));

      // Revert
      await toggle.click();
      await page.waitForTimeout(500);
    });

    test('all notification toggles have switch role and aria-checked', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'notifications');
      const toggleIds = ['#settingsNotif', '#settingsNudgeEnabled', '#settingsThematicEnabled', '#settingsOverdueEnabled', '#settingsAutoIcon'];
      for (const id of toggleIds) {
        const toggle = page.locator(id);
        await expect(toggle).toHaveAttribute('role', 'switch');
        const checked = await toggle.getAttribute('aria-checked');
        expect(['true', 'false']).toContain(checked);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // System Tab
  // ═══════════════════════════════════════════════════════════════

  test.describe('System Tab', () => {
    test('port input and server controls are visible', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'system');
      await expect(page.locator('#settingsPort')).toBeVisible();
      await expect(page.locator('#settingsStartup')).toBeVisible();
      await expect(page.locator('#settingsServerBtn')).toBeVisible();
    });

    test('port auto-saves on blur (no explicit save button)', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'system');
      const portInput = page.locator('#settingsPort');
      // There should be NO explicit save button for port
      const saveBtns = page.locator('button', { hasText: /^Save$/ });
      await expect(saveBtns).toHaveCount(0);
      // Fill and blur to trigger auto-save
      await portInput.fill('8275');
      await portInput.blur();
    });

    test('action buttons are present in Data section', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'system');
      await expect(page.locator('button', { hasText: 'Clear Completed Todos' })).toBeVisible();
      await expect(page.locator('button', { hasText: 'Force Refresh Cache' })).toBeVisible();
      await expect(page.locator('button', { hasText: 'Export Todos (JSON)' })).toBeVisible();
    });

    test('run on startup toggle works', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      await switchTab(page, 'system');
      await page.waitForTimeout(500);
      const toggle = page.locator('#settingsStartup');
      const initial = await toggle.getAttribute('aria-checked');
      await toggle.click();
      await page.waitForTimeout(1200);
      expect(await toggle.getAttribute('aria-checked')).not.toBe(initial);
      // Revert
      await toggle.click();
      await page.waitForTimeout(800);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Settings Search
  // ═══════════════════════════════════════════════════════════════

  test.describe('Settings Search', () => {
    test('search input filters settings groups', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      const search = page.locator('#settingsSearch');
      await search.fill('theme');
      await page.waitForTimeout(300);
      // The theme group should still be visible
      const themeGroup = page.locator('[data-search-terms*="theme"]');
      await expect(themeGroup.first()).toBeVisible();
    });

    test('clearing search restores all groups', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      const search = page.locator('#settingsSearch');
      await search.fill('zzzznonexistent');
      await page.waitForTimeout(200);
      await search.fill('');
      await page.waitForTimeout(200);
      // All groups should be visible again
      const hiddenGroups = page.locator('.settings-group.search-hidden');
      await expect(hiddenGroups).toHaveCount(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Cross-Cutting Concerns
  // ═══════════════════════════════════════════════════════════════

  test.describe('Cross-Cutting', () => {
    test('all unified toggles have role=switch and aria-checked', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      const toggleIds = [
        '#settingsHideIncompat', '#settingsToolCallOnly',
        '#settingsShowReasoning', '#settingsDnd', '#settingsReminder',
        '#settingsStartup', '#settingsNotif',
        '#settingsNudgeEnabled', '#settingsThematicEnabled', '#settingsOverdueEnabled',
        '#settingsAutoIcon',
      ];
      // Visit all tabs to make toggles accessible
      for (const tabId of ['general', 'ai', 'inference', 'schedule', 'notifications', 'system']) {
        await switchTab(page, tabId);
      }
      for (const id of toggleIds) {
        const toggle = page.locator(id);
        await expect(toggle).toHaveAttribute('role', 'switch');
        const checked = await toggle.getAttribute('aria-checked');
        expect(['true', 'false']).toContain(checked);
      }
    });

    test('theme changes render correctly in all 4 themes', async ({ page }) => {
      await page.goto('/');
      await openSettings(page);
      const themes = ['dark-roast', 'latte', 'espresso', 'black-coffee'];
      for (const theme of themes) {
        await page.locator(`.theme-swatch-btn[data-theme="${theme}"]`).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        // Verify modal is still visible and styled
        await expect(page.locator('.settings-modal')).toBeVisible();
        await expect(page.locator('.settings-sidebar')).toBeVisible();
      }
      // Reset to dark-roast
      await page.locator('.theme-swatch-btn[data-theme="dark-roast"]').click();
    });

    test('non-settings toggles (clock) still use legacy settings-toggle', async ({ page }) => {
      await page.goto('/');
      // Check clock seconds toggle
      await page.locator('#chipClock').click();
      await page.waitForTimeout(300);
      const secToggle = page.locator('#clockSecondsToggle');
      if (await secToggle.isVisible()) {
        const classes = await secToggle.getAttribute('class');
        expect(classes).toContain('settings-toggle');
      }
    });

    test('reopening settings after reachability change refreshes controls', async ({ page }) => {
      await page.goto('/');
      // Wait for full load
      await page.waitForTimeout(2000);
      await openSettings(page);
      // Controls should not be disabled when server is reachable
      const modelSelect = page.locator('#settingsModel');
      // Navigate to AI tab first
      await switchTab(page, 'ai');
      await expect(modelSelect).not.toBeDisabled();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Responsive Layout
  // ═══════════════════════════════════════════════════════════════

  test.describe('Responsive Layout', () => {
    test('sidebar collapses to icons at narrow width', async ({ page }) => {
      await page.setViewportSize({ width: 650, height: 800 });
      await page.goto('/');
      await page.waitForTimeout(1000);
      await openSettings(page);
      // Tab labels should be hidden via CSS media query
      const label = page.locator('.settings-tab .tab-label').first();
      // The label exists but should be hidden by CSS
      await expect(label).toHaveCSS('display', 'none');
    });

    test('full layout at wide viewport', async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto('/');
      await openSettings(page);
      // Tab labels should be visible
      const label = page.locator('.settings-tab .tab-label').first();
      await expect(label).toBeVisible();
      // Sidebar should have proper width
      const sidebar = page.locator('.settings-sidebar');
      const box = await sidebar.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(140);
    });
  });

});


// ── Friday-release coverage: agent toggle rollback on POST failure (C1) ───

test.describe('Agents tab — toggle rollback on error', () => {
  test.use({ serviceWorkers: 'block' });
  test('toggle reverts aria-checked and surfaces .agent-settings-err on 500', async ({ page }) => {
    // Intercept the toggle POST BEFORE navigation so the first click is covered.
    await page.route('**/api/agent-usage/settings/copilot', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"boom"}' })
    );
    // Give the detection endpoint a deterministic "installed" response so the
    // toggle renders as a real (non-disabled) button we can click.
    await page.route('**/api/agent-usage/detection', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          copilot:       { installed: true,  enabled: false },
          'claude-code': { installed: false, enabled: false },
          codex:         { installed: false, enabled: false },
          opencode:      { installed: false, enabled: false },
        }),
      })
    );

    await page.goto('/');
    await openSettings(page);
    await switchTab(page, 'agents');

    const toggle = page.locator('.agent-settings-row[data-agent="copilot"] button.stg-toggle');
    await expect(toggle).toBeVisible({ timeout: 5000 });
    const before = await toggle.getAttribute('aria-checked');
    await toggle.click();

    // After the failed POST resolves, the button''s aria-checked must match the
    // pre-click value (rolled back) and the inline error must appear.
    await expect(page.locator('.agent-settings-row[data-agent="copilot"] .agent-settings-err')).toBeVisible({ timeout: 5000 });
    await expect(toggle).toHaveAttribute('aria-checked', before || 'false');
  });
});
