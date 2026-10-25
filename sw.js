const CACHE = 'church-v3';
const SHELL = [
  './', './index.html', './style.css', './i18n.js', './app.js', './manifest.json',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) {
      // each file separately, so one failure can't break the whole install
      return Promise.all(SHELL.map(function(u) { return c.add(u).catch(function() {}); }));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    }).then(function() { return self.clients.claim(); })
  );
});

// The app's own files: newest from the network, saved copy when offline.
// Everything from another site (Supabase, the Bootstrap CDN...) is left completely alone:
// jsDelivr sends versioned files with a one-year "immutable" cache header, so the browser
// already keeps Bootstrap for offline use, and touching it here can make Chrome drop the styling.
self.addEventListener('fetch', function(e) {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) { return; }
  e.respondWith(
    fetch(e.request).then(function(res) {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then(function(c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function() {
      return caches.match(e.request).then(function(r) { return r || caches.match('./index.html'); });
    })
  );
});
