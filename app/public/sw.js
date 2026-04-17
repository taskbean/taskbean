const CACHE_NAME = 'taskbean-v16';
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
  self.skipWaiting();
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
        return cached || new Response('Offline — no cached page available', {
          status: 503, headers: { 'Content-Type': 'text/plain' }
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

// Respond to version queries from the page (used by the About panel).
// Replies via MessageChannel so the page can await a single response.
self.addEventListener('message', (e) => {
  if (!e.data || typeof e.data !== 'object') return;
  if (e.data.type === 'GET_VERSION') {
    const port = e.ports && e.ports[0];
    if (port) port.postMessage({ type: 'VERSION', cache: CACHE_NAME });
  }
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
