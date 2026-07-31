/**
 * Always Precise — live visitor alerts.
 *
 * A Cloudflare Worker that receives a lightweight beacon from the website,
 * keeps a short rolling log of visits, and sends a Web Push "tickle" to the
 * owner's phone when someone arrives.
 *
 * Endpoints
 *   POST /hit         public  — beacon from the site (no auth; origin-checked)
 *   POST /subscribe   auth    — register a device for push
 *   POST /unsubscribe auth    — remove a device
 *   GET  /recent      auth    — recent visits as JSON (dashboard + SW)
 *   GET  /health      public  — liveness
 *
 * Auth is a single shared passphrase (env.WATCH_PASSWORD) sent as
 * `Authorization: Bearer <passphrase>`. The dashboard page itself contains no
 * secret, so it is harmless if anyone stumbles onto the URL — without the
 * passphrase it shows nothing.
 *
 * Push carries NO payload. A payload would need aes128gcm encryption; instead
 * the push simply wakes the service worker, which calls /recent for details.
 * Simpler, and no visitor data ever passes through the push service.
 *
 * Privacy: stores page path, referrer host, coarse city/region from Cloudflare
 * headers, and a daily-rotating pseudonymous visitor hash. No cookies, no
 * cross-site identifiers, no IP or user-agent at rest, and nothing whatsoever
 * from the intake form's fields.
 */

const MAX_LOG = 120;            // rolling visits retained
const QUIET_MINUTES = 15;       // per-visitor notification debounce
const HIGH_INTENT = [/^\/intake/, /contact/i];  // always notify, ignores debounce

/* ------------------------------------------------------------------ utils */

const b64urlToBytes = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const bytesToB64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time-ish string compare so the passphrase can't be timed out. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authed(request, env) {
  const h = request.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  return env.WATCH_PASSWORD && safeEqual(token, env.WATCH_PASSWORD);
}

function corsHeaders(env) {
  return {
    'access-control-allow-origin': env.SITE_ORIGIN || '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
  };
}

/* ------------------------------------------------------------- VAPID push */

/** Sign a VAPID JWT for one push endpoint. */
async function vapidAuth(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = bytesToB64url(
    new TextEncoder().encode(
      JSON.stringify({
        aud,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: env.VAPID_SUBJECT || 'mailto:AlwaysPreciseInvestigations@gmail.com',
      })
    )
  );
  const unsigned = `${header}.${body}`;

  // Import the raw P-256 private scalar as a JWK signing key.
  const d = env.VAPID_PRIVATE_KEY;
  const pub = b64urlToBytes(env.VAPID_PUBLIC_KEY); // 65-byte uncompressed point
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d,
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true,
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(unsigned)
  );
  return `vapid t=${unsigned}.${bytesToB64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

/** Fan a payload-less push out to every registered device; prune dead ones. */
async function notifyAll(env) {
  const list = await env.SUBS.list({ prefix: 'sub:' });
  await Promise.all(
    list.keys.map(async ({ name }) => {
      const raw = await env.SUBS.get(name);
      if (!raw) return;
      const sub = JSON.parse(raw);
      try {
        const res = await fetch(sub.endpoint, {
          method: 'POST',
          headers: {
            Authorization: await vapidAuth(sub.endpoint, env),
            TTL: '600',
            'content-length': '0',
          },
        });
        // 404/410 mean the browser dropped the subscription — clean it up.
        if (res.status === 404 || res.status === 410) await env.SUBS.delete(name);
      } catch (_) {
        /* transient push-service failure: leave the subscription in place */
      }
    })
  );
}

/* -------------------------------------------------------------- handlers */

async function handleHit(request, env) {
  // Only accept beacons fired from the site itself.
  const origin = request.headers.get('origin');
  if (env.SITE_ORIGIN && origin && origin !== env.SITE_ORIGIN) {
    return json({ ok: false, error: 'origin' }, 403);
  }

  let body = {};
  try { body = await request.json(); } catch (_) {}

  const cf = request.cf || {};
  const path = String(body.path || '/').slice(0, 200);
  let refHost = '';
  try { refHost = body.ref ? new URL(body.ref).hostname : ''; } catch (_) {}

  // Pseudonymous, daily-rotating visitor key — enough to debounce, not enough
  // to follow anyone across days. Raw IP/UA are never stored.
  const day = new Date().toISOString().slice(0, 10);
  const vkey = (await sha256Hex(
    [request.headers.get('cf-connecting-ip') || '',
     request.headers.get('user-agent') || '',
     day, env.SALT || 'api'].join('|')
  )).slice(0, 16);

  const visit = {
    t: Date.now(),
    path,
    ref: refHost,
    city: cf.city || '',
    region: cf.region || '',
    country: cf.country || '',
    v: vkey,
    returning: false,
  };

  // Append to the rolling log.
  const logRaw = await env.HITS.get('log');
  const log = logRaw ? JSON.parse(logRaw) : [];
  visit.returning = log.some((h) => h.v === vkey);
  log.unshift(visit);
  await env.HITS.put('log', JSON.stringify(log.slice(0, MAX_LOG)));

  // Debounce: one alert per visitor per QUIET_MINUTES, unless high intent.
  const hot = HIGH_INTENT.some((re) => re.test(path));
  const seenKey = `seen:${vkey}`;
  const seen = await env.HITS.get(seenKey);
  if (!seen || hot) {
    await env.HITS.put(seenKey, '1', { expirationTtl: QUIET_MINUTES * 60 });
    await notifyAll(env);
  }
  return json({ ok: true });
}

async function handleSubscribe(request, env) {
  const sub = await request.json();
  if (!sub || !sub.endpoint) return json({ ok: false, error: 'bad subscription' }, 400);
  const id = (await sha256Hex(sub.endpoint)).slice(0, 24);
  await env.SUBS.put(`sub:${id}`, JSON.stringify({ endpoint: sub.endpoint }));
  return json({ ok: true, id });
}

async function handleUnsubscribe(request, env) {
  const { endpoint } = await request.json();
  if (!endpoint) return json({ ok: false }, 400);
  const id = (await sha256Hex(endpoint)).slice(0, 24);
  await env.SUBS.delete(`sub:${id}`);
  return json({ ok: true });
}

async function handleRecent(env) {
  const raw = await env.HITS.get('log');
  const log = raw ? JSON.parse(raw) : [];
  const now = Date.now();
  return json({
    ok: true,
    now,
    // "online" = seen in the last 3 minutes
    online: new Set(log.filter((h) => now - h.t < 3 * 60_000).map((h) => h.v)).size,
    visits: log.slice(0, 60),
  });
}

/* ----------------------------------------------------------------- entry */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    let res;
    try {
      if (url.pathname === '/health') {
        res = json({ ok: true });
      } else if (url.pathname === '/hit' && request.method === 'POST') {
        res = await handleHit(request, env);
      } else if (url.pathname === '/subscribe' && request.method === 'POST') {
        res = authed(request, env) ? await handleSubscribe(request, env) : json({ ok: false }, 401);
      } else if (url.pathname === '/unsubscribe' && request.method === 'POST') {
        res = authed(request, env) ? await handleUnsubscribe(request, env) : json({ ok: false }, 401);
      } else if (url.pathname === '/recent') {
        res = authed(request, env) ? await handleRecent(env) : json({ ok: false }, 401);
      } else if (url.pathname === '/vapid-public-key') {
        res = json({ key: env.VAPID_PUBLIC_KEY || null });
      } else {
        res = json({ ok: false, error: 'not found' }, 404);
      }
    } catch (err) {
      res = json({ ok: false, error: String(err && err.message || err) }, 500);
    }

    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
