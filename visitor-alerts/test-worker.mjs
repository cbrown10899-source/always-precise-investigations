/**
 * Tests for the visitor-alerts Worker.
 *
 * Runs the real worker module against an in-memory KV and a stubbed fetch,
 * so behaviour is verified before anything is deployed.
 *
 *   node visitor-alerts/test-worker.mjs
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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

/* CLOSEOUT HARDENING (2026-09-03): the limiter was keyed on a hash that
   INCLUDED the User-Agent, which the caller chooses — so changing it handed
   every request a fresh bucket and the flood control above could be walked
   straight past. The dedup key still carries the UA (it wants to tell one
   person's two browsers apart); the LIMITER key is the address alone. */
{
  const env = makeEnv();
  let limited = 0;
  for (let i = 0; i < 30; i++) {
    const r = await call(hit({ path: '/p' + i },
      { ip: '203.0.113.78', ua: HUMAN_UA + ' build/' + i }), env);
    if (r.status === 429) limited++;
  }
  ok('a caller rotating its User-Agent does NOT get a fresh bucket',
     limited > 0, `${limited} blocked across 30 distinct user-agents`);
  ok('and a different address is still unaffected',
     (await call(hit({ path: '/other' }, { ip: '203.0.113.79' }), env)).status === 200);
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

/* The client script that feeds this Worker. It has no DOM harness, so these
   are structural guards over the two bugs found on 2026-08-14 — both of which
   lost real visits silently, which is the kind that never gets reported. */
{
  const src = fs.readFileSync(new URL('../beacon.js', import.meta.url), 'utf8');

  /* A prerendered page BECOMES a real visit on activation, and it is the same
     document — already parsed, already run. Returning meant that visit was
     never counted, and the ones lost were the highest-intent: straight from
     Chrome's address bar. */
  ok('a prerender defers the beacon rather than killing it',
     /prerenderingchange/.test(src));
  ok('and does not bail out of the script on prerender',
     !/document\.prerendering[^\n]*\breturn\b/.test(src));

  /* The dwell timer used to check visibility once and forfeit if hidden — a
     reader who tabbed away across the 4s mark and came back was never counted
     unless they touched something. */
  ok('the dwell timer re-arms when the tab is hidden rather than forfeiting',
     /else\s+timer\s*=\s*setTimeout\(tick/.test(src));

  // The privacy promises in its own header, still true.
  ok('the beacon still sends only the path, never the query string',
     /path:\s*location\.pathname/.test(src) && !/location\.search|location\.href/.test(src));
  ok('it still honours Do Not Track and Global Privacy Control',
     /doNotTrack/.test(src) && /globalPrivacyControl/.test(src));
  ok('it still refuses to send cookies', /credentials:\s*'omit'/.test(src));
}

/* ================================================================ journeys

   LIVE VISITORS V2 (owner brief 2026-10-10). Everything below runs the real
   Worker against real SQLite behind the same D1-shaped adapter the case
   portal's suite uses, so the journey SQL is executed, not mocked. Time is a
   stub clock: the Worker reads Date.now(), and a journey spans days. */

const SCHEMA = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

function d1(db) {
  return {
    prepare(sql) {
      const stmt = { sql, params: [] };
      stmt.bind = (...p) => ({ ...stmt, params: p, bind: stmt.bind, first: stmt.first, all: stmt.all, run: stmt.run });
      stmt.first = function (col) {
        const row = db.prepare(this.sql).get(...this.params);
        if (row === undefined) return null;
        return col ? row[col] : row;
      };
      stmt.all = function () { return { results: db.prepare(this.sql).all(...this.params), success: true }; };
      stmt.run = function () {
        const r = db.prepare(this.sql).run(...this.params);
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      };
      return stmt;
    },
    // D1's batch() is one transaction: all commit or none do.
    batch(stmts) {
      const out = [];
      db.exec('BEGIN');
      try { for (const st of stmts) out.push(st.run()); db.exec('COMMIT'); }
      catch (e) { try { db.exec('ROLLBACK'); } catch { /* already unwound */ } throw e; }
      return out;
    },
  };
}

/* KV that counts what it is asked to do, so "/t writes nothing to KV" is a
   measurement rather than a promise. */
function countingKV() {
  const kv = makeKV();
  kv.ops = { get: 0, put: 0, delete: 0, list: 0 };
  for (const k of Object.keys(kv.ops)) {
    const real = kv[k].bind(kv);
    kv[k] = async (...a) => { kv.ops[k]++; return real(...a); };
  }
  return kv;
}

function journeyEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const env = makeEnv();
  env.HITS = countingKV();
  env.SUBS = countingKV();
  env.VDB = d1(db);
  env._db = db;
  return env;
}
const rows = (env, sql, ...p) => env._db.prepare(sql).all(...p);
const one = (env, sql, ...p) => env._db.prepare(sql).get(...p);
const everything = (env) => JSON.stringify(['visitor', 'visitor_session', 'visitor_event', 'visitor_alert', 'visitor_meta']
  .map((t) => rows(env, `SELECT * FROM ${t}`)));

const REAL_NOW = Date.now;
let CLOCK = null;
Date.now = () => (CLOCK === null ? REAL_NOW() : CLOCK);
const clockAt = (iso) => { CLOCK = Date.parse(iso); };
const tick = (ms) => { CLOCK += ms; };

const tok = (name) => (name + 'Tk_' + 'q'.repeat(40)).slice(0, 26);
const LEX = { city: 'Lexington', region: 'Virginia', country: 'US' };

/** A beacon page view. `ago` is how long before the send the page opened. */
function page(env, t, pv, path, { ref = '', d, q, ip = '198.51.100.40', ua = HUMAN_UA, cf = LEX, ago = 1500 } = {}) {
  const now = Date.now();
  const body = { path, ref, s: SIGNALS, id: t, pv, lt: now - ago, c: now };
  if (d) body.d = d;
  if (q) body.q = q;
  return call(hit(body, { ip, ua, cf }), env);
}
/** Engagement and presses for page views already recorded. */
function track(env, t, q, { ip = '198.51.100.40', origin = SITE } = {}) {
  const req = new Request('https://w.dev/t', {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8', 'user-agent': HUMAN_UA, 'cf-connecting-ip': ip, ...(origin ? { origin } : {}) },
    body: JSON.stringify({ id: t, c: Date.now(), q }),
  });
  req.cf = {};
  return call(req, env);
}
const eng = (pv, m, b) => (b ? { k: 'e', p: pv, m, b: 1 } : { k: 'e', p: pv, m });
const act = (pv, a, extra = {}) => ({ k: 'a', p: pv, a, e: 'ev' + Math.random().toString(36).slice(2, 10), t: Date.now(), ...extra });
const caseToday = () => `API-${new Date(Date.now()).toISOString().slice(0, 10).replace(/-/g, '')}-4821`;
async function subscribed(env) {
  await call(authed('/subscribe', { method: 'POST', body: { endpoint: 'https://fcm.googleapis.com/fcm/send/journeys' } }), env);
}
const visitorOf = async (t, env) => (await sha256(`vid|${t}|${env.SALT}`)).slice(0, 32);
async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// --- fail open: no database bound
{
  const env = makeEnv();   // the production state until visitors-setup.yml runs
  const r = await call(hit({ path: '/', id: tok('nodb'), pv: 'pvNoDb0001', lt: Date.now() - 1000, c: Date.now() }), env);
  const b = await r.json();
  ok('JOURNEYS: without the database a v2 page view is still logged and counted', r.status === 200 && JSON.parse(await env.HITS.get('log')).length === 1);
  ok('and it says journeys are not set up rather than pretending', b.journey === 'not_set_up', JSON.stringify(b));
  const t = new Request('https://w.dev/t', { method: 'POST', headers: { origin: SITE, 'content-type': 'text/plain' }, body: JSON.stringify({ id: tok('nodb'), q: [] }) });
  t.cf = {};
  const tb = await (await call(t, env)).json();
  ok('/t is a harmless no-op without the database', tb.ok === true && tb.journey === 'not_set_up');
  const v = await (await call(authed('/visitors'), env)).json();
  ok('/visitors names the missing setup instead of drawing an empty list', v.ok === false && v.code === 'journeys_not_set_up');
  const h = await (await call(new Request('https://w.dev/health'), env)).json();
  ok('/health says journeys are not set up', h.journeys === 'not_set_up');
  const rec = await (await call(authed('/recent'), env)).json();
  ok('/recent carries the state for the dashboard', rec.journeys === 'not_set_up');
}

// --- the schema
{
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  let again = true;
  try { db.exec(SCHEMA); } catch (_) { again = false; }
  ok('JOURNEYS: the schema applies twice without an error', again);
  const names = db.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => `${r.type}:${r.name}`);
  for (const t of ['visitor', 'visitor_session', 'visitor_event', 'visitor_alert', 'visitor_meta']) {
    ok(`the schema creates ${t}`, names.includes(`table:${t}`));
  }
  // What visitors-setup.yml actually sends: comments stripped, one batch.
  const stripped = SCHEMA.replace(/--.*$/gm, '');
  const db2 = new DatabaseSync(':memory:');
  db2.exec(stripped);
  const names2 = db2.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => `${r.type}:${r.name}`);
  ok('the comment-stripped schema the setup sends builds the identical set of objects', JSON.stringify(names2) === JSON.stringify(names), JSON.stringify(names2));
  ok('no comment in the schema carries a semicolon (the setup splits on them)', !/--[^\n]*;/.test(SCHEMA));
  const creates = SCHEMA.replace(/--.*$/gm, '').match(/CREATE\s+(TABLE|INDEX)\s+(?!IF NOT EXISTS)/gi);
  ok('every CREATE is IF NOT EXISTS', !creates, JSON.stringify(creates));
  ok('the schema never drops, alters or deletes', !/\b(DROP|ALTER|DELETE)\b/i.test(SCHEMA.replace(/--.*$/gm, '')));
  ok('no CHECK constraint to widen later', !/\bCHECK\b/i.test(SCHEMA.replace(/--.*$/gm, '')));
  const cols = db.prepare("SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'").all();
  const bad = cols.filter((x) => /(^|_)(ip|agent|ua|token|email|phone|signature|address|name)($|_)/i.test(x.c) && x.c !== 'name');
  ok('no column could hold an IP, a user agent, a token or a contact detail', bad.length === 0, JSON.stringify(bad));
}

// --- identity: a first-party token, never the network (brief §5, §40)
{
  clockAt('2026-10-09T15:00:00Z');
  const env = journeyEnv();
  const A = tok('alice'), B = tok('bobby');
  // Same address, same browser, same city — two different people.
  const r1 = await (await page(env, A, 'pvAlice001', '/', { ip: '198.51.100.7' })).json();
  tick(20_000);
  const r2 = await (await page(env, B, 'pvBobby001', '/', { ip: '198.51.100.7' })).json();
  ok('JOURNEYS: a page view with a token is recorded as a journey', r1.journey === 'recorded' && r2.journey === 'recorded', JSON.stringify([r1, r2]));
  ok('same IP, same browser, same city, different tokens: TWO visitors', one(env, 'SELECT COUNT(*) AS n FROM visitor').n === 2);
  ok('and two visits', one(env, 'SELECT COUNT(*) AS n FROM visitor_session').n === 2);
  const dump = everything(env);
  ok('no raw token is stored anywhere', !dump.includes(A) && !dump.includes(B));
  ok('no IP address is stored anywhere', !dump.includes('198.51.100.7'));
  ok('no user agent is stored anywhere', !dump.includes('iPhone OS') && !dump.includes('Mozilla'));
  ok('the visitor id is the salted hash of the token', !!one(env, 'SELECT 1 AS x FROM visitor WHERE id = ?', await visitorOf(A, env)));
  const recent = await (await call(authed('/recent'), env)).json();
  ok('the 30-day ticker counts them as two visits, not one', recent.visits30 === 2, String(recent.visits30));
  // An older beacon with no token: counted the old way, no journey.
  const legacy = await (await call(hit({ path: '/', pv: 'pvLegacy01' }, { ip: '198.51.100.8' }), env)).json();
  ok('a beacon without a token is counted the old way and gets no journey', legacy.journey === 'no_token' && one(env, 'SELECT COUNT(*) AS n FROM visitor').n === 2, JSON.stringify(legacy));
  CLOCK = null;
}

// --- visits: 30 minutes of nothing starts a new one; a reload is not a visit
{
  clockAt('2026-10-09T15:00:00Z');
  const env = journeyEnv();
  const T = tok('carol');
  await page(env, T, 'pvCarol001', '/child-custody-investigations/');
  tick(20_000);
  await page(env, T, 'pvCarol002', '/child-custody-investigations/');   // a reload: same path, new page load
  ok('JOURNEYS: a reload stays in the same visit', one(env, 'SELECT COUNT(*) AS n FROM visitor_session').n === 1);
  ok('the visitor still has one visit', one(env, 'SELECT sessions FROM visitor').sessions === 1);
  const sc = one(env, 'SELECT score, reasons FROM visitor');
  ok('a reload earns no second service-page point', sc.score === 5 && /Viewed 1 service page/.test(sc.reasons), JSON.stringify(sc));
  await page(env, T, 'pvCarol002', '/child-custody-investigations/');   // the same page view sent twice
  ok('the same page view sent twice is one row', one(env, "SELECT COUNT(*) AS n FROM visitor_event WHERE kind = 'page'").n === 2);
  ok("and the visit's page count is not inflated by it", one(env, 'SELECT pages FROM visitor_session').pages === 2);
  tick(29 * 60_000);
  await page(env, T, 'pvCarol003', '/');
  ok('29 minutes later is still the same visit', one(env, 'SELECT COUNT(*) AS n FROM visitor_session').n === 1);
  tick(31 * 60_000);
  await page(env, T, 'pvCarol004', '/infidelity-investigations/');
  ok('31 minutes of nothing starts a new visit', one(env, 'SELECT COUNT(*) AS n FROM visitor_session').n === 2);
  ok('the visitor now has two visits', one(env, 'SELECT sessions FROM visitor').sessions === 2);
  ok("the newest visit's current page is the page it is on", one(env, 'SELECT current_path FROM visitor_session ORDER BY started_at DESC LIMIT 1').current_path === '/infidelity-investigations/');
  CLOCK = null;
}

// --- engagement: a running total, never more than the wall time, never through KV
{
  clockAt('2026-10-09T15:00:00Z');
  const env = journeyEnv();
  const T = tok('dave');
  await page(env, T, 'pvDave0001', '/legal-investigations/', { ago: 1000 });
  const kvBefore = JSON.stringify([env.HITS.ops, env.SUBS.ops]);
  tick(40_000);
  const a = await (await track(env, T, [eng('pvDave0001', 30_000)])).json();
  ok('JOURNEYS: an engagement check-in is applied', a.applied === 1, JSON.stringify(a));
  ok('the page, the visit and the visitor all gain the 30 seconds',
    one(env, "SELECT engaged_ms AS n FROM visitor_event WHERE kind = 'page'").n === 30_000
    && one(env, 'SELECT engaged_ms AS n FROM visitor_session').n === 30_000
    && one(env, 'SELECT engaged_ms AS n FROM visitor').n === 30_000);
  await track(env, T, [eng('pvDave0001', 30_000)]);
  ok('the same total again changes nothing', one(env, 'SELECT engaged_ms AS n FROM visitor').n === 30_000);
  tick(10_000);
  await track(env, T, [eng('pvDave0001', 45_000)]);
  ok('a larger total adds exactly the difference', one(env, 'SELECT engaged_ms AS n FROM visitor').n === 45_000
    && one(env, 'SELECT engaged_ms AS n FROM visitor_session').n === 45_000);
  await track(env, T, [eng('pvDave0001', 10 * 3600_000)]);
  const capped = one(env, "SELECT engaged_ms AS n FROM visitor_event WHERE kind = 'page'").n;
  ok('a claimed ten hours is cut to the wall time since the page opened', capped <= 51_000 + 5_000 + 1000 && capped >= 45_000, String(capped));
  ok('/t made no KV write and no KV read at all', JSON.stringify([env.HITS.ops, env.SUBS.ops]) === kvBefore, `${kvBefore} -> ${JSON.stringify([env.HITS.ops, env.SUBS.ops])}`);
  // Heartbeats stop at thirty for one page view.
  for (let i = 1; i <= 32; i++) { tick(60_000); await track(env, T, [eng('pvDave0001', 60_000 + i * 55_000, true)]); }
  ok('a page left running stops spending writes after thirty check-ins', one(env, "SELECT beats FROM visitor_event WHERE kind = 'page'").beats === 30);
  // A page view this visitor never recorded, or somebody else's.
  const other = tok('erin');
  await page(env, other, 'pvErin0001', '/', { ip: '198.51.100.41' });
  const cross = await (await track(env, other, [eng('pvDave0001', 99_000)])).json();
  ok("one visitor cannot write to another's page view", cross.applied === 0, JSON.stringify(cross));
  const ghost = await (await track(env, tok('ghost'), [eng('pvDave0001', 99_000)])).json();
  ok('an unknown visitor writes nothing', ghost.applied === 0);
  const foreign = await track(env, T, [eng('pvDave0001', 99_000)], { origin: 'https://evil.example' });
  ok('/t refuses a foreign origin', foreign.status === 403);
  CLOCK = null;
}

// --- actions: a fixed vocabulary, counted once, capped per visit
{
  clockAt('2026-10-09T15:00:00Z');
  const env = journeyEnv();
  const T = tok('fran');
  await page(env, T, 'pvFran0001', '/insurance-investigations/');
  tick(5_000);
  const r = await (await track(env, T, [
    act('pvFran0001', 'call'), act('pvFran0001', 'email'), act('pvFran0001', 'contact'),
    act('pvFran0001', 'cta', { d: 'insurance' }),
    act('pvFran0001', 'delete_everything'),
    act('pvFran0001', 'intake_opened'),
    act('pvFran0001', 'intake_started'),
    act('pvFran0001', 'cta', { d: 'free_money' }),
  ])).json();
  const names = rows(env, "SELECT name, detail FROM visitor_event WHERE kind = 'action' ORDER BY rowid").map((x) => x.name + (x.detail ? ':' + x.detail : ''));
  ok('JOURNEYS: Call, Email, Contact and an intake button are recorded', JSON.stringify(names) === JSON.stringify(['call', 'email', 'contact', 'cta:insurance']), JSON.stringify(names));
  ok('an action outside the vocabulary is dropped', !names.includes('delete_everything') && r.applied === 4);
  ok('"opened intake" cannot be claimed by a request — only by an intake page view', !names.includes('intake_opened'));
  ok('"started intake" off the intake page is dropped', !names.includes('intake_started'));
  ok('an intake button the site does not have is dropped', !names.some((n) => n.includes('free_money')));
  const same = act('pvFran0001', 'call');
  await track(env, T, [same]); await track(env, T, [same]);
  ok('the same press sent twice is one row', rows(env, "SELECT 1 FROM visitor_event WHERE name = 'call'").length === 2);
  const sc = one(env, 'SELECT reasons FROM visitor').reasons;
  ok('two calls still earn the Call points once', (sc.match(/Clicked Call/g) || []).length === 1, sc);
  const many = Array.from({ length: 20 }, () => act('pvFran0001', 'call'));
  for (let i = 0; i < 4; i++) await track(env, T, many.slice(i * 5, i * 5 + 5).concat(Array.from({ length: 15 }, () => act('pvFran0001', 'call'))));
  ok('a visit records at most sixty presses', one(env, "SELECT COUNT(*) AS n FROM visitor_event WHERE kind = 'action'").n === 60);
  CLOCK = null;
}

// --- the link to an intake: deterministic, first-party, and nothing typed (§16, §41)
{
  clockAt('2026-10-10T14:00:00Z');
  const env = journeyEnv();
  await subscribed(env);
  const T = tok('gail');
  await page(env, T, 'pvGail0001', '/child-custody-investigations/');
  tick(30_000);
  await page(env, T, 'pvGail0002', '/intake/', { d: { door: 'private', svc: 'custody' } });
  const opened = one(env, "SELECT service FROM visitor_event WHERE name = 'intake_opened'");
  ok('JOURNEYS: the intake page view records that the intake was opened, on its door', opened && opened.service === 'custody', JSON.stringify(opened));
  tick(10_000);
  // Sensitive values riding along in fields the Worker does not read.
  const SECRET = ['Jane Sensitive', '540-555-0199', 'he hides the car keys', 'jane@example.com'];
  await track(env, T, [{ ...act('pvGail0002', 'intake_started'), name: SECRET[0], phone: SECRET[1], narrative: SECRET[2], email: SECRET[3] }]);
  ok('"started intake" is recorded on the intake page', !!one(env, "SELECT 1 AS x FROM visitor_event WHERE name = 'intake_started'"));
  tick(60_000);
  pushCalls = [];
  const cn = caseToday();
  const sub = await (await track(env, T, [{ ...act('pvGail0002', 'intake_submitted', { n: cn, s: 'custody' }), client_name: SECRET[0], client_phone: SECRET[1] }])).json();
  const row = one(env, "SELECT related_submission_id AS c, service FROM visitor_event WHERE name = 'intake_submitted'");
  ok('a submission links the request number the intake page minted', row && row.c === cn && row.service === 'custody', JSON.stringify(row));
  ok('the visitor carries the link for the list', one(env, 'SELECT intake_case FROM visitor').intake_case === cn);
  ok('it raised exactly one NEW INTAKE alert', rows(env, "SELECT 1 FROM visitor_alert WHERE kind = 'intake'").length === 1 && sub.notified === true);
  ok('and the phone was woken for it', pushCalls.length === 1, String(pushCalls.length));
  const alert = one(env, "SELECT title, body FROM visitor_alert WHERE kind = 'intake'");
  ok('the alert reads NEW INTAKE / place / service', alert.title === 'NEW INTAKE' && alert.body === 'Lexington, Virginia\nChild Custody intake submitted.', JSON.stringify(alert));
  ok('the lock-screen text carries no request number', !alert.body.includes(cn) && !alert.title.includes(cn));
  pushCalls = [];
  await track(env, T, [act('pvGail0002', 'intake_submitted', { n: cn, s: 'custody' })]);
  ok('the same submission again links nothing new and wakes nobody', rows(env, "SELECT 1 FROM visitor_event WHERE name = 'intake_submitted'").length === 1 && pushCalls.length === 0);
  const dump = everything(env) + JSON.stringify([...env.HITS._store.values()]);
  ok('nothing typed into the form reaches the journey or the log', SECRET.every((s) => !dump.includes(s)), SECRET.filter((s) => dump.includes(s)).join(', '));
  await track(env, T, [act('pvGail0001', 'intake_submitted', { n: cn.replace(/\d$/, '9'), s: 'custody' })]);
  ok('a "submission" from a page that is not the intake is dropped', rows(env, "SELECT 1 FROM visitor_event WHERE name = 'intake_submitted'").length === 1);
  for (const bad of ['API-20250101-1234', 'API-12', "API-20261010-1234'; DROP TABLE visitor;--", 'CASE-20261010-1234']) {
    await track(env, T, [act('pvGail0002', 'intake_submitted', { n: bad, s: 'custody' })]);
  }
  ok('an old, malformed or hostile request number links nothing', rows(env, "SELECT 1 FROM visitor_event WHERE name = 'intake_submitted'").length === 1);
  // Legal carries its own service as detail, from a fixed list.
  const L = tok('hank');
  await page(env, L, 'pvHank0001', '/intake/', { d: { door: 'legal', svc: 'legal' }, ip: '198.51.100.42' });
  await track(env, L, [act('pvHank0001', 'intake_submitted', { n: cn.replace(/\d{4}$/, '7777'), s: 'legal', l: 'process' })], { ip: '198.51.100.42' });
  await track(env, L, [act('pvHank0001', 'intake_submitted', { n: cn.replace(/\d{4}$/, '7778'), s: 'legal', l: 'world_domination' })], { ip: '198.51.100.42' });
  const legal = rows(env, "SELECT detail FROM visitor_event WHERE name = 'intake_submitted' AND service = 'legal' ORDER BY rowid").map((x) => x.detail);
  ok("a legal submission keeps its service from Legal's own five, and nothing else", JSON.stringify(legal) === JSON.stringify(['process', null]), JSON.stringify(legal));
  CLOCK = null;
}

// --- §39: Visitor A, end to end
let VISITOR_A = null;
{
  const env = journeyEnv();
  await subscribed(env);
  const A = tok('visitorA');
  const vid = await visitorOf(A, env);
  // Day 1 — Oct 7, 9:12:00 PM EDT: from Google to the homepage, then Child Custody, then gone.
  clockAt('2026-10-08T01:12:01.500Z');
  await page(env, A, 'pvA1home00', '/', { ref: 'https://www.google.com/', ago: 1500 });
  tick(18_000);
  await track(env, A, [eng('pvA1home00', 18_000)]);
  tick(2_000);
  await page(env, A, 'pvA1cust00', '/child-custody-investigations/', { ago: 1500 });
  tick(128_000);
  await track(env, A, [eng('pvA1cust00', 128_000)]);
  const day1 = one(env, 'SELECT score, tier, sessions FROM visitor');
  ok('§39 day 1: one visit, browsing', day1.sessions === 1 && day1.tier === 'browsing', JSON.stringify(day1));
  // Day 3 — Oct 9, 11:42:18 PM EDT: back, directly, to Child Custody.
  clockAt('2026-10-10T03:42:19.500Z');
  pushCalls = [];
  await page(env, A, 'pvA2cust00', '/child-custody-investigations/', { ago: 1500 });
  ok('§39 day 3: the return opens a second visit and says so', one(env, "SELECT title FROM visitor_alert WHERE kind = 'visit' ORDER BY id DESC LIMIT 1").title === 'Returning visitor on your website');
  tick(72_000);
  await track(env, A, [eng('pvA2cust00', 72_000), act('pvA2cust00', 'cta', { d: 'custody' })]);
  const before = one(env, 'SELECT score, tier FROM visitor');
  ok('§39 before the intake: interested, not yet high', before.tier === 'interested', JSON.stringify(before));
  tick(1_000);
  pushCalls = [];
  await page(env, A, 'pvA2intk00', '/intake/', { d: { door: 'private', svc: 'custody' }, ago: 900 });
  const high = one(env, 'SELECT score, tier FROM visitor');
  ok('§39 opening the Child Custody intake crosses into HIGH INTENT', high.tier === 'high', JSON.stringify(high));
  const ha = rows(env, "SELECT body FROM visitor_alert WHERE kind = 'high'");
  ok('§39 exactly one HIGH INTENT alert, and it says what happened', ha.length === 1 && ha[0].body === 'Lexington, Virginia\nReturning visitor opened Child Custody intake.', JSON.stringify(ha));
  ok('§39 and the phone was woken once for it', pushCalls.length === 1, String(pushCalls.length));
  tick(20_000);
  await track(env, A, [act('pvA2intk00', 'intake_started')]);
  tick(240_000);
  await track(env, A, [eng('pvA2intk00', 261_000)]);
  ok('§39 starting and filling the form raises nothing more', rows(env, "SELECT 1 FROM visitor_alert WHERE kind = 'high'").length === 1);
  clockAt('2026-10-10T03:48:09.000Z');
  const cn = 'API-20261010-4821';
  await track(env, A, [act('pvA2intk00', 'intake_submitted', { n: cn, s: 'custody', t: Date.now() })]);
  ok('§39 the submission raises NEW INTAKE', rows(env, "SELECT 1 FROM visitor_alert WHERE kind = 'intake'").length === 1);

  tick(60_000);
  const list = await (await call(authed('/visitors'), env)).json();
  const card = list.visitors.find((v) => v.id === vid);
  ok('§39 the card: returning, two visits, both this week', card && card.returning && card.visits === 2 && card.visits7 === 2 && card.visits_sub === '(2 this week)', JSON.stringify(card));
  ok('§39 the card: HIGH INTENT and NEW INTAKE together', card && card.tier === 'high' && card.new_intake === true);
  ok('§39 the card: likely interest Child Custody, intake submitted', card && card.interest === 'Child Custody' && card.activity_line === 'Submitted intake' && card.activity_sub === 'Child Custody', JSON.stringify(card));
  ok('§39 the card: approximate location and source', card && card.place === 'Lexington, Virginia' && card.source_line === 'Direct');
  ok('§39 the card: time on site is every visit\'s engaged time', card && card.engaged_label === '7m 59s', card && card.engaged_label);

  const d = await (await call(authed('/visitor?id=' + vid), env)).json();
  VISITOR_A = d;
  const v = d.visitor;
  ok('§39 first seen is exact, in Eastern time', v.first_label === 'Oct 7, 2026 · 9:12:00 PM EDT', v.first_label);
  ok('§39 last active is the moment of the submission', v.last_label === 'Oct 9, 2026 · 11:48:09 PM EDT', v.last_label);
  ok('§39 total visits 2 (2 in last 7 days)', v.visits_detail === '2 (2 in last 7 days)', v.visits_detail);
  ok('§39 the score is 85, and every point is a reason', v.score === 85 && v.reasons.reduce((n, r) => n + r.pts, 0) === 85, JSON.stringify(v.reasons));
  const labels = v.reasons.map((r) => r.label);
  ok('§39 the reasons name what happened', ['Returning visitor', '2 visits within 7 days', 'Viewed 1 service page', 'Spent 7m 59s on site', 'Opened intake', 'Started intake', 'Clicked “Request a Child Custody Investigation”'].every((l) => labels.includes(l)), JSON.stringify(labels));
  ok('§39 the interest is Child Custody, from the page, the button and the intake', v.interest === 'Child Custody' && v.interest_basis.length >= 2, JSON.stringify(v.interest_basis));
  ok('§39 the intake link is the request number and its moment', v.intake && v.intake.case === cn && v.intake.label === 'Oct 9, 2026 · 11:48:09 PM EDT' && v.intake.service === 'Child Custody', JSON.stringify(v.intake));
  const j = d.journey.map((vis) => vis.rows.map((r) => `${r.time} ${r.label}`));
  ok('§39 the journey is two visits in the order they happened', d.journey.length === 2 && d.journey[0].n === 1 && d.journey[1].n === 2);
  ok('§39 visit 1: landed from Google, then Child Custody', JSON.stringify(j[0]) === JSON.stringify(['9:12:00 PM Landed from Google', '9:12:20 PM Viewed Child Custody']), JSON.stringify(j[0]));
  ok('§39 visit 2: Child Custody, the button, the intake, started, submitted',
    JSON.stringify(j[1]) === JSON.stringify([
      '11:42:18 PM Landed directly',
      '11:43:31 PM Clicked “Request a Child Custody Investigation”',
      '11:43:31 PM Opened Intake — Child Custody',
      '11:43:52 PM Started intake',
      '11:48:09 PM Intake submitted',
    ]), JSON.stringify(j[1]));
  ok('§39 each visit names its date and zone', d.journey[0].date === 'Oct 7, 2026' && d.journey[1].date === 'Oct 9, 2026' && d.journey.every((x) => x.zone === 'EDT'));
  ok('§39 the submitted row says which form and carries the request number', d.journey[1].rows[4].sub === 'Form: Child Custody' && d.journey[1].rows[4].case === cn);
  ok('§39 every row carries its full exact timestamp', d.journey.every((x) => x.rows.every((r) => /^[A-Z][a-z]{2} \d{1,2}, 2026 · \d{1,2}:\d{2}:\d{2} [AP]M E[DS]T$/.test(r.full))));
  ok('§39 per-page engaged time', d.journey[0].rows[1].engaged_label === '2m 08s' && d.journey[1].rows[2].engaged_label === '4m 21s', JSON.stringify(d.journey.map((x) => x.rows.map((r) => r.engaged_label))));
  ok('§39 pages viewed: four, in order', JSON.stringify(d.pages.map((p) => p.label)) === JSON.stringify(['Home', 'Child Custody', 'Child Custody', 'Intake — Child Custody']), JSON.stringify(d.pages));
  ok('§39 actions include the submission with its request number', d.actions.some((a) => a.name === 'intake_submitted' && a.case === cn && a.time === '11:48:09 PM'));
  ok('§39 the returning fact rides with the actions', d.facts.length === 1 && d.facts[0].sub === '2nd visit this week', JSON.stringify(d.facts));
  ok('§39 nothing in the answer is a raw token or an address', !JSON.stringify(d).includes(A) && !JSON.stringify(d).includes('198.51.100'));
  CLOCK = null;
}

// --- §42: what earns nothing
{
  clockAt('2026-10-09T12:00:00Z');
  const env = journeyEnv();
  const H = tok('homeOnly');
  await page(env, H, 'pvHome0001', '/');
  tick(31 * 60_000);
  await page(env, H, 'pvHome0002', '/');
  for (let i = 0; i < 12; i++) { tick(60_000); await track(env, H, [eng('pvHome0002', 60_000 * (i + 1), true)]); }
  for (let i = 0; i < 5; i++) await track(env, H, [act('pvHome0002', 'call')]);
  await track(env, H, [act('pvHome0002', 'email')]);
  const h = one(env, 'SELECT score, tier, reasons FROM visitor');
  ok('§42 a homepage-only visitor is never HIGH INTENT, however long or often', h.tier !== 'high', JSON.stringify(h));
  ok('§42 five calls count as one', (h.reasons.match(/Clicked Call/g) || []).length === 1);
  const R = tok('reloader');
  for (let i = 0; i < 10; i++) { tick(3_000); await page(env, R, 'pvRel' + String(i).padStart(5, '0'), '/infidelity-investigations/', { ip: '198.51.100.43' }); }
  const r = one(env, 'SELECT score FROM visitor WHERE id = ?', await visitorOf(R, env));
  ok('§42 ten reloads of one service page earn five points, not fifty', r.score === 5, String(r.score));
  const bot = await (await page(env, tok('crawler'), 'pvBot00001', '/legal-investigations/', { ua: 'Googlebot/2.1 (+http://www.google.com/bot.html)', ip: '66.249.66.1' })).json();
  ok('§42 a bot never becomes a visitor', bot.filtered === 'known-bot-ua' && one(env, 'SELECT COUNT(*) AS n FROM visitor').n === 2);
  CLOCK = null;
}

// --- §43: alerts only when something changed
{
  clockAt('2026-10-09T16:00:00Z');
  const env = journeyEnv();
  await subscribed(env);
  const T = tok('ivy');
  pushCalls = [];
  await page(env, T, 'pvIvy00001', '/', { ref: 'https://www.bing.com/' });
  ok('§43 a new visit wakes the phone once', pushCalls.length === 1 && one(env, "SELECT title FROM visitor_alert").title === 'Visitor on your website');
  ok('§43 its text names the page, the place and the source', one(env, 'SELECT body FROM visitor_alert').body === 'Home — Lexington, Virginia (from Bing)', one(env, 'SELECT body FROM visitor_alert').body);
  tick(10_000); await page(env, T, 'pvIvy00002', '/');
  tick(10_000); await page(env, T, 'pvIvy00003', '/private-investigator/lynchburg-va/');
  tick(60_000); await track(env, T, [eng('pvIvy00003', 55_000, true)]);
  ok('§43 a refresh, another page and a heartbeat wake nobody', pushCalls.length === 1, String(pushCalls.length));
  tick(5_000); await page(env, T, 'pvIvy00004', '/child-custody-investigations/');
  tick(5_000); await track(env, T, [act('pvIvy00004', 'cta', { d: 'custody' })]);
  tick(1_000); await page(env, T, 'pvIvy00005', '/intake/', { d: { door: 'private', svc: 'custody' } });
  ok('§43 crossing into HIGH INTENT wakes it once', pushCalls.length === 2 && rows(env, "SELECT 1 FROM visitor_alert WHERE kind = 'high'").length === 1, String(pushCalls.length));
  tick(5_000); await page(env, T, 'pvIvy00006', '/intake/', { d: { door: 'private', svc: 'custody' } });
  tick(5_000); await track(env, T, [act('pvIvy00006', 'intake_started'), act('pvIvy00006', 'call')]);
  ok('§43 more strong signals inside HIGH INTENT wake nobody', pushCalls.length === 2, String(pushCalls.length));
  const rec = await (await call(authed('/recent'), env)).json();
  ok('§43 /recent hands the service worker the newest alerts, newest first', rec.journeys === 'ready' && rec.alerts.length === 2 && rec.alerts[0].kind === 'high' && rec.alerts[0].title === 'HIGH INTENT VISITOR', JSON.stringify(rec.alerts));
  ok('§43 each alert names its visitor for the deep link', rec.alerts.every((a) => /^[0-9a-f]{32}$/.test(a.visitor_id)));
  tick(40 * 60_000);
  await page(env, T, 'pvIvy00007', '/');
  ok('§43 a new visit by the same person later says Returning', one(env, "SELECT title FROM visitor_alert ORDER BY id DESC LIMIT 1").title === 'Returning visitor on your website' && pushCalls.length === 3);
  ok('§43 and HIGH INTENT is not alerted again inside the week', rows(env, "SELECT 1 FROM visitor_alert WHERE kind = 'high'").length === 1);
  CLOCK = null;
}

// --- the dashboard's reads
{
  clockAt('2026-10-09T18:00:00Z');
  const env = journeyEnv();
  const noAuth = new Request('https://w.dev/visitors'); noAuth.cf = {};
  ok('JOURNEYS: /visitors requires the passcode', (await call(noAuth, env)).status === 401);
  const noAuth2 = new Request('https://w.dev/visitor?id=' + 'a'.repeat(32)); noAuth2.cf = {};
  ok('/visitor requires the passcode', (await call(noAuth2, env)).status === 401);
  ok('/visitor refuses an id that is not one', (await call(authed('/visitor?id=../../etc'), env)).status === 404);
  ok('/visitor answers an unknown visitor with 404', (await call(authed('/visitor?id=' + 'b'.repeat(32)), env)).status === 404);
  // Places, as precisely as the network allows and no more.
  const places = [
    [{ city: 'Destin', region: 'Florida', country: 'US' }, 'Destin, Florida'],
    [{ region: 'Virginia', country: 'US' }, 'Virginia'],
    [{ country: 'GB' }, 'United Kingdom'],
    [{}, 'Location unavailable'],
  ];
  let i = 0;
  for (const [cf] of places) { tick(1000); await page(env, tok('place' + i), 'pvPlace' + String(i).padStart(3, '0'), '/', { cf, ip: '198.51.100.' + (60 + i) }); i++; }
  const list = await (await call(authed('/visitors'), env)).json();
  const got = list.visitors.map((v) => v.place).reverse();
  ok('the place falls back from city to state to country to "Location unavailable"', JSON.stringify(got) === JSON.stringify(places.map((p) => p[1])), JSON.stringify(got));
  ok('the newest visitor is first', list.visitors[0].place === 'Location unavailable');
  ok('a visitor seen in the last three minutes is live', list.visitors.every((v) => v.live === true));
  tick(4 * 60_000);
  const later = await (await call(authed('/visitors'), env)).json();
  ok('and three minutes of nothing is not', later.visitors.every((v) => v.live === false));
  ok('the list carries the zone it composed its times in', later.tz === 'America/New_York');
  CLOCK = null;
}

// --- where a visit came from: certain names only
{
  clockAt('2026-10-09T19:00:00Z');
  const env = journeyEnv();
  const refs = [
    ['https://www.google.com/', 'Google'], ['https://www.google.co.uk/', 'Google'], ['https://news.google.com/', 'Google'],
    ['android-app://com.google.android.googlequicksearchbox/', 'Google'], ['https://www.bing.com/', 'Bing'],
    ['https://l.facebook.com/', 'Facebook'], ['https://m.facebook.com/', 'Facebook'], ['https://duckduckgo.com/', 'DuckDuckGo'],
    ['https://google.evil.com/', 'Referral: google.evil.com'], ['https://notgoogle.com/', 'Referral: notgoogle.com'],
    ['https://alwayspreciseinvestigations.net/', 'Referral: alwayspreciseinvestigations.net'], ['', 'Direct'],
  ];
  let n = 0;
  for (const [ref] of refs) { tick(1000); await page(env, tok('ref' + n), 'pvRef' + String(n).padStart(5, '0'), '/', { ref, ip: '198.51.100.' + (100 + n) }); n++; }
  const got = rows(env, 'SELECT source FROM visitor_session ORDER BY started_at').map((r) => r.source);
  ok('JOURNEYS: sources are named only when certain — never a guessed category', JSON.stringify(got) === JSON.stringify(refs.map((r) => r[1])), JSON.stringify(got));
  ok('the referring host is kept, never a URL', rows(env, 'SELECT ref_host FROM visitor_session').every((r) => r.ref_host === null || !/[/:?]/.test(r.ref_host)));
  CLOCK = null;
}

// --- "visits today" and "on the site now" count visits, on Eastern time
{
  const env = journeyEnv();
  clockAt('2026-10-10T03:50:00Z');   // 11:50 PM EDT on Oct 9
  await page(env, tok('lateNight'), 'pvLate0001', '/', { ip: '198.51.100.70' });
  clockAt('2026-10-10T04:10:00Z');   // 12:10 AM EDT on Oct 10
  await page(env, tok('earlyBird'), 'pvEarly001', '/', { ip: '198.51.100.71' });
  tick(60_000);
  const rec = await (await call(authed('/recent'), env)).json();
  ok('JOURNEYS: "visits today" starts at midnight in Virginia', rec.visitsToday === 1, String(rec.visitsToday));
  ok('"on the site now" is the visitors active in the last three minutes', rec.online === 1, String(rec.online));
  CLOCK = null;
}

// --- standard time is EST, from the date itself
{
  clockAt('2026-01-15T03:00:01.000Z');
  const env = journeyEnv();
  const T = tok('winter');
  await page(env, T, 'pvWinter01', '/', { ago: 1000 });
  const d = await (await call(authed('/visitor?id=' + await visitorOf(T, env)), env)).json();
  ok('JOURNEYS: a January visit is stamped EST', d.visitor.first_label === 'Jan 14, 2026 · 10:00:00 PM EST', d.visitor.first_label);
  CLOCK = null;
}

// --- retention: 90 days, swept once a day
{
  clockAt('2026-10-09T20:00:00Z');
  const env = journeyEnv();
  const old = Date.now() - 100 * 86_400_000;
  env._db.prepare("INSERT INTO visitor (id, first_at, last_at, sessions) VALUES ('oldvisitor', ?, ?, 1)").run(old, old);
  env._db.prepare("INSERT INTO visitor_session (id, visitor_id, started_at, last_at) VALUES ('oldsession', 'oldvisitor', ?, ?)").run(old, old);
  env._db.prepare("INSERT INTO visitor_event (id, visitor_id, session_id, at, kind, path) VALUES ('oldvisitor:pv', 'oldvisitor', 'oldsession', ?, 'page', '/')").run(old);
  env._db.prepare("INSERT INTO visitor_alert (at, kind, title, body) VALUES (?, 'visit', 'x', 'y')").run(Date.now() - 40 * 86_400_000);
  await page(env, tok('sweeper'), 'pvSweep001', '/', { ip: '198.51.100.80' });
  ok('JOURNEYS: a visitor not seen for 90 days is deleted, every row of them',
    !one(env, "SELECT 1 AS x FROM visitor WHERE id = 'oldvisitor'") && !one(env, "SELECT 1 AS x FROM visitor_session WHERE id = 'oldsession'") && !one(env, "SELECT 1 AS x FROM visitor_event WHERE visitor_id = 'oldvisitor'"));
  ok('old alerts go after 30 days', rows(env, "SELECT 1 FROM visitor_alert WHERE title = 'x'").length === 0);
  ok('the visitor of today is kept', one(env, 'SELECT COUNT(*) AS n FROM visitor').n === 1);
  env._db.prepare("INSERT INTO visitor (id, first_at, last_at, sessions) VALUES ('oldvisitor2', ?, ?, 1)").run(old, old);
  tick(60_000);
  await page(env, tok('sweeper'), 'pvSweep002', '/', { ip: '198.51.100.80' });
  ok('the sweep runs once a day, not on every page view', !!one(env, "SELECT 1 AS x FROM visitor WHERE id = 'oldvisitor2'"));
  clockAt('2026-10-10T20:00:00Z');
  await page(env, tok('sweeper'), 'pvSweep003', '/', { ip: '198.51.100.80' });
  ok('and runs again the next day', !one(env, "SELECT 1 AS x FROM visitor WHERE id = 'oldvisitor2'"));
  CLOCK = null;
}

// --- fail open, never silent: a broken database does not stop the alert
{
  const env = makeEnv();
  env.VDB = d1(new DatabaseSync(':memory:'));   // bound, schema never applied
  pushCalls = [];
  await call(authed('/subscribe', { method: 'POST', body: { endpoint: 'https://fcm.googleapis.com/fcm/send/broken' } }), env);
  const r = await (await call(hit({ path: '/intake/', id: tok('broken'), pv: 'pvBroken01', lt: Date.now() - 1000, c: Date.now() }, { ip: '198.51.100.90' }), env)).json();
  ok('JOURNEYS: a journey write that fails is reported, not thrown', r.ok === true && r.journey === 'error', JSON.stringify(r));
  ok('and the older alert still wakes the phone', r.notified === true && pushCalls.length === 1);
  ok('and the page view is still in the log', JSON.parse(await env.HITS.get('log')).length === 1);
  const h = await (await call(new Request('https://w.dev/health'), env)).json();
  ok('/health names a missing schema', h.journeys === 'schema_missing');
  const rec = await (await call(authed('/recent'), env)).json();
  ok('/recent falls back to the page-view figures and says so', rec.journeys === 'error' && rec.visits.length === 1);
  const tr = await (await track(env, tok('broken'), [eng('pvBroken01', 1000)], { ip: '198.51.100.90' })).json();
  ok('/t with a broken database answers ok and changes nothing', tr.ok === true);
}

/* The beacon and the intake hooks, read as source: the promises in their own
   comments, held as structure. */
{
  const src = fs.readFileSync(new URL('../beacon.js', import.meta.url), 'utf8');
  const optOut = Math.max(src.indexOf('globalPrivacyControl) return'), src.indexOf('navigator.webdriver) return'), src.indexOf("'apiv-exclude') === '1') return"));
  ok('JOURNEYS beacon: every opt-out returns before a token is made', optOut > 0 && optOut < src.indexOf('var ID = token()'));
  ok('it honours a browser the owner marked as his own', /apiv-exclude/.test(src));
  ok('it reads no form value — not one .value anywhere', !/\.value\b/.test(src));
  ok('it queries no form control', !/querySelector(All)?\(['"](input|textarea|select)/.test(src) && !/elements\[/.test(src));
  ok('the click handler reads only a link\'s address', /closest\('a\[href\]'\)/.test(src));
  ok('its calls are simple requests that survive the page being left', /text\/plain/.test(src) && /keepalive/.test(src));
  ok('the token lives in local storage, not a cookie', /localStorage\.setItem\('apiv-id'/.test(src) && !/document\.cookie/.test(src));
  ok('it never sends before 200ms, so a moving cursor is not filed as "instant-fire"', /var wait = 200 - performance\.now\(\);/.test(src) && /if \(wait > 0\)/.test(src));
  ok('the referrer is reduced to its host before it leaves', /u\.protocol \+ '\/\/' \+ u\.hostname/.test(src));
  const intake = fs.readFileSync(new URL('../intake/index.html', import.meta.url), 'utf8');
  const at0 = intake.indexOf('function visitNote');
  const hook = intake.slice(at0, intake.indexOf('})();', at0) + 5);
  ok('intake: the started hook never looks at what changed', hook.length > 100 && !/target|\.value|dataset/.test(hook.slice(hook.indexOf('(function(){'))), hook);
  ok('intake: it says "started" once', /if\(said\) return; said = true;/.test(hook));
  ok('intake: the submission is announced only after the firm has it', /if\(stored \|\| notified\) visitNote\(\["act", "intake_submitted", \{ n: p\.case_no, s: S\.svc \|\| "", l: S\.lsvc \|\| "" \}\]\);/.test(intake));
  ok('intake: nothing else from the payload goes to the visitor script', (intake.match(/visitNote\(/g) || []).length === 4);
}

/* ----------------------------------------------------------------- report */

console.log('\nvisitor-alerts worker tests\n');
console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
