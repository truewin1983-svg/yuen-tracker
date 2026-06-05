// 昱恩追蹤工具 — service worker (app shell cache)
const CACHE = 'yuen-tracker-v1';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 永遠不要快取 Google Apps Script 的資料請求
  if (url.hostname.includes('script.google.com') || url.hostname.includes('googleusercontent')) return;
  if (e.request.method !== 'GET') return;
  // app shell: cache-first，其他: network-first 退回快取
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchP = fetch(e.request).then(res => {
        if (res && res.status === 200 && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || fetchP;
    })
  );
});
