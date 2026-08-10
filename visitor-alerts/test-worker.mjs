/**
 * Tests for the visitor-alerts Worker.
 *
 * Runs the real worker module against an in-memory KV and a stubbed fetch,
 * so behaviour is verified before anything is deployed.
 *
 *   node visitor-alerts/test-worker.mjs
 */
import worker from './worker.js';

/* ------------------------------------------------------------ test harness */

let passed = 0, failed = 0;
const results = [];

function ok(name, cond, detail = '') {
  if (cond) { passed++; results.push(`  PASS  ${name}`); }
  else { failed++; results.push(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

/** Minimal KV stand-in with TTL support. */
function makeKV() {
  const store = new Map();
  const alive = (rec) => !rec.exp || rec.exp > Date.now();
  return {
    _store: store,
    async get(key) { const r = store.get(key); return r && alive(r) ? r.value : null; },
    async put(key, value, opts = {}) {
      store.set(key, { value, exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 });
    },
    async delete(key) { store.delete(key); },
    async list({ prefix = '' } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix) && alive(store.get(k))).map((name) => ({ name })) };
    },
    _expire(key) { const r = store.get(key); if (r) r.exp = Date.now() - 1; },
  };
}

const SITE = 'https://alwayspreciseinvestigations.net';
// Fixture only — never the live WATCH_PASSWORD. The real one is a Worker
// secret and must not appear in this repository.
const PASS = 'test-passphrase-not-the-real-one';

// A real P-256 key pair so VAPID signing is genuinely exercised.
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const rawPub = await crypto.subtle.exportKey('raw', kp.publicKey);
const jwkPriv = await crypto.subtle.exportKey('jwk', kp.privateKey);
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function makeEnv() {
  return {
    HITS: makeKV(),
    SUBS: makeKV(),
    SITE_ORIGIN: SITE,
    WATCH_PASSWORD: PASS,
    SALT: 'test-salt',
    VAPID_PUBLIC_KEY: b64url(rawPub),
    VAPID_PRIVATE_KEY: jwkPriv.d,
    VAPID_SUBJECT: 'mailto:test@example.com',
  };
}

let pushCalls = [];
globalThis.fetch = async (url, init) => {
  pushCalls.push({ url: String(url), init });
  return new Response(null, { status: 201 });
};

const HUMAN_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const SIGNALS = { tz: 'America/New_York', w: 390, h: 844, t: 4200 };

function hit(body = {}, { origin = SITE, ua = HUMAN_UA, ip = '203.0.113.9', cf = {} } = {}) {
  const payload = JSON.stringify({ path: '/', ref: '', s: SIGNALS, ...body });
  const req = new Request('https://w.dev/hit', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
      'user-agent': ua,
      'cf-connecting-ip': ip,
    },
    body: payload,
  });
  req.cf = cf;
  return req;
}

function authed(path, { token = PASS, method = 'GET', body, ip = '203.0.113.9' } = {}) {
  const req = new Request('https://w.dev' + path, {
    method,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'cf-connecting-ip': ip },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  req.cf = {};
  return req;
}

const call = (req, env) => worker.fetch(req, env);

/* ------------------------------------------------------------------ tests */

// --- origin locking
{
  const env = makeEnv();
  ok('rejects a beacon with no Origin header',
    (await call(hit({}, { origin: null }), env)).status === 403);
  ok('rejects a beacon from a foreign Origin',
    (await call(hit({}, { origin: 'https://evil.example' }), env)).status === 403);
  ok('accepts a beacon from the site Origin',
    (await call(hit(), env)).status === 200);
}

// --- body limits and malformed input
{
  const env = makeEnv();
  const big = new Request('https://w.dev/hit', {
    method: 'POST',
    headers: { origin: SITE, 'user-agent': HUMAN_UA, 'content-type': 'application/json' },
    body: 'x'.repeat(5000),
  });
  big.cf = {};
  ok('rejects an oversized body', (await call(big, env)).status === 413);

  const bad = new Request('https://w.dev/hit', {
    method: 'POST',
    headers: { origin: SITE, 'user-agent': HUMAN_UA, 'content-type': 'application/json' },
    body: 'not json',
  });
  bad.cf = {};
  ok('rejects malformed JSON', (await call(bad, env)).status === 400);
}

// --- path sanitising (no protocol-relative or absolute URLs into the log)
{
  const env = makeEnv();
  await call(hit({ path: '//evil.example/x' }), env);
  const log = JSON.parse(await env.HITS.get('log'));
  ok('normalises a protocol-relative path to /', log[0].path === '/', log[0].path);

  await call(hit({ path: 'https://evil.example/x' }, { ip: '203.0.113.10' }), env);
  const log2 = JSON.parse(await env.HITS.get('log'));
  ok('normalises an absolute URL path to /', log2[0].path === '/', log2[0].path);
}

// --- bot filtering
{
  const env = makeEnv();
  pushCalls = [];
  await call(authed('/subscribe', { method: 'POST', body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' } }), env);

  const r1 = await call(hit({}, { ua: 'Googlebot/2.1 (+http://www.google.com/bot.html)', ip: '66.249.0.1' }), env);
  ok('flags a known crawler user-agent', (await r1.json()).filtered === 'known-bot-ua');

  const r2 = await call(hit({ s: undefined }, { ip: '203.0.113.20' }), env);
  ok('flags a request with no client signals', (await r2.json()).filtered === 'no-client-signals');

  const r3 = await call(hit({}, { ip: '203.0.113.21', cf: { verifiedBotCategory: 'Search Engine Crawler' } }), env);
  ok('flags a Cloudflare-verified bot', (await r3.json()).filtered === 'verified-bot');

  const r3b = await call(hit({ s: { ...SIGNALS, tz: '' } }, { ip: '203.0.113.23' }), env);
  ok('flags a client reporting no timezone', (await r3b.json()).filtered === 'no-timezone');

  const r3c = await call(hit({ s: { ...SIGNALS, t: 0 } }, { ip: '203.0.113.24' }), env);
  ok('flags an instantly-fired beacon (replayed request)', (await r3c.json()).filtered === 'instant-fire');

  ok('no push was sent for any bot hit', pushCalls.length === 0, `${pushCalls.length} calls`);

  const r4 = await call(hit({}, { ip: '203.0.113.22' }), env);
  ok('a human hit notifies', (await r4.json()).notified === true);
  ok('push was delivered for the human hit', pushCalls.length === 1, `${pushCalls.length} calls`);

  const recent = await (await call(authed('/recent'), env)).json();
  ok('bots are excluded from the visitor list', recent.visits.every((v) => !v.bot));
  ok('bots are counted separately', recent.botsToday === 5, String(recent.botsToday));
}

// --- notification debounce
{
  const env = makeEnv();
  pushCalls = [];
  await call(authed('/subscribe', { method: 'POST', body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' } }), env);
  await call(hit({ path: '/' }), env);
  await call(hit({ path: '/private-investigator/lynchburg-va/' }), env);
  await call(hit({ path: '/private-investigator/bedford-va/' }), env);
  ok('repeat pages from one visitor alert only once', pushCalls.length === 1, `${pushCalls.length} calls`);

  await call(hit({ path: '/intake/' }), env);
  ok('the intake page always alerts, ignoring the debounce', pushCalls.length === 2, `${pushCalls.length} calls`);
}

// --- auth + brute-force lockout
{
  const env = makeEnv();
  ok('correct passphrase is accepted', (await call(authed('/recent'), env)).status === 200);
  ok('wrong passphrase is rejected', (await call(authed('/recent', { token: 'wrong', ip: '198.51.100.5' }), env)).status === 401);

  let lastStatus = 0;
  for (let i = 0; i < 10; i++) {
    lastStatus = (await call(authed('/recent', { token: 'guess' + i, ip: '198.51.100.7' }), env)).status;
  }
  ok('repeated failures trigger a lockout (429)', lastStatus === 429, `got ${lastStatus}`);
  ok('lockout applies even to the correct passphrase',
    (await call(authed('/recent', { ip: '198.51.100.7' }), env)).status === 429);
  ok('a different client is unaffected by that lockout',
    (await call(authed('/recent', { ip: '198.51.100.99' }), env)).status === 200);
}

// --- rate limiting the beacon
{
  const env = makeEnv();
  let limited = 0;
  for (let i = 0; i < 30; i++) {
    const r = await call(hit({ path: '/p' + i }, { ip: '203.0.113.77' }), env);
    if (r.status === 429) limited++;
  }
  ok('floods from one visitor get rate limited', limited > 0, `${limited} blocked`);
}

// --- push endpoint validation (SSRF guard)
{
  const env = makeEnv();
  const bad = await call(authed('/subscribe', { method: 'POST', body: { endpoint: 'https://evil.example/steal' } }), env);
  ok('refuses a push endpoint on an unknown host', bad.status === 400);
  const good = await call(authed('/subscribe', { method: 'POST', body: { endpoint: 'https://web.push.apple.com/xyz' } }), env);
  ok('accepts a genuine Apple push endpoint', good.status === 200);
  const http = await call(authed('/subscribe', { method: 'POST', body: { endpoint: 'http://fcm.googleapis.com/x' } }), env);
  ok('refuses a non-https push endpoint', http.status === 400);
}

// --- unauthenticated access
{
  const env = makeEnv();
  const noAuth = new Request('https://w.dev/recent'); noAuth.cf = {};
  ok('/recent requires auth', (await call(noAuth, env)).status === 401);
  const noAuthSub = new Request('https://w.dev/subscribe', { method: 'POST', body: '{}' }); noAuthSub.cf = {};
  ok('/subscribe requires auth', (await call(noAuthSub, env)).status === 401);
  ok('/health is public', (await call(new Request('https://w.dev/health'), env)).status === 200);
}

// --- CORS never wildcards an authenticated route
{
  const env = makeEnv();
  const res = await call(authed('/recent'), env);
  ok('authenticated route echoes the exact site origin',
    res.headers.get('access-control-allow-origin') === SITE);
  const envNoOrigin = { ...makeEnv(), SITE_ORIGIN: '' };
  const res2 = await call(authed('/recent'), envNoOrigin);
  ok('authenticated route never falls back to a wildcard',
    res2.headers.get('access-control-allow-origin') !== '*');
}

// --- returning-visitor detection
{
  const env = makeEnv();
  await call(hit({ path: '/' }, { ip: '203.0.113.55' }), env);
  await call(hit({ path: '/intake/' }, { ip: '203.0.113.55' }), env);
  const log = JSON.parse(await env.HITS.get('log'));
  ok('a second visit from the same person is marked returning', log[0].returning === true);
}

// --- error handling never leaks internals
{
  const brokenEnv = { ...makeEnv(), HITS: null };
  const res = await call(authed('/recent'), brokenEnv);
  const body = await res.json();
  ok('an internal failure returns a generic 500', res.status === 500 && body.error === 'server error');
}

// --- ticker counters: 30-day real visits (+ affiliate plumbing, unused here)
{
  const env = makeEnv();

  // Two visits by one person (second is returning), then a second person.
  await call(hit({ path: '/' }, { ip: '203.0.113.81' }), env);
  await call(hit({ path: '/privacy' }, { ip: '203.0.113.81' }), env);
  await call(hit({ path: '/' }, { ip: '203.0.113.82' }), env);
  // Affiliate clicks: three from one person (count once), one from another.
  await call(hit({ path: '/Amazon Click · linen shirt' }, { ip: '203.0.113.81' }), env);
  await call(hit({ path: '/Amazon Click · linen shirt' }, { ip: '203.0.113.81' }), env);
  await call(hit({ path: '/Amazon Click · lamp' }, { ip: '203.0.113.81' }), env);
  await call(hit({ path: '/Amazon Click · lamp' }, { ip: '203.0.113.82' }), env);
  // A bot affiliate click never counts.
  await call(hit({ path: '/Amazon Click · bot' }, { ip: '66.249.0.9', ua: 'Googlebot/2.1' }), env);

  const recent = await (await call(authed('/recent'), env)).json();
  ok('30-day ticker counts each person once per day', recent.visits30 === 2, String(recent.visits30));
  ok('affiliate clicks dedupe to one per person per day', recent.aff30 === 2, String(recent.aff30));
  ok('running affiliate total matches', recent.affTotal === 2, String(recent.affTotal));
}

// --- ticker seeding from a log that predates the counters
{
  const env = makeEnv();
  const now = Date.now();
  await env.HITS.put('log', JSON.stringify([
    { t: now - 2 * 86_400_000, path: '/', v: 'aaaa', returning: false },
    { t: now - 2 * 86_400_000, path: '/privacy', v: 'aaaa', returning: true },
    { t: now - 86_400_000, path: '/Amazon Click · rug', v: 'bbbb', returning: false },
    { t: now - 86_400_000, path: '/Amazon Click · rug', v: 'bbbb', returning: true },
    { t: now - 86_400_000, path: '/', v: 'cccc', returning: false, bot: 'known-bot-ua' },
  ]));
  const recent = await (await call(authed('/recent'), env)).json();
  ok('counters seed real visits from the pre-existing log', recent.visits30 === 1, String(recent.visits30));
  ok('counters seed deduped affiliate clicks from the log', recent.aff30 === 1, String(recent.aff30));
  const again = await (await call(authed('/recent'), env)).json();
  ok('seeded totals are stable across reads', again.affTotal === 1 && again.visits30 === 1,
    `affTotal ${again.affTotal}, visits30 ${again.visits30}`);
}

/* ----------------------------------------------------------------- report */

console.log('\nvisitor-alerts worker tests\n');
console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
