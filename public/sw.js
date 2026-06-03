// PrivacyClean Service Worker — offline-capable privacy tool
const CACHE_NAME = 'privacyclean-v2';
const PRECACHE_URLS = [
  '/',
  '/css/shared.css',
  '/js/app.js',
  '/js/landing-shared.js',
  '/wasm/privacy_clean_wasm.js',
  '/wasm/privacy_clean_wasm_bg.wasm',
  '/remove-exif-iphone',
  '/remove-exif-android',
  '/strip-pdf-metadata',
  '/privacy',
  '/terms',
  '/manifest.json',
];

// Install: precache static assets (fail gracefully for WASM files that may not exist yet)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Precache all URLs, but don't fail installation if WASM files are missing
      // (they'll be cached on first fetch instead)
      return Promise.allSettled(
        PRECACHE_URLS.map((url) =>
          cache.match(url).then((cached) => {
            if (!cached) return cache.add(url).catch((err) => {
              console.warn(`[SW] Failed to precache ${url}:`, err.message);
            });
          })
        )
      );
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch: cache-first for static assets, network-first for API/WASM
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls
  if (url.pathname.startsWith('/api/')) return;

  // WASM files: cache-first (large, rarely change)
  if (url.pathname.startsWith('/wasm/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Static assets: cache-first
  if (event.request.method === 'GET') {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return cached || fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      }).catch(() => {
        // Offline fallback for navigation
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
      })
    );
  }
});
