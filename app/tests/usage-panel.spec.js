import { test, expect } from '@playwright/test';

// Service worker caches /api/agent-usage — block so page.route() intercepts fire.
test.use({ serviceWorkers: 'block' });

// Friday-release coverage: multi-agent Usage panel rendering states.
// Selectors confirmed against public/index.html §usage-*, §loadUsageStats.

async function openProjects(page) {
  await page.goto('/');
  await page.locator('#tabProjects').click();
  await expect(page.locator('#usageContent')).toBeVisible();
}

test.describe('Usage panel — session-only copy (C2)', () => {
  test('renders Session-only tracking and no "0 tokens" for session-only agent', async ({ page }) => {
    // Two enabled agents so the per-agent breakdown renders.
    await page.route('**/api/agent-usage**', (route) => {
      if (route.request().url().includes('/detection')) return route.continue();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          settings: {
            copilot:       { enabled: 1 },
            'claude-code': { enabled: 1 },
          },
          totals: { turns: 2, sessions: 4, inputTokens: 100, outputTokens: 50 },
          byAgent: {
            copilot:       { turns: 2, sessions: 1, inputTokens: 100, outputTokens: 50 },
            'claude-code': { turns: 0, sessions: 3, inputTokens: 0,   outputTokens: 0  },
          },
          byModel: [],
        }),
      });
    });

    await openProjects(page);

    // Session-only copy should appear somewhere in the panel for claude-code.
    await expect(page.locator('#usageContent')).toContainText(/Session-only tracking/i, { timeout: 5000 });

    // The per-agent row for claude-code must NOT show a "0 out" / "0 tokens" stat —
    // it should render the session-only italic stat instead.
    const claudeRow = page.locator('.usage-agent-row', { hasText: 'Claude Code' });
    await expect(claudeRow).toBeVisible();
    await expect(claudeRow).not.toContainText(/0\s*out/i);
    await expect(claudeRow).not.toContainText(/0\s*tokens/i);
    await expect(claudeRow).toContainText(/3\s*sess/i);
  });
});

test.describe('Usage panel — empty state (C3)', () => {
  test('shows "Install or enable an agent" when no agents enabled & no data', async ({ page }) => {
    await page.route('**/api/agent-usage/detection', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          detection: {
            copilot:       { installed: false, enabled: false },
            'claude-code': { installed: false, enabled: false },
            codex:         { installed: false, enabled: false },
            opencode:      { installed: false, enabled: false },
          },
        }),
      })
    );
    await page.route('**/api/agent-usage?**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          settings: {}, // no enabled agents
          totals: { turns: 0, sessions: 0, inputTokens: 0, outputTokens: 0 },
          byAgent: {},
          byModel: [],
        }),
      })
    );

    await openProjects(page);
    await expect(page.locator('#usageContent')).toContainText(/Install or enable an agent/i, { timeout: 5000 });
    await expect(page.locator('.usage-empty-title')).toBeVisible();
  });
});

test.describe('Usage panel — offline banner (C4)', () => {
  test('shows "Couldn\'t reach the taskbean agent" without stale port advice on abort', async ({ page }) => {
    await page.route('**/api/agent-usage**', (route) => {
      if (route.request().url().includes('/detection')) return route.continue();
      return route.abort();
    });

    await openProjects(page);
    const errBox = page.locator('.usage-panel-error');
    await expect(errBox).toBeVisible({ timeout: 5000 });
    await expect(errBox).toContainText(/Couldn.?t reach the taskbean agent/i);
    await expect(errBox).not.toContainText(/:8275/);
  });
});

test.describe('Usage panel — effort and token efficiency', () => {
  test('renders effort and only shows tokens per task for linked work', async ({ page }) => {
    await page.route('**/api/agent-usage**', (route) => {
      if (route.request().url().includes('/detection')) return route.continue();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          settings: {
            copilot: { enabled: 1 },
            codex: { enabled: 1 },
          },
          totals: {
            turns: 5,
            sessions: 2,
            inputTokens: 0,
            outputTokens: 2800,
            totalTokens: 2800,
            toolCalls: 0,
            estimatedEffortMinutes: 15,
            tokensPerTask: 900,
          },
          byAgent: {
            copilot: {
              turns: 3,
              sessions: 1,
              outputTokens: 1800,
              estimatedEffortMinutes: 9,
              tokensPerTask: 900,
            },
            codex: {
              turns: 2,
              sessions: 1,
              outputTokens: 1000,
              estimatedEffortMinutes: 6,
            },
          },
          byModel: [],
        }),
      });
    });

    await openProjects(page);

    const content = page.locator('#usageContent');
    await expect(content.locator('.usage-stat', { hasText: 'Effort Minutes' })).toContainText('15');
    await expect(content.locator('.usage-stat', { hasText: 'Tokens / Task' })).toContainText('900');

    await page.locator('.usage-agent-chip', { hasText: 'Codex' }).click();
    await expect(content.locator('.usage-stat', { hasText: 'Effort Minutes' })).toContainText('6');
    await expect(content).not.toContainText('Tokens / Task');
  });
});
