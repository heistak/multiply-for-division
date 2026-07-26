// Network-first service worker: always tries the network, falls back to cache
// when offline. Keeps the app fresh during development AND functional offline.
const CACHE = 'wari-v3';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // `cache: 'reload'` bypasses the browser's HTTP cache. Without it a stale
  // style.css or app.js can survive a deploy: index.html is versioned by the
  // server but the asset URLs never change, so the browser happily reuses its
  // cached copies and the app updates only partially.
  const fresh = new Request(e.request.url, {
    cache: 'reload',
    credentials: 'same-origin',
    headers: e.request.headers,
    mode: e.request.mode === 'navigate' ? 'same-origin' : e.request.mode,
    redirect: 'follow',
  });
  e.respondWith(
    fetch(fresh).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request))
  );
});
