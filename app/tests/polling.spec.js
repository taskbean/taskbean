import { test, expect } from '@playwright/test';

// Block the service worker so page.route / visibilitychange tracking is deterministic.
test.use({ serviceWorkers: 'block' });

// Friday-release coverage: polling + visibility-change refresh (H7).

test.describe('Projects/Usage polling — visibility refresh (H7)', () => {
  test('visibilitychange to visible triggers immediate refetch', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tabProjects').click();
    // Ensure projects tab is active + server is flagged reachable so the poll handler runs.
    await expect(page.locator('#tabContentProjects')).toHaveClass(/active/);
    await page.evaluate(() => { window.serverReachable = true; });
    // Let initial fetches settle.
    await page.waitForResponse(r => /\/api\/agent-usage(\?|$)/.test(r.url()), { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);

    // Install an in-page fetch counter so we don't race Playwright's response events
    // against the short (≤3s) window we're testing. We patch *both* window.fetch and
    // globalThis.fetch to catch any reference captured at module load time.
    await page.evaluate(() => {
      window.__pollHits = 0;
      const origFetch = window.fetch.bind(window);
      const wrapped = function (input, init) {
        try {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (/\/api\/agent-usage(\?|$)/.test(url) || /\/api\/projects(\?|$)/.test(url)) {
            window.__pollHits++;
          }
        } catch {}
        return origFetch(input, init);
      };
      window.fetch = wrapped;
      try { globalThis.fetch = wrapped; } catch {}
    });

    // Simulate tab becoming visible again. The visibilitychange handler early-returns
    // when document.hidden is true; we force it false then dispatch.
    await page.evaluate(() => {
      try {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      } catch {}
      window.serverReachable = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Expect a fresh fetch within 3s — not waiting for the 10s interval.
    await expect.poll(() => page.evaluate(() => window.__pollHits || 0), { timeout: 3000 }).toBeGreaterThan(0);
  });
});
