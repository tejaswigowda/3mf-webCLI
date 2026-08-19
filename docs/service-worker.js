/**
 * Service Worker for 3mf-webCLI
 * 
 * Implements offline-first PWA caching strategy:
 * - Cache static assets on first load
 * - Serve from cache on subsequent loads
 * - Update cache in background
 * - Enable offline mode for previously cached content
 */

const CACHE_NAME = '3mf-webCLI-v18';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './app.js',
  './viewer.js',
  './glb-parser.js',
  './color-clusterer.js',
  './3mf-authorer.js',
  './download-handler.js',
  './manifest.json',
  // CDN dependencies (cached for offline use)
  'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/exporters/GLTFExporter.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/utils/BufferGeometryUtils.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css',
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch(() => {
        // Fail gracefully if some assets are missing (OK for dev)
        console.warn('Some assets failed to cache during install');
      });
    }),
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        }),
      );
    }),
  );
  self.clients.claim();
});

// Fetch: network-first for dynamic content, cache-first for static
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip cross-origin requests
  if (url.origin !== location.origin) {
    return;
  }

  // Network-first for app code (HTML/CSS/JS) so updates load immediately;
  // falls back to cache when offline. Prevents stale JS during development.
  if (
    request.destination === 'style' ||
    request.destination === 'script' ||
    request.destination === 'document' ||
    url.pathname.endsWith('.wasm')
  ) {
    event.respondWith(
      fetch(request).then((fetchResponse) => {
        if (fetchResponse.ok) {
          const responseToCache = fetchResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
        }
        return fetchResponse;
      }).catch(() => {
        // Offline fallback to cached copy
        return caches.match(request).then(
          (r) => r || new Response('Offline', { status: 503 }),
        );
      }),
    );
  }
});
