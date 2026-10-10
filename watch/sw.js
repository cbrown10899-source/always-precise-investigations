/**
 * Service worker for the live-visitor dashboard.
 *
 * Push messages carry no payload — they only wake this worker. It then calls
 * /recent and shows the alert the Worker raised (NEW INTAKE, HIGH INTENT
 * VISITOR, or a new visit), falling back to the newest page view when
 * journeys are not switched on. The passphrase needed for that call is handed
 * over by the page via postMessage and kept in the Cache API (localStorage is
 * not available here).
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
    event.waitUntil((async () => {
      const old = (await loadConfig()) || {};
      await saveConfig({ ...old, token: d.token, api: d.api });
    })());
  }
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let title = 'Someone is on your website';
    let body = 'Tap to see what they are looking at.';
    let tag = 'visitor';
    let url = '/watch/';
    let renotify = true;

    try {
      const cfg = await loadConfig();
      if (cfg && cfg.api && cfg.token) {
        const res = await fetch(cfg.api + '/recent', {
          headers: { authorization: 'Bearer ' + cfg.token },
        });
        if (res.ok) {
          const data = await res.json();
          const alerts = Array.isArray(data.alerts) ? data.alerts : [];
          if (alerts.length) {
            /* Newest first. Show the newest one this device has not shown yet;
               if every recent alert has been shown, a push still has to show
               something, so the newest is shown again under its own tag —
               which replaces it quietly instead of buzzing twice. */
            const seen = Number(cfg.seen) || 0;
            const fresh = alerts.filter((a) => a.id > seen);
            const a = fresh.length ? fresh[0] : alerts[0];
            title = a.title;
            body = a.body;
            tag = 'va-' + a.id;
            renotify = fresh.length > 0;
            if (a.visitor_id) url = '/watch/?v=' + encodeURIComponent(a.visitor_id);
            if (fresh.length) await saveConfig({ ...cfg, seen: Math.max(seen, ...alerts.map((x) => x.id)) });
          } else {
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
      }
    } catch (_) {
      /* fall back to the generic message */
    }

    await self.registration.showNotification(title, {
      body,
      tag,                 // collapses rapid-fire alerts into one
      renotify,
      icon: '/assets/logo-white.webp',
      badge: '/assets/logo-white.webp',
      data: { url },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/watch/';
  const v = new URL(url, self.location.origin).searchParams.get('v');
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('/watch')) {
        // Already open: say which visitor, and let the page open the journey.
        if (v) c.postMessage({ type: 'open', v });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
