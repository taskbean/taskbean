import { test, expect } from '@playwright/test';

// Service worker caches /api/projects — block it so page.route() intercepts work.
test.use({ serviceWorkers: 'block' });

// Friday-release coverage: agent attribution badge on project task rows (H8).
// Selector source: public/index.html §project-task-item, .ptask-agent-badge.

const AGENTS = [
  { agent: 'copilot',      label: 'Copilot' },
  { agent: 'claude-code',  label: 'Claude' },   // loose match — AGENT_META label shape
  { agent: 'codex',        label: 'Codex' },
  { agent: 'opencode',     label: 'OpenCode' },
];

async function stubProjectsAndTasks(page, agent) {
  await page.route(/\/api\/projects(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        name: 'stub-proj',
        path: 'C:/tmp/stub-proj',
        total: 1, done: 0, pending: 1,
      }]),
    })
  );
  await page.route(/\/api\/projects\/tasks/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        id: `stub-task-${agent || 'none'}`,
        title: `stub task ${agent || 'no-agent'}`,
        completed: false,
        createdAt: '2026-04-16T17:00:00Z',
        agent: agent,
        project: 'stub-proj',
      }]),
    })
  );
}

for (const { agent, label } of AGENTS) {
  test(`ptask-agent-badge renders for ${agent}`, async ({ page }) => {
    await stubProjectsAndTasks(page, agent);

    await page.goto('/');
    await page.locator('#tabProjects').click();
    await expect(page.locator('.project-card', { hasText: 'stub-proj' })).toBeVisible({ timeout: 10000 });

    await page.locator('.project-card', { hasText: 'stub-proj' }).click();

    const badge = page.locator('.ptask-agent-badge');
    await expect(badge).toBeVisible({ timeout: 5000 });
    // Badge content is AGENT_META[agent].label; verify with loose match.
    await expect(badge).toContainText(new RegExp(label, 'i'));
  });
}

test('no ptask-agent-badge when task.agent is null', async ({ page }) => {
  await stubProjectsAndTasks(page, null);

  await page.goto('/');
  await page.locator('#tabProjects').click();
  await expect(page.locator('.project-card', { hasText: 'stub-proj' })).toBeVisible({ timeout: 10000 });
  await page.locator('.project-card', { hasText: 'stub-proj' }).click();

  await expect(page.locator('.project-task-item')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.ptask-agent-badge')).toHaveCount(0);
});
