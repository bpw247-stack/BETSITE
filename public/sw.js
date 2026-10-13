// BetsFriend service worker: lets the site install as an app, and shows a helpful page
// instead of a browser error when the BetsFriend server on this computer isn't running.
// Everything else goes straight to the network, so updates show up immediately.
const CACHE = 'betsfriend-offline-v2';
const OFFLINE = ['/offline.html', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(OFFLINE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/offline.html')));
  } else if (OFFLINE.includes(new URL(e.request.url).pathname)) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
  }
});
