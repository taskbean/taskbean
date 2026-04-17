// NOTE: Bump CACHE_NAME on every deploy that touches user-visible assets so
// old caches are invalidated on activate. Consider deriving this from a
// build-time constant in the future.
const CACHE_NAME = 'taskbean-v20';
const SHELL_ASSETS = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/taskbean-only.png',
  '/vendor/lucide.min.js',
  '/vendor/fast-json-patch.min.js'
];

// Read-only API endpoints eligible for network-first caching
const CACHEABLE_API = ['/api/todos', '/api/config', '/api/models', '/api/recurring', '/api/templates', '/api/projects'];

// Install: cache static assets only (NOT index.html — that's network-first)
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(SHELL_ASSETS).catch((err) => {
        console.error('[SW] Failed to cache shell assets:', err);
        throw err;
      })
    )
  );
  // Auto-activate on install. The paired `controllerchange` listener on the
  // page triggers a single location.reload() so the user gets fresh HTML
  // without a manual prompt. A broken update shouldn't ever strand clients
  // on an old SW again (see offline-mode regression, v19→v20).
  self.skipWaiting();
});

// Kept for clients that want to trigger activation explicitly (e.g. a future
// "update available — reload" UI). Harmless when skipWaiting() already ran.
// Respond to VERSION queries from the page. The page uses a MessageChannel
// reply port so it doesn't have to listen for broadcasts.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    const port = event.ports && event.ports[0];
    const payload = { type: 'VERSION', cache: CACHE_NAME };
    if (port) port.postMessage(payload);
    else event.source?.postMessage(payload);
  }
});

// Activate: clean old caches, enable navigation preload
self.addEventListener('activate', (e) => {
  e.waitUntil(
    Promise.all([
      // Clean old caches
      caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      ),
      // Enable navigation preload if supported
      self.registration.navigationPreload?.enable()
    ])
  );
  self.clients.claim();
});

// Fetch: network-first for cacheable APIs, skip SSE/POST, cache-first for static
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  if (url.pathname.startsWith('/api/')) {
    // Only cache GET requests to whitelisted read endpoints
    if (e.request.method === 'GET' && CACHEABLE_API.some(p => url.pathname === p)) {
      e.respondWith((async () => {
        try {
          const response = await fetch(e.request);
          if (response.ok) {
            const clone = response.clone();
            e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone)));
          }
          return response;
        } catch {
          const cached = await caches.match(e.request);
          return cached || new Response(JSON.stringify([]), {
            status: 503, headers: { 'Content-Type': 'application/json' }
          });
        }
      })());
      return;
    }
    // All other API calls (POST, SSE, health, etc.) — pass through
    return;
  }

  // Navigation: network-first (always get fresh HTML), cache as offline fallback
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        // Try navigation preload first
        const preloadResponse = await e.preloadResponse;
        if (preloadResponse) {
          const clone = preloadResponse.clone();
          e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', clone)));
          return preloadResponse;
        }
        // Otherwise fetch from network
        const response = await fetch(e.request);
        if (response.ok) {
          const clone = response.clone();
          e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', clone)));
        }
        return response;
      } catch {
        // Offline: fall back to cached index.html
        const cached = await caches.match('/index.html');
        if (cached) return cached;
        // Last-resort fallback. UTF-8 charset is required (em-dash is multi-byte)
        // and the page gives the user a way to retry without typing the URL.
        const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>taskbean — offline</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100dvh; display:flex; flex-direction:column;
         align-items:center; justify-content:center; gap:16px; padding:24px;
         font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background:#fafaf7; color:#2c1810; text-align:center; }
  @media (prefers-color-scheme: dark) {
    body { background:#1a1410; color:#e8ddd0; }
  }
  h1 { margin:0; font-size:18px; font-weight:600; }
  p  { margin:0; max-width:48ch; opacity:.75; }
  button { font:inherit; font-weight:600; padding:8px 16px; border-radius:6px;
           border:1px solid currentColor; background:transparent; color:inherit;
           cursor:pointer; }
  button:hover { background:rgba(232,134,60,.12); border-color:#e8863c; color:#e8863c; }
</style>
</head>
<body>
<h1>taskbean is offline</h1>
<p>The local server isn't reachable. Start it with <code>launch.cmd</code> and retry.</p>
<button type="button" onclick="location.reload()">Retry</button>
</body>
</html>`;
        return new Response(html, {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    })());
    return;
  }

  // Static assets: cache-first with background refresh
  const isShellAsset = SHELL_ASSETS.includes(url.pathname);
  if (isShellAsset) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        const networkUpdate = fetch(e.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone)));
          }
          return response;
        }).catch(() => null);

        return cached || networkUpdate;
      })
    );
    return;
  }

  // Everything else: network-first with cache fallback
  e.respondWith(
    fetch(e.request).then((response) => {
      if (response.ok) {
        const clone = response.clone();
        e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone)));
      }
      return response;
    }).catch(() => caches.match(e.request))
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const targetUrl = e.notification.data?.url || '/';
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin === self.location.origin) {
        await client.focus();
        if ('navigate' in client) {
          await client.navigate(targetUrl);
        }
        return;
      }
    }
    await self.clients.openWindow(targetUrl);
  })());
});
