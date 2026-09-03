/**
 * Always Precise — live visitor alerts.
 *
 * A Cloudflare Worker that receives a lightweight beacon from the website,
 * keeps a short rolling log of real visits, and sends a Web Push "tickle" to
 * the owner's phone when someone arrives.
 *
 * Endpoints
 *   POST /hit               public — beacon from the site (origin-locked, rate-limited)
 *   POST /subscribe         auth   — register a device for push
 *   POST /unsubscribe       auth   — remove a device
 *   GET  /recent            auth   — recent visits as JSON (dashboard + service worker)
 *   GET  /vapid-public-key  public — the push public key (not a secret)
 *   GET  /health            public — liveness
 *
 * Security posture
 *   - The dashboard page holds no secret. Auth is a shared passphrase compared
 *     as a SHA-256 digest (constant length, constant time), so neither the value
 *     nor its length leaks by timing.
 *   - Failed unlock attempts are counted per client and locked out. This matters:
 *     a short numeric passcode is otherwise trivially brute-forced.
 *   - /hit requires the site's Origin, caps body size, and is rate-limited per
 *     visitor so nobody can flood the log or spam the owner's phone.
 *   - Push endpoints are validated against known push services, so a stolen
 *     passphrase cannot turn this Worker into a request proxy.
 *   - CORS never falls back to a wildcard on authenticated routes.
 *
 * Push carries NO payload — it only wakes the service worker, which then calls
 * /recent. No visitor data ever passes through Apple's or Google's push
 * infrastructure.
 *
 * Privacy: stores page path, referrer host, coarse city/region from Cloudflare,
 * and a daily-rotating pseudonymous visitor hash. No cookies, no IPs or user
 * agents at rest, no cross-site identifiers, and nothing from the intake form.
 */

const MAX_LOG = 120;              // rolling visits retained
const QUIET_MINUTES = 15;         // per-visitor notification debounce
const MAX_BODY = 2048;            // bytes accepted on /hit
const HIT_LIMIT = 20;             // hits per visitor per window
const HIT_WINDOW = 60;            // seconds
const AUTH_MAX_FAILS = 8;         // failed unlocks before lockout
const AUTH_LOCK_SECONDS = 900;    // lockout duration (15 min)
const MAX_SUBS = 10;              // registered devices
const TZ = 'America/New_York';    // for "today" boundaries
const DAYS_KEY = 'days';          // KV: rolling per-day counters {date:{v,a}}
const DAYS_KEEP = 40;             // days of counters retained
const COUNT_WINDOW = 30;          // days summed for the dashboard ticker
const AFF_PREFIX = '/Amazon Click'; // paths logged by an affiliate ping (unused here today)

const HIGH_INTENT = [/^\/intake/, /contact/i];

/* Known Web Push services. A subscription endpoint outside this set is refused
   so the Worker can never be aimed at an arbitrary host. */
const PUSH_HOSTS = [
  /\.push\.services\.mozilla\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
  /^web\.push\.apple\.com$/,
  /\.push\.apple\.com$/,
];

/* Bots: logged for reference, never alerted. */
const BOT_UA = new RegExp([
  'bot', 'crawl', 'spider', 'slurp', 'archiver', 'scrape', 'curl', 'wget', 'python-requests',
  'httpclient', 'okhttp', 'java/', 'go-http', 'libwww', 'perl', 'ruby', 'scrapy', 'phantomjs',
  'headlesschrome', 'puppeteer', 'playwright', 'selenium', 'lighthouse', 'pagespeed',
  'gtmetrix', 'pingdom', 'uptimerobot', 'statuscake', 'semrush', 'ahrefs', 'mj12', 'dotbot',
  'petalbot', 'bytespider', 'dataforseo', 'serpstat', 'screaming frog', 'sitebulb',
  'facebookexternalhit', 'twitterbot', 'linkedinbot', 'slackbot', 'discordbot',
  'whatsapp', 'telegrambot', 'embedly', 'preview', 'gptbot', 'oai-searchbot', 'chatgpt',
  'claudebot', 'anthropic', 'perplexity', 'ccbot', 'google-extended', 'applebot',
  'amazonbot', 'duckduckbot', 'yandex', 'baiduspider', 'sogou', 'exabot', 'ia_archiver',
].join('|'), 'i');

/* ------------------------------------------------------------------ utils */

const b64urlToBytes = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  return Uint8Array.from(atob(s + pad), (c) => c.charCodeAt(0));
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

/**
 * Compare two secrets in constant time.
 * Both sides are hashed first, so the comparison is always over 64 hex chars —
 * the length of the supplied value cannot be inferred from timing.
 */
async function secretEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

/** Start of "today" in the business's timezone, as an epoch ms value. */
function startOfLocalDay(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(now));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const secondsIntoDay = get('hour') * 3600 + get('minute') * 60 + get('second');
  return now - secondsIntoDay * 1000;
}

/** Local calendar date (YYYY-MM-DD) in the business timezone. */
function localDayStr(ts = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ts));
}

/** The last n distinct local dates, today first. 12h steps so DST cannot skip a day. */
function lastLocalDays(n) {
  const out = [];
  let t = Date.now();
  while (out.length < n) {
    const d = localDayStr(t);
    if (out[out.length - 1] !== d) out.push(d);
    t -= 43_200_000;
  }
  return out;
}

/**
 * Rolling per-day counters: { 'YYYY-MM-DD': { v, a } } — v is real first
 * visits (non-bot, not a same-day repeat), a is affiliate clicks deduped to
 * one per person per day. The visit log only holds MAX_LOG entries, so these
 * live in their own KV record; on first use they are seeded from whatever
 * history the log still holds.
 */
async function loadDays(env, log) {
  const raw = await env.HITS.get(DAYS_KEY);
  if (raw !== null) {
    try { return { days: JSON.parse(raw) || {}, fresh: false }; }
    catch (_) { return { days: {}, fresh: false }; }
  }
  const days = {};
  const affSeen = new Set();
  for (const h of [...(log || [])].reverse()) {
    if (h.bot) continue;
    const d = localDayStr(h.t);
    days[d] = days[d] || { v: 0, a: 0 };
    if (String(h.path || '').startsWith(AFF_PREFIX)) {
      const k = `${d}:${h.v}`;
      if (!affSeen.has(k)) { affSeen.add(k); days[d].a++; }
    } else if (!h.returning) {
      days[d].v++;
    }
  }
  return { days, fresh: true };
}

function pruneDays(days) {
  const keep = new Set(lastLocalDays(DAYS_KEEP));
  for (const d of Object.keys(days)) if (!keep.has(d)) delete days[d];
  return days;
}

/** All-time affiliate-click total; falls back to the seeded counters on first use. */
async function affTotalValue(env, days) {
  const raw = await env.HITS.get('affTotal');
  if (raw !== null) return Number(raw) || 0;
  return Object.values(days).reduce((s, x) => s + (x.a || 0), 0);
}

/** Stable per-client key used for rate limiting and lockout (never stored raw). */
async function clientKey(request, env) {
  return (await sha256Hex(
    [request.headers.get('cf-connecting-ip') || '',
     new Date().toISOString().slice(0, 10),
     env.SALT || 'api'].join('|')
  )).slice(0, 20);
}

function corsHeaders(env, authRoute) {
  const origin = env.SITE_ORIGIN;
  // Never wildcard a route that accepts credentials.
  const allow = origin || (authRoute ? 'null' : '*');
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

/* ---------------------------------------------------------------- auth */

/**
 * Verify the bearer passphrase, with lockout after repeated failures.
 * Returns { ok } or { ok:false, locked:true, retryAfter }.
 */
async function checkAuth(request, env) {
  const ck = await clientKey(request, env);
  const failKey = `authfail:${ck}`;
  const fails = Number((await env.HITS.get(failKey)) || 0);
  if (fails >= AUTH_MAX_FAILS) return { ok: false, locked: true, retryAfter: AUTH_LOCK_SECONDS };

  const h = request.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const ok = Boolean(env.WATCH_PASSWORD) && (await secretEqual(token, env.WATCH_PASSWORD));

  if (!ok) {
    await env.HITS.put(failKey, String(fails + 1), { expirationTtl: AUTH_LOCK_SECONDS });
    return { ok: false, locked: false };
  }
  if (fails) await env.HITS.delete(failKey);   // clean slate on success
  return { ok: true };
}

function authFailure(res) {
  return res.locked
    ? json({ ok: false, error: 'too many attempts', retryAfter: res.retryAfter }, 429)
    : json({ ok: false, error: 'unauthorized' }, 401);
}

/* ------------------------------------------------------------- VAPID push */

async function vapidAuth(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:AlwaysPreciseInvestigations@gmail.com',
  })));
  const unsigned = `${header}.${body}`;

  const pub = b64urlToBytes(env.VAPID_PUBLIC_KEY);
  const jwk = {
    kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY,
    x: bytesToB64url(pub.slice(1, 33)), y: bytesToB64url(pub.slice(33, 65)), ext: true,
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key,
    new TextEncoder().encode(unsigned));
  return `vapid t=${unsigned}.${bytesToB64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

function isValidPushEndpoint(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;
  return PUSH_HOSTS.some((re) => re.test(u.hostname));
}

async function notifyAll(env) {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return;   // push not configured
  const list = await env.SUBS.list({ prefix: 'sub:' });
  await Promise.all(list.keys.map(async ({ name }) => {
    const raw = await env.SUBS.get(name);
    if (!raw) return;
    let sub;
    try { sub = JSON.parse(raw); } catch (_) { return; }
    if (!sub.endpoint || !isValidPushEndpoint(sub.endpoint)) { await env.SUBS.delete(name); return; }
    try {
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: await vapidAuth(sub.endpoint, env),
          TTL: '600',
          'content-length': '0',
        },
      });
      if (res.status === 404 || res.status === 410) await env.SUBS.delete(name);
    } catch (_) { /* transient push-service failure */ }
  }));
}

/* -------------------------------------------------------------- bot check */

function botReason(request, body) {
  const ua = request.headers.get('user-agent') || '';
  if (!ua) return 'no-user-agent';
  if (BOT_UA.test(ua)) return 'known-bot-ua';

  const cf = request.cf || {};
  if (cf.verifiedBotCategory) return 'verified-bot';

  // The beacon only fires after a human signal and always sends these.
  const sig = body && body.s;
  if (!sig || typeof sig.w !== 'number' || typeof sig.h !== 'number') return 'no-client-signals';
  if (sig.w < 200 || sig.h < 200 || sig.w > 20000 || sig.h > 20000) return 'implausible-viewport';

  // A real browser reports a timezone; scripted clients usually do not.
  if (typeof sig.tz !== 'string' || !sig.tz.includes('/')) return 'no-timezone';

  // sig.t is ms on the page before the human signal fired. The beacon cannot
  // legitimately report ~0 — it waits for interaction or four seconds of dwell.
  if (typeof sig.t !== 'number' || sig.t < 150) return 'instant-fire';

  return '';

  /* Deliberately NOT filtered on datacenter ASN: iCloud Private Relay, corporate
     VPNs and mobile carriers all resolve to hosting-like networks, and blocking
     them would silently drop real prospects — the failure that actually costs
     money here. */
}

/* -------------------------------------------------------------- handlers */

async function handleHit(request, env) {
  // Origin is required and must match the site — a bare POST is rejected.
  const origin = request.headers.get('origin');
  if (!env.SITE_ORIGIN || origin !== env.SITE_ORIGIN) {
    return json({ ok: false, error: 'origin' }, 403);
  }

  // Cap the body before parsing.
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY) return json({ ok: false, error: 'too large' }, 413);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: 'too large' }, 413);

  let body = {};
  try { body = JSON.parse(text); } catch (_) { return json({ ok: false, error: 'bad json' }, 400); }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'bad json' }, 400);

  const cf = request.cf || {};
  const day = new Date().toISOString().slice(0, 10);
  const vkey = (await sha256Hex([
    request.headers.get('cf-connecting-ip') || '',
    request.headers.get('user-agent') || '',
    day, env.SALT || 'api',
  ].join('|'))).slice(0, 16);

  /* Per-visitor flood control — keyed on the ADDRESS, not the visitor key
     above: `vkey` carries the User-Agent, which the caller chooses, so keying
     the limiter on it handed every request a fresh bucket (closeout audit,
     2026-09-02). The dedup and "returning" semantics keep `vkey` as it was. */
  const rlKey = 'rl:' + (await sha256Hex([
    request.headers.get('cf-connecting-ip') || '',
    day, env.SALT || 'api',
  ].join('|'))).slice(0, 16);
  const count = Number((await env.HITS.get(rlKey)) || 0);
  if (count >= HIT_LIMIT) return json({ ok: false, error: 'rate limited' }, 429);
  await env.HITS.put(rlKey, String(count + 1), { expirationTtl: HIT_WINDOW });

  // Only accept a same-site path; never trust a client-supplied absolute URL.
  let path = String(body.path || '/');
  if (!path.startsWith('/') || path.startsWith('//')) path = '/';
  path = path.slice(0, 200);

  let refHost = '';
  try { refHost = body.ref ? new URL(String(body.ref)).hostname.slice(0, 100) : ''; } catch (_) {}

  const bot = botReason(request, body);
  const visit = {
    t: Date.now(),
    path,
    ref: refHost,
    city: String(cf.city || '').slice(0, 60),
    region: String(cf.region || '').slice(0, 60),
    country: String(cf.country || '').slice(0, 4),
    v: vkey,
    returning: false,
    bot: bot || undefined,
  };

  const logRaw = await env.HITS.get('log');
  let log = [];
  try { log = logRaw ? JSON.parse(logRaw) : []; } catch (_) { log = []; }
  visit.returning = log.some((h) => h.v === vkey && !h.bot);

  // Durable ticker counters — the log above forgets after MAX_LOG entries.
  // Counted before this visit joins the log so first-use seeding cannot
  // double-count it.
  if (!bot) {
    const days = pruneDays((await loadDays(env, log)).days);
    const d = localDayStr(visit.t);
    days[d] = days[d] || { v: 0, a: 0 };
    if (path.startsWith(AFF_PREFIX)) {
      // One affiliate click per person per local day, however many they make.
      const affKey = `affseen:${d}:${vkey}`;
      if ((await env.HITS.get(affKey)) === null) {
        const total = await affTotalValue(env, days);
        days[d].a = (days[d].a || 0) + 1;
        await env.HITS.put('affTotal', String(total + 1));
        await env.HITS.put(affKey, '1', { expirationTtl: 100_000 });
      }
    } else if (!visit.returning) {
      days[d].v = (days[d].v || 0) + 1;
    }
    await env.HITS.put(DAYS_KEY, JSON.stringify(days));
  }

  log.unshift(visit);
  await env.HITS.put('log', JSON.stringify(log.slice(0, MAX_LOG)));

  if (bot) return json({ ok: true, filtered: bot });

  const hot = HIGH_INTENT.some((re) => re.test(path));
  const seenKey = `seen:${vkey}`;
  const seen = await env.HITS.get(seenKey);
  if (!seen || hot) {
    await env.HITS.put(seenKey, '1', { expirationTtl: QUIET_MINUTES * 60 });
    await notifyAll(env);
    return json({ ok: true, notified: true });
  }
  return json({ ok: true, notified: false });
}

async function handleSubscribe(request, env) {
  let sub;
  try { sub = await request.json(); } catch (_) { return json({ ok: false, error: 'bad json' }, 400); }
  if (!sub || typeof sub.endpoint !== 'string') return json({ ok: false, error: 'bad subscription' }, 400);
  if (!isValidPushEndpoint(sub.endpoint)) return json({ ok: false, error: 'unrecognized push service' }, 400);

  const existing = await env.SUBS.list({ prefix: 'sub:' });
  const id = (await sha256Hex(sub.endpoint)).slice(0, 24);
  const known = existing.keys.some((k) => k.name === `sub:${id}`);
  if (!known && existing.keys.length >= MAX_SUBS) {
    return json({ ok: false, error: 'device limit reached' }, 409);
  }
  await env.SUBS.put(`sub:${id}`, JSON.stringify({ endpoint: sub.endpoint, at: Date.now() }));
  return json({ ok: true, id });
}

async function handleUnsubscribe(request, env) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false }, 400); }
  if (!body || typeof body.endpoint !== 'string') return json({ ok: false }, 400);
  await env.SUBS.delete(`sub:${(await sha256Hex(body.endpoint)).slice(0, 24)}`);
  return json({ ok: true });
}

async function handleRecent(env) {
  const raw = await env.HITS.get('log');
  let log = [];
  try { log = raw ? JSON.parse(raw) : []; } catch (_) { log = []; }
  const now = Date.now();
  const dayStart = startOfLocalDay(now);

  const people = log.filter((h) => !h.bot);
  const bots = log.filter((h) => h.bot);

  const loaded = await loadDays(env, log);
  const days = pruneDays(loaded.days);
  if (loaded.fresh) await env.HITS.put(DAYS_KEY, JSON.stringify(days));
  const win = lastLocalDays(COUNT_WINDOW);
  const sum = (k) => win.reduce((s, d) => s + ((days[d] && days[d][k]) || 0), 0);

  return json({
    ok: true,
    now,
    online: new Set(people.filter((h) => now - h.t < 3 * 60_000).map((h) => h.v)).size,
    todayCount: people.filter((h) => h.t >= dayStart).length,
    visits: people.slice(0, 60),
    botsToday: bots.filter((h) => h.t >= dayStart).length,
    visits30: sum('v'),
    aff30: sum('a'),
    affTotal: await affTotalValue(env, days),
  });
}

/* ----------------------------------------------------------------- entry */

const AUTH_ROUTES = new Set(['/subscribe', '/unsubscribe', '/recent']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isAuthRoute = AUTH_ROUTES.has(url.pathname);
    const cors = corsHeaders(env, isAuthRoute);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let res;
    try {
      if (url.pathname === '/health') {
        res = json({ ok: true, configured: Boolean(env.WATCH_PASSWORD && env.VAPID_PUBLIC_KEY) });
      } else if (url.pathname === '/vapid-public-key') {
        res = json({ key: env.VAPID_PUBLIC_KEY || null });
      } else if (url.pathname === '/hit' && request.method === 'POST') {
        res = await handleHit(request, env);
      } else if (isAuthRoute) {
        const auth = await checkAuth(request, env);
        if (!auth.ok) {
          res = authFailure(auth);
        } else if (url.pathname === '/recent') {
          res = await handleRecent(env);
        } else if (request.method === 'POST' && url.pathname === '/subscribe') {
          res = await handleSubscribe(request, env);
        } else if (request.method === 'POST' && url.pathname === '/unsubscribe') {
          res = await handleUnsubscribe(request, env);
        } else {
          res = json({ ok: false, error: 'method not allowed' }, 405);
        }
      } else {
        res = json({ ok: false, error: 'not found' }, 404);
      }
    } catch (err) {
      // Never leak internals to the client; the detail goes to the Worker log.
      console.error('worker error', err && err.stack);
      res = json({ ok: false, error: 'server error' }, 500);
    }

    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    out.headers.set('x-content-type-options', 'nosniff');
    out.headers.set('referrer-policy', 'no-referrer');
    return out;
  },
};
