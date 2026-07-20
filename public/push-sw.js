// Web Push handlers, pulled into the generated service worker via
// workbox.importScripts (see vite.config.ts). Runs even when the app is
// closed — this is what makes nudges reach a locked phone.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'The Hourly', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'The Hourly', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'the-hourly',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          const focused = client.focus();
          // Deep link (e.g. /?photo=<id>): steer the already-open app to the
          // tapped photo instead of just focusing wherever it was.
          if (url !== '/' && 'navigate' in client) {
            return focused.then(() => client.navigate(url)).catch(() => undefined);
          }
          return focused;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
