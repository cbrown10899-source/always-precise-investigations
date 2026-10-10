/**
 * Tests for Live Visitors V2 in a real browser: the beacon on the real public
 * pages, the intake's hooks, and the /watch/ dashboard — all against the real
 * Worker running in this process over real SQLite.
 *
 *   node watch/test-watch.mjs
 *
 * Needs Playwright, like the intake suite; skips cleanly without it. Every
 * request the pages make to the visitor Worker is answered by the Worker
 * module itself, so nothing here touches the network. Set SHOTS=<dir> to keep
 * screenshots of the dashboard for a look.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../visitor-alerts/worker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'visitor-alerts/schema.sql'), 'utf8');
const SHOTS = process.env.SHOTS || '';

async function loadChromium() {
  const require_ = createRequire(import.meta.url);
  for (const spec of ['playwright', 'playwright-core']) {
    try { return (await import(spec)).chromium; } catch { /* try next */ }
    try { return require_(spec).chromium; } catch { /* try next */ }
  }
  for (const dir of ['/opt/node22/lib/node_modules', '/usr/lib/node_modules', '/usr/local/lib/node_modules']) {
    const p = path.join(dir, 'playwright', 'index.mjs');
    if (fs.existsSync(p)) return (await import(p)).chromium;
  }
  return null;
}
const chromium = await loadChromium();
if (!chromium) {
  console.log('SKIP  Playwright is not installed — cannot run the Live Visitors browser tests.');
  process.exit(0);
}

/* ------------------------------------------------------------ test harness */
let passed = 0, failed = 0;
const results = [];
function ok(name, cond, detail = '') {
  if (cond) { passed++; results.push(`  PASS  ${name}`); }
  else { failed++; results.push(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(name) { results.push(`\n${name}`); }
function crash(e) {
  results.push(`\n  CRASH  ${e && e.stack ? e.stack : e}`);
  console.log(results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed, then the run crashed`);
  process.exit(1);
}
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

/* ------------------------------------------------------------ static server */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'text/plain' });
  res.end(fs.readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

/* --------------------------------------------------------- the Worker, here */
function makeKV() {
  const store = new Map();
  const alive = (r) => !r.exp || r.exp > Date.now();
  return {
    _store: store,
    async get(k) { const r = store.get(k); return r && alive(r) ? r.value : null; },
    async put(k, v, o = {}) { store.set(k, { value: v, exp: o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : 0 }); },
    async delete(k) { store.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; },
  };
}
function d1(db) {
  return {
    prepare(sql) {
      const stmt = { sql, params: [] };
      stmt.bind = (...p) => ({ ...stmt, params: p, bind: stmt.bind, first: stmt.first, all: stmt.all, run: stmt.run });
      stmt.first = function (col) { const row = db.prepare(this.sql).get(...this.params); if (row === undefined) return null; return col ? row[col] : row; };
      stmt.all = function () { return { results: db.prepare(this.sql).all(...this.params), success: true }; };
      stmt.run = function () { const r = db.prepare(this.sql).run(...this.params); return { success: true, meta: { changes: Number(r.changes) } }; };
      return stmt;
    },
    batch(stmts) {
      const out = [];
      db.exec('BEGIN');
      try { for (const st of stmts) out.push(st.run()); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
      return out;
    },
  };
}
const PASS = 'watch-test-passcode';
function makeEnv({ journeys = true } = {}) {
  const env = { HITS: makeKV(), SUBS: makeKV(), SITE_ORIGIN: ORIGIN, WATCH_PASSWORD: PASS, SALT: 'watch-salt' };
  if (journeys) { const db = new DatabaseSync(':memory:'); db.exec(SCHEMA); env.VDB = d1(db); env._db = db; }
  return env;
}
const rowsOf = (env, sql, ...p) => env._db.prepare(sql).all(...p);
const dumpOf = (env) => JSON.stringify(['visitor', 'visitor_session', 'visitor_event', 'visitor_alert'].map((t) => rowsOf(env, `SELECT * FROM ${t}`)))
  + JSON.stringify([...env.HITS._store.values()]);

const WORKER = 'https://api-visitor-alerts.corlinllc.workers.dev';
const LEX = { city: 'Lexington', region: 'Virginia', country: 'US' };
let ipN = 0;
/**
 * Every request the page makes to the visitor Worker is handed to the Worker
 * module, as Cloudflare would hand it: with the page's Origin, a client
 * address (a fresh one each time — identity here is the token, never the
 * address) and Cloudflare's coarse geography.
 */
async function wire(ctx, env, log, { fail = '' } = {}) {
  await ctx.route(WORKER + '/**', async (route) => {
    const r = route.request();
    const u = new URL(r.url());
    const body = r.postData();
    if (body) log.push({ path: u.pathname, body });
    if (fail === 'abort') return route.abort('failed');
    if (fail === 'visitors500' && u.pathname === '/visitors') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false}' });
    const req = new Request('https://w.dev' + u.pathname + u.search, {
      method: r.method(),
      headers: { ...r.headers(), 'cf-connecting-ip': `203.0.113.${(ipN++ % 200) + 1}` },
      body: ['GET', 'HEAD', 'OPTIONS'].includes(r.method()) ? undefined : body,
    });
    req.cf = LEX;
    const res = await worker.fetch(req, env);
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    await route.fulfill({ status: res.status, headers, body: await res.text() });
  });
}

/* ------------------------------------------------------------ browser setup */
const launch = {};
const bundled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (fs.existsSync(bundled)) launch.executablePath = bundled;
const browser = await chromium.launch(launch);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** A browser that looks like a person to the beacon: not webdriver, a real
    user agent, a real time zone. */
async function person({ width = 1200, height = 900, gpc = false, exclude = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, userAgent: UA, timezoneId: 'America/New_York' });
  await ctx.addInitScript(([g, x]) => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
    if (g) Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true });
    if (x) { try { localStorage.setItem('apiv-exclude', '1'); } catch (e) {} }
  }, [gpc, exclude]);
  return ctx;
}
async function humanOn(page) {
  await page.mouse.move(200, 300);
  await page.mouse.move(260, 340);
  await page.waitForTimeout(250);
}
const settle = (page, ms = 400) => page.waitForTimeout(ms);

/* ============================================================== the beacon */

section('The beacon on the real pages');
let walk = null;
{
  const env = makeEnv();
  const log = [];
  const ctx = await person();
  await wire(ctx, env, log);
  let stored = null;
  await ctx.route('**api.web3forms.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' }));
  await ctx.route('**formsubmit.co/**', (r) => r.abort());
  await ctx.route('**/portal-api/ingest', (r) => { stored = JSON.parse(r.request().postData() || '{}'); r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(ORIGIN + '/child-custody-investigations/?utm_source=test&secret=1');
  await humanOn(page);
  await settle(page);
  const hits = log.filter((x) => x.path === '/hit').map((x) => JSON.parse(x.body));
  ok('a page view is sent after a human signal', hits.length === 1, String(hits.length));
  const h = hits[0] || {};
  ok('it carries the path and never the query string', h.path === '/child-custody-investigations/' && !JSON.stringify(h).includes('utm_source') && !JSON.stringify(h).includes('secret'), JSON.stringify(h));
  /* The mouse moved the instant the page loaded — a cursor already in motion.
     That used to fire under 150ms, which the Worker files as a replayed
     request, so the page view was dropped as a bot. */
  ok('a cursor already moving when the page opens still counts: the send waits out 200ms', (h.s && h.s.t >= 200) && rowsOf(env, 'SELECT COUNT(*) AS n FROM visitor')[0].n === 1, JSON.stringify(h.s));
  ok('it carries a random first-party token and a page-view id', /^[A-Za-z0-9_-]{22}$/.test(h.id || '') && /^[A-Za-z0-9_-]{16}$/.test(h.pv || ''), JSON.stringify(h));
  const token = await page.evaluate(() => localStorage.getItem('apiv-id'));
  ok('the token lives in this site\'s local storage, not a cookie', token === h.id && !(await ctx.cookies()).length);
  ok('the journey recorded the visitor, the visit and the page',
    rowsOf(env, 'SELECT COUNT(*) AS n FROM visitor')[0].n === 1 && rowsOf(env, "SELECT service FROM visitor_event WHERE kind = 'page'")[0].service === 'custody');

  // The custody page's own door into the intake.
  await page.locator('.cta a[href*="/intake/"]').first().click();
  await page.waitForURL(/\/intake\//);
  await humanOn(page);
  await settle(page, 700);
  const acts = rowsOf(env, "SELECT name, detail, service FROM visitor_event WHERE kind = 'action' ORDER BY at, rowid");
  ok('the press of "Request a Child Custody Investigation" is recorded', acts.some((a) => a.name === 'cta' && a.detail === 'custody'), JSON.stringify(acts));
  ok('opening the intake is recorded, on the Child Custody door', acts.some((a) => a.name === 'intake_opened' && a.service === 'custody'), JSON.stringify(acts));
  ok('it is the same visitor on the second page', rowsOf(env, 'SELECT COUNT(*) AS n FROM visitor')[0].n === 1 && await page.evaluate(() => localStorage.getItem('apiv-id')) === token);

  // §41: type sensitive data and do NOT submit.
  const SECRET = ['Jane Sensitive', '5405550199', 'jane.sensitive@example.com'];
  await page.locator('[data-k="c_name"]').fill(SECRET[0]);
  await page.locator('[data-k="c_phone"]').fill(SECRET[1]);
  await page.locator('[data-k="c_email"]').fill(SECRET[2]).catch(() => {});
  await settle(page, 500);
  ok('§41 starting the form is recorded as a bare fact', rowsOf(env, "SELECT COUNT(*) AS n FROM visitor_event WHERE name = 'intake_started'")[0].n === 1);
  const sentSoFar = JSON.stringify(log);
  ok('§41 nothing typed has left the page for the visitor Worker', SECRET.every((s) => !sentSoFar.includes(s)), SECRET.filter((s) => sentSoFar.includes(s)).join(', '));
  ok('§41 and nothing typed is in the journey', SECRET.every((s) => !dumpOf(env).includes(s)));

  // Now submit (the intake suite's own walk), and the link is made.
  const set = (k, v) => page.locator(`[data-k="${k}"]`).fill(v);
  const advance = async () => { await page.locator('.btn.primary').click(); await page.waitForTimeout(110); };
  await set('c_name', 'Dana Parent');
  await set('c_phone', '4345550144');
  await advance();
  await page.evaluate(() => pickSvc('custody'));
  await page.waitForTimeout(90);
  await advance();
  await set('s_name', 'Other Parent');
  await advance();
  await set('o_goal', 'Document the exchanges and who is present for them.');
  await advance();
  await page.locator('[data-k="a_consent"]').check();
  await set('a_typed', 'Dana Parent');
  const c = page.locator('#sig');
  await c.scrollIntoViewIfNeeded(); await page.waitForTimeout(60);
  const b = await c.boundingBox();
  await page.mouse.move(b.x + 30, b.y + 90); await page.mouse.down();
  await page.mouse.move(b.x + 120, b.y + 60); await page.mouse.move(b.x + 200, b.y + 100); await page.mouse.up();
  await advance();
  await settle(page, 900);
  ok('the intake reached the portal (the existing path, untouched)', stored && stored.service === 'Child Custody', JSON.stringify(stored && stored.service));
  const sub = rowsOf(env, "SELECT related_submission_id AS c, service FROM visitor_event WHERE name = 'intake_submitted'");
  ok('§41 the submission is linked by the request number the page minted', sub.length === 1 && stored && sub[0].c === stored.case_no && sub[0].service === 'custody', JSON.stringify(sub));
  ok('a NEW INTAKE alert was raised for it', rowsOf(env, "SELECT COUNT(*) AS n FROM visitor_alert WHERE kind = 'intake'")[0].n === 1);
  const all = JSON.stringify(log) + dumpOf(env);
  const fromForm = ['Dana Parent', '4345550144', 'Other Parent', 'Document the exchanges', 'data:image'];
  ok('§41 nothing else from the submission reached the visitor Worker or the journey', fromForm.every((s) => !all.includes(s)), fromForm.filter((s) => all.includes(s)).join(', '));
  ok('the pages raised no script errors', errors.length === 0, errors.join(' | '));

  // Engagement is sent when the page is hidden.
  await page.goto(ORIGIN + '/legal-investigations/');
  await humanOn(page);
  await page.waitForTimeout(1500);
  await humanOn(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await settle(page, 600);
  const legal = rowsOf(env, "SELECT engaged_ms, at FROM visitor_event WHERE kind = 'page' AND path = '/legal-investigations/'")[0];
  ok('engaged time is sent when the page is hidden', legal && legal.engaged_ms > 500 && legal.engaged_ms < 60_000, JSON.stringify(legal));
  const ts = log.filter((x) => x.path === '/t').map((x) => JSON.parse(x.body));
  ok('every check-in is a /t call carrying the token and nothing else of the page', ts.length > 0 && ts.every((t) => Object.keys(t).sort().join() === 'c,id,q'), JSON.stringify(ts.map((t) => Object.keys(t))));
  walk = { env, token };
  await ctx.close();
}

section('Do Not Track, Global Privacy Control and the owner\'s own browser');
{
  for (const [label, opts] of [['Global Privacy Control', { gpc: true }], ['a browser the owner marked as his own', { exclude: true }]]) {
    const env = makeEnv();
    const log = [];
    const ctx = await person(opts);
    await wire(ctx, env, log);
    const page = await ctx.newPage();
    await page.goto(ORIGIN + '/');
    await humanOn(page);
    await page.locator('a[href^="tel:"]').first().click({ noWaitAfter: true }).catch(() => {});
    await settle(page, 600);
    ok(`with ${label}: nothing is sent`, log.length === 0, String(log.length));
    ok(`with ${label}: no token is even made`, await page.evaluate(() => localStorage.getItem('apiv-id')) === null);
    await ctx.close();
  }
  // Headless automation, as the existing suites run it: the beacon stays out.
  const env = makeEnv(); const log = [];
  const ctx = await browser.newContext({ userAgent: UA, timezoneId: 'America/New_York' });
  await wire(ctx, env, log);
  const page = await ctx.newPage();
  await page.goto(ORIGIN + '/');
  await humanOn(page); await settle(page, 400);
  ok('an automated browser (navigator.webdriver) sends nothing', log.length === 0);
  await ctx.close();
}

section('Analytics fails open: the Worker unreachable changes nothing on the site');
{
  const env = makeEnv(); const log = [];
  const ctx = await person();
  await wire(ctx, env, log, { fail: 'abort' });
  let stored = null;
  await ctx.route('**api.web3forms.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' }));
  await ctx.route('**formsubmit.co/**', (r) => r.abort());
  await ctx.route('**/portal-api/ingest', (r) => { stored = JSON.parse(r.request().postData() || '{}'); r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(ORIGIN + '/child-custody-investigations/');
  await humanOn(page);
  await page.locator('.cta a[href*="/intake/"]').first().click();
  await page.waitForURL(/\/intake\//);
  ok('the intake button still navigates', page.url().includes('/intake/') && page.url().includes('service=custody'));
  const set = (k, v) => page.locator(`[data-k="${k}"]`).fill(v);
  const advance = async () => { await page.locator('.btn.primary').click(); await page.waitForTimeout(110); };
  await set('c_name', 'Fail Open'); await set('c_phone', '4345550155'); await advance();
  await page.evaluate(() => pickSvc('custody')); await page.waitForTimeout(90); await advance();
  await set('s_name', 'Somebody'); await advance();
  await set('o_goal', 'Check the intake still submits.'); await advance();
  await page.locator('[data-k="a_consent"]').check();
  await set('a_typed', 'Fail Open');
  const c = page.locator('#sig');
  await c.scrollIntoViewIfNeeded(); await page.waitForTimeout(60);
  const b = await c.boundingBox();
  await page.mouse.move(b.x + 30, b.y + 90); await page.mouse.down();
  await page.mouse.move(b.x + 150, b.y + 70); await page.mouse.up();
  await advance();
  await settle(page, 900);
  ok('the intake still submits with the visitor Worker down', stored && stored.service === 'Child Custody');
  ok('and the client sees their record', /Intake submitted/.test(await page.locator('#app').innerText()));
  ok('and no script error was raised', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/* ============================================================== dashboard */

/* Seed a dashboard: Visitor A from the brief (day 1 two days ago, day 3 three
   hours ago, submitted), plus visitors in the other tiers. The Worker runs in
   this process, so its clock is moved for the seeding and put back. */
async function seed(env) {
  const realNow = Date.now;
  let clock = realNow() - 2 * 86_400_000 - 3 * 3_600_000;
  Date.now = () => clock;
  let n = 0;
  const go = async (pathName, body) => {
    const req = new Request('https://w.dev' + pathName, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'text/plain', 'user-agent': UA, 'cf-connecting-ip': `198.51.100.${(n++ % 200) + 1}` },
      body: JSON.stringify(body),
    });
    req.cf = body._cf || LEX;
    delete body._cf;
    return worker.fetch(req, env);
  };
  const S = { tz: 'America/New_York', w: 390, h: 844, t: 4200 };
  const pageView = (id, pv, p, extra = {}) => go('/hit', { path: p, ref: '', s: S, id, pv, lt: clock - 1500, c: clock, ...extra });
  const t = (id, q) => go('/t', { id, c: clock, q });
  const e = (pv, m) => ({ k: 'e', p: pv, m });
  const a = (pv, name, extra = {}) => ({ k: 'a', p: pv, a: name, e: 'e' + Math.random().toString(36).slice(2, 9), t: clock, ...extra });
  const A = 'VisitorA_' + 'x'.repeat(16);
  await pageView(A, 'pvA1home00', '/', { ref: 'https://www.google.com/' });
  clock += 18_000; await t(A, [e('pvA1home00', 18_000)]);
  clock += 2_000; await pageView(A, 'pvA1cust00', '/child-custody-investigations/');
  clock += 128_000; await t(A, [e('pvA1cust00', 128_000)]);
  clock = realNow() - 3 * 3_600_000;
  await pageView(A, 'pvA2cust00', '/child-custody-investigations/');
  clock += 72_000; await t(A, [e('pvA2cust00', 72_000), a('pvA2cust00', 'cta', { d: 'custody' })]);
  // The intake opens just after the press that opened it, as it does in a browser.
  clock += 1_000; await go('/hit', { path: '/intake/', ref: '', s: S, id: A, pv: 'pvA2intk00', lt: clock - 900, c: clock, d: { door: 'private', svc: 'custody' } });
  clock += 20_000; await t(A, [a('pvA2intk00', 'intake_started')]);
  clock += 240_000; await t(A, [e('pvA2intk00', 261_000)]);
  clock += 17_000;
  const caseNo = `API-${new Date(clock).toISOString().slice(0, 10).replace(/-/g, '')}-4821`;
  await t(A, [a('pvA2intk00', 'intake_submitted', { n: caseNo, s: 'custody' })]);
  // An interested first-timer, a browsing one in Florida, and one on the site right now.
  const B = 'VisitorB_' + 'y'.repeat(16);
  clock = realNow() - 3 * 3_600_000 + 600_000;
  await pageView(B, 'pvB1home00', '/', { ref: 'https://www.google.com/' });
  clock += 30_000; await pageView(B, 'pvB1lyn000', '/private-investigator/lynchburg-va/');
  clock += 40_000; await pageView(B, 'pvB1inf000', '/infidelity-investigations/');
  clock += 12_000; await t(B, [e('pvB1inf000', 11_000)]);
  clock += 2_000; await pageView(B, 'pvB1cus000', '/child-custody-investigations/');
  clock += 50_000; await t(B, [e('pvB1cus000', 48_000)]);
  const C = 'VisitorC_' + 'z'.repeat(16);
  clock = realNow() - 3 * 86_400_000;
  await pageView(C, 'pvC1home00', '/', { ref: 'https://www.google.com/', _cf: { city: 'Destin', region: 'Florida', country: 'US' } });
  clock += 37_000; await t(C, [e('pvC1home00', 36_000)]);
  const D = 'VisitorD_' + 'w'.repeat(16);
  clock = realNow() - 60_000;
  await pageView(D, 'pvD1ins000', '/insurance-investigations/', { ref: 'https://www.bing.com/' });
  Date.now = realNow;
  const vid = async (token) => {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`vid|${token}|${env.SALT}`));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
  };
  return { A: await vid(A), B: await vid(B), C: await vid(C), D: await vid(D), caseNo };
}

async function dashboard({ width, height = 900, env, fail = '', query = '' }) {
  const ctx = await browser.newContext({ viewport: { width, height }, userAgent: UA, timezoneId: 'America/Los_Angeles' });
  await ctx.addInitScript((p) => { try { localStorage.setItem('apiwatch-token', p); } catch (e) {} }, PASS);
  const log = [];
  await wire(ctx, env, log, { fail });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(ORIGIN + '/watch/' + query);
  await page.waitForSelector('#app', { state: 'visible' });
  await page.waitForTimeout(700);
  return { ctx, page, errors };
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } }

const dash = makeEnv();
const ids = await seed(dash);
const visitorAAt = rowsOf(dash, 'SELECT first_at, last_at FROM visitor WHERE id = ?', ids.A)[0];
const fmt = (ms) => {
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(d).replace(/[  ]/g, ' ');
  return `${date} · ${time}`;
};

section('The dashboard on a phone: the list');
{
  const { ctx, page, errors } = await dashboard({ width: 390, height: 844, env: dash });
  await shot(page, 'list-390');
  ok('the 30-day ticker, "on the site now" and "visits today" are drawn', /\d/.test(await page.locator('#v30').innerText()) && await page.locator('#online').innerText() === '1');
  const cards = await page.locator('a.vcard').count();
  ok('one card per visitor', cards === 4, String(cards));
  const first = page.locator('a.vcard').first();
  ok('the visitor on the site now is first, and live', /Live now/i.test(await first.innerText()));
  const a = page.locator(`a.vcard[data-v="${ids.A}"]`);
  const at = await a.innerText();
  ok('Visitor A: path, place and source', at.includes('/intake/') && at.includes('Lexington, Virginia') && at.includes('Direct'), at);
  ok('Visitor A: HIGH INTENT, RETURNING and NEW INTAKE', /High intent/i.test(at) && /Returning/i.test(at) && /New intake/i.test(at), at);
  ok('Visitor A: 2 visits (2 this week), time on site, Submitted intake / Child Custody', at.includes('2 visits') && at.includes('(2 this week)') && at.includes('7m 59s') && at.includes('Submitted intake') && at.includes('Child Custody'), at);
  const border = await a.evaluate((el) => getComputedStyle(el).borderTopColor);
  ok('a HIGH INTENT card has the gold border', border === 'rgb(242, 184, 75)', border);
  const bt = await page.locator(`a.vcard[data-v="${ids.B}"]`).innerText();
  ok('an interested first-timer reads "1 visit / first time" and INTERESTED', bt.includes('1 visit') && bt.includes('first time') && /Interested/i.test(bt) && bt.includes('from Google'), bt);
  const ct = await page.locator(`a.vcard[data-v="${ids.C}"]`).innerText();
  ok('a homepage-only visitor reads BROWSING, "Viewed 1 page / Home", in Destin, Florida', /Browsing/i.test(ct) && ct.includes('Viewed 1 page') && ct.includes('Home') && ct.includes('Destin, Florida'), ct);
  ok('no sideways scroll on the list at 390', await overflow(page) <= 0, String(await overflow(page)));
  const small = await page.evaluate(() => [...document.querySelectorAll('#app button, #app a.vcard, header button')]
    .filter((el) => el.offsetParent !== null).map((el) => ({ t: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 20), h: el.getBoundingClientRect().height }))
    .filter((x) => x.h < 44));
  ok('every control on the list clears the 44px tap floor', small.length === 0, JSON.stringify(small));
  ok('no script errors', errors.length === 0, errors.join(' | '));

  // Tap → the visitor's journey, full screen.
  await a.click();
  await page.waitForSelector('.d-loc');
  await page.waitForTimeout(300);
  await shot(page, 'detail-390');
  ok('the list gives way to the journey on a phone', await page.locator('#listcol').isHidden() && await page.locator('#detail').isVisible());
  ok('the header becomes "← Live Visitors"', await page.locator('#back').isVisible() && !(await page.locator('h1').isVisible()));
  const loc = await page.locator('.d-loc').innerText();
  ok('the location card says Approximate location (IP), never exact', loc.includes('Lexington, Virginia') && loc.includes('Approximate location (IP)') && !/exact location/i.test(await page.locator('#detail').innerText()), loc);
  ok('the score is 85, in gold', await page.locator('.score-n').innerText() === '85'
    && await page.locator('.score-n').evaluate((el) => getComputedStyle(el).color) === 'rgb(242, 184, 75)');
  const det = await page.locator('#detail').innerText();
  ok('first seen and last active are exact, in Eastern time (on a Pacific laptop)', det.includes(fmt(visitorAAt.first_at)) && det.includes(fmt(visitorAAt.last_at)), fmt(visitorAAt.first_at) + ' / ' + fmt(visitorAAt.last_at));
  ok('total visits 2 (2 in last 7 days), Child Custody, intake submitted with its request number', det.includes('2 (2 in last 7 days)') && det.includes('Child Custody') && det.includes('Submitted ✓') && det.includes(ids.caseNo), det.slice(0, 400));
  const jrows = await page.locator('.journey li.j').allInnerTexts();
  ok('the journey draws every row in order, ending in the submission', jrows.length === 7 && /Landed from Google/.test(jrows[0]) && /Intake submitted/.test(jrows[6]), JSON.stringify(jrows));
  ok('each row shows its time with seconds', jrows.every((r) => /\d{1,2}:\d{2}:\d{2} [AP]M/.test(r)));
  ok('each row\'s full exact timestamp is one hover away', (await page.locator('.journey time').evaluateAll((t) => t.map((x) => x.title))).every((tt) => /^[A-Z][a-z]{2} \d{1,2}, \d{4} · .* E[DS]T$/.test(tt)));
  ok('pages viewed (4)', /Pages Viewed\s*\(4\)/.test(det));
  ok('the actions list names the submission and the return', det.includes('Submitted intake form') && det.includes('Returning visitor') && det.includes('2nd visit this week'));
  ok('the request number opens the case portal, which decides who may see it', await page.locator('.journey a[href^="/portal/?case="]').getAttribute('href') === '/portal/?case=' + encodeURIComponent(ids.caseNo));
  ok('no sideways scroll on the journey at 390', await overflow(page) <= 0, String(await overflow(page)));
  // The score explains itself.
  const info = page.locator('button.info');
  ok('the ⓘ explanation starts closed', await info.getAttribute('aria-expanded') === 'false' && await page.locator('#rules').isHidden());
  await info.click();
  ok('ⓘ opens how the score is counted', await info.getAttribute('aria-expanded') === 'true' && /Not a probability/.test(await page.locator('#rules').innerText()));
  // Back, by the button and by the phone's own back.
  await page.locator('#back').click();
  await page.waitForTimeout(250);
  ok('← Live Visitors returns to the list', await page.locator('#listcol').isVisible() && !(await page.locator('#detail').isVisible()));
  await page.locator(`a.vcard[data-v="${ids.C}"]`).click();
  await page.waitForSelector('.d-loc'); await page.waitForTimeout(250);
  await page.goBack(); await page.waitForTimeout(300);
  ok('the browser\'s own back also returns to the list', await page.locator('#listcol').isVisible());
  await ctx.close();
}

section('The dashboard at 320');
{
  const { ctx, page } = await dashboard({ width: 320, height: 640, env: dash });
  ok('no sideways scroll on the list at 320', await overflow(page) <= 0, String(await overflow(page)));
  await page.locator(`a.vcard[data-v="${ids.A}"]`).click();
  await page.waitForSelector('.d-loc'); await page.waitForTimeout(300);
  await shot(page, 'detail-320');
  ok('no sideways scroll on the journey at 320', await overflow(page) <= 0, String(await overflow(page)));
  const small = await page.evaluate(() => [...document.querySelectorAll('#detail button, #detail a, header button')]
    .filter((el) => el.offsetParent !== null && !el.closest('.jl')).map((el) => ({ t: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 20), h: el.getBoundingClientRect().height }))
    .filter((x) => x.h < 44));
  ok('every button on the journey clears 44px at 320', small.length === 0, JSON.stringify(small));
  const clipped = await page.evaluate(() => [...document.querySelectorAll('.badge')].filter((b) => b.getBoundingClientRect().right > document.documentElement.clientWidth).length);
  ok('badges wrap instead of running off the screen', clipped === 0, String(clipped));
  await ctx.close();
}

section('The dashboard on a desk: list left, journey right');
{
  const { ctx, page, errors } = await dashboard({ width: 1280, height: 900, env: dash });
  await page.waitForSelector('.d-loc');
  await shot(page, 'desk-1280');
  const L = await page.locator('#listcol').boundingBox();
  const R = await page.locator('#detail').boundingBox();
  ok('the list and the journey sit side by side', L && R && L.x + L.width <= R.x + 1 && Math.abs(L.y - R.y) < 40, JSON.stringify({ L, R }));
  ok('the newest visitor\'s journey opens by itself', await page.locator('a.vcard.sel').count() === 1);
  await page.locator(`a.vcard[data-v="${ids.A}"]`).click();
  await page.waitForTimeout(500);
  ok('choosing another visitor swaps the journey in place', (await page.locator('#detail').innerText()).includes(ids.caseNo) && await page.locator(`a.vcard.sel[data-v="${ids.A}"]`).count() === 1);
  ok('the back button is not drawn on a desk', !(await page.locator('#back').isVisible()));
  ok('no sideways scroll at 1280', await overflow(page) <= 0);
  ok('no script errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

section('A link from an alert opens that visitor');
{
  const { ctx, page } = await dashboard({ width: 390, height: 844, env: dash, query: '?v=' + ids.B });
  await page.waitForSelector('.d-loc'); await page.waitForTimeout(300);
  ok('/watch/?v=<id> opens straight on that visitor\'s journey', (await page.locator('.d-loc').innerText()).includes('Lexington, Virginia') && /Interested/i.test(await page.locator('.d-loc').innerText()));
  await ctx.close();
}

section('Three states, never a failure drawn as an empty list');
{
  const { ctx, page } = await dashboard({ width: 390, height: 844, env: dash, fail: 'visitors500' });
  const st = await page.locator('#state').innerText();
  ok('a failed read says it could not load, and is not "nobody visited"', /could not be loaded/i.test(st) && !/No visitors/i.test(await page.locator('#listcol').innerText()), st);
  ok('and offers Try again', await page.locator('#state button[data-act="retry"]').count() === 1);
  await ctx.close();
  const legacy = makeEnv({ journeys: false });
  // A page view in the old log so the fallback has something to draw.
  const req = new Request('https://w.dev/hit', { method: 'POST', headers: { origin: ORIGIN, 'user-agent': UA, 'content-type': 'text/plain', 'cf-connecting-ip': '198.51.100.250' },
    body: JSON.stringify({ path: '/', ref: '', s: { tz: 'America/New_York', w: 390, h: 844, t: 4200 } }) });
  req.cf = LEX;
  await worker.fetch(req, legacy);
  const l = await dashboard({ width: 390, height: 844, env: legacy });
  const lt = await l.page.locator('#listcol').innerText();
  ok('without journeys the page-view log is shown, and says why', /not switched on yet/i.test(lt) && lt.includes('Lexington, Virginia'), lt.slice(0, 300));
  await l.ctx.close();
}

section('This browser: the owner\'s own visits are not leads');
{
  const { ctx, page } = await dashboard({ width: 390, height: 844, env: dash });
  ok('unlocking the dashboard marks this browser as not counted', await page.evaluate(() => localStorage.getItem('apiv-exclude')) === '1' && /not counted/i.test(await page.locator('#devText').innerText()));
  await page.locator('#devToggle').click();
  ok('one tap counts it again (for testing), and says so', await page.evaluate(() => localStorage.getItem('apiv-exclude')) === '0' && /is counted/i.test(await page.locator('#devText').innerText()));
  await ctx.close();
}

/* ----------------------------------------------------------------- report */
await browser.close();
server.close();
console.log('\nLive Visitors browser tests\n');
console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
