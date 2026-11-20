/* Fleet Monitor service worker: shows push notifications (reminders) even when the site is closed. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Fleet Monitor', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    tag: d.tag || undefined,
    renotify: Boolean(d.tag),
    data: { url: d.url || '/#/notifications' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        try { await w.navigate(url); } catch { /* some browsers do not allow navigate */ }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
