const CACHE_NAME = 'taskbean-v6';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/taskbean-only.png',
  '/vendor/lucide.min.js',
  '/vendor/fast-json-patch.min.js'
];

// Install: cache the app shell
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

// Fetch: skip API, cache-first for shell, network-first for rest
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never cache API calls or SSE streams
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Navigation: preload-first, then cache-first with network fallback
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      // Try navigation preload first (faster than cache for online users)
      const preloadResponse = await e.preloadResponse;
      if (preloadResponse) {
        // Update cache in background
        const clone = preloadResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', clone)).catch(() => {});
        return preloadResponse;
      }

      // Fall back to cache-first with network update
      const cached = await caches.match('/index.html');
      const networkUpdate = fetch(e.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', clone)).catch(() => {});
        }
        return response;
      }).catch(() => null);

      return cached || networkUpdate;
    })());
    return;
  }

  // Shell assets: cache-first, background refresh
  const isShellAsset = SHELL_ASSETS.includes(url.pathname);
  if (isShellAsset) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        const networkUpdate = fetch(e.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone)).catch(() => {});
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
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone)).catch(() => {});
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
