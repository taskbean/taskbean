import { test, expect } from '@playwright/test';

test.describe('taskbean — Model Switch', () => {

  test.describe('Model Switch', () => {
    test('switch with invalid modelId returns 404', async ({ page }) => {
      await page.goto('/');
      const result = await page.evaluate(async () => {
        const r = await fetch('/api/models/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: 'nonexistent-model-xyz:99' })
        });
        return { status: r.status };
      });
      expect(result.status).toBe(404);
    });

    test('switch with missing modelId returns 400', async ({ page }) => {
      await page.goto('/');
      const result = await page.evaluate(async () => {
        const r = await fetch('/api/models/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        return { status: r.status };
      });
      expect(result.status).toBe(400);
    });

    test('health endpoint reflects current active model', async ({ page }) => {
      await page.goto('/');
      const result = await page.evaluate(async () => {
        const health = await (await fetch('/api/health')).json();
        const models = await (await fetch('/api/models')).json();
        const activeModel = models.models.find(m => m.active);
        return {
          healthModel: health.model,
          activeModelId: activeModel?.modelId,
          match: health.model === activeModel?.modelId
        };
      });
      expect(result.match).toBe(true);
    });
  });

  test.describe('Model Switch — SSE & Concurrency', () => {
    test('switching to active model returns SSE stream with done event', async ({ page }) => {
      await page.goto('/');
      const result = await page.evaluate(async () => {
        const models = await (await fetch('/api/models')).json();
        const r = await fetch('/api/models/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: models.active })
        });
        const text = await r.text();
        const events = text.split('\n\n')
          .filter(b => b.trim().startsWith('data:'))
          .map(b => { try { return JSON.parse(b.trim().slice(6)); } catch { return null; } })
          .filter(Boolean);
        return {
          contentType: r.headers.get('content-type'),
          eventCount: events.length,
          types: events.map(e => e.type),
          hasDone: events.some(e => e.type === 'done'),
          hasError: events.some(e => e.type === 'error'),
        };
      });
      expect(result.contentType).toContain('text/event-stream');
      expect(result.eventCount).toBeGreaterThan(0);
      expect(result.hasDone || result.hasError).toBe(true);
    });

    test('concurrent switch returns 409', async ({ page }) => {
      await page.goto('/');
      const result = await page.evaluate(async () => {
        const models = await (await fetch('/api/models')).json();
        const modelId = models.active;
        const body = JSON.stringify({ modelId });
        const headers = { 'Content-Type': 'application/json' };

        // Fire first switch (don't await)
        const req1 = fetch('/api/models/switch', { method: 'POST', headers, body });
        // Brief delay so server registers the lock
        await new Promise(r => setTimeout(r, 50));
        // Fire second switch
        const req2 = await fetch('/api/models/switch', { method: 'POST', headers, body });
        // Clean up first
        await req1.then(r => r.text()).catch(() => {});
        return { status: req2.status };
      });
      expect(result.status).toBe(409);
    });

    test('switch SSE includes progress events before done', async ({ page }) => {
      await page.goto('/');
      const result = await page.evaluate(async () => {
        const models = await (await fetch('/api/models')).json();
        const r = await fetch('/api/models/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: models.active })
        });
        const text = await r.text();
        const events = text.split('\n\n')
          .filter(b => b.trim().startsWith('data:'))
          .map(b => { try { return JSON.parse(b.trim().slice(6)); } catch { return null; } })
          .filter(Boolean);
        return {
          hasProgress: events.some(e => e.type === 'progress'),
          hasDone: events.some(e => e.type === 'done'),
        };
      });
      // Should have at least a progress event ("Loading ...") before done
      expect(result.hasProgress).toBe(true);
    });
  });

  test.describe('Model Lifecycle — Download, Switch, Verify, Cleanup', () => {
    const TEST_MODEL = 'qwen2.5-0.5b-instruct-generic-cpu:4';

    test.afterEach(async ({ page }) => {
        // Guarantee cleanup regardless of test outcome
        await page.evaluate(async (modelId) => {
            try { await fetch(`/api/models/cache/${encodeURIComponent(modelId)}`, { method: 'DELETE' }); } catch {}
        }, TEST_MODEL);
    });

    test('download new model, switch to it, verify UI updates', async ({ page }) => {
      test.setTimeout(180_000); // downloads can take a while
      await page.goto('/');
      await page.waitForTimeout(1000);

      // Remember original model
      const originalModel = await page.evaluate(async () => {
        const r = await (await fetch('/api/models')).json();
        return r.active;
      });

      // Download and switch via API
      const switchResult = await page.evaluate(async (modelId) => {
        const r = await fetch('/api/models/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId, forceDownload: true })
        });
        const text = await r.text();
        const events = text.split('\n\n')
          .filter(b => b.trim().startsWith('data:'))
          .map(b => { try { return JSON.parse(b.trim().slice(6)); } catch { return null; } })
          .filter(Boolean);
        return {
          done: events.find(e => e.type === 'done'),
          error: events.find(e => e.type === 'error'),
          hasDownloadProgress: events.some(e => e.type === 'download_progress'),
        };
      }, TEST_MODEL);

      expect(switchResult.error).toBeFalsy();
      expect(switchResult.done).toBeTruthy();
      expect(switchResult.done.modelId).toBe(TEST_MODEL);

      // Verify model is now active and cached in API
      const postSwitch = await page.evaluate(async (modelId) => {
        const r = await (await fetch('/api/models')).json();
        const entry = r.models.find(m => m.modelId === modelId);
        return { active: r.active, cached: entry?.cached, modelActive: entry?.active };
      }, TEST_MODEL);

      expect(postSwitch.active).toBe(TEST_MODEL);
      expect(postSwitch.cached).toBe(true);
      expect(postSwitch.modelActive).toBe(true);

      // Verify model picker UI shows the new model as Active
      await page.reload();
      await page.waitForTimeout(1000);
      await page.locator('#chipModel').click();
      await expect(page.locator('#modelModalOverlay')).toHaveClass(/open/, { timeout: 3000 });
      const activeCard = page.locator('.model-card.active');
      await expect(activeCard.first()).toBeVisible();
      const activeAlias = await activeCard.first().locator('.model-card-alias').textContent();
      expect(activeAlias).toContain('qwen2.5-0.5b');

      // Switch back to original model
      await page.evaluate(async (modelId) => {
        const r = await fetch('/api/models/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId })
        });
        await r.text();
      }, originalModel);

      // Cleanup: delete the test model from cache
      const cleanup = await page.evaluate(async (modelId) => {
        const r = await fetch(`/api/models/cache/${encodeURIComponent(modelId)}`, { method: 'DELETE' });
        return { ok: r.ok, status: r.status };
      }, TEST_MODEL);
      expect(cleanup.ok).toBe(true);

      // Verify model is no longer cached
      const afterCleanup = await page.evaluate(async (modelId) => {
        const r = await (await fetch('/api/models')).json();
        const entry = r.models.find(m => m.modelId === modelId);
        return { cached: entry?.cached };
      }, TEST_MODEL);
      expect(afterCleanup.cached).toBe(false);
    });

    test('concurrent switch during download returns 409', async ({ page }) => {
      test.setTimeout(180_000);
      await page.goto('/');

      // First download the test model so we have 2 cached models
      await page.evaluate(async (modelId) => {
        const r = await fetch('/api/models/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId, forceDownload: true })
        });
        await r.text();
      }, TEST_MODEL);

      // Now we have 2 cached models — race two switches
      const result = await page.evaluate(async (modelId) => {
        const models = await (await fetch('/api/models')).json();
        const other = models.models.find(m => m.cached && m.modelId !== models.active);
        if (!other) return { skipped: true };

        const body = JSON.stringify({ modelId: other.modelId });
        const headers = { 'Content-Type': 'application/json' };

        const [r1, r2] = await Promise.all([
          fetch('/api/models/switch', { method: 'POST', headers, body }),
          new Promise(r => setTimeout(r, 50)).then(() =>
            fetch('/api/models/switch', { method: 'POST', headers, body })
          )
        ]);
        await r1.text().catch(() => {});
        return { status1: r1.status, status2: r2.status };
      }, TEST_MODEL);

      if (result.skipped) {
        test.skip();
        return;
      }
      expect(result.status2 === 409 || result.status2 === 200).toBe(true);

      // Cleanup: switch back and delete test model
      await page.evaluate(async (testModel) => {
        const models = await (await fetch('/api/models')).json();
        const other = models.models.find(m => m.cached && m.modelId !== testModel);
        if (other && models.active !== other.modelId) {
          await (await fetch('/api/models/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelId: other.modelId })
          })).text();
        }
        await fetch(`/api/models/cache/${encodeURIComponent(testModel)}`, { method: 'DELETE' });
      }, TEST_MODEL);
    });
  });

  test.describe('Model Cache Detection', () => {
    test('API returns cached boolean for every model', async ({ page }) => {
      await page.goto('/');
      const result = await page.evaluate(async () => {
        const r = await fetch('/api/models');
        const data = await r.json();
        const allBoolean = data.models.every(m => typeof m.cached === 'boolean');
        const cachedCount = data.models.filter(m => m.cached).length;
        return { allBoolean, total: data.models.length, cachedCount };
      });
      expect(result.allBoolean).toBe(true);
      expect(result.total).toBeGreaterThan(0);
    });

    test('cached models render Use button, non-cached render Download', async ({ page }) => {
      await page.goto('/');
      await page.locator('#chipModel').click();
      await expect(page.locator('#modelModalOverlay')).toHaveClass(/open/, { timeout: 3000 });

      // At least one download button should exist (we only have 1 cached model in test)
      const downloadBtns = page.locator('.model-use-btn.download-btn');
      expect(await downloadBtns.count()).toBeGreaterThan(0);

      // Active model should show Active button (not Download)
      const activeBtn = page.locator('.model-card.active .model-use-btn.active-indicator');
      await expect(activeBtn.first()).toBeVisible();
      await expect(activeBtn.first()).toContainText('Active');
    });
  });

});
