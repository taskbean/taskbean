import { test, expect } from '@playwright/test';

/**
 * Engine status indicator redesign — coverage for the three surfaces that
 * replaced the old "Foundry: init/error" chip:
 *   1. Status chip (role=button with embedded disclosure popover)
 *   2. Engine popover (title / body / details / restart action)
 *   3. Top alert banner (role=group with Restart engine + Dismiss)
 *
 * These tests drive the UI by calling the exposed updateStatusBarHealth()
 * function directly rather than waiting for real health events — that keeps
 * them deterministic and independent of model-load timing.
 */

// Helper: wait for the page to fully hydrate so the global functions we call
// via page.evaluate are available. The taskbean SPA exposes these after its
// init script runs, and a stray navigation / service-worker update can bounce
// the execution context — this makes tests robust against that.
async function loadAndWait(page) {
  await page.goto('/');
  // First wait — the functions have been declared in the initial script.
  await page.waitForFunction(
    () => typeof window.updateStatusBarHealth === 'function'
       && typeof window.setStatus === 'function',
    { timeout: 10_000 }
  );
  // Second wait — the service worker can trigger a reload ~1s after first
  // paint. Give that a moment to settle, then re-wait for the functions in
  // the (possibly new) context.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await page.waitForFunction(
    () => typeof window.updateStatusBarHealth === 'function',
    { timeout: 10_000 }
  );
}

// Helper: evaluate, retry once if the execution context was destroyed by a
// mid-test navigation (service-worker reload, view-transition, etc.).
async function safeEvaluate(page, fn, arg) {
  try {
    return await page.evaluate(fn, arg);
  } catch (e) {
    if (String(e).match(/Execution context was destroyed|not a function/)) {
      await page.waitForFunction(
        () => typeof window.updateStatusBarHealth === 'function',
        { timeout: 5_000 }
      );
      return await page.evaluate(fn, arg);
    }
    throw e;
  }
}

test.describe('Engine status — chip + popover + banner', () => {

  test('chip renders plain-English labels by state', async ({ page }) => {
    await loadAndWait(page);

    // Ready → "Engine"
    await safeEvaluate(page, () => window.updateStatusBarHealth({
      foundryReady: true, modelReady: true, model: '', modelAlias: '', startupError: null
    }));
    await expect(page.locator('#foundryLabel')).toHaveText('Engine');
    await expect(page.locator('#foundryDot')).toHaveClass(/ok/);
    await expect(page.locator('#foundryAlertIcon')).toBeHidden();

    // Warming → "Warming up…"
    await safeEvaluate(page, () => window.updateStatusBarHealth({
      foundryReady: false, modelReady: false, startupError: null
    }));
    await expect(page.locator('#foundryLabel')).toHaveText(/Warming up/);
    await expect(page.locator('#foundryDot')).toHaveClass(/warn/);

    // Error → "Engine needs attention" + triangle-alert icon + pulsing ring class
    await safeEvaluate(page, () => window.updateStatusBarHealth({
      foundryReady: false, modelReady: false,
      startupError: 'Hardware execution providers failed to register.'
    }));
    await expect(page.locator('#foundryLabel')).toHaveText(/Engine needs attention/);
    await expect(page.locator('#chipFoundry')).toHaveClass(/engine-error/);
    await expect(page.locator('#foundryAlertIcon')).toBeVisible();
  });

  test('chip is keyboard-accessible and opens the popover', async ({ page }) => {
    await loadAndWait(page);

    const chip = page.locator('#chipFoundry');
    await expect(chip).toHaveAttribute('role', 'button');
    await expect(chip).toHaveAttribute('tabindex', '0');
    await expect(chip).toHaveAttribute('aria-expanded', 'false');

    // Open with click
    await chip.click();
    await expect(page.locator('#enginePopover')).toHaveClass(/open/);
    await expect(chip).toHaveAttribute('aria-expanded', 'true');

    // Escape closes
    await page.keyboard.press('Escape');
    await expect(page.locator('#enginePopover')).not.toHaveClass(/open/);
    await expect(chip).toHaveAttribute('aria-expanded', 'false');

    // Enter key opens
    await chip.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#enginePopover')).toHaveClass(/open/);
    await page.keyboard.press('Escape');
  });

  test('popover is a disclosure (role=group), NOT role=dialog', async ({ page }) => {
    await loadAndWait(page);

    const pop = page.locator('#enginePopover');
    await expect(pop).toHaveAttribute('role', 'group');
    await expect(pop).toHaveAttribute('aria-labelledby', 'enginePopoverTitle');

    // Chip must NOT advertise aria-haspopup=dialog (disclosure, not modal).
    const chip = page.locator('#chipFoundry');
    const hasPopup = await chip.getAttribute('aria-haspopup');
    expect(hasPopup).toBeNull();
  });

  test('popover body reflects plain-English error copy', async ({ page }) => {
    await loadAndWait(page);

    await safeEvaluate(page, () => window.updateStatusBarHealth({
      foundryReady: false, modelReady: false,
      startupError: 'Execution providers failed to register during cold-start.'
    }));

    const title = page.locator('#enginePopoverTitle');
    const body  = page.locator('#enginePopBody');
    // The title copy contains a curly apostrophe — match substring via
    // toContainText + a regex that accepts either apostrophe form.
    await expect(title).toContainText(/Engine (couldn't|couldn\u2019t) start/);
    await expect(body).toContainText(/AI drivers/);

    // Technical details wrapper is rendered (may be inside a collapsed
    // <details> so not "visible" until expanded — assert attached + text).
    const detailsWrap = page.locator('#enginePopDetailsWrap');
    await expect(detailsWrap).toBeAttached();
    const pre = page.locator('#enginePopPre');
    await expect(pre).toBeAttached();
    expect(await pre.textContent()).toMatch(/Execution providers failed/);

    // Restart action is offered inside the popover. Open the popover first.
    await page.locator('#chipFoundry').click();
    await expect(page.locator('#enginePopover')).toHaveClass(/open/);
    await expect(page.locator('#enginePopRestart')).toBeAttached();
    await page.keyboard.press('Escape');
  });
});

test.describe('Engine banner', () => {

  test('banner is hidden in healthy state and visible on startupError', async ({ page }) => {
    await loadAndWait(page);

    const banner = page.locator('#engineBanner');

    await safeEvaluate(page, () => window.updateStatusBarHealth({
      foundryReady: true, modelReady: true, startupError: null
    }));
    await expect(banner).not.toHaveClass(/show/);

    await safeEvaluate(page, () => window.updateStatusBarHealth({
      foundryReady: false, modelReady: false,
      startupError: 'Hardware execution providers failed to register.'
    }));
    await expect(banner).toHaveClass(/show/);
    await expect(page.locator('#engineBannerTitle')).toBeVisible();
    await expect(page.locator('#engineBannerRestart')).toBeVisible();
  });

  test('banner has correct a11y attributes and no conflicting role=alert', async ({ page }) => {
    await loadAndWait(page);

    const banner = page.locator('#engineBanner');
    await expect(banner).toHaveAttribute('aria-live', 'polite');
    await expect(banner).toHaveAttribute('aria-atomic', 'true');

    // The review flagged `role=alert` + `aria-live=polite` as conflicting —
    // role=alert should NOT be present.
    const role = await banner.getAttribute('role');
    expect(role).toBeNull();
  });

  test('banner dismiss button hides the banner', async ({ page }) => {
    await loadAndWait(page);

    await safeEvaluate(page, () => window.updateStatusBarHealth({
      foundryReady: false, modelReady: false,
      startupError: 'Execution providers failed to register.'
    }));

    const banner = page.locator('#engineBanner');
    await expect(banner).toHaveClass(/show/);

    await page.locator('#engineBanner .engine-banner-dismiss').click();
    await expect(banner).not.toHaveClass(/show/);
  });

  test('banner dismiss target is at least 32x32 (touch-target minimum)', async ({ page }) => {
    await loadAndWait(page);

    const size = await page.locator('#engineBanner .engine-banner-dismiss').evaluate(el => {
      const s = getComputedStyle(el);
      return { w: parseFloat(s.width), h: parseFloat(s.height) };
    });
    expect(size.w).toBeGreaterThanOrEqual(32);
    expect(size.h).toBeGreaterThanOrEqual(32);
  });
});

test.describe('Engine restart + backend', () => {

  test('backend exposes POST /api/shutdown endpoint', async ({ request }) => {
    const r = await request.get('/openapi.json');
    const spec = await r.json();
    expect(spec.paths['/api/shutdown']).toBeDefined();
    expect(spec.paths['/api/shutdown'].post).toBeDefined();
  });
});

