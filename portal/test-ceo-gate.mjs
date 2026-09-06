/**
 * THE CEO UX GATE (owner charter 2026-09-06, Mission 1).
 *
 * A skeptical real user walked through the product: the public site, the three
 * intake doors, the portal's main screens and the phone render — asking, at
 * every stop, the charter's own questions. Can a client figure out what to do?
 * Can they get trapped? Is there a way back? Does mobile work? Can the owner
 * reach the money actions fast?
 *
 * It is a GATE: run it before major releases.
 *
 *   node portal/test-ceo-gate.mjs
 *
 * Findings print in the charter's report shape — severity, what a real user
 * sees, why it is confusing, the reproduction path, the smallest safe fix,
 * and who it affects. A green run prints its PASS ledger. WARN does not fail
 * the gate; FAIL does. The CEO Bot reads the same checks' ids, so the gate
 * detects and the Bot displays — one crawler, never two.
 */
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import worker from '../case-portal/worker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'case-portal/schema.sql'), 'utf8');

async function loadChromium() {
  const require_ = createRequire(import.meta.url);
  for (const spec of ['playwright', 'playwright-core']) {
    try { return (await import(spec)).chromium; } catch { /* next */ }
    try { return require_(spec).chromium; } catch { /* next */ }
  }
  for (const dir of ['/opt/node22/lib/node_modules', '/usr/lib/node_modules', '/usr/local/lib/node_modules']) {
    const p = path.join(dir, 'playwright', 'index.mjs');
    if (fs.existsSync(p)) return (await import(p)).chromium;
  }
  return null;
}
const chromium = await loadChromium();
if (!chromium) { console.log('SKIP  Playwright is not installed.'); process.exit(0); }

/* ------------------------------------------------------------ the ledger */

const findings = [];
let passes = 0;
/* A finding in the charter's own shape. `id` is stable — the CEO Bot keys on
   it, and a dismissal has to survive a rewording. */
function finding(sev, id, f) { findings.push({ sev, id, ...f }); }
function pass(id, what) { passes++; findings.push({ sev: 'PASS', id, what }); }
function gate(id, cond, sevIfNot, f) { if (cond) pass(id, f.what); else finding(sevIfNot, id, f); }

/* ------------------------------------------------- D1 adapter over sqlite */

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
    batch(stmts) {
      const out = [];
      db.exec('BEGIN');
      try { for (const st of stmts) out.push(st.run()); db.exec('COMMIT'); }
      catch (e) { try { db.exec('ROLLBACK'); } catch { /* unwound */ } throw e; }
      return out;
    },
  };
}

const db = new DatabaseSync(':memory:');
db.exec(SCHEMA);

/* The Worker's outbound calls are answered locally — the gate never reaches
   Dropbox or a mail provider. */
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('dropboxapi.com')) {
    if (u.includes('oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'AT', expires_in: 14400 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200 });
  }
  if (u.includes('api.resend.com')) return new Response('{"id":"re"}', { status: 200 });
  return realFetch(url, init);
};

const env = {
  DB: d1(db), SITE_ORIGIN: '',
  INGEST_KEY: 'gate-ingest-key', BOOTSTRAP_TOKEN: 'gate-bootstrap',
  PBKDF2_ITER: '10000', INGEST_PER_MINUTE: '500',
  DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's', DROPBOX_REFRESH_TOKEN: 'r',
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.css': 'text/css', '.xml': 'text/xml', '.txt': 'text/plain' };
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/portal-api')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
      method: req.method, headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const out = await worker.fetch(request, env);
    const headers = {};
    const cookies = out.headers.getSetCookie ? out.headers.getSetCookie() : [];
    for (const [k, v] of out.headers) if (k.toLowerCase() !== 'set-cookie') headers[k] = v;
    if (cookies.length) headers['set-cookie'] = cookies.map(c => c.replace(/;\s*Secure/i, ''));
    res.writeHead(out.status, headers);
    return res.end(Buffer.from(await out.arrayBuffer()));
  }
  let p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'text/plain' });
  res.end(fs.readFileSync(p));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${server.address().port}`;
env.SITE_ORIGIN = SITE;

async function post(p, body, headers = {}) {
  return worker.fetch(new Request(SITE + '/portal-api' + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: SITE, ...headers },
    body: JSON.stringify(body),
  }), env);
}
await post('/setup', { username: 'trever', display_name: 'Trever Brown', password: 'GatePassword1x' },
  { 'X-Bootstrap-Token': 'gate-bootstrap' });
/* A signed intake and a paid retainer, so the walk sees real content. */
await post('/ingest', { case_no: 'API-GATE-1', service: 'Surveillance',
  client_name: 'Gate Client', client_email: 'gate@example.com', client_phone: '4345550100',
  subject_name: 'Gate Subject', objective: 'Verify the walk',
  signature: 'data:image/png;base64,iVBORw0KGgo=' }, { 'X-Ingest-Key': 'gate-ingest-key' });

const launch = {};
const bundled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (fs.existsSync(bundled)) launch.executablePath = bundled;
const browser = await chromium.launch(launch);

async function page(width = 1200, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const pg = await ctx.newPage();
  await pg.route('**api.web3forms.com/**', r => r.fulfill({ status: 200, body: '{"success":true}' }));
  pg.on('pageerror', e => finding('FAIL', 'js-error', {
    what: `The page threw: ${e.message}`, why: 'A thrown error can stop everything after it.',
    path: pg.url(), fix: 'Read the stack; a page that throws is broken for someone.',
    who: 'both' }));
  return pg;
}
async function signIn(pg) {
  await pg.goto(SITE + '/portal/');
  await pg.waitForTimeout(400);
  await pg.fill('#u', 'trever');
  await pg.fill('#p', 'GatePassword1x');
  await pg.click('button[data-act="login"], #loginBtn');
  await pg.waitForTimeout(1400);
}

/* ---- REUSABLE CHECKS — each has a stable id the CEO Bot keys on. ---- */

/* The client-side vocabulary sweep: internal/CRM words a client must never
   read. Surgical on purpose — "assignment" is legitimate client language on
   this site ("Submit an Assignment"), so it is NOT on the list. */
const INTERNAL_WORDS = /\blead status\b|\bconverted\b|\btombstone\b|\bredact|\bDEMO_|\bTEST-\b|\badmin only\b|\bCRM\b/i;

async function checkOverflow(pg, id, where, who) {
  const over = await pg.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  gate(`${id}:overflow`, !over, 'FAIL', {
    what: `${where} scrolls sideways at 390px.`,
    why: 'Horizontal scroll on a phone hides content and reads as broken.',
    path: `Open ${where} at 390px and swipe sideways.`,
    fix: 'Find the box wider than the viewport (usually a fixed width or an unwrapped row) and let it wrap or scroll inside its own container.',
    who });
}
async function checkTapFloor(pg, id, where, selector, who, floor = 44) {
  const small = await pg.evaluate(({ sel, fl }) =>
    [...document.querySelectorAll(sel)]
      .filter(b => b.offsetParent !== null)
      .map(b => ({ t: (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 30),
                   h: Math.round(b.getBoundingClientRect().height) }))
      .filter(b => b.h > 0 && b.h < fl), { sel: selector, fl: floor });
  gate(`${id}:tap`, small.length === 0, 'WARN', {
    what: `${where}: ${small.length} control(s) under the ${floor}px tap floor — ${JSON.stringify(small.slice(0, 4))}`,
    why: 'A control smaller than a fingertip gets missed taps, and the miss lands on whatever is beside it.',
    path: `Open ${where} at 390px and measure the named controls.`,
    fix: 'min-height on the control (end of the stylesheet, after what it overrides).',
    who });
}

/* ============================ THE CLIENT SIDE ============================ */

/* 1. The public home page: can a client start, and does every start work? */
{
  const pg = await page();
  await pg.goto(SITE + '/');
  await pg.waitForTimeout(300);
  const doors = await pg.evaluate(() => ({
    cards: [...document.querySelectorAll('a[href*="/intake/"]')].map(a => a.getAttribute('href')),
    tel: !!document.querySelector('a[href^="tel:"]'),
  }));
  gate('home:doors', doors.cards.some(h => h.includes('assignment=insurance'))
    && doors.cards.some(h => h.includes('assignment=legal'))
    && doors.cards.some(h => h.includes('assignment=private')), 'FAIL', {
    what: 'The homepage is missing one of the three intake doors.',
    why: 'A client who cannot find their door phones instead — the delay the portal exists to remove.',
    path: 'Open / and look for the three cards.', fix: 'Restore the missing card link.',
    who: 'client' });
  gate('home:call', doors.tel, 'WARN', {
    what: 'No tap-to-call number on the homepage.', why: 'Some clients will only ever phone.',
    path: 'Open / on a phone.', fix: 'Keep a tel: link visible.', who: 'client' });
  await pg.close();
}

/* 2. Each intake door, cold, exactly as an email/text link opens it. */
for (const door of ['', '?assignment=private', '?assignment=legal', '?assignment=insurance']) {
  const name = door || 'bare /intake/';
  const pg = await page(390, 844);
  await pg.goto(SITE + '/intake/' + door);
  await pg.waitForTimeout(400);
  const m = await pg.evaluate(() => ({
    back: !!document.querySelector('.top a.home'),
    backFoot: !!document.querySelector('.foot a.home2'),
    brand: /ALWAYS PRECISE/.test(document.body.innerText),
    progress: !!document.querySelector('#progress i'),
    firstQuestion: !!document.querySelector('#app input, #app select, .opt'),
    txt: document.body.innerText,
  }));
  gate(`intake:${name}:back`, m.back && m.backFoot, 'FAIL', {
    what: `${name} has no way back to the main site.`,
    why: 'A client arriving from a text has no browser history — without a link they are trapped.',
    path: `Open /intake/${door} directly on a phone.`,
    fix: 'The header and footer way-back links.', who: 'client' });
  gate(`intake:${name}:orient`, m.brand && m.progress && m.firstQuestion, 'FAIL', {
    what: `${name} does not orient a cold visitor (brand/progress/first question).`,
    why: 'Ten seconds of confusion on a phone is an abandoned intake.',
    path: `Open /intake/${door} directly.`, fix: 'Keep branding, progress and the first field on screen one.',
    who: 'client' });
  gate(`intake:${name}:words`, !INTERNAL_WORDS.test(m.txt), 'FAIL', {
    what: `${name} shows internal vocabulary: ${(m.txt.match(INTERNAL_WORDS) || [])[0]}`,
    why: 'CRM language tells a client they are a database row.',
    path: `Open /intake/${door} and read.`, fix: 'Reword the client-facing copy.', who: 'client' });
  await checkOverflow(pg, `intake:${name}`, `/intake/${door}`, 'client');
  await pg.close();
}

/* 3. The private door, walked to the signature and submitted — the overnight
   client of Scenario A, on a phone, no help. */
{
  const pg = await page(390, 844);
  let portalGot = null;
  await pg.route('**/portal-api/ingest', r => {
    portalGot = JSON.parse(r.request().postData() || '{}');
    r.fulfill({ status: 200, body: '{"ok":true}' });
  });
  await pg.goto(SITE + '/intake/?assignment=private');
  await pg.waitForTimeout(300);
  const step = async () => { await pg.locator('.btn.primary').click(); await pg.waitForTimeout(150); };
  await pg.locator('[data-k="c_name"]').fill('Overnight Client');
  await pg.locator('[data-k="c_phone"]').fill('4345550188');
  await step();
  await pg.locator('.opt').first().click();
  await step();
  await pg.locator('[data-k="s_name"]').fill('Subject Person');
  await step();
  /* THE KEY IS `o_goal`. Probed against the real wizard rather than guessed:
     the private door's steps are c_name/c_phone → the service picker →
     s_name → o_goal → the agreement, and a gate that walks a form by
     invented selectors is a gate that reports on a form nobody ships. */
  await pg.locator('[data-k="o_goal"]').fill('Document activity overnight');
  await step();
  for (let i = 0; i < 3; i++) {
    const sig = pg.locator('#sig');
    if (await sig.count()) break;
    await step();
  }
  const sig = pg.locator('#sig');
  gate('intake:reach-signature', await sig.count() > 0, 'FAIL', {
    what: 'The private door never reached a signature step under a minimal fill.',
    why: 'If the happy path stalls, the overnight client phones or gives up.',
    path: 'Private door, fill name+phone, pick first service, subject, objective, Continue.',
    fix: 'Walk the wizard and find the step that refused.', who: 'client' });
  if (await sig.count()) {
    /* SCROLL THE CANVAS INTO VIEW FIRST. `intake/test-intake.mjs` already
       carries the reason in its own helper — at a phone viewport the canvas
       sits below the fold and a pointer event outside the viewport is simply
       lost — and this gate did not inherit it. The strokes went nowhere, the
       form said "Please sign in the box above", the submit never fired, and
       the gate reported the PRODUCT as failing to deliver the intake.

       A gate that cries wolf is worse than no gate: it is the one report the
       owner is meant to trust about dead ends, and its first finding would
       have been a dead end it caused itself. Both halves of the agreement are
       filled by their own keys now rather than by "the first checkbox". */
    await sig.scrollIntoViewIfNeeded();
    await pg.waitForTimeout(60);
    const box = await sig.boundingBox();
    await pg.mouse.move(box.x + 30, box.y + 90);
    await pg.mouse.down();
    await pg.mouse.move(box.x + 120, box.y + 60);
    await pg.mouse.move(box.x + 200, box.y + 100);
    await pg.mouse.up();
    await pg.waitForTimeout(60);
    const agree = pg.locator('[data-k="a_consent"]');
    if (await agree.count()) await agree.check();
    const typed = pg.locator('[data-k="a_typed"]');
    if (await typed.count()) await typed.fill('Overnight Client');
    await pg.locator('.btn.primary').click();
    await pg.waitForTimeout(1200);
    const confirm = await pg.evaluate(() => document.body.innerText);
    gate('intake:confirmation', /request number|case/i.test(confirm)
      && /Return to Always Precise/i.test(confirm), 'FAIL', {
      what: 'The post-submit page does not confirm and route the client onward.',
      why: 'A dead-end confirmation is the last thing a paying client sees.',
      path: 'Submit the private intake and read the final screen.',
      fix: 'Confirmation must show the reference and the way back.', who: 'client' });
    gate('intake:submitted', portalGot !== null && !!portalGot.case_no, 'FAIL', {
      what: 'Submitting did not deliver the intake to the portal.',
      why: 'The overnight client thinks they are done; the office never hears.',
      path: 'Submit and watch the network.', fix: 'The ingest post.', who: 'both' });
  }
  await pg.close();
}

/* ============================ THE OWNER SIDE ============================ */

/* 4. Sign in, and the desk answers "what do I do next" — Scenario A's morning
   half: the signed intake is ONE TAP from the list. */
{
  const pg = await page();
  await signIn(pg);
  const dash = await pg.evaluate(() => ({
    signedIn: !!document.querySelector('.tabs'),
    quick: [...document.querySelectorAll('[data-qt]')].map(b => b.dataset.qt),
  }));
  gate('portal:in', dash.signedIn, 'FAIL', {
    what: 'Sign-in did not land on the portal.', why: 'Nothing else matters if this fails.',
    path: 'Sign in.', fix: 'Read the console.', who: 'owner' });
  gate('portal:rate-sheet-first', dash.quick.includes('sheets'), 'FAIL', {
    what: 'The Rate Sheet quick action is missing from Home.',
    why: 'It is the owner\'s most-used conversion tool; Mission 3 puts it first.',
    path: 'Sign in, look at Quick tools.', fix: 'Restore the quick action.', who: 'owner' });

  await pg.evaluate(() => { TAB = 'leads'; paint(); });
  await pg.waitForTimeout(600);
  const card = await pg.evaluate(() => {
    const b = document.querySelector('.pc-open');
    return b ? { label: b.getAttribute('aria-label') || b.textContent } : null;
  });
  gate('portal:one-tap-intake', !!card, 'FAIL', {
    what: 'The Intakes desk offers no one-tap door into the submitted intake.',
    why: 'Review → case → scroll → details is the friction the owner named.',
    path: 'Portal → Intakes → the card.', fix: 'The identity block is the door (pc-open).',
    who: 'owner' });
  if (card) {
    await pg.evaluate(() => document.querySelector('.pc-open').click());
    await pg.waitForTimeout(900);
    const detail = await pg.evaluate(() => ({
      tab: typeof WS_TAB !== 'undefined' ? WS_TAB : null,
      sig: !!document.querySelector('img.sig'),
      actions: /What happens to this intake/.test(document.body.innerText),
      back: !!document.querySelector('[data-act="backToCases"]') || !!document.querySelector('.tabs'),
    }));
    gate('portal:intake-direct', detail.tab === 'details' && detail.sig, 'FAIL', {
      what: 'One tap did not land on the full submitted intake with the signature visible.',
      why: 'The signed intake is the document; the owner reads it, not a summary.',
      path: 'Intakes → tap the card.', fix: 'pc-open routes to the details tab.', who: 'owner' });
    gate('portal:intake-actions', detail.actions, 'WARN', {
      what: 'The intake screen does not carry its own action row.',
      why: 'Acting on what was just read should not mean going back to the desk.',
      path: 'Open an intake, scroll to the bottom.', fix: 'intakeActionsHtml at the details foot.',
      who: 'owner' });
    gate('portal:intake-back', detail.back, 'FAIL', {
      what: 'No visible way back from the intake screen.', why: 'A dead end on the most-used path.',
      path: 'Open an intake and look for Back.', fix: 'Back to Cases / the rail.', who: 'owner' });
  }

  /* The case screen: the money actions are on the row (Missions 6-7). */
  await pg.evaluate(() => openCase('API-GATE-1'));
  await pg.waitForTimeout(900);
  const caseRow = await pg.evaluate(() => ({
    ret: !!document.querySelector('[data-act="retQuick"]'),
    close: !!document.querySelector('[data-act="fcQuick"]'),
    surv: /surveillance/i.test(document.body.innerText),
  }));
  gate('portal:money-actions', caseRow.ret && caseRow.close, 'FAIL', {
    what: 'Retainer paid / Close case are not on the case actions row.',
    why: 'They are as operationally important as Start Day (charter Missions 6-7).',
    path: 'Open a private case and look at the actions row.', fix: 'caseActionsHtml.',
    who: 'owner' });
  await pg.close();
}

/* 5. The portal at 390: the phone is the owner's fast operations app. */
{
  const pg = await page(390, 844);
  await signIn(pg);
  await checkOverflow(pg, 'portal:home', 'the portal Home at 390', 'owner');
  await checkTapFloor(pg, 'portal:home', 'the portal Home', '.qtapp, .appbar button, .btn', 'owner');
  const nav = await pg.evaluate(() => ({
    bottomNav: !!document.querySelector('.appbar'),
    burger: !!document.querySelector('.burger'),
  }));
  gate('portal:phone-nav', nav.bottomNav || nav.burger, 'FAIL', {
    what: 'No phone navigation (bottom bar or burger) on the portal at 390.',
    why: 'A phone portal with no nav is one screen deep forever.',
    path: 'Sign in at 390.', fix: 'The appbar/burger.', who: 'owner' });

  /* Every top-level screen has a way to leave it. */
  for (const tab of ['leads', 'sheets', 'cases', 'tasks', 'settings']) {
    await pg.evaluate(t => { TAB = t; WS_CASE = null; VIEW = 'list'; paint(); }, tab);
    await pg.waitForTimeout(350);
    const out = await pg.evaluate(() => ({
      nav: !!document.querySelector('.appbar') || !!document.querySelector('.burger'),
    }));
    gate(`portal:${tab}:exit`, out.nav, 'FAIL', {
      what: `The ${tab} screen has no visible way to another screen at 390.`,
      why: 'A dead end — the owner reloads to escape.',
      path: `Open ${tab} at 390.`, fix: 'Keep the nav on every top-level screen.', who: 'owner' });
    await checkOverflow(pg, `portal:${tab}`, `the ${tab} screen at 390`, 'owner');
  }
  await pg.close();
}

/* 6. The Assistant panel and the case closeout on the phone: scroll ownership
   and reachability — the two known phone failure modes. */
{
  const pg = await page(390, 844);
  await signIn(pg);
  await pg.evaluate(() => openCase('API-GATE-1'));
  await pg.waitForTimeout(800);
  await pg.evaluate(() => { WS_TAB = 'billing'; WS_MORE = false; paintCase(); });
  await pg.waitForTimeout(600);
  const co = await pg.evaluate(() => {
    const box = document.querySelector('.fc-box');
    return { present: !!box,
      over: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
  });
  gate('portal:closeout-phone', co.present && !co.over, 'FAIL', {
    what: 'The closeout panel is missing or overflows at 390.',
    why: 'Closing a case is a core action and has to work from the owner\'s phone.',
    path: 'Case → Billing & closing at 390.', fix: 'The fc- phone rules.', who: 'owner' });
  await pg.close();
}

/* --------------------------------------------------------------- report */

globalThis.fetch = realFetch;
await browser.close();
server.close();

/* ==================== THE GATE ANSWERS FOR THE BOT =========================

   The CEO Bot's Health tab prints `CEO_GATE_SUMMARY` from `case-portal/
   worker.js`. That is a LITERAL, so on its own it is a number somebody typed
   once — and the tab would go on reading "0 critical dead ends in the last
   release gate" forever, including the release that introduced the first one.

   So the gate is the writer's check: it compares its own fresh totals against
   that literal and FAILS on drift, naming what to paste. "The gate detects,
   the Bot displays" (brief §7) only means anything if this runs. */
{
  const wsrc = fs.readFileSync(path.join(ROOT, 'case-portal/worker.js'), 'utf8');
  const m = wsrc.match(/const CEO_GATE_SUMMARY = \{\s*ran: '([^']+)',\s*pass: (\d+), warn: (\d+), fail: (\d+)/);
  const claimed = m ? { pass: +m[2], warn: +m[3], fail: +m[4] } : null;
  /* COUNTED FROM `findings` DIRECTLY, because this check runs BEFORE `fails`
     and `warns` are derived — and it has to. Placed after them, its own FAIL
     landed in `findings` while the summary counted a snapshot taken before it:
     the run printed 0 FAIL and exited 0 with a real failure in the report.
     A check whose result cannot reach the summary is a check that is not
     running, and it took the JSON to see it.

     `passes + 1` counts the pass this is about to record. */
  const real = { pass: passes + 1,
    warn: findings.filter(f => f.sev === 'WARN').length,
    fail: findings.filter(f => f.sev === 'FAIL').length };
  const agrees = !!claimed && claimed.pass === real.pass
    && claimed.warn === real.warn && claimed.fail === real.fail;
  gate('gate:bot-summary-current', agrees, 'FAIL', {
    what: 'The CEO Bot Health tab states gate totals this run does not agree with'
        + ` — it claims ${claimed ? JSON.stringify(claimed) : 'nothing readable'},`
        + ` this run measured ${JSON.stringify(real)}.`,
    why: 'The Bot would tell the owner the portal is healthier (or worse) than it is, '
       + 'in the one panel written to answer that question.',
    path: 'node portal/test-ceo-gate.mjs, then read CEO_GATE_SUMMARY in worker.js.',
    fix: `Set CEO_GATE_SUMMARY to { pass: ${real.pass}, warn: ${real.warn}, fail: ${real.fail} }.`,
    who: 'owner' });
}

const fails = findings.filter(f => f.sev === 'FAIL');
const warns = findings.filter(f => f.sev === 'WARN');
console.log('CEO UX GATE');
console.log('===========');
for (const f of findings) {
  if (f.sev === 'PASS') { console.log(`  PASS  ${f.id}${f.what ? ' — ' + f.what : ''}`); continue; }
  console.log(`\n  ${f.sev}  [${f.id}] ${f.what}`);
  console.log(`        why:  ${f.why}`);
  console.log(`        repro: ${f.path}`);
  console.log(`        fix:  ${f.fix}`);
  console.log(`        affects: ${f.who}`);
}

console.log(`\n${passes} PASS, ${warns.length} WARN, ${fails.length} FAIL`);
/* The machine-readable copy, for the CEO Bot's Health tab. */
fs.writeFileSync(path.join(HERE, 'ceo-gate-report.json'), JSON.stringify({
  ran_at: new Date().toISOString(), pass: passes, warn: warns.length, fail: fails.length,
  findings: findings.filter(f => f.sev !== 'PASS'),
}, null, 1));
process.exit(fails.length ? 1 : 0);
