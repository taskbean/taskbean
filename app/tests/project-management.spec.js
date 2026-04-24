import { test, expect } from '@playwright/test';

// Block SW so page.route() intercepts work reliably.
test.use({ serviceWorkers: 'block' });

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_PROJECTS = [
  { name: 'taskbean',   path: 'C:\\dev\\taskbean',   total: 12, done: 8, pending: 4, hidden: 0, category: 'work',     skill_installed: 1 },
  { name: 'blog',       path: 'C:\\dev\\blog',       total: 3,  done: 1, pending: 2, hidden: 0, category: 'personal', skill_installed: 0 },
  { name: 'oss-lib',    path: 'C:\\dev\\oss-lib',    total: 7,  done: 7, pending: 0, hidden: 0, category: 'oss',      skill_installed: 1 },
  { name: 'old-project',path: 'C:\\dev\\old-project', total: 2,  done: 2, pending: 0, hidden: 1, category: null,       skill_installed: 0 },
];

const MOCK_TASKS = [
  { id: 't1', title: 'fix auth bug',      completed: false, project: 'taskbean', agent: 'copilot', createdAt: '2026-04-23' },
  { id: 't2', title: 'add caching layer', completed: true,  project: 'taskbean', agent: null,      createdAt: '2026-04-22' },
];

function mockProjectAPIs(page, projects = MOCK_PROJECTS) {
  return Promise.all([
    page.route('**/api/projects?*', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(projects) });
    }),
    page.route('**/api/projects/tasks*', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_TASKS) });
    }),
    // Stub usage + detection so the usage panel doesn't error
    page.route('**/api/agent-usage**', (route) => {
      if (route.request().url().includes('/detection')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ detection: {} }) });
      }
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ settings: {}, totals: { turns: 0, sessions: 0 }, byAgent: {}, byModel: [] }),
      });
    }),
  ]);
}

async function openProjectsTab(page) {
  await page.goto('/');
  await page.locator('#tabProjects').click();
  await expect(page.locator('#tabContentProjects')).toBeVisible();
}

// ── Filter bar ───────────────────────────────────────────────────────────────

test.describe('Project management — Filter bar', () => {

  test('filter bar renders category chips from project data', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    const bar = page.locator('#projectFilterBar');
    await expect(bar).toBeVisible();

    // All + 3 unique categories
    await expect(bar.locator('.project-filter-chip')).toHaveCount(4);
    await expect(bar.locator('.project-filter-chip').first()).toContainText('All');
    await expect(bar).toContainText('work');
    await expect(bar).toContainText('personal');
    await expect(bar).toContainText('oss');
  });

  test('"All" chip is active by default', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    const allChip = page.locator('.project-filter-chip', { hasText: 'All' });
    await expect(allChip).toHaveClass(/active/);
  });

  test('clicking a category chip filters project cards', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    // Before filter: 3 visible projects (old-project is hidden, not shown by default)
    await expect(page.locator('.project-card')).toHaveCount(3);

    // Click "work" chip
    await page.locator('[data-cat-filter="work"]').click();
    await expect(page.locator('.project-card')).toHaveCount(1);
    await expect(page.locator('.project-card')).toContainText('taskbean');
  });

  test('show-hidden toggle reveals hidden projects', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    // Initially 3 visible (hidden project excluded)
    await expect(page.locator('.project-card')).toHaveCount(3);

    // Toggle show-hidden
    await page.locator('[data-show-hidden]').check();
    await expect(page.locator('.project-card')).toHaveCount(4);

    // Hidden project should have reduced opacity class
    const hiddenCard = page.locator('.project-card.hidden-project');
    await expect(hiddenCard).toBeVisible();
    await expect(hiddenCard).toContainText('old-project');
  });

  test('filter bar hidden when no projects', async ({ page }) => {
    await mockProjectAPIs(page, []);
    await openProjectsTab(page);

    await expect(page.locator('#projectFilterBar')).toBeHidden();
    await expect(page.locator('.project-empty')).toContainText('No tracked projects');
  });
});

// ── Project cards ────────────────────────────────────────────────────────────

test.describe('Project management — Card rendering', () => {

  test('cards show category badges with correct classes', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    const workBadge = page.locator('.project-card-category.cat-work');
    await expect(workBadge).toBeVisible();
    await expect(workBadge).toContainText('work');

    const personalBadge = page.locator('.project-card-category.cat-personal');
    await expect(personalBadge).toBeVisible();
    await expect(personalBadge).toContainText('personal');

    const ossBadge = page.locator('.project-card-category.cat-oss');
    await expect(ossBadge).toBeVisible();
    await expect(ossBadge).toContainText('oss');
  });

  test('cards show skill-installed status indicator', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    // taskbean has skill_installed=1
    const taskbeanCard = page.locator('.project-card', { hasText: 'taskbean' });
    await expect(taskbeanCard.locator('.project-card-skill.installed')).toBeVisible();

    // blog has skill_installed=0
    const blogCard = page.locator('.project-card', { hasText: 'blog' });
    await expect(blogCard.locator('.project-card-skill.not-installed')).toBeVisible();
  });

  test('hidden badge shows on hidden projects when visible', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    // Enable show-hidden
    await page.locator('[data-show-hidden]').check();

    const hiddenCard = page.locator('.project-card', { hasText: 'old-project' });
    await expect(hiddenCard.locator('.project-card-hidden-badge')).toContainText('hidden');
  });

  test('task count badge shows total tasks', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    const taskbeanCard = page.locator('.project-card', { hasText: 'taskbean' });
    await expect(taskbeanCard.locator('.project-card-badge')).toContainText('12 tasks');
  });

  test('done/pending stats are rendered', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    const card = page.locator('.project-card', { hasText: 'taskbean' });
    await expect(card).toContainText('8 done');
    await expect(card).toContainText('4 pending');
  });

  test('project count badge in nav shows visible (non-hidden) count', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    // 3 visible out of 4 total
    await expect(page.locator('#projectCount')).toContainText('3');
  });
});

// ── Expand / collapse ────────────────────────────────────────────────────────

test.describe('Project management — Expand tasks', () => {

  test('clicking a card expands the task list', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    const card = page.locator('.project-card', { hasText: 'taskbean' });
    const tasks = card.locator('.project-card-tasks');
    await expect(tasks).toBeHidden();

    await card.click();
    await expect(tasks).toBeVisible();
    await expect(tasks).toContainText('fix auth bug');
  });

  test('clicking again collapses the task list', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    const card = page.locator('.project-card', { hasText: 'taskbean' });
    await card.click();
    await expect(card.locator('.project-card-tasks')).toBeVisible();

    await card.click();
    await expect(card.locator('.project-card-tasks')).toBeHidden();
  });
});

// ── Context menu ─────────────────────────────────────────────────────────────

test.describe('Project management — Context menu', () => {

  test('kebab button opens context menu', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    const card = page.locator('.project-card', { hasText: 'taskbean' });
    // Hover to reveal kebab
    await card.hover();
    await card.locator('[data-project-menu]').click();

    const menu = page.locator('.project-ctx-menu');
    await expect(menu).toBeVisible();
  });

  test('context menu has category select, hide, untrack, and delete actions', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    const card = page.locator('.project-card', { hasText: 'taskbean' });
    await card.hover();
    await card.locator('[data-project-menu]').click();

    const menu = page.locator('.project-ctx-menu');
    // Category submenu
    await expect(menu.locator('.project-ctx-submenu label')).toContainText(/category/i);
    await expect(menu.locator('select')).toBeVisible();

    // Action items
    await expect(menu.locator('[data-action="hide"]')).toContainText('Hide project');
    await expect(menu.locator('[data-action="untrack"]')).toContainText('Untrack project');
    await expect(menu.locator('[data-action="delete"]')).toContainText('Delete project');
  });

  test('context menu shows "Show project" for hidden projects', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    // Enable show-hidden to see old-project
    await page.locator('[data-show-hidden]').check();

    const hiddenCard = page.locator('.project-card', { hasText: 'old-project' });
    await hiddenCard.hover();
    await hiddenCard.locator('[data-project-menu]').click();

    const menu = page.locator('.project-ctx-menu');
    await expect(menu.locator('[data-action="show"]')).toContainText('Show project');
  });

  test('clicking outside closes context menu', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    const card = page.locator('.project-card', { hasText: 'taskbean' });
    await card.hover();
    await card.locator('[data-project-menu]').click();
    await expect(page.locator('.project-ctx-menu')).toBeVisible();

    // Click outside
    await page.locator('#usageSection').click();
    await expect(page.locator('.project-ctx-menu')).not.toBeVisible();
  });

  test('category select has preset options (work, personal, oss) plus none and custom', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    const card = page.locator('.project-card', { hasText: 'taskbean' });
    await card.hover();
    await card.locator('[data-project-menu]').click();

    const select = page.locator('.project-ctx-menu select');
    const options = await select.locator('option').allTextContents();
    expect(options).toContain('— none —');
    expect(options).toContain('work');
    expect(options).toContain('personal');
    expect(options).toContain('oss');
    expect(options).toContain('custom…');
  });

  test('hide action calls POST /api/projects/{name}/hide', async ({ page }) => {
    let hideRequest = null;
    await mockProjectAPIs(page);
    await page.route('**/api/projects/*/hide', (route) => {
      hideRequest = route.request();
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'hidden', project: 'taskbean' }) });
    });

    await openProjectsTab(page);

    const card = page.locator('.project-card', { hasText: 'taskbean' });
    await card.hover();
    await card.locator('[data-project-menu]').click();

    // Stub window.confirm for untrack/delete (hide doesn't need it)
    await page.locator('.project-ctx-menu [data-action="hide"]').click();
    expect(hideRequest).not.toBeNull();
    expect(hideRequest.method()).toBe('POST');
    expect(hideRequest.url()).toContain('/api/projects/taskbean/hide');
  });

  test('delete action shows confirm dialog', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    const card = page.locator('.project-card', { hasText: 'taskbean' });
    await card.hover();
    await card.locator('[data-project-menu]').click();

    // Set up confirm to return false (cancel)
    page.on('dialog', dialog => dialog.dismiss());
    await page.locator('.project-ctx-menu [data-action="delete"]').click();

    // Menu should close but no API call made
    await expect(page.locator('.project-ctx-menu')).not.toBeVisible();
  });
});

// ── Empty & edge states ──────────────────────────────────────────────────────

test.describe('Project management — Empty states', () => {

  test('shows "No projects match" when filter yields empty', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    // Set a non-existent category via JS (to avoid relying on a chip that doesn't exist)
    await page.evaluate(() => {
      window._projectCategoryFilter = 'nonexistent';
      window.renderProjects();
    });
    await page.waitForTimeout(500);

    await expect(page.locator('.project-empty')).toContainText('No projects match');
  });

  test('context menu animation class is present', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    const card = page.locator('.project-card', { hasText: 'taskbean' });
    await card.hover();
    await card.locator('[data-project-menu]').click();

    const menu = page.locator('.project-ctx-menu');
    await expect(menu).toBeVisible();
    // Verify the animation class exists via CSS
    const anim = await menu.evaluate(el => getComputedStyle(el).animationName);
    expect(anim).toBe('ctx-in');
  });
});

// ── Theme consistency ────────────────────────────────────────────────────────

test.describe('Project management — Theme consistency', () => {

  test('category badges use CSS custom properties, not hardcoded colors', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    // Work badge should use --accent-soft / --accent (from theme)
    const workBadge = page.locator('.project-card-category.cat-work');
    const bg = await workBadge.evaluate(el => getComputedStyle(el).backgroundColor);
    const color = await workBadge.evaluate(el => getComputedStyle(el).color);

    // Should NOT be hardcoded blue (#2563eb) — should resolve to accent from theme
    expect(bg).not.toContain('37, 99, 235'); // rgba of #2563eb
    expect(color).not.toContain('96, 165, 250'); // rgba of #60a5fa
  });

  test('filter bar border matches theme', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    const bar = page.locator('#projectFilterBar');
    const borderColor = await bar.evaluate(el => getComputedStyle(el).borderBottomColor);
    // Should resolve to var(--border), not transparent/none
    expect(borderColor).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('kebab button only visible on hover', async ({ page }) => {
    await mockProjectAPIs(page);
    await openProjectsTab(page);

    const kebab = page.locator('.project-card', { hasText: 'taskbean' }).locator('[data-project-menu]');
    // Not hovered — opacity 0
    const initialOpacity = await kebab.evaluate(el => getComputedStyle(el).opacity);
    expect(parseFloat(initialOpacity)).toBe(0);

    // Hover card — kebab becomes visible
    await page.locator('.project-card', { hasText: 'taskbean' }).hover();
    const hoverOpacity = await kebab.evaluate(el => getComputedStyle(el).opacity);
    expect(parseFloat(hoverOpacity)).toBe(1);
  });
});
