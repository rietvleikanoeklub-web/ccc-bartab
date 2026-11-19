/* Network-only for the page itself so a phone does not keep an old till. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) { return caches.delete(key); }));
    })
  ]));
});
self.addEventListener('message', function (event) {
  if (event.data === 'skip') self.skipWaiting();
});
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(fetch(req, { cache: 'no-store' }));
  }
});
