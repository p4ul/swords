// Minimal service worker: cache the app shell so the game loads fast on
// repeat visits. Model weights and TF.js come from CDNs and are cached
// with a stale-while-revalidate strategy.
const CACHE = 'swordstorm-v2';
const SHELL = [
  '.',
  'index.html',
  'style.css',
  'icon.svg',
  'manifest.webmanifest',
  'js/main.js',
  'js/pose.js',
  'js/game.js',
  'js/audio.js',
  'vendor/tf.min.js',
  'vendor/pose-detection.min.js',
  'vendor/movenet/movenet-lightning.json',
  'vendor/movenet/movenet-lightning.bin',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetched = fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    }),
  );
});
