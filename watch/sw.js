/**
 * Service worker for the live-visitor dashboard.
 *
 * Push messages carry no payload — they only wake this worker. It then calls
 * /recent for the latest visit and shows a notification with the real detail.
 * The passphrase needed for that call is handed over by the page via
 * postMessage and kept in the Cache API (localStorage is not available here).
 */

const CFG_CACHE = 'apiwatch-config';
const CFG_URL = 'https://apiwatch.local/config';

async function saveConfig(cfg) {
  const cache = await caches.open(CFG_CACHE);
  await cache.put(CFG_URL, new Response(JSON.stringify(cfg)));
}

async function loadConfig() {
  const cache = await caches.open(CFG_CACHE);
  const res = await cache.match(CFG_URL);
  return res ? res.json() : null;
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type === 'token' && d.token) {
    event.waitUntil(saveConfig({ token: d.token, api: d.api }));
  }
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let title = 'Someone is on your website';
    let body = 'Tap to see what they are looking at.';
    let tag = 'visitor';

    try {
      const cfg = await loadConfig();
      if (cfg && cfg.api && cfg.token) {
        const res = await fetch(cfg.api + '/recent', {
          headers: { authorization: 'Bearer ' + cfg.token },
        });
        if (res.ok) {
          const data = await res.json();
          const v = data.visits && data.visits[0];
          if (v) {
            const place = [v.city, v.region].filter(Boolean).join(', ') || v.country || '';
            const hot = /^\/intake|contact/i.test(v.path);
            title = hot ? 'High-intent visitor' : 'Visitor on your website';
            body = v.path
              + (place ? ' — ' + place : '')
              + (v.ref ? ' (from ' + v.ref + ')' : '')
              + (data.online > 1 ? '\n' + data.online + ' people on the site now' : '');
            tag = hot ? 'visitor-hot' : 'visitor';
          }
        }
      }
    } catch (_) {
      /* fall back to the generic message */
    }

    await self.registration.showNotification(title, {
      body,
      tag,                 // collapses rapid-fire alerts into one
      renotify: true,
      icon: '/assets/logo-white.webp',
      badge: '/assets/logo-white.webp',
      data: { url: '/watch/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/watch/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('/watch')) return c.focus();
    }
    return self.clients.openWindow(url);
  })());
});
