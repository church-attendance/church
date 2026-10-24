const CACHE = 'church-v1';
const BOOTSTRAP = 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/';
const SHELL = [
  './', './index.html', './style.css', './i18n.js', './app.js', './manifest.json',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'
];
const BOOTSTRAP_FILES = [BOOTSTRAP + 'bootstrap.rtl.min.css', BOOTSTRAP + 'bootstrap.min.css'];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) {
      // each file separately, so one failure can't break the whole install
      const own = SHELL.map(function(u) { return c.add(u).catch(function() {}); });
      const cdn = BOOTSTRAP_FILES.map(function(u) {
        return fetch(new Request(u, { mode: 'no-cors' })).then(function(r) { return c.put(u, r); }).catch(function() {});
      });
      return Promise.all(own.concat(cdn));
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

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') { return; }
  const url = new URL(e.request.url);

  // Bootstrap from the CDN: the file is versioned and never changes, so the saved copy is used first.
  if (e.request.url.indexOf(BOOTSTRAP) === 0) {
    e.respondWith(
      caches.match(e.request.url).then(function(r) {
        return r || fetch(e.request).then(function(res) {
          const copy = res.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request.url, copy); });
          return res;
        });
      })
    );
    return;
  }

  // Everything else from another site (e.g. Supabase) is never touched.
  if (url.origin !== location.origin) { return; }

  // The app's own files: newest from the network, saved copy when offline.
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
