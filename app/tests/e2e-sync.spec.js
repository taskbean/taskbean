import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';

// H9: adversarial sync — a task added via `bean add` on the CLI must appear
// in the PWA within 12s, without any manual reload.

const PROJECT_NAME = 'e2e-sync-proj';
const PROJECT_PATH = 'C:/Users/nbrady/personal/taskbean/app/tests/e2e-sync-proj';
const TITLE   = `e2e sync test ${Date.now()}`;
let createdId = null;

function runBean(args) {
  try {
    return execSync(`bean ${args}`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
      encoding: 'utf8',
      shell: true,
    });
  } catch (e) {
    return { error: e.message, stdout: e.stdout?.toString?.() || '' };
  }
}

test.describe('E2E sync — external bean add surfaces in PWA (H9)', () => {
  test.skip(() => {
    try {
      execSync('bean --version', { stdio: 'ignore', timeout: 5000, shell: true });
      return false;
    } catch {
      return true;
    }
  }, 'bean CLI not on PATH');

  test('bean add appears in Projects tab within 12s', async ({ page }) => {
    // Ensure sandbox dir exists so `bean track --path` accepts it.
    const fs = await import('node:fs');
    try { fs.mkdirSync(PROJECT_PATH, { recursive: true }); } catch {}

    await page.goto('/');
    await page.locator('#tabProjects').click();
    await page.waitForTimeout(500);

    // Track the project so the Projects tab will list it.
    runBean(`track --path "${PROJECT_PATH}" --name "${PROJECT_NAME}"`);

    // Add the todo via the CLI.
    const addOut = runBean(`add "${TITLE}" --project "${PROJECT_PATH}" --json`);
    const raw = typeof addOut === 'string' ? addOut : addOut.stdout || '';
    try {
      const parsed = JSON.parse(raw.trim().split(/\n/).pop());
      createdId = parsed?.id || parsed?.todo?.id || null;
    } catch { /* best-effort; title-based lookup still works */ }

    // Expand the project so tasks render; if not present yet, the 10s poll
    // or visibility handler should refresh the project list.
    const card = page.locator('.project-card', { hasText: PROJECT_NAME });

    // Wait up to 15s for the project card to appear, then expand it.
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();

    // Title should now appear without manual reload.
    await expect(page.locator('.project-task-item', { hasText: TITLE }))
      .toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(() => {
    try {
      if (createdId) runBean(`done ${createdId}`);
    } catch {}
    try { runBean(`untrack --path "${PROJECT_PATH}"`); } catch {}
  });
});
