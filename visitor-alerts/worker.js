/**
 * Always Precise — live visitor alerts.
 *
 * A Cloudflare Worker that receives a lightweight beacon from the website,
 * keeps a short rolling log of real visits, and sends a Web Push "tickle" to
 * the owner's phone when someone arrives. Since Live Visitors V2 it also keeps
 * each visitor's JOURNEY — visits, pages, engaged time, button presses and a
 * submitted intake's request number — in a D1 database of its own, so the
 * dashboard can say whether a visit looks like somebody about to hire the firm.
 *
 * Endpoints
 *   POST /hit               public — a page view from the beacon (origin-locked, rate-limited)
 *   POST /t                 public — engagement and button presses for a page view already recorded
 *   POST /subscribe         auth   — register a device for push
 *   POST /unsubscribe       auth   — remove a device
 *   GET  /recent            auth   — summary, recent page views and alerts (dashboard + service worker)
 *   GET  /visitors          auth   — one card per recent visitor (journeys)
 *   GET  /visitor?id=       auth   — one visitor's journey, in the order it happened
 *   GET  /vapid-public-key  public — the push public key (not a secret)
 *   GET  /health            public — liveness, and whether journeys are set up
 *
 * Security posture
 *   - The dashboard page holds no secret. Auth is a shared passphrase compared
 *     as a SHA-256 digest (constant length, constant time), so neither the value
 *     nor its length leaks by timing.
 *   - Failed unlock attempts are counted per client and locked out. This matters:
 *     a short numeric passcode is otherwise trivially brute-forced.
 *   - /hit requires the site's Origin, caps body size, and is rate-limited per
 *     visitor so nobody can flood the log or spam the owner's phone. /t also
 *     requires the Origin, and can only add to a page view /hit already accepted.
 *   - Push endpoints are validated against known push services, so a stolen
 *     passphrase cannot turn this Worker into a request proxy.
 *   - CORS never falls back to a wildcard on authenticated routes.
 *
 * Push carries NO payload — it only wakes the service worker, which then calls
 * /recent. No visitor data ever passes through Apple's or Google's push
 * infrastructure.
 *
 * Privacy: the rolling log stores page path, referrer host, coarse city/region
 * from Cloudflare and a daily-rotating pseudonym. A journey stores a salted
 * hash of a random token the visitor's own browser keeps, the pages viewed and
 * buttons pressed, engaged time, each visit's source and approximate location,
 * and — only after an intake is submitted — the request number that page
 * minted. No cookies, no IPs or user agents at rest, no cross-site identifiers,
 * and nothing typed into the intake form, ever.
 */

const MAX_LOG = 120;              // rolling visits retained
const QUIET_MINUTES = 15;         // per-visitor notification debounce
const MAX_BODY = 2048;            // bytes accepted on /hit
const MAX_T_BODY = 4096;          // bytes accepted on /t
const HIT_LIMIT = 20;             // hits per visitor per window
const HIT_WINDOW = 60;            // seconds
const AUTH_MAX_FAILS = 8;         // failed unlocks before lockout
const AUTH_LOCK_SECONDS = 900;    // lockout duration (15 min)
const MAX_SUBS = 10;              // registered devices
const TZ = 'America/New_York';    // for "today" boundaries and every displayed time
const DAYS_KEY = 'days';          // KV: rolling per-day counters {date:{v,a}}
const DAYS_KEEP = 40;             // days of counters retained
const COUNT_WINDOW = 30;          // days summed for the dashboard ticker
const AFF_PREFIX = '/Amazon Click'; // paths logged by an affiliate ping (unused here today)

const HIGH_INTENT = [/^\/intake/, /contact/i];

/* Journeys — see "visitor journeys" below for what each one is for. */
const SESSION_GAP_MS = 30 * 60_000;     // a new visit after 30 minutes with no activity
const ACTIVE_MS = 3 * 60_000;           // "on the site now": activity in the last 3 minutes
const SCORE_WINDOW_MS = 7 * 86_400_000; // the score reads the 7 days before a visitor's last activity
const HIGH_AT = 50;                     // score for HIGH INTENT (with a service page or the intake seen)
const INTERESTED_AT = 20;               // score for INTERESTED
const JOURNEY_KEEP_DAYS = 90;           // journeys older than this are deleted, and a visitor not seen for this long with them
const ALERT_KEEP_DAYS = 30;
const MAX_QUEUE = 20;                   // events accepted in one request
const MAX_BEATS = 30;                   // engagement check-ins per page view: thirty minutes of reading
const MAX_ACTIONS = 60;                 // button presses recorded per visit
const SCORE_EVENT_CAP = 400;            // events the score reads
const LIST_DAYS = 30;                   // the dashboard lists visitors active in the last 30 days
const LIST_CAP = 60;
const DETAIL_VISITS = 10;               // visits drawn on one visitor's journey
const DETAIL_EVENT_CAP = 300;
const T_LIMIT = 90;                     // /t requests per address per minute, per isolate

const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
const PAGE_RE = /^[A-Za-z0-9_-]{8,32}$/;
const EVENT_RE = /^[A-Za-z0-9_-]{4,32}$/;
const CASE_RE = /^API-(\d{4})(\d{2})(\d{2})-\d{4}$/;

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

/* ------------------------------------------------------- visitor journeys */

/*
 * LIVE VISITORS V2 (owner brief 2026-10-10). A page-hit log becomes a journey:
 * new or returning, which pages, how long they were really read, which buttons
 * were pressed, whether an intake was opened, started and submitted, and at
 * what exact time each of those happened.
 *
 * WHERE IT LIVES, AND WHY NOT IN KV. The free plan allows 1,000 KV writes a
 * day and a page view already spends three or four of them on the rolling log,
 * the counter and the rate limiter — and the passcode lockout writes there
 * too, so a feature that exhausted the allowance would switch the lockout off.
 * Journeys go to a D1 database of their own, `VDB` (api-visitor-journeys),
 * which allows 100,000 row writes a day and can answer "which pages did this
 * visitor see" as a query. It is bound to THIS Worker only. The case portal's
 * database, which holds claimant names and signatures, is never reachable from
 * here — the reason the two Workers were kept apart in the first place.
 *
 * IT FAILS OPEN. Without the binding every route answers exactly as it did
 * before and the beacon's new calls are no-ops; a journey write that throws is
 * logged and swallowed. The rolling log, the 30-day counter, the alerts and the
 * intake itself never wait on a journey.
 *
 * WHO A VISITOR IS. A random token the visitor's own browser chose and keeps
 * in its local storage — not an IP address, not a user agent, not a
 * fingerprint — and only a salted hash of it is stored. Two people sharing a
 * network, a city and a phone model are two visitors. One person on two
 * browsers is two visitors as well, and nothing here pretends otherwise.
 */

/* The vocabulary. One writer for every label the dashboard prints; the page
   never names a page, a service or a button itself. */
const SERVICE_LABEL = Object.freeze({
  custody: 'Child Custody', infidelity: 'Infidelity', surveillance: 'Surveillance',
  process: 'Process Serving', private: 'Private Investigation', insurance: 'Insurance', legal: 'Legal',
});
/* The intake form's own service keys (FEES in intake/index.html), mapped into
   that vocabulary, and its doors (?assignment=) for an intake opened before a
   service is chosen. */
const INTAKE_SERVICE = Object.freeze({
  surveillance: 'surveillance', custody: 'custody', process: 'process', claims: 'insurance', legal: 'legal',
});
const INTAKE_DOOR = Object.freeze({ private: 'private', insurance: 'insurance', legal: 'legal' });
/* Legal's five services (LEGAL_SVCS there), carried as detail on a legal submission. */
const LEGAL_SERVICE = Object.freeze({
  locate: 'Person Locate / Skip Trace', process: 'Process Service', general: 'General Investigation',
  surveillance: 'Surveillance', custom: 'Other / Custom Assignment',
});
/* The intake buttons, in the site's own words. The beacon sends the key; the
   wording is decided here. */
const CTA = Object.freeze({
  private:   { label: 'Request a Private Investigation', service: 'private' },
  custody:   { label: 'Request a Child Custody Investigation', service: 'custody' },
  insurance: { label: 'Submit an Insurance Assignment', service: 'insurance' },
  legal:     { label: 'Submit a Legal Assignment', service: 'legal' },
  intake:    { label: 'Start an intake', service: null },
});
/* Every action the journey can hold. Anything else a request names is dropped. */
const ACTIONS = Object.freeze({
  call: 'Clicked Call',
  email: 'Clicked Email',
  contact: 'Clicked Contact',
  cta: 'Clicked Get Started',
  intake_opened: 'Opened intake page',
  intake_started: 'Started intake',
  intake_submitted: 'Submitted intake form',
});
const TIER_LABEL = Object.freeze({ browsing: 'Browsing', interested: 'Interested', high: 'High intent' });

/**
 * What a path IS. `service: null` means the page is not about one service —
 * the homepage, the privacy policy — and earns no service-page points. The
 * intake is its own signal, not a service page.
 */
function pageInfo(path) {
  const p = String(path || '/');
  if (p === '/' || p === '/index.html') return { label: 'Home', service: null };
  if (/^\/child-custody-investigations(\/|$)/.test(p)) return { label: 'Child Custody', service: 'custody' };
  if (/^\/infidelity-investigations(\/|$)/.test(p)) return { label: 'Infidelity', service: 'infidelity' };
  if (/^\/insurance-investigations\/vendor-information(\/|$)/.test(p)) {
    return { label: 'Insurance — Vendor Information', service: 'insurance' };
  }
  if (/^\/insurance-investigations(\/|$)/.test(p)) return { label: 'Insurance Investigations', service: 'insurance' };
  if (/^\/legal-investigations(\/|$)/.test(p)) return { label: 'Legal / Law Firm', service: 'legal' };
  const city = p.match(/^\/private-investigator\/([a-z]+(?:-[a-z]+)*)-va(\/|$)/);
  if (city) return { label: `Private Investigator — ${titleCase(city[1])}`, service: 'private' };
  if (/^\/private-investigator(\/|$)/.test(p)) return { label: 'Private Investigator', service: 'private' };
  if (/^\/intake(\/|$)/.test(p)) return { label: 'Intake', service: null, intake: true };
  if (/^\/privacy(\.html)?\/?$/.test(p)) return { label: 'Privacy Policy', service: null };
  return { label: p, service: null };
}
const titleCase = (slug) => slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * Where a visit came from, from the referring host the browser reported. Only
 * hosts that are certainly a search engine or a social network get its name;
 * anything else is shown as the host it was — never guessed into a category,
 * and never a search phrase, which no referrer carries.
 */
function sourceOf(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!h) return 'Direct';
  if (/(^|\.)google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(h)
      || h === 'com.google.android.googlequicksearchbox') return 'Google';
  if (/(^|\.)bing\.com$/.test(h)) return 'Bing';
  if (/(^|\.)(facebook\.com|fb\.com|fb\.me)$/.test(h)) return 'Facebook';
  if (/(^|\.)instagram\.com$/.test(h)) return 'Instagram';
  if (/(^|\.)duckduckgo\.com$/.test(h)) return 'DuckDuckGo';
  if (/(^|\.)yahoo\.com$/.test(h)) return 'Yahoo';
  return `Referral: ${h}`;
}
/* "from Google" / "Direct" / "from example.com" — the card's wording. */
function sourceLine(source) {
  const s = source || 'Direct';
  if (s === 'Direct') return 'Direct';
  return `from ${s.replace(/^Referral: /, '')}`;
}
function landedLine(source) {
  const s = source || 'Direct';
  return s === 'Direct' ? 'Landed directly' : `Landed from ${s.replace(/^Referral: /, '')}`;
}

let REGION_NAMES = null;
function countryName(code) {
  try {
    REGION_NAMES = REGION_NAMES || new Intl.DisplayNames(['en'], { type: 'region' });
    return REGION_NAMES.of(code) || code;
  } catch (_) { return code; }
}
/**
 * Approximate location, as Cloudflare resolves the connection — the city a
 * network says it is in, which is a guess about an IP address and never where
 * a person is standing. Falls back to the state, then the country.
 */
function placeOf(r) {
  const city = (r && r.city) || '', region = (r && r.region) || '', country = (r && r.country) || '';
  if (city && region) return `${city}, ${region}`;
  if (region) return country && country !== 'US' ? `${region}, ${countryName(country)}` : region;
  if (city) return country ? `${city}, ${countryName(country)}` : city;
  if (country) return countryName(country);
  return 'Location unavailable';
}

/* Every displayed time is composed here, in the business's zone, so a laptop
   set to Pacific draws a Virginia visit at the time it happened in Virginia.
   EST or EDT comes from the date itself; no offset is written down anywhere. */
const FMT_DATE = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });
const FMT_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
});
function stamp(ms) {
  const d = new Date(ms);
  const parts = FMT_TIME.formatToParts(d);
  const zone = (parts.find((p) => p.type === 'timeZoneName') || {}).value || '';
  const time = parts.filter((p) => p.type !== 'timeZoneName').map((p) => p.value).join('')
    .replace(/[  ]/g, ' ').trim();
  const date = FMT_DATE.format(d);
  return { date, time, zone, full: `${date} · ${time} ${zone}` };
}
function durLabel(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
const ordinal = (n) => {
  const t = n % 100;
  const suf = t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th';
  return `${n}${suf}`;
};
const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };

async function visitorIdFor(token, env) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return '';
  return (await sha256Hex(`vid|${token}|${env.SALT || 'api'}`)).slice(0, 32);
}

/* The browser's clock is not ours. Each request carries the client's "now";
   the difference corrects every time it reports, and a clock more than a day
   out is not trusted at all. */
function clientSkew(body, now) {
  const c = Number(body && body.c);
  return Number.isFinite(c) && Math.abs(now - c) < 86_400_000 ? now - c : 0;
}
function eventAt(t, skew, lo, now) {
  const x = Number(t) + skew;
  return Number.isFinite(x) ? Math.min(now, Math.max(lo, Math.round(x))) : now;
}

/* A request number the intake page minted carries its UTC date. One far from
   today was not minted by a submission happening now. */
function caseIsCurrent(caseNo, now) {
  const m = CASE_RE.exec(caseNo);
  if (!m) return false;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) && Math.abs(now - t) < 3 * 86_400_000;
}

function intakeService(d) {
  if (!d || typeof d !== 'object') return null;
  return INTAKE_SERVICE[String(d.svc || '')] || INTAKE_DOOR[String(d.door || '')] || null;
}

/* Best-effort flood control for /t, in this isolate's memory only. /t can
   only add to a page view /hit already accepted (and /hit is rate-limited in
   KV), so this is a second fence, not the first — and it costs no write. */
const T_BUCKETS = new Map();
function tAllowed(key, now) {
  const minute = Math.floor(now / 60_000);
  const b = T_BUCKETS.get(key);
  if (!b || b.minute !== minute) {
    if (T_BUCKETS.size > 5000) T_BUCKETS.clear();
    T_BUCKETS.set(key, { minute, n: 1 });
    return true;
  }
  b.n += 1;
  return b.n <= T_LIMIT;
}

/**
 * The interest score: a deterministic count of what a visitor DID, over the
 * seven days before their last activity. It is not a probability and it is
 * never shown as one. Each reason is listed with its points, so the number is
 * always explainable from the journey beside it.
 *
 * What earns nothing, by construction: a reload (service pages count distinct
 * paths, and engagement only accrues while somebody is actually looking), idle
 * time (the beacon stops the clock a minute after the last touch, and the
 * Worker caps a page's engagement at the wall time since it opened), a
 * duplicate event (each action counts once however often it happens), and a
 * bot (filtered before any journey row exists).
 */
function scoreOf({ visitsTotal, sessions, events }) {
  const reasons = [];
  const add = (pts, icon, label) => reasons.push({ pts, icon, label });
  if (visitsTotal >= 2) add(10, 'return', 'Returning visitor');
  if (sessions.length >= 2) add(10, 'visits', `${sessions.length} visits within 7 days`);
  /* A service page is one the CATALOGUE says is about a service. The intake
     page view carries its door's service for the journey's wording, but it is
     the intake, not a service page — counting it here scored it twice. */
  const services = new Set(events.filter((e) => e.kind === 'page' && pageInfo(e.path).service).map((e) => e.path));
  if (services.size) {
    add(Math.min(services.size, 3) * 5 + (services.size >= 2 ? 5 : 0), 'pages',
      `Viewed ${services.size} service page${services.size === 1 ? '' : 's'}`);
  }
  const engaged = sessions.reduce((n, s) => n + (Number(s.engaged_ms) || 0), 0);
  if (engaged > 120_000) add(engaged > 300_000 ? 15 : 5, 'time', `Spent ${durLabel(engaged)} on site`);
  const acts = new Map();
  for (const e of events) if (e.kind === 'action' && !acts.has(e.name)) acts.set(e.name, e);
  if (acts.has('intake_opened')) add(20, 'intake', 'Opened intake');
  if (acts.has('intake_started')) add(10, 'intake', 'Started intake');
  if (acts.has('call')) add(20, 'call', 'Clicked Call');
  if (acts.has('email') || acts.has('contact')) add(15, 'mail', acts.has('email') ? 'Clicked Email' : 'Clicked Contact');
  if (acts.has('cta')) add(15, 'cta', `Clicked “${(CTA[acts.get('cta').detail] || CTA.intake).label}”`);
  const score = Math.min(100, reasons.reduce((n, r) => n + r.pts, 0));
  /* A homepage-only visit is never HIGH INTENT however long it lasts: that
     tier also needs a service page or the intake to have been seen. */
  const gate = services.size > 0 || acts.has('intake_opened');
  const tier = score >= HIGH_AT && gate ? 'high' : score >= INTERESTED_AT ? 'interested' : 'browsing';
  return { score, tier, reasons, submitted: acts.has('intake_submitted'), servicePages: services.size };
}
const SCORE_RULES = 'Not a probability: a count of what this visitor did in the 7 days before their last activity. '
  + 'Returning visitor +10 · two or more visits within 7 days +10 · each service page +5 (up to three) · '
  + 'more than one service page +5 · over 2 minutes engaged +5, over 5 minutes +10 more · opened the intake +20 · '
  + 'started the intake +10 · clicked Call +20 · Email or Contact +15 · an intake button (Get Started) +15. '
  + `Reloads, idle time, repeated clicks and bots add nothing. ${HIGH_AT}+ with a service page or the intake seen `
  + `is High intent; ${INTERESTED_AT}+ is Interested. A submitted intake is shown as New intake whatever the score.`;

/**
 * Likely interest, from what the visitor actually looked at and pressed, in
 * the site's own service vocabulary. A submission decides it; an opened intake
 * or an intake button outweighs pages; a specific service outweighs the
 * general Private Investigator pages. No evidence is "not determined".
 */
function interestOf(events) {
  const weight = {}, last = {}, basis = {};
  const bump = (svc, pts, at, why) => {
    if (!svc) return;
    weight[svc] = (weight[svc] || 0) + pts;
    last[svc] = Math.max(last[svc] || 0, at);
    basis[svc] = basis[svc] || [];
    if (why && !basis[svc].includes(why)) basis[svc].push(why);
  };
  for (const e of events) {
    const info = e.kind === 'page' ? pageInfo(e.path) : null;
    if (info && info.service) {
      bump(info.service, 10 + Math.min(10, Math.floor((Number(e.engaged_ms) || 0) / 30_000)), e.at,
        `${info.label} page`);
    } else if (e.kind === 'action' && e.service) {
      const label = SERVICE_LABEL[e.service] || '';
      if (e.name === 'intake_submitted') bump(e.service, 100, e.at, `${label} intake submitted`);
      else if (e.name === 'intake_opened') bump(e.service, 40, e.at, `${label} intake opened`);
      else if (e.name === 'cta') bump(e.service, 30, e.at, `“${(CTA[e.detail] || CTA.intake).label}”`);
    }
  }
  const keys = Object.keys(weight);
  const specific = keys.filter((k) => k !== 'private');
  const pool = specific.length ? specific : keys;
  if (!pool.length) return { interest: null, basis: [] };
  pool.sort((a, b) => weight[b] - weight[a] || last[b] - last[a]);
  return { interest: pool[0], basis: basis[pool[0]] };
}

/* Recompute one visitor's score, tier, interest and card summary from the
   journey, and store them when anything moved. The Worker is the only writer
   of these; the dashboard prints what is stored. */
async function rescore(env, vid) {
  const db = env.VDB;
  const v = await db.prepare('SELECT * FROM visitor WHERE id = ?1').bind(vid).first();
  if (!v) return null;
  const from = Number(v.last_at) - SCORE_WINDOW_MS;
  const sessions = ((await db.prepare(
    'SELECT id, started_at, last_at, engaged_ms FROM visitor_session WHERE visitor_id = ?1 AND started_at >= ?2 ORDER BY started_at'
  ).bind(vid, from).all()).results) || [];
  const events = ((await db.prepare(
    'SELECT kind, name, path, service, detail, engaged_ms, at FROM visitor_event WHERE visitor_id = ?1 AND at >= ?2 ORDER BY at, rowid LIMIT ?3'
  ).bind(vid, from, SCORE_EVENT_CAP).all()).results) || [];
  const s = scoreOf({ visitsTotal: Number(v.sessions) || 0, sessions, events });
  const i = interestOf(events);
  const paths = new Set(events.filter((e) => e.kind === 'page').map((e) => e.path));
  const summary = JSON.stringify({
    pages: paths.size,
    opened: events.some((e) => e.kind === 'action' && e.name === 'intake_opened'),
    only: paths.size === 1 ? pageInfo([...paths][0]).label : null,
    basis: i.basis,
  });
  const reasons = JSON.stringify(s.reasons);
  if (s.score !== v.score || s.tier !== v.tier || i.interest !== v.interest
      || reasons !== v.reasons || summary !== v.summary) {
    await db.prepare('UPDATE visitor SET score = ?2, tier = ?3, interest = ?4, reasons = ?5, summary = ?6 WHERE id = ?1')
      .bind(vid, s.score, s.tier, i.interest, reasons, summary).run();
  }
  return { visitor: v, after: s, events };
}

/* The HIGH INTENT alert's sentence: who, and the strongest thing they did. */
function highPhrase(r) {
  const who = (Number(r.visitor.sessions) || 0) >= 2 ? 'Returning visitor' : 'New visitor';
  const acts = r.events.filter((e) => e.kind === 'action');
  const lastOf = (name) => { for (let i = acts.length - 1; i >= 0; i--) if (acts[i].name === name) return acts[i]; return null; };
  const opened = lastOf('intake_opened');
  const what = SERVICE_LABEL[opened && opened.service];
  if (lastOf('intake_started')) return `${who} started ${what ? what + ' ' : 'the '}intake.`;
  if (opened) return `${who} opened ${what ? what + ' ' : 'the '}intake.`;
  if (lastOf('call')) return `${who} clicked Call.`;
  const cta = lastOf('cta');
  if (cta) return `${who} clicked “${(CTA[cta.detail] || CTA.intake).label}”.`;
  return `${who} viewed ${r.after.servicePages} service pages.`;
}

/**
 * After a journey changed: rescore, then decide whether the phone hears about
 * it. At most ONE alert per request, strongest first, and never twice for the
 * same thing:
 *   - NEW INTAKE — an intake_submitted row that did not exist before;
 *   - HIGH INTENT VISITOR — the tier crossing INTO high, once per 7 days;
 *   - a new visit — once per visit, because a visit is only opened once.
 * A refresh, another page or a heartbeat inside the same tier says nothing.
 */
async function afterJourney(env, vid, now, facts) {
  const r = await rescore(env, vid);
  if (!r) return null;
  const db = env.VDB;
  const ses = await db.prepare('SELECT * FROM visitor_session WHERE visitor_id = ?1 ORDER BY last_at DESC LIMIT 1')
    .bind(vid).first();
  const place = placeOf(ses || {});
  const was = r.visitor;
  let alert = null;
  if (facts.newIntake) {
    const label = SERVICE_LABEL[facts.newIntake.service];
    /* No request number on a lock screen — the same rule the portal applies
       to a text message. The dashboard shows it once unlocked. */
    alert = { kind: 'intake', title: 'NEW INTAKE', body: `${place}\n${label ? label + ' intake' : 'Intake'} submitted.` };
  } else if (r.after.tier === 'high' && was.tier !== 'high' && !r.after.submitted
             && !(was.alerted_high_at && now - Number(was.alerted_high_at) < SCORE_WINDOW_MS)) {
    alert = { kind: 'high', title: 'HIGH INTENT VISITOR', body: `${place}\n${highPhrase(r)}` };
    await db.prepare('UPDATE visitor SET alerted_high_at = ?2 WHERE id = ?1').bind(vid, now).run();
  } else if (facts.opened && ses) {
    const returning = (Number(was.sessions) || 0) >= 2;
    const src = ses.source && ses.source !== 'Direct' ? ` (${sourceLine(ses.source)})` : '';
    alert = {
      kind: 'visit',
      title: returning ? 'Returning visitor on your website' : 'Visitor on your website',
      body: `${pageInfo(ses.current_path).label} — ${place}${src}`,
    };
  }
  if (alert) {
    await db.prepare('INSERT INTO visitor_alert (at, kind, visitor_id, session_id, title, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(now, alert.kind, vid, ses ? ses.id : null, alert.title, alert.body).run();
    await notifyAll(env);
  }
  return { tier: r.after.tier, score: r.after.score, alerted: alert ? alert.kind : null };
}

/**
 * Apply queued events — engagement and button presses — to page views this
 * visitor already has. Nothing here can create a visitor, a visit or a page
 * view: an event naming a page this visitor never recorded is dropped.
 */
async function applyQueue(env, vid, items, now, skew) {
  const out = { applied: 0, touched: false, newIntake: null };
  if (!Array.isArray(items) || !items.length) return out;
  const db = env.VDB;
  const pages = new Map();
  const pageOf = async (pv) => {
    if (!PAGE_RE.test(pv)) return null;
    const id = `${vid}:${pv}`;
    if (!pages.has(id)) {
      pages.set(id, await db.prepare(
        "SELECT id, session_id, at, path, service, engaged_ms, beats FROM visitor_event WHERE id = ?1 AND visitor_id = ?2 AND kind = 'page'"
      ).bind(id, vid).first());
    }
    return pages.get(id);
  };
  for (const it of items.slice(0, MAX_QUEUE)) {
    if (!it || typeof it !== 'object') continue;
    const page = await pageOf(String(it.p || ''));
    if (!page) continue;

    if (it.k === 'e') {
      /* Engagement is the page's running total, so a repeat is harmless and
         the larger figure wins. It can never exceed the wall time since the
         page opened, whatever a request claims. */
      const cap = Math.max(0, now - Number(page.at) + 5_000);
      const ms = Math.min(cap, Math.max(0, Math.round(Number(it.m) || 0)));
      const beat = it.b ? 1 : 0;
      if (beat && Number(page.beats) >= MAX_BEATS) continue;
      if (ms <= Number(page.engaged_ms)) continue;
      await db.batch([
        db.prepare('UPDATE visitor_session SET engaged_ms = engaged_ms + MAX(0, ?1 - (SELECT engaged_ms FROM visitor_event WHERE id = ?2)), last_at = MAX(last_at, ?3) WHERE id = ?4')
          .bind(ms, page.id, now, page.session_id),
        db.prepare('UPDATE visitor SET engaged_ms = engaged_ms + MAX(0, ?1 - (SELECT engaged_ms FROM visitor_event WHERE id = ?2)), last_at = MAX(last_at, ?3) WHERE id = ?4')
          .bind(ms, page.id, now, vid),
        db.prepare('UPDATE visitor_event SET engaged_ms = MAX(engaged_ms, ?1), beats = beats + ?2 WHERE id = ?3')
          .bind(ms, beat, page.id),
      ]);
      page.engaged_ms = Math.max(Number(page.engaged_ms), ms);
      page.beats = Number(page.beats) + beat;
      out.applied += 1; out.touched = true;
      continue;
    }

    if (it.k !== 'a') continue;
    const name = String(it.a || '');
    /* intake_opened is the Worker's own fact, written when the intake page
       view arrives — a request cannot claim it. */
    if (!Object.hasOwn(ACTIONS, name) || name === 'intake_opened') continue;
    const onIntake = /^\/intake(\/|$)/.test(String(page.path));
    if ((name === 'intake_started' || name === 'intake_submitted') && !onIntake) continue;
    const at = eventAt(it.t, skew, Number(page.at) - 5_000, now);
    let id, detail = null, service = null, related = null;
    if (name === 'intake_started') {
      id = `${page.id}:started`;
    } else if (name === 'intake_submitted') {
      /* THE LINK TO AN INTAKE. Deterministic and first-party: this event
         arrives with the same browser token as the page views before it, on
         the intake page view it was submitted from, carrying the request
         number that page minted. Never inferred from an address, a city, a
         browser or a nearby time. Nothing the visitor typed is in it. */
      related = String(it.n || '');
      if (!caseIsCurrent(related, now)) continue;
      service = INTAKE_SERVICE[String(it.s || '')] || null;
      detail = service === 'legal' && Object.hasOwn(LEGAL_SERVICE, String(it.l || '')) ? String(it.l) : null;
      id = `${vid}:case:${related}`;
    } else {
      const e = String(it.e || '');
      if (!EVENT_RE.test(e)) continue;
      id = `${page.id}:${e}`;
      if (name === 'cta') {
        const key = String(it.d || '');
        if (!Object.hasOwn(CTA, key)) continue;
        detail = key;
        service = CTA[key].service;
      }
    }
    const count = await db.prepare("SELECT COUNT(*) AS n FROM visitor_event WHERE session_id = ?1 AND kind = 'action'")
      .bind(page.session_id).first('n');
    if (Number(count) >= MAX_ACTIONS) continue;
    const ins = await db.prepare(
      "INSERT OR IGNORE INTO visitor_event (id, visitor_id, session_id, page_id, at, kind, name, path, service, detail, related_submission_id) VALUES (?1, ?2, ?3, ?4, ?5, 'action', ?6, ?7, ?8, ?9, ?10)"
    ).bind(id, vid, page.session_id, page.id, at, name, page.path, service, detail, related).run();
    if (!ins.meta || ins.meta.changes !== 1) continue;   // already recorded: a retry, never a second press
    const stmts = [
      db.prepare('UPDATE visitor_session SET last_at = MAX(last_at, ?2) WHERE id = ?1').bind(page.session_id, at),
      db.prepare('UPDATE visitor SET last_at = MAX(last_at, ?2) WHERE id = ?1').bind(vid, at),
    ];
    if (name === 'intake_submitted') {
      stmts.push(db.prepare(
        'UPDATE visitor SET intake_case = ?2, intake_at = ?3, intake_service = ?4 WHERE id = ?1 AND (intake_at IS NULL OR intake_at <= ?3)'
      ).bind(vid, related, at, service));
      out.newIntake = { case: related, service, at };
    }
    await db.batch(stmts);
    out.applied += 1; out.touched = true;
  }
  return out;
}

/* Once a day, on the first page view of it: journeys past their keeping are
   deleted. The marker is a row in this database, so the check costs no KV. */
async function sweepJourneys(env, now) {
  const db = env.VDB;
  const day = localDayStr(now);
  if ((await db.prepare("SELECT v FROM visitor_meta WHERE k = 'swept'").first('v')) === day) return false;
  const cut = now - JOURNEY_KEEP_DAYS * 86_400_000;
  await db.batch([
    db.prepare("INSERT INTO visitor_meta (k, v) VALUES ('swept', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(day),
    db.prepare('DELETE FROM visitor_event WHERE at < ?1').bind(cut),
    db.prepare('DELETE FROM visitor_session WHERE last_at < ?1').bind(cut),
    db.prepare('DELETE FROM visitor WHERE last_at < ?1').bind(cut),
    db.prepare('DELETE FROM visitor_alert WHERE at < ?1').bind(now - ALERT_KEEP_DAYS * 86_400_000),
  ]);
  return true;
}

/**
 * Record a page view in the journey: the visitor (first sighting), the visit
 * (a new one after SESSION_GAP_MS of nothing), the page, and on the intake
 * page the fact that it was opened. Then any queued events, the score and the
 * alerts. Returns null when the request carries no page-view id.
 */
async function journeyPage(env, { vid, body, path, refHost, cf, now }) {
  const db = env.VDB;
  const pv = String(body.pv || '');
  if (!PAGE_RE.test(pv)) return null;
  const skew = clientSkew(body, now);
  // When the page opened, by the visitor's corrected clock: the beacon waits
  // for a human signal before it sends, and the journey wants the arrival.
  const at = eventAt(body.lt, skew, now - 15 * 60_000, now);
  const pid = `${vid}:${pv}`;
  const page = pageInfo(path);

  await db.prepare('INSERT INTO visitor (id, first_at, last_at) VALUES (?1, ?2, ?2) ON CONFLICT(id) DO NOTHING')
    .bind(vid, at).run();
  let opened = false;
  const known = await db.prepare('SELECT session_id FROM visitor_event WHERE id = ?1').bind(pid).first();
  if (!known) {
    /* One statement decides whether a visit is open, so two pages arriving at
       once cannot open two visits: D1 runs statements one at a time. */
    const fresh = crypto.randomUUID();
    const made = await db.prepare(
      `INSERT INTO visitor_session (id, visitor_id, started_at, last_at, landing_path, current_path, source, ref_host, city, region, country)
       SELECT ?1, ?2, ?3, ?3, ?4, ?4, ?5, ?6, ?7, ?8, ?9
        WHERE NOT EXISTS (SELECT 1 FROM visitor_session WHERE visitor_id = ?2 AND last_at >= ?10)`
    ).bind(fresh, vid, at, path, sourceOf(refHost), refHost || null,
      String(cf.city || '').slice(0, 60) || null, String(cf.region || '').slice(0, 60) || null,
      String(cf.country || '').slice(0, 4) || null, at - SESSION_GAP_MS).run();
    opened = Boolean(made.meta && made.meta.changes === 1);
    const sid = opened ? fresh : await db.prepare(
      'SELECT id FROM visitor_session WHERE visitor_id = ?1 AND last_at >= ?2 ORDER BY last_at DESC LIMIT 1'
    ).bind(vid, at - SESSION_GAP_MS).first('id');
    if (!sid) return null;
    const service = page.intake ? intakeService(body.d) : page.service;
    const stmts = [
      db.prepare("INSERT OR IGNORE INTO visitor_event (id, visitor_id, session_id, page_id, at, kind, path, service) VALUES (?1, ?2, ?3, ?1, ?4, 'page', ?5, ?6)")
        .bind(pid, vid, sid, at, path, service),
      db.prepare('UPDATE visitor_session SET pages = pages + 1, current_path = CASE WHEN ?2 >= last_at THEN ?3 ELSE current_path END, last_at = MAX(last_at, ?2) WHERE id = ?1')
        .bind(sid, at, path),
      db.prepare('UPDATE visitor SET last_at = MAX(last_at, ?2), sessions = sessions + ?3 WHERE id = ?1')
        .bind(vid, at, opened ? 1 : 0),
    ];
    if (page.intake) {
      stmts.push(db.prepare(
        "INSERT OR IGNORE INTO visitor_event (id, visitor_id, session_id, page_id, at, kind, name, path, service) VALUES (?1, ?2, ?3, ?4, ?5, 'action', 'intake_opened', ?6, ?7)"
      ).bind(`${pid}:open`, vid, sid, pid, at, path, service));
    }
    await db.batch(stmts);
  }
  const q = await applyQueue(env, vid, body.q, now, skew);
  const after = await afterJourney(env, vid, now, { opened, newIntake: q.newIntake });
  await sweepJourneys(env, now);
  return { opened, alerted: after && after.alerted };
}

/* One card per recent visitor, every string composed here. */
function visitorCard(r, now) {
  const sum = parseJson(r.summary) || {};
  const visits = Number(r.sessions) || 0;
  const visits7 = Number(r.visits7) || 0;
  const pages = Number(sum.pages) || 0;
  const newIntake = Boolean(r.intake_at && Number(r.intake_at) >= Number(r.last_at) - SCORE_WINDOW_MS);
  const interest = r.interest ? SERVICE_LABEL[r.interest] || null : null;
  return {
    id: r.id,
    path: r.current_path || '/',
    page_label: pageInfo(r.current_path).label,
    live: now - Number(r.seen_at || r.last_at) < ACTIVE_MS,
    last_at: Number(r.last_at),
    last_label: stamp(Number(r.last_at)).full,
    place: placeOf(r),
    source: r.source || 'Direct',
    source_line: sourceLine(r.source),
    returning: visits >= 2,
    visits, visits7,
    visits_line: visits === 1 ? '1 visit' : `${visits} visits`,
    visits_sub: visits <= 1 ? 'first time' : `(${visits7} this week)`,
    engaged_label: durLabel(r.engaged_ms),
    activity_line: newIntake ? 'Submitted intake' : sum.opened ? 'Viewed intake' : `Viewed ${pages} page${pages === 1 ? '' : 's'}`,
    activity_sub: interest || (pages === 1 && sum.only ? sum.only : 'Interest not determined'),
    score: Number(r.score) || 0,
    tier: r.tier || 'browsing',
    tier_label: TIER_LABEL[r.tier] || TIER_LABEL.browsing,
    interest,
    new_intake: newIntake,
  };
}

const CARD_SQL = `
  SELECT v.id, v.first_at, v.last_at, v.sessions, v.engaged_ms, v.score, v.tier, v.interest, v.summary, v.reasons,
         v.intake_case, v.intake_at, v.intake_service,
         s.id AS session_id, s.current_path, s.landing_path, s.source, s.ref_host, s.city, s.region, s.country,
         s.last_at AS seen_at, s.started_at AS seen_started, s.engaged_ms AS seen_engaged,
         (SELECT COUNT(*) FROM visitor_session w WHERE w.visitor_id = v.id AND w.started_at >= ?2) AS visits7
    FROM visitor v
    JOIN visitor_session s ON s.id = (SELECT x.id FROM visitor_session x WHERE x.visitor_id = v.id ORDER BY x.last_at DESC LIMIT 1)`;

async function handleVisitors(env) {
  if (!env.VDB) return json({ ok: false, code: 'journeys_not_set_up' });
  const now = Date.now();
  const rows = ((await env.VDB.prepare(`${CARD_SQL} WHERE v.last_at >= ?1 ORDER BY v.last_at DESC LIMIT ?3`)
    .bind(now - LIST_DAYS * 86_400_000, now - 7 * 86_400_000, LIST_CAP).all()).results) || [];
  return json({ ok: true, now, tz: TZ, active_ms: ACTIVE_MS, visitors: rows.map((r) => visitorCard(r, now)) });
}

/* The journey rows of one visit, in the order they happened. A reload — the
   same page again with nothing between — is one row that says so, not two. */
function journeyRows(visit, events, zone) {
  const rows = [];
  let first = true;
  for (const e of events) {
    const st = stamp(Number(e.at));
    const when = { at: Number(e.at), time: st.time, zone: st.zone !== zone ? st.zone : '', full: st.full };
    if (e.kind === 'page') {
      const info = pageInfo(e.path);
      const prev = rows[rows.length - 1];
      if (prev && prev.kind === 'page' && prev.path === e.path) {
        prev.views += 1;
        prev.engaged_ms += Number(e.engaged_ms) || 0;
        prev.engaged_label = durLabel(prev.engaged_ms);
        continue;
      }
      const svc = info.intake && e.service ? SERVICE_LABEL[e.service] : '';
      rows.push({
        kind: 'page', ...when, path: e.path,
        label: first ? landedLine(visit.source)
          : info.intake ? `Opened Intake${svc ? ' — ' + svc : ''}` : `Viewed ${info.label}`,
        page_label: info.intake ? `Intake${svc ? ' — ' + svc : ''}` : info.label,
        engaged_ms: Number(e.engaged_ms) || 0,
        engaged_label: durLabel(e.engaged_ms),
        views: 1,
      });
      first = false;
    } else if (e.kind === 'action') {
      if (e.name === 'intake_opened') continue;   // the intake page's own row already says it
      const svc = SERVICE_LABEL[e.service] || '';
      let label = ACTIONS[e.name] || e.name, sub = '';
      if (e.name === 'cta') label = `Clicked “${(CTA[e.detail] || CTA.intake).label}”`;
      if (e.name === 'intake_started') label = 'Started intake';
      if (e.name === 'intake_submitted') {
        label = 'Intake submitted';
        sub = `Form: ${svc || 'Intake'}${e.detail && LEGAL_SERVICE[e.detail] ? ' — ' + LEGAL_SERVICE[e.detail] : ''}`;
      }
      rows.push({ kind: 'action', ...when, name: e.name, label, sub, case: e.related_submission_id || null });
    }
  }
  return rows;
}

async function handleVisitor(env, url) {
  if (!env.VDB) return json({ ok: false, code: 'journeys_not_set_up' });
  const id = String(url.searchParams.get('id') || '');
  if (!/^[0-9a-f]{32}$/.test(id)) return json({ ok: false, error: 'not found' }, 404);
  const db = env.VDB;
  const now = Date.now();
  const r = await db.prepare(`${CARD_SQL} WHERE v.id = ?1`).bind(id, now - 7 * 86_400_000).first();
  if (!r) return json({ ok: false, error: 'not found' }, 404);
  const visits = (((await db.prepare(
    'SELECT * FROM visitor_session WHERE visitor_id = ?1 ORDER BY started_at DESC LIMIT ?2'
  ).bind(id, DETAIL_VISITS).all()).results) || []).reverse();
  const from = visits.length ? Number(visits[0].started_at) - 60_000 : now;
  const events = ((await db.prepare(
    'SELECT * FROM visitor_event WHERE visitor_id = ?1 AND at >= ?2 ORDER BY at, rowid LIMIT ?3'
  ).bind(id, from, DETAIL_EVENT_CAP).all()).results) || [];
  const card = visitorCard(r, now);
  const total = Number(r.sessions) || visits.length;
  const firstNo = Math.max(1, total - visits.length + 1);

  const journey = visits.map((s, i) => {
    const st = stamp(Number(s.started_at));
    const rows = journeyRows(s, events.filter((e) => e.session_id === s.id), st.zone);
    return {
      n: firstNo + i,
      date: st.date, zone: st.zone, started_label: st.full,
      source: s.source || 'Direct', source_line: sourceLine(s.source), place: placeOf(s),
      landing: s.landing_path, engaged_label: durLabel(s.engaged_ms),
      rows,
    };
  });
  const pages = [], actions = [];
  for (const v of journey) {
    for (const row of v.rows) {
      if (row.kind === 'page') pages.push({ label: row.page_label, path: row.path, engaged_label: row.engaged_label, time: row.time, full: row.full, views: row.views });
    }
  }
  for (const e of events) {
    if (e.kind !== 'action') continue;
    const st = stamp(Number(e.at));
    const svc = SERVICE_LABEL[e.service] || '';
    let label = ACTIONS[e.name] || e.name;
    if (e.name === 'cta') label = `Clicked “${(CTA[e.detail] || CTA.intake).label}”`;
    if (e.name === 'intake_opened' && svc) label += ` — ${svc}`;
    if (e.name === 'intake_submitted' && svc) label += ` — ${svc}`;
    actions.push({ name: e.name, label, time: st.time, full: st.full, case: e.related_submission_id || null });
  }
  const visits7 = Number(r.visits7) || 0;
  const facts = [];
  if (total >= 2) facts.push({ label: 'Returning visitor', sub: `${ordinal(total)} visit${visits7 >= 2 ? ' this week' : ''}` });

  const sum = parseJson(r.summary) || {};
  const first = stamp(Number(r.first_at));
  const lastS = stamp(Number(r.last_at));
  return json({
    ok: true, now, tz: TZ,
    visitor: {
      ...card,
      first_label: first.full,
      last_label: lastS.full,
      visits_detail: `${total} (${visits7} in last 7 days)`,
      engaged_total_label: durLabel(r.engaged_ms),
      engaged_visit_label: durLabel(r.seen_engaged),
      landing: r.landing_path || '/',
      source_detail: r.source || 'Direct',
      current_label: pageInfo(r.current_path).label,
      reasons: parseJson(r.reasons) || [],
      score_rules: SCORE_RULES,
      interest_basis: Array.isArray(sum.basis) ? sum.basis : [],
      intake: r.intake_case ? {
        case: r.intake_case,
        label: stamp(Number(r.intake_at)).full,
        service: SERVICE_LABEL[r.intake_service] || null,
      } : null,
      earlier_visits: Math.max(0, total - visits.length),
    },
    journey, pages, actions, facts,
  });
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
  const token = typeof body.id === 'string' && TOKEN_RE.test(body.id) ? body.id : '';
  /* The day's pseudonym for the rolling log and the 30-day counter's
     same-day dedupe. From the visitor's own token when the beacon sends one —
     so two people sharing an address and a phone model are two visits, not
     one — and from the address and user agent only for an older beacon that
     sends no token, which is the daily hash this has always used. */
  const vkey = token
    ? (await sha256Hex(['day', token, day, env.SALT || 'api'].join('|'))).slice(0, 16)
    : (await sha256Hex([
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

  /* The journey, when the database is bound and the beacon sent a token. Its
     alerts replace the older ones below for this page view; if it is not set
     up, or fails, the older alerts still run — fail open, never silent. */
  let journey = !env.VDB ? 'not_set_up' : !token ? 'no_token' : 'pending';
  if (journey === 'pending') {
    try {
      const vid = await visitorIdFor(token, env);
      const jr = await journeyPage(env, { vid, body, path, refHost, cf, now: visit.t });
      if (jr) return json({ ok: true, journey: 'recorded', notified: Boolean(jr.alerted) });
      journey = 'skipped';
    } catch (err) {
      console.error('journey write failed', err && err.stack);
      journey = 'error';
    }
  }

  const hot = HIGH_INTENT.some((re) => re.test(path));
  const seenKey = `seen:${vkey}`;
  const seen = await env.HITS.get(seenKey);
  if (!seen || hot) {
    await env.HITS.put(seenKey, '1', { expirationTtl: QUIET_MINUTES * 60 });
    await notifyAll(env);
    return json({ ok: true, notified: true, journey });
  }
  return json({ ok: true, notified: false, journey });
}

/**
 * Engagement check-ins and button presses for page views /hit already
 * recorded. It writes NOTHING to KV — the rolling log and its counters are
 * the page views' business, and the KV write allowance is spoken for — and it
 * cannot create a visitor, a visit or a page.
 */
async function handleTrack(request, env) {
  const origin = request.headers.get('origin');
  if (!env.SITE_ORIGIN || origin !== env.SITE_ORIGIN) return json({ ok: false, error: 'origin' }, 403);
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_T_BODY) return json({ ok: false, error: 'too large' }, 413);
  const text = await request.text();
  if (text.length > MAX_T_BODY) return json({ ok: false, error: 'too large' }, 413);
  let body;
  try { body = JSON.parse(text); } catch (_) { return json({ ok: false, error: 'bad json' }, 400); }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'bad json' }, 400);
  if (!env.VDB) return json({ ok: true, journey: 'not_set_up' });

  const now = Date.now();
  const bucket = (await sha256Hex(`t|${request.headers.get('cf-connecting-ip') || ''}|${env.SALT || 'api'}`)).slice(0, 16);
  if (!tAllowed(bucket, now)) return json({ ok: false, error: 'rate limited' }, 429);
  const vid = await visitorIdFor(body.id, env);
  if (!vid) return json({ ok: true, applied: 0 });
  try {
    if (!(await env.VDB.prepare('SELECT id FROM visitor WHERE id = ?1').bind(vid).first())) {
      return json({ ok: true, applied: 0 });
    }
    const q = await applyQueue(env, vid, body.q, now, clientSkew(body, now));
    const after = q.touched ? await afterJourney(env, vid, now, { opened: false, newIntake: q.newIntake }) : null;
    return json({ ok: true, applied: q.applied, notified: Boolean(after && after.alerted) });
  } catch (err) {
    console.error('journey event failed', err && err.stack);
    return json({ ok: true, journey: 'error' });
  }
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

  const out = {
    ok: true,
    now,
    online: new Set(people.filter((h) => now - h.t < 3 * 60_000).map((h) => h.v)).size,
    todayCount: people.filter((h) => h.t >= dayStart).length,
    visits: people.slice(0, 60),
    botsToday: bots.filter((h) => h.t >= dayStart).length,
    visits30: sum('v'),
    aff30: sum('a'),
    affTotal: await affTotalValue(env, days),
    journeys: 'not_set_up',
  };
  /* With journeys on, "on the site now" and "visits today" are counted from
     visits rather than page views, and the newest alerts ride along so the
     phone's service worker can say what woke it. The 30-day ticker stays on
     the KV counter: it holds the history from before journeys existed. */
  if (env.VDB) {
    try {
      const db = env.VDB;
      const online = await db.prepare('SELECT COUNT(DISTINCT visitor_id) AS n FROM visitor_session WHERE last_at >= ?1')
        .bind(now - ACTIVE_MS).first('n');
      const today = await db.prepare('SELECT COUNT(*) AS n FROM visitor_session WHERE started_at >= ?1')
        .bind(dayStart).first('n');
      const alerts = ((await db.prepare(
        'SELECT id, at, kind, title, body, visitor_id FROM visitor_alert WHERE at >= ?1 ORDER BY id DESC LIMIT 5'
      ).bind(now - 10 * 60_000).all()).results) || [];
      Object.assign(out, { journeys: 'ready', online: Number(online) || 0, visitsToday: Number(today) || 0, alerts });
    } catch (err) {
      console.error('journey summary failed', err && err.stack);
      out.journeys = 'error';
    }
  }
  return json(out);
}

async function journeyHealth(env) {
  if (!env.VDB) return 'not_set_up';
  try {
    await env.VDB.prepare('SELECT COUNT(*) AS n FROM visitor_meta').first();
    return 'ready';
  } catch (_) { return 'schema_missing'; }
}

/* ----------------------------------------------------------------- entry */

const AUTH_ROUTES = new Set(['/subscribe', '/unsubscribe', '/recent', '/visitors', '/visitor']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isAuthRoute = AUTH_ROUTES.has(url.pathname);
    const cors = corsHeaders(env, isAuthRoute);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let res;
    try {
      if (url.pathname === '/health') {
        res = json({
          ok: true,
          configured: Boolean(env.WATCH_PASSWORD && env.VAPID_PUBLIC_KEY),
          journeys: await journeyHealth(env),
        });
      } else if (url.pathname === '/vapid-public-key') {
        res = json({ key: env.VAPID_PUBLIC_KEY || null });
      } else if (url.pathname === '/hit' && request.method === 'POST') {
        res = await handleHit(request, env);
      } else if (url.pathname === '/t' && request.method === 'POST') {
        res = await handleTrack(request, env);
      } else if (isAuthRoute) {
        const auth = await checkAuth(request, env);
        if (!auth.ok) {
          res = authFailure(auth);
        } else if (url.pathname === '/recent') {
          res = await handleRecent(env);
        } else if (url.pathname === '/visitors' && request.method === 'GET') {
          res = await handleVisitors(env);
        } else if (url.pathname === '/visitor' && request.method === 'GET') {
          res = await handleVisitor(env, url);
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
