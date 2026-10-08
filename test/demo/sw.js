// Demo service worker: opens one cache at install so the purge test (and
// anyone trying "Purge SW caches" manually) has something real to remove.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open('demo-v1').then((cache) => cache.put(new Request('/sw-asset'), new Response('ok')))
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
