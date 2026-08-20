/**
 * End-to-end tests for the case portal.
 *
 * Serves the real /portal/ page against the real case-portal Worker, backed by
 * a real SQLite database — page, API and SQL all genuinely exercised, nothing
 * stubbed but the network transport. The page's API constant is rewritten on
 * the fly to point at the local Worker.
 *
 *   node portal/test-portal.mjs
 *
 * Needs Playwright, which is not vendored:
 *   npm i -g playwright && npx playwright install chromium
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

/* ------------------------------------------------------------ dependencies */

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
if (!chromium) {
  console.log('SKIP  Playwright is not installed — cannot run the portal tests.');
  console.log('      npm i -g playwright && npx playwright install chromium');
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

/* A crashed run must still say what it saw. An uncaught Playwright timeout
   otherwise swallows the whole report — including the page-error FAILs that
   name the exception being debugged. */
function crash(e) {
  results.push(`\n  CRASH  ${e && e.message ? e.message : e}`);
  console.log(results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed, then the run crashed`);
  process.exit(1);
}
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

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
    /* D1's batch() is one transaction: all its statements commit or none do.
       The Worker relies on that to write a retainer payment and claim its
       idempotency token as a single fact. This mock lacked it, so the route
       threw here while the worker suite passed — the two harnesses have to
       model the same database. */
    batch(stmts) {
      const out = [];
      db.exec('BEGIN');
      try {
        for (const st of stmts) out.push(st.run());
        db.exec('COMMIT');
      } catch (e) {
        /* Rolling back must not replace the error that caused it, and must not
           leave a transaction open for every statement after it. */
        try { db.exec('ROLLBACK'); } catch { /* already unwound */ }
        throw e;
      }
      return out;
    },
  };
}

/* --------------------------------------------------------------- servers */

const db = new DatabaseSync(':memory:');
db.exec(SCHEMA);

/* ------------------------------------------------------------ fake Dropbox

   New case photos go to Dropbox since 2026-08-18, so the Worker under test
   needs one that answers. This intercepts only the Worker's own outbound calls
   — Node's fetch — and never the browser's, which talks to the local server
   over real HTTP. Files are kept in memory so a test can assert where one
   landed rather than inferring it from a 201. */
const DBX = {
  files: new Map(),
  folders: new Set(),
  reset() { this.files.clear(); this.folders.clear(); },
  paths() { return [...this.files.keys()]; },
};
const REAL_FETCH = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url && url.url ? url.url : url);
  if (!u.includes('dropboxapi.com')) return REAL_FETCH(url, init);
  const arg = () => JSON.parse((init.headers || {})['Dropbox-API-Arg'] || '{}');
  if (u.includes('/oauth2/token')) {
    return new Response(JSON.stringify({ access_token: 'sl.FAKE', expires_in: 14400 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('/2/files/create_folder_batch')) {
    for (const f of JSON.parse(init.body).paths) DBX.folders.add(f);
    return new Response('{"entries":[]}', { status: 200 });
  }
  /* MATCHED EXACTLY. `/2/files/upload_session/start`.includes('/2/files/upload')
     is true, so a loose match here swallows every session call and the plain
     upload branch answers all three steps. */
  if (u.endsWith('/2/files/upload')) {
    const a = arg();
    const body = init.body;
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body)
      : ArrayBuffer.isView(body) ? new Uint8Array(body.buffer) : new Uint8Array(0);
    DBX.files.set(a.path, bytes);
    return new Response(JSON.stringify({ path_display: a.path, path_lower: a.path.toLowerCase(),
      rev: 'r' + DBX.files.size, size: bytes.length }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('/2/files/download')) {
    const f = DBX.files.get(arg().path);
    return f ? new Response(f, { status: 200 }) : new Response('not_found', { status: 409 });
  }
  if (u.includes('/2/files/delete_v2')) {
    return new Response('{}', { status: DBX.files.delete(JSON.parse(init.body).path) ? 200 : 409 });
  }
  return new Response('{}', { status: 200 });
};

const r2store = new Map();
const env = {
  DB: d1(db),
  SITE_ORIGIN: '',              // filled in once the port is known
  INGEST_KEY: 'e2e-ingest-key',
  BOOTSTRAP_TOKEN: 'e2e-bootstrap',
  PBKDF2_ITER: '10000',
  INGEST_PER_MINUTE: '500',
  /* A connected Dropbox is the default state of the portal now, the same way
     it is the default state of production — a case cannot take a photograph
     without one. */
  DROPBOX_APP_KEY: 'e2e-app-key',
  DROPBOX_APP_SECRET: 'e2e-app-secret',
  DROPBOX_REFRESH_TOKEN: 'e2e-refresh',
  EVIDENCE: {                    // the R2 stand-in — bytes in, bytes out
    async put(key, body, opts) { r2store.set(key, { body, opts }); },
    async get(key) { const o = r2store.get(key); return o ? { body: o.body } : null; },
    async delete(key) { r2store.delete(key); },
  },
};

// ONE server serves the page and mounts the Worker at /portal-api/*, because
// that is how it is deployed. Serving the API from a second origin would let a
// cross-site cookie bug pass unnoticed — which is exactly what it did before.
/* Read once, from the file Cloudflare Pages actually applies. */
const PORTAL_CSP = ((fs.readFileSync(path.join(ROOT, '_headers'), 'utf8')
  .split('/portal/*')[1] || '').split('\n')
  .find(l => l.includes('Content-Security-Policy')) || '')
  .replace(/^\s*Content-Security-Policy:\s*/, '').trim();

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml',
                '.webp': 'image/webp', '.png': 'image/png',
                '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/portal-api')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const out = await worker.fetch(request, env);
    const headers = {};
    const cookies = out.headers.getSetCookie ? out.headers.getSetCookie() : [];
    for (const [k, v] of out.headers) if (k.toLowerCase() !== 'set-cookie') headers[k] = v;
    if (cookies.length) {
      // The browser will not keep a Secure cookie over plain http on a
      // non-localhost host, and 127.0.0.1 counts as a secure context, so this
      // only drops the flag that the transport cannot satisfy locally.
      headers['set-cookie'] = cookies.map(c => c.replace(/;\s*Secure/i, ''));
    }
    res.writeHead(out.status, headers);
    return res.end(Buffer.from(await out.arrayBuffer()));
  }
  let p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  /* THE REAL CSP, off the real `_headers`, on every /portal/ response.
     This suite ran for months against a page with NO Content-Security-Policy at
     all, because `_headers` is applied by Cloudflare Pages and nothing here read
     it. That is a whole class of failure the tests could not see, and it cost a
     live one: `img-src` did not allow `blob:`, so Timestamp Photo's <img> was
     BLOCKED on the phone and passed in every test. Serving the real policy is
     the only way this suite can be evidence about the deployed page. */
  const head = { 'Content-Type': TYPES[path.extname(p)] || 'text/plain' };
  if (req.url.startsWith('/portal/')) head['Content-Security-Policy'] = PORTAL_CSP;
  res.writeHead(200, head);
  res.end(fs.readFileSync(p));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${server.address().port}`;
env.SITE_ORIGIN = SITE;
const API = SITE + '/portal-api';

/* ------------------------------------------------------------- seed data */

async function post(p, body, headers = {}) {
  return worker.fetch(new Request(API + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: SITE, ...headers },
    body: JSON.stringify(body),
  }), env);
}
await post('/setup', { username: 'trever', display_name: 'Trever Brown', password: 'AdminPassword1x' },
  { 'X-Bootstrap-Token': 'e2e-bootstrap' });
await post('/ingest', {
  case_no: 'API-20260812-4001', service: 'Insurance Claim Assignment',
  carrier: 'Example Mutual Insurance', claim_number: 'WC-2026-88421', policy_number: 'POL-77123',
  claim_type: "Workers' compensation", date_of_loss: '03/14/2026',
  adjuster: 'Dana Reyes', adjuster_email: 'dreyes@examplemutual.com',
  client_name: 'Dana Reyes', subject_name: 'Pat Coleman',
  subject_relationship: 'Lumbar strain; no lifting over 10 lbs',
  objective: 'Activity level versus stated restrictions', timeline: 'Hearing 9/12',
  signed_name: 'Dana Reyes', payment_method: 'Invoiced to carrier', fee_due: 0,
}, { 'X-Ingest-Key': 'e2e-ingest-key' });
await post('/ingest', {
  case_no: 'API-20260812-4002', service: 'Surveillance',
  client_name: 'Jane Client', client_phone: '4345550111',
  subject_name: 'John Subject', subject_relationship: 'spouse',
  objective: 'Establish whereabouts', fee_due: 1500, payment_method: 'venmo',
}, { 'X-Ingest-Key': 'e2e-ingest-key' });

/* --------------------------------------------------------------- browser */

const launch = {};
const bundled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (fs.existsSync(bundled)) launch.executablePath = bundled;
const browser = await chromium.launch(launch);

async function newPage() {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(250);
  return page;
}
const text = (page, sel) => page.locator(sel).first().innerText();
// innerText returns *rendered* text and .tag is text-transform:uppercase, so
// every comparison against a tag has to be case-insensitive.
const has = (haystack, needle) => haystack.toLowerCase().includes(needle.toLowerCase());
// The list is newest-first, so never address a row by position.
const rowFor = (page, caseNo) => page.locator('tbody tr', { hasText: caseNo }).first();
/* A FIXTURE ENTRY MUST BE STAMPED EARLIER IN THE DAY THAN ANYTHING A LATER
   SECTION FILES WITH THE REAL CLOCK. The timeline orders by at_time, and later
   sections stamp with `stampNow()`, so a fixture typed at a fixed hour sits on
   top of them whenever the suite happens to run before that hour.

   That is exactly what bit: fixtures at 09:41 and 10:05 sorted below a real
   entry on every run until one started at 01:00, and then nine voice assertions
   read the wrong row and the field-home edit hit "that entry belongs to another
   investigator" — because it genuinely did. Measured at the failure:

     id  6  10:05  Trever Brown   "Subject returned to residence and entered…"
     id 11  01:00  Dana Field     "No change observed at the residence."  (voice)

   Nothing about the product was wrong: 10:05 IS later in the day than 01:00.
   Clamped at 00:00 so a run a minute after midnight cannot roll into yesterday
   and land back on top; a tie then falls to `id DESC`, which is the real
   creation order. */
const earlierToday = (mins) => {
  const d = new Date();
  const m = Math.max(0, d.getHours() * 60 + d.getMinutes() - mins);
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
};
// The case dialog is a workspace with tabs; most detail is no longer on the
// first panel, so a test that wants a panel has to open it. Panels live
// inside four sections now (UIBUILD P6) — when the wanted sub-tab is not in
// the visible row, walk the section bar until it shows, the way a person
// hunting for it would.
async function wsTab(page, name) {
  const tab = () => page.locator('.wstabs button', { hasText: name });
  if (!(await tab().count())) {
    for (const sec of await page.locator('.wsecs button').all()) {
      await sec.click();
      await page.waitForTimeout(180);
      if (await tab().count()) break;
    }
  }
  await tab().click();
  await page.waitForTimeout(200);
}
// The activity form lives in the Add Activity sheet (UIBUILD P8); the free
// composer is its Custom tab.
async function openComposer(page) {
  await page.locator('[data-act="actOpen"]').click();
  await page.waitForTimeout(250);
  await page.locator('.amtab', { hasText: 'Custom' }).click();
  await page.waitForTimeout(250);
}
async function signIn(page, u, p) {
  await page.locator('#u').fill(u);
  await page.locator('#p').fill(p);
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(500);
  // Admins land on the Dashboard now; the suite's sections start from Cases.
  const cases = page.locator('.tabs button', { hasText: 'Cases' });
  if (await cases.count()) { await cases.first().click(); await page.waitForTimeout(400); }
}

/* ------------------------------------------------------------------ tests */


section('Sign-in');
{
  const page = await newPage();
  ok('the portal opens on a sign-in form', (await text(page, 'h1')) === 'Case Portal');
  ok('no case data is visible before signing in', !(await page.content()).includes('WC-2026-88421'));

  await signIn(page, 'trever', 'WrongPassword9');
  ok('bad credentials show an error', (await text(page, '#err')).length > 0);
  ok('bad credentials do not sign you in', await page.locator('#loginBtn').count() === 1);

  await signIn(page, 'trever', 'AdminPassword1x');
  ok('good credentials sign in', await page.locator('.tabs').count() === 1);
  ok('the header shows who is signed in', (await text(page, '#who')).includes('Trever Brown'));
  await page.close();
}

section('Assignment');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Staff' }).click();
  await page.waitForTimeout(250);
  await page.locator('#nv_name').fill('Dana Field');
  await page.locator('#nv_user').fill('dana');
  await page.locator('.btn', { hasText: 'Create invitation' }).click();
  await page.waitForTimeout(600);
  const linkText = await text(page, '.linkbox');
  ok('inviting produces a one-time link', linkText.includes('/portal/?invite='));
  ok('the admin is told the link is shown once', has(linkText, 'not shown again'));
  const inviteUrl = (linkText.match(/http\S*\/portal\/\?invite=[0-9a-f]{64}/) || [''])[0];

  // The invitee sets their own password; the admin never sees it.
  const invitee = await (await browser.newContext()).newPage();
  await invitee.goto(inviteUrl);
  await invitee.waitForTimeout(400);
  ok('the invitation link opens a set-your-password page',
     (await invitee.locator('h1').first().innerText()) === 'Set your password');
  await invitee.locator('#p1').fill('FieldWork2026x');
  await invitee.locator('#p2').fill('Mismatch2026x');
  await invitee.locator('#acceptBtn').click();
  await invitee.waitForTimeout(300);
  ok('mismatched passwords are refused', (await invitee.locator('#err').innerText()).length > 0);
  await invitee.locator('#p2').fill('FieldWork2026x');
  await invitee.locator('#acceptBtn').click();
  await invitee.waitForTimeout(700);
  ok('accepting signs the investigator straight in', await invitee.locator('.tabs').count() === 1);
  ok('the invite token is cleared from the address bar', !invitee.url().includes('invite='));
  await invitee.close();

  await page.reload();
  await page.waitForTimeout(600);
  await page.locator('.tabs button', { hasText: 'Staff' }).click();
  await page.waitForTimeout(300);
  ok('the new investigator appears in staff', (await text(page, '.card')).includes('Dana Field'));

  await page.locator('.tabs button', { hasText: 'Cases' }).click();
  await page.waitForTimeout(250);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(400);
  await wsTab(page, 'Assignment');
  await page.locator('#asg').selectOption({ label: 'Dana Field' });
  await page.locator('#sts').selectOption('in_progress');
  await page.locator('.btn', { hasText: 'Save' }).click();
  await page.waitForTimeout(600);
  const after = await text(page, '.card');
  ok('the case shows as assigned in the list', after.includes('Dana Field'));
  ok('the status change is reflected', has(after, 'In progress'));
  await page.close();
}

section('Daily summary: deterministic sentences over the day\'s own facts');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);

  /* THE ENGINE FIRST, as pure functions: every grammar case the brief names,
     asserted on the exact words. No fixture needed — this is arithmetic. */
  const eng = await page.evaluate(() => ({
    weekday: dsWeekday('2026-08-20'),
    heading: dsHeading('2026-08-22'),
    mdy: dsMDY('2026-08-20'),
    full: dsVehiclesSentence([{ year: '2022', make: 'Chevrolet', model: 'Silverado',
      color: '', plate: 'ABC-1234', plate_state: 'VA', registered_owner: 'John Smith' }], 'in the driveway'),
    two: dsVehiclesSentence([
      { year: '2022', make: 'Chevrolet', model: 'Silverado', plate: 'ABC-1234', plate_state: 'VA', registered_owner: 'John Smith' },
      { year: '2020', make: 'Toyota', model: 'Camry', plate: 'XYZ-5678', plate_state: 'VA', registered_owner: 'Jane Smith' },
    ], 'in the driveway'),
    noYear: dsVehiclesSentence([{ make: 'Toyota', model: 'Camry', color: 'gray' }], 'on the street'),
    noOwner: dsVehiclesSentence([{ year: '2019', make: 'Ford', model: 'F-150', plate: 'K99', plate_state: 'VA' }], 'at the residence'),
    an: dsVehiclesSentence([{ make: 'Acura', model: 'TL' }], 'in the driveway'),
    none: dsVehiclesSentence([], 'in the driveway'),
  }));
  ok('08-20-2026 is a Thursday, on every machine', eng.weekday === 'Thursday', eng.weekday);
  ok('the day heading reads like a report', eng.heading === 'SATURDAY, AUGUST 22, 2026', eng.heading);
  ok('and the inline date is month-day-year', eng.mdy === '08-20-2026', eng.mdy);
  ok('one vehicle reads exactly as the office would write it',
     eng.full === 'A 2022 Chevrolet Silverado bearing Virginia registration ABC-1234 was observed '
       + 'in the driveway. The vehicle was recorded as registered to John Smith.', eng.full);
  ok('two vehicles read as a list with their owners inline',
     eng.two === 'Two vehicles were observed in the driveway: a 2022 Chevrolet Silverado bearing '
       + 'Virginia registration ABC-1234, registered to John Smith, and a 2020 Toyota Camry bearing '
       + 'Virginia registration XYZ-5678, registered to Jane Smith.', eng.two);
  ok('a missing year prints no blank year', eng.noYear === 'A gray Toyota Camry was observed on the street.', eng.noYear);
  ok('a missing owner prints NO owner clause — never "registered to unknown"',
     !/unknown/i.test(eng.noOwner) && !/registered to/.test(eng.noOwner), eng.noOwner);
  ok('the article bends to the word', eng.an.startsWith('An Acura'), eng.an);
  ok('no vehicles is silence, never an invented absence', eng.none === '');

  /* NOW THE BUILDER, on a real day with real vehicles. */
  await page.evaluate(async no => {
    const post = (p2, b2) => fetch('/portal-api' + p2, { method: 'POST',
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b2 || {}) }).then(r => r.json());
    const sj = await post(`/cases/${no}/subjects`, { name: 'Walter Mott',
      addresses: '41 Cedar Ln, Roanoke VA' });
    await post(`/cases/${no}/subjects/${sj.id}/vehicles`, { year: '2022', make: 'Chevrolet',
      model: 'Silverado', color: 'White', plate: 'ABC-1234', plate_state: 'VA',
      registered_owner: 'John Smith' });
    await post(`/cases/${no}/day/start`, { day_date: '2026-08-20', start_time: '08:03' });
    for (const [t, d] of [['09:14', 'Subject departed residence in white pickup.'],
                          ['11:42', 'Subject returned to residence.']]) {
      await post(`/cases/${no}/activity`, { at_date: '2026-08-20', at_time: t, description: d });
    }
    await post(`/cases/${no}/day/end`, { end_time: '12:15' });
    const ws = await (await fetch(`/portal-api/cases/${no}/workspace`,
      { credentials: 'same-origin' })).json();
    const day = (ws.days || []).find(d => d.day_date === '2026-08-20');
    await post(`/cases/${no}/reports/generate`, { day_id: day.id });
  }, 'API-20260812-4001');
  await page.reload();
  await page.waitForTimeout(700);
  { const cbtn = page.locator('.tabs button', { hasText: 'Cases' });
    if (await cbtn.count()) { await cbtn.first().click(); await page.waitForTimeout(400); } }
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  await wsTab(page, 'Reports');
  await page.waitForTimeout(400);
  await page.locator('.rcard', { hasText: '2026-08-20' }).first().click();
  await page.waitForTimeout(400);
  await page.locator('.rpnav button', { hasText: 'Daily summary' }).click();
  await page.waitForTimeout(400);

  ok('the builder opens on the day, named like a report heading',
     has(await text(page, '.dsb-wrap'), 'THURSDAY, AUGUST 20, 2026'));
  const para0 = await page.locator('#ds_text').inputValue();
  ok('the opening prefilled from the day and the case',
     has(para0, 'On Thursday, 08-20-2026, surveillance was initiated at 8:03 AM'), para0);
  ok('the subject\'s address seeded the location',
     has(para0, "41 Cedar Ln"), para0);
  ok('and the builder SAYS where its suggestions came from',
     has(await text(page, '.dsb-wrap'), 'FROM DAY') && has(await text(page, '.dsb-wrap'), 'FROM CASE'));

  /* Pick the vehicle and both moments; the paragraph rebuilds live. */
  await page.locator('[id^="ds_veh_"]').first().check();
  await page.waitForTimeout(300);
  const moments = page.locator('[id^="ds_act_"]');
  await moments.nth(0).check(); await page.waitForTimeout(250);
  await moments.nth(1).check(); await page.waitForTimeout(250);
  let para = await page.locator('#ds_text').inputValue();
  ok('the chosen vehicle writes its sentence',
     has(para, 'A 2022 white Chevrolet Silverado bearing Virginia registration ABC-1234 was observed in the driveway.'), para);
  ok('a chosen moment arrives as written, timed in words',
     has(para, 'At 9:14 AM, subject departed residence in white pickup.'), para);
  ok('the moments land in the day\'s order',
     para.indexOf('9:14 AM') < para.indexOf('11:42 AM'), para);

  /* Turn the second moment into the deterministic return sentence. */
  const secondId = await moments.nth(1).getAttribute('id');
  await page.locator('#ds_mode_' + secondId.replace('ds_act_', '')).selectOption('return');
  await page.waitForTimeout(250);
  para = await page.locator('#ds_text').inputValue();
  ok('a template mode rewrites just that sentence',
     has(para, 'At 11:42 AM, the subject returned to the residence.'), para);

  /* Exclude the first moment — its sentence leaves, nothing else moves. */
  await moments.nth(0).uncheck();
  await page.waitForTimeout(250);
  para = await page.locator('#ds_text').inputValue();
  ok('an excluded moment leaves the paragraph',
     !has(para, '9:14 AM') && has(para, '11:42 AM'), para);

  /* Close the day with a stated reason and save. */
  await page.locator('#ds_reason').selectOption('returned');
  await page.waitForTimeout(250);
  await page.locator('[data-act="dsSave"]').click();
  await page.waitForTimeout(600);
  ok('the summary saves and says so', has(await text(page, '.dsb-wrap'), 'Saved'));

  /* THE LOG IS UNTOUCHED — the builder narrates it, never edits it. */
  const log = await page.evaluate(async no => {
    const ws = await (await fetch(`/portal-api/cases/${no}/workspace`,
      { credentials: 'same-origin' })).json();
    return ws.activity.filter(a => a.at_date === '2026-08-20')
      .map(a => [a.at_time, a.description]);
  }, 'API-20260812-4001');
  ok('every activity entry still reads exactly as logged',
     JSON.stringify(log.sort()) === JSON.stringify([['09:14', 'Subject departed residence in white pickup.'],
                                                    ['11:42', 'Subject returned to residence.']].sort()), JSON.stringify(log));
}

section('Daily summary: the writer\'s words survive everything but a deliberate rebuild');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  await wsTab(page, 'Reports');
  await page.waitForTimeout(400);
  await page.locator('.rcard', { hasText: '2026-08-20' }).first().click();
  await page.waitForTimeout(400);
  await page.locator('.rpnav button', { hasText: 'Daily summary' }).click();
  await page.waitForTimeout(400);

  /* Type into the paragraph: it becomes the writer's. */
  await page.locator('#ds_text').click();
  await page.locator('#ds_text').press('End');
  await page.locator('#ds_text').type(' Hand-written closing thought.');
  await page.waitForTimeout(200);
  /* A control change now repaints — and must NOT touch the words. */
  await page.locator('#ds_gap').selectOption('before_end');
  await page.waitForTimeout(350);
  let para = await page.locator('#ds_text').inputValue();
  ok('a control change no longer rewrites a claimed paragraph',
     has(para, 'Hand-written closing thought.'), para);
  ok('and the screen says the wording is protected',
     has(await text(page, '.dsb-wrap'), 'protected'));

  /* Walk away and come back: tab, then a full repaint. */
  await page.locator('.rpnav button', { hasText: 'Chronology' }).click();
  await page.waitForTimeout(300);
  await page.locator('.rpnav button', { hasText: 'Daily summary' }).click();
  await page.waitForTimeout(300);
  para = await page.locator('#ds_text').inputValue();
  ok('leaving the tab and returning keeps the words', has(para, 'Hand-written closing thought.'), para);
  await page.evaluate(() => paint());
  await page.waitForTimeout(300);
  para = await page.locator('#ds_text').inputValue();
  ok('a page repaint keeps them too', has(para, 'Hand-written closing thought.'), para);

  /* Rebuild asks first; declined, nothing changes. */
  page.once('dialog', d => d.dismiss());
  await page.locator('[data-act="dsRebuild"]').click();
  await page.waitForTimeout(300);
  para = await page.locator('#ds_text').inputValue();
  ok('Rebuild asks, and No means no', has(para, 'Hand-written closing thought.'), para);
  page.once('dialog', d => d.accept());
  await page.locator('[data-act="dsRebuild"]').click();
  await page.waitForTimeout(300);
  para = await page.locator('#ds_text').inputValue();
  ok('Yes rebuilds from the selections', !has(para, 'Hand-written closing thought.')
     && has(para, 'surveillance was initiated'), para);

  /* A SECOND DAY STARTS CLEAN — nothing crossed over. */
  await page.evaluate(async no => {
    const post = (p2, b2) => fetch('/portal-api' + p2, { method: 'POST',
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b2 || {}) }).then(r => r.json());
    await post(`/cases/${no}/day/start`, { day_date: '2026-08-21', start_time: '07:30' });
    await post(`/cases/${no}/activity`, { at_date: '2026-08-21', at_time: '08:05',
      description: 'No activity observed at the residence.' });
    await post(`/cases/${no}/day/end`, { end_time: '10:00' });
    const ws = await (await fetch(`/portal-api/cases/${no}/workspace`,
      { credentials: 'same-origin' })).json();
    const day = (ws.days || []).find(d => d.day_date === '2026-08-21');
    await post(`/cases/${no}/reports/generate`, { day_id: day.id });
  }, 'API-20260812-4001');
  await page.reload();
  await page.waitForTimeout(700);
  { const cbtn = page.locator('.tabs button', { hasText: 'Cases' });
    if (await cbtn.count()) { await cbtn.first().click(); await page.waitForTimeout(400); } }
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  await wsTab(page, 'Reports');
  await page.waitForTimeout(400);
  await page.locator('.rcard', { hasText: '2026-08-21' }).first().click();
  await page.waitForTimeout(400);
  await page.locator('.rpnav button', { hasText: 'Daily summary' }).click();
  await page.waitForTimeout(400);
  para = await page.locator('#ds_text').inputValue();
  ok('Friday does not inherit Thursday\'s vehicles or moments',
     has(para, 'On Friday, 08-21-2026') && !has(para, 'Silverado') && !has(para, '11:42'), para);
  ok('and no moment arrives pre-selected on a fresh day',
     await page.locator('[id^="ds_act_"]:checked').count() === 0);
}

section('Daily summary: the narrative rides the documents, clean of builder scaffolding');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);

  /* Approve the day's report and re-save a known paragraph to carry. */
  await page.evaluate(async no => {
    const post = (p2, b2) => fetch('/portal-api' + p2, { method: 'POST',
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b2 || {}) }).then(r => r.json());
    const ws = await (await fetch(`/portal-api/cases/${no}/workspace`,
      { credentials: 'same-origin' })).json();
    const day = (ws.days || []).find(d => d.day_date === '2026-08-20');
    const rep = (ws.reports || []).find(r => r.day_id === day.id);
    await post(`/cases/${no}/reports/${rep.id}/status`, { status: 'approved' });
    await post(`/cases/${no}/days/${day.id}/summary`, {
      narrative: 'On Thursday, 08-20-2026, surveillance was initiated at 8:03 AM at the subject’s '
        + 'residence at 41 Cedar Ln, Roanoke VA. At 11:42 AM, the subject returned to the residence. '
        + 'Surveillance was concluded at 12:15 PM after the subject returned to the residence and no '
        + 'additional activity was observed.' });
  }, 'API-20260812-4001');
  await page.reload();
  await page.waitForTimeout(700);
  { const cbtn = page.locator('.tabs button', { hasText: 'Cases' });
    if (await cbtn.count()) { await cbtn.first().click(); await page.waitForTimeout(400); } }
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);

  /* The report's own draft document leads with it. */
  await wsTab(page, 'Reports');
  await page.waitForTimeout(400);
  await page.locator('.rcard', { hasText: '2026-08-20' }).first().click();
  await page.waitForTimeout(400);
  const rep = await page.locator('#repdoc').innerText();
  ok('the day\'s document leads with the authored paragraph',
     has(rep, 'surveillance was initiated at 8:03 AM'), rep.slice(0, 200));
  ok('prose before chronology — the paragraph sits above the body',
     rep.indexOf('surveillance was initiated at 8:03 AM') < rep.indexOf('CHRONOLOG')
       || !has(rep, 'CHRONOLOG'));

  /* And the client package prints it under the day heading. */
  await wsTab(page, 'Package');
  await page.waitForTimeout(700);
  if (await page.locator('[data-act="pkgStart"]').count()) {
    await page.locator('[data-act="pkgStart"]').click();
    await page.waitForTimeout(900);
  }
  const offer = page.locator('.btn', { hasText: 'Add to package' });
  while (await offer.count()) { await offer.first().click(); await page.waitForTimeout(700); }
  const doc = await page.locator('#pkgdoc').innerText();
  ok('the package document carries the day\'s paragraph',
     has(doc, 'surveillance was initiated at 8:03 AM'), doc.slice(0, 300));
  ok('ahead of that day\'s detailed body', 
     doc.indexOf('surveillance was initiated at 8:03 AM') < doc.indexOf('INVESTIGATION NOTES')
       || !has(doc, 'INVESTIGATION NOTES'));
  /* THE DOCUMENT IS CLEAN: no builder scaffolding of any kind. */
  for (const tokenWord of ['FROM DAY', 'FROM CASE', 'FROM ACTIVITY', '[VEHICLE]', '[TIME]']) {
    ok(`the document never says "${tokenWord}"`, !has(doc, tokenWord));
  }
  ok('and no dropdown or checkbox lives inside the printed region',
     await page.locator('#pkgdoc select, #pkgdoc input, #pkgdoc textarea').count() === 0);
  ok('the report document is equally clean',
     await page.locator('#repdoc select, #repdoc input, #repdoc textarea').count() === 0);

  /* EVERY TEMPLATE CARRIES IT. The paragraph rides the day section, and all
     six styles include one — the template decides labels and order, never
     whether the day's narrative exists. */
  for (const tid of ['surveillance', 'legal', 'general']) {
    await page.evaluate(async id => {
      const st = await (await fetch(`/portal-api/cases/API-20260812-4001/build`,
        { credentials: 'same-origin' })).json();
      await fetch(`/portal-api/build/${st.build.id}/template`, { method: 'POST',
        credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: id }) });
    }, tid);
    await wsTab(page, 'Package');
    await page.waitForTimeout(600);
    ok(`the ${tid} style prints the day's paragraph too`,
       has(await page.locator('#pkgdoc').innerText(), 'surveillance was initiated at 8:03 AM'));
  }
}

section('Daily summary: the field writes its own day and nothing more');
{
  await post('/ingest', {
    case_no: 'API-DSFIELD-1', service: 'Surveillance',
    client_name: 'Field Client', subject_name: 'Field Subject',
    objective: 'Document daily activity',
  }, { 'X-Ingest-Key': 'e2e-ingest-key' });
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  /* Give dana a case with a worked day. */
  await page.evaluate(async () => {
    const post = (p2, b2) => fetch('/portal-api' + p2, { method: 'POST',
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b2 || {}) }).then(r => r.json());
    const users = await (await fetch('/portal-api/users', { credentials: 'same-origin' })).json();
    const dana = users.users.find(u => u.username === 'dana');
    await post('/submissions/API-DSFIELD-1/assign', { user_id: dana.id });
  });
  const inv = await newPage();
  await signIn(inv, 'dana', 'FieldWork2026x');
  await rowFor(inv, 'API-DSFIELD-1').click();
  await inv.waitForTimeout(500);
  await inv.evaluate(async no => {
    const post = (p2, b2) => fetch('/portal-api' + p2, { method: 'POST',
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b2 || {}) }).then(r => r.json());
    await post(`/cases/${no}/day/start`, { day_date: '2026-08-20', start_time: '06:45' });
    await post(`/cases/${no}/activity`, { at_date: '2026-08-20', at_time: '07:20',
      description: 'Subject departed in gray sedan.' });
    await post(`/cases/${no}/day/end`, { end_time: '14:30' });
    const ws = await (await fetch(`/portal-api/cases/${no}/workspace`,
      { credentials: 'same-origin' })).json();
    await post(`/cases/${no}/reports/generate`, { day_id: ws.days[0].id });
  }, 'API-DSFIELD-1');
  await inv.reload();
  await inv.waitForTimeout(700);
  { const cbtn = inv.locator('.tabs button', { hasText: 'Cases' });
    if (await cbtn.count()) { await cbtn.first().click(); await inv.waitForTimeout(400); } }
  await rowFor(inv, 'API-DSFIELD-1').click();
  await inv.waitForTimeout(500);
  await wsTab(inv, 'Reports');
  await inv.waitForTimeout(400);
  await inv.locator('.rcard').first().click();
  await inv.waitForTimeout(400);
  await inv.locator('.rpnav button', { hasText: 'Daily summary' }).click();
  await inv.waitForTimeout(400);
  ok('the investigator has the builder on their own day',
     await inv.locator('#ds_text').count() === 1);
  await inv.locator('[data-act="dsSave"]').click();
  await inv.waitForTimeout(500);
  ok('and their save lands', has(await text(inv, '.dsb-wrap'), 'Saved'));

  /* Submitted, the day is with the office: the builder goes read-only. */
  await inv.evaluate(async no => {
    const post = (p2, b2) => fetch('/portal-api' + p2, { method: 'POST',
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b2 || {}) }).then(r => r.json());
    const ws = await (await fetch(`/portal-api/cases/${no}/workspace`,
      { credentials: 'same-origin' })).json();
    await post(`/cases/${no}/reports/${ws.reports[0].id}/status`, { status: 'submitted' });
  }, 'API-DSFIELD-1');
  await inv.reload();
  await inv.waitForTimeout(700);
  { const cbtn = inv.locator('.tabs button', { hasText: 'Cases' });
    if (await cbtn.count()) { await cbtn.first().click(); await inv.waitForTimeout(400); } }
  await rowFor(inv, 'API-DSFIELD-1').click();
  await inv.waitForTimeout(500);
  await wsTab(inv, 'Reports');
  await inv.waitForTimeout(400);
  await inv.locator('.rcard').first().click();
  await inv.waitForTimeout(400);
  await inv.locator('.rpnav button', { hasText: 'Daily summary' }).click();
  await inv.waitForTimeout(400);
  ok('with the report submitted, the summary is read-only for its writer',
     await inv.locator('#ds_text[disabled]').count() === 1
       && await inv.locator('[data-act="dsSave"]').count() === 0);
  ok('and the screen says why', has(await text(inv, '.dsb-wrap'), 'with the office'));
  /* The Worker is the boundary, not the page. */
  const denied = await inv.evaluate(async no => {
    const ws = await (await fetch(`/portal-api/cases/${no}/workspace`,
      { credentials: 'same-origin' })).json();
    const r = await fetch(`/portal-api/cases/${no}/days/${ws.days[0].id}/summary`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ narrative: 'around the review' }) });
    return r.status;
  }, 'API-DSFIELD-1');
  ok('the Worker refuses the write regardless of the page', denied === 409, String(denied));
  await inv.close();
}

section('Daily summary on a phone: one column, honest targets, nothing sideways');
{
  /* NAVIGATE THE WAY A PERSON ON A PHONE DOES — under 900px the rail is a
     drawer behind the burger, the same lesson the timeline's phone section
     already carries. */
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(1400);
  const burger = page.locator('.burger');
  if (await burger.isVisible()) { await burger.click(); await page.waitForTimeout(300); }
  await page.locator('.side button, .tabs button', { hasText: 'Cases' }).first().click();
  await page.waitForTimeout(600);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  await wsTab(page, 'Reports');
  await page.waitForTimeout(400);
  await page.locator('.rcard', { hasText: '2026-08-20' }).first().click();
  await page.waitForTimeout(400);
  await page.locator('.rpnav button', { hasText: 'Daily summary' }).click();
  await page.waitForTimeout(500);

  const over = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('no horizontal overflow at 390px', over <= 0, String(over));
  const ta = await page.evaluate(() => {
    const el = document.getElementById('ds_text');
    return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
  });
  ok('the paragraph edits at 16px — iOS must not zoom', ta >= 16, String(ta));
  const grid = await page.evaluate(() => {
    const g = document.querySelector('.dsb-grid');
    return g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : 0;
  });
  ok('the builder grid stacks to one column', grid === 1, String(grid));
  const box = await page.locator('[id^="ds_act_"]').first().boundingBox();
  ok('a moment\'s checkbox is a thumb target', !!box && box.height >= 18 && box.width >= 18,
     JSON.stringify(box));
  const save = await page.locator('[data-act="dsSave"]').boundingBox();
  ok('Save meets the 44px floor', !!save && save.height >= 44, JSON.stringify(save));
  const wrap = await page.evaluate(() => {
    const w = document.querySelector('.dsb-wrap');
    const p = document.querySelector('.wspanel .quick') || w.parentElement;
    return { w: w.getBoundingClientRect().width, p: p.getBoundingClientRect().width };
  });
  ok('the builder fills its panel and no more', wrap.w <= wrap.p + 1,
     JSON.stringify(wrap));
}


await browser.close();
server.close();
console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
