/* Bible Bubble — offline shell.
   Lives at the repo root so its scope covers the whole app, and every URL below
   is relative so the same file works at /bible-bubble/ and at any other prefix. */

/* Bump this and the old cache is dropped wholesale on the next activate. */
const VERSION = 'bb-v1';

/* Everything index.html pulls in. Kept in step with its <link>/<script> tags by
   hand; if one of these stops resolving the install fails loudly rather than
   leaving a half-cached shell that only half works on a plane. */
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'css/web.css',
  'css/pwa.css',
  'css/mobile.css',
  'js/util.js',
  'js/seed.js',
  'js/store.js',
  'js/lineage.js',
  'js/canvas.js',
  'js/inspector.js',
  'js/timeline.js',
  'js/sidebar.js',
  'js/io.js',
  'js/web.js',
  'js/app.js',
  'js/peek.js',
  'js/pwa.js',
];

/* Wanted, but the app runs fine without them, so one 404 here must not cost the
   whole install — the launcher will just re-fetch the icon it is missing. */
const EXTRAS = [
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/shortcut-canvas.png',
  'icons/shortcut-web.png',
  'icons/shortcut-timeline.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(EXTRAS.map((url) => cache.add(url).catch(() => {})));
    await cache.addAll(SHELL);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => (n === VERSION ? null : caches.delete(n))));
    await self.clients.claim();
  })());
});

/**
 * Documents: network first, so a fresh deploy is picked up the moment there is
 * signal, with the precached shell standing in when there is none.
 */
async function documentFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const fresh = await fetch(request);
    /* Store under a fixed key: ?view=web and friends are all the same document,
       and caching each query string would just grow junk. */
    if (fresh && fresh.ok) cache.put('index.html', fresh.clone());
    return fresh;
  } catch (_) {
    const hit = await cache.match(request, { ignoreSearch: true }) ||
      await cache.match('index.html') ||
      await cache.match('./');
    return hit || Response.error();
  }
}

/**
 * Assets: straight from the cache, with a quiet refresh behind it so the next
 * load has the newer copy. Nothing here is allowed to reject out loud.
 */
async function assetFirst(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request);
  if (hit) {
    fetch(request)
      .then((fresh) => { if (fresh && fresh.ok) return cache.put(request, fresh.clone()); })
      .catch(() => {});
    return hit;
  }
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok && fresh.type === 'basic') {
      cache.put(request, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (_) {
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') event.respondWith(documentFirst(request));
  else event.respondWith(assetFirst(request));
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'SKIP_WAITING') self.skipWaiting();
});
