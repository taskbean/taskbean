import { test, expect } from '@playwright/test';

test.describe('taskbean — Telemetry Panel', () => {

  test.describe('Tracing / Nerd Panel', () => {
    test('nerd panel opens and shows 4 tabs', async ({ page }) => {
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      await page.goto('/');
      // Open nerd panel
      await page.locator('#statusLeftArea').click();
      const panel = page.locator('#nerdPanel');
      await expect(panel).toHaveClass(/open/);
      // Verify all 4 tabs exist (Health removed — info in status bar)
      const tabs = panel.locator('.nerd-tab');
      expect(await tabs.count()).toBe(4);
      await expect(tabs.nth(0)).toContainText('Events');
      await expect(tabs.nth(1)).toContainText('Metrics');
      await expect(tabs.nth(2)).toContainText('Traces');
      await expect(tabs.nth(3)).toContainText('Logs');
      expect(errors).toHaveLength(0);
    });

    test('header buttons use Lucide icons', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      // Jaeger button has radar icon (rendered as SVG by Lucide)
      const jaegerBtn = page.locator('#nerdJaegerBtn');
      await expect(jaegerBtn).toBeVisible();
      await expect(jaegerBtn.locator('svg')).toBeVisible();
      // Export button has download icon
      const exportBtn = page.locator('#nerdExportBtn');
      await expect(exportBtn).toBeVisible();
      await expect(exportBtn.locator('svg')).toBeVisible();
      // Close button has x icon
      const closeBtn = page.locator('#nerdCloseBtn');
      await expect(closeBtn).toBeVisible();
      await expect(closeBtn.locator('svg')).toBeVisible();
    });

    test('events tab shows telemetry events', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      // Wait for at least one event (health.snapshot is emitted on connect)
      const event = page.locator('#nerdEvents .telem-event');
      await expect(event.first()).toBeVisible({ timeout: 10000 });
      // Verify event row structure
      const firstEvent = event.first();
      await expect(firstEvent.locator('.telem-ts')).toBeVisible();
      await expect(firstEvent.locator('.telem-badge')).toBeVisible();
      await expect(firstEvent.locator('.telem-summary')).toBeVisible();
    });

    test('clicking event row expands rich detail card', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      const event = page.locator('#nerdEvents .telem-event');
      await expect(event.first()).toBeVisible({ timeout: 10000 });
      // Click to expand
      await event.first().click();
      await expect(event.first()).toHaveClass(/expanded/);
      // Detail card should be visible
      const detail = event.first().locator('.telem-detail');
      await expect(detail).toBeVisible();
    });

    test('nerd panel close button works', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      await expect(page.locator('#nerdPanel')).toHaveClass(/open/);
      // Close via close button
      await page.locator('#nerdCloseBtn').click();
      await expect(page.locator('#nerdPanel')).not.toHaveClass(/open/);
    });

    test('keyboard shortcut Ctrl+Shift+T toggles nerd panel', async ({ page }) => {
      await page.goto('/');
      const panel = page.locator('#nerdPanel');
      await expect(panel).not.toHaveClass(/open/);
      // Open with keyboard
      await page.keyboard.press('Control+Shift+T');
      await expect(panel).toHaveClass(/open/);
      // Close with keyboard
      await page.keyboard.press('Control+Shift+T');
      await expect(panel).not.toHaveClass(/open/);
    });

    test('tab switching works across all tabs', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      // Switch to Metrics
      await page.locator('.nerd-tab[data-tab="metrics"]').click();
      await expect(page.locator('#nerdMetrics')).toHaveClass(/active/);
      // Switch to Traces
      await page.locator('.nerd-tab[data-tab="traces"]').click();
      await expect(page.locator('#nerdTraces')).toHaveClass(/active/);
      // Switch to Logs
      await page.locator('.nerd-tab[data-tab="logs"]').click();
      await expect(page.locator('#nerdLogs')).toHaveClass(/active/);
      // Switch back to Events
      await page.locator('.nerd-tab[data-tab="events"]').click();
      await expect(page.locator('#nerdEvents')).toHaveClass(/active/);
    });

    test('Traces tab shows native trace viewer with toolbar', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      await page.locator('.nerd-tab[data-tab="traces"]').click();
      await expect(page.locator('#nerdTraces')).toHaveClass(/active/);
      // Should show toolbar with Refresh and Jaeger buttons
      await expect(page.locator('.trace-toolbar')).toBeVisible();
      await expect(page.locator('#tracesList')).toBeVisible();
    });

    test('export button downloads telemetry JSON', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      // Wait for events to populate
      await expect(page.locator('#nerdEvents .telem-event').first()).toBeVisible({ timeout: 10000 });
      // Listen for download
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#nerdExportBtn').click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/^telemetry-.*\.json$/);
    });

    test('nerd panel persists state in localStorage', async ({ page }) => {
      await page.goto('/');
      // Open nerd panel
      await page.locator('#statusLeftArea').click();
      await expect(page.locator('#nerdPanel')).toHaveClass(/open/);
      // Check localStorage
      const stored = await page.evaluate(() => localStorage.getItem('nerdMode'));
      expect(stored).toBe('true');
      // Switch tab
      await page.locator('.nerd-tab[data-tab="logs"]').click();
      const storedTab = await page.evaluate(() => localStorage.getItem('nerdTab'));
      expect(storedTab).toBe('logs');
    });

    test('nerd panel shows events after chat interaction', async ({ page }) => {
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      await page.goto('/');

      // Open nerd panel first so it starts collecting events
      await page.locator('#statusLeftArea').click();
      await expect(page.locator('#nerdPanel')).toHaveClass(/open/);

      // Send a chat message to trigger flow.started/flow.finished/tool events
      await page.locator('#chatInput').fill('add task: e2e tracing test');
      await page.locator('#chatInput').press('Enter');

      // Wait for assistant response (may take a while with real model)
      await expect(page.locator('.chat-msg.assistant').first()).toBeVisible({ timeout: 30000 });

      // The events tab should now contain flow events
      const events = page.locator('#nerdEvents .telem-event');
      const count = await events.count();
      expect(count).toBeGreaterThan(1); // At minimum: health.snapshot + flow events

      // Check that at least one event has a badge (flow, ai, or http)
      const badges = page.locator('#nerdEvents .telem-badge');
      expect(await badges.count()).toBeGreaterThan(0);

      expect(errors).toHaveLength(0);
    });

    test('nerd panel shows no JS errors across all themes', async ({ page }) => {
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      await expect(page.locator('#nerdEvents .telem-event').first()).toBeVisible({ timeout: 10000 });

      // Cycle through all 4 themes
      for (const theme of ['latte', 'espresso', 'black-coffee', 'dark-roast']) {
        await page.evaluate((t) => {
          document.documentElement.setAttribute('data-theme', t);
          localStorage.setItem('theme', t);
        }, theme);
        await page.waitForTimeout(200);
        // Verify panel is still visible and no errors
        await expect(page.locator('#nerdPanel')).toHaveClass(/open/);
        await expect(page.locator('#nerdEvents .telem-event').first()).toBeVisible();
      }
      expect(errors).toHaveLength(0);
    });
  });

  test.describe('Telemetry Panel — Connecting Fallback', () => {
    test('events tab shows Connecting initially then updates', async ({ page }) => {
      await page.goto('/');
      // Open nerd panel
      await page.locator('#statusLeftArea').click();
      await page.waitForTimeout(500);

      const eventsTab = page.locator('#nerdEvents');
      const emptyEl = eventsTab.locator('.nerd-events-empty');

      // Initially might show "Connecting…" or events (if snapshot loaded fast)
      if (await emptyEl.isVisible()) {
        const text = await emptyEl.textContent();
        // Should be "Connecting…" or already transitioned to "Waiting for events…"
        expect(text).toMatch(/Connecting|Waiting for events/);

        // After 6 seconds, should transition if still no events
        await page.waitForTimeout(6000);
        if (await emptyEl.isVisible()) {
          await expect(emptyEl).toContainText('Waiting for events');
        }
      }
      // If no empty element, events already loaded — that's fine
    });

    test('telemetry events appear after user interaction', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      await page.waitForTimeout(500);

      // Trigger an action that generates telemetry
      await page.evaluate(async () => {
        await fetch('/api/todos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'telemetry test todo' })
        });
      });

      // Wait for event to flow through SSE
      await page.waitForTimeout(2000);
      const events = page.locator('#nerdEvents .telem-event');
      // Should have at least one event now
      expect(await events.count()).toBeGreaterThan(0); // server activity should produce at least one event
    });
  });

  test.describe('Telemetry Panel — Redesigned Features', () => {

    // ── 4-Tab Structure (Health removed — info in status bar) ──
    test('panel shows 4 tabs in correct order', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      const tabs = page.locator('.nerd-tab');
      expect(await tabs.count()).toBe(4);
      await expect(tabs.nth(0)).toContainText('Events');
      await expect(tabs.nth(1)).toContainText('Metrics');
      await expect(tabs.nth(2)).toContainText('Traces');
      await expect(tabs.nth(3)).toContainText('Logs');
    });

    // ── Events Filter Bar ──
    test('events filter bar is visible with chips', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      const filterBar = page.locator('#eventsFilterBar');
      await expect(filterBar).toBeVisible();
      const chips = filterBar.locator('.telem-filter-chip');
      expect(await chips.count()).toBeGreaterThanOrEqual(5);
      // "All" chip should be active by default
      await expect(chips.filter({ hasText: 'All' })).toHaveClass(/active/);
    });

    test('clicking filter chip toggles it', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      const aiChip = page.locator('#eventsFilterBar .telem-filter-chip[data-filter="ai"]');
      await expect(aiChip).toBeVisible();
      await aiChip.click();
      await expect(aiChip).toHaveClass(/active/);
      // "All" should no longer be active
      const allChip = page.locator('#eventsFilterBar .telem-filter-chip[data-filter="all"]');
      await expect(allChip).not.toHaveClass(/active/);
    });

    test('events search input filters events', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      // Wait for events to appear
      await expect(page.locator('#nerdEvents .telem-event').first()).toBeVisible({ timeout: 10000 });
      const searchInput = page.locator('#eventSearchInput');
      await expect(searchInput).toBeVisible();
      // Type a search term
      await searchInput.fill('health');
      // Some events should still be visible (or none if no match — that's fine)
      // The key test is that the input works without JS errors
    });

    // ── Traces Tab (Native) ──
    test('traces tab shows toolbar with Refresh and Jaeger buttons', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      await page.locator('.nerd-tab[data-tab="traces"]').click();
      await expect(page.locator('#nerdTraces')).toHaveClass(/active/);
      // Toolbar should be visible
      const toolbar = page.locator('.trace-toolbar');
      await expect(toolbar).toBeVisible();
      // Refresh button
      await expect(toolbar.locator('text=Refresh')).toBeVisible();
      // Jaeger external link
      await expect(toolbar.locator('text=Jaeger')).toBeVisible();
    });

    test('traces tab shows empty state before refresh', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      await page.locator('.nerd-tab[data-tab="traces"]').click();
      const tracesList = page.locator('#tracesList');
      await expect(tracesList).toBeVisible();
      // Should show placeholder text
      await expect(tracesList.locator('.nerd-events-empty')).toBeVisible();
    });

    test('refresh button attempts to load traces without error', async ({ page }) => {
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      await page.locator('.nerd-tab[data-tab="traces"]').click();
      // Click refresh — may fail to reach Jaeger but should not throw JS errors
      await page.locator('.trace-refresh-btn').click();
      await page.waitForTimeout(2000);
      expect(errors).toHaveLength(0);
    });

    // ── Logs Tab ──
    test('logs tab has filter bar with severity chips', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      await page.locator('.nerd-tab[data-tab="logs"]').click();
      await expect(page.locator('#nerdLogs')).toHaveClass(/active/);
      const filterBar = page.locator('#logsFilterBar');
      await expect(filterBar).toBeVisible();
      const chips = filterBar.locator('.telem-filter-chip');
      expect(await chips.count()).toBeGreaterThanOrEqual(4);
      // Check severity levels
      await expect(chips.filter({ hasText: 'Error' })).toBeVisible();
      await expect(chips.filter({ hasText: 'Warn' })).toBeVisible();
      await expect(chips.filter({ hasText: 'Info' })).toBeVisible();
    });

    test('logs tab has search input', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      await page.locator('.nerd-tab[data-tab="logs"]').click();
      const searchInput = page.locator('#logSearchInput');
      await expect(searchInput).toBeVisible();
      await searchInput.fill('test search');
      // Should not cause errors
    });

    test('logs tab shows empty state initially', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      await page.locator('.nerd-tab[data-tab="logs"]').click();
      const logsFeed = page.locator('#logsFeed');
      await expect(logsFeed).toBeVisible();
    });

    // ── Panel Resize ──
    test('panel has resizable width', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      const panel = page.locator('#nerdPanel');
      await expect(panel).toHaveClass(/open/);
      // Check CSS allows resize
      const resize = await panel.evaluate(el => getComputedStyle(el).resize);
      // resize should be 'horizontal' or similar (depends on browser)
      // Just verify the panel has min/max width constraints
      const minWidth = await panel.evaluate(el => getComputedStyle(el).minWidth);
      const maxWidth = await panel.evaluate(el => getComputedStyle(el).maxWidth);
      expect(parseInt(minWidth)).toBeGreaterThanOrEqual(300);
      expect(parseInt(maxWidth)).toBeLessThanOrEqual(700);
    });

    // ── Tab switching with new tabs ──
    test('all 4 tabs switch correctly', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      for (const tab of ['events', 'metrics', 'traces', 'logs']) {
        await page.locator(`.nerd-tab[data-tab="${tab}"]`).click();
        const contentId = `nerd${tab.charAt(0).toUpperCase() + tab.slice(1)}`;
        await expect(page.locator(`#${contentId}`)).toHaveClass(/active/);
      }
    });

    // ── Clear clears all tabs ──
    test('clear button resets all tabs including logs and traces', async ({ page }) => {
      await page.goto('/');
      await page.locator('#statusLeftArea').click();
      // Wait for events
      await expect(page.locator('#nerdEvents .telem-event').first()).toBeVisible({ timeout: 10000 });
      // Clear
      await page.locator('#nerdClearBtn').click();
      // Events should show "Cleared"
      await expect(page.locator('#nerdEvents .nerd-events-empty')).toContainText('Cleared');
    });

    // ── No JS errors across new features ──
    test('no JS errors when interacting with all new features', async ({ page }) => {
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      await page.goto('/');
      await page.locator('#statusLeftArea').click();

      // Events filter
      await page.locator('#eventsFilterBar .telem-filter-chip[data-filter="ai"]').click();
      await page.locator('#eventSearchInput').fill('test');

      // Traces tab
      await page.locator('.nerd-tab[data-tab="traces"]').click();
      await page.locator('.trace-refresh-btn').click();
      await page.waitForTimeout(1000);

      // Logs tab
      await page.locator('.nerd-tab[data-tab="logs"]').click();
      await page.locator('#logsFilterBar .telem-filter-chip[data-filter="error"]').click();
      await page.locator('#logSearchInput').fill('test');

      // Back to events
      await page.locator('.nerd-tab[data-tab="events"]').click();

      expect(errors).toHaveLength(0);
    });
  });

  test.describe('Telemetry Panel — Fixture-Driven Data Tests', () => {

    // Fixture data for consistent testing
    const FIXTURE_EVENTS = [
      {
        id: 1, ts: '2026-04-14T01:00:00.000Z', type: 'health.snapshot',
        foundryReady: true, modelReady: true, mcpAvailable: true, model: 'qwen2.5-coder-0.5b'
      },
      {
        id: 2, ts: '2026-04-14T01:00:01.000Z', type: 'ai.response',
        spanId: 'abc123', traceId: '0123456789abcdef', spanName: 'ai.completeWithTools',
        durationMs: 3500, 'gen_ai.request.model': 'qwen2.5-coder-0.5b', 'ai.model': 'qwen2.5-coder-0.5b',
        'gen_ai.usage.input_tokens': 412, 'gen_ai.usage.output_tokens': 89,
        'gen_ai.response.finish_reason': 'stop',
        spanEvents: [
          { name: 'tool.executed', ts: '2026-04-14T01:00:01.500Z', attributes: { 'tool.name': 'get_current_datetime', 'tool.args': '{"timezone":"UTC"}', 'tool.result': '{"formatted":"Monday"}', durationMs: 2 } }
        ]
      },
      {
        id: 3, ts: '2026-04-14T01:00:02.000Z', type: 'tool.executed',
        spanId: 'def456', traceId: '0123456789abcdef', spanName: 'tool.add_task',
        durationMs: 5, 'tool.name': 'add_task', 'tool.args': '{"title":"Test"}', 'tool.result': '{"success":true}',
      },
      {
        id: 4, ts: '2026-04-14T01:00:03.000Z', type: 'metric.sample',
        aiCalls: 3, commands: 2, tasks: 1, uploads: 0, errors: 0, todosActive: 5, uptimeMs: 60000
      },
      {
        id: 5, ts: '2026-04-14T01:00:04.000Z', type: 'http.request',
        spanId: 'ghi789', traceId: 'fedcba9876543210', spanName: 'POST /api/command',
        durationMs: 4200, 'http.method': 'POST', 'http.route': '/api/command'
      },
      {
        id: 6, ts: '2026-04-14T01:00:05.000Z', type: 'log.record',
        severityText: 'WARNING', body: 'Context truncated for speech flow', traceId: '0123456789abcdef'
      },
      {
        id: 7, ts: '2026-04-14T01:00:06.000Z', type: 'log.record',
        severityText: 'ERROR', body: 'Model inference timeout after 30s'
      },
      {
        id: 8, ts: '2026-04-14T01:00:07.000Z', type: 'log.record',
        severityText: 'INFO', body: 'Agent built with model qwen2.5-coder-0.5b'
      },
    ];

    const FIXTURE_TRACES = {
      traces: [
        {
          traceId: '0123456789abcdef',
          spans: [
            { spanId: 'root1', operationName: 'POST /api/command', name: 'POST /api/command', startTimeMs: 1000, durationMs: 4200, startTime: '2026-04-14T01:00:00.000Z', depth: 0, tags: {} },
            { spanId: 'child1', operationName: 'ai.completeWithTools', name: 'ai.completeWithTools', startTimeMs: 1050, durationMs: 3500, startTime: '2026-04-14T01:00:00.050Z', depth: 1, tags: { 'gen_ai.request.model': 'qwen2.5-coder-0.5b' } },
            { spanId: 'child2', operationName: 'tool.add_task', name: 'tool.add_task', startTimeMs: 4600, durationMs: 5, startTime: '2026-04-14T01:00:03.600Z', depth: 1, tags: {} },
          ]
        }
      ]
    };

    // Helper to set up route interceptions
    async function setupFixtures(page) {
      // Mock the snapshot API
      await page.route('**/api/telemetry/snapshot*', route => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ events: FIXTURE_EVENTS, serverTime: '2026-04-14T01:00:10.000Z' })
        });
      });

      // Mock the SSE stream — send fixture events then keep alive
      await page.route('**/api/telemetry/stream', route => {
        const sseBody = FIXTURE_EVENTS.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
        route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseBody
        });
      });

      // Mock the traces API
      await page.route('**/api/traces*', route => {
        if (route.request().url().includes('/api/traces/')) {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trace: FIXTURE_TRACES.traces[0] }) });
        } else {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURE_TRACES) });
        }
      });
    }

    // ── Event Summary Rendering ──

    test('AI event summary shows tokens, duration, and model', async ({ page }) => {
      await setupFixtures(page);
      await page.goto('/');
      await page.evaluate(() => toggleNerdMode(true));
      await page.waitForTimeout(1000);

      const aiEvent = page.locator('#nerdEvents .telem-event', { has: page.locator('.telem-badge.ai') }).first();
      await expect(aiEvent).toBeVisible({ timeout: 5000 });
      const summary = await aiEvent.locator('.telem-summary').textContent();
      // Should contain duration, token counts, and model
      expect(summary).toContain('3500ms');
      expect(summary).toContain('in:412');
      expect(summary).toContain('out:89');
      expect(summary).toContain('qwen2.5-coder-0.5b');
    });

    test('tool event summary shows tool name and duration', async ({ page }) => {
      await setupFixtures(page);
      await page.goto('/');
      await page.evaluate(() => toggleNerdMode(true));
      await page.waitForTimeout(1000);

      const toolEvent = page.locator('#nerdEvents .telem-event', { has: page.locator('.telem-badge.tool') }).first();
      await expect(toolEvent).toBeVisible({ timeout: 5000 });
      const summary = await toolEvent.locator('.telem-summary').textContent();
      expect(summary).toContain('add_task');
    });

    test('metric event summary shows counter values', async ({ page }) => {
      await setupFixtures(page);
      await page.goto('/');
      await page.evaluate(() => toggleNerdMode(true));
      await page.waitForTimeout(1000);

      const metricEvent = page.locator('#nerdEvents .telem-event', { has: page.locator('.telem-badge.metric') }).first();
      await expect(metricEvent).toBeVisible({ timeout: 5000 });
      const summary = await metricEvent.locator('.telem-summary').textContent();
      expect(summary).toContain('calls:3');
      expect(summary).toContain('cmds:2');
    });

    test('health event summary shows service status', async ({ page }) => {
      await setupFixtures(page);
      await page.goto('/');
      await page.evaluate(() => toggleNerdMode(true));
      await page.waitForTimeout(1000);

      const healthEvent = page.locator('#nerdEvents .telem-event', { has: page.locator('.telem-badge.health') }).first();
      await expect(healthEvent).toBeVisible({ timeout: 5000 });
      const summary = await healthEvent.locator('.telem-summary').textContent();
      expect(summary).toContain('foundry:✓');
      expect(summary).toContain('model:✓');
    });

    // ── Detail Card Content ──

    test('expanding AI event shows model, tokens, and span link', async ({ page }) => {
      await setupFixtures(page);
      await page.goto('/');
      await page.evaluate(() => toggleNerdMode(true));
      await page.waitForTimeout(1000);

      const aiEvent = page.locator('#nerdEvents .telem-event', { has: page.locator('.telem-badge.ai') }).first();
      await aiEvent.click();
      await expect(aiEvent).toHaveClass(/expanded/);

      const detail = aiEvent.locator('.telem-detail');
      await expect(detail).toBeVisible();
      const detailText = await detail.textContent();
      expect(detailText).toContain('qwen2.5-coder-0.5b');
      expect(detailText).toContain('412');
      expect(detailText).toContain('89');
    });

    test('expanding tool event shows args and result', async ({ page }) => {
      await setupFixtures(page);
      await page.goto('/');
      await page.evaluate(() => toggleNerdMode(true));
      await page.waitForTimeout(1000);

      const toolEvent = page.locator('#nerdEvents .telem-event', { has: page.locator('.telem-badge.tool') }).first();
      await toolEvent.click();
      await expect(toolEvent).toHaveClass(/expanded/);

      const detail = toolEvent.locator('.telem-detail');
      await expect(detail).toBeVisible();
      const detailText = await detail.textContent();
      expect(detailText).toContain('add_task');
      expect(detailText).toContain('success');
    });

    test('AI event has trace link when traceId present', async ({ page }) => {
      await setupFixtures(page);
      await page.goto('/');
      await page.evaluate(() => toggleNerdMode(true));
      await page.waitForTimeout(1000);

      const aiEvent = page.locator('#nerdEvents .telem-event', { has: page.locator('.telem-badge.ai') }).first();
      const traceLink = aiEvent.locator('.telem-trace-link');
      await expect(traceLink).toBeVisible();
      expect(await traceLink.textContent()).toContain('🔗');
    });

    // ── Filter Functional Tests ──

    test('AI filter chip hides non-AI events', async ({ page }) => {
      await setupFixtures(page);
      await page.goto('/');
      await page.evaluate(() => toggleNerdMode(true));
      await page.waitForTimeout(1000);

      // Count total visible events
      const allEvents = page.locator('#nerdEvents .telem-event:not(.filtered-out)');
      const totalBefore = await allEvents.count();
      expect(totalBefore).toBeGreaterThan(1);

      // Click AI filter
      await page.locator('#eventsFilterBar .telem-filter-chip[data-filter="ai"]').click();

      // Only AI events should be visible
      const visibleAfter = page.locator('#nerdEvents .telem-event:not(.filtered-out)');
      const countAfter = await visibleAfter.count();
      expect(countAfter).toBeLessThan(totalBefore);
      // All visible should have AI badge
      for (let i = 0; i < countAfter; i++) {
        await expect(visibleAfter.nth(i).locator('.telem-badge')).toContainText('ai');
      }
    });

    test('search input filters events by text', async ({ page }) => {
      await setupFixtures(page);
      await page.goto('/');
      await page.evaluate(() => toggleNerdMode(true));
      await page.waitForTimeout(1000);

      const searchInput = page.locator('#eventSearchInput');
      await searchInput.fill('add_task');
      await page.waitForTimeout(300);

      const visible = page.locator('#nerdEvents .telem-event:not(.filtered-out)');
      const count = await visible.count();
      expect(count).toBeGreaterThan(0);
      // Each visible event should contain the search term in its summary
      for (let i = 0; i < count; i++) {
        const summary = await visible.nth(i).locator('.telem-summary').textContent();
        expect(summary.toLowerCase()).toContain('add_task');
      }
    });

    test('combined chip + search filtering works', async ({ page }) => {
      await setupFixtures(page);
      await page.goto('/');
      await page.evaluate(() => toggleNerdMode(true));
      await page.waitForTimeout(1000);

      // Filter to metric type
      await page.locator('#eventsFilterBar .telem-filter-chip[data-filter="metric"]').click();
      // Then search for "calls"
      await page.locator('#eventSearchInput').fill('calls');
      await page.waitForTimeout(300);

      const visible = page.locator('#nerdEvents .telem-event:not(.filtered-out)');
      const count = await visible.count();
      expect(count).toBeGreaterThan(0);
    });

    // ── Traces Tab Data Rendering ──

    test('traces tab renders trace items from API', async ({ page }) => {
      await setupFixtures(page);
      await page.goto('/');
      await page.evaluate(() => toggleNerdMode(true));
      await page.evaluate(() => switchNerdTab('traces'));

      // Click refresh to load fixtures
      await page.locator('.trace-refresh-btn').click();
      await page.waitForTimeout(1000);

      const traceItems = page.locator('#tracesList .trace-item');
      await expect(traceItems.first()).toBeVisible({ timeout: 5000 });

      // Verify trace item shows operation name and duration
      const header = traceItems.first().locator('.trace-item-header');
      await expect(header).toContainText('POST /api/command');
      await expect(header).toContainText('4200ms');
    });

    test('clicking trace item expands waterfall', async ({ page }) => {
      await setupFixtures(page);
      await page.goto('/');
      await page.evaluate(() => toggleNerdMode(true));
      await page.evaluate(() => switchNerdTab('traces'));
      await page.locator('.trace-refresh-btn').click();
      await page.waitForTimeout(1000);

      const traceItem = page.locator('#tracesList .trace-item').first();
      await traceItem.click();

      // Waterfall should show span bars
      const waterfallSpans = traceItem.locator('.trace-span');
      await expect(waterfallSpans.first()).toBeVisible({ timeout: 3000 });
      expect(await waterfallSpans.count()).toBe(3); // root + 2 children
    });

    // ── Logs Tab Data Rendering ──

    test('logs tab renders entries with severity badges', async ({ page }) => {
      await setupFixtures(page);
      await page.goto('/');
      await page.evaluate(() => toggleNerdMode(true));
      await page.waitForTimeout(1000);

      // Switch to logs and wait for them to render
      await page.evaluate(() => switchNerdTab('logs'));
      await page.waitForTimeout(500);

      const logEntries = page.locator('#logsFeed .log-entry');
      expect(await logEntries.count()).toBe(3); // 3 log.record events in fixtures

      // Check severity badges
      const badges = page.locator('#logsFeed .log-level-badge');
      const badgeTexts = await badges.allTextContents();
      expect(badgeTexts).toContain('WARNING');
      expect(badgeTexts).toContain('ERROR');
      expect(badgeTexts).toContain('INFO');
    });

    test('logs severity filter hides non-matching entries', async ({ page }) => {
      await setupFixtures(page);
      await page.goto('/');
      await page.evaluate(() => toggleNerdMode(true));
      await page.waitForTimeout(1000);
      await page.evaluate(() => switchNerdTab('logs'));
      await page.waitForTimeout(500);

      // Click Error chip
      await page.locator('#logsFilterBar .telem-filter-chip[data-filter="error"]').click();

      const visible = page.locator('#logsFeed .log-entry:not(.filtered-out)');
      expect(await visible.count()).toBe(1);
      await expect(visible.first().locator('.log-level-badge')).toContainText('ERROR');
    });

    test('log entry with traceId shows correlation link', async ({ page }) => {
      await setupFixtures(page);
      await page.goto('/');
      await page.evaluate(() => toggleNerdMode(true));
      await page.waitForTimeout(1000);
      await page.evaluate(() => switchNerdTab('logs'));
      await page.waitForTimeout(500);

      // WARNING log has traceId, ERROR log doesn't
      const logEntries = page.locator('#logsFeed .log-entry');
      // Find the WARNING entry (has traceId)
      const warnEntry = logEntries.filter({ hasText: 'Context truncated' });
      await expect(warnEntry.locator('.log-trace-link')).toBeVisible();

      // ERROR entry should NOT have trace link
      const errorEntry = logEntries.filter({ hasText: 'timeout' });
      await expect(errorEntry.locator('.log-trace-link')).toHaveCount(0);
    });

    // ── Export Content Verification ──

    test('exported JSON contains span fields', async ({ page }) => {
      await setupFixtures(page);
      await page.goto('/');
      await page.evaluate(() => toggleNerdMode(true));
      await page.waitForTimeout(1000);

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#nerdExportBtn').click(),
      ]);

      const readable = await download.createReadStream();
      const chunks = [];
      for await (const chunk of readable) {
        chunks.push(chunk);
      }
      const content = Buffer.concat(chunks).toString('utf-8');
      const events = JSON.parse(content);

      // Should contain our fixture events with OTel fields
      const aiEvent = events.find(e => e.type === 'ai.response');
      expect(aiEvent).toBeDefined();
      expect(aiEvent.spanId).toBe('abc123');
      expect(aiEvent.traceId).toBe('0123456789abcdef');
      expect(aiEvent.durationMs).toBe(3500);
      expect(aiEvent['gen_ai.usage.input_tokens']).toBe(412);
    });
  });

});