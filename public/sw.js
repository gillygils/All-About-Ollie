'use strict';

// The scrapbook's background helper. It only shows push notifications and opens the scrapbook when
// one is tapped. It doesn't keep copies of anything, so pages always come fresh from the server.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Scrapbook', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag,
    data: { url: d.url || '/' },
  }));
});

// Tapping a notification: bring an open scrapbook forward and take it there, or open a new one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = open.find((c) => new URL(c.url).origin === self.location.origin);
    if (page) {
      await page.focus();
      page.postMessage({ type: 'open', url });
    } else {
      await self.clients.openWindow(url);
    }
  })());
});
