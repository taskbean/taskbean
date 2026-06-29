import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.use({ serviceWorkers: 'block' });

const INDEX_HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

const MOCK_PROJECTS = [
  { name: 'taskbean', path: 'C:\\dev\\taskbean', total: 1, done: 0, pending: 1, hidden: 0, category: 'work', skill_installed: 1 },
];

const MOCK_TASKS = [
  { id: 't1', title: 'Canonical task', completed: false, project: 'taskbean', agent: 'copilot', createdAt: '2026-01-01T09:00:00Z' },
];

function makeSuggestions() {
  return [
    {
      id: 'sug-approve-0001',
      suggested_title: 'Review Chronicle API',
      suggested_project: 'taskbean',
      suggested_status: 'pending',
      evidence_summary: 'Implemented API endpoints from Chronicle metadata',
      confidence: 0.82,
      state: 'pending',
      occurred_at: '2026-01-01T10:00:00Z',
      evidence: [{
        id: 'tev-1',
        source: 'copilot',
        branch: 'chronicle-api',
        files_changed: ['app/agent/main.py'],
        pr_refs: ['#41'],
        issue_refs: ['#40'],
        summary: 'Safe evidence summary',
        confidence: 0.82,
        occurred_at: '2026-01-01T10:00:00Z',
      }],
    },
    {
      id: 'sug-link-0001',
      suggested_title: 'Link existing task evidence',
      suggested_project: 'taskbean',
      suggested_status: 'done',
      evidence_summary: 'Found evidence that belongs on an existing task',
      confidence: 0.74,
      state: 'pending',
      occurred_at: '2026-01-02T09:00:00Z',
      evidence: [],
    },
  ];
}

const REPORT_PREVIEW = {
  period: 'This Week',
  since: '2026-01-01',
  until: '2026-01-07',
  tasks: [{ id: 't1', title: 'Canonical task', completed: false, status: 'pending', project: 'taskbean' }],
  taskGroups: {
    completed: [],
    in_progress: [],
    blocked: [],
    pending: [{ id: 't1', title: 'Canonical task', completed: false, status: 'pending', project: 'taskbean' }],
  },
  chronicle: {
    available: true,
    reason: null,
    summary: { linkedEvidence: 1, pendingSuggestions: 1, autoLinked: 1 },
    evidence: [{
      todo_id: 't1',
      source: 'copilot',
      branch: 'chronicle-api',
      pr_refs: ['#41'],
      issue_refs: ['#40'],
      files_changed: ['app/agent/main.py'],
      summary: 'Safe evidence summary',
      confidence: 0.82,
      occurred_at: '2026-01-01T10:00:00Z',
    }],
    autoLinked: [{
      id: 'sug-auto-0001',
      suggested_title: 'Canonical task',
      linked_todo_id: 't1',
      confidence: 0.95,
      state: 'linked',
      auto_linked: true,
      decision_reason: 'same project, same branch, 1 shared file; runner-up: Nearby task',
      decision_details: { confidence: 0.95, matchedSignals: ['same project', 'same branch', '1 shared file'] },
      occurred_at: '2026-01-01T10:00:00Z',
    }],
    pendingSuggestions: [{
      id: 'sug-pending-0001',
      suggested_title: 'Needs review suggestion',
      evidence_summary: 'Potential untracked Chronicle work',
      confidence: 0.68,
      occurred_at: '2026-01-03T10:00:00Z',
    }],
  },
};

async function mockWeeklyReviewAPIs(page, suggestions = makeSuggestions(), options = {}) {
  const state = { suggestions, approveBody: null, linkBody: null, ignored: false, reportPreview: structuredClone(REPORT_PREVIEW) };
  const staleSuggestionIds = new Set(options.staleSuggestionIds || []);
  const isStaleDecision = url => [...staleSuggestionIds].some(id => url.includes(id));
  await Promise.all([
    page.route(/https?:\/\/localhost:8275\/(?:index\.html)?$/, route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: INDEX_HTML })
    ),
    page.route('**/api/health', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', model: 'test-model', modelAlias: 'test-model' }) })
    ),
    page.route('**/api/config', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schedule: null }) })
    ),
    page.route('**/api/templates', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
    ),
    page.route('**/api/skill-status', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: false }) })
    ),
    page.route('**/api/version', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ app: 'test', started_at: '2026-01-01T00:00:00Z' }) })
    ),
    page.route('**/api/projects?*', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PROJECTS) })
    ),
    page.route('**/api/projects/tasks*', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_TASKS) })
    ),
    page.route('**/api/todos', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_TASKS) })
    ),
    page.route('**/api/agent-usage**', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ settings: {}, totals: { turns: 0, sessions: 0 }, byAgent: {}, byModel: [] }),
      })
    ),
    page.route('**/api/reports/preview**', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.reportPreview) })
    ),
    page.route('**/api/task-detail/t1', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          task: { id: 't1', title: 'Canonical task', completed: false, project: 'taskbean', source: 'agent', created_at: '2026-01-01T09:00:00Z' },
          session: null,
          sourceCard: null,
          files: [],
          refs: [],
          tools: {},
          checkpoint: null,
          evidence: REPORT_PREVIEW.chronicle.evidence,
        }),
      })
    ),
    page.route('**/api/chronicle/suggestions**', async route => {
      const req = route.request();
      const url = req.url();
      if (req.method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'pending', count: state.suggestions.length, suggestions: state.suggestions }),
        });
      }
      if (url.endsWith('/undo-auto-link')) {
        state.suggestions = [...state.suggestions, {
          id: 'sug-auto-0001',
          suggested_title: 'Canonical task',
          suggested_project: 'taskbean',
          suggested_status: 'pending',
          evidence_summary: 'Auto-linked evidence summary',
          confidence: 0.95,
          state: 'pending',
          evidence: [],
        }];
        state.reportPreview.chronicle.autoLinked = [];
        state.reportPreview.chronicle.summary.autoLinked = 0;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ action: 'undo-auto-link', suggestion: state.suggestions.at(-1) }) });
      }
      if (url.endsWith('/approve')) {
        if (isStaleDecision(url)) {
          state.suggestions = state.suggestions.filter(s => !url.includes(s.id));
          return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: 'Suggestion was already approved elsewhere.' }) });
        }
        state.approveBody = JSON.parse(req.postData() || '{}');
        state.suggestions = state.suggestions.filter(s => !url.includes(s.id));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ action: 'approve', task: MOCK_TASKS[0], suggestion: {} }) });
      }
      if (url.endsWith('/link')) {
        if (isStaleDecision(url)) {
          state.suggestions = state.suggestions.filter(s => !url.includes(s.id));
          return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: 'Suggestion was already linked elsewhere.' }) });
        }
        state.linkBody = JSON.parse(req.postData() || '{}');
        state.suggestions = state.suggestions.filter(s => !url.includes(s.id));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ action: 'link', task: MOCK_TASKS[0], suggestion: {} }) });
      }
      if (url.endsWith('/ignore')) {
        if (isStaleDecision(url)) {
          state.suggestions = state.suggestions.filter(s => !url.includes(s.id));
          return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: 'Suggestion was already ignored elsewhere.' }) });
        }
        state.ignored = true;
        state.suggestions = state.suggestions.filter(s => !url.includes(s.id));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ action: 'ignore', suggestion: {} }) });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'not found' }) });
    }),
  ]);
  return state;
}

async function openProjects(page) {
  await page.goto('/');
  await page.locator('#tabProjects').click();
  await expect(page.locator('#chronicleReviewSection')).toBeVisible();
}

test.describe('Chronicle weekly review dashboard', () => {
  test('approves an edited suggestion and removes it from the pending inbox', async ({ page }) => {
    const state = await mockWeeklyReviewAPIs(page);
    await openProjects(page);

    const card = page.locator('[data-review-card="sug-approve-0001"]');
    await expect(card).toContainText('Review Chronicle API');
    await expect(card).toContainText('82%');
    await expect(card).toContainText('Implemented API endpoints');
    await expect(card.locator('#chronicle-work-date-sug-approve-0001')).toHaveValue('2026-01-01');

    await card.locator('#chronicle-title-sug-approve-0001').fill('');
    await card.locator('button', { hasText: 'Approve' }).click();
    await expect(card.locator('[data-review-error]')).toContainText('Title is required');
    expect(state.approveBody).toBeNull();

    await card.locator('#chronicle-title-sug-approve-0001').fill('Edited Chronicle API task');
    await card.locator('button', { hasText: 'Approve' }).click();

    await expect(page.locator('[data-review-card="sug-approve-0001"]')).toHaveCount(0);
    expect(state.approveBody).toMatchObject({
      title: 'Edited Chronicle API task',
      status: 'pending',
      workDate: '2026-01-01',
    });
  });

  test('links a suggestion to an existing task and ignores noise without reloading', async ({ page }) => {
    const state = await mockWeeklyReviewAPIs(page);
    await openProjects(page);

    const linkCard = page.locator('[data-review-card="sug-link-0001"]');
    await linkCard.locator('#chronicle-link-sug-link-0001').selectOption('t1');
    await linkCard.locator('button', { hasText: 'Link' }).click();
    await expect(page.locator('[data-review-card="sug-link-0001"]')).toHaveCount(0);
    expect(state.linkBody).toEqual({ todoId: 't1' });

    await page.locator('[data-review-card="sug-approve-0001"] button', { hasText: 'Ignore' }).click();
    await expect(page.locator('.review-empty')).toContainText('No pending suggestions');
    expect(state.ignored).toBe(true);
  });

  test('removes stale cards after already-decided responses and refreshes the inbox', async ({ page }) => {
    const state = await mockWeeklyReviewAPIs(page, makeSuggestions(), { staleSuggestionIds: ['sug-approve-0001'] });
    await openProjects(page);

    await page.locator('[data-review-card="sug-approve-0001"] button', { hasText: 'Approve' }).click();

    await expect(page.locator('[data-review-card="sug-approve-0001"]')).toHaveCount(0);
    await expect(page.locator('.review-notice')).toContainText('already approved elsewhere');
    await expect(page.locator('[data-review-card="sug-link-0001"]')).toBeVisible();
    expect(state.approveBody).toBeNull();
  });

  test('task detail shows linked Chronicle evidence', async ({ page }) => {
    await mockWeeklyReviewAPIs(page);
    await openProjects(page);

    await page.locator('.project-card', { hasText: 'taskbean' }).click();
    await page.locator('.project-task-item', { hasText: 'Canonical task' }).click();

    await expect(page.locator('#taskDetailPanel')).toBeVisible();
    await expect(page.locator('.task-detail-evidence-card')).toContainText('Chronicle evidence');
    await expect(page.locator('.task-detail-evidence-card')).toContainText('Safe evidence summary');
  });

  test('shows auto-linked evidence audit rows and can undo them to pending review', async ({ page }) => {
    await mockWeeklyReviewAPIs(page);
    await openProjects(page);

    const auditCard = page.locator('[data-auto-linked-card="sug-auto-0001"]');
    await expect(auditCard).toContainText('Canonical task');
    await expect(auditCard).toContainText('same project, same branch');

    await auditCard.locator('button', { hasText: 'Undo' }).click();

    await expect(page.locator('[data-auto-linked-card="sug-auto-0001"]')).toHaveCount(0);
    await expect(page.locator('[data-review-card="sug-auto-0001"]')).toBeVisible();
    await expect(page.locator('.review-notice')).toContainText('returned to pending review');
  });

  test('report builder toggles, copies, and exports Markdown', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async text => { window.__copiedText = text; } },
      });
    });
    await mockWeeklyReviewAPIs(page);
    await openProjects(page);

    const report = page.locator('#chronicleReportMarkdown');
    await expect(report).toHaveValue(/Canonical task/);
    await expect(report).toHaveValue(/Safe evidence summary/);
    await expect(report).toHaveValue(/Needs review suggestion/);

    await page.locator('#chronicleReportEvidence').uncheck();
    await expect(report).not.toHaveValue(/Safe evidence summary/);

    await page.locator('#chronicleCopyReportBtn').click();
    await expect.poll(() => page.evaluate(() => window.__copiedText || '')).toContain('Taskbean weekly review');

    const downloadPromise = page.waitForEvent('download');
    await page.locator('.review-builder-actions .review-action-btn', { hasText: 'Export' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('taskbean-weekly-review-week.md');
  });
});
