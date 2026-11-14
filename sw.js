const CACHE = 'docscan-pro-v3'; // <--- v1 ko v2 se badal dein
const ASSETS = [
  './', './index.html', './manifest.json',
  './css/app.css',
  './js/core.js', './js/store.js', './js/nav.js', './js/imaging.js',
  './js/crop.js', './js/camera.js', './js/editor.js', './js/pdf.js',
  './js/ocr.js', './js/screens.js', './js/app.js',
  './icons/icon.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && (e.request.url.startsWith(location.origin) || e.request.url.includes('cdn.jsdelivr.net') || e.request.url.includes('fonts.g'))) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
    })
  );
});
