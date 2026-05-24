const CACHE_NAME = 'kayan-expenses-v2';
const STATIC = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC).catch(()=>{})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => 
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Skip API calls - always go to network
  if (e.request.url.includes('/api/')) return;
  
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});

// Push notification handler
self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  self.registration.showNotification(data.title || 'مصروفات كيان', {
    body: data.body || '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    dir: 'rtl',
    lang: 'ar',
    vibrate: [200, 100, 200],
    data: data
  });
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});
