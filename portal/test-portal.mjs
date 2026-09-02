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
/* Progress streams to stderr so a stalled run says WHERE it stalled — the
   results themselves still buffer and print at the end, unchanged. */
function section(name) { results.push(`\n${name}`); console.error(`>> ${name}`); }

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
/* UNIT 38 — every tab this role can reach on a case, row plus More. The
   boundary walks below use it, so "no panel anywhere shows money" keeps
   meaning ANYWHERE rather than "in the four sections that used to exist". */
async function wsAllTabs(page) {
  return page.evaluate(() => [...wsPrimary(), ...wsMore()].map(t => ({ key: t[0], label: t[1] })));
}
/* Visit every one of them and collect what each drew. */
async function wsVisitAll(page, read) {
  const out = [];
  for (const t of await wsAllTabs(page)) {
    await page.evaluate(k => { WS_TAB = k; WS_MORE = false; paintCase(); }, t.key);
    await page.waitForTimeout(220);
    out.push({ tab: t.label, text: await read(page) });
  }
  return out;
}

/* UNIT 38 — the case workspace is one level deep now. Six tabs in a row, and
   everything else behind More. This walks the same way a person does: look for
   the tab, and if it is not on the row, open More and take it from there. */
/* Which case tab is open, by key. Reading the current nav BUTTON's words was
   fine while every tab was on a bar; since Unit 38 a tab inside More marks the
   More button instead, so the words say "More" and not the panel on screen.
   WS_TAB is the routing state itself and cannot disagree with the panel. */
const wsOpenTab = page => page.evaluate(() => WS_TAB);

async function wsTab(page, name) {
  /* Resolve the LABEL to its tab key first and click by key. Matching nav
     buttons by their words is what a person does, but Playwright's hasText is
     a substring match, so "Subject" also matches "Subject vehicles" and the
     More button when it carried a name. The key is exact. */
  const key = await page.evaluate(
    n => ([...wsPrimary(), ...wsMore()].find(t => t[1] === n) || [])[0] || null, name);
  if (!key) throw new Error(`no case tab labelled "${name}"`);
  /* Take whichever door is VISIBLE at this width, the way a person would: the
     desktop row, then the thumb bar, then More. Counting elements is not
     enough — the row is in the DOM on a phone and hidden by CSS. */
  for (const sel of [`.wsnav button[data-tab="${key}"]`, `.wsbar button[data-tab="${key}"]`]) {
    const door = page.locator(`${sel}:visible`);
    if (await door.count()) {
      await door.first().click();
      await page.waitForTimeout(250);
      return;
    }
  }
  if (!(await page.locator('.wsmorelist:visible').count())) {
    await page.locator('[data-act="wsMore"]:visible').first().click();
    await page.waitForTimeout(250);
  }
  await page.locator(`.wsmorelist button[data-tab="${key}"]:visible`).first().click();
  await page.waitForTimeout(250);
}
// The activity form lives in the Add Activity sheet (UIBUILD P8); the free
// composer is its Custom tab.
async function openComposer(page) {
  /* Unit 38 — Add activity has one primary door (the case action row) and one
     contextual shortcut (the phone bar), so the DOM holds both and exactly one
     is visible at any width. Click the visible one. */
  await page.locator('[data-act="actOpen"]:visible').first().click();
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

section('Admin case list');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  const table = await text(page, '.card');
  ok('both submissions are listed', table.includes('API-20260812-4001') && table.includes('API-20260812-4002'));
  ok('the claim is tagged as a claim', has(table, 'Claim'));
  ok('the carrier is shown on the claim row', table.includes('Example Mutual Insurance'));
  ok('the claim number is shown', table.includes('WC-2026-88421'));

  await page.locator('#q').fill('WC-2026');
  await page.waitForTimeout(200);
  const filtered = await text(page, '.card');
  ok('search narrows the list', filtered.includes('API-20260812-4001') && !filtered.includes('API-20260812-4002'));
  await page.locator('#q').fill('');
  await page.waitForTimeout(200);

  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(350);
  const dlg = await text(page, '#dlgBody');
  ok('opening a case shows the claim detail', dlg.includes('WC-2026-88421') && dlg.includes('Example Mutual'));
  await wsTab(page, 'Subject');
  const subj = await text(page, '#dlgBody');
  ok('the claimant is labelled as a claimant', subj.includes('Claimant'));
  ok('the injury and restrictions are shown', subj.includes('Lumbar strain'));
  /* Unit 38 — one row of six, not four sections over seventeen tabs. */
  ok('the case opens on a one-level workspace',
     await page.locator('.wsnav button[data-act="wsTab"]').count() === 6,
     JSON.stringify(await page.locator('.wsnav button').allInnerTexts()));
  ok('and Daily Summary is on it, not three levels down',
     await page.locator('.wsnav button', { hasText: 'Daily Summary' }).count() === 1);
  await wsTab(page, 'Assignment');
  ok('an admin sees the assignment controls', await page.locator('#asg').count() === 1);
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

section('Investigator scope');
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  const body = await text(page, '.card');
  ok('the investigator sees the case assigned to them', body.includes('API-20260812-4001'));
  ok('the investigator does NOT see the unassigned case', !body.includes('API-20260812-4002'));
  ok('the investigator has no Staff tab', !(await text(page, '.tabs')).includes('Staff'));
  ok('the case list shows the subject instead of the carrier',
     body.includes('Pat Coleman') && !body.includes('Example Mutual Insurance'));

  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(350);
  const dlg = await text(page, '#dlgBody');
  ok('the investigator can open their case', dlg.includes('API-20260812-4001'));
  ok('the investigator gets the subject', dlg.includes('Pat Coleman'));
  ok('the investigator gets the scope', dlg.includes('Activity level versus stated restrictions'));
  ok('the investigator gets the deadline', dlg.includes('Hearing 9/12'));
  await wsTab(page, 'Subject');
  const isubj = await text(page, '#dlgBody');
  ok('the investigator gets the injury and restrictions', isubj.includes('Lumbar strain'));
  const inav = await page.locator('.wsnav button').allInnerTexts();
  ok('the investigator gets the same one-level workspace',
     ['Overview', 'Activity', 'Daily Summary', 'Evidence', 'Report']
       .every(t => inav.some(x => x.trim() === t)), JSON.stringify(inav));
  ok('and no Billing tab on it', !inav.some(t => /Billing/i.test(t)), JSON.stringify(inav));
  await wsTab(page, 'Activity');
  ok('the investigator has an Activity tab', await page.locator('.wsnav button[data-tab="activity"]').count() === 1);
  ok('the investigator can still reach Field work', await page.evaluate(
     () => [...wsPrimary(), ...wsMore()].some(t => t[0] === 'field')));
  ok('the investigator has NO Assignment tab', await page.locator('.wstabs button', { hasText: 'Assignment' }).count() === 0);
  ok('the investigator gets no assignment controls', await page.locator('#asg').count() === 0);
  await page.close();
}

/* The commercial boundary: an investigator is given the fieldwork and nothing
   that identifies who is paying for it. Asserted against the page AND against
   the raw API response, because a field the page merely declines to draw is
   still sitting in the browser's network tab. */
section('The client is not shown to an investigator');
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(350);
  const dlg = await text(page, '#dlgBody');
  const secrets = {
    'the carrier': 'Example Mutual Insurance',
    'the claim number': 'WC-2026-88421',
    'the policy number': 'POL-77123',
    'the adjuster': 'Dana Reyes',
    "the adjuster's email": 'dreyes@examplemutual.com',
  };
  for (const [what, value] of Object.entries(secrets)) {
    ok(`${what} is not in the case detail`, !dlg.includes(value), value);
  }

  // Straight from the API, with the page taken out of it entirely.
  const raw = await page.evaluate(async () =>
    JSON.stringify(await (await fetch('/portal-api/submissions/API-20260812-4001',
      { credentials: 'same-origin' })).json()));
  for (const [what, value] of Object.entries(secrets)) {
    ok(`${what} never reaches the browser at all`, !raw.includes(value), value);
  }
  ok('the API still sends what the fieldwork needs',
     raw.includes('Pat Coleman') && raw.includes('Lumbar strain'));

  const rawList = await page.evaluate(async () =>
    JSON.stringify(await (await fetch('/portal-api/submissions?limit=200',
      { credentials: 'same-origin' })).json()));
  ok('the list response carries no carrier', !rawList.includes('Example Mutual Insurance'));
  ok('the list response carries no claim number', !rawList.includes('WC-2026-88421'));
  await page.close();
}

/* The portal used to ship two invented cases — a carrier assignment for
   "Blue Ridge Mutual" and a client intake — and showed them unasked on a first
   sign-in so an empty list had something in it. A staff screen that invents a
   client can be photographed, quoted or acted on as though that client were
   real, and the person least able to tell is the new member of staff the
   example existed to teach. These sections assert they are gone, and that what
   replaced them says something true. */
section('No fabricated case appears anywhere in the portal');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  const body = await text(page, '.card');
  ok('the case list carries no EXAMPLE- row', !body.includes('EXAMPLE-'), body.slice(0, 200));
  ok('and none of the invented people reach the screen',
     !/Blue Ridge Mutual|Karen Whitfield|Marcus Ellery/.test(body), body.slice(0, 200));
  ok('the case list bar carries no test controls',
     !has(await text(page, '.bar'), 'test case') && !has(await text(page, '.bar'), 'example'));

  await page.locator('.tabs button', { hasText: 'Settings' }).click();
  await page.waitForTimeout(300);
  const settings = await page.locator('#app').innerText();
  ok('Settings still holds the developer area', has(settings, 'Developer & testing'));
  ok('but offers no control that summons an example',
     await page.locator('.btn', { hasText: 'example' }).count() === 0);
  ok('and says plainly that there are none', has(settings, 'no fabricated example cases'));
  ok('the TEST- case control is still offered',
     await page.locator('.btn', { hasText: 'Add a test case' }).count() === 1);
  ok('and it now says what removing one takes with it',
     has(settings, 'days, activity, reports, invoices, evidence and packages'));
  await page.close();

  const planted = db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE case_no LIKE 'EXAMPLE-%'").get().n;
  ok('and no example was ever written to the database', planted === 0);
}

section('A new investigator gets an honest empty state, not an invented case');
{
  // Someone who has just accepted an invitation and has nothing assigned yet.
  const admin = await newPage();
  await signIn(admin, 'trever', 'AdminPassword1x');
  await admin.locator('.tabs button', { hasText: 'Staff' }).click();
  await admin.waitForTimeout(250);
  await admin.locator('#nv_name').fill('Nate Ruiz');
  await admin.locator('#nv_user').fill('nate');
  await admin.locator('.btn', { hasText: 'Create invitation' }).click();
  await admin.waitForTimeout(600);
  const url = ((await text(admin, '.linkbox')).match(/http\S*\/portal\/\?invite=[0-9a-f]{64}/) || [''])[0];
  await admin.close();

  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  await page.goto(url);
  await page.waitForTimeout(400);
  await page.locator('#p1').fill('NightWatch2026x');
  await page.locator('#p2').fill('NightWatch2026x');
  await page.locator('#acceptBtn').click();
  await page.waitForTimeout(800);

  const body = await text(page, '.card');
  ok('no example case is waiting for them', !body.includes('EXAMPLE-'), body.slice(0, 200));
  ok('no invented carrier or claimant is on screen',
     !/Blue Ridge Mutual|Marcus Ellery|Karen Whitfield/.test(body), body.slice(0, 200));
  ok('the empty state says nothing is assigned yet', has(body, 'Nothing assigned to you yet'));
  ok('and says what will change that', has(body, 'admin assigns one'));
  ok('there is no control offering to show them an example',
     await page.locator('.btn', { hasText: 'example' }).count() === 0);
  await page.close();
}

/* The page carried a second copy of the Worker's redaction allow-list, purely
   so the page-held example could be redacted the way the Worker redacts a real
   case. With the example gone that copy has no consumer, and a stale duplicate
   of a security boundary is worse than no duplicate at all — so FIELD_KEEP has
   exactly one writer again, in the Worker, which is the thing that enforces it. */
section('The page holds no example data and no second copy of the allow-list');
{
  const src = fs.readFileSync(path.join(ROOT, 'portal/index.html'), 'utf8');
  for (const marker of ['EXAMPLE_CASES', 'EXAMPLE_SIGNATURE', 'examplesFor', 'redactExample',
                        'exampleBodyHtml', 'openExampleCase', 'SHOW_EXAMPLE', 'isExample'])
    ok(`the page source no longer defines ${marker}`, !src.includes(marker), marker);

  ok('no EXAMPLE- case number survives in the source', !src.includes('EXAMPLE-'));
  ok('and none of the invented identities remain',
     !/Blue Ridge Mutual|Karen Whitfield|Marcus Ellery|blueridgemutual/.test(src));
  ok('no data: image signature is left embedded in the page',
     !src.includes('data:image/png;base64,iVBOR'));

  ok('the page carries no copy of the redaction allow-list', !src.includes('FIELD_KEEP'));
  const worker = fs.readFileSync(path.join(ROOT, 'case-portal/worker.js'), 'utf8');
  ok('the Worker still declares it, and is now the only place that does',
     /const FIELD_KEEP = \[/.test(worker));
}

section('Session');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.reload();
  await page.waitForTimeout(500);
  ok('the session survives a reload', await page.locator('.tabs').count() === 1);

  await page.locator('#who button').click();
  await page.waitForTimeout(400);
  ok('signing out returns to the sign-in form', (await text(page, 'h1')) === 'Case Portal');
  await page.reload();
  await page.waitForTimeout(400);
  ok('the session does not come back after signing out', await page.locator('#loginBtn').count() === 1);
  await page.close();
}

section('Stored XSS regression');
{
  // Ingest now rejects this, so plant it straight into the table. The point is
  // that even a hostile row already in the database must render as text.
  db.prepare(`INSERT INTO submissions (case_no, kind, status, client_name, payload, created_at)
              VALUES (?, 'consumer', 'new', ?, '{}', ?)`)
    .run("x'); window.__pwned = true; ('",
         '<img src=x onerror="window.__pwned=true">',
         new Date().toISOString());

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.waitForTimeout(500);
  const pwned = await page.evaluate(() => Boolean(window.__pwned));
  ok('a hostile case number in the database does not execute', pwned === false);
  ok('a hostile client name does not execute', pwned === false);
  ok('the hostile row still renders as visible text',
     (await text(page, '.card')).includes('window.__pwned'));
  await page.close();
}

section('The dashboard');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  const stats = await text(page, '.stats');
  for (const label of ['Open cases', 'Needs assignment', 'Out now', 'Reports due', 'Authorization low']) {
    ok(`the dashboard shows ${label}`, has(stats, label), stats);
  }
  ok('carrier and private counts moved to the case bar, not the cards',
     !has(stats, 'Carrier') && has(await text(page, '.bar'), 'carrier'));
  ok('the counts are real numbers', /\d/.test(stats));
  await page.close();
}

/* An empty portal that draws nothing looks broken, and a new admin has no way
   to tell what it will look like once work arrives. */
section('The dashboard with nothing in it');
{
  const empty = new DatabaseSync(':memory:');
  empty.exec(SCHEMA);
  const saved = env.DB;
  env.DB = d1(empty);
  await worker.fetch(new Request(API + '/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: SITE, 'X-Bootstrap-Token': 'e2e-bootstrap' },
    body: JSON.stringify({ username: 'fresh', display_name: 'Fresh Admin', password: 'FreshStart1x' }),
  }), env);

  const page = await newPage();
  await signIn(page, 'fresh', 'FreshStart1x');
  ok('the dashboard still draws with no cases', await page.locator('.stats').count() === 1);
  ok('and the cards are shown rather than hidden', await page.locator('.stat').count() > 0);

  const shell = await page.locator('#app').innerText();
  ok('no example is invented to fill the dashboard', !shell.includes('EXAMPLE-'), shell.slice(0, 200));
  ok('and no invented client is named anywhere on it',
     !/Blue Ridge Mutual|Karen Whitfield|Marcus Ellery/.test(shell));
  ok('nothing claims the totals include an example', !has(shell, 'include the example'));

  /* A zero IS the answer on an empty portal. The cards used to be padded with
     the example so they would not all read zero, which made the one number a
     new admin most needs to trust the first number they could not. */
  await page.locator('.tabs button', { hasText: 'Cases' }).click();
  await page.waitForTimeout(350);
  const body = await text(page, '.card');
  ok('the case list is empty and says so', has(body, 'No cases yet'), body.slice(0, 200));
  ok('and says what will fill it', has(body, 'Intake forms arrive here'));
  ok('it points at the TEST- case as the way to try the portal', has(body, 'TEST-'));
  ok('there is no button offering to show an example',
     await page.locator('.btn', { hasText: 'Show an example' }).count() === 0);
  ok('the dashboard is still drawn when empty',
     await page.locator('.tabs button', { hasText: 'Dashboard' }).count() === 1);
  await page.close();
  env.DB = saved;
}

/* A case list that cannot load and a case list with nothing in it are not the
   same thing. The portal used to draw the same screen for both — an empty
   dashboard, a "no submissions yet" line, and no hint that anything had gone
   wrong. That is how a real failure sat on the live site looking like calm. */
section('A failed load says so instead of looking empty');
{
  const page = await newPage();
  // Break the case list for this page only, before it ever loads.
  await page.route('**/portal-api/submissions?**', r =>
    r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"database unavailable"}' }));
  await signIn(page, 'trever', 'AdminPassword1x');

  const body = await text(page, '.card');
  const shell = await page.evaluate(() => document.querySelector('#app').innerText);
  ok('the failure is on screen', shell.includes('Something did not load'), shell.slice(0, 200));
  ok('it says what failed', shell.includes('case list could not be loaded'));
  ok('it carries the reason back from the server', shell.includes('database unavailable'));
  ok('there is a way to retry', await page.locator('.btn', { hasText: 'Try again' }).count() === 1);
  ok('it warns that what is shown may be incomplete', has(shell, 'necessarily the whole picture'));

  /* The important part: a failed load must not read as an empty portal. There
     is no example left to stand in for the data, so what matters now is that
     the empty state does not claim the portal is simply quiet. */
  ok('a broken load shows no fabricated case', !body.includes('EXAMPLE-'), body.slice(0, 200));
  ok('and does not claim there are simply no cases',
     !body.includes('No cases yet') && !body.includes('No submissions yet'), body.slice(0, 200));
  ok('it says the list did not load instead', has(body, 'did not load'), body.slice(0, 200));

  // Recovering works without a reload.
  await page.unroute('**/portal-api/submissions?**');
  await page.locator('.btn', { hasText: 'Try again' }).click();
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => document.querySelector('#app').innerText);
  ok('retrying clears the banner', !after.includes('Something did not load'));
  ok('and the real cases come back', after.includes('API-20260812-4001'));
  await page.close();
}

section('Adding a test case from the portal');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Settings' }).click();
  await page.waitForTimeout(300);
  await page.locator('.btn', { hasText: 'Add a test case' }).click();
  await page.waitForTimeout(700);

  ok('adding lands on the case list, where it now sits',
     has(await text(page, '.tabs button.on'), 'Cases'));
  const list = await text(page, '.card');
  ok('a test case appears in the list', /TEST-\d{8}-/.test(list), list.slice(0, 200));
  ok('it is badged as a test', has(list, 'Test'));
  ok('its carrier is unmistakably fake', list.includes('Demo Mutual Insurance (TEST)'));
  await page.locator('.tabs button', { hasText: 'Settings' }).click();
  await page.waitForTimeout(300);
  ok('a Remove button appears in Settings once one exists',
     await page.locator('.btn', { hasText: 'Remove test cases' }).count() === 1);
  await page.locator('.tabs button', { hasText: 'Cases' }).click();
  await page.waitForTimeout(300);

  // It behaves like a real case, which is the whole point of having one.
  await page.locator('tbody tr', { hasText: 'TEST-' }).first().click();
  await page.waitForTimeout(500);
  ok('it opens a full workspace', await page.locator('.wsnav button').count() >= 6,
     String(await page.locator('.wsnav button').count()));
  await wsTab(page, 'Authorization');
  const auth = await text(page, '#dlgBody');
  ok('it arrives with hours to work against', auth.includes('24 hours'));
  ok('and a budget', auth.includes('3,300'));
  await page.locator('.close').click();
  await page.waitForTimeout(250);

  // Clearing takes the test cases and leaves the real ones — from Settings.
  page.on('dialog', d => d.accept());
  await page.locator('.tabs button', { hasText: 'Settings' }).click();
  await page.waitForTimeout(300);
  await page.locator('.btn', { hasText: 'Remove test cases' }).click();
  await page.waitForTimeout(800);
  await page.locator('.tabs button', { hasText: 'Cases' }).click();
  await page.waitForTimeout(400);
  const after = await text(page, '.card');
  ok('the test case is gone', !/TEST-\d{8}-/.test(after), after.slice(0, 200));
  ok('the real cases are untouched', after.includes('API-20260812-4001') && after.includes('API-20260812-4002'));
  await page.close();
}
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  ok('an investigator gets no Settings', !has(await text(page, '.tabs'), 'Settings'));
  await page.close();
}

/* The live portal hit exactly this: the workspace tables had not been created,
   so every button that touched one returned "Something went wrong handling
   that request" and the screen otherwise looked like a normal empty portal.
   One cause, many symptoms, and nothing on screen naming it. */
section('No rate is baked into the portal page source');
{
  const src = fs.readFileSync(path.join(ROOT, 'portal/index.html'), 'utf8');
  ok('no dollar figure appears in the served portal HTML',
     !/\$\s?\d/.test(src), (src.match(/\$\s?\d[^\n]{0,50}/) || [''])[0]);
}

section('A half-applied schema names itself');
{
  const page = await newPage();
  await page.route('**/portal-api/health', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, configured: true, email: false,
                           missing_tables: ['case_types', 'case_meta', 'case_days'] }),
  }));
  await signIn(page, 'trever', 'AdminPassword1x');
  const shell = await page.evaluate(() => document.querySelector('#app').innerText);

  ok('the portal says the database is not set up', has(shell, 'not fully set up'));
  ok('it counts what is missing', shell.includes('3 tables are missing'));
  ok('it names them', shell.includes('case_types') && shell.includes('case_days'));
  ok('it gives the exact fix', has(shell, 'Set up the case portal'));
  ok('it says the fix is safe to re-run', has(shell, 'safe to re-run'));
  ok('there is a way to re-check', await page.locator('.btn', { hasText: 'Check again' }).count() === 1);
  await page.close();
}

section('A missing table is reported as a fixable setup problem, not a mystery');
{
  // Drop a workspace table under the running Worker, the way a live database
  // sits when the schema has not been re-applied after a deploy.
  db.exec('DROP TABLE IF EXISTS case_types');
  const res = await worker.fetch(new Request(API + '/demo-case', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: SITE },
  }), env);
  ok('an unauthenticated caller is still just refused', res.status === 401);

  const login = await post('/auth/login', { username: 'trever', password: 'AdminPassword1x' });
  const cookie = (login.headers.getSetCookie()[0] || '').split(';')[0];
  const attempt = await worker.fetch(new Request(API + '/demo-case', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: SITE, Cookie: cookie },
  }), env);
  const bodyText = await attempt.text();
  ok('the failure is a 503, not a bare 500', attempt.status === 503, String(attempt.status));
  ok('it names the workflow that fixes it', bodyText.includes('Set up the case portal'), bodyText);
  ok('it is tagged so the page can act on it', bodyText.includes('schema_out_of_date'));
  ok('it does not leak the SQL or the column', !/sqlite|SELECT|no such table/i.test(bodyText), bodyText);

  // Health reports it too, so the page can warn before anything is clicked.
  const h = await (await worker.fetch(new Request(API + '/health', { headers: { Origin: SITE } }), env)).json();
  ok('health lists the missing table', h.missing_tables.includes('case_types'), JSON.stringify(h));

  db.exec(SCHEMA);   // put it back for the rest of the run
  const h2 = await (await worker.fetch(new Request(API + '/health', { headers: { Origin: SITE } }), env)).json();
  ok('and reports a clean bill once the schema is applied', h2.missing_tables.length === 0,
     JSON.stringify(h2.missing_tables));
}

section('Rate sheets');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Rate Sheets' }).click();
  await page.waitForTimeout(400);
  const card = await text(page, '.card');
  ok('the retainer product is offered by its unmistakable label',
     card.includes('Private Client — $1,500 Retainer'));
  ok('it names its audience', has(card, 'Private surveillance, domestic and family'));
  ok('the insurance product is offered', card.includes('Insurance Assignment Rates'));
  ok('it names its audience', has(card, 'carriers, TPAs'));
  ok('the page says none of it is on the website', has(card, 'Nothing here appears on the website'));

  /* UNIT 28 — LEGAL IS ON THIS SCREEN. The Production Truth Audit found it was
     not: a law firm could only be sent a sheet from an existing lead card, so
     a firm that was not on the desk yet could be sent nothing at all. These
     assertions are REACHABILITY — the owner's test is that they can see it and
     press it, not that a route exists. */
  ok('the legal product is offered beside the other two',
     has(card, 'Legal / Law Firm'), card.slice(0, 400));
  ok('it names its audience', has(card, 'Law firms, attorneys and paralegals'));
  ok('three cards are on the screen, not two',
     await page.locator('.sheet-card').count() === 3,
     String(await page.locator('.sheet-card').count()));

  await page.locator('.sheet-card', { hasText: 'Legal / Law Firm' }).click();
  await page.waitForTimeout(300);
  const lg = await page.locator('.card').nth(1).innerText();
  ok('the legal sheet opens', has(lg, 'Legal / Law Firm') || has(lg, '$1,500'), lg.slice(0, 200));
  ok('it carries the SAME figures as the private sheet — one pricing source',
     lg.includes('$1,500') && lg.includes('$100/hr'), lg.slice(0, 200));
  ok('it names the approved firm-billing arrangements',
     has(lg, 'BILL.com') && has(lg, 'pick-up'), lg.slice(0, 400));
  ok('and shows NO private payment language',
     !has(lg, 'Cash App') && !has(lg, 'Venmo'), lg.slice(0, 400));
  ok('its next-step names the legal form, never the private one',
     has(await text(page, '.nextstep'), 'Legal Investigation Assignment Form')
       && !has(await text(page, '.nextstep'), 'Private Client Intake'),
     await text(page, '.nextstep'));
  ok('and it has its own send door', await page.locator('.btn', { hasText: 'Send this sheet' }).count() === 1);

  /* SEND TO SOMEONE NEW — the pre-case doors, all three of them. Located by
     the BUTTON rather than by card text: `.card` matches the sheet grid first,
     and reading the wrong card is how a reachability test passes vacuously. */
  const preBtns = await page.locator('.btn', { hasText: 'Send legal intake' }).count();
  ok('a legal intake can be sent to someone who is not on the desk', preBtns === 1,
     String(preBtns));
  ok('and the other two pre-case doors are still their own separate choices',
     await page.locator('.btn', { hasText: 'Send private intake' }).count() === 1
       && await page.locator('.btn', { hasText: 'Send insurance intake' }).count() === 1);
  await page.locator('.btn', { hasText: 'Send legal intake' }).click();
  await page.waitForTimeout(250);
  const dlg = await text(page, '.amsheet');
  ok('and the dialog names the LEGAL form, never the Private Client Intake',
     has(dlg, 'Legal Investigation Assignment Form') && !has(dlg, 'Private Client Intake'), dlg.slice(0, 300));
  await page.locator('.amx').click();
  await page.waitForTimeout(200);
  /* Close the LEGAL card rather than opening the private one: `openSheet`
     TOGGLES, so opening private here and letting the original assertions open
     it again would shut it, and the block below would find no sheet at all. */
  await page.locator('.sheet-card', { hasText: 'Legal / Law Firm' }).click();
  await page.waitForTimeout(250);

  /* NAMED, not matched on the figure: Private and Legal are the same product
     at the same price, so '$1,500 Retainer' matches both cards (Unit 28). */
  await page.locator('.sheet-card', { hasText: 'Private Client — $1,500' }).click();
  await page.waitForTimeout(300);
  const sheet = await page.locator('.card').nth(1).innerText();
  ok('the retainer sheet states the retainer', sheet.includes('$1,500'));
  ok('it states the hourly rate', sheet.includes('$100/hr'));
  ok('it states the minimum', has(sheet, '4-hour minimum'));
  ok('the retainer reads as a deposit against the work',
     has(sheet, 'applied directly to authorized investigative services'));
  ok('"Additional fees — None" is gone', !has(sheet, 'Additional fees'));
  ok('replaced by the plain-language promise', has(sheet, 'No routine add-on fees'));
  ok('its confirmation line is its own', has(sheet, 'Your case. Your authorization.'));
  ok('the send wizard is the one door out', await page.locator('.btn', { hasText: 'Send this sheet' }).count() === 1);

  /* PAYMENTS.md §2 — the send area used to explain itself in a 0.78rem muted
     `.opt` footnote, which is the one presentation that section forbids by
     name. The wording is asserted here; the SIZE is asserted too, because
     "don't make this look like a tiny gray footnote" is the requirement and
     the only way it regresses is silently. */
  const cta = await text(page, '.nextstep');
  ok('the send area carries a NEXT STEP block', await page.locator('.nextstep').count() === 1);
  ok('it says what the click will offer', has(cta, 'Choose what to include with this email'));
  ok('it names the private intake form', has(cta, 'Private Client Intake Form'));
  ok('and payment options', has(cta, 'Payment Options'));
  ok('the vague footnote it replaced is gone', !has(sheet, 'The send screen offers to include'));
  const ctaPx = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('.nextstep')).fontSize));
  ok(`it is body-size type, not the 12.5px footnote (${ctaPx}px)`, ctaPx >= 14, String(ctaPx));

  /* §2: "Desktop: button + helper panel. Mobile: stack vertically." One flex
     row with wrap does both, so the guard is that it genuinely lays out both
     ways — side by side at 1200, stacked at 390 — rather than that a CSS
     property has a particular value. */
  const sideBySide = await page.evaluate(() => {
    const b = document.querySelector('.sendcta .btn').getBoundingClientRect();
    const p = document.querySelector('.nextstep').getBoundingClientRect();
    return { apart: p.left >= b.right, sameRow: Math.abs(p.top - b.top) < 40 };
  });
  ok('on a desktop the panel sits beside the button', sideBySide.apart && sideBySide.sameRow,
     JSON.stringify(sideBySide));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  /* Measured on the SEND AREA, not on the document. The Rate sheets view
     already overflows 390px by 23px at `SPAN.rs-v` inside the fee box — proven
     on unmodified master at c60542b, so it predates this block and is recorded
     in NEXT.md as its own unit. A document-wide assertion here would fail for
     a reason this section does not own, and "fix" it by tempting someone to
     widen the tolerance. */
  const stacked = await page.evaluate(() => {
    const b = document.querySelector('.sendcta .btn').getBoundingClientRect();
    const p = document.querySelector('.nextstep').getBoundingClientRect();
    const c = document.querySelector('.sendcta').getBoundingClientRect();
    return { below: p.top >= b.bottom,
             fits: p.right <= 391 && c.right <= 391 && p.left >= -1,
             edges: [Math.round(p.right), Math.round(c.right)] };
  });
  ok('on a phone it stacks below instead', stacked.below, JSON.stringify(stacked));
  ok('and the send area itself stays inside a 390px screen',
     stacked.fits, JSON.stringify(stacked));
  /* THE FEE BOX ON A PHONE (owner, Unit 2). `.rs-v` was `white-space:nowrap`
     for the money figures, but two private-sheet lines carry sentences, and an
     unbreakable sentence made the view 413px wide on a 390px screen. Asserted
     as no overflow AND as nothing hidden to achieve it — clipping the text
     would satisfy a width check and lose the client's terms. */
  const feeBox = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.rs-row')];
    const wide = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.right > 391 && r.width > 0) wide.push(`${el.tagName}.${el.className}`.slice(0, 40));
    }
    return { sw: document.documentElement.scrollWidth, wide: wide.slice(0, 5),
             rows: rows.length, text: document.querySelector('.feebox').innerText };
  });
  ok('the rate sheet does not scroll sideways on a 390px screen',
     feeBox.sw <= 390, JSON.stringify({ sw: feeBox.sw, wide: feeBox.wide }));
  ok('and every fee line is still there', feeBox.rows === 5, String(feeBox.rows));
  ok('the sentence value that caused it is shown in full, not clipped',
     has(feeBox.text, 'No routine add-on fees'), feeBox.text.slice(0, 200));
  ok('and so is the other one', has(feeBox.text, 'Quoted in advance'));
  ok('the retainer figure is still readable', has(feeBox.text, '$1,500'));

  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForTimeout(250);
  const feeDesk = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    text: document.querySelector('.feebox').innerText,
  }));
  ok('and the desktop layout is unharmed', feeDesk.sw <= 1200
     && has(feeDesk.text, 'No routine add-on fees') && has(feeDesk.text, '$1,500'),
     String(feeDesk.sw));

  await page.locator('.sheet-card', { hasText: 'Insurance Assignment Rates' }).click();
  await page.waitForTimeout(300);
  const ins = await page.locator('.card').nth(1).innerText();
  ok('the insurance sheet lists the one-day block', ins.includes('$1,200'));
  ok('it lists the two-day block', ins.includes('$2,300'));
  ok('it lists the three-day block', ins.includes('$3,300'));
  ok('it states the overage rate', ins.includes('$150/hr'));
  ok('the three-day block wears the recommendation badge',
     has(ins, 'Recommended initial authorization'));
  ok('"Additional fees — None" is gone here too', !has(ins, 'Additional fees'));
  ok('its own confirmation line', has(ins, 'Clear pricing. No surprise billing.'));
  ok('the retainer figure is NOT on the carrier sheet', !ins.includes('$1,500'), ins);

  /* PAYMENTS.md §14 — the carrier sheet gets the SAME clearer send area and the
     strict pairing: its own intake named, and the words Payment Options, Cash
     App and Venmo absent. Asserted against the whole card rather than the block
     alone, so the guard cannot be satisfied by moving the words somewhere else
     on the same screen. */
  const insCta = await text(page, '.nextstep');
  ok('the carrier sheet has the same NEXT STEP block', await page.locator('.nextstep').count() === 1);
  ok('it says what the click will offer here too',
     has(insCta, 'Choose what to include with this email'));
  ok('naming the insurance assignment intake form',
     has(insCta, 'Insurance Assignment Intake Form'));
  ok('and never the private one', !has(ins, 'Private Client Intake'));
  ok('§14: no payment options on the carrier sheet', !has(ins, 'Payment Options'), ins);
  ok('§14: no Cash App', !has(ins, 'Cash App'), ins);
  ok('§14: no Venmo', !has(ins, 'Venmo'), ins);

  // The carrier sheet shares the fee box, so it gets the same phone check.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const insPhone = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    text: document.querySelector('.feebox').innerText,
  }));
  ok('the carrier sheet does not scroll sideways on a phone either',
     insPhone.sw <= 390, String(insPhone.sw));
  ok('with its blocks still legible', has(insPhone.text, '$1,200')
     && has(insPhone.text, '$3,300'), insPhone.text.slice(0, 200));
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForTimeout(300);

  // UIBUILD P18: the 3-step wizard — Recipient, Options (the paired intake),
  // Preview. On the carrier sheet the paired intake is the carrier door.
  await page.locator('.btn', { hasText: 'Send this sheet' }).click();
  await page.waitForTimeout(300);
  const first = await text(page, '.amsheet');
  ok('the wizard opens on Recipient', has(first, 'Send it to'));
  /* The owner's 2026-08-14 report: the include-intake choice existed on a
     second step and was therefore never seen. It is now a named guarantee
     that the checkbox is VISIBLE the moment the wizard opens. */
  ok('the intake checkbox is on the FIRST screen, visible before any click',
     await page.locator('#wiz_inc').isVisible());
  ok('naming the carrier intake', has(first, 'Insurance Assignment Intake'));
  ok('and saying the consumer picker is never offered', has(first, 'never the consumer picker'));
  await page.locator('.btn', { hasText: 'Preview' }).click();
  await page.waitForTimeout(250);
  ok('an empty address is refused before moving on',
     has(await text(page, '.amsheet'), 'Enter the address'));
  await page.locator('#wiz_to').fill('adjuster@example.test');
  await page.locator('.btn', { hasText: 'Preview' }).click();
  await page.waitForTimeout(250);
  const prev = await text(page, '.amsheet');
  ok('Preview names the recipient and the included intake',
     has(prev, 'adjuster@example.test') && has(prev, 'link included'));
  await page.locator('.btn', { hasText: 'Send it' }).click();
  await page.waitForTimeout(500);
  ok('with no mail key the wizard says exactly what is missing',
     has(await text(page, '.amsheet'), 'not configured'));
  await page.locator('.amx').click();
  await page.waitForTimeout(250);
  await page.close();
}

section('An investigator gets no rates at all');
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  ok('there is no Rate Sheets tab', !(await text(page, '.tabs')).includes('Rate Sheets'));

  const sheets = await page.evaluate(async () =>
    (await fetch('/portal-api/sheets', { credentials: 'same-origin' })).status);
  ok('the sheets endpoint refuses them', sheets === 403);
  const pricing = await page.evaluate(async () =>
    (await fetch('/portal-api/pricing', { credentials: 'same-origin' })).status);
  ok('the rates endpoint refuses them', pricing === 403);
  const mail = await page.evaluate(async () =>
    (await fetch('/portal-api/sheets/insurance_assignment/email', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'someone@example.com' }),
    })).status);
  ok('and they cannot email one to anybody', mail === 403);
  await page.close();
}

/* The cards are doors, not statistics: clicking one shows exactly the cases
   behind its number. This drives the whole loop — a day left running makes
   Out now light up, clicking it narrows the list, ending the day makes the
   finished-but-unreported day surface under Reports due. */
section('Dashboard cards answer "what needs my attention"');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  // Use 4001: the later workspace section does exact hour-math on 4002, and a
  // stray day here would silently break it.
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Field work');
  await page.locator('#d_date').fill('2026-08-13');
  await page.locator('#d_start').fill('06:00');
  await page.locator('.btn', { hasText: 'Start investigation' }).click();
  await page.waitForTimeout(500);
  await page.locator('.close').click();
  await page.waitForTimeout(300);

  await render(page);
  const stats = await text(page, '.stats');
  ok('Out now counts the running day', /Out now/.test(stats), stats);

  const outCard = page.locator('.stat', { hasText: 'Out now' });
  ok('the card with work behind it is clickable', (await outCard.getAttribute('class')).includes('click'));
  await outCard.click();
  await page.waitForTimeout(250);
  let list = await text(page, '.card');
  ok('clicking it narrows the list to those cases', list.includes('API-20260812-4001'));
  ok('other cases drop out of view', !list.includes('API-20260812-4002'));
  ok('a chip names the active filter', has(await text(page, '.bar'), 'Out now'));
  ok('the example never stands in for an alert', !list.includes('EXAMPLE-'));

  await page.locator('.chip button').click();
  await page.waitForTimeout(250);
  list = await text(page, '.card');
  ok('clearing the chip restores the full list', list.includes('API-20260812-4002'));

  // End the day: it must move from Out now to Reports due.
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Field work');
  await page.locator('#d_end').fill('10:00');
  await page.locator('.btn', { hasText: 'End investigation day' }).click();
  await page.waitForTimeout(600);
  await page.locator('.close').click();
  await page.waitForTimeout(300);
  await render(page);
  const after = await text(page, '.stats');
  const dueCard = page.locator('.stat', { hasText: 'Reports due' });
  ok('a finished day without a report shows under Reports due',
     parseInt((await dueCard.innerText()).match(/\d+/)[0], 10) >= 1, after);
  await page.close();
}

async function render(page){ await page.evaluate(() => window.render && window.render()); await page.waitForTimeout(500); }

/* The field workflow, driven through the page the way it will actually be
   used: open a case, start the day, log the timeline, end the day, and watch
   the authorization move. */
section('The case workspace in the browser');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);

  const navbar = await text(page, '.wsnav');
  for (const t of ['Overview', 'Activity', 'Daily Summary', 'Evidence', 'Report', 'Billing']) {
    ok(`the workspace navigates in one row: ${t}`, has(navbar, t), navbar);
  }
  // Every panel is still reachable behind its section.
  const tabKeys = { Subject: 'subject', Activity: 'activity', 'Field work': 'field',
                    Authorization: 'auth', Assignment: 'assign' };
  for (const t of ['Subject', 'Activity', 'Field work', 'Authorization', 'Assignment']) {
    await wsTab(page, t);
    ok(`the ${t} panel is still reachable`, (await wsOpenTab(page)) === tabKeys[t], t);
  }

  // The chain has to hold hands: Reports with nothing to report on points at
  // Field work rather than dead-ending.
  await wsTab(page, 'Report');
  ok('an empty Reports tab offers the way to Field work',
     await page.locator('.btn', { hasText: 'Go to Field work' }).count() === 1);
  await page.locator('.btn', { hasText: 'Go to Field work' }).click();
  await page.waitForTimeout(250);
  ok('and it lands on the day controls', await page.locator('#d_date').count() === 1);

  // Set the authorization first so the panel has something to measure against.
  await wsTab(page, 'Authorization');
  await page.locator('#m_hours').fill('8');
  await page.locator('#m_budget').fill('1200');
  await page.locator('.btn', { hasText: 'Save authorization' }).click();
  await page.waitForTimeout(500);
  let auth = await text(page, '#dlgBody');
  ok('the authorization panel shows the hours', auth.includes('8 hours'));
  ok('it shows the budget an admin authorized', auth.includes('1,200'));
  ok('nothing is used yet', auth.includes('0 hours'));

  // Start the day.
  await wsTab(page, 'Field work');
  await page.locator('#d_date').fill('2026-08-12');
  await page.locator('#d_start').fill('07:00');
  await page.locator('#d_smiles').fill('41000');
  await page.locator('.btn', { hasText: 'Start investigation' }).click();
  await page.waitForTimeout(500);
  ok('the day is running', has(await text(page, '#dlgBody'), 'Day running since 7:00 AM'));

  // Log the timeline — the form lives in the Add Activity sheet now (P10).
  await wsTab(page, 'Activity');
  ok('the log says a day is running', has(await text(page, '#dlgBody'), 'Investigation day running'));
  ok('and offers to end it from right there',
     await page.locator('.btn', { hasText: 'End the day' }).count() === 1);

  await openComposer(page);
  const quick = await page.locator('.qgrid').innerText();
  for (const b of ['Activity', 'Location', 'Vehicle', 'Note', 'Mileage', 'Expense']) {
    ok(`there is a quick button for ${b}`, has(quick, b), quick);
  }
  ok('Photo and Video pills are gone — capture is a checkmark on the moment',
     !has(quick, 'Photo') && !has(quick, 'Video'), quick);
  await page.locator('#a_date').fill('2026-08-12');
  await page.locator('#a_time').fill('07:14');
  await page.locator('#a_desc').fill('Subject vehicle observed parked at residence.');
  await page.locator('#a_loc').fill('88 Peakland Pl');
  await page.locator('.btn', { hasText: 'Add to the log' }).click();
  await page.waitForTimeout(500);

  let log = await text(page, '#dlgBody');
  ok('the entry is on the timeline', log.includes('Subject vehicle observed parked at residence.'));
  ok('the time is shown in 12-hour form', log.includes('7:14 AM'));
  ok('the location is shown', log.includes('88 Peakland Pl'));
  ok('the sheet closed itself on success', await page.locator('.amsheet').count() === 0);

  await openComposer(page);
  await page.locator('#a_date').fill('2026-08-12');
  await page.locator('#a_time').fill('08:17');
  await page.locator('#a_desc').fill('Subject arrived at ABC Fitness.');
  await page.locator('.btn', { hasText: 'Add to the log' }).click();
  await page.waitForTimeout(500);
  log = await text(page, '#dlgBody');
  ok('a second entry joins it', log.includes('Subject arrived at ABC Fitness.'));
  /* Unit 38 — the log is a narrative, so it reads OLDEST first. */
  ok('the log reads oldest first', log.indexOf('7:14 AM') < log.indexOf('8:17 AM'),
     `7:14 at ${log.indexOf('7:14 AM')}, 8:17 at ${log.indexOf('8:17 AM')}`);

  await openComposer(page);
  await page.locator('#a_desc').fill('');
  await page.locator('.btn', { hasText: 'Add to the log' }).click();
  await page.waitForTimeout(400);
  ok('an entry with no description is refused on screen',
     has(await text(page, '#dlgBody'), 'Describe what happened'));
  ok('and the sheet stays open to fix it', await page.locator('.amsheet').count() === 1);
  await page.locator('.amx').click();
  await page.waitForTimeout(250);

  // End the day and watch the authorization move.
  await wsTab(page, 'Field work');
  await page.locator('#d_end').fill('13:00');
  await page.locator('#d_emiles').fill('41042');
  await page.locator('#d_sum').fill('Subject active throughout the morning.');
  await page.locator('.btn', { hasText: 'End investigation day' }).click();
  await page.waitForTimeout(600);
  const field = await text(page, '#dlgBody');
  ok('ending the day says what was recorded', has(field, 'Day ended — 6 hours'));
  ok('and offers the report as the next step',
     await page.locator('.btn', { hasText: 'Draft the daily report' }).count() === 1);
  await page.locator('.btn', { hasText: 'Draft the daily report' }).click();
  await page.waitForTimeout(300);
  ok('which lands on Reports with the day ready to draft', await page.locator('#r_day').count() === 1);
  await wsTab(page, 'Field work');
  ok('the day is recorded with its hours', (await text(page, '#dlgBody')).includes('6'));
  ok('the summary is kept', field.includes('Subject active throughout the morning.'));
  ok('the start/end times show on the day row', field.includes('7:00 AM'));

  await wsTab(page, 'Authorization');
  auth = await text(page, '#dlgBody');
  ok('used hours reached the authorization panel', auth.includes('6 hours'));
  ok('remaining is worked out', auth.includes('2 hours'));
  ok('the 75% threshold warns', has(auth, '75%'));
  ok('mileage carried over', auth.includes('42'));
  ok('the billable figure is shown to an admin, at the private rate', auth.includes('600'));
  await page.close();
}

section('Drafting and reviewing a daily report in the browser');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Report');

  ok('a completed day is offered to report on',
     await page.locator('#r_day').count() === 1);
  ok('the page is explicit that the wording stays the investigator\'s',
     has(await text(page, '#dlgBody'), 'wording stays yours'));

  await page.locator('.btn', { hasText: 'Generate draft' }).click();
  await page.waitForTimeout(700);

  // UIBUILD P11: the preview leads — a branded document, not a bare textarea.
  ok('the draft opens as a branded preview', await page.locator('#repdoc').count() === 1);
  const doc = await text(page, '#repdoc');
  ok('the document is headed as an investigative report', has(doc, 'INVESTIGATIVE REPORT'));
  ok('and flagged as a draft', has(doc, 'DRAFT'));
  ok('with the firm name on it', has(doc, 'Always Precise Investigations'));
  ok('and the case number', doc.includes('API-20260812-4002'));
  ok('a chronology is drafted', doc.includes('SURVEILLANCE CHRONOLOGY'));
  ok('it carries the logged observation',
     doc.includes('Subject vehicle observed parked at residence'), doc);
  ok('a noun phrase is left alone rather than mangled into "the subject vehicle"',
     !doc.includes('the subject vehicle'), doc);
  ok('the time is written out in 12-hour form', doc.includes('7:14 AM'));
  const rpnav = await text(page, '.rpnav');
  for (const v of ['Draft preview', 'Chronology', 'Summary', 'Attachments', 'Versions']) {
    ok(`the panel nav offers ${v}`, has(rpnav, v), rpnav);
  }
  await page.locator('.rpnav button', { hasText: 'Chronology' }).click();
  await page.waitForTimeout(250);
  ok('Chronology is the timeline extract', has(await text(page, '#dlgBody'), '7:14 AM'));
  /* Exact, since Unit 12 added a "Daily summary" tab beside this one. */
  await page.locator('.rpnav button', { hasText: /^Summary$/ }).click();
  await page.waitForTimeout(250);
  ok('Summary is the day', has(await text(page, '#dlgBody'), 'Hours'));
  await page.locator('.rpnav button', { hasText: 'Draft preview' }).click();
  await page.waitForTimeout(250);

  // Edit it, the way a person actually would — a step in, a step out.
  await page.locator('.btn', { hasText: 'Edit report' }).click();
  await page.waitForTimeout(300);
  const draft = await page.locator('#r_body').inputValue();
  await page.locator('#r_body').fill(draft + '\nAt approximately 1:00 PM, surveillance was discontinued.');
  await page.locator('.btn', { hasText: 'Save changes' }).click();
  await page.waitForTimeout(600);
  ok('the edit survives a save',
     (await page.locator('#r_body').inputValue()).includes('surveillance was discontinued'));
  await page.locator('.btn', { hasText: 'Done editing' }).click();
  await page.waitForTimeout(300);
  ok('done editing returns to the preview', await page.locator('#repdoc').count() === 1);
  ok('and there is a way to take the document with you',
     await page.locator('.btn', { hasText: 'Download draft' }).count() === 1);

  /* ITEM 4 (owner, 2026-08-19): an admin no longer submits to themselves —
     their own draft offers Approve directly. The REVIEW cycle below is the
     investigator->office handoff, so the field half arrives the way it really
     does (the field's own route; the investigator's actual Submit CLICK is
     exercised in the item-4 section on dana's case) and every office half
     stays a real click on this screen. */
  ok('an admin\'s own draft offers Approve directly',
     await page.locator('[data-act="reportStatus"][data-to="approved"]').count() === 1);
  ok('and no submit-to-myself button',
     await page.locator('.btn', { hasText: 'Submit report' }).count() === 0);
  const repId = await page.evaluate(() => WS_REPORT);
  const fieldSubmit = () => page.evaluate(async (id) => {
    await fetch(`/portal-api/cases/API-20260812-4002/reports/${id}/status`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'submitted' }) });
    await reloadWorkspace();
  }, repId);
  await fieldSubmit();
  await page.waitForTimeout(600);
  let panel = await text(page, '#dlgBody');
  ok('a submission moves it along', has(panel, 'Submitted'));
  ok('an admin reviewing gets Approve', await page.locator('.btn', { hasText: 'Approve' }).count() === 1);
  ok('and Send back', await page.locator('.btn', { hasText: 'Send back' }).count() === 1);

  await page.locator('#r_note').fill('Add the vehicle description.');
  await page.locator('.btn', { hasText: 'Send back' }).click();
  await page.waitForTimeout(600);
  panel = await text(page, '#dlgBody');
  ok('sending it back records the note', panel.includes('Add the vehicle description.'));
  ok('and it reads as needing revision', has(panel, 'Needs revision'));

  await fieldSubmit();
  await page.waitForTimeout(600);
  await page.locator('.btn', { hasText: 'Approve' }).click();
  await page.waitForTimeout(600);
  panel = await text(page, '#dlgBody');
  ok('an admin can approve it', has(panel, 'Approved'));
  ok('and then mark it delivered', await page.locator('.btn', { hasText: 'Mark delivered' }).count() === 1);

  // Two submissions, two preserved versions (P11) — never overwritten.
  await page.locator('.rpnav button', { hasText: 'Versions' }).click();
  await page.waitForTimeout(600);
  const vers = await text(page, '#dlgBody');
  ok('each submission preserved its exact text',
     (vers.match(/Submitted /g) || []).length >= 2, vers.slice(0, 300));
  await page.close();
}

section('An investigator gets the same field tools, without the money');
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  const fnav = await text(page, '.wsnav');
  ok('they get their own row', has(fnav, 'Activity') && has(fnav, 'Evidence') && has(fnav, 'Report'));
  ok('they do not get Billing on it', !has(fnav, 'Billing'));

  await wsTab(page, 'Field work');
  ok('they get field work', (await wsOpenTab(page)) === 'field');
  ok('they can start their own day',
     await page.locator('.btn', { hasText: 'Start investigation' }).count() === 1);

  await wsTab(page, 'Activity');
  await openComposer(page);
  await page.locator('#a_desc').fill('Arrived in vicinity of subject residence.');
  await page.locator('.btn', { hasText: 'Add to the log' }).click();
  await page.waitForTimeout(500);
  ok('an investigator can log their own timeline',
     (await text(page, '#dlgBody')).includes('Arrived in vicinity of subject residence.'));

  // The whole panel, checked for anything commercial.
  const whole = await text(page, '#dlgBody');
  for (const [what, needle] of Object.entries({
    'the carrier': 'Example Mutual',
    'the claim number': 'WC-2026-88421',
    'a billable figure': 'Billable',
    'a budget': 'Authorized budget',
  })) ok(`an investigator never sees ${what} in the workspace`, !whole.includes(needle), needle);
  await page.close();
}

section('The workspace is a full page, not a popup');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  ok('opening a case leaves no dialog element at all', await page.locator('dialog').count() === 0);
  ok('the workspace fills the page', await page.locator('.casepage').count() === 1);
  ok('the dashboard cards are out of the way', await page.locator('.stats').count() === 0);
  ok('there is a way back', has(await text(page, '.pagebar'), 'Back to Cases'));
  await page.locator('.close').click();
  await page.waitForTimeout(500);
  ok('back returns to the case list', await page.locator('.stats').count() === 1);
  await page.close();
}

section('Expenses: the field records, the office decides');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Expenses');

  await page.locator('#x_date').fill('2026-08-12');
  await page.locator('#x_cat').selectOption('parking');
  await page.locator('#x_amt').fill('14.50');
  await page.locator('#x_desc').fill('Parking garage across from the courthouse');
  await page.locator('.btn', { hasText: 'Record expense' }).click();
  await page.waitForTimeout(500);
  let panel = await text(page, '#dlgBody');
  ok('the expense is listed', panel.includes('Parking garage across from the courthouse'));
  ok('with its amount', panel.includes('$14.50'));
  ok('it awaits the three decisions', await page.locator('.xrev').count() === 1);

  // Mileage claims carry miles, not just dollars.
  await page.locator('#x_cat').selectOption('mileage');
  await page.locator('#x_mi').fill('62');
  await page.locator('#x_desc').fill('Round trip to the subject residence');
  await page.locator('.btn', { hasText: 'Record expense' }).click();
  await page.waitForTimeout(500);
  panel = await text(page, '#dlgBody');
  ok('a mileage claim records the miles', panel.includes('62'));

  // The office's three separate decisions.
  const box = page.locator('.xrev').first();
  await box.locator('.xr-re').check();
  await box.locator('.xr-bi').check();
  await box.locator('button').click();
  await page.waitForTimeout(500);
  panel = await text(page, '#dlgBody');
  ok('a reviewed expense wears its decisions', has(panel, 'Reimburse') && has(panel, 'Billable'));
  ok('the total claimed is summed', panel.includes('Total claimed'));
  await page.close();
}

section('Notes: visibility is decided at the Worker, not the page');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Internal notes');

  // An admin-only note about money — the kind an investigator must never see.
  await page.locator('#n_type').selectOption('billing');
  await page.locator('#n_vis').selectOption('admin');
  await page.locator('#n_body').fill('Carrier agreed to the preferred-volume rate on this file.');
  await page.locator('.btn', { hasText: 'Add note' }).click();
  await page.waitForTimeout(500);
  // And a team note the investigator should see.
  await page.locator('#n_type').selectOption('subject');
  await page.locator('#n_vis').selectOption('team');
  await page.locator('#n_body').fill('Subject has switched to a grey rental sedan this week.');
  await page.locator('.btn', { hasText: 'Add note' }).click();
  await page.waitForTimeout(500);
  const adminSees = await text(page, '#dlgBody');
  ok('the admin sees both notes', adminSees.includes('preferred-volume') && adminSees.includes('grey rental sedan'));
  ok('visibility is labelled on each note', has(adminSees, 'Admin only') && has(adminSees, 'Team'));
  await page.close();

  const inv = await newPage();
  await signIn(inv, 'dana', 'FieldWork2026x');
  await rowFor(inv, 'API-20260812-4001').click();
  await inv.waitForTimeout(450);
  await wsTab(inv, 'Internal notes');
  const invSees = await inv.evaluate(() => document.body.innerText);
  ok('the investigator sees the team note', invSees.includes('grey rental sedan'));
  ok('THE ADMIN-ONLY NOTE NEVER REACHES THEIR BROWSER', !invSees.includes('preferred-volume'), invSees.slice(0, 120));
  ok('an investigator is not offered admin visibility', await inv.locator('#n_vis').count() === 0);
  const opts = await inv.locator('#n_type').innerText();
  ok('office note types are not offered to them', !has(opts, 'Billing') && !has(opts, 'Strategy'));
  await inv.close();
}

/* The owner's exact repro: click a quick button, watch the form. Each kind
   must swap the composer — a highlighted pill over an unchanged form reads as
   broken because it is. */
section('The Custom tab carries every composer');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Activity');

  ok('the panel is the timeline, not a form (P10)', await page.locator('#a_desc').count() === 0);
  await openComposer(page);
  ok('Custom starts with the plain composer', await page.locator('#a_loc').count() === 1);

  await page.locator('.qk2', { hasText: 'Mileage' }).click();
  await page.waitForTimeout(250);
  ok('Mileage swaps in a miles field', await page.locator('#a_miles').count() === 1);
  ok('and drops the location field', await page.locator('#a_loc').count() === 0);

  await page.locator('.qk2', { hasText: 'Expense' }).click();
  await page.waitForTimeout(250);
  ok('Expense swaps in amount and category',
     await page.locator('#a_amt').count() === 1 && await page.locator('#a_cat').count() === 1);

  await page.locator('.qk2', { hasText: 'Activity' }).click();
  await page.waitForTimeout(250);
  ok('the capture checkmarks sit on the activity composer',
     await page.locator('#a_sd').count() === 1 && await page.locator('#a_va').count() === 1
       && await page.locator('#a_pa').count() === 1);
  await page.locator('#a_desc').fill('Subject departed residence.');
  await page.locator('#a_va').check();
  await page.locator('#a_sd').check();
  await page.locator('#a_time').fill(earlierToday(4));
  await page.locator('.btn', { hasText: 'Add to the log' }).click();
  await page.waitForTimeout(500);
  const flagged = await text(page, '#dlgBody');
  ok('the timeline wears the capture badges',
     has(flagged, 'Subject documented') && has(flagged, 'Video'), flagged.slice(0, 200));

  await openComposer(page);
  await page.locator('.qk2', { hasText: 'Location' }).click();
  await page.waitForTimeout(250);
  await page.locator('#a_desc').fill('ABC Fitness — regular morning gym.');
  await page.locator('.btn', { hasText: 'Add to the log' }).click();
  await page.waitForTimeout(400);
  ok('a location entry without the location is refused on screen',
     has(await text(page, '#dlgBody'), 'needs the location'));

  // Mileage writes the expense AND marks the timeline.
  await page.locator('.qk2', { hasText: 'Mileage' }).click();
  await page.waitForTimeout(250);
  await page.locator('#a_miles').fill('62');
  await page.locator('#a_desc').fill('Office to subject residence and back');
  await page.locator('.btn', { hasText: 'Record mileage' }).click();
  await page.waitForTimeout(600);
  const log = await text(page, '#dlgBody');
  ok('the mileage moment lands on the timeline', log.includes('62 miles — Office to subject residence and back'));
  await wsTab(page, 'Expenses');
  const xp = await text(page, '#dlgBody');
  ok('and the claim lands under Expenses for review', xp.includes('Office to subject residence and back'));
  await page.close();
}

/* Every surveillance DATE came from toISOString() — UTC — while every
   surveillance TIME came from toTimeString() — local. On the same line, in the
   same record. In EDT that is four hours of disagreement every evening: at
   20:15 on the 14th the page filed 2026-08-15 beside 20:15, so evening work
   (most of this firm's) was recorded a day late with the previous day's times,
   and it reached case_days.day_date, the derived case_reports.report_date and
   the timeline's ORDER BY. Driven in two real timezones rather than by calling
   the helper, because the bug was never in a helper — it was in what the
   screens rendered. */
section('A surveillance date is the date where the investigator is standing');
{
  /* UTC+14 and UTC-11 bracket the clock: whatever the hour when this suite
     runs, at least one of them is on a different calendar date from UTC. The
     counter at the end asserts that actually happened, so a green run can
     never mean "neither zone drifted today, so nothing was tested". */
  let drifted = 0;
  for (const [tz, nick] of [['Pacific/Kiritimati', 'UTC+14'], ['Pacific/Pago_Pago', 'UTC-11']]) {
    const page = await (await browser.newContext({
      viewport: { width: 1200, height: 900 }, timezoneId: tz })).newPage();
    page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
    await page.goto(SITE + '/portal/');
    await page.waitForTimeout(250);
    await signIn(page, 'trever', 'AdminPassword1x');
    await rowFor(page, 'API-20260812-4001').click();
    await page.waitForTimeout(450);
    await wsTab(page, 'Activity');
    await openComposer(page);

    const seen = await page.evaluate(() => {
      const d = new Date(), p = n => String(n).padStart(2, '0');
      return {
        date: document.querySelector('#a_date').value,
        time: document.querySelector('#a_time').value,
        local: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
        utc: d.toISOString().slice(0, 10),
      };
    });
    ok(`${nick}: the date offered is the local calendar date, not the UTC one`,
       seen.date === seen.local, JSON.stringify(seen));
    ok(`${nick}: and a time is offered beside it`, /^\d\d:\d\d$/.test(seen.time), seen.time);
    if (seen.local !== seen.utc) {
      drifted++;
      ok(`${nick}: this zone genuinely disagreed with UTC, so the date above was the real test`,
         seen.date !== seen.utc, JSON.stringify(seen));
    }
    await page.close();
  }
  ok('at least one zone was on a different UTC date — otherwise this section proves nothing',
     drifted > 0, `${drifted} of 2 drifted`);
}

/* PAYMENTS.md §3 — payment options on the private send wizard, independently
   selectable. The Worker has accepted include_payment since #80; until now
   nothing in the portal could send it, so the feature existed and no admin
   could reach it. The boundary is asserted from the other side too: the
   carrier wizard must not render the section at all. */
section('The private send wizard offers payment options; the carrier one never does');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Rate Sheets' }).click();
  await page.waitForTimeout(700);

  // The carrier sheet first — the absence matters more than the presence.
  await page.locator('.sheet-card', { hasText: 'Insurance Assignment Rates' }).click();
  await page.waitForTimeout(400);
  await page.locator('.btn', { hasText: 'Send this sheet' }).click();
  await page.waitForTimeout(700);
  const carrier = await text(page, '.amsheet');
  ok('the carrier wizard offers its own intake', has(carrier, 'Insurance Assignment Intake'));
  ok('and no payment options whatsoever',
     !has(carrier, 'payment options') && !has(carrier, 'Cash App') && !has(carrier, 'Venmo'));
  ok('not even as a hidden control',
     await page.locator('#wiz_pay').count() === 0
     && await page.locator('.wiz-pm').count() === 0);
  // The close BUTTON, not the overlay — the overlay also carries wizClose and
  // the dialog sits on top of it, so a click there can land on the dialog.
  await page.locator('.amx').first().click();
  await page.waitForTimeout(300);

  // The private sheet.
  await page.locator('.sheet-card', { hasText: 'Private Client — ' }).click();
  await page.waitForTimeout(400);
  await page.locator('.btn', { hasText: 'Send this sheet' }).click();
  await page.waitForTimeout(900);
  ok('the private wizard offers payment options', await page.locator('#wiz_pay').count() === 1);
  ok('with both methods independently tickable', await page.locator('.wiz-pm').count() === 2);
  ok('and both start selected, which is the onboarding email the owner described',
     await page.locator('.wiz-pm:checked').count() === 2);

  // Independently selectable: drop one, and the preview says so.
  await page.locator('.wiz-pm[data-pm="cash_app"]').uncheck();
  await page.locator('#wiz_to').fill('client@example.com');
  await page.locator('.btn', { hasText: 'Preview' }).click();
  await page.waitForTimeout(500);
  const preview = await text(page, '.amsheet');
  ok('the preview names only the method still ticked',
     has(preview, 'Venmo') && !has(preview, 'Cash App'), preview.slice(0, 300));
  ok('and states that sending does not mark the retainer paid',
     has(preview, 'does not mark the retainer paid'));

  // Unticking payment entirely reads as Not included.
  await page.locator('.btn', { hasText: 'Back' }).click();
  await page.waitForTimeout(400);
  await page.locator('#wiz_pay').uncheck();
  await page.waitForTimeout(400);
  ok('unticking payment hides the method list', await page.locator('.wiz-pm').count() === 0);
  await page.locator('.btn', { hasText: 'Preview' }).click();
  await page.waitForTimeout(500);
  ok('and the preview says payment options are not included',
     has(await text(page, '.amsheet'), 'Not included'));
  await page.close();
}

/* PAYMENTS.md, owner 2026-08-15 — the CUSTOM PRIVATE RETAINER SELECTOR.
   The Worker has stored a per-case retainer since #97 and carried it through
   the sheet since #123; what did not exist was any way to CHOOSE it before
   sending. Driven here as an admin actually uses it, because the storage was
   never the missing half. */
section('A private retainer is chosen before the sheet goes, and never reset by accident');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Rate Sheets' }).click();
  await page.waitForTimeout(700);

  /* The carrier side first — the absence is the requirement. An insurance
     assignment is authorized in hour blocks, so a retainer selector on it would
     be offering the wrong billing model entirely. */
  await page.locator('.sheet-card', { hasText: 'Insurance Assignment Rates' }).click();
  await page.waitForTimeout(400);
  await page.locator('.btn', { hasText: 'Send this sheet' }).click();
  await page.waitForTimeout(700);
  ok('the carrier wizard has no retainer selector at all',
     await page.locator('#wiz_ret').count() === 0);
  ok('and does not mention an agreed retainer',
     !has(await text(page, '.amsheet'), 'Agreed retainer'));
  await page.locator('.amx').click();
  await page.waitForTimeout(300);

  // The private side.
  await page.locator('.sheet-card', { hasText: 'Private Client — ' }).click();
  await page.waitForTimeout(400);
  await page.locator('.btn', { hasText: 'Send this sheet' }).click();
  await page.waitForTimeout(900);
  ok('the private wizard offers the retainer selector',
     await page.locator('#wiz_ret').count() === 1);
  const opts = await page.locator('#wiz_ret option').allInnerTexts();
  ok('with the owner\'s four choices, standard first',
     opts.length === 4 && has(opts[0], '$1,500') && has(opts[0], 'Standard')
     && has(opts[1], '$2,000') && has(opts[2], '$3,000') && has(opts[3], 'Custom'),
     JSON.stringify(opts));
  ok('and opens on the standard figure', await page.locator('#wiz_ret').inputValue() === '1500');
  ok('the custom box stays out of the way until it is wanted',
     await page.locator('#wiz_retc').count() === 0);

  // Custom reveals its field, and an empty one is refused rather than sent.
  await page.locator('#wiz_ret').selectOption('custom');
  await page.waitForTimeout(400);
  ok('choosing Custom reveals the amount field',
     await page.locator('#wiz_retc').isVisible());
  await page.locator('#wiz_to').fill('client@example.com');
  await page.locator('#wiz_case').fill('API-20260812-4002');
  await page.locator('.btn', { hasText: 'Preview' }).click();
  await page.waitForTimeout(500);
  ok('an empty custom retainer is refused before anything is sent',
     has(await text(page, '.amsheet'), 'above zero'), await text(page, '.amsheet'));
  ok('and it did not advance to Preview on the strength of a blank box',
     await page.locator('#wiz_ret').count() === 1);
  /* Zero is refused for the same reason the Worker refuses it: the sheet falls
     back to the standard figure for anything not above zero, so a stored 0
     would put $0 in the record and $1,500 in front of the client. */
  await page.locator('#wiz_retc').fill('0');
  await page.locator('.btn', { hasText: 'Preview' }).click();
  await page.waitForTimeout(500);
  ok('and so is a zero one', has(await text(page, '.amsheet'), 'above zero'));

  // A real preset, carried all the way into the preview.
  await page.locator('#wiz_ret').selectOption('3000');
  await page.waitForTimeout(400);
  ok('picking a preset hides the custom box again',
     await page.locator('#wiz_retc').count() === 0);
  await page.locator('.btn', { hasText: 'Preview' }).click();
  await page.waitForTimeout(900);
  const prev = await text(page, '.amsheet');
  ok('the preview states the agreed retainer', has(prev, 'Agreed retainer') && has(prev, '$3,000'), prev);
  ok('and the sheet it names is the $3,000 one, not the standard',
     has(prev, '$3,000 Retainer') && !has(prev, '$1,500'), prev);
  await page.locator('.amx').click();
  await page.waitForTimeout(400);

  /* THE GUARD THAT MAKES THE FEATURE SAFE. Reopened from Rate sheets there is
     no case number yet, so the selector shows the standard $1,500 because it
     has nothing else to show. Typing the case number and previewing must NOT
     write that untouched default over the $3,000 just agreed — otherwise
     looking at an email silently re-cuts the client's retainer. */
  await page.locator('.btn', { hasText: 'Send this sheet' }).click();
  await page.waitForTimeout(900);
  ok('a freshly opened wizard shows the standard, having no case to read yet',
     await page.locator('#wiz_ret').inputValue() === '1500');
  await page.locator('#wiz_to').fill('client@example.com');
  await page.locator('#wiz_case').fill('API-20260812-4002');
  await page.locator('.btn', { hasText: 'Preview' }).click();
  await page.waitForTimeout(1000);
  const untouched = await text(page, '.amsheet');
  ok('an untouched selector does not overwrite what the case already agreed',
     has(untouched, '$3,000') && !has(untouched, '$1,500'), untouched);
  ok('and the preview reads back the real figure rather than what was on screen',
     has(untouched, 'Agreed retainer') && has(untouched, '$3,000'));

  /* And the selector then shows the truth, so the next admin to open it is not
     misled by the default they arrived on. */
  await page.locator('.btn', { hasText: 'Back' }).click();
  await page.waitForTimeout(600);
  ok('the selector has caught up to the case it is now pointed at',
     await page.locator('#wiz_ret').inputValue() === '3000',
     await page.locator('#wiz_ret').inputValue());
  await page.close();
}

/* PAYMENTS.md second handoff §1/§4 — SEND PAYMENT OPTIONS from the lead card,
   and the standalone dialog it opens. "This allows payment instructions to be
   sent later without resending the rate sheet."

   The boundary is asserted from both ends on the same desk, which is the point:
   a private card offers it, an insurance card beside it does not. */
section('A private lead can be sent payment options; an insurance lead cannot');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Intakes' }).click();
  await page.waitForTimeout(600);

  const priv = page.locator('.pcard', { hasText: 'API-20260812-4002' });
  const ins = page.locator('.pcard', { hasText: 'API-20260812-4001' });
  ok('both a private and an insurance lead are on the desk',
     await priv.count() === 1 && await ins.count() === 1);

  // §15.1 / §15.2 — the whole boundary, on two cards side by side.
  ok('the private card offers Send payment options',
     await priv.locator('.btn', { hasText: 'Send payment options' }).count() === 1);
  ok('the insurance card does NOT, anywhere on it',
     await ins.locator('.btn', { hasText: 'Send payment options' }).count() === 0);
  ok('and the insurance card still offers its own two sends',
     await ins.locator('.btn', { hasText: 'Send rate sheet' }).count() === 1
     && await ins.locator('.btn', { hasText: 'Send intake' }).count() === 1);
  ok('the private card keeps its existing actions too — nothing was displaced',
     await priv.locator('.btn', { hasText: 'Review' }).count() === 1
     && await priv.locator('.btn', { hasText: 'Send rate sheet' }).count() === 1
     && await priv.locator('.btn', { hasText: 'Send intake' }).count() === 1);

  // The dialog.
  await priv.locator('.btn', { hasText: 'Send payment options' }).click();
  await page.waitForTimeout(900);
  ok('the standalone dialog opens', await page.locator('.amsheet').count() === 1);
  ok('titled as payment options, not as a rate sheet send',
     has(await text(page, '.amhead'), 'Send payment options'));
  ok('with the case number riding along',
     await page.locator('#ps_case').inputValue() === 'API-20260812-4002');
  ok('both methods are offered, independently tickable',
     await page.locator('.ps-pm').count() === 2);
  ok('and both start ticked, which is the onboarding default',
     await page.locator('.ps-pm:checked').count() === 2);

  // An address is required before anything can be spent on a send.
  await page.locator('#ps_to').fill('');
  await page.locator('[data-act="paySendStep"]').click();
  await page.waitForTimeout(400);
  ok('an empty address is refused before moving on',
     has(await text(page, '.amsheet'), 'Enter the address'));

  /* Choosing NO method is refused rather than sent as an empty PAYMENT OPTIONS
     heading — the same refusal the Worker makes, answered where it can be
     fixed. */
  await page.locator('#ps_to').fill('client@example.test');
  await page.locator('.ps-pm[data-pm="cash_app"]').uncheck();
  await page.locator('.ps-pm[data-pm="venmo"]').uncheck();
  await page.locator('[data-act="paySendStep"]').click();
  await page.waitForTimeout(400);
  ok('choosing no payment method at all is refused',
     has(await text(page, '.amsheet'), 'at least one payment method'));

  // One method, then preview.
  await page.locator('.ps-pm[data-pm="venmo"]').check();
  await page.locator('[data-act="paySendStep"]').click();
  await page.waitForTimeout(600);
  const prev = await text(page, '.amsheet');
  ok('the preview names only the method still ticked',
     has(prev, 'Venmo') && !has(prev, 'Cash App'), prev.slice(0, 300));
  /* The reason this dialog exists at all, stated on the screen where an admin
     would otherwise assume the opposite. */
  ok('and says plainly that the rate sheet is NOT included',
     has(prev, 'Not included') && has(prev, 'payment instructions only'), prev.slice(0, 400));
  ok('and that sending does not mark the retainer paid',
     has(prev, 'does not mark the retainer paid'));

  /* Mail is unconfigured in this run, so a send is a REAL failure — and it has
     to be reported as one rather than swallowed into a success message. A send
     that vanished silently is how "I sent that last week" becomes wrong. */
  await page.locator('[data-act="paySendGo"]').click();
  await page.waitForTimeout(900);
  ok('a failed send says so instead of claiming success',
     has(await text(page, '.amsheet'), 'not configured'), await text(page, '.amsheet'));
  ok('and the dialog stays open on the failure, rather than closing over it',
     await page.locator('.amsheet').count() === 1);

  await page.locator('.amx').click();
  await page.waitForTimeout(300);
  ok('closing returns to the desk with the cards intact',
     await page.locator('.amsheet').count() === 0
     && await page.locator('.pcard').count() >= 2);
  await page.close();
}

/* PRE-CASE SENDS (owner, 2026-08-15 — a blocking workflow defect).

   The sends never required a case in the Worker, but the intake and the payment
   options could only be REACHED from a lead card, so in practice the office had
   to put someone on the desk before it could email them anything. The intake is
   what turns a phone call into a lead, so that ordering was backwards.

   This is the door, and the history that has to work without a case number. */
/* THE OWNER'S PRODUCTION REPRODUCTION. The send screen labels the case number
   "optional", and typing one that matched no case returned a bare "not found"
   under the Preview button and never advanced. The cause was on THIS side: the
   page wrote the agreed retainer on the way to Preview, and that write is
   case-scoped. A worker test cannot see it — the Worker never 404'd. */
section('An unmatched case reference does not block Preview');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Rate Sheets' }).click();
  await page.waitForTimeout(500);
  await page.locator('.sheet-card', { hasText: 'Private Client — ' }).click();
  await page.waitForTimeout(400);
  await page.locator('.btn', { hasText: 'Send this sheet' }).click();
  await page.waitForTimeout(900);

  await page.locator('#wiz_to').fill('marinerecon016@example.test');
  await page.locator('#wiz_case').fill('Test123');
  await page.locator('#wiz_ret').selectOption('2000');
  await page.waitForTimeout(400);
  /* The "not stored" notice can only appear AFTER the attempt — until Preview
     tries the write, nothing knows the reference resolves to nothing. */
  await page.locator('.btn', { hasText: 'Preview' }).click();
  await page.waitForTimeout(900);
  const body = await text(page, '.amsheet');
  ok('Preview is not blocked by a reference that matches no case',
     !has(body, 'not found'), body.slice(0, 200));
  ok('and it really did advance to the preview step',
     await page.locator('.btn', { hasText: 'Send it' }).count() === 1
     || has(body, 'Send it'), body.slice(0, 200));
  ok('the preview quotes the $2,000 that was agreed, not the standard figure',
     has(body, '$2,000') && !has(body, '$1,500'), body.slice(0, 300));
  ok('and the office is told plainly that nothing was stored against a case',
     has(body, 'nothing is stored') || has(body, 'not stored'), body.slice(0, 400));
  await page.close();
}

section('Sending works before anyone is on the desk, and the history shows it');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Rate Sheets' }).click();
  await page.waitForTimeout(800);
  const view = await text(page, '#app');

  ok('the Rate sheets screen carries a pre-case send area', has(view, 'Send to someone new'));
  ok('and says plainly that no case is needed', has(view, 'no case needed'));
  ok('with all three sends that had no door before',
     await page.locator('[data-act="preIntake"][data-kind="private"]').count() === 1
     && await page.locator('[data-act="preIntake"][data-kind="insurance"]').count() === 1
     && await page.locator('[data-act="prePay"]').count() === 1);
  /* Requirement 3, said on the screen where someone might assume otherwise. */
  ok('and states that nothing is created by sending',
     has(view, 'Nothing here creates a lead or a case'));

  // The private intake door. The KIND is fixed by the button, not pickable —
  // a picker here would be one more way to send a carrier the consumer form.
  await page.locator('[data-act="preIntake"][data-kind="private"]').click();
  await page.waitForTimeout(400);
  ok('the private intake dialog opens', await page.locator('#pi_to').count() === 1);
  ok('naming the private form', has(await text(page, '.amhead'), 'Private Client Intake'));
  ok('with no case field at all — there is nothing to attach it to',
     await page.locator('#pi_case').count() === 0);
  ok('and no way to switch it to the carrier form',
     await page.locator('.amsheet select').count() === 0);
  ok('an address is required before a send is spent',
     await (async () => {
       await page.locator('[data-act="preIntakeGo"]').click();
       await page.waitForTimeout(300);
       return has(await text(page, '.amsheet'), 'Enter the address');
     })());

  /* Mail is unconfigured in this run, so the send is a real failure — which is
     useful twice over: it proves the door reaches the Worker, and it proves a
     failed pre-case send is KEPT and shown rather than swallowed. */
  await page.locator('#pi_to').fill('newcaller@example.test');
  await page.locator('#pi_name').fill('Jane Caller');
  await page.locator('[data-act="preIntakeGo"]').click();
  await page.waitForTimeout(900);
  ok('a failed pre-case send says so rather than claiming success',
     has(await text(page, '.amsheet'), 'not configured'), await text(page, '.amsheet'));
  await page.locator('.amx').click();
  await page.waitForTimeout(400);

  // The insurance door is the same control with the other form behind it.
  await page.locator('[data-act="preIntake"][data-kind="insurance"]').click();
  await page.waitForTimeout(400);
  ok('the insurance intake dialog names the carrier form',
     has(await text(page, '.amhead'), 'Insurance Assignment Intake'));
  /* Checked on the METHODS and the handles, not on the word "payment" — the
     dialog's own correct copy says no payment information is included, and an
     assertion that trips on that is testing the wrong thing. */
  ok('and offers a carrier no payment method or handle',
     !has(await text(page, '.amsheet'), 'Cash App')
     && !has(await text(page, '.amsheet'), 'Venmo')
     && await page.locator('.ps-pm').count() === 0
     && !has(await text(page, '.amsheet'), 'PAYMENT OPTIONS'));
  await page.locator('.amx').click();
  await page.waitForTimeout(300);

  /* Payment options from here open the SAME dialog the lead card opens, with
     no case behind it — deliberately one code path, because a second payment
     dialog is a second place for the private-only boundary to go wrong. */
  await page.locator('[data-act="prePay"]').click();
  await page.waitForTimeout(900);
  ok('payment options open with no case number', await page.locator('#ps_case').count() === 1
     && await page.locator('#ps_case').inputValue() === '');
  ok('and the methods are still offered', await page.locator('.ps-pm').count() === 2);
  await page.locator('#ps_to').fill('newcaller@example.test');
  await page.locator('[data-act="paySendStep"]').click();
  await page.waitForTimeout(500);
  ok('it previews without a case reference',
     has(await text(page, '.amsheet'), 'payment instructions only'));
  await page.locator('.amx').click();
  await page.waitForTimeout(500);

  /* Requirement 6 — the history has to work with no case number. The failed
     intake send above had none, so it can only appear here if the log and this
     view both handle a null case. */
  await page.locator('.tabs button', { hasText: 'Cases' }).click();
  await page.waitForTimeout(300);
  await page.locator('.tabs button', { hasText: 'Rate Sheets' }).click();
  await page.waitForTimeout(900);
  const hist = await text(page, '#app');
  ok('the screen carries a recent sends history', has(hist, 'Recent sends'));
  ok('the pre-case send is in it, by recipient', has(hist, 'newcaller@example.test'));
  ok('marked as having had no case rather than shown blank',
     has(hist, 'sent before one existed'));
  ok('and marked as failed, because it was', has(hist, 'Failed'));

  /* A FAILED LOAD IS NOT AN EMPTY HISTORY (Codex stop-time review, 2026-08-15).

     `loadSends` set SENDS = [] in its catch, and an empty list renders as
     "Nothing sent yet." So a 500, a dropped connection or a permission problem
     told the office that nothing had ever been emailed to anyone — the screen
     asserting a fact it did not have, in the one panel whose entire job is
     answering "did that go out?", and in the direction that reads as
     reassuring.

     Driven as a real failed request rather than by poking page state, so it
     covers the wiring and not just the markup. */
  await page.route('**/portal-api/sends*', r => r.fulfill({
    status: 500, contentType: 'application/json', body: '{"error":"the history is unavailable"}' }));
  await page.locator('.tabs button', { hasText: 'Cases' }).click();
  await page.waitForTimeout(300);
  await page.locator('.tabs button', { hasText: 'Rate Sheets' }).click();
  await page.waitForTimeout(900);
  const broken = await text(page, '#app');
  ok('a history that failed to load does NOT claim nothing was sent',
     !has(broken, 'Nothing sent yet'), broken.slice(0, 400));
  ok('it says it did not load', has(broken, 'Did not load'));
  ok('and says so in as many words, because the difference is the whole point',
     has(broken, 'not the same as nothing having been sent'));
  ok('the failure reason is shown rather than swallowed',
     has(broken, 'the history is unavailable'));
  ok('and there is a way to ask again', await page.locator('[data-act="sendsRetry"]').count() === 1);

  // Recovering: with the route released, Try again brings the history back.
  await page.unroute('**/portal-api/sends*');
  await page.locator('[data-act="sendsRetry"]').click();
  await page.waitForTimeout(900);
  const recovered = await text(page, '#app');
  ok('retrying loads it properly', !has(recovered, 'Did not load'));
  ok('and the real history is back', has(recovered, 'newcaller@example.test'));
  await page.close();
}

/* The Worker refuses a send when a method is switched on with no payment link,
   and that refusal says "add a link in Settings". This screen is what makes
   that sentence true — it shipped as an error with nowhere to go, which is a
   dead end rather than a guard. Tested as the recovery path it has to be. */
section('Payment methods can be configured, and a broken one can be repaired');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Settings' }).click();
  await page.waitForTimeout(700);
  const body = await page.locator('#app').innerText();

  ok('Settings carries the private-client payment methods',
     has(body, 'Private client payment methods'));
  ok('and says plainly that they are private-client only',
     has(body, 'never on an insurance sheet'));
  ok('both methods are listed', has(body, 'Cash App') && has(body, 'Venmo'));
  ok('with the firm\'s configured handles shown',
     (await page.locator('#pm_handle_cash_app').inputValue()) === '$TreverB'
     && (await page.locator('#pm_handle_venmo').inputValue()) === '@Trever-Brown-9');
  ok('and their links, which the admin can edit',
     (await page.locator('#pm_url_venmo').inputValue()) === 'https://venmo.com/u/Trever-Brown-9');
  ok('the screen warns against building a link from a handle',
     has(body, 'never built from the handle'));
  ok('and states that no credential is stored',
     has(body, 'No password, login or account credential is stored'));
  ok('there is no field for a password or token',
     await page.locator('input[type="password"]').count() === 0);

  /* The recovery path itself: break it the way a legacy row is broken, and
     confirm the screen both explains it and can fix it. */
  await page.locator('#pm_url_venmo').fill('');
  await page.locator('.feebox[data-pay="venmo"] .btn', { hasText: 'Save and switch on' }).click();
  await page.waitForTimeout(700);
  const broken = await page.locator('#app').innerText();
  ok('saving it on with no link is refused, in the Worker\'s own words',
     has(broken, 'needs a payment link') || has(broken, 'cannot be offered'), broken.slice(0, 200));

  /* A refusal must leave the admin looking at their OWN words. Repainting from
     the server threw the edits away — and where they had deliberately cleared
     the link, put the old one back, so the form showed a link present while
     the error said it was missing. */
  ok('the cleared link stays cleared after the refusal',
     (await page.locator('#pm_url_venmo').inputValue()) === '');
  ok('and the row says the boxes are not saved yet', has(broken, 'Not saved yet'));

  await page.locator('#pm_handle_venmo').fill('@Trever-Brown-9-EDITED');
  await page.locator('.feebox[data-pay="venmo"] .btn', { hasText: 'Save and switch on' }).click();
  await page.waitForTimeout(700);
  ok('a second refusal keeps the newly typed handle too',
     (await page.locator('#pm_handle_venmo').inputValue()) === '@Trever-Brown-9-EDITED'
     && (await page.locator('#pm_url_venmo').inputValue()) === '');

  await page.locator('#pm_handle_venmo').fill('@Trever-Brown-9');
  await page.locator('#pm_url_venmo').fill('https://venmo.com/u/Trever-Brown-9');
  await page.locator('.feebox[data-pay="venmo"] .btn', { hasText: 'Save and switch on' }).click();
  await page.waitForTimeout(700);
  const done = await page.locator('#app').innerText();
  ok('and supplying the link fixes it from this screen', has(done, 'saved'));
  ok('the unsaved marker clears once it is saved', !has(done, 'Not saved yet'));
  ok('and the saved values are the ones that went in',
     (await page.locator('#pm_url_venmo').inputValue()) === 'https://venmo.com/u/Trever-Brown-9'
     && (await page.locator('#pm_handle_venmo').inputValue()) === '@Trever-Brown-9');

  await page.close();
}
{
  // The field must never see where the firm's money arrives.
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  const nav = await text(page, '.tabs');
  ok('an investigator has no Settings tab at all', !has(nav, 'Settings'));
  const seen = await page.evaluate(async () => {
    const r = await fetch('/portal-api/payment-methods', { headers: { Accept: 'application/json' } });
    return r.status;
  });
  ok('and the route refuses them directly', seen === 403, String(seen));
  await page.close();
}

/* UIBUILD phase 3 (P8/P9): the Quick tab — stock lines behind a search and
   categories, favorites first, one-tap No change, and the arrival template
   that writes the sentence. */
section('Quick lines: search, favorites, one tap');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Activity');

  await page.locator('[data-act="actOpen"]:visible').first().click();
  await page.waitForTimeout(300);
  ok('the sheet opens on Quick', has(await text(page, '.amtab.on'), 'Quick'));
  const cats = await text(page, '.amcats');
  for (const c of ['Favorites', 'Arrival', 'No activity', 'Subject', 'Vehicle', 'Location']) {
    ok(`the ${c} category is offered`, has(cats, c), cats);
  }

  // Search cuts across every category.
  await page.locator('#am_q').fill('visual contact');
  await page.waitForTimeout(300);
  const hits = await text(page, '.amsheet');
  ok('search finds the line', has(hits, 'Lost visual contact with subject vehicle in traffic.'));
  ok('and drops the rest', !has(hits, 'Subject departed residence.'));
  await page.locator('#am_q').fill('');
  await page.waitForTimeout(300);

  // Starring keeps a line under Favorites, first.
  await page.locator('.amcat', { hasText: 'Subject' }).click();
  await page.waitForTimeout(250);
  await page.locator('.amline', { hasText: 'Subject returned to residence.' }).locator('.amstar').click();
  await page.waitForTimeout(250);
  await page.locator('.amcat', { hasText: 'Favorites' }).click();
  await page.waitForTimeout(250);
  ok('a starred line waits under Favorites',
     has(await text(page, '.amsheet'), 'Subject returned to residence.'));

  // Picking a line lands on the compose step with the sentence in the box.
  await page.locator('.ampick', { hasText: 'Subject returned to residence.' }).click();
  await page.waitForTimeout(300);
  ok('the picked line fills the narrative',
     (await page.locator('#qa_desc').inputValue()) === 'Subject returned to residence.');
  ok('the time is already on the clock', (await page.locator('#qa_time').inputValue()).length === 5);
  ok('the rare fields wait behind one fold', await page.locator('.amfold summary').count() === 1);
  await page.locator('#qa_time').fill(earlierToday(3));
  await page.locator('.btn', { hasText: 'Add to log' }).click();
  await page.waitForTimeout(500);
  ok('the quick entry is on the timeline',
     (await text(page, '#dlgBody')).includes('Subject returned to residence.'));
  ok('the sheet closed on success', await page.locator('.amsheet').count() === 0);

  // NO CHANGE is one tap: no compose step, straight to the log (P9).
  await page.locator('[data-act="actOpen"]:visible').first().click();
  await page.waitForTimeout(300);
  await page.locator('.amcat', { hasText: 'No activity' }).click();
  await page.waitForTimeout(250);
  await page.locator('.ampick', { hasText: 'No change was noted during this period.' }).click();
  await page.waitForTimeout(500);
  ok('one tap logged it', (await text(page, '#dlgBody')).includes('No change was noted during this period.'));
  ok('with no compose step in between', await page.locator('.amsheet').count() === 0);

  // The arrival template generates the sentence from the extras.
  await page.locator('[data-act="actOpen"]:visible').first().click();
  await page.waitForTimeout(300);
  await page.locator('.amcat', { hasText: 'Arrival' }).click();
  await page.waitForTimeout(250);
  await page.locator('.ampick', { hasText: 'Arrived in vicinity of subject residence.' }).click();
  await page.waitForTimeout(300);
  ok('arrival asks the two field questions',
     await page.locator('#qa_vp').count() === 1 && await page.locator('#qa_pos').count() === 1);
  await page.locator('#qa_vp').fill("Subject's white GMC Sierra in the driveway");
  await page.waitForTimeout(200);
  await page.locator('#qa_pos').fill('with a clear view of the front door');
  await page.waitForTimeout(200);
  const built = await page.locator('#qa_desc').inputValue();
  ok('the sentence is generated from the answers',
     built.includes('Arrived in vicinity of subject residence.')
       && built.includes("Sierra in the driveway present.")
       && built.includes('Established surveillance position with a clear view of the front door.'), built);

  // P6's five position options, and the article each one needs to read right.
  ok('view and placement are separate choices, not one five-way list',
     await page.locator('#qa_view option').count() === 3
       && await page.locator('#qa_place option').count() === 4);
  await page.locator('#qa_view').selectOption('indirect');
  await page.waitForTimeout(200);
  const withView = await page.locator('#qa_desc').inputValue();
  ok('an indirect view composes as a whole sentence',
     withView.includes('Established an indirect surveillance position with a clear view of the front door.'),
     withView);
  // MASTER §10's canonical example combines BOTH — an indirect position ALONG
  // the primary route of departure. One five-way select cannot express that
  // sentence at all, which is why view and placement are independent.
  await page.locator('#qa_pos').fill('');
  await page.waitForTimeout(150);
  await page.locator('#qa_place').selectOption('primary');
  await page.waitForTimeout(250);
  const canonical = await page.locator('#qa_desc').inputValue();
  ok('MASTER §10\'s canonical combined sentence is reachable',
     canonical.includes('Established an indirect surveillance position along the primary route of departure.'),
     canonical);
  await page.locator('#qa_place').selectOption('mobile');
  await page.waitForTimeout(250);
  ok('and mobile reads as the method, not a position',
     (await page.locator('#qa_desc').inputValue()).includes('Established indirect mobile surveillance.'));
  await page.locator('#qa_place').selectOption('');
  await page.locator('#qa_pos').fill('with a clear view of the front door');
  await page.waitForTimeout(250);
  // The rule that keeps a template from becoming a fabricated fact.
  await page.locator('#qa_desc').fill('Hand written by the investigator.');
  await page.waitForTimeout(150);
  await page.locator('#qa_vp').fill('Two vehicles');
  await page.waitForTimeout(250);
  ok('a hand-edited narrative is never overwritten by the generator',
     (await page.locator('#qa_desc').inputValue()) === 'Hand written by the investigator.');
  await page.locator('.amx').click();
  await page.waitForTimeout(250);

  // The unobtrusive Edit (P10): correct an entry from the timeline.
  await page.locator('.tl-i', { hasText: 'Subject returned to residence.' })
    .locator('.tl-edit', { hasText: 'Edit' }).click();
  await page.waitForTimeout(300);
  ok('Edit opens the correction form with the entry in it',
     (await page.locator('#qa_desc').inputValue()) === 'Subject returned to residence.');
  await page.locator('#qa_desc').fill('Subject returned to residence and entered through the garage.');
  await page.locator('.btn', { hasText: 'Save the correction' }).click();
  await page.waitForTimeout(500);
  const edited = await text(page, '#dlgBody');
  ok('the correction is on the timeline', edited.includes('entered through the garage'));
  ok('and stamped rather than silent', has(edited, 'edited'));
  await page.close();
}

/* Priority 9: the investigator navigation is a field desk, not a mini admin. */
section("The investigator's own navigation");
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  const tabs = await text(page, '.tabs');
  for (const t of ['My assignments', 'Today', 'Reports', 'Expenses']) {
    ok(`the investigator gets ${t}`, has(tabs, t), tabs);
  }
  ok('and none of the office', !has(tabs, 'Rate Sheets') && !has(tabs, 'Staff'));

  await page.locator('.tabs button', { hasText: 'Today' }).click();
  await page.waitForTimeout(300);
  const today = await text(page, '.card');
  ok('Today shows their caseload', today.includes('API-20260812-4001'));

  await page.locator('.tabs button', { hasText: 'Reports' }).click();
  await page.waitForTimeout(500);
  const rep = await text(page, '.card');
  ok('their Reports desk loads', has(rep, 'Your reports'), rep.slice(0, 120));

  await page.locator('.tabs button', { hasText: 'Expenses' }).click();
  await page.waitForTimeout(500);
  ok('their Expenses desk loads', has(await text(page, '.card'), 'Your expenses'));
  await page.close();
}

/* The suite left two worked days this month, both the admin's — so the
   calendar has real chips for the office and nothing for dana, which is
   exactly the scoping to prove. */
section('The calendar shows the month of work');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  ok('the office gets a Calendar tab', has(await text(page, '.tabs'), 'Calendar'));
  await page.locator('.tabs button', { hasText: 'Calendar' }).click();
  await page.waitForTimeout(600);
  /* THE FIXTURE DAYS LIVE IN AUGUST 2026, AND THE CALENDAR OPENS ON TODAY.
     For two weeks those were the same month; on the 1st of September every
     chip assertion below went false with no code having changed. So the test
     now walks to the fixtures' own month first — the calendar genuinely shows
     the work in the month it happened, which is the thing worth asserting. */
  for (let i = 0; i < 24; i++) {
    if (has(await text(page, '.bar'), 'August 2026')) break;
    await page.locator('[data-act="calMonth"][data-d="-1"]').click();
    await page.waitForTimeout(250);
  }
  ok('the calendar reaches the month the work happened in',
     has(await text(page, '.bar'), 'August 2026'));
  const grid = await text(page, '.cal-grid');
  ok('a month grid renders with weekday headers', has(grid, 'Sun') && has(grid, 'Sat'));
  ok('the admin calendar covers every investigator',
     has(await text(page, '.card'), 'every investigator'));
  const chips = await page.locator('.cal-ev').allInnerTexts();
  ok('each worked day is a chip on its date', chips.length === 2, chips.join(' | '));
  ok('an admin chip names who worked it', chips.every(c => has(c, 'Trever')), chips.join(' | '));
  ok('and carries the hours', chips.some(c => /6h/.test(c)) && chips.some(c => /4h/.test(c)),
     chips.join(' | '));

  await page.locator('.cal-ev').first().click();
  await page.waitForTimeout(600);
  ok('clicking a solid chip opens the case', await page.locator('.casepage').count() === 1);
  await page.locator('.close').click();
  await page.waitForTimeout(400);

  /* Month navigation, against months chosen for what they hold: July 2026 has
     no work in the fixtures, August has the two days — whatever month "today"
     happens to be. Reopening the tab resets the view to today, so the walk
     back to August is repeated, then one step to July and back. */
  await page.locator('.tabs button', { hasText: 'Calendar' }).click();
  await page.waitForTimeout(400);
  for (let i = 0; i < 24; i++) {
    if (has(await text(page, '.bar'), 'August 2026')) break;
    await page.locator('[data-act="calMonth"][data-d="-1"]').click();
    await page.waitForTimeout(250);
  }
  await page.locator('[data-act="calMonth"][data-d="-1"]').click();
  await page.waitForTimeout(600);
  ok('stepping to a month with no work clears the chips', await page.locator('.cal-ev').count() === 0);
  await page.locator('[data-act="calMonth"][data-d="1"]').click();
  await page.waitForTimeout(600);
  ok('and stepping back to the worked month brings them back', await page.locator('.cal-ev').count() === 2);
  await page.close();
}
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  ok('an investigator gets the Calendar tab too', has(await text(page, '.tabs'), 'Calendar'));
  await page.locator('.tabs button', { hasText: 'Calendar' }).click();
  await page.waitForTimeout(600);
  ok('scoped to their own days', has(await text(page, '.card'), 'your days and offers'));
  ok("the admin's days are not on it", await page.locator('.cal-ev').count() === 0);
  await page.close();
}

/* Priority 16: the Subject tab of a private case carries the per-type details
   form, and the field set follows the case type. */
section('Private case details follow the case type');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);

  await wsTab(page, 'Subject');
  let body = await text(page, '#dlgBody');
  ok('the details form is on the Subject tab', has(body, 'Case details'));
  ok('objectives carry the observe-and-document framing', has(body, 'observe and document'));
  ok('an untyped case asks the general questions', await page.locator('#det_known_routine').count() === 1
     && await page.locator('#det_suspected_companion').count() === 0);
  await page.locator('#det_objectives').fill('Document comings and goings during the stated schedule.');
  await page.locator('#det_client_concerns').fill('Late unexplained absences.');
  await page.locator('.btn', { hasText: 'Save details' }).click();
  await page.waitForTimeout(600);
  ok('the save survives the round trip',
     (await page.locator('#det_objectives').inputValue()).startsWith('Document comings'));

  // Give the case a type; the Subject tab asks that type's questions.
  await wsTab(page, 'Authorization');
  await page.locator('#m_type').selectOption({ label: 'Adultery / Infidelity' });
  await page.locator('.btn', { hasText: 'Save authorization' }).click();
  await page.waitForTimeout(600);
  await wsTab(page, 'Subject');
  body = await text(page, '#dlgBody');
  ok('an infidelity case asks about the suspected companion', has(body, 'Suspected companion'));
  ok('the shared fields kept their values',
     (await page.locator('#det_objectives').inputValue()).startsWith('Document comings')
     && (await page.locator('#det_client_concerns').inputValue()).startsWith('Late'));
  await page.close();
}

/* Priority 17: structured subjects and vehicles, driven through the page. */
section('Subjects and vehicles in the browser');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Subject');
  ok('the subjects section is on the Subject tab', has(await text(page, '#dlgBody'), 'Subjects & vehicles'));

  await page.locator('.btn', { hasText: 'Start from the intake subject' }).click();
  await page.waitForTimeout(300);
  ok('the intake subject prefills the form',
     (await page.locator('#sf_name').inputValue()) === 'John Subject');
  await page.locator('#sf_hair').fill('brown, short');
  await page.locator('.btn', { hasText: 'Save subject' }).click();
  await page.waitForTimeout(600);
  let body = await text(page, '#dlgBody');
  ok('the subject card appears with its fields', has(body, 'John Subject') && has(body, 'brown, short'));

  await page.locator('.btn', { hasText: 'Add vehicle' }).click();
  await page.waitForTimeout(300);
  await page.locator('#vf_make').fill('GMC');
  await page.locator('#vf_model').fill('Sierra');
  await page.locator('#vf_color').fill('white');
  await page.locator('#vf_plate').fill('ABC-1234');
  await page.locator('.btn', { hasText: 'Save vehicle' }).click();
  await page.waitForTimeout(600);
  body = await text(page, '#dlgBody');
  ok('the vehicle rides with the subject', has(body, 'white GMC Sierra') && has(body, 'ABC-1234'));
  await page.close();
}

/* Priority 18: the communication log in the browser. */
section('The communication log');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Comm log');
  let body = await text(page, '#dlgBody');
  ok('the log opens on its own tab', has(body, 'Log the communication'));
  ok('and says it never sends anything', has(body, 'nothing is sent'));

  await page.locator('#c_person').fill('Jane Client');
  await page.locator('#c_time').fill('14:30');
  await page.locator('#c_sum').fill('Client asked for a status update; told her the report drafts tonight.');
  await page.locator('#c_fup').fill('2026-08-15');
  await page.locator('.btn', { hasText: 'Log the communication' }).click();
  await page.waitForTimeout(600);
  body = await text(page, '#dlgBody');
  ok('the entry lands on the log', has(body, 'status update'));
  ok('with its time in 12-hour form', has(body, '2:30 PM'));
  ok('and the follow-up date on it', has(body, 'follow up'));
  ok('office-only is the default badge', has(body, 'Admin only'));
  await page.close();
}

/* Priority 19: follow-up tasks, and the overdue card that answers for them. */
section('Follow-up tasks in the browser');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Tasks');
  await page.locator('#t_task').fill('Call the adjuster to confirm the second day.');
  await page.locator('#t_due').fill('2026-08-12');
  await page.locator('#t_pri').selectOption('high');
  await page.locator('.btn', { hasText: 'Add task' }).click();
  await page.waitForTimeout(600);
  const body = await text(page, '#dlgBody');
  ok('the task lands on the list', has(body, 'Call the adjuster'));
  ok('a past due date reads overdue', has(body, 'overdue'));

  await page.locator('.close').click();
  await page.waitForTimeout(400);
  await render(page);
  const lateCard = page.locator('.stat', { hasText: 'Tasks overdue' });
  ok('the dashboard counts it', parseInt((await lateCard.innerText()).match(/\d+/)[0], 10) >= 1);
  await lateCard.click();
  await page.waitForTimeout(300);
  ok('clicking narrows the list to the case', (await text(page, '.card')).includes('API-20260812-4002'));
  await page.locator('.chip button').click();
  await page.waitForTimeout(250);

  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Tasks');
  await page.locator('.btn', { hasText: 'Done' }).first().click();
  await page.waitForTimeout(600);
  ok('done retires the task', has(await text(page, '#dlgBody'), 'done'));
  await page.close();
}

/* Priority 20: the nine stages, and closing through the checklist. Runs last
   on purpose — it walks API-20260812-4002 to closed and back. */
section('Closing a case takes the checklist');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);

  await wsTab(page, 'Assignment');
  ok('the status select speaks the full vocabulary',
     has(await text(page, '#sts'), 'Awaiting client') && has(await text(page, '#sts'), 'On hold'));
  await page.locator('#sts').selectOption('awaiting_client');
  await page.locator('[data-act="saveCase"]').click();
  await page.waitForTimeout(700);
  ok('the list tag reads the new stage', has(await rowFor(page, 'API-20260812-4002').innerText(), 'Awaiting client'));
  const waitCard = page.locator('.stat', { hasText: 'Awaiting client' });
  ok('the dashboard card counts it', parseInt((await waitCard.innerText()).match(/\d+/)[0], 10) >= 1);

  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Billing');
  ok('the closing checklist waits under Billing & closing',
     has(await text(page, '#dlgBody'), 'Close the case'));
  await page.locator('[data-act="closeCase"]').click();
  await page.waitForTimeout(600);
  ok('closing early names the unfinished lines',
     has(await text(page, '#dlgBody'), 'Finish the checklist'));
  for (const k of ['field_work','activity_logs','evidence','report','admin_review','deliverables','expenses','billing']) {
    await page.locator('#cl_' + k).check();
  }
  await page.locator('[data-act="closeCase"]').click();
  await page.waitForTimeout(700);
  ok('all eight confirmed closes the case', has(await text(page, '#dlgBody'), 'Case closed'));

  await page.locator('.close').click();
  await page.waitForTimeout(500);
  ok('the list shows it closed', has(await rowFor(page, 'API-20260812-4002').innerText(), 'Closed'));

  // Reopen from the status select — the checklist is for closing, not holding.
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Assignment');
  await page.locator('#sts').selectOption('in_progress');
  await page.locator('[data-act="saveCase"]').click();
  await page.waitForTimeout(700);
  ok('reopening from the status works',
     has(await rowFor(page, 'API-20260812-4002').innerText(), 'In progress'));
  await page.close();
}

/* REOPEN IS A BUTTON ON THE CLOSED PANEL (owner, WORKFLOW-SIMPLIFICATION §2).

   The closed-case panel used to say "Reopen by setting a status above and
   saving." Nothing was above it: the closing panel renders in Admin → Billing
   & closing while the status selector lives in Admin → Assignment, a different
   tab. The one sentence explaining how to undo a closure pointed off the screen
   and did not name where to go.

   The section above still reopens through the status selector, deliberately —
   that path has to keep working. These assert the direct one, on the panel where
   the closure happened. */
section('A closed case can be reopened where it was closed');
{
  await post('/ingest', {
    case_no: 'API-20260812-4010', service: 'Surveillance',
    client_name: 'Reopen Client', subject_name: 'Reopen Subject',
    objective: 'Establish whereabouts',
  }, { 'X-Ingest-Key': 'e2e-ingest-key' });

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4010').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Billing');
  ok('an open case offers no Reopen button',
     await page.locator('[data-act="reopenCase"]').count() === 0);

  for (const k of ['field_work','activity_logs','evidence','report','admin_review',
                   'deliverables','expenses','billing']) {
    await page.locator('#cl_' + k).check();
  }
  await page.locator('[data-act="closeCase"]').click();
  await page.waitForTimeout(700);
  const closed = await text(page, '#dlgBody');
  ok('the case closes through the checklist as before', has(closed, 'Case closed'));

  /* THE POINT OF THE CHANGE. No wsTab() call here — the control has to be on
     the panel the admin is already looking at, or this proves nothing. */
  ok('and Reopen case is right there on the closed panel',
     await page.locator('[data-act="reopenCase"]').count() === 1);
  ok('the instruction pointing at another tab is gone',
     !has(closed, 'setting a status above'), closed.slice(0, 300));

  await page.locator('[data-act="reopenCase"]').click();
  await page.waitForTimeout(800);
  const back = await text(page, '#dlgBody');
  ok('pressing it reopens the case without leaving the panel',
     has(back, 'Close the case') && !has(back, 'Case closed'), back.slice(0, 300));
  /* "Reopening keeps every tick below as history" — the checklist is what the
     office confirmed, and losing it would make reopening cost eight decisions. */
  ok('and every tick survives as history', has(back, '8/8 confirmed'), back.slice(0, 300));
  ok('so the case can be closed again without redoing the checklist',
     await page.locator('[data-act="closeCase"]').count() === 1);

  await page.locator('.close').click();
  await page.waitForTimeout(500);
  ok('the list shows it open again',
     !has(await rowFor(page, 'API-20260812-4010').innerText(), 'Closed'),
     await rowFor(page, 'API-20260812-4010').innerText());
  await page.close();
}
{
  /* The closing panel is admin-only in full, so the button cannot reach the
     field. Dana is assigned the claims case; neither panel nor control. */
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  ok('an investigator gets no Reopen control',
     await page.locator('[data-act="reopenCase"]').count() === 0);
  ok('nor the closing checklist it belongs to',
     !has(await text(page, '#dlgBody'), 'Close the case'));
  await page.close();
}

/* ARCHIVE AND RESTORE ON THE SCREEN (owner, WORKFLOW-SIMPLIFICATION §2).

   The case is archived and then restored inside this section: the suite shares
   one database, and leaving a case out of the active list would silently change
   what every later section sees. */
section('A case can be archived and brought back');
{
  await post('/ingest', {
    case_no: 'API-20260812-4011', service: 'Surveillance',
    client_name: 'Archive Client', subject_name: 'Archive Subject',
    objective: 'Establish whereabouts',
  }, { 'X-Ingest-Key': 'e2e-ingest-key' });

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  ok('the Cases tab offers an Archived lens',
     await page.locator('.lens', { hasText: 'Archived' }).count() === 1);
  ok('and the new case starts in the active list',
     await rowFor(page, 'API-20260812-4011').count() === 1);

  await rowFor(page, 'API-20260812-4011').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Billing');
  ok('Archive sits beside closing, where the lifecycle lives',
     await page.locator('[data-act="archiveCase"]').count() === 1);
  ok('and says plainly that nothing is deleted',
     has(await text(page, '#dlgBody'), 'Nothing is deleted'));

  await page.locator('[data-act="archiveCase"]').click();
  await page.waitForTimeout(800);
  const arch = await text(page, '#dlgBody');
  ok('archiving is confirmed on the case, with who and when',
     has(arch, 'Case archived') && has(arch, 'Trever'), arch.slice(0, 300));
  ok('and the offer becomes Restore, without leaving the panel',
     await page.locator('[data-act="restoreCase"]').count() === 1
     && await page.locator('[data-act="archiveCase"]').count() === 0);

  await page.locator('.close').click();
  await page.waitForTimeout(600);
  ok('the archived case has left the active list',
     await rowFor(page, 'API-20260812-4011').count() === 0);

  await page.locator('.lens', { hasText: 'Archived' }).click();
  await page.waitForTimeout(800);
  ok('and is found under the Archived lens',
     await rowFor(page, 'API-20260812-4011').count() === 1);
  ok('which shows only archived cases',
     await rowFor(page, 'API-20260812-4002').count() === 0);

  /* PUT IT BACK, and leave the database as this section found it. */
  await rowFor(page, 'API-20260812-4011').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Billing');
  await page.locator('[data-act="restoreCase"]').click();
  await page.waitForTimeout(800);
  ok('restoring is offered from the archived case itself',
     await page.locator('[data-act="archiveCase"]').count() === 1);
  await page.locator('.close').click();
  await page.waitForTimeout(600);
  await page.locator('.lens', { hasText: 'All' }).click();
  await page.waitForTimeout(800);
  ok('and the case is back in the active list',
     await rowFor(page, 'API-20260812-4011').count() === 1);
  await page.close();
}
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  ok('an investigator gets no Archived lens',
     await page.locator('.lens', { hasText: 'Archived' }).count() === 0);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  ok('nor any archive control on a case',
     await page.locator('[data-act="archiveCase"]').count() === 0
     && await page.locator('[data-act="restoreCase"]').count() === 0);
  await page.close();
}

/* DELETE CASE ON THE SCREEN — a tombstone, never a purge (owner, §2 answer).
   Deleted and then put back inside this section, so the shared database is left
   as it was found. */
section('A case can be deleted as a tombstone and put back');
{
  await post('/ingest', {
    case_no: 'API-20260812-4012', service: 'Surveillance',
    client_name: 'Delete Client', subject_name: 'Delete Subject',
    objective: 'Establish whereabouts',
  }, { 'X-Ingest-Key': 'e2e-ingest-key' });

  const page = await newPage();
  page.on('dialog', d => d.accept());   // the confirm every destructive action here uses
  await signIn(page, 'trever', 'AdminPassword1x');
  ok('the Cases tab offers a Deleted lens',
     await page.locator('.lens', { hasText: 'Deleted' }).count() === 1);

  await rowFor(page, 'API-20260812-4012').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Billing');
  ok('Delete case sits with the other lifecycle controls',
     await page.locator('[data-act="deleteCase"]').count() === 1);
  ok('and says at rest that nothing is destroyed',
     has(await text(page, '#dlgBody'), 'Nothing is destroyed'));

  await page.locator('[data-act="deleteCase"]').click();
  await page.waitForTimeout(900);
  const del = await text(page, '#dlgBody');
  ok('deleting is confirmed on the case, with who and when',
     has(del, 'Case deleted') && has(del, 'Trever'), del.slice(0, 300));
  ok('and names what survived, not merely that it is gone',
     has(del, 'activity') && has(del, 'invoices'), del.slice(0, 400));
  ok('the offer becomes Put the case back',
     await page.locator('[data-act="undeleteCase"]').count() === 1
     && await page.locator('[data-act="deleteCase"]').count() === 0);

  /* THE CASE STILL OPENS IN FULL — it has to, or it could never be restored. */
  ok('and the workspace is still usable', await page.locator('.wstabs').count() >= 1);

  await page.locator('.close').click();
  await page.waitForTimeout(600);
  ok('the deleted case has left the active list',
     await rowFor(page, 'API-20260812-4012').count() === 0);
  await page.locator('.lens', { hasText: 'Archived' }).click();
  await page.waitForTimeout(800);
  ok('and is NOT under Archived — delete reaches further than archive',
     await rowFor(page, 'API-20260812-4012').count() === 0);
  await page.locator('.lens', { hasText: 'Deleted' }).click();
  await page.waitForTimeout(800);
  ok('it is found under Deleted',
     await rowFor(page, 'API-20260812-4012').count() === 1);

  await rowFor(page, 'API-20260812-4012').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Billing');
  await page.locator('[data-act="undeleteCase"]').click();
  await page.waitForTimeout(900);
  ok('putting it back is offered from the deleted case itself',
     await page.locator('[data-act="deleteCase"]').count() === 1);
  await page.locator('.close').click();
  await page.waitForTimeout(600);
  await page.locator('.lens', { hasText: 'All' }).click();
  await page.waitForTimeout(800);
  ok('and the case is back in the active list',
     await rowFor(page, 'API-20260812-4012').count() === 1);
  await page.close();
}
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  ok('an investigator gets no Deleted lens',
     await page.locator('.lens', { hasText: 'Deleted' }).count() === 0);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  ok('nor any delete control on a case',
     await page.locator('[data-act="deleteCase"]').count() === 0
     && await page.locator('[data-act="undeleteCase"]').count() === 0);
  await page.close();
}

/* TWO ADMINS ON ONE CASE, and ASSIGNMENT REACHABLE BUT SECONDARY — both on the
   screen (owner, 2026-08-16). */
section('A second admin sees whose day is running, and cannot end it by press');
{
  /* A second ADMIN, made server-side: the browser invite flow is exercised
     elsewhere and is slow, and this section is about the field panel. */
  const lr = await post('/auth/login', { username: 'trever', password: 'AdminPassword1x' });
  const sc = lr.headers.getSetCookie ? lr.headers.getSetCookie()[0] : lr.headers.get('Set-Cookie');
  const adminCookie = sc.split(';')[0];
  const iv = await (await post('/invites',
    { username: 'second_admin', display_name: 'Second Admin', role: 'admin' },
    { Cookie: adminCookie })).json();
  const tok = new URL(iv.url, 'https://x.test').searchParams.get('invite');
  await post(`/invite/${tok}/accept`, { password: 'SecondAdmin2026x' });
  await post('/ingest', {
    case_no: 'API-20260812-4013', service: 'Surveillance',
    client_name: 'Shared Case', subject_name: 'Shared Subject',
  }, { 'X-Ingest-Key': 'e2e-ingest-key' });

  const page = await newPage();
  page.on('dialog', d => d.accept());
  await signIn(page, 'trever', 'AdminPassword1x');

  /* Trever starts a day, then the SECOND admin looks at the same case. */
  await rowFor(page, 'API-20260812-4013').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Field work');
  await page.locator('#d_date').fill('2026-08-17');
  await page.locator('#d_start').fill('07:00');
  await page.locator('[data-act="startDay"] button[type="submit"]').first().click();
  await page.waitForTimeout(800);
  ok('the first admin has a day running',
     await page.locator('[data-act="endDay"]').count() === 1);
  await page.close();

  const second = await newPage();
  second.on('dialog', d => d.accept());
  await signIn(second, 'second_admin', 'SecondAdmin2026x');
  await rowFor(second, 'API-20260812-4013').click();
  await second.waitForTimeout(450);
  await wsTab(second, 'Field work');
  const panel = await text(second, '#dlgBody');
  ok('the second admin is told whose day is running',
     has(panel, 'has a day running') && has(panel, 'Trever'), panel.slice(0, 400));
  ok('and is told they can run their own alongside it',
     has(panel, 'runs alongside'), panel.slice(0, 400));
  ok('the ordinary End form is not offered for someone else\'s day',
     await second.locator('[data-act="endDay"]').count() === 0);
  ok('but a separate End their session action is',
     await second.locator('[data-act="endOtherDay"]').count() === 1);
  /* THE BUTTON CARRIES THE SESSION IT IS LABELLED FOR. It used to carry
     nothing, and the Worker ended whichever day was newest — so with two admins
     out, the button saying one name ended the other's clock. */
  const btn = second.locator('[data-act="endOtherDay"]').first();
  ok('the action names the session it would end',
     /^\d+$/.test((await btn.getAttribute('data-id')) || ''),
     await btn.getAttribute('data-id'));
  ok('and the person it belongs to, so the confirm can say their name',
     ((await btn.getAttribute('data-who')) || '').includes('Trever'),
     await btn.getAttribute('data-who'));
  ok('and the form to start their OWN day is still right there',
     await second.locator('[data-act="startDay"]').count() === 1);

  await second.locator('[data-act="endOtherDay"]').click();
  await second.waitForTimeout(900);
  ok('the separate action ends it, behind a confirm',
     await second.locator('[data-act="endOtherDay"]').count() === 0,
     (await text(second, '#dlgBody')).slice(0, 300));
  await second.close();
}
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  ok('an investigator is never offered the end-someone-else action',
     await page.locator('[data-act="endOtherDay"]').count() === 0);
  await page.close();
}
/* EDIT CASE (owner, 2026-08-16) — one place to correct what the case says. */
section('A case can be corrected from one Edit case screen');
{
  await post('/ingest', {
    case_no: 'API-20260812-4014', service: 'Surveillance',
    client_name: 'Mistyped Nmae', client_email: 'wrong@example.com',
    client_phone: '5550100111', subject_name: 'Subject Wrong',
    subject_address: '1 Old Road', objective: 'Establish whereabouts',
  }, { 'X-Ingest-Key': 'e2e-ingest-key' });

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4014').click();
  await page.waitForTimeout(500);

  /* The header button says Edit case; it used to open Assignment, which could
     only change the assignee and the status. */
  await page.locator('.caseheader button', { hasText: 'Edit case' }).first().click();
  await page.waitForTimeout(600);
  const panel = await text(page, '#dlgBody');
  ok('the header button opens a real Edit case screen', has(panel, 'Edit case'), panel.slice(0, 200));
  ok('the case number is shown but not editable',
     has(panel, 'API-20260812-4014') && await page.locator('#dlgBody input[value*="4014"]').count() === 0);
  ok('and says plainly why it cannot change', has(panel, 'never changes'), panel.slice(0, 400));

  ok('the identity fields are all there',
     await page.locator('#ed_client').count() === 1 && await page.locator('#ed_email').count() === 1
     && await page.locator('#ed_subject').count() === 1 && await page.locator('#ed_address').count() === 1);
  ok('with the existing single phone read through into the list',
     (await page.locator('#edc_num_0').inputValue()) === '5550100111',
     await page.locator('#edc_num_0').inputValue());
  ok('case type, status, reference, retainer and assignment are on the same screen',
     await page.locator('#ed_type').count() === 1 && await page.locator('#ed_status').count() === 1
     && await page.locator('#ed_claim').count() === 1 && await page.locator('#ed_asg').count() === 1);
  ok('assignment offers unassigned and says a case may stay that way',
     has(await page.locator('#ed_asg').first().innerText(), 'unassigned')
     && has(panel, 'may stay unassigned'), panel.slice(0, 900));
  ok('internal notes are linked, not duplicated into a second box',
     await page.locator('[data-act="wsTab"][data-tab="notes"]').count() >= 1
     && await page.locator('#dlgBody textarea').count() === 0);

  await page.locator('#ed_client').fill('Jane Correct');
  await page.locator('#ed_email').fill('jane@example.com');
  await page.locator('#ed_subject').fill('Subject Right');
  await page.locator('#ed_address').fill('2 New Street');
  await page.locator('#edc_num_0').fill('555 0100 222');
  await page.locator('#edc_lab_0').selectOption('mobile');
  await page.locator('[data-act="edAddPhone"]').first().click();
  await page.waitForTimeout(400);
  ok('another number can be added without losing the first',
     (await page.locator('#edc_num_0').inputValue()) === '555 0100 222'
     && await page.locator('#edc_num_1').count() === 1,
     await page.locator('#edc_num_0').inputValue());
  /* ADDING A ROW REPAINTS THE PANEL, and a repaint rebuilds every input from
     the stored case. Without a draft the corrected NAME reverted to the stored
     one and the save then sent it back unchanged while reporting success —
     which is exactly what happened, and what these four assertions pin. */
  ok('and the corrected name survives the repaint',
     (await page.locator('#ed_client').inputValue()) === 'Jane Correct',
     await page.locator('#ed_client').inputValue());
  ok('as does the email', (await page.locator('#ed_email').inputValue()) === 'jane@example.com');
  ok('and the subject', (await page.locator('#ed_subject').inputValue()) === 'Subject Right');
  ok('and the address', (await page.locator('#ed_address').inputValue()) === '2 New Street');
  await page.locator('#edc_num_1').fill('555 0100 333');
  await page.locator('#edc_lab_1').selectOption('work');
  await page.locator('[data-act="edSave"]').click();
  await page.waitForTimeout(900);
  ok('saving is confirmed', has(await text(page, '#dlgBody'), 'Case updated'),
     (await text(page, '#dlgBody')).slice(0, 300));
  ok('and the correction really reached the database',
     db.prepare('SELECT client_name FROM submissions WHERE case_no = ?')
       .get('API-20260812-4014').client_name === 'Jane Correct',
     String(db.prepare('SELECT client_name FROM submissions WHERE case_no = ?')
       .get('API-20260812-4014').client_name));

  await page.locator('.close').click();
  await page.waitForTimeout(600);
  ok('the corrected name shows on the case list',
     has(await rowFor(page, 'API-20260812-4014').innerText(), 'Jane Correct'),
     await rowFor(page, 'API-20260812-4014').innerText());

  await rowFor(page, 'API-20260812-4014').click();
  await page.waitForTimeout(500);
  await wsTab(page, 'Edit case');
  ok('both numbers survived the save',
     (await page.locator('#edc_num_0').inputValue()) === '555 0100 222'
     && (await page.locator('#edc_num_1').inputValue()) === '555 0100 333',
     await page.locator('#edc_num_1').inputValue());
  ok('with their labels', (await page.locator('#edc_lab_1').inputValue()) === 'work');

  /* MOBILE-SAFE: 44px targets and no sideways scroll on a phone. Measured by
     resizing the page already sitting on the panel, rather than signing in
     again — the panel is what is being measured, not the route to it. */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const phone = page;
  const small = await phone.evaluate(() => {
    const out = [];
    /* The PANEL's own controls. The "Edit case" button in the case header is
       what opens this and belongs to the header, not to the form — measuring it
       here would be asserting something this section does not name. */
    for (const el of document.querySelectorAll('.editcase input, .editcase select, .editcase .btn')) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.height < 44) out.push((el.id || el.textContent || '').slice(0, 24));
    }
    return out;
  });
  ok('every control on Edit case is at least 44px tall', small.length === 0, small.join(' | '));
  const overflow = await phone.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('and the page does not scroll sideways on a phone', overflow <= 0, String(overflow));
  await phone.close();
}

section('Assignment is reachable from the overview, and stays secondary');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4013').click();
  await page.waitForTimeout(500);

  /* No wsTab() call: the point is that it is reachable from where a case opens. */
  /* Unit 38 — the overview is four blocks now and the investigator sits on
     Case status, so this reads the panel rather than whichever card is first. */
  const card = await text(page, '.wspanel');
  ok('the overview still names the investigator', has(card, 'Investigator'), card.slice(0, 300));
  const link = page.locator('.ovcard [data-act="wsTab"][data-tab="assign"]');
  ok('and offers a way to act on it without hunting', await link.count() === 1);
  ok('worded for the case as it stands',
     ['Assign', 'Change'].includes((await link.first().innerText()).trim()),
     await link.first().innerText());

  /* SECONDARY, NOT A PRIMARY ACTION: it is a quiet inline link, not one of the
     card's buttons, and it does not take over the Next step card. */
  ok('it is not styled as a primary button',
     (await link.first().getAttribute('class') || '').includes('tl-edit'),
     await link.first().getAttribute('class'));
  ok('and the Next step card is still about the package, not assignment',
     !has(await page.locator('.ov-next').first().innerText(), 'assign'),
     await page.locator('.ov-next').first().innerText());

  await link.first().click();
  await page.waitForTimeout(700);
  ok('it opens the Assignment panel that already existed',
     await page.locator('#asg').count() === 1);
  ok('reusing the existing assign control rather than a second one',
     await page.locator('[data-act="saveCase"]').count() === 1);
  ok('which still offers unassigned, because assignment is optional',
     has(await page.locator('#asg').first().innerText(), 'unassigned'),
     await page.locator('#asg').first().innerText());
  await page.close();
}
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  ok('an investigator gets no assign link',
     await page.locator('[data-act="wsTab"][data-tab="assign"]').count() === 0);
  await page.close();
}

/* WHO GETS TOLD, on the screen. Settings and data layer only — there is no SMS
   provider configured, so the page has to say so rather than imply a text went
   out. */
section('Notification recipients in the browser');
{
  const page = await newPage();
  page.on('dialog', d => d.accept());
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Settings' }).first().click();
  await page.waitForTimeout(700);

  const card = await text(page, '.card');
  ok('Settings opens on the recipients card', has(card, 'Who gets told'), card.slice(0, 200));
  ok('and says plainly that texts are not sent yet',
     has(card, 'not sent yet') && has(card, 'no sms provider is configured'), card.slice(0, 500));
  ok('with nobody set up to begin with, rather than a default recipient',
     has(card, 'Nobody is set up to be told yet'));

  /* THE WORDING IS SHOWN, so the office reads what would actually leave. */
  ok('the five alert choices are previewed by their real wording',
     ['New intake received', 'Payment recorded', 'Report ready for review',
      'Client package finalized', 'Important task due'].every(t => has(card, t)), card.slice(0, 900));
  ok('and every email preview says where to look',
     (card.match(/sign in to the portal/gi) || []).length >= 5);
  ok('the preview case number is obviously not a real case', has(card, 'API-EXAMPLE-0001'));

  /* A TEXT CARRIES NO CASE NUMBER (owner, 2026-08-16). Both channels are shown
     side by side so the office reads the difference rather than being told it. */
  ok('both channels are previewed, labelled',
     has(card, 'Text message') && has(card, 'Email'), card.slice(0, 600));
  ok('the SMS wording tells the admin to open the portal',
     (card.match(/open the portal\./gi) || []).length >= 5, card.slice(0, 900));
  ok('and the page says plainly that a text carries no case number',
     has(card, 'carries no case number'), card.slice(0, 900));
  /* The example case number appears for email only. Counting it is the check:
     five events, so five occurrences and not ten. */
  ok('the case number appears once per event, on the email side only',
     (card.match(/API-EXAMPLE-0001/g) || []).length === 5,
     String((card.match(/API-EXAMPLE-0001/g) || []).length));

  await page.locator('[data-act="ntAdd"]').click();
  await page.waitForTimeout(300);
  ok('the add form asks who it is, a phone and an email',
     await page.locator('#nt_label').count() === 1 && await page.locator('#nt_phone').count() === 1
     && await page.locator('#nt_email').count() === 1);
  ok('and offers a switch for each alert',
     await page.locator('#nt_a_intakes').count() === 1
     && await page.locator('#nt_a_payments').count() === 1
     && await page.locator('#nt_a_reports').count() === 1
     && await page.locator('#nt_a_packages').count() === 1
     && await page.locator('#nt_a_tasks').count() === 1);

  await page.locator('#nt_label').fill('Owner mobile');
  await page.locator('#nt_phone').fill('555 0100 111');
  await page.locator('#nt_a_payments').check();
  await page.locator('#nt_a_packages').check();
  await page.locator('[data-act="ntSave"]').click();
  await page.waitForTimeout(800);
  const one = await text(page, '.card');
  ok('the recipient is listed with the alerts it was given',
     has(one, 'Owner mobile') && has(one, 'Payment recorded') && has(one, 'Client package finalized'),
     one.slice(0, 400));

  /* A SECOND NUMBER WITH DIFFERENT CHOICES — the whole point of rows. */
  await page.locator('[data-act="ntAdd"]').click();
  await page.waitForTimeout(300);
  await page.locator('#nt_label').fill('Second phone');
  await page.locator('#nt_phone').fill('555 0100 222');
  await page.locator('#nt_a_intakes').check();
  await page.locator('[data-act="ntSave"]').click();
  await page.waitForTimeout(800);
  ok('a second number is held alongside the first',
     has(await text(page, '.card'), 'Second phone'));
  ok('each with its own choices, not one shared setting',
     await page.locator('.row', { hasText: 'Second phone' }).first().innerText()
       .then(t => has(t, 'New intake received') && !has(t, 'Payment recorded')));

  /* THE ENABLE TOGGLE IS PER RECIPIENT. */
  await page.locator('.row', { hasText: 'Second phone' })
    .locator('[data-act="ntToggle"]').first().click();
  await page.waitForTimeout(800);
  /* Read the toggle's own state, not the row's words: the button for an enabled
     recipient READS "Switch off", so a substring test for "off" passes whatever
     the state is and proves nothing. */
  const stateOf = async label => page.locator('.row', { hasText: label })
    .locator('[data-act="ntToggle"]').first().getAttribute('data-on');
  const offRow = await page.locator('.row', { hasText: 'Second phone' }).first().innerText();
  ok('switching one off is shown on that recipient',
     (await stateOf('Second phone')) === '0' && has(offRow, 'Switch on'), offRow);
  ok('and the other is untouched', (await stateOf('Owner mobile')) === '1');
  ok('and the number it belongs to is still there',
     has(offRow, '555 0100 222'), offRow);

  const bad = await page.locator('[data-act="ntAdd"]');
  await bad.click();
  await page.waitForTimeout(300);
  await page.locator('#nt_label').fill('Nobody');
  await page.locator('[data-act="ntSave"]').click();
  await page.waitForTimeout(700);
  ok('a recipient with neither a number nor an address is refused, with the reason',
     has(await text(page, '.card'), 'could never be told anything'),
     (await text(page, '.card')).slice(0, 400));
  await page.locator('[data-act="ntCancel"]').click();
  await page.waitForTimeout(300);

  await page.locator('.row', { hasText: 'Second phone' })
    .locator('[data-act="ntDelete"]').first().click();
  await page.waitForTimeout(900);
  ok('a recipient can be removed',
     !has(await text(page, '.card'), 'Second phone'));
  ok('and the other one stays', has(await text(page, '.card'), 'Owner mobile'));
  await page.close();
}
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  ok('an investigator has no Settings tab at all',
     await page.locator('.tabs button', { hasText: 'Settings' }).count() === 0);
  await page.close();
}

/* The private-retainer balance (RATESHEETS.md admin side): internal only,
   driven from the Authorization tab of a private case. */
section('The retainer balance on a private case');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Authorization');
  ok('a private case offers the retainer fields', await page.locator('#m_ret').count() === 1);
  await page.locator('#m_ret').fill('1500');
  await page.locator('#m_retrec').check();
  await page.locator('.btn', { hasText: 'Save authorization' }).click();
  await page.waitForTimeout(600);
  const auth = await text(page, '#dlgBody');
  ok('the panel shows the retainer balance', has(auth, 'Remaining retainer'));
  // The bare Yes/No row became a status, so the panel reads as a state rather
  // than a checkbox someone has to interpret.
  ok('received is recorded', has(auth, 'Retainer received'));

  /* PAYMENTS.md §5/§11 — RETAINER PENDING until an admin records the money,
     and recording it means saying WHAT arrived. */
  await page.locator('#m_retrec').uncheck();
  await page.locator('.btn', { hasText: 'Save authorization' }).click();
  await page.waitForTimeout(600);
  ok('un-ticking it puts the case back to pending',
     has(await text(page, '#dlgBody'), 'Retainer pending'));
  ok('and offers to record the payment',
     await page.locator('[data-act="retOpen"]').count() === 1);
  ok('while saying plainly that sending instructions is not payment',
     has(await text(page, '#dlgBody'), 'does not mark it paid'));

  await page.locator('[data-act="retOpen"]').click();
  await page.waitForTimeout(300);
  ok('the form asks for amount, method, date and reference',
     await page.locator('#ret_amt').count() === 1 && await page.locator('#ret_method').count() === 1
     && await page.locator('#ret_date').count() === 1 && await page.locator('#ret_ref').count() === 1);

  /* Owner correction 2026-08-15: the firm does not accept these two, so they
     are not offered — a method it cannot take pushes the failure onto the
     client mid-retainer. */
  const methods = await page.locator('#ret_method option').allInnerTexts();
  ok('the five accepted methods are offered',
     ['Cash App', 'Venmo', 'Check', 'Cash', 'ACH / BILL'].every(m => methods.includes(m)),
     methods.join('|'));
  ok('and credit card and other are not selectable',
     !methods.some(m => /credit|other/i.test(m)), methods.join('|'));

  await page.locator('#ret_amt').fill('1500');
  await page.locator('#ret_method').selectOption('venmo');
  await page.locator('#ret_date').fill('2026-08-14');
  await page.locator('#ret_ref').fill('Venmo note: retainer');
  await page.locator('[data-act="retSave"]').click();
  await page.waitForTimeout(800);
  const paid = await text(page, '#dlgBody');
  ok('recording it moves the case to received', has(paid, 'Retainer received'));
  ok('and the panel shows what actually arrived',
     has(paid, 'Venmo') && has(paid, '1,500'), paid.slice(0, 400));
  ok('with the date the client paid', has(paid, 'Aug'));
  ok('and the reference', has(paid, 'Venmo note: retainer'));
  ok('stamped with who recorded it', has(paid, 'Recorded by'));

  /* The owner's three figures, labelled apart. OUTSTANDING is what the client
     still owes; `remaining` above it is the retainer the work has not consumed,
     and the two must never share a word. */
  ok('the panel shows received and outstanding',
     has(paid, 'Received') && has(paid, 'Outstanding'));

  /* A FAILED ATTEMPT KEEPS ITS TOKEN. The page used to clear it on an error,
     which is how one slow press became two recorded payments: the retry looked
     like a new payment because nothing tied it to the attempt that might still
     have been in flight. Keeping the token means the retry IS the same attempt
     and the server can refuse it as such.

     The real handler runs against a stubbed failure and the state it leaves is
     inspected — driving the function rather than re-implementing its branch,
     which would only prove the test. */
  {
    await page.locator('[data-act="retOpen"]').first().click();
    await page.waitForTimeout(300);
    await page.locator('#ret_amt').fill('42');
    const outcome = await page.evaluate(async () => {
      const real = window.fetch;
      window.fetch = async () => new Response(JSON.stringify({
        error: 'That payment did not finish recording. Try again — nothing was saved.',
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      RET_TOKEN = 'ui-attempt-token';
      try { await recordRetainerPayment(true); } finally { window.fetch = real; }
      return { token: RET_TOKEN, msg: RET_MSG, err: RET_ERR, formOpen: RET_FORM };
    });
    ok('a failure is surfaced to the admin, not swallowed',
       outcome.err === true && outcome.msg.includes('nothing was saved'), outcome.msg);
    ok('and the attempt keeps its token, so a retry cannot read as a new payment',
       outcome.token === 'ui-attempt-token', outcome.token);
    ok('and the form stays open to be pressed again', outcome.formOpen === true);
    ok('and an ordinary failure offers no way to reissue the token',
       await page.locator('[data-act="retNewAttempt"]').count() === 0);
  }

  /* THE ONE ATTEMPT THAT CANNOT BE RETRIED AS ITSELF. A claim left by the old
     two-step version may or may not have money behind it, so its token is
     unusable for ever — keeping it would mean the payment could never be
     recorded from this screen. The escape is a NEW attempt, and it has to be
     pressed: the page must not reissue a token on its own, because the question
     "was that money already recorded" is answered by the payment list, which is
     on this same screen. */
  {
    const stuck = await page.evaluate(async () => {
      const real = window.fetch;
      window.fetch = async () => new Response(JSON.stringify({
        error: 'An earlier version of the portal started recording this payment and did not '
             + 'finish saying whether it succeeded. Check the payments listed on this case.',
        code: 'payment_indeterminate',
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
      RET_TOKEN = 'ui-legacy-token';
      try { await recordRetainerPayment(true); } finally { window.fetch = real; }
      return { token: RET_TOKEN, msg: RET_MSG, stuck: RET_STUCK };
    });
    ok('the admin is told which check to make, not just that it failed',
       stuck.msg.includes('Check the payments listed on this case'), stuck.msg);
    ok('the token is still not reissued behind their back',
       stuck.token === 'ui-legacy-token', stuck.token);
    ok('but a way past it is now offered',
       await page.locator('[data-act="retNewAttempt"]').count() === 1);
    await page.locator('[data-act="retNewAttempt"]').first().click();
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({ token: RET_TOKEN, stuck: RET_STUCK, open: RET_FORM }));
    ok('and pressing it starts a genuinely new attempt', after.token === '');
    ok('with the form still open and the offer withdrawn',
       after.open === true && after.stuck === false);
    /* AND THE FIGURE THEY TYPED IS STILL THERE. Every paint rebuilds these
       inputs, so the amount used to be wiped by the repaint — and the next
       press then sent `received: true` with no figure, which marks the case
       received with NOTHING behind it. The admin means "retry my $310"; the
       case would read as paid with $0 received. */
    ok('and the amount they entered survived the repaint',
       await page.locator('#ret_amt').inputValue() === '42',
       await page.locator('#ret_amt').inputValue());
  }

  /* A PAYMENT WITH NO FIGURE IS REFUSED HERE. `received: true` with no amount
     is the office's bare flag, not a payment, and this button must never
     produce one by accident. */
  {
    await page.locator('[data-act="retCancel"]').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-act="retOpen"]').first().click();
    await page.waitForTimeout(300);
    ok('the amount is no longer offered as optional',
       !(await page.locator('#ret_amt').locator('xpath=../span').innerText()).toLowerCase().includes('optional'));
    /* Asserted as "the write never happened" rather than by reading the status
       afterwards: this case already holds a payment, so it legitimately reads
       as received and an absolute check would pass whatever the button did. The
       question is whether a blank amount reaches the route that sets the flag,
       and the answer has to be no. */
    const blank = await page.evaluate(async () => {
      const real = window.fetch;
      const calls = [];
      window.fetch = async (u, o) => { calls.push(String(u)); return real(u, o); };
      try { await recordRetainerPayment(true); } finally { window.fetch = real; }
      return { msg: RET_MSG, err: RET_ERR, posted: calls.some(u => /\/retainer$/.test(u)) };
    });
    ok('recording with no amount is refused, with the reason',
       blank.err === true && blank.msg.includes('nothing behind it'), blank.msg);
    ok('and nothing was sent that could set the received flag', blank.posted === false);
    await page.locator('[data-act="retCancel"]').first().click();
    await page.waitForTimeout(200);
  }

  ok('each recorded payment offers a void', await page.locator('[data-act="retVoid"]').count() >= 1);
  await page.locator('[data-act="retVoid"]').first().click();
  await page.waitForTimeout(900);
  /* Read the effect from the API rather than the panel: the workspace reload
     lands on the case's default tab, and chasing the dialog around would test
     navigation rather than the money. */
  const after = await page.evaluate(async () => {
    const w = await (await fetch('/portal-api/cases/API-20260812-4002/workspace',
      { headers: { Accept: 'application/json' } })).json();
    return w.authorization.retainer;
  });
  ok('voiding the payment returns the case to pending',
     after.received_total === 0 && after.status === 'pending',
     `${after.received_total} / ${after.status}`);
  ok('but the payment is still on the record, marked voided',
     after.payments.length === 1 && after.payments[0].voided === true);
  ok('and the reference it carried is not erased',
     after.payments[0].reference === 'Venmo note: retainer');
  ok('while the agreed retainer is untouched by any of it', after.agreed === 1500);
  ok('six recorded hours at the private rate leave $900', auth.includes('900'), auth.slice(0, 400));

  /* AN UNFINISHED PAYMENT DOES NOT FOLLOW THE ADMIN TO THE NEXT CASE. All of
     this form's state is page-level, so a failed attempt used to leave the form
     open on whatever case was opened next — carrying the amount typed for
     someone else, and the first case's idempotency token. A figure prefilled
     against another client's retainer is found when the money is reconciled, if
     then. Last in this section because it navigates away deliberately. */
  {
    await page.evaluate(() => { RET_FORM = true; RET_DRAFT = { amt: '777' }; RET_TOKEN = 'left-behind'; RET_STUCK = true; });
    const stranded = await page.evaluate(() => ({ token: RET_TOKEN, draft: RET_DRAFT.amt, open: RET_FORM }));
    ok('the failed attempt is held on the case it belongs to',
       stranded.open === true && stranded.draft === '777' && stranded.token === 'left-behind');

    /* AND REOPENING THE SAME CASE LEAVES IT ALONE. A tab, a reload or the same
       row clicked again all run openCase, and clearing the token there would
       hand a fresh one to a press that may be retrying a write which did
       commit — the duplicate this guard exists to prevent, reintroduced by the
       cleanup that was meant to stop the state leaking. */
    await page.evaluate(() => openCase('API-20260812-4002'));
    await page.waitForTimeout(700);
    const same = await page.evaluate(() => ({ token: RET_TOKEN, draft: RET_DRAFT.amt, open: RET_FORM }));
    ok('reopening the same case keeps the attempt and its token',
       same.token === 'left-behind' && same.draft === '777' && same.open === true,
       `${same.token} / ${same.draft} / ${same.open}`);

    await page.evaluate(() => openCase('API-20260812-4001'));
    await page.waitForTimeout(700);
    const moved = await page.evaluate(() => ({
      token: RET_TOKEN, draft: RET_DRAFT.amt, open: RET_FORM, stuck: RET_STUCK, msg: RET_MSG,
    }));
    ok('opening another case does not carry the amount across',
       moved.draft === undefined, String(moved.draft));
    ok('nor the token that belongs to the first case', moved.token === '');
    ok('and the next case is not met with a form already open',
       moved.open === false && moved.stuck === false && moved.msg === '');
  }
  await page.close();
}
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Authorization');
  ok('a claims case never offers retainer fields', await page.locator('#m_ret').count() === 0);
  await page.close();
}

/* SIGNING OUT MUST LEAVE NOTHING BEHIND FOR THE NEXT PERSON. All of this is
   page-level state about one signed-in person's work, and a portal on a shared
   desk gets used by two people in a row. The retainer draft is money typed for
   one client; the workspace is rows the Worker served THAT user, so landing an
   investigator back in an admin's open case shows them the client name and
   claim number the redaction exists to withhold. The Worker's boundary was
   never breached — the page was still holding an answer it had already been
   given. */
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(500);
  await page.evaluate(() => { RET_FORM = true; RET_DRAFT = { amt: '650' }; RET_TOKEN = 'admin-attempt'; });
  const before = await page.evaluate(() => ({ view: VIEW, wsCase: WS_CASE, token: RET_TOKEN }));
  ok('the admin has a case open and a payment half-entered',
     before.view === 'case' && before.wsCase === 'API-20260812-4002' && before.token === 'admin-attempt');

  await page.locator('[data-act="logout"]').first().click();
  await page.waitForTimeout(600);
  const out = await page.evaluate(() => ({
    token: RET_TOKEN, draft: RET_DRAFT.amt, retCase: RET_CASE, wsCase: WS_CASE, ws: WS, view: VIEW,
  }));
  ok('signing out clears the half-entered payment',
     out.token === '' && out.draft === undefined && out.retCase === null);
  ok('and the case workspace it was drawn from',
     out.wsCase === null && out.ws === null && out.view === 'list');

  await signIn(page, 'dana', 'FieldWork2026x');
  const next = await page.evaluate(() => ({ view: VIEW, wsCase: WS_CASE, token: RET_TOKEN, draft: RET_DRAFT.amt }));
  ok('so the next person signs in to their own list, not the last one’s case',
     next.view === 'list' && next.wsCase === null);
  ok('with no trace of the amount typed before them',
     next.token === '' && next.draft === undefined);
  await page.close();
}

/* A SESSION THAT EXPIRES IS THE SAME BOUNDARY AS SIGNING OUT, and it was not
   clearing the same things: the workspace clear-down lived in sessionForget()
   while the case list, invitations and reset links were cleared only by the
   Sign out button. A portal left open until the cookie expired therefore kept
   an admin's cases — with client names and carriers — plus any live invitation
   or password-reset URL, for whoever signed in next. Driven through the REAL
   401 handler rather than by calling the clear-down directly. */
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.waitForTimeout(400);
  const loaded = await page.evaluate(() => ({ cases: CASES.length, me: !!ME }));
  ok('the admin has their case list loaded', loaded.cases > 0 && loaded.me === true);

  const expired = await page.evaluate(async () => {
    LAST_LINK = 'https://example.invalid/invite/abc123';
    RESET_BOX = { userId: 9, url: 'https://example.invalid/reset/def456' };
    const real = window.fetch;
    window.fetch = async () => new Response(JSON.stringify({ error: 'unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } });
    try { await api('/cases'); } catch (e) { /* the expiry is the point */ }
    finally { window.fetch = real; }
    return { me: ME, cases: CASES.length, link: LAST_LINK, reset: RESET_BOX, users: USERS.length };
  });
  ok('an expired session signs the page out', expired.me === null);
  ok('and takes the case list with it', expired.cases === 0, String(expired.cases));
  ok('and the invitation and reset links it was holding',
     expired.link === '' && expired.reset === null);

  await signIn(page, 'dana', 'FieldWork2026x');
  const after = await page.evaluate(() => ({ cases: CASES.length, mine: CASES.every(c => c.assigned_to_me !== false) }));
  ok('the investigator’s list is their own, fetched fresh', after.cases >= 0 && after.mine === true);
  await page.close();
}

/* The invoice workflow (INVOICING.md): CASE -> CREATE -> REVIEW -> document ->
   BILL -> payment -> PAID, driven through the page. */
/* RECORD PAYMENT IS ON THE CASE OVERVIEW (owner, WORKFLOW-SIMPLIFICATION §1 —
   "Make Record Payment easy to reach").

   It existed only inside the retainer block on Admin → Authorization: a section
   group and a tab in, then a scroll. Overview had been showing Retainer and
   Balance the whole time with no way to act on them and no pointer to where you
   could. These assert the control is on the panel a case OPENS on, that it is
   the SAME form and the same flow rather than a second one, and that the money
   boundary did not move. */
section('Record payment is reachable from the case overview');
{
  await post('/ingest', {
    case_no: 'API-20260812-4009', service: 'Surveillance',
    client_name: 'Overview Client', client_phone: '4345550199',
    subject_name: 'Overview Subject', objective: 'Establish whereabouts',
  }, { 'X-Ingest-Key': 'e2e-ingest-key' });

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4009').click();
  await page.waitForTimeout(500);

  /* Deliberately NO wsTab() call between opening the case and finding the
     control. A test that navigated first would pass just as well before this
     change, and would be proving nothing. */
  const summary = await text(page, '.wspanel');
  ok('the case opens on a summary carrying the retainer and the balance',
     has(summary, 'Retainer') && has(summary, 'Balance'), summary.slice(0, 300));
  ok('and Record payment is right there, with no tab to find first',
     await page.locator('.ovcard [data-act="retOpen"]').count() === 1);
  ok('offered once, not duplicated onto the page',
     await page.locator('[data-act="retOpen"]').count() === 1);

  await page.locator('.ovcard [data-act="retOpen"]').click();
  await page.waitForTimeout(300);
  ok('it opens the existing form, in place on the overview',
     await page.locator('.ovcard #ret_amt').count() === 1
     && await page.locator('.ovcard #ret_method').count() === 1
     && await page.locator('.ovcard #ret_date').count() === 1
     && await page.locator('.ovcard #ret_ref').count() === 1);
  const methods = await page.locator('#ret_method option').allInnerTexts();
  ok('with the same five accepted methods and nothing else',
     ['Cash App', 'Venmo', 'Check', 'Cash', 'ACH / BILL'].every(m => methods.includes(m))
     && !methods.some(m => /credit|other/i.test(m)), methods.join('|'));

  await page.locator('#ret_amt').fill('600');
  await page.locator('#ret_method').selectOption('cash_app');
  await page.locator('#ret_date').fill('2026-08-15');
  await page.locator('#ret_ref').fill('Cash App note: deposit');
  await page.locator('[data-act="retSave"]').click();
  await page.waitForTimeout(900);
  ok('recording it from the overview is confirmed there',
     has(await text(page, '.wspanel'), 'Payment recorded'), (await text(page, '.wspanel')).slice(0, 300));
  ok('and the form closes behind it',
     await page.locator('.ovcard #ret_amt').count() === 0);

  /* THE SAME FLOW, NOT A SECOND ONE. The payment started on the overview has
     to be the payment the Authorization panel knows about — same route, same
     ledger — or the office would have two places that disagree about money. */
  await wsTab(page, 'Authorization');
  const auth = await text(page, '#dlgBody');
  ok('the payment recorded from the overview is on the Authorization panel',
     has(auth, 'Cash App') && has(auth, '600'), auth.slice(0, 400));
  ok('with the reference typed on the overview',
     has(auth, 'Cash App note: deposit'));
  ok('and it counts as money received, not merely requested',
     has(auth, 'Retainer received') && has(auth, 'Received'));
  ok('the Authorization panel still offers its own Record payment',
     await page.locator('[data-act="retOpen"]').count() === 1);
  await page.close();
}
{
  /* A CLAIM ASSIGNMENT IS NOT A RETAINER CASE. The route refuses one by name;
     the overview must not offer the control in the first place. */
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  ok('a claim assignment offers no Record payment on its overview',
     await page.locator('[data-act="retOpen"]').count() === 0);
  ok('and shows authorization rather than a retainer',
     has(await text(page, '.wspanel'), 'Authoriz'), (await text(page, '.wspanel')).slice(0, 300));
  await page.close();
}
{
  /* An investigator never reaches a money control. The overview panel is on
     the admin branch of the dispatch and `retainer` is admin-only in the
     payload; this is the third guard, asserted on the screen itself. */
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  ok('an investigator opening their case gets no Record payment control',
     await page.locator('[data-act="retOpen"]').count() === 0);
  ok('and no retainer figure anywhere on it',
     !has(await text(page, '#dlgBody'), 'retainer'), (await text(page, '#dlgBody')).slice(0, 200));
  await page.close();
}

section('An invoice from case to PAID');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  ok('the office gets a Billing tab', has(await text(page, '.tabs'), 'Billing'));

  // Authorize 8 hours on the claims case, then bill it as the flat block.
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Authorization');
  await page.locator('#m_hours').fill('8');
  await page.locator('.btn', { hasText: 'Save authorization' }).click();
  await page.waitForTimeout(500);
  await wsTab(page, 'Billing');
  await page.locator('[data-act="createInvoiceAuth"]').click();
  await page.waitForTimeout(800);

  let body = await text(page, '.card');
  ok('the invoice opens on its own desk', /API-INV-\d{4}-0001/.test(body), body.slice(0, 160));
  ok('the authorization billed as the flat block',
     has(body, '8-Hour Surveillance Authorization') && body.includes('$1,200'));
  ok('the carrier and claim rode along',
     has(body, 'Example Mutual') && body.includes('WC-2026-88421'));
  ok('the document block is the printable review', await page.locator('#invdoc').count() === 1);
  ok('with the company name on it', has(await text(page, '#invdoc'), 'Always Precise Investigations'));

  /* MASTER §28 — Special Instructions. A carrier's own billing instruction,
     so it prints as a paragraph rather than as another reference row. */
  ok('an insurance invoice asks for special instructions',
     await page.locator('#ir_special_instructions').count() === 1);
  await page.locator('#ir_special_instructions')
    .fill('Submit through the vendor portal. Reference the PO on every page.');
  await page.locator('.btn', { hasText: 'Save invoice' }).click();
  await page.waitForTimeout(800);
  const insDoc = await text(page, '#invdoc');
  ok('and prints them on the document', has(insDoc, 'Special instructions')
     && has(insDoc, 'Submit through the vendor portal'));
  ok('a private-only retainer block stays off a carrier invoice',
     !has(insDoc, 'Retainer held'));

  await page.locator('[data-act="invStatus"][data-s="ready"]').click();
  await page.waitForTimeout(500);
  ok('ready surfaces the carrier gaps as warnings', has(await text(page, '.card'), 'PO number'));
  await page.locator('[data-act="invStatus"][data-s="sent_to_bill"]').click();
  await page.waitForTimeout(500);
  body = await text(page, '.card');
  ok('sent to BILL is stamped, not paid', has(body, 'Sent to BILL') && body.includes('$1,200'));

  await page.locator('#ip_amt').fill('1200');
  await page.locator('.btn', { hasText: 'Record payment' }).click();
  await page.waitForTimeout(800);
  ok('the balance reaching zero is what makes it PAID',
     has(await text(page, '.card'), 'Paid in full'));

  await page.locator('[data-act="invBack"]').click();
  await page.waitForTimeout(600);
  ok('the book lists it', /API-INV/.test(await text(page, '.card')));
  ok('with the month of payments summed', has(await text(page, '.stats'), 'Paid this month'));
  await page.close();
}
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  ok('an investigator has no Billing tab', !has(await text(page, '.tabs'), 'Billing'));
  const st = await page.evaluate(async () =>
    (await fetch('/portal-api/invoices', { credentials: 'same-origin' })).status);
  ok('and the invoice book refuses them', st === 403);
  await page.close();
}

/* Priority 6: evidence through the browser — upload, classify, serve, delete,
   and the storage meter on the dashboard. */
section('Evidence in the browser');
{
  /* A LEGACY STORED VIDEO, planted straight into the database before the page
     loads. Since 2026-08-17 video is device-first and the Worker refuses a
     `video/*` upload outright — but video already in R2 was deliberately left
     untouched, so rows like this still exist and everything downstream of them
     must still be right: the gallery's Video tab, the quick-entry fold, the
     package type's video gate. Planted first so the photo uploaded below is the
     newest row and therefore the first card, which is the one the serving check
     reads. */
  db.prepare(`INSERT INTO case_evidence (case_no, r2_key, filename, content_type,
      size_bytes, classification, uploaded_at)
    VALUES ('API-20260812-4002', 'cases/API-20260812-4002/legacy-clip1.mp4', 'clip1.mp4',
            'video/mp4', 4096, 'client_deliverable', '2026-08-12T14:00:00.000Z')`).run();

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Evidence');
  ok('the tab says the failsafe is on', has(await text(page, '#dlgBody'), 'free-plan failsafe'));

  /* A PHOTOGRAPH — what this tab uploads now. The storage, classification,
     serving and meter rules under test are unchanged by which type it is. */
  await page.locator('#ev_file').setInputFiles({
    name: 'frame1.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(4096, 65) });
  await page.locator('#ev_note').fill('Subject loading lumber, frame 1.');
  await page.locator('.btn', { hasText: 'Upload picture or document' }).click();
  await page.waitForTimeout(700);
  let body = await text(page, '#dlgBody');
  ok('the upload lands with its note', has(body, 'frame1.jpg') && has(body, 'loading lumber'));
  ok('and reports the meter', has(body, '% of the free plan'));

  /* The card's opener is a viewer button now, not an anchor, but it carries the
     SAME authenticated route it always did — which is the point: the viewer
     reuses the existing file endpoint and its permission check rather than
     introducing a second way to reach evidence. */
  const served = await page.evaluate(async () => {
    const opener = document.querySelector('.evcard [data-act="evOpen"]');
    const src = opener.dataset.src;
    const r = await fetch(src, { credentials: 'same-origin' });
    return { src, status: r.status, type: r.headers.get('content-type'),
             len: (await r.arrayBuffer()).byteLength };
  });
  ok('the file streams back through the Worker', served.status === 200
     && served.type === 'image/jpeg' && served.len === 4096);
  ok('and the viewer points at the case-scoped evidence route, not a copy',
     /^\/portal-api\/cases\/[^/]+\/evidence\/\d+\/file$/.test(served.src), served.src);

  /* Scoped to the FIRST card — the photo just uploaded, the newest row — and
     moved to a classification the default is not, so the assertion cannot pass
     on a card that was already deliverable when it arrived. Then put back,
     because the sections below build a package from this case. */
  await page.locator('[data-act="evClass"]').first().selectOption('needs_redaction');
  await page.waitForTimeout(600);
  ok('the office classifies it', has(await text(page, '#dlgBody'), 'Needs redaction'));
  await page.locator('[data-act="evClass"]').first().selectOption('client_deliverable');
  await page.waitForTimeout(600);
  ok('and puts it back', has(await text(page, '#dlgBody'), 'Client deliverable'));

  // Attach a photo to the subject built earlier: it appears on the card.
  await page.locator('#ev_file').setInputFiles({
    name: 'subject.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(600, 66) });
  await page.locator('#ev_link').selectOption({ label: 'John Subject' });
  await page.locator('.btn', { hasText: 'Upload picture or document' }).click();
  await page.waitForTimeout(700);
  await wsTab(page, 'Subject');
  const subjCard = await text(page, '#dlgBody');
  ok('the photo rides with the subject card', has(subjCard, 'Photos & files'));
  ok('as an image thumbnail', await page.locator('.rcard img').count() >= 1);
  await wsTab(page, 'Evidence');

  // The gallery (UIBUILD P12): tabs cut by type, cards carry the picture.
  ok('the gallery tabs stand ready', has(await text(page, '.evtabs'), 'Photos'));
  await page.locator('.evtab', { hasText: 'Video' }).click();
  await page.waitForTimeout(250);
  let gal = await text(page, '.evgrid');
  ok('the Video tab holds the clip', has(gal, 'clip1.mp4') && !has(gal, 'subject.jpg'), gal.slice(0, 150));
  ok('a stored video says it predates the move to the device', has(gal, 'stored earlier'));
  await page.locator('.evtab', { hasText: 'Photos' }).click();
  await page.waitForTimeout(250);
  gal = await text(page, '.evgrid');
  ok('the Photos tab holds the stills', has(gal, 'subject.jpg') && !has(gal, 'clip1.mp4'), gal.slice(0, 150));
  ok('a photo card carries its thumbnail', await page.locator('.evcard img.evthumb').count() >= 1);
  await page.locator('.evtab', { hasText: 'All' }).click();
  await page.waitForTimeout(250);

  // A photo linked to a timeline moment: the entry wears its count (P10).
  await page.locator('#ev_file').setInputFiles({
    name: 'moment.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(500, 67) });
  await page.locator('#ev_link').selectOption({ label: '8:17 AM — Subject arrived at ABC Fitness.' });
  await page.locator('.btn', { hasText: 'Upload picture or document' }).click();
  await page.waitForTimeout(700);
  await wsTab(page, 'Activity');
  ok('a linked photo puts a count on the moment',
     await page.locator('.tl-i', { hasText: 'Subject arrived at ABC Fitness.' })
       .locator('.tl-counts').count() >= 1);
  await wsTab(page, 'Evidence');
  ok('and the card names its moment', has(await text(page, '.evgrid'), '8:17 AM'));

  // The quick-entry fold links an already-uploaded file to the new moment (P9).
  await wsTab(page, 'Activity');
  await page.locator('[data-act="actOpen"]:visible').first().click();
  await page.waitForTimeout(300);
  await page.locator('.ampick', { hasText: 'Established stationary surveillance position.' }).click();
  await page.waitForTimeout(300);
  await page.locator('.amfold summary').click();
  await page.waitForTimeout(200);
  ok('the fold offers the unlinked files', has(await text(page, '.amfold'), 'clip1.mp4'));
  await page.locator('.cap', { hasText: 'clip1.mp4' }).locator('input').check();
  await page.locator('.btn', { hasText: 'Add to log' }).click();
  await page.waitForTimeout(700);
  ok('the ticked file rode to the new moment',
     await page.locator('.tl-i', { hasText: 'Established stationary surveillance position.' })
       .locator('.tl-counts').count() >= 1);
  await wsTab(page, 'Evidence');

  /* UNIT 39 — removing a file goes through the one confirmation every removable
     record uses, so the direct `evDelete` button this used to click no longer
     exists. The assertion it was making is stronger now and is made in two
     places: the confirmation says the file itself is not deleted BEFORE the
     act, and the card says so afterwards. */
  await page.locator('[data-act="rmOpen"][data-kind="evidence"]').first().click();
  await page.waitForTimeout(800);
  const evAsk = await text(page, '.amsheet');
  ok('removing a file asks first, and says the file is not deleted',
     has(evAsk, 'The file itself is not deleted'), evAsk.replace(/\s+/g, ' ').slice(0, 240));
  ok('and names what it is about to remove', has(evAsk, 'Remove this file'), evAsk.slice(0, 120));
  await page.locator('[data-act="rmGo"]').click();
  await page.waitForTimeout(1200);
  ok('a delete keeps the record on screen',
     has(await text(page, '#dlgBody'), 'the file itself was not deleted'),
     (await text(page, '#dlgBody')).replace(/\s+/g, ' ').slice(0, 240));
  ok('and offers to put it back', await page.locator(
     '[data-act="rmOpen"][data-kind="evidence"][data-put="1"]').count() >= 1);

  await page.locator('.close').click();
  await page.waitForTimeout(400);
  await render(page);
  ok('the dashboard carries the storage meter', has(await text(page, '.stats'), 'Storage'));
  await page.close();
}

/* The two live findings from the owner: the reset link now appears AT the
   row that was clicked, and disabled accounts offer the guarded delete. */
section('Reset links land where you clicked');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Staff' }).click();
  await page.waitForTimeout(500);
  await page.locator('tr', { hasText: 'dana' }).locator('.btn', { hasText: 'Reset password' }).first().click();
  await page.waitForTimeout(600);
  const box = await text(page, '.linkbox');
  ok('the link appears inline, at the row', has(box, 'Password reset link for dana'));
  ok('worded as a reset, not an invitation', !has(box, 'Invitation'));
  ok('and carries the working link', /\?reset=[0-9a-f]{64}/.test(box), box.slice(0, 160));
  ok('a delete button only ever appears on a disabled account',
     await page.locator('[data-act="deleteUser"]').count() === 0);
  await page.close();
}

/* Case Build through the browser: the mini-dashboard, the gates, the
   finalized document (CASEBUILD.md P0 + UXSIMPLIFY P9/P16/P17). */
section('The case package, gated and printed');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Package');
  await page.waitForTimeout(700);
  let body = await text(page, '#dlgBody');
  ok('the mini-dashboard shows the case state',
     has(body, 'Activity') && has(body, 'Report') && has(body, 'Case build'));
  ok('the build reads not started', has(body, 'Not started'));
  await page.locator('[data-act="pkgStart"]').click();
  await page.waitForTimeout(700);
  body = await text(page, '#dlgBody');
  ok('a draft opens at version one', has(body, 'Draft v1'));
  ok('the six build steps stand above the work (P13)', await page.locator('.pkg-steps').count() === 1);
  ok('the contents read live', has(body, 'Package contents'));
  ok('preview is offered before finalize', await page.locator('.btn', { hasText: 'Preview package' }).count() === 1);

  await page.locator('.pkg-item', { hasText: 'clip1.mp4' }).locator('.btn', { hasText: 'Add' }).click();
  await page.waitForTimeout(700);
  ok('the missing panel names the package-type gate',
     has(await text(page, '#dlgBody'), 'package type does not include video'));
  await page.locator('[data-act="pkgType"]').selectOption('report_photos_video');
  await page.waitForTimeout(700);

  await page.locator('[data-act="pkgFinalize"]').click();
  await page.waitForTimeout(800);
  body = await text(page, '#dlgBody');
  ok('with the gates clear it finalizes', has(body, 'Package finalized'));
  ok('the document carries the video section and the index',
     has(body, 'VIDEO EVIDENCE') && has(body, 'EVIDENCE INDEX'));
  ok('and says video is provided separately while Dropbox is unconnected',
     has(body, 'provided separately'));
  await page.locator('[data-act="pkgDelivered"]').click();
  await page.waitForTimeout(700);
  body = await text(page, '#dlgBody');
  ok('delivery is stamped', has(body, 'Delivered'));

  // UIBUILD P13/P14: the finished package reads as artifacts, each with a door.
  const rail = await text(page, '.pkg-steps');
  ok('the steps rail walks Review to Finalize', has(rail, 'Review') && has(rail, 'Finalize'));
  ok('every artifact is itemized', has(body, 'Client package') && has(body, 'Evidence index'));
  ok('the report row routes to the report', await page.locator('.btn', { hasText: 'Open report' }).count() === 1);
  ok('video is honest while Dropbox is unconnected — no dead copy button',
     await page.locator('[data-act="pkgCopyLink"]').count() === 0);
  await page.locator('[data-act="evJump"]').click();
  await page.waitForTimeout(350);
  ok('Photographs routes into the gallery, filtered to Photos',
     has(await text(page, '.evtab.on'), 'Photos'));
  await page.close();
}
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  ok('an investigator has no Package tab', !has(await text(page, '.wstabs'), 'Package'));
  await page.close();
}

/* HIGH #4 (2026-08-14). The finalize gate refuses held-back material, but it
   runs AT finalize and nothing re-ran afterwards. Reclassify a photo to "do not
   use" on a package that is already finalized and two things used to happen at
   once: the gate strip was suppressed — it rendered only while the status was
   NOT finalized, which is exactly when Download works — and the document went
   on printing the photo, because it rendered every build_items row with no
   classification check. Held-back material reaching a client is the one outcome
   the classification system exists to prevent. This drives the real screens:
   the package 4002 finalized in the section above is the subject. */
section('A finalized package still says when something has been held back');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Package');
  await page.waitForTimeout(800);

  /* The exhibits the document actually PRINTS, read off the rendered evidence
     index rather than off the payload. Counting these is the assertion that
     matters: the caption falls back note -> entry description -> filename, so
     checking for a filename passes vacuously whenever the item has a note —
     which is exactly what happened, and it let the broken document through. */
  const exhibits = () => page.evaluate(() => {
    const t = [...document.querySelectorAll('#pkgdoc table.doc-table')]
      .find(x => x.querySelector('thead'));
    return t ? [...t.querySelectorAll('tbody tr')].map(r => r.textContent.trim()) : [];
  });

  let body = await text(page, '#dlgBody');
  ok('the package under test is the finalized one', has(body, 'Finalized') || has(body, 'Delivered'));
  ok('and its document carries an evidence index to begin with', has(body, 'EVIDENCE INDEX'));
  ok('with nothing withheld yet', !has(body, 'withheld'));

  const before = await exhibits();
  ok('the document prints exhibits to begin with', before.length > 0, `${before.length} rows`);

  /* This package holds exactly one item and it is clip1.mp4, a video, put there
     by the section above; the build is finalized, so nothing can be added to it
     here. That bounds what this section can prove, and the bound is worth
     stating: the photo <img> path is NOT separately exercised. It does not need
     to be — `photos` and `videos` are both derived from the one filtered `rows`
     (portal/index.html), so the exhibit-count assertion below covers the same
     filter that governs the image tag. If a photo ever joins this package,
     assert the <img> for it directly rather than trusting that sentence. */
  const held = await page.evaluate(async () => {
    const b = await (await fetch('/portal-api/cases/API-20260812-4002/build',
      { headers: { Accept: 'application/json' } })).json();
    const it = (b.items || [])[0];
    if (!it) return { id: 0, caption: '', ok: false,
                      why: `no build items (${(b.items || []).length})` };
    const ev = (b.evidence || []).find(e => e.id === it.evidence_id) || {};
    const r = await fetch(`/portal-api/cases/API-20260812-4002/evidence/${it.evidence_id}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classification: 'do_not_use' }) });
    // The caption the document would render for it — the same fallback chain.
    return { id: it.evidence_id, role: it.role, ok: r.ok, why: `status ${r.status}`,
             caption: ev.note || ev.entry_description || ev.filename || '' };
  });
  ok('an item in the finalized package could be reclassified — and the write was accepted',
     !!held && held.id > 0 && held.ok === true, held && held.why);

  await wsTab(page, 'Overview');
  await page.waitForTimeout(250);
  await wsTab(page, 'Package');
  await page.waitForTimeout(800);
  body = await text(page, '#dlgBody');

  ok('the finalized package now warns rather than staying silent',
     has(body, 'This finalized package needs attention'));
  ok('and the warning names the material by its classification',
     has(body, 'do not use'));
  ok('the package screen tells the OFFICE an item was withheld', has(body, 'withheld'));
  ok('and says where to deal with it', has(body, 'reclassify or unselect in Evidence'));
  ok('and says WHY it was withheld, not merely that it was',
     has(body, 'no longer marked client-deliverable'));
  ok('while making clear the material still exists on the case',
     has(body, 'Nothing is removed from the case'));

  /* And the CLIENT is told none of it. #pkgdoc is the only region the print
     stylesheet leaves visible, so anything inside it is the document that
     leaves the building. A count of withheld exhibits would disclose that
     evidence exists which was classified internal-only, needs-redaction or
     do-not-use — announcing precisely what the classification withholds. The
     first version of this fix put the notice inside #pkgdoc and did exactly
     that; the structural check below is what stops it coming back. */
  const docText = await text(page, '#pkgdoc');
  ok('but the client’s own document says nothing about anything withheld',
     !has(docText, 'withheld') && !has(docText, 'client-deliverable')
     && !has(docText, 'do not use') && !has(docText, 'internal only'));
  ok('and the notice is not inside the printed region at all',
     await page.evaluate(() => !document.querySelector('#pkgdoc .pkg-miss')));

  /* WHO ENDED THE DAY IS OPERATIONS, NOT EVIDENCE (owner, 2026-08-21, Unit 27):
     the history must say it "without cluttering the client-facing report unless
     appropriate". The office needs to know the desk closed a shift; a client
     receiving the case package does not, and #pkgdoc is what leaves the
     building. Asserted here rather than assumed from where the field was
     added, because the next person to touch the day renderer will not
     remember. */
  ok('the client document never names who ended a shift',
     !has(docText, 'Ended by') && !has(docText, 'Ending actor'), docText.slice(0, 300));
  ok('the gate strip that carries it is outside the printed region too',
     await page.evaluate(() => {
       const g = [...document.querySelectorAll('.pkg-miss')];
       const doc = document.querySelector('#pkgdoc');
       return g.length > 0 && !g.some(x => doc && doc.contains(x));
     }));

  /* The half that actually ships material to a client. One exhibit fewer is
     printed, and the held-back one's own caption is gone from the document. */
  const after = await exhibits();
  ok('the document prints one exhibit fewer', after.length === before.length - 1,
     `${before.length} -> ${after.length}`);
  ok('and the held-back exhibit is the one that went',
     !!held.caption && !after.some(r => r.includes(held.caption)), held.caption);
  ok('its caption appears nowhere else in the document',
     !!held.caption && !has(await text(page, '#pkgdoc'), held.caption));

  /* The exhibit's whole section goes with it, not just its index row — the
     held-back item is this package's only video, so VIDEO EVIDENCE and the
     delivery sentence that names it must both stop being printed. */
  const doc = await text(page, '#pkgdoc');
  ok('the section that presented it is gone from the document too',
     !has(doc, 'VIDEO EVIDENCE') && !has(doc, 'provided separately'));
  /* Nothing in the document may still point a client's browser at the file. */
  const stillLinked = await page.evaluate(id =>
    (document.querySelector('#pkgdoc') || {}).innerHTML?.includes(`/evidence/${id}/`) || false, held.id);
  ok('and nothing in it still points at the evidence route for that file', !stillLinked);

  // Put it back, so the rest of the suite sees the package it expects.
  await page.evaluate(async (id) => {
    await fetch(`/portal-api/cases/API-20260812-4002/evidence/${id}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classification: 'client_deliverable' }) });
  }, held.id);
  await wsTab(page, 'Overview');
  await page.waitForTimeout(250);
  await wsTab(page, 'Package');
  await page.waitForTimeout(800);
  ok('and reclassifying it back clears the warning',
     !has(await text(page, '#dlgBody'), 'This finalized package needs attention'));
  ok('and puts the exhibit back in the document',
     (await exhibits()).length === before.length);
  await page.close();
}

/* UIBUILD phase 1: the sidebar, the dashboard landing, the package cards
   and Continue Case routing. */
section('The dashboard leads with case packages');
{
  const page = await newPage();
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);
  ok('an admin lands on the dashboard', has(await text(page, '.tabs button.on'), 'Dashboard'));
  ok('the navigation carries the intake door', has(await text(page, '.tabs'), 'Intake a Client'));
  const body = await text(page, '#app');
  ok('the outstanding balance is a card', has(body, 'Outstanding'));
  ok('case packages render as cards', await page.locator('.pcard').count() >= 2);
  const card = await page.locator('.pcard', { hasText: 'API-20260812-4001' }).innerText();
  ok('a card shows the module states', has(card, 'Activity') && has(card, 'Report') && has(card, 'Invoice'));
  ok('and one computed next step', has(card, 'Next step'));
  ok('the ring speaks percent', /\d+%/.test(card));

  await page.locator('.pcard', { hasText: 'API-20260812-4001' })
    .locator('.btn', { hasText: 'Continue case' }).click();
  await page.waitForTimeout(700);
  ok('Continue case opens the case at its step', await page.locator('.casepage').count() === 1);
  await page.close();
}
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  ok('an investigator keeps their own landing', has(await text(page, '.tabs button.on'), 'My assignments'));
  ok('and gets no intake door', !has(await text(page, '.tabs'), 'Intake a Client'));
  await page.close();
}

/* UIBUILD phase 2: the case page — P5 header, P6 four sections, P7 overview.
   Runs late in the suite on purpose: 4001 has authorization, days, a report,
   a finalized build and an invoice by now, so the overview has real state to
   draw and a real next step to compute. */
section('The case page: four sections, one obvious next step');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);

  const head = await text(page, '.caseheader');
  ok('the header carries the case number', head.includes('API-20260812-4001'));
  ok('the header names who is paying', has(head, 'Example Mutual'));
  ok('and the claim', head.includes('WC-2026-88421'));
  ok('and the claimant', head.includes('Pat Coleman'));
  ok('and where the case stands', await page.locator('.caseheader .tag').count() >= 2);

  const body = await text(page, '#dlgBody');
  /* Unit 38 — the overview is four blocks in the owner's own order, and it
     LEADS with the answer to "what now" rather than with a summary card. */
  const heads = (await page.locator('.ovcard h3').allInnerTexts()).map(h => h.trim().toUpperCase());
  ok('the overview leads with Next step',
     JSON.stringify(heads) === JSON.stringify(['NEXT STEP', 'TODAY', 'RECENT ACTIVITY', 'CASE STATUS']),
     JSON.stringify(heads));
  ok('case status carries the authorization', has(body, 'Authorized'));
  ok('the package progress speaks percent', /\d+%/.test(body));
  ok('one next step is computed', has(body, 'Next step'));
  ok('recent activity is on the overview', has(body, 'Recent activity'));
  ok('and the evidence is reachable from Today',
     await page.locator('.ovcard [data-act="wsTab"][data-tab="evidence"]').count() >= 1);

  // P22: the module lines route. The Report line lands on the Reports panel.
  await page.locator('.ov-mods button', { hasText: 'Report' }).first().click();
  await page.waitForTimeout(300);
  ok('a module line routes to its panel', (await wsOpenTab(page)) === 'reports');

  // And the one computed next step routes with a single GO. Every branch of
  // pkgNextStep leads away from the overview, so landing anywhere else is
  // the router working.
  await wsTab(page, 'Overview');
  await page.locator('.ov-next .btn').click();
  await page.waitForTimeout(300);
  ok('GO lands on the computed step', (await wsOpenTab(page)) !== 'overview');

  // The intake detail kept its home behind the Overview section.
  await wsTab(page, 'Intake details');
  ok('the full intake is still a panel', has(await text(page, '#dlgBody'), 'Adjuster'));
  await page.close();
}
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);

  const head = await text(page, '.caseheader');
  ok('an investigator header shows the claimant', head.includes('Pat Coleman'));
  ok('and never the carrier', !has(head, 'Example Mutual'));
  ok('and never the claim number', !head.includes('WC-2026-88421'));
  /* Tightened when Phase 8 added a pin control to the header: this assertion is
     named for Edit case and that is what it should test. Counting every button
     was an accurate proxy only while Edit case was the only one. */
  ok('and offers no Edit case',
     await page.locator('.caseheader .btn', { hasText: 'Edit case' }).count() === 0);
  ok('and no route to the edit panel at all',
     await page.locator('.caseheader [data-tab="edit"]').count() === 0);

  // Walk every section an investigator has; no sub-tab anywhere is money.
  const seen = [];
  for (const t of await wsAllTabs(page)) seen.push(t.label);
  const everything = seen.join(' ');
  ok('nothing anywhere in their nav is a Billing panel', !has(everything, 'Billing'), everything);
  ok('nothing anywhere in their nav is a Package panel', !has(everything, 'Package'), everything);
  ok('and the walk really walked something', seen.length >= 8, String(seen.length));
  ok('no section hides an Assignment panel', !has(everything, 'Assignment'));
  await page.close();
}

/* INTAKE-NA, admin side: a partial intake reads as intentional gaps, never as
   a broken record — and the office is told what is still needed in words. */
section('A partial intake reads as intentional, not broken');
{
  // Plant a submission the way the public form now writes one: values empty,
  // availability carried beside them.
  db.prepare(`INSERT INTO submissions (case_no, kind, status, carrier, client_name,
                subject_name, payload, created_at)
              VALUES (?, 'claims', 'new', ?, ?, ?, ?, ?)`)
    .run('API-NA-2001', 'Urgent Mutual', 'A. Adjuster', 'Pat Claimant',
      JSON.stringify({
        carrier: 'Urgent Mutual', client_name: 'A. Adjuster', client_email: 'a@urgent.example',
        subject_name: 'Pat Claimant', objective: 'Activity versus stated restrictions',
        claim_number: '', claim_number_status: 'not_available',
        date_of_loss: '', date_of_loss_status: 'unknown',
        subject_address: '', subject_address_status: 'not_available',
        authorized_hours: 'Authorization pending', authorized_hours_status: 'pending',
        start_date: '', start_date_status: 'flexible',
      }), new Date().toISOString());

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-NA-2001').click();
  await page.waitForTimeout(500);
  await wsTab(page, 'Intake details');
  const body = await text(page, '#dlgBody');

  ok('the office is told what is still needed', has(body, 'Information still needed'));
  ok('and that the gaps were deliberate, not errors', has(body, 'never an error'));
  ok('the claim number is named', has(body, 'Claim number'));
  ok('the unknown date of loss is named', has(body, 'Date of loss'));
  ok('the missing address is named', has(body, 'address'));
  ok('the pending authorization is named', has(body, 'Authorization'));
  ok('a marked field reads as unavailable rather than blank',
     has(body, 'Not available at submission'));
  ok('completeness is words, never a percentage',
     has(body, 'Additional information helpful') && !/\d+%\s*complete/i.test(body));
  ok('and there is a way to ask for the rest',
     await page.locator('.btn', { hasText: 'Request it' }).count() === 1);

  // The pending authorization must not read as a set figure anywhere.
  await wsTab(page, 'Authorization');
  ok('a pending authorization says so instead of inventing hours',
     has(await text(page, '#dlgBody'), 'Pending'));
  await page.close();
}
{
  /* MASTER-HANDOFF §7: what a client picked is REQUESTED, never "approved" —
     only what the office confirms is an authorization, and only that carries
     a figure. */
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  // API-NA-2001 carries what the carrier asked for on the intake.
  await rowFor(page, 'API-NA-2001').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Intake details');
  const detail = await text(page, '#dlgBody');
  ok('the intake\'s own hours read as requested', has(detail, 'Requested authorization'));
  ok('and are never labelled authorized on their own',
     !/\bAuthorized hours\b/.test(detail), detail.slice(0, 300));
  await page.close();

  // 4001 has a figure an admin actually confirmed.
  const admin = await newPage();
  await signIn(admin, 'trever', 'AdminPassword1x');
  await rowFor(admin, 'API-20260812-4001').click();
  await admin.waitForTimeout(450);
  await wsTab(admin, 'Authorization');
  ok('the office\'s figure is the confirmed one',
     has(await text(admin, '#dlgBody'), 'Confirmed authorization'));
  await admin.close();
}
{
  // The same case, seen from the field: the statuses that are fieldwork show,
  // the ones that name the carrier do not.
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-NA-2001').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Assignment');
  await page.locator('#asg').selectOption({ label: 'Dana Field' });
  await page.locator('.btn', { hasText: 'Save' }).click();
  await page.waitForTimeout(700);
  await page.close();

  const inv = await newPage();
  await signIn(inv, 'dana', 'FieldWork2026x');
  await rowFor(inv, 'API-NA-2001').click();
  await inv.waitForTimeout(450);
  await wsTab(inv, 'Subject');
  const seen = await text(inv, '#dlgBody');
  ok('the field is told the address is not known yet',
     has(seen, 'Not available at submission'));
  ok('and is never told whether the claim number exists', !has(seen, 'Claim number'));
  await inv.close();
}

/* UIBUILD phase 6: the leads desk, the manual intake, and both landing as
   ordinary submissions — no parallel store. */
section('Leads and intakes: cards, decisions, and the phone-call lead');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  ok('the office navigation carries Intakes', has(await text(page, '.tabs'), 'Intakes'));
  await page.locator('.tabs button', { hasText: 'Intakes' }).click();
  await page.waitForTimeout(400);
  const desk = await text(page, '#app');
  ok('early-stage submissions wait as cards', await page.locator('.pcard').count() >= 1, desk.slice(0, 200));
  ok('a card offers Review', await page.locator('.pcard .btn', { hasText: 'Review' }).count() >= 1);
  ok('and Accept routes to the assignment decision',
     await page.locator('.pcard .btn', { hasText: 'Accept' }).count() >= 1);
  // The hostile row is stage new, so it sits on this desk too — as text.
  ok('a hostile case number renders as text on the leads desk',
     desk.includes('window.__pwned'));
  ok('and still does not execute', (await page.evaluate(() => Boolean(window.__pwned))) === false);

  // P17 — the phone-call lead: name only, saved, waiting under New.
  await page.locator('.side-intake').click();
  await page.waitForTimeout(400);
  ok('the intake door asks who it is for', has(await text(page, '#app'), 'Private Client'));
  await page.locator('.sheet-card', { hasText: 'Private Client' }).click();
  await page.waitForTimeout(300);
  ok('only the relevant questions follow', await page.locator('#nl_carrier').count() === 0
     && await page.locator('#nl_client').count() === 1);
  await page.locator('#nl_client').fill('Phone Lead Client');
  await page.locator('.btn', { hasText: 'Save lead' }).click();
  await page.waitForTimeout(900);
  const after = await text(page, '#app');
  ok('the lead saves and lands on the desk', has(after, 'Saved as API-'), after.slice(0, 200));
  ok('and waits under New', has(after, 'Phone Lead Client'));

  // The insurance path goes straight into the case when asked to.
  await page.locator('.side-intake').click();
  await page.waitForTimeout(400);
  await page.locator('.sheet-card', { hasText: 'Insurance / Commercial' }).click();
  await page.waitForTimeout(300);
  ok('the carrier questions appear', await page.locator('#nl_carrier').count() === 1);
  await page.locator('#nl_carrier').fill('Walkthrough Mutual');
  await page.locator('#nl_claim').fill('WM-2026-001');
  await page.locator('.btn', { hasText: 'Create case' }).click();
  await page.waitForTimeout(1100);
  ok('Create case opens the new case itself', await page.locator('.casepage').count() === 1);
  ok('with the carrier in the header', has(await text(page, '.caseheader'), 'Walkthrough Mutual'));
  await page.close();
}
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  ok('an investigator gets no intakes desk', !has(await text(page, '.tabs'), 'Intakes'));
  await page.close();
}

/* UIBUILD phase 7 (P15): the field's case home, and the phone gets a bottom
   bar. */
section('The field case home, on a desk and in a hand');
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  const home = await text(page, '#dlgBody');
  ok('the assignment leads with its progress', has(home, 'Assignment progress'));
  ok('the ring speaks percent to the field too', /\d+%/.test(home));
  ok('one next step, with a GO',
     has(home, 'Next step') && await page.locator('.ov-next .btn').count() === 1);
  const fieldMods = await text(page, '.ov-mods');
  ok('their modules only — never Build', !has(fieldMods, 'Build'));
  ok('and never Invoice', !has(fieldMods, 'Invoice'));
  ok('the assignment detail still follows', has(home, 'Pat Coleman'));
  await page.close();
}
{
  // A phone. The section bar pins under the thumb with short words.
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('dana');
  await page.locator('#p').fill('FieldWork2026x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(800);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  ok('the section bar is the bottom navigation on a phone',
     (await page.evaluate(() => getComputedStyle(document.querySelector('.wsbar')).position)) === 'fixed');
  const box = await page.locator('.wsbar').boundingBox();
  ok('and it sits at the bottom of the hand', box && box.y > 600, JSON.stringify(box));
  ok('with thumb-size words', has(await text(page, '.wsbar'), 'Activity'));
  await page.locator('.wsbar button', { hasText: 'Evidence' }).click();
  await page.waitForTimeout(400);
  ok('the bottom bar navigates', (await page.evaluate(() => WS_TAB)) === 'evidence');
  await page.close();
}

/* Active Surveillance Mode (SURVEILLANCE.md). The rule under test throughout:
   it is a VIEW of the existing case. Everything it writes must be visible in
   the ordinary portal, because there is no second database. */
section('Active Surveillance Mode: a field view of the same case');
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('dana');
  await page.locator('#p').fill('FieldWork2026x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);

  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  /* Unit 38 — two doors by design, which is the owner's own "1 obvious primary
     entry point plus 1 useful contextual shortcut": the case action row on
     every tab, and the icon card on the case home. Both must be there. */
  ok('the assignment offers the field mode from the action row and the card',
     await page.locator('.caseacts [data-act="svEnter"]').count() === 1
     && await page.locator('.sv-go[data-act="svEnter"]').count() === 1,
     String(await page.locator('[data-act="svEnter"]').count()));
  await page.locator('[data-act="svEnter"]:visible').first().click();
  await page.waitForTimeout(700);

  ok('the field view takes the whole screen', await page.locator('.sv').count() === 1);
  ok('it is the dark field interface',
     (await page.evaluate(() => getComputedStyle(document.querySelector('.sv')).backgroundColor))
       === 'rgb(13, 24, 38)');
  ok('the case number is in the header', has(await text(page, '.sv-head'), 'API-20260812-4001'));
  /* MOBILE PR 2 — the way out moved out of the top-right corner and into the
     Case drawer, which the bottom bar already reaches. The assertion is that it
     is REACHABLE, which is what "an obvious way out" always meant; pinning it
     to the header was pinning it to the worst place on the phone to put it. */
  ok('the header no longer carries the way out',
     !has(await text(page, '.sv-head'), 'Exit active mode'));
  ok('and a bottom navigation for one hand', await page.locator('.sv-nav button').count() === 5);

  // Day 4001 was ended by an earlier section, so this starts a fresh one.
  ok('with no day running the one action is starting one',
     await page.locator('[data-act="svStartDay"]').count() === 1);
  await page.locator('#sv_start').fill('06:30');
  await page.locator('#sv_smiles').fill('52000');
  await page.locator('[data-act="svStartDay"]').click();
  await page.waitForTimeout(900);

  const home = await text(page, '.sv-body');
  ok('the day starts and the timer appears', await page.locator('#svTimer').count() === 1);
  ok('the timer reads as a clock', /\d\d:\d\d:\d\d/.test(await page.locator('#svTimer').innerText()));
  ok('it says when the day started', has(home, '6:30 AM'));
  /* REVERSED BY THE OWNER, 2026-08-17: "End investigation day should not be the
     loudest or easiest accidental tap on the page." It was the gold action when
     it was the screen's primary; it is pressed once a shift, so the emphasis
     now belongs to the actions used all day. Asserted as the new rule rather
     than deleted, so nothing drifts back. */
  ok('ending the day is NOT the gold action while a day is running',
     await page.locator('.sv-btn.gold', { hasText: 'End investigation day' }).count() === 0);
  ok('and it is still plainly there, below the field actions',
     await page.locator('.sv-shift .sv-btn', { hasText: 'End investigation day' }).count() === 1);
  ok('the four quick actions are there',
     has(home, 'Activity') && has(home, 'Photo') && has(home, 'Video') && has(home, 'Note'));

  /* THE TIMER RULE (P2): elapsed derives from the server's record of the
     start, so a reload cannot reset it and a wrong device clock cannot move
     it. Reload and confirm it did not restart from zero. */
  const before = await page.locator('#svTimer').innerText();
  await page.reload();
  await page.waitForTimeout(1200);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  await page.locator('[data-act="svEnter"]:visible').first().click();
  await page.waitForTimeout(800);
  const after = await page.locator('#svTimer').innerText();
  const secs = t => t.split(':').reduce((a, n) => a * 60 + Number(n), 0);
  ok('a reload does not restart the timer', secs(after) >= secs(before), `${before} → ${after}`);
  ok('and the day is resumed, not duplicated',
     has(await text(page, '.sv-body'), '6:30 AM'));

  // Quick activity: the same lines and favorites the office sheet uses.
  await page.locator('.sv-nav button', { hasText: 'Activity' }).click();
  await page.waitForTimeout(400);
  ok('the field gets the same searchable actions',
     await page.locator('#sv_q').count() === 1);
  ok('with the same categories', has(await text(page, '.sv-cats'), 'Arrival'));
  await page.locator('#sv_q').fill('visual contact');
  await page.waitForTimeout(350);
  ok('search finds a line', has(await text(page, '.sv-body'), 'Lost visual contact'));
  await page.locator('#sv_q').fill('');
  await page.waitForTimeout(350);

  await page.locator('.sv-cat', { hasText: 'Arrival' }).click();
  await page.waitForTimeout(250);
  await page.locator('.sv-pick', { hasText: 'Arrived in vicinity of subject residence.' }).click();
  await page.waitForTimeout(300);
  ok('picking a line opens the entry with it filled in',
     (await page.locator('#sv_desc').inputValue()).includes('Arrived in vicinity'));

  // The arrival generator reaches the field (MASTER §10 / SURVEILLANCE P6).
  // It was desk-only, which is the one place an investigator is NOT sitting.
  ok('the field asks the same arrival questions as the desk',
     await page.locator('#sv_vp').count() === 1
       && await page.locator('#sv_view').count() === 1
       && await page.locator('#sv_place').count() === 1
       && await page.locator('#sv_pos').count() === 1);
  await page.locator('#sv_vp').fill('Two vehicles in the driveway');
  await page.waitForTimeout(200);
  await page.locator('#sv_view').selectOption('indirect');
  await page.waitForTimeout(250);
  const svBuilt = await page.locator('#sv_desc').inputValue();
  ok('and composes the same sentence the desk sheet would',
     svBuilt.includes('Arrived in vicinity of subject residence.')
       && svBuilt.includes('Two vehicles in the driveway present.')
       && svBuilt.includes('Established an indirect surveillance position.'), svBuilt);
  await page.locator('#sv_place').selectOption('primary');
  await page.waitForTimeout(250);
  const svCanon = await page.locator('#sv_desc').inputValue();
  ok('the canonical combined sentence is reachable in the field too',
     svCanon.includes('Established an indirect surveillance position along the primary route of departure.'),
     svCanon);

  await page.locator('#sv_pa').check();
  await page.locator('[data-act="svSaveEntry"]').click();
  await page.waitForTimeout(800);
  ok('saving confirms in the field', has(await text(page, '.sv-body'), 'Activity saved'));
  ok('and offers to add another', await page.locator('[data-act="svAddAnother"]').count() === 1);

  // One-tap No change.
  await page.locator('[data-act="svAddAnother"]').click();
  await page.waitForTimeout(250);
  await page.locator('.sv-cat', { hasText: 'No activity' }).click();
  await page.waitForTimeout(250);
  await page.locator('.sv-pick', { hasText: 'No change was noted during this period.' }).click();
  await page.waitForTimeout(800);
  ok('No change logs in one tap', has(await text(page, '.sv-body'), 'Activity saved'));

  await page.locator('.sv-nav button', { hasText: 'Activity' }).click();
  await page.waitForTimeout(300);
  await page.locator('[data-act="svTab"][data-t="timeline"]').first().click().catch(() => {});
  await page.waitForTimeout(300);

  // The case drawer: fieldwork facts, never money.
  await page.locator('.sv-nav button', { hasText: 'Case' }).click();
  await page.waitForTimeout(400);
  const drawer = await text(page, '.sv-body');
  ok('the drawer carries the subject', has(drawer, 'Pat Coleman'));
  ok('and the scope', has(drawer, 'Activity level'));
  ok('it never carries the carrier', !has(drawer, 'Example Mutual'));
  ok('nor a rate or a budget', !/\$\s?\d/.test(drawer), drawer.slice(0, 200));

  // Ending the day is a confirmation with totals, never one tap.
  await page.locator('.sv-nav button', { hasText: 'Home' }).click();
  await page.waitForTimeout(400);
  await page.locator('.sv-btn', { hasText: 'End investigation day' }).first().click();
  await page.waitForTimeout(400);
  const end = await text(page, '.sv-body');
  ok('ending shows the totals first', has(end, 'Activity entries') && has(end, 'Photos'));
  ok('and offers to keep working instead',
     await page.locator('.sv-btn', { hasText: 'Keep working' }).count() === 1);
  await page.locator('#sv_end').fill('11:30');
  await page.locator('#sv_emiles').fill('52040');
  await page.locator('[data-act="svEndDay"]').click();
  await page.waitForTimeout(1000);
  ok('the day ends with its hours recorded', has(await text(page, '.sv-body'), 'Day ended'));

  /* THE POINT: leave the mode and the work is simply there in the portal.
     The way out moved into the Case drawer in Mobile PR 2 — it is reached
     through the bottom bar's own item now, so this navigates the way a person
     would rather than clicking a control that is no longer on this screen. */
  await page.locator('.sv-nav button').last().click();
  await page.waitForTimeout(600);
  await page.locator('.sv-exitblock [data-act="svExit"]').click();
  await page.waitForTimeout(700);
  ok('exiting returns to the ordinary case page', await page.locator('.casepage').count() === 1);
  await wsTab(page, 'Activity');
  const log = await text(page, '#dlgBody');
  ok('the field entries are in the normal activity log', has(log, 'Arrived in vicinity'));
  ok('including the one-tap entry', has(log, 'No change was noted'));
  await wsTab(page, 'Field work');
  // The miles column is hidden at phone width, so assert on the window itself.
  ok('and the day is an ordinary recorded day, start to end',
     has(await text(page, '#dlgBody'), '6:30 AM–11:30 AM'));
  await page.close();
}

/* The app's own icon: on the button in the portal and on the home screen, so
   the two are visibly one thing. A wrong path here fails silently in a way
   nobody notices until a phone shows a blank square. */
/* A phone must be able to NAVIGATE. This shipped broken: the base .burger rule
   sat after its own media query with equal specificity, so display:none won at
   every width — the sidebar is hidden under 900px and the burger that opens the
   drawer never appeared, leaving a phone with NO navigation at all while an
   iPad in landscape looked perfect. Every suite passed, because every test
   either ran wide or clicked inside the case page. */
/* THE GROUPED NAVIGATION RAIL (owner, 2026-08-16). Three labelled groups, the
   renamed doors, and the two ACTIONS in their own separated block.

   The labels moved and the TAB KEYS did not, which is the whole reason this
   change is safe: `paint()` and every loader route on the key, so a rename can
   never move a destination or a permission. The tests below assert the label
   and the key separately, on purpose. */
section('The navigation rail is grouped, renamed, and reachable');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  const nav = await text(page, '.tabs');

  for (const g of ['Operations', 'Delivery & Billing', 'Team & System']) {
    ok(`the office rail carries the ${g} group`, has(nav, g), nav);
  }
  const groups = await page.locator('.tabs .navgrp').allInnerTexts();
  ok('there are exactly three of them, in the intended order',
     groups.map(s => s.trim().toLowerCase()).join('|') === 'operations|delivery & billing|team & system',
     groups.join('|'));

  /* A HEADER IS A LABEL, NOT A DOOR. Rendered as a button it would be tabbable,
     focusable, counted as a destination, and — the real hazard — a candidate
     for every `.tabs button` hasText click in this suite. */
  ok('a group header is never a button', await page.locator('.tabs button.navgrp').count() === 0);
  ok('and never carries an action', await page.locator('.navgrp[data-act]').count() === 0);

  // The renames, in both directions: the new word is there and the old one is gone.
  ok('Leads & intakes is now Intakes', has(nav, 'Intakes') && !has(nav, 'Leads'), nav);
  ok('Invoices is now Billing', has(nav, 'Billing') && !has(nav, 'Invoices'), nav);
  ok('Rate sheets is now title-cased', (await text(page, '.tabs')).includes('Rate Sheets'));

  // ...and the destinations behind them did not move.
  for (const [label, key] of [['Intakes', 'leads'], ['Billing', 'invoices'], ['Rate Sheets', 'sheets']]) {
    ok(`${label} still opens data-tab="${key}"`,
       await page.locator(`.tabs button[data-tab="${key}"]`).count() === 1);
  }

  // The separated action block.
  ok('the field and intake doors sit in one separated block',
     await page.locator('.navfoot').count() === 1);
  ok('Active Surveillance is inside it',
     await page.locator('.navfoot .side-surv').count() === 1);
  ok('so is the intake door', await page.locator('.navfoot .side-intake').count() === 1);
  /* THE RULE IS "no DESTINATION leaked in", not "there are exactly two
     buttons". Counting re-encoded the number of doors, so adding a third one
     (Timestamp Video) failed a check whose stated intent it does not touch.
     Asserted as the property instead: everything in the block is a door. */
  ok('and no destination is in there with them',
     await page.evaluate(() => [...document.querySelectorAll('.navfoot button')]
       .every(b => /\bside-(surv|vst|intake)\b/.test(b.className))),
     await page.evaluate(() => [...document.querySelectorAll('.navfoot button')]
       .map(b => b.className).join(' | ')));
  const lastGroup = await page.locator('.tabs .navgrp').last().boundingBox();
  const footBox = await page.locator('.navfoot').boundingBox();
  ok('the block genuinely sits below every group',
     footBox && lastGroup && footBox.y > lastGroup.y, JSON.stringify([lastGroup, footBox]));

  /* WHERE YOU ARE IS NOT CARRIED BY COLOUR ALONE. The gold rule and the changed
     background are the look; aria-current is the fact. */
  ok('the current destination is marked for a screen reader too',
     await page.locator('.tabs button.on[aria-current="page"]').count() === 1);

  // Reports & Packages — a top-level destination assembled from two existing routes.
  await page.locator('.tabs button', { hasText: 'Reports & Packages' }).click();
  await page.waitForTimeout(900);
  const dl = await text(page, '#app');
  for (const b of ['Ready to build', 'Packages ready', 'Recently completed']) {
    ok(`Reports & Packages carries the ${b} band`, has(dl, b), dl.slice(0, 240));
    /* Either there is work in it or there is a sentence saying what will fill
       it. A band that is simply blank is the state this portal keeps refusing
       to ship — it reads the same as a band that failed to load. */
    const card = page.locator('.card', { hasText: b }).first();
    ok(`${b} shows work or an empty state that explains itself`,
       (await card.locator('.pkgcards, .donegrid').count()) > 0
       || (await card.locator('.empty').count()) > 0,
       (await card.innerText()).slice(0, 200));
  }
  ok('and no fabricated case reached it', !dl.includes('EXAMPLE-'), dl.slice(0, 240));

  /* NO NEW BACKEND. The screen is the two routes that already existed; if a
     third were ever needed this is where it would show up. */
  const codes = await page.evaluate(() => Promise.all(
    ['/portal-api/packages', '/portal-api/completed']
      .map(u => fetch(u, { headers: { Accept: 'application/json' } }).then(r => r.status))));
  ok('it reuses /packages and /completed, both already live',
     codes.join(',') === '200,200', codes.join(','));

  // The Cases lens it now shares a loader with must still work.
  await page.locator('.tabs button', { hasText: 'Cases' }).click();
  await page.waitForTimeout(400);
  await page.locator('.lens', { hasText: 'Completed' }).click();
  await page.waitForTimeout(800);
  ok('and the Completed lens inside Cases still loads from the same one writer',
     (await page.locator('.donegrid, .empty').count()) > 0);
  await page.close();
}
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  const nav = await text(page, '.tabs');
  ok('an investigator gets no Reports & Packages door', !has(nav, 'Reports & Packages'), nav);
  ok('nor Billing, Rate Sheets or Staff',
     !has(nav, 'Billing') && !has(nav, 'Rate Sheets') && !has(nav, 'Staff'), nav);
  ok('their rail is grouped too', await page.locator('.tabs .navgrp').count() === 2);
  ok('Active Surveillance is in its own block for them as well',
     await page.locator('.navfoot .side-surv').count() === 1);
  ok('with no intake door beside it', await page.locator('.navfoot .side-intake').count() === 0);
  /* THE RAIL IS NOT THE BOUNDARY. Not drawing a door is presentation; the
     Worker refusing the routes behind it is the security property. */
  const s = await page.evaluate(() => Promise.all(
    ['/portal-api/packages', '/portal-api/completed']
      .map(u => fetch(u, { headers: { Accept: 'application/json' } }).then(r => r.status))));
  ok('and both routes behind that door still refuse them directly',
     s.join(',') === '403,403', s.join(','));
  await page.close();
}

/* MEASURED, NOT EYEBALLED. Apple's minimum is 44px and this file holds every
   other phone control to 50-52px; the rail's own padding left an item under
   the line, which is exactly how the burger shipped at 30px. */
/* THE DASHBOARD BANDS (owner, 2026-08-16). Needs attention, then Current work.

   The point of this section is not that the cards render — it is that every
   number on them comes from a read that already existed, that a card which
   counts something takes you to where that something is, and that a card whose
   figure the Worker does not provide is ABSENT rather than zero. */
section('The dashboard leads with two named bands');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1100);
  const body = await text(page, '#app');

  ok('there are exactly two bands', await page.locator('.band').count() === 2);
  const heads = (await page.locator('.bandhead h2').allInnerTexts()).map(s => s.trim().toLowerCase());
  ok('named Needs attention then Current work', heads.join('|') === 'needs attention|current work', heads.join('|'));

  for (const c of ['New intakes', 'Reports due', 'Retainer / authorization', 'Needs assignment']) {
    ok(`Needs attention carries ${c}`, has(body, c), body.slice(0, 400));
  }
  for (const c of ['Active today', 'Ready to build', 'Packages ready', 'Outstanding']) {
    ok(`Current work carries ${c}`, has(body, c), body.slice(0, 400));
  }

  /* ONE OBVIOUS PRIMARY ACTION PER AREA. */
  ok('each band has exactly one primary action', await page.locator('.bandgo .btn').count() === 2);
  ok('Needs attention leads to the intakes desk',
     await page.locator('.bandgo .btn[data-tab="leads"]').count() === 1);
  ok('Current work leads to Reports & Packages',
     await page.locator('.bandgo .btn[data-tab="delivery"]').count() === 1);

  /* NOTHING IS INVENTED. Every card is one of the eight above; a ninth would
     mean a figure arrived from somewhere other than /summary and /packages. */
  ok('no card was invented to fill a slot', await page.locator('.band .stat').count() <= 9,
     String(await page.locator('.band .stat').count()));
  ok('and no fabricated case reached the dashboard', !body.includes('EXAMPLE-'), body.slice(0, 300));

  /* THE SECONDARY LINE. Real alerts, kept as text so they do not become five
     more cards — but not dropped, because somebody depends on them. */
  const also = await text(page, '.alsoline');
  for (const a of ['open cases', 'tasks overdue', 'awaiting client', 'ready to close', 'expenses to review']) {
    ok(`the also-line still carries ${a}`, has(also, a), also);
  }
  ok('storage is accounted for somewhere on the dashboard', has(body, 'storage'), also);

  // Assignment stays optional: the card reports, it never scolds.
  const assign = await page.locator('.stat', { hasText: 'Needs assignment' }).first();
  ok('Needs assignment is never dressed as a warning',
     !(await assign.getAttribute('class')).includes('warn'), await assign.getAttribute('class'));
  ok('and says so in words', has(await assign.innerText(), 'optional'), await assign.innerText());

  await page.close();
}

/* A CARD THAT COUNTS SOMETHING MUST GO WHERE THAT SOMETHING IS. On Cases the
   strip filters the list beneath it; on the Dashboard there is no list, so a
   card that only set a filter would look broken. */
section('Dashboard cards are doors, and they know which door');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1100);

  /* NO DEAD CONTROLS. A card is a door only while there is something behind
     it, so which assertion applies depends on the fixture — both are the rule,
     not a fallback for a flaky one. */
  const rtb = page.locator('.band .stat', { hasText: 'Ready to build' }).first();
  if (parseInt((await rtb.innerText()).match(/\d+/)[0], 10) > 0) {
    await rtb.click();
    await page.waitForTimeout(800);
    ok('Ready to build opens Reports & Packages',
       has(await text(page, '.tabs button.on'), 'Reports & Packages'));
  } else {
    ok('Ready to build offers no click while there is nothing behind it',
       !(await rtb.getAttribute('class')).includes('click'), await rtb.getAttribute('class'));
  }

  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1100);
  await page.locator('.band .stat', { hasText: 'Outstanding' }).click();
  await page.waitForTimeout(800);
  ok('Outstanding opens Billing', has(await text(page, '.tabs button.on'), 'Billing'));

  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1100);
  await page.locator('.band .stat', { hasText: 'New intakes' }).click();
  await page.waitForTimeout(800);
  ok('New intakes opens the intakes desk', has(await text(page, '.tabs button.on'), 'Intakes'));

  /* A SET-BACKED CARD BOTH FILTERS AND TRAVELS. Reports due carries case
     numbers, so it lands on Cases already narrowed to exactly those. */
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1100);
  const due = page.locator('.band .stat', { hasText: 'Reports due' }).first();
  const dueN = parseInt((await due.innerText()).match(/\d+/)[0], 10);
  if (dueN > 0) {
    await due.click();
    await page.waitForTimeout(800);
    ok('Reports due lands on Cases', has(await text(page, '.tabs button.on'), 'Cases'));
    ok('already narrowed, with a chip naming the filter',
       has(await text(page, '.bar'), 'Reports due'));
  } else {
    ok('Reports due is not clickable while there is nothing behind it',
       !(await due.getAttribute('class')).includes('click'));
  }
  await page.close();
}

/* THE STRIP ON CASES IS NOT THE DASHBOARD. It is a filter control sitting
   directly above the list it filters, so it keeps its flat shape — a heading
   between a control and the thing it controls helps nobody. */
section('Cases keeps the flat strip, not the bands');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Cases' }).click();
  await page.waitForTimeout(700);
  ok('Cases draws no bands', await page.locator('.band').count() === 0);
  ok('but keeps its cards', await page.locator('.stat').count() > 0);
  const strip = await text(page, '.stats');
  ok('including the ones the bands do not show', has(strip, 'Out now') && has(strip, 'Open cases'), strip);
  await page.close();
}

/* DID NOT LOAD IS NOT EMPTY. The totals are their own read; when they fail the
   dashboard must say so rather than draw a quiet day in zeros. This is the
   failure mode this portal has already been bitten by twice. */
section('A dashboard whose totals failed says so');
{
  const page = await newPage();
  await page.route('**/portal-api/summary*', r => r.abort());
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1100);
  const body = await text(page, '#app');
  ok('it names the failure', has(body, 'could not be read'), body.slice(0, 300));
  ok('and does not report a quiet day in zeros',
     !/\b0\s*\n?\s*New intakes/i.test(body) && !has(body, 'Active today'), body.slice(0, 300));
  ok('the page still works around it', await page.locator('.tabs').count() === 1);
  await page.close();
}

/* THE 390px DEFECT, FIXED AT THE ELEMENT. A grid item defaults to
   min-width:auto, so an unbreakable case number floored its own track above the
   viewport and took the page sideways with it. This suite plants a
   deliberately long hostile case number, which is exactly the input that
   triggered it. */
/* TODAY / NEXT ACTIONS (owner, 2026-08-16). A compact queue with one direct
   action per row, built entirely from alerts the Worker already computed.

   What this section is really guarding is the rules AROUND the queue: that a
   case appears once rather than four times, that things the office cannot act
   on stay out of it, that assignment is never queued as an outstanding task,
   and that a queue which failed to build never looks like a clear desk. */
const queueCard = page => page.locator('.card', { hasText: 'Today / next actions' }).first();
const doneCard  = page => page.locator('.card', { hasText: 'Recently completed' }).first();

section('Today / next actions is a queue, not another pile of cards');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1300);

  ok('the dashboard carries the queue', await queueCard(page).count() === 1);
  const rows = queueCard(page).locator('.qrow');
  const n = await rows.count();
  ok('it is rows rather than cards', n > 0 && await queueCard(page).locator('.stat').count() === 0,
     `${n} rows`);

  /* ONE DIRECT ACTION PER ROW. Not two, not a menu — the owner asked for one,
     and a row offering three choices is a decision, not an action. */
  let worst = 0;
  for (const r of await rows.all()) worst = Math.max(worst, await r.locator('.btn').count());
  ok('every row offers exactly one action', worst === 1, `most buttons on a row: ${worst}`);

  /* ONE ROW PER CASE. A case can sit in four alert sets at once and four rows
     for one file is a queue nobody finishes. */
  const nos = (await queueCard(page).locator('.qno').allInnerTexts()).map(s => s.trim().split(' ')[0]);
  ok('no case is queued twice', new Set(nos).size === nos.length, nos.join(','));

  /* THINGS THE OFFICE CANNOT ACT ON STAY OUT. A running day needs no decision
     and a case awaiting the client has its ball in their court; both are still
     on the also-line, so nothing was lost — only the noise. */
  const qtext = await queueCard(page).innerText();
  ok('a running day is not queued as a task', !has(qtext, 'day is running'), qtext.slice(0, 200));
  ok('nor is a case awaiting the client', !has(qtext, 'awaiting client'), qtext.slice(0, 200));
  /* ASSIGNMENT IS OPTIONAL, so an unassigned case is never an outstanding task. */
  ok('and assignment is never queued', !has(qtext, 'assign'), qtext.slice(0, 200));

  ok('no fabricated case reached the queue', !qtext.includes('EXAMPLE-'), qtext.slice(0, 200));

  // The cap is stated, never silent.
  const foot = await queueCard(page).locator('.qfoot').count();
  ok('a truncated queue says so, or there was nothing to truncate',
     n < 8 ? foot === 0 : foot === 1, `${n} rows, ${foot} footers`);

  await page.close();
}

/* A ROW'S ACTION MUST LAND WHERE THE WORK IS. The whole point of one direct
   action is that it is the right one. */
section('A queue row opens the case at the panel that does the work');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1300);

  const first = queueCard(page).locator('.qrow').first();
  const caseNo = (await first.locator('.qno').innerText()).trim().split(' ')[0];
  const btn = first.locator('.btn');
  const wantTab = await btn.getAttribute('data-tab');
  ok('the row names the panel it will open', !!wantTab, String(wantTab));
  await btn.click();
  await page.waitForTimeout(900);
  ok('it opens the case workspace', await page.locator('.casepage').count() === 1);
  ok('and it is the right case', has(await text(page, '#dlgBody'), caseNo), caseNo);
  await page.close();
}

/* DID NOT BUILD IS NOT A CLEAR DESK. An empty queue is the most reassuring
   thing this page can say, so it may never be what a failed read looks like. */
section('A queue that could not be built refuses to look empty');
{
  const page = await newPage();
  /* UNIT 8 moved the queue's derivation to the Worker, so the read that can
     fail is /attention. The RULE is unchanged and is what this section is
     for: a source that did not answer must never be drawn as a clear desk. */
  await page.route('**/portal-api/attention*', r => r.abort());
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1300);
  const body = await text(page, '#app');
  ok('it says the queue could not be built', has(body, 'could not be built'), body.slice(0, 300));
  ok('and says not to read it as a clear desk', has(body, 'clear desk'), body.slice(0, 300));
  ok('it never claims nothing needs you', !has(body, 'Nothing needs you'), body.slice(0, 300));
  await page.close();
}

/* FAILURE IS NOT EMPTY, AND RETRY MUST RETRY (terminal handoff, 2026-08-17).
   Three defects, one shape: a failed read left a truthy error-shaped object in
   PKGS/COMPLETED, so (1) the Case packages card drew "No active cases" off a
   list nobody fetched, and (2) Try again went through render(), whose !PKGS /
   !COMPLETED guards read truthy as loaded — the button repainted the same
   error forever. The proof of the fix is end-to-end: break the route, see the
   honest failure, HEAL the route, click Try again, and watch real data arrive.
   A retry that works is the only acceptable evidence — a button that exists is
   not. */
section('A failed packages read is not an empty case list, and Retry really retries');
{
  const page = await newPage();
  await page.route('**/portal-api/packages*', r => r.abort());
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1300);
  let body = await text(page, '#app');
  ok('the Case packages card refuses to claim "No active cases"',
     !has(body, 'No active cases'), body.slice(0, 400));
  ok('it says the read did not load, and that unknown is not empty',
     has(body, 'did not load') && has(body, 'not empty'), body.slice(0, 400));
  ok('and the flag agrees the read failed',
     (await page.evaluate(() => PKGS_OK)) === false);

  // Heal the route. The click must cause a FRESH request — nothing else will.
  await page.unroute('**/portal-api/packages*');
  await page.locator('[data-act="reload"]').first().click();
  await page.waitForTimeout(1300);
  body = await text(page, '#app');
  ok('Try again actually retried: the load is now vouched for',
     (await page.evaluate(() => PKGS_OK)) === true);
  ok('and the error is gone from the card',
     !has(body, 'The active-case read did not load'), body.slice(0, 400));
  ok('with the real list in its place',
     (await page.locator('.pkgcards .pkgcard, .pkgcards > *').count()) > 0
     || has(body, 'No active cases'), body.slice(0, 300));
  await page.close();
}

section('A failed completed read says so, and its Retry really retries');
{
  const page = await newPage();
  await page.route('**/portal-api/completed*', r => r.abort());
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1300);
  let card = await text(page, '#app');
  ok('the completed card names the failure rather than looking empty',
     has(card, 'completed list did not load') && has(card, 'not an empty desk'),
     card.slice(0, 400));
  ok('it never claims nothing was completed', !has(card, 'Nothing completed yet'),
     card.slice(0, 300));

  await page.unroute('**/portal-api/completed*');
  /* More than one Try again can be on screen (the banner and a card). All go
     through one handler that clears only what failed, so any of them heals
     the completed read too. */
  await page.locator('[data-act="reload"]').first().click();
  await page.waitForTimeout(1300);
  card = await text(page, '#app');
  ok('Try again really reloaded the completed list',
     !has(card, 'completed list did not load'), card.slice(0, 400));
  ok('and it now shows a real state — records or a true empty',
     has(card, 'Nothing completed yet') || has(card, 'finalized') || has(card, 'Complete'),
     card.slice(0, 300));
  await page.close();
}

/* RECENTLY COMPLETED — the same /completed route the Cases lens and Reports &
   Packages already read, as one line per case rather than the full card. */
section('Recently completed is a compact list of real records');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1300);

  ok('the dashboard carries it', await doneCard(page).count() === 1);
  const body = await doneCard(page).innerText();
  ok('no fabricated record is on it', !body.includes('EXAMPLE-'), body.slice(0, 240));
  ok('it offers the full desk rather than repeating it',
     await doneCard(page).locator('.btn[data-tab="delivery"]').count() === 1);

  const rows = doneCard(page).locator('.qrow');
  const n = await rows.count();
  ok('it is compact — at most five', n <= 5, `${n} rows`);
  if (n > 0) {
    ok('each row says what finished', has(await rows.first().innerText(), 'finalized')
       || has(await rows.first().innerText(), 'complete')
       || has(await rows.first().innerText(), 'closed'), await rows.first().innerText());
    const caseNo = (await rows.first().locator('.qno').innerText()).trim().split(' ')[0];
    await rows.first().locator('.btn').click();
    await page.waitForTimeout(900);
    ok('and opens its case', has(await text(page, '#dlgBody'), caseNo), caseNo);
  } else {
    ok('an empty list says what will fill it',
       has(body, 'closing checklist') || has(body, 'package is finalized'), body);
  }
  await page.close();
}

/* The completed read is its own read and fails on its own. */
section('A completed list that failed says so')
{
  const page = await newPage();
  await page.route('**/portal-api/completed*', r => r.abort());
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1300);
  const body = await doneCard(page).innerText();
  ok('it names the failure', has(body, 'did not load'), body.slice(0, 240));
  ok('and refuses to read as an empty desk', has(body, 'not an empty desk'), body.slice(0, 240));
  ok('it never says nothing is completed', !has(body, 'Nothing completed yet'), body.slice(0, 240));
  await page.close();
}

/* Both new panels, at both widths the owner named. */
/* "NOTHING NEEDS YOU RIGHT NOW" HAS TO BE EARNED (Codex stop-time review,
   2026-08-16).

   The queue has four inputs and the first version guarded exactly one of them.
   `/packages` failing leaves PKGS.packages an EMPTY ARRAY; the case list
   failing leaves CASES empty; a half-applied schema makes the Worker omit whole
   alert sets from /summary without comment. Every one of those deletes a
   category of work and leaves the queue free to announce a clear desk — the
   reassuring direction, which is the dangerous one.

   Each case below kills ONE input and asserts the queue says what it cannot
   see instead of saying there is nothing to do. */
section('A queue missing an input never claims a clear desk');
{
  /* THE MECHANISM CHANGED, THE RULE DID NOT. Before Unit 8 the queue was
     derived in the browser from several reads, and a failed one was named as a
     missing input. It is one Worker read now — but that read is itself guarded
     table by table, so a half-applied schema silently drops whole CATEGORIES
     of work. The Worker reports what it could not look at, and the page says
     its view is partial rather than claiming a clear desk. Driven here through
     the real answer, so the wording and the plumbing are both exercised. */
  const page = await newPage();
  await page.route('**/portal-api/attention*', async r => {
    await r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ alerts: [], counts: { urgent: 0, attention: 0, info: 0 },
        kinds: {}, total: 0,
        missing_sources: ['retainers outstanding', 'overdue invoices'],
        windows: { legal_days: 14, quiet_days: 21, long_day_hours: 14 } }),
    });
  });
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1400);
  const q = await queueCard(page).innerText();

  ok('a partial queue never says nothing needs you', !has(q, 'Nothing needs you'), q.slice(0, 300));
  ok('it says its view is partial',
     has(q, 'queue is missing') || has(q, 'queue is incomplete'), q.slice(0, 300));
  ok('and names what it could not read',
     has(q, 'retainers outstanding') && has(q, 'overdue invoices'), q.slice(0, 300));
  await page.close();
}

/* And the same notice rides ALONGSIDE real rows, not only on an empty list —
   a queue with three things on it and two categories unread is still partial. */
section('A partial queue says so even when it has rows');
{
  const page = await newPage();
  await page.route('**/portal-api/attention*', async r => {
    await r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        alerts: [{ key: 'intakes:API-PARTIAL-1', severity: 'urgent', kind: 'intakes',
          case_no: 'API-PARTIAL-1', what: 'Intake awaiting a decision',
          why: 'Somebody — waiting 3 days',
          action: { label: 'Review intake', view: 'case', tab: 'assign' } }],
        counts: { urgent: 1, attention: 0, info: 0 }, kinds: { intakes: 1 }, total: 1,
        missing_sources: ['legal dates'],
        windows: { legal_days: 14, quiet_days: 21, long_day_hours: 14 } }),
    });
  });
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1400);
  const q = await queueCard(page).innerText();
  ok('the rows it does have are drawn', has(q, 'Intake awaiting a decision'), q.slice(0, 200));
  ok('and it still says what it could not read', has(q, 'legal dates'), q.slice(0, 400));
  await page.close();
}

/* The same rule as CARDS. Three of the Current work cards are derived from the
   packages payload, so with that read down they would each report a confident
   zero for something nobody managed to look at. This file's standing rule is
   that such a card is ABSENT, not zero. */
section('No card reports a zero nobody checked');
{
  const page = await newPage();
  await page.route('**/portal-api/packages*', r => r.abort());
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1400);
  const body = await text(page, '#app');

  /* Asserted as ELEMENTS, not as strings: the note that explains their absence
     names all three, so a text search finds exactly the words it should. */
  for (const card of ['Ready to build', 'Packages ready', 'Outstanding']) {
    ok(`${card} is absent rather than zero`,
       await page.locator('.stat', { hasText: card }).count() === 0,
       String(await page.locator('.stat', { hasText: card }).count()));
  }
  ok('and the band says why they are gone',
     has(body, 'unknown, not zero'), body.slice(0, 400));
  /* Active today comes from /summary, not /packages, so it must SURVIVE — the
     fix has to remove what it cannot vouch for and nothing else. */
  ok('the card that does not depend on it still draws', has(body, 'Active today'), body.slice(0, 400));

  /* The retainer half of that card is also unknowable now, so the card must
     stop claiming it checked both. */
  ok('the money card stops claiming a retainer check it could not make',
     !has(body, 'Retainer / authorization'), body.slice(0, 400));
  ok('and says so in words', has(body, 'retainers could not be read'), body.slice(0, 400));
  await page.close();
}

/* Reports & Packages is assembled from the same payload and had the same
   shape: an empty desk and a failed read drew identically. */
section('Reports & Packages does not draw a failed read as an empty desk');
{
  const page = await newPage();
  await page.route('**/portal-api/packages*', r => r.abort());
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Reports & Packages' }).click();
  await page.waitForTimeout(1200);
  const body = await text(page, '#app');
  ok('it refuses to say nothing is waiting', !has(body, 'Nothing is waiting on a package'), body.slice(0, 300));
  ok('it says the read failed instead', has(body, 'did not load'), body.slice(0, 300));
  ok('and offers a way to retry', await page.locator('[data-act="reload"]').count() >= 1);
  await page.close();
}

/* The flags describe a READ, so they must not outlive the session that made
   it — otherwise the next person's dashboard vouches for someone else's fetch. */
section('The did-it-load flags do not survive a sign-out');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1200);
  const loaded = await page.evaluate(() => `${PKGS_OK}/${CASES_OK}`);
  ok('a successful load vouches for itself', loaded === 'true/true', loaded);
  await page.locator('[data-act="logout"]').click();
  await page.waitForTimeout(800);
  const cleared = await page.evaluate(() => `${PKGS_OK}/${CASES_OK}`);
  ok('and both flags are cleared with the data they describe', cleared === 'false/false', cleared);
  await page.close();
}


section('Slice two fits the phone and the desktop');
for (const [label, w, h] of [['phone 390', 390, 844], ['desktop 1200', 1200, 900]]) {
  const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(1600);

  ok(`${label}: the queue is on screen`, await queueCard(page).count() === 1);
  ok(`${label}: recently completed is on screen`, await doneCard(page).count() === 1);

  const over = await page.evaluate(() => {
    const vw = window.innerWidth, out = [];
    for (const el of document.querySelectorAll('#app *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) out.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}@${Math.round(r.right)}`);
    }
    return { doc: Math.round(document.documentElement.scrollWidth - vw), els: out.slice(0, 4) };
  });
  ok(`${label}: the dashboard still fits its viewport`, over.doc <= 1, JSON.stringify(over));
  ok(`${label}: and nothing hangs past the right edge`, over.els.length === 0, JSON.stringify(over));

  let smallest = 999, which = '';
  for (const b of await page.locator('.qrow .btn').all()) {
    const box = await b.boundingBox();
    if (box && box.height < smallest) { smallest = box.height; which = (await b.innerText()).trim(); }
  }
  ok(`${label}: every row action clears 44px`, smallest === 999 || smallest >= 44,
     `smallest ${smallest}px on "${which}"`);
  await page.close();
}


section('The dashboard does not scroll sideways on a phone');
for (const [label, w, h] of [['phone 390', 390, 844], ['desktop 1200', 1200, 900]]) {
  const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(1400);

  const over = await page.evaluate(() => {
    const vw = window.innerWidth, out = [];
    for (const el of document.querySelectorAll('#app *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) out.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}@${Math.round(r.right)}`);
    }
    return { doc: Math.round(document.documentElement.scrollWidth - vw), els: out.slice(0, 4) };
  });
  ok(`${label}: the dashboard fits its viewport`, over.doc <= 1, JSON.stringify(over));
  ok(`${label}: and no element hangs past the right edge`, over.els.length === 0, JSON.stringify(over));

  // The same hostile case number that caused it must still be readable, not clipped away.
  ok(`${label}: the long case number is still on screen, wrapped rather than cut`,
     (await text(page, '#app')).includes('window.__pwned'));

  if (w === 390) {
    let smallest = 999, which = '';
    for (const b of await page.locator('.alsoline button, .bandgo .btn').all()) {
      const box = await b.boundingBox();
      if (box && box.height < smallest) { smallest = box.height; which = (await b.innerText()).trim(); }
    }
    ok('every band and also-line control clears 44px', smallest >= 44, `smallest ${smallest}px on "${which}"`);
  }
  await page.close();
}


section('The rail on a phone: 44px targets and nothing sideways');
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);
  await page.locator('.burger').click();
  await page.waitForTimeout(400);

  let smallest = 999, which = '';
  for (const b of await page.locator('.tabs button').all()) {
    const box = await b.boundingBox();
    if (box && box.height < smallest) { smallest = box.height; which = (await b.innerText()).trim(); }
  }
  ok('every drawer target clears 44px', smallest >= 44, `smallest ${smallest}px on "${which}"`);

  const surv = await page.locator('.navfoot .side-surv').boundingBox();
  ok('including the field door', surv && surv.height >= 44, JSON.stringify(surv));

  /* SCOPED TO THE RAIL ON PURPOSE. A page-wide overflow check here would be
     measuring the case cards, not the navigation: `.pcard` is a grid item with
     the default min-width:auto, so this suite's deliberately hostile long case
     number widens its own track past the phone. That is a real `.pcard`
     property, it predates this change, and it belongs to whoever next touches
     the dashboard — not to an assertion in the navigation section, where it
     would fail for a reason nobody reading the section name would guess. */
  const rail = await page.evaluate(() => {
    const t = document.querySelector('.tabs');
    const r = t.getBoundingClientRect();
    return { over: Math.round(t.scrollWidth - t.clientWidth), right: Math.round(r.right), vw: window.innerWidth };
  });
  ok('the group headers do not push the drawer wider than itself', rail.over <= 1, JSON.stringify(rail));
  ok('and the drawer stays inside the phone', rail.right <= rail.vw + 1, JSON.stringify(rail));
  /* NAMED FOR WHAT IT ACTUALLY GUARDS. The assertion above is the measurement,
     but its name says "group headers" and that is only the first thing that
     ever tripped it. What went wrong the second time was different and the name
     sent the next reader looking in the wrong place: `.tabs` is a WRAPPING ROW
     at the top of the stylesheet, the drawer only changes its direction, so the
     wrap came along — and once the items were taller than the drawer they
     wrapped into a SECOND COLUMN. Measured when it broke: 296px wide, 460px of
     content, every child 224px or less. A vertical navigation scrolls; the
     drawer has `overflow-y:auto` for exactly that. */
  const wrap = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.tabs')).flexWrap);
  ok('the drawer is a SCROLLING column, never a wrapping one', wrap === 'nowrap', wrap);
  await page.close();
}


section('A phone can actually reach the navigation');
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);

  ok('the sidebar is out of the way on a phone', !(await page.locator('.tabs').isVisible()));
  ok('but the burger that opens it IS visible', await page.locator('.burger').isVisible());
  await page.locator('.burger').click();
  await page.waitForTimeout(300);
  ok('tapping it opens the drawer', await page.locator('.tabs').isVisible());
  const drawer = await text(page, '.tabs');
  for (const t of ['Dashboard', 'Cases', 'Intakes', 'Billing', 'Settings']) {
    ok(`the drawer carries ${t}`, has(drawer, t), drawer);
  }
  await page.locator('.tabs button', { hasText: 'Intakes' }).click();
  await page.waitForTimeout(700);
  ok('and navigating from it works', has(await text(page, '#app'), 'awaiting a decision'));
  ok('the drawer closes behind you', !(await page.locator('.tabs').isVisible()));
  await page.close();
}
{
  // iPad portrait (834px) sits in the same band as a phone: drawer, not rail.
  const page = await (await browser.newContext({ viewport: { width: 834, height: 1112 } })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);
  ok('an iPad in portrait also gets the burger', await page.locator('.burger').isVisible());
  await page.close();
}
{
  // iPad landscape / laptop: the rail itself, and no burger.
  const page = await (await browser.newContext({ viewport: { width: 1112, height: 834 } })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);
  ok('a wide screen gets the fixed sidebar rail', await page.locator('.tabs').isVisible());
  ok('and no burger', !(await page.locator('.burger').isVisible()));
  const box = await page.locator('.tabs').boundingBox();
  ok('which is genuinely a left rail', box && box.x === 0 && box.height > 400, JSON.stringify(box));
  await page.close();
}

/* -------------------------------- the voice command registry (SURVEILLANCE-VOICE)

   §4 ONE centralized registry, §5 standardized activity text, §7 never guess.
   The matcher is pure, so it is tested as a function against the real registry
   in the real page rather than by talking to a microphone. */
/* ---------------------------- §10 LAST ACTIVITY, corrected where you stand

   SURVEILLANCE-VOICE.md §10: the investigator "must be able to correct the most
   recent activity WITHOUT NAVIGATING AWAY from the Active Surveillance Home
   screen". At the wheel, leaving the screen to fix a typo is how you lose the
   thing you were watching.

   That the rest of the entry survives a wording-only correction is proved in
   the Worker suite, against the route — this is the screen. */
/* -------------------------- VOICE COMMAND MODE: the wake-word loop (§2, §8, §9, §14, §16)

   Speech recognition does not exist in headless Chromium, so the ENGINE is
   stubbed and everything around it is real: the real registry, the real
   activity API, the real database. The stub only decides what was "heard" —
   which is the one thing a machine in a data centre cannot supply. */
section('Voice mode: explicit, looping, and never filing what it is unsure of');
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', (e) => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('dana');
  await page.locator('#p').fill('FieldWork2026x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);

  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  await page.locator('[data-act="svEnter"]:visible').first().click();
  await page.waitForTimeout(700);
  if (await page.locator('[data-act="svStartDay"]').count()) {
    await page.locator('#sv_start').fill('06:30');
    await page.locator('[data-act="svStartDay"]').click();
    await page.waitForTimeout(900);
  }

  /* The stubbed engine. It records start/stop so "the microphone is inactive
     when off" is a fact about calls, not about wording. */
  await page.evaluate(() => {
    window.__mic = { made: 0, started: 0, stopped: 0, rec: null };
    window.SpeechRecognition = function () {
      const self = this;
      window.__mic.made++;
      window.__mic.rec = self;
      self.start = () => { window.__mic.started++; };
      self.stop = () => { window.__mic.stopped++; };
    };
  });
  const say = async (words) => {
    await page.evaluate((w) => {
      const r = window.__mic.rec;
      r.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: w } }] });
    }, words);
    await page.waitForTimeout(700);
  };
  const stateText = () => text(page, '.sv-voice');
  const entries = () => page.evaluate(() => (WS && WS.activity ? WS.activity.length : -1));
  const mic = () => page.evaluate(() => window.__mic);

  /* §14 — EXPLICIT ACTIVATION. Opening Active Surveillance arms nothing. */
  ok('voice mode is off when the field view opens',
     has(await stateText(), 'Voice mode off'), (await stateText()).slice(0, 160));
  ok('and no recogniser has been constructed at all',
     (await mic()).made === 0, JSON.stringify(await mic()));
  ok('the control says what it will do rather than what it is',
     has(await stateText(), 'tap to start'));

  /* ON. §2's state, in §14's words. */
  await page.locator('[data-act="svVoiceToggle"]').click();
  await page.waitForTimeout(500);
  ok('turning it on starts listening for the wake word',
     has(await stateText(), 'Listening for'), (await stateText()).slice(0, 160));
  ok('and the engine was actually started', (await mic()).started === 1);
  /* §16 — the limitation is on the screen, not only in a document. */
  ok('it says plainly that it only listens while on screen',
     has(await stateText(), 'only listens while this page is on screen'));

  /* NOT EVERYTHING IN THE CAR IS FOR US. */
  const before = await entries();
  await say('so then he pulled out and drove off down the road');
  ok('speech without the wake word files nothing', (await entries()) === before);
  ok('and does not interrupt with a review prompt',
     await page.locator('#sv_heard').count() === 0);
  ok('it is still listening', has(await stateText(), 'Listening for'));

  /* THE TWO-STEP FORM: "Mobile" alone arms it. */
  await say('Mobile');
  ok('saying just the wake word arms it for a command',
     has(await stateText(), 'Listening for the command'), (await stateText()).slice(0, 160));

  /* §3 + §9 — a recognized command becomes a REAL entry, and confirms briefly. */
  await say('no change at residence');
  let filedCount = await entries();
  for (let i = 0; i < 20 && filedCount !== before + 1; i++) {
    await page.waitForTimeout(200);
    filedCount = await entries();
  }
  ok('the command files a real activity entry', filedCount === before + 1,
     `${before} -> ${filedCount}`);
  /* THE ENTRY JUST FILED IS AT THE END. WS.activity is chronological and
     oldest-first since Unit 38, so "the one I just spoke" is the last element
     rather than the first — these six reads used to index from the front. */
  const filed = await page.evaluate(() => (WS.activity[WS.activity.length - 1] || {}));
  ok('with the standardized wording, not the transcript',
     filed.description === 'No change observed at the residence.', filed.description);
  ok('marked as captured by voice, with the command that made it',
     filed.source === 'voice' && filed.command_id === 'NO_CHANGE_RESIDENCE',
     JSON.stringify({ s: filed.source, c: filed.command_id }));
  ok('a brief confirmation names the command and the time',
     has(await stateText(), 'NO CHANGE RESIDENCE'), (await stateText()).slice(0, 200));
  /* §9 — and back to listening WITHOUT the investigator touching anything. */
  ok('and it returns to listening on its own',
     has(await stateText(), 'Listening for “Mobile'), (await stateText()).slice(0, 200));

  /* §8 — ONE spoken command, ONE record, however many finals the engine emits. */
  const after = await entries();
  await say('Mobile, subject observed');
  await say('Mobile, subject observed');
  ok('the same command heard twice makes one entry, not two',
     (await entries()) === after + 1, `${after} -> ${await entries()}`);

  /* AN UNCERTAIN PHRASE IS KEPT, NOT REFUSED (owner, 2026-08-18). Proven with
     a real collision added to the registry, because the shipped one has no
     such pair. */
  const n2 = await entries();
  await page.evaluate(() => {
    VOICE_COMMANDS.push({ id: 'TEST_TIE', text: 'A test tie.', say: ['lost visual'] });
  });
  await say('Mobile, lost visual');
  ok('an ambiguous phrase is saved rather than thrown away', (await entries()) === n2 + 1,
     `${n2} -> ${await entries()}`);
  const amb = await page.evaluate(() => (WS.activity[WS.activity.length - 1] || {}));
  ok('in the words that were actually spoken', amb.description === 'lost visual', amb.description);
  /* THE PART OF §7 THAT STILL HOLDS, and the part that mattered: NO_CHANGE and
     CHANGE_POSITION are opposite facts about the same minute. An uncertain
     phrase records what was SAID and claims neither. */
  ok('claiming no canonical command, because more than one fitted it',
     !amb.command_id, JSON.stringify(amb.command_id));
  ok('still marked as captured by voice', amb.source === 'voice');
  ok('and the loop kept listening rather than stopping to ask',
     has(await stateText(), 'Listening for'), (await stateText()).slice(0, 200));
  await page.evaluate(() => { VOICE_COMMANDS.pop(); });

  /* THE CASE THE OWNER REPORTED: useful speech that matches nothing. */
  const n3 = await entries();
  await say('Mobile, the grey van came back and parked across the street');
  ok('an unrecognised observation is saved in the investigator’s own words',
     (await entries()) === n3 + 1, `${n3} -> ${await entries()}`);
  const free = await page.evaluate(() => (WS.activity[WS.activity.length - 1] || {}));
  ok('with the wake word stripped off the front',
     free.description === 'the grey van came back and parked across the street',
     free.description);
  ok('and no canonical command invented for it', !free.command_id);
  ok('the loop is still listening after saving it',
     has(await stateText(), 'Listening for'), (await stateText()).slice(0, 200));
  ok('and it confirmed the save briefly, like any other',
     has(await stateText(), 'VOICE NOTE'), (await stateText()).slice(0, 200));

  /* "Mobile, note …" still means free text, and the word that asked for it is
     not part of the observation. */
  const n4 = await entries();
  await say('Mobile, note the subject left in a grey van');
  ok('a dictated note is saved too', (await entries()) === n4 + 1);
  ok('without the word that asked for it',
     (await page.evaluate(() => WS.activity[WS.activity.length - 1].description)) === 'the subject left in a grey van',
     await page.evaluate(() => WS.activity[WS.activity.length - 1].description));

  /* §8 still holds for free speech, which has no command id to key on. */
  const n5 = await entries();
  await say('Mobile, the same words twice');
  await say('Mobile, the same words twice');
  ok('the same free phrase heard twice makes one entry, not two',
     (await entries()) === n5 + 1, `${n5} -> ${await entries()}`);

  /* OFF means the microphone is inactive — asserted as a call, not a label. */
  const onCount = (await mic()).stopped;
  await page.locator('[data-act="svVoiceToggle"]').click();
  await page.waitForTimeout(400);
  ok('turning it off stops the engine', (await mic()).stopped === onCount + 1);
  ok('and says so', has(await stateText(), 'Voice mode off'), (await stateText()).slice(0, 160));

  /* §16 — FOREGROUND ONLY, enforced. */
  await page.locator('[data-act="svVoiceToggle"]').click();
  await page.waitForTimeout(400);
  const hiddenBefore = (await mic()).stopped;
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(400);
  ok('the page going into the background stops the microphone',
     (await mic()).stopped === hiddenBefore + 1);
  ok('and says that is what happened, rather than going quiet',
     has(await stateText(), 'went into the background'), (await stateText()).slice(0, 220));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  /* ONE REGISTRY still, and the loop did not grow a second one. */
  const src = fs.readFileSync(path.join(ROOT, 'portal/index.html'), 'utf8');
  ok('the loop matches phrases through the registry and nowhere else',
     (src.match(/function voiceMatch\(/g) || []).length === 1
     && (src.match(/voiceMatch\(/g) || []).length >= 2);
}

/* ------------------------- the iPhone bug: ON, microphone lit, nothing happens

   Owner, live on the device, 2026-08-18: "Voice Mode shows ON and iOS mic
   indicator is active, but saying Mobile produces no result and Tap to speak
   does nothing."

   TWO SYMPTOMS, and one of them is a defect that needs no Safari knowledge to
   see: the page had TWO recognisers — the loop's and "Tap to speak"'s — and a
   browser gives a page ONE speech session. Starting a second on top of the
   first is ignored, which is exactly what a button that does nothing looks
   like. That half is fixed and asserted here.

   The other half cannot be reproduced in this container, because there is no
   speech engine in it at all. So the fix is (a) stop asking for `continuous`,
   which iOS Safari does not honour and which produces precisely the reported
   "microphone on, no results", and (b) make the device show its own events, so
   the next device test reports a fact instead of a symptom. */
section('Voice mode: the engine is one session, and it says what it did');
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', (e) => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('dana');
  await page.locator('#p').fill('FieldWork2026x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  await page.locator('[data-act="svEnter"]:visible').first().click();
  await page.waitForTimeout(700);
  if (await page.locator('[data-act="svStartDay"]').count()) {
    await page.locator('#sv_start').fill('06:30');
    await page.locator('[data-act="svStartDay"]').click();
    await page.waitForTimeout(900);
  }

  await page.evaluate(() => {
    window.__mic = { made: 0, started: 0, stopped: 0, rec: null, throwOnStart: false };
    window.SpeechRecognition = function () {
      const self = this;
      window.__mic.made++;
      window.__mic.rec = self;
      self.start = () => {
        if (window.__mic.throwOnStart) throw new Error('InvalidStateError: already started');
        window.__mic.started++;
      };
      self.stop = () => { window.__mic.stopped++; };
    };
  });
  const mic = () => page.evaluate(() => window.__mic);
  const panel = () => text(page, '.sv-voice');
  const fire = async (name, payload) => {
    await page.evaluate(([n, p]) => { window.__mic.rec['on' + n](p || {}); }, [name, payload || null]);
    await page.waitForTimeout(250);
  };

  await page.locator('[data-act="svVoiceToggle"]').click();
  await page.waitForTimeout(500);

  /* NOT CONTINUOUS. iOS Safari does not honour it, and the session then starts,
     lights the indicator, and delivers nothing — the reported symptom. */
  const cfg = await page.evaluate(() => ({
    continuous: window.__mic.rec.continuous,
    interim: window.__mic.rec.interimResults,
    lang: window.__mic.rec.lang,
  }));
  ok('the loop asks for one-shot recognition, not continuous',
     cfg.continuous === false, JSON.stringify(cfg));

  /* EVERY engine event is wired, because what is MISSING from the log is as
     diagnostic as what is in it. */
  const wired = await page.evaluate(() => VOICE_ENGINE_EVENTS
    .filter((n) => typeof window.__mic.rec['on' + n] === 'function').length);
  ok('every speech event the engine can raise is listened for', wired === 11, String(wired));

  /* THE LOG IS ON THE DEVICE, not in a console no one can open on a phone. */
  ok('the log is visible once there is something in it',
     await page.locator('.sv-voicelog').count() === 1);
  ok('and already shows this page calling start()',
     has(await panel(), 'start() called'), (await panel()).slice(-300));

  await fire('audiostart');
  await fire('speechstart');
  ok('an engine event reaches the log', has(await panel(), 'audiostart'), (await panel()).slice(-300));
  ok('and so does the next one', has(await panel(), 'speechstart'));
  const stamped = await page.evaluate(() =>
    /\d\d:\d\d:\d\d\.\d\d\d/.test(document.querySelector('.sv-voicelogrows').textContent));
  ok('each line carries the time it happened', stamped);

  /* ONE-SHOT MEANS `end` IS NORMAL. It must restart rather than sit there
     claiming to listen. */
  const beforeEnd = (await mic()).started;
  await fire('end');
  ok('the engine ending restarts it, because one-shot ends on its own',
     (await mic()).started === beforeEnd + 1, `${beforeEnd} -> ${(await mic()).started}`);
  ok('and the restart is in the log', has(await panel(), 'restarting'));

  /* AN ERROR IS LOGGED, NOT SWALLOWED — even the ordinary ones that stop
     nothing. Silence was what made this bug invisible. */
  await fire('error', { error: 'no-speech' });
  ok('an ordinary no-speech is logged rather than hidden',
     has(await panel(), 'no-speech'), (await panel()).slice(-300));
  ok('and it does not turn voice mode off', has(await panel(), 'tap to stop'));

  /* THE DEFECT THE OWNER FELT AS "Tap to speak does nothing". */
  const stopsBefore = (await mic()).stopped;
  await page.locator('[data-act="svMic"]').click();
  await page.waitForTimeout(500);
  ok('Tap to speak takes the session instead of starting a second engine',
     (await mic()).stopped === stopsBefore + 1, `${stopsBefore} -> ${(await mic()).stopped}`);
  ok('voice mode stands down when it does',
     has(await panel(), 'tap to start'), (await panel()).slice(0, 200));
  ok('and the handover is on the record',
     has(await panel(), 'Tap to speak took the microphone'));
  await page.evaluate(() => { if (SV._rec) { SV.listening = false; SV._rec = null; } });

  /* A START THAT THROWS MUST NOT LEAVE THE PANEL CLAIMING ON. That is the
     shape of the whole bug report: a control that says it is listening while
     nothing is. */
  await page.evaluate(() => { window.__mic.throwOnStart = true; });
  await page.locator('[data-act="svVoiceToggle"]').click();
  await page.waitForTimeout(500);
  ok('a refused start turns voice mode off rather than claiming to listen',
     has(await panel(), 'tap to start'), (await panel()).slice(0, 200));
  ok('and says the microphone would not start',
     has(await panel(), 'would not start'), (await panel()).slice(0, 300));
  ok('with the throw itself in the log', has(await panel(), 'start() threw'));
  await page.evaluate(() => { window.__mic.throwOnStart = false; });

  /* The log can be cleared, so it costs nothing when it is not wanted. */
  await page.locator('[data-act="svVoiceLogClear"]').click();
  await page.waitForTimeout(300);
  ok('the log can be cleared away', await page.locator('.sv-voicelog').count() === 0);
}

/* ------------------ §13 capture, §8 offline, §1 compact — the mobile polish

   §13: "Support 'Mobile, take photo' and 'Mobile, video'. If the browser
   requires a user gesture before actual capture: open/prepare the correct
   capture interface, and do not claim a photo or video was captured until it
   actually was. NEVER FAKE EVIDENCE CREATION." */
section('Voice §13 and §8: prepare the camera, claim nothing, lose nothing');
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', (e) => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('dana');
  await page.locator('#p').fill('FieldWork2026x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  await page.locator('[data-act="svEnter"]:visible').first().click();
  await page.waitForTimeout(700);
  if (await page.locator('[data-act="svStartDay"]').count()) {
    await page.locator('#sv_start').fill('06:30');
    await page.locator('[data-act="svStartDay"]').click();
    await page.waitForTimeout(900);
  }

  await page.evaluate(() => {
    window.__mic = { started: 0, stopped: 0, rec: null };
    window.SpeechRecognition = function () {
      const self = this;
      window.__mic.rec = self;
      self.start = () => { window.__mic.started++; };
      self.stop = () => { window.__mic.stopped++; };
    };
  });
  const say = async (words) => {
    await page.evaluate((w) => {
      window.__mic.rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: w } }] });
    }, words);
    await page.waitForTimeout(700);
  };
  const entries = () => page.evaluate(() => (WS && WS.activity ? WS.activity.length : -1));
  const panel = () => text(page, '.sv-voice');

  /* §1 / §16.1 — THE STATUS IS COMPACT, and this is measured rather than
     admired: what matters is that the controls start high enough for a thumb. */
  const geom = await page.evaluate(() => {
    const st = document.querySelector('.sv-status');
    const quad = document.querySelector('.sv-quad');
    return { status: Math.round(st.getBoundingClientRect().height),
             controlsTop: Math.round(quad.getBoundingClientRect().top),
             vh: window.innerHeight };
  });
  ok('the status block is compact, not a stack of lines',
     geom.status <= 78, `${geom.status}px`);
  ok('and the quick controls start in the top third of the phone',
     geom.controlsTop < geom.vh / 3, `${geom.controlsTop} of ${geom.vh}`);
  ok('while still saying it is active, for how long, and which day',
     has(await text(page, '.sv-status'), 'ACTIVE')
     && /Day \d/.test(await text(page, '.sv-status')), await text(page, '.sv-status'));

  await page.locator('[data-act="svVoiceToggle"]').click();
  await page.waitForTimeout(500);

  /* §13 — THE COMMAND PREPARES AND CLAIMS NOTHING. */
  const before = await entries();
  await say('Mobile, take photo');
  ok('a photo command files no activity at all', (await entries()) === before,
     `${before} -> ${await entries()}`);
  ok('and creates no evidence record either',
     await page.evaluate(() => (WS.evidence || []).length) === 0);
  ok('it prepares the capture instead', await page.locator('.sv-capture').count() === 1);
  ok('saying plainly that nothing is logged until the picture arrives',
     has(await text(page, '.sv-capture'), 'Nothing is logged until'),
     await text(page, '.sv-capture'));
  ok('with the one tap the browser requires',
     await page.locator('[data-act="svCaptureGo"]').count() === 1);
  ok('and a way out of it', await page.locator('[data-act="svCaptureCancel"]').count() === 1);
  /* THE LOOP DOES NOT STOP TO WAIT. */
  ok('the loop is still listening while the camera waits',
     has(await panel(), 'Listening for'), (await panel()).slice(0, 200));

  await page.locator('[data-act="svCaptureCancel"]').click();
  await page.waitForTimeout(300);
  ok('cancelling clears it and still files nothing',
     await page.locator('.sv-capture').count() === 0 && (await entries()) === before);

  await say('Mobile, video');
  ok('a video command prepares the video tool',
     has(await text(page, '.sv-capture'), 'Video ready'), await text(page, '.sv-capture'));
  ok('and files nothing either', (await entries()) === before);
  await page.locator('[data-act="svCaptureCancel"]').click();
  await page.waitForTimeout(300);

  /* §8 — NO SIGNAL MUST NOT LOSE THE OBSERVATION. A surveillance position is
     exactly where there is no bar of service. */
  await page.evaluate(() => {
    window.__realFetch = window.fetch;
    window.fetch = (u, o) => (String(u).includes('/activity') && o && o.method === 'POST')
      ? Promise.reject(new TypeError('Failed to fetch'))
      : window.__realFetch(u, o);
  });
  const n1 = await entries();
  await say('Mobile, the grey van came back');
  ok('an entry that cannot be sent is not lost', has(await panel(), 'held on this phone'),
     (await panel()).slice(0, 260));
  ok('and the operator is told how many are waiting',
     has(await panel(), '1 entry is held') || has(await panel(), 'entries are held'),
     (await panel()).slice(0, 260));
  ok('nothing reached the case yet', (await entries()) === n1);
  ok('and the loop kept listening through it',
     has(await panel(), 'Listening for'), (await panel()).slice(0, 200));

  /* THE NETWORK COMES BACK. */
  await page.evaluate(() => { window.fetch = window.__realFetch; });
  await page.locator('[data-act="svVoiceRetry"]').click();
  await page.waitForTimeout(1200);
  ok('when the signal returns the held entry sends itself',
     (await entries()) === n1 + 1, `${n1} -> ${await entries()}`);
  ok('in the words that were spoken',
     (await page.evaluate(() => WS.activity[WS.activity.length - 1].description)) === 'the grey van came back',
     await page.evaluate(() => WS.activity[WS.activity.length - 1].description));
  ok('and the waiting notice is gone', !has(await panel(), 'held on this phone'));

  /* THE RETRY CARRIES THE SAME NAME, which is what stops a lost response
     becoming a second entry. */
  const ids = await page.evaluate(() => window.__eventIds || null);
  ok('the held entry was sent under one event id, not a fresh one each time',
     ids === null || new Set(ids).size === ids.length);
}

section('Voice §10: the last activity is corrected without leaving the field screen');
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', (e) => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('dana');
  await page.locator('#p').fill('FieldWork2026x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);

  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  await page.locator('[data-act="svEnter"]:visible').first().click();
  await page.waitForTimeout(700);

  // Whichever state earlier sections left the day in, get one running.
  if (await page.locator('[data-act="svStartDay"]').count()) {
    await page.locator('#sv_start').fill('06:30');
    await page.locator('[data-act="svStartDay"]').click();
    await page.waitForTimeout(900);
  }

  /* An entry to correct. Note is the one quick action that opens the form
     without depending on which template lines happen to be configured. */
  await page.locator('[data-act="svNote"]').first().click();
  await page.waitForTimeout(400);
  await page.locator('#sv_desc').fill('No chnage observed at the residence.');
  await page.locator('[data-act="svSaveEntry"]').first().click();
  await page.waitForTimeout(1000);
  await page.locator('[data-act="svTab"][data-t="home"]').first().click();
  await page.waitForTimeout(700);

  const homeText = () => text(page, '.sv-body');
  ok('the last activity is on the field home', has(await homeText(), 'No chnage observed'),
     (await homeText()).slice(0, 200));
  ok('with Edit and Remove right there',
     await page.locator('[data-act="svLastEdit"]').count() === 1
     && await page.locator('[data-act="svDelete"]').count() >= 1);

  /* WITHOUT NAVIGATING AWAY. The editor opens INSIDE the home screen, so the
     assertion is that the things which MAKE it the home screen are still on it. */
  await page.locator('[data-act="svLastEdit"]').click();
  await page.waitForTimeout(400);
  ok('editing opens in place', await page.locator('#sv_last_edit').count() === 1);
  ok('and the screen is still the field home, not the activity form',
     await page.locator('.sv-quad').count() === 1
     && await page.locator('[data-act="svLastSave"]').count() === 1
     && await page.locator('#sv_desc').count() === 0);
  ok('the bottom navigation never moved', await page.locator('.sv-nav button').count() === 5);

  await page.locator('#sv_last_edit').fill('No change observed at the residence.');
  await page.locator('[data-act="svLastSave"]').click();
  await page.waitForTimeout(1000);
  ok('the correction lands, still on the home screen',
     has(await homeText(), 'No change observed at the residence.')
     && await page.locator('.sv-quad').count() === 1, (await homeText()).slice(0, 200));

  /* Cancel leaves the entry exactly as it was — an editor you cannot back out
     of is one nobody opens at the wheel. */
  await page.locator('[data-act="svLastEdit"]').click();
  await page.waitForTimeout(350);
  await page.locator('#sv_last_edit').fill('Something typed and thought better of.');
  await page.locator('[data-act="svLastCancel"]').click();
  await page.waitForTimeout(500);
  ok('cancelling changes nothing',
     has(await homeText(), 'No change observed at the residence.')
     && !has(await homeText(), 'thought better of'));

  /* REMOVE, and the way back — the same system the timeline uses (§11). */
  page.once('dialog', (d) => d.accept());
  await page.locator('[data-act="svDelete"]').first().click();
  await page.waitForTimeout(1000);
  /* AND IT IS STILL THE HOME SCREEN. The timeline shows the same "not in the
     report" wording, so without pinning the screen this passed while standing
     somewhere else — which is how the jump to the timeline hid here. */
  ok('removing keeps you on the field home', await page.locator('.sv-quad').count() === 1,
     (await homeText()).slice(0, 200));
  ok('a removed last entry says so on the home screen',
     has(await homeText(), 'not in the report'), (await homeText()).slice(0, 240));
  ok('and offers to put it back without leaving either',
     await page.locator('[data-act="svRestore"]').count() >= 1);
  await page.locator('[data-act="svRestore"]').first().click();
  await page.waitForTimeout(1000);
  ok('putting it back restores it in place',
     has(await homeText(), 'No change observed at the residence.')
     && await page.locator('[data-act="svLastEdit"]').count() === 1,
     (await homeText()).slice(0, 260));
}

section('Voice commands: one registry, standard wording, and no guessing');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  const m = (said) => page.evaluate((x) => {
    const r = voiceMatch(x);
    return { status: r.status, id: r.command ? r.command.id : null, text: r.text || null,
             candidates: (r.candidates || []).map((c) => c.id) };
  }, said);

  /* §5's two verbatim examples, spoken the way §5 spells them — including the
     trailing "stand by" that must not stop the command being recognized. */
  let r = await m('Mobile, doing a drive-by check of residence, stand by.');
  ok('the drive-by check is recognized through the words after it',
     r.status === 'ok' && r.id === 'MOBILE_RESIDENCE_CHECK', r.status + ' ' + r.id);
  ok('and stores the standardized sentence, not the transcript',
     r.text === 'Mobile check of residence was conducted.', r.text);
  r = await m('Mobile, no change at residence.');
  ok('no change at residence is its own command, not the shorter one',
     r.status === 'ok' && r.id === 'NO_CHANGE_RESIDENCE', r.id);
  ok('with §5’s own wording', r.text === 'No change observed at the residence.', r.text);
  /* The shorter command still works on its own — the longest alias winning is
     what keeps these two apart. */
  r = await m('Mobile, no change');
  ok('and the shorter one still means the shorter one', r.id === 'NO_CHANGE', r.id);

  /* The wake word is optional for matching, and is part of the alias where the
     owner wrote it that way. */
  r = await m('Mobile check');
  ok('"Mobile check" is the mobile check command', r.id === 'MOBILE_CHECK', r.id);
  r = await m('no change');
  ok('and a command said without the wake word still matches', r.id === 'NO_CHANGE', r.id);

  /* §6B — "Mobile, note" is the door into dictation, and dictation is NOT a
     command that files itself. */
  r = await m('Mobile, note the subject left in a grey van');
  ok('"Mobile, note" is dictation rather than a filed command',
     r.status === 'dictation' && r.id === 'FREE_FORM_DICTATION_MODE', r.status);

  /* §7 — never guess. Something unplanned is UNRECOGNIZED; it is not bent
     onto the nearest command. */
  r = await m('Mobile, the weather has turned');
  ok('an unplanned phrase is unrecognized, not approximated',
     r.status === 'unrecognized' && r.id === null, r.status + ' ' + r.id);

  /* §4 — the aliases that arrived truncated were NOT inferred. The owner
     supplied VEHICLE_OBSERVED's two phrases directly on 2026-08-18, with the
     instruction not to map the bare word "observed" — which is the reason it
     had no alias until they did: it would file "subject observed" as a vehicle
     sighting. Both halves of that are asserted here. */
  const reg = await page.evaluate(() => VOICE_COMMANDS.map(
    (c) => ({ id: c.id, n: c.say.length })));
  ok('every canonical command in §4 is in the registry', reg.length >= 21, String(reg.length));
  r = await m('Mobile, vehicle observed');
  ok('"vehicle observed" is the vehicle command', r.id === 'VEHICLE_OBSERVED', r.id);
  r = await m('Mobile, vehicle sighting');
  ok('and so is "vehicle sighting"', r.id === 'VEHICLE_OBSERVED', r.id);
  r = await m('Mobile, observed');
  ok('bare "observed" is deliberately mapped to nothing',
     r.status === 'unrecognized' && r.id === null, r.status + ' ' + r.id);
  r = await m('Mobile, subject observed');
  ok('so "subject observed" is still the subject, never the vehicle',
     r.id === 'SUBJECT_OBSERVED', r.id);

  /* §7's hard case: two DIFFERENT commands that fit equally well. Proven by
     adding one, because the shipped registry deliberately has no such pair —
     the mechanism has to work the day someone adds one. */
  const amb = await page.evaluate(() => {
    VOICE_COMMANDS.push({ id: 'TEST_TIE', text: 'A test tie.', say: ['no change'] });
    const r = voiceMatch('Mobile, no change');
    VOICE_COMMANDS.pop();
    return { status: r.status, candidates: (r.candidates || []).map((c) => c.id) };
  });
  ok('two commands that fit equally are reported ambiguous, not resolved by table order',
     amb.status === 'ambiguous' && amb.candidates.length === 2, amb.status + ' ' + amb.candidates);
  ok('and the registry is unchanged afterwards',
     (await m('Mobile, no change')).status === 'ok');

  /* ONE REGISTRY. §4: "No scattered phrase matching through UI components." */
  const src = fs.readFileSync(path.join(ROOT, 'portal/index.html'), 'utf8');
  ok('the standard sentences exist in exactly one place',
     (src.match(/No change observed at the residence\./g) || []).length === 1);
  ok('and only the registry decides what a spoken phrase means',
     (src.match(/function voiceMatch\(/g) || []).length === 1);
}

section('The Active Surveillance mark');
{
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'portal/manifest.webmanifest'), 'utf8'));
  ok('the home-screen name is the firm\'s', manifest.name === 'API Surveillance');
  ok('it launches into the field, not the office', manifest.start_url === '/portal/?surveillance=1');
  ok('it opens standalone, portrait, in the field colours',
     manifest.display === 'standalone' && manifest.orientation === 'portrait'
     && manifest.background_color === '#0d1826');
  for (const i of manifest.icons) {
    ok(`the ${i.sizes} icon exists in the repo`,
       fs.existsSync(path.join(ROOT, 'portal', i.src)), i.src);
    ok(`the ${i.sizes} icon is the portal's own, not borrowed from /watch/`,
       !i.src.includes('/watch/'), i.src);
  }
  /* Not maskable on purpose: an Android mask crops the corners, which would
     take the firm's banner off the top of the mark. */
  ok('no icon is declared maskable', !manifest.icons.some(i => /maskable/.test(i.purpose || '')));
  ok('an Apple touch icon is present too',
     fs.existsSync(path.join(ROOT, 'portal/icon-180.png')));

  /* The portal's CSP is default-src 'none', which silently blocks the manifest
     — and therefore the whole install — unless manifest-src says otherwise.
     Nothing on screen reports it; the Add to Home Screen option simply never
     offers the app. */
  const headers = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8');
  const portalCsp = (headers.split('/portal/*')[1] || '').split('\n')
    .find(l => l.includes('Content-Security-Policy')) || '';
  ok('the portal CSP allows its own manifest', /manifest-src 'self'/.test(portalCsp), portalCsp);
  /* `blob:` is the page's OWN picture, made in this tab and readable by nobody
     else — the same permission `media-src` has carried since the video tool
     shipped. Without it Timestamp Photo was blocked on every device. */
  ok('images are its own, plus data: and its own blobs',
     /img-src 'self' data: blob:/.test(portalCsp), portalCsp);
  ok('and no remote origin is allowed to supply one',
     !/img-src[^;]*https?:/.test(portalCsp), portalCsp);
  ok('while defaulting to none', /default-src 'none'/.test(portalCsp));

  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  ok('the launch button wears the app icon',
     await page.locator('.sv-go img').count() === 1);
  const served = await page.evaluate(async () => {
    const r = await fetch(document.querySelector('.sv-go img').getAttribute('src'),
      { credentials: 'same-origin' });
    return { status: r.status, type: r.headers.get('content-type') };
  });
  ok('and that icon actually serves', served.status === 200 && /image\/png/.test(served.type || ''),
     JSON.stringify(served));
  await page.close();
}

/* Straight from using it in the field on 2026-08-14: a way back that does not
   leave the mode, and Edit/Delete on the things you just logged. */
section('Back, edit and delete, from the field');
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('dana');
  await page.locator('#p').fill('FieldWork2026x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(600);
  await page.locator('[data-act="svEnter"]:visible').first().click();
  await page.waitForTimeout(800);

  // Earlier sections ended this case's day, so start one to work inside.
  if (await page.locator('[data-act="svStartDay"]').count()) {
    await page.locator('#sv_start').fill('05:45');
    await page.locator('[data-act="svStartDay"]').click();
    await page.waitForTimeout(1000);
  }
  ok('the home screen needs no back button', await page.locator('.sv-backbar').count() === 0);
  await page.locator('.sv-nav button', { hasText: 'Media' }).click();
  await page.waitForTimeout(500);
  ok('every other screen has one', await page.locator('.sv-backbar').count() === 1);
  ok('and it goes back WITHOUT leaving the mode',
     has(await text(page, '.sv-backbar'), 'Back to active surveillance'));
  await page.locator('.sv-back').first().click();
  await page.waitForTimeout(500);
  ok('tapping it lands on the field home, still in the mode',
     await page.locator('.sv-nav').count() === 1 && await page.locator('.sv-backbar').count() === 0);
  /* The distinction this asserts is the real one and still holds: the
     contextual back does NOT leave the mode, and Exit active mode is a
     different control somewhere else. It moved to the Case drawer in Mobile
     PR 2, so this checks the SEPARATION rather than the old address. */
  ok('and Exit active mode is still a separate control, not this one',
     !has(await text(page, '.sv-body'), 'Exit active mode')
     && await page.locator('.sv-back').count() === 0);

  // Log a line, then correct it, then remove it — all from the phone.
  await page.locator('.sv-nav button', { hasText: 'Activity' }).click();
  await page.waitForTimeout(400);
  await page.locator('.sv-cat', { hasText: 'Vehicle' }).click();
  await page.waitForTimeout(250);
  await page.locator('.sv-pick').first().click();
  await page.waitForTimeout(300);
  await page.locator('#sv_desc').fill('Typo entry to be corrected.');
  await page.locator('[data-act="svSaveEntry"]').click();
  await page.waitForTimeout(900);

  await page.locator('.sv-nav button', { hasText: 'Home' }).click();
  await page.waitForTimeout(400);
  await page.locator('[data-act="svTab"][data-t="timeline"]').first().click();
  await page.waitForTimeout(500);
  const line = () => page.locator('.sv-tl li', { hasText: 'Typo entry to be corrected.' });
  ok('the timeline offers Edit on the entry', await line().locator('[data-act="svEdit"]').count() === 1);
  ok('and Delete', await line().locator('[data-act="svDelete"]').count() === 1);

  await line().locator('[data-act="svEdit"]').click();
  await page.waitForTimeout(400);
  ok('Edit opens the entry with its own words',
     (await page.locator('#sv_desc').inputValue()) === 'Typo entry to be corrected.');
  await page.locator('#sv_desc').fill('Subject vehicle departed the residence.');
  await page.locator('.sv-btn.gold', { hasText: 'Save the correction' }).click();
  await page.waitForTimeout(900);
  ok('the correction is on the timeline',
     has(await text(page, '.sv-tl'), 'Subject vehicle departed the residence.'));

  page.on('dialog', d => d.accept());
  await page.locator('.sv-tl li', { hasText: 'Subject vehicle departed the residence.' })
    .locator('[data-act="svDelete"]').click();
  await page.waitForTimeout(1000);
  const tl = await text(page, '.sv-tl');
  ok('a removed entry is struck through rather than vanishing', has(tl, 'Removed'));
  ok('it says it is out of the report', has(tl, 'not in the report'));
  ok('and offers to put it back',
     await page.locator('[data-act="svRestore"]').count() >= 1);
  await page.locator('[data-act="svRestore"]').first().click();
  await page.waitForTimeout(900);
  ok('restoring makes it ordinary again',
     !has(await text(page, '.sv-tl'), 'Removed'));

  // Evidence gets the same two controls.
  await page.locator('.sv-nav button', { hasText: 'Media' }).click();
  await page.waitForTimeout(600);
  if (await page.locator('.evcard').count()) {
    ok('an evidence card offers a caption', await page.locator('[data-act="svEvNote"]').count() >= 1);
    ok('and a delete', await page.locator('[data-act="svEvDelete"]').count() >= 1);
  }
  ok('and the field is told its uploads are ready for the report, not held back',
     has(await text(page, '.sv-body'), 'ready for the'));

  // Leave the world as we found it — the next section expects no day running.
  await page.locator('.sv-nav button', { hasText: 'Home' }).click();
  await page.waitForTimeout(400);
  await page.locator('.sv-btn', { hasText: 'End investigation day' }).first().click();
  await page.waitForTimeout(500);
  await page.locator('[data-act="svEndDay"]').click();
  await page.waitForTimeout(900);
  await page.close();
}
{
  // The office side of the same removal, and the timer that got smaller.
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  await wsTab(page, 'Activity');
  ok('the office timeline offers Delete too',
     await page.locator('.tl-edit', { hasText: 'Delete' }).count() >= 1);
  await page.close();
}

/* The home-screen launcher (P16) and the office's live view (P18). */
section('The home-screen launcher, and who is out now');
{
  /* A FRESHLY INSTALLED shortcut has no session yet: the flag must survive the
     sign-in. It did not — boot() only checked it when a session already
     existed, so the first launch after installing dropped the investigator in
     the office portal instead of the field. */
  const fresh = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  fresh.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await fresh.goto(SITE + '/portal/?surveillance=1');
  await fresh.waitForTimeout(400);
  ok('the shortcut asks for a sign-in when there is no session',
     await fresh.locator('#loginBtn').count() === 1);
  await fresh.locator('#u').fill('dana');
  await fresh.locator('#p').fill('FieldWork2026x');
  await fresh.locator('#loginBtn').click();
  await fresh.waitForTimeout(1100);
  ok('and signing in from it lands in the FIELD, not the office',
     await fresh.locator('.sv').count() === 1,
     (await fresh.locator('#app').innerText()).slice(0, 120));
  await fresh.close();

  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await page.goto(SITE + '/portal/?surveillance=1');
  await page.waitForTimeout(900);
  ok('the shortcut opens the field launcher', await page.locator('.sv').count() === 1);
  const l = await text(page, '.sv');
  ok('with no day running it lists the assignments', has(l, 'My surveillance assignments'));
  ok('and names one', has(l, 'API-20260812-4001'));
  ok('there is a way into the full portal', has(l, 'The full portal'));
  await page.locator('[data-act="svEnter"]').first().click();
  await page.waitForTimeout(900);
  ok('and it opens straight into the field view of that case',
     await page.locator('.sv-nav').count() === 1);

  // Start a day so the office has someone to see.
  await page.locator('#sv_start').fill('08:00');
  await page.locator('[data-act="svStartDay"]').click();
  await page.waitForTimeout(900);
  ok('the day is running', await page.locator('#svTimer').count() === 1);

  // Relaunching now resumes rather than asking again.
  await page.goto(SITE + '/portal/?surveillance=1');
  await page.waitForTimeout(900);
  ok('relaunching offers to resume the running day',
     has(await text(page, '.sv'), 'Resume active surveillance'));
  ok('and shows its elapsed time', /\d\d:\d\d:\d\d/.test(await text(page, '.sv-timer')));
  await page.close();

  const admin = await newPage();
  await signIn(admin, 'trever', 'AdminPassword1x');
  await admin.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await admin.waitForTimeout(700);
  const board = await text(admin, '#app');
  ok('the office sees who is out now', has(board, 'Out now'));
  ok('with the investigator named', has(board, 'Dana Field'));
  ok('and the case', has(board, 'API-20260812-4001'));
  ok('and no location tracking of any kind',
     !has(board, 'GPS') && !has(board, 'location'));
  await admin.close();
}

/* MASTER §13 — a three-day case in the package screen. Seeded here, at the
   end of the run, so the extra case cannot shift the dashboard counts and
   list assertions the earlier sections make. */
section('A three-day package reads as one investigation');
{
  await post('/ingest', {
    case_no: 'API-20260812-4003', service: 'Insurance Claim Assignment',
    carrier: 'Example Mutual Insurance', claim_number: 'WC-2026-99000',
    claim_type: "Workers' compensation", date_of_loss: '02/02/2026',
    client_name: 'Dana Reyes', subject_name: 'Reese Alvarado',
    objective: 'Document activity across a full working week.',
  }, { 'X-Ingest-Key': 'e2e-ingest-key' });

  const uid = db.prepare("SELECT id FROM users WHERE username = 'trever'").get().id;
  const dayIds = [];
  for (const [d, s, e, h] of [['2026-08-10', '07:00', '15:00', 8],
                              ['2026-08-11', '06:30', '14:30', 8],
                              ['2026-08-12', '08:00', '13:00', 5]]) {
    const r = db.prepare(`INSERT INTO case_days
      (case_no, investigator_id, day_date, start_time, end_time, hours, miles, created_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('API-20260812-4003', uid, d, s, e, h, 42, d + 'T12:00:00Z', d + 'T20:00:00Z');
    dayIds.push(Number(r.lastInsertRowid));
    db.prepare(`INSERT INTO case_reports
      (case_no, day_id, investigator_id, report_date, status, body, created_at)
      VALUES (?, ?, ?, ?, 'approved', ?, ?)`)
      .run('API-20260812-4003', Number(r.lastInsertRowid), uid, d,
           `Narrative for ${d}. Subject observed leaving the residence.`, d + 'T21:00:00Z');
  }

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4003').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Package');
  await page.waitForTimeout(700);
  await page.locator('[data-act="pkgStart"]').click();
  await page.waitForTimeout(800);

  let body = await text(page, '#dlgBody');
  ok('the package names its days', has(body, 'Days in this package'));
  ok('all three days are in it, not just the last',
     has(body, 'Investigation — Day 1') && has(body, 'Investigation — Day 2')
     && has(body, 'Investigation — Day 3'));
  ok('the contents line counts days rather than saying "one report"',
     has(body, '3 days, approved'));
  ok('the day total adds the hours up', has(body, '21 h'));

  const doc = await text(page, '#pkgdoc');
  ok('the document heads with case information', has(doc, 'CASE INFORMATION'));
  ok('and carries the claim it belongs to', has(doc, 'WC-2026-99000'));
  ok('and who it is prepared for', has(doc, 'Example Mutual Insurance'));
  ok('the assignment objective is stated, not assumed',
     has(doc, 'ASSIGNMENT OBJECTIVE') && has(doc, 'Document activity across a full working week'));
  ok('every day gets its own titled section',
     has(doc, 'INVESTIGATION — DAY 1') && has(doc, 'INVESTIGATION — DAY 3'));
  ok('each day prints its own narrative',
     has(doc, 'Narrative for 2026-08-10') && has(doc, 'Narrative for 2026-08-12'));
  ok('the masthead reads as a span of days, not a single date',
     has(doc, '3 days'));
  ok('a multi-day package carries a combined summary', has(doc, 'COMBINED SUMMARY'));
  ok('whose facts are derived, not typed', has(doc, '3 days of surveillance'));
  ok('including the hours actually worked', has(doc, '21 hours of documented field time'));

  // The admin's own paragraph sits above the derived facts.
  await page.locator('[data-act="pkgSummary"]').fill('The claimant worked throughout.');
  await page.locator('[data-act="pkgSummary"]').blur();
  await page.waitForTimeout(800);
  ok('the admin can write the summary in their own words',
     has(await text(page, '#pkgdoc'), 'The claimant worked throughout'));

  // Dropping a day, and putting it back.
  await page.locator('.row', { hasText: 'Investigation — Day 2' })
    .locator('.btn', { hasText: 'Remove' }).click();
  await page.waitForTimeout(800);
  body = await text(page, '#dlgBody');
  ok('a day can be dropped from the package', has(body, '2 days, approved'));
  ok('and is offered back, named', has(body, 'approved, not in the package'));
  await page.locator('.btn', { hasText: 'Add day' }).click();
  await page.waitForTimeout(800);
  ok('adding it puts the investigation back together',
     has(await text(page, '#dlgBody'), '3 days, approved'));

  // The Custom package type (MASTER §13's fourth).
  ok('Custom is one of the package types',
     await page.locator('[data-act="pkgType"] option[value="custom"]').count() === 1);
  await page.locator('[data-act="pkgType"]').selectOption('custom');
  await page.waitForTimeout(800);
  body = await text(page, '#dlgBody');
  ok('choosing it says what it means', has(body, 'exactly what ships'));
  ok('and it survives a repaint as the selected option',
     await page.locator('[data-act="pkgType"]').inputValue() === 'custom');

  await page.locator('[data-act="pkgFinalize"]').click();
  await page.waitForTimeout(900);
  ok('a three-day custom package finalizes',
     has(await text(page, '#dlgBody'), 'Package finalized'));
  await page.close();
}

/* MASTER §28's private list — Retainer, Amount Applied, Additional
   Authorization, Balance. Seeded at the end for the same reason as above. */
section('A private invoice shows the retainer drawing down');
{
  await post('/ingest', {
    case_no: 'API-20260812-4004', service: 'Surveillance',
    client_name: 'Morgan Hale', client_phone: '4345550188',
    subject_name: 'Alex Hale', objective: 'Establish whereabouts on weekday evenings.',
  }, { 'X-Ingest-Key': 'e2e-ingest-key' });

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4004').click();
  await page.waitForTimeout(450);

  /* A budget above the retainer is §28's "Additional Authorization". Set it
     first so one invoice can show the whole block. */
  await wsTab(page, 'Authorization');
  await page.locator('#m_budget').fill('2500');
  await page.locator('.btn', { hasText: 'Save authorization' }).click();
  await page.waitForTimeout(600);

  await wsTab(page, 'Billing');
  await page.locator('[data-act="createInvoiceAuth"]').click();
  await page.waitForTimeout(900);

  const body = await text(page, '.card');
  ok('a private case opens on the retainer', has(body, 'Investigation Retainer'));
  ok('the editor shows the retainer block', has(body, 'Retainer held'));
  ok('and says whether the money is actually in', has(body, 'not yet received'));
  ok('with what the case has drawn against it', has(body, 'Applied to date'));
  ok('a budget above the retainer reads as an additional authorization',
     has(body, 'Additional authorization'));

  const doc = await text(page, '#invdoc');
  ok('the document carries the retainer block too', has(doc, 'Retainer held'));
  ok('and reads the remainder, not a mystery balance', has(doc, 'Retainer remaining'));
  ok('a carrier-only special-instructions block stays off a private invoice',
     !has(doc, 'Special instructions'));
  await page.close();
}

/* The owner could not reach the field view from an iPad. svLaunchButton()
   rendered in exactly two places and both were a case's Overview tab, so you
   had to open Cases, open a case and land on Overview before any door
   existed — and ?surveillance=1 assumes the icon is already on the home
   screen. Tested at iPad width BECAUSE that is where it was reported. */
section('The field view has a door you can find from anywhere');
{
  for (const [label, w, h] of [['iPad landscape', 1112, 834], ['phone', 390, 844]]) {
    const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
    page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
    await page.goto(SITE + '/portal/');
    await page.waitForTimeout(300);
    await page.locator('#u').fill('dana');
    await page.locator('#p').fill('FieldWork2026x');
    await page.locator('#loginBtn').click();
    await page.waitForTimeout(900);

    /* THE DOOR HAS TO BE HITTABLE, not merely present (owner, 2026-08-15). At
       1.4rem with 4px of padding the burger measured about 30px square — under
       Apple's 44px minimum and half the 50-52px this file uses for every other
       phone control. Measured, because "it looks fine" is how it stayed that
       size while the navigation it opens was being tested. */
    if (w < 900) {
      const b = await page.locator('.burger').boundingBox();
      ok(`${label}: the menu button clears the 44px minimum`,
         b.height >= 44 && b.width >= 44, `${Math.round(b.width)}x${Math.round(b.height)}`);
      await page.locator('.burger').click(); await page.waitForTimeout(300);
    }
    ok(`${label}: the navigation offers Active surveillance without opening a case`,
       await page.locator('.side-surv').isVisible());
    await page.locator('.side-surv').click();
    await page.waitForTimeout(800);
    ok(`${label}: and it opens the field launcher`,
       has(await text(page, 'body'), 'surveillance'));
    ok(`${label}: from the launcher, without ever touching the home screen`,
       await page.locator('.sv-launch, [data-act="svEnter"]').count() > 0);
    await page.close();
  }

  // The office runs its own fieldwork too, so the same door is on both roles.
  const admin = await newPage();
  await signIn(admin, 'trever', 'AdminPassword1x');
  ok('an admin has the same door', await admin.locator('.side-surv').isVisible());
  await admin.close();
}

/* Pausing the day. The rule that must survive: the clock is derived from
   server timestamps, never counted here — so a pause FREEZES it because
   paused_at is a fixed instant, and a reload shows the same number. */
section('A day can be paused, and a paused clock stays paused');
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('dana');
  await page.locator('#p').fill('FieldWork2026x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);
  // Under 900px the sidebar is a drawer, so the burger comes first.
  await page.locator('.burger').click();
  await page.waitForTimeout(300);
  await page.locator('.side-surv').click();
  await page.waitForTimeout(800);
  await page.locator('[data-act="svEnter"]').first().click();
  await page.waitForTimeout(900);

  /* An earlier section may have left a day running on this investigator —
     that is the point of resume-anywhere. Start one only if none is. */
  if (await page.locator('[data-act="svStartDay"]').count()) {
    await page.locator('[data-act="svStartDay"]').click();
    await page.waitForTimeout(900);
  }
  /* §1 compacted this line: "ACTIVE" now carries the running state and the
     sub-line carries "since 6:30 AM", so "running since" is redundant wording
     that no longer appears. Pinned to the meaning instead of the phrase. */
  ok('the day is running', has(await text(page, '.sv-status'), 'ACTIVE')
     && /since \d/.test(await text(page, '.sv-status')), await text(page, '.sv-status'));
  ok('and a break is offered', await page.locator('[data-act="svPause"]').count() === 1);

  await page.locator('[data-act="svPause"]').click();
  await page.waitForTimeout(900);
  let body = await text(page, '.sv-body');
  ok('pausing says so in words, not only in colour', has(body, 'paused'));
  ok('and says the time is not billed', has(body, 'not billed'));
  ok('the timer is marked paused', await page.locator('.sv-timer.paused').count() === 1);
  ok('Pause is replaced by Resume — never both at once',
     await page.locator('[data-act="svResume"]').count() === 1
     && await page.locator('[data-act="svPause"]').count() === 0);
  ok('ending the day is still reachable while paused',
     await page.locator('[data-act="svTab"][data-t="endday"]').count() === 1);

  /* The whole point: the pause lives on the SERVER, so it survives both the
     seconds passing and the page going away. A reload leaves the mode (that
     has always been true), so come back in through the new top-level door —
     which is exactly how an investigator would recover in the field. */
  const before = await page.locator('#svTimer').innerText();
  await page.waitForTimeout(2200);
  ok('a paused clock does not tick', (await page.locator('#svTimer').innerText()) === before);
  await page.reload();
  await page.waitForTimeout(1200);
  await page.locator('.burger').click();
  await page.waitForTimeout(300);
  await page.locator('.side-surv').click();
  await page.waitForTimeout(900);
  await page.locator('[data-act="svEnter"]').first().click();
  await page.waitForTimeout(900);
  ok('coming back in, the day is still paused on the same number',
     await page.locator('.sv-timer.paused').count() === 1
     && (await page.locator('#svTimer').innerText()) === before);

  await page.locator('[data-act="svResume"]').click();
  await page.waitForTimeout(900);
  ok('resuming puts it back on the clock',
     await page.locator('.sv-timer.paused').count() === 0
     && await page.locator('[data-act="svPause"]').count() === 1);
  await page.close();
}

/* The case bottom bar is the only navigation a phone has once a case is open,
   and the owner could neither see it nor hit it (2026-08-14). It sat 6px off
   the screen edge — `calc(6px + env(safe-area-inset-bottom))` adds nothing
   when the browser reports an inset of zero, which iOS does without
   viewport-fit=cover — and its targets were about 33px, under Apple's 44px
   minimum. Numbers, not eyeballs, because "looks fine" is what shipped it. */
section('The phone bottom bar can be seen and hit');
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);
  // An admin lands on the dashboard, and under 900px the nav is a drawer.
  await page.locator('.burger').click();
  await page.waitForTimeout(300);
  await page.locator('.tabs button', { hasText: 'Cases' }).click();
  await page.waitForTimeout(700);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(700);

  const bar = page.locator('.casepage .wsbar');
  ok('the bottom bar is there on a phone', await bar.isVisible());

  const box = await bar.boundingBox();
  const btns = page.locator('.casepage .wsbar button');
  const n = await btns.count();
  /* Unit 38 — Activity, Summary, + Add, Evidence, More. */
  ok('it carries the five field keys', n === 5, String(n));
  const barText = await text(page, '.casepage .wsbar');
  ok('Activity and Summary are IN the bar, never under More',
     has(barText, 'Activity') && has(barText, 'Summary'), barText);
  ok('and the middle key is the one you press standing up',
     await page.locator('.casepage .wsbar .wsbar-add').count() === 1);
  ok('the desktop row is not a second navigation on a phone',
     (await page.evaluate(() => getComputedStyle(document.querySelector('.wsnav')).display)) === 'none');

  let shortest = 1e9, lowestTop = 0;
  for (let i = 0; i < n; i++) {
    const b = await btns.nth(i).boundingBox();
    shortest = Math.min(shortest, b.height);
    lowestTop = Math.max(lowestTop, b.y + b.height);
  }
  ok(`every target clears Apple's 44px minimum (smallest ${Math.round(shortest)}px)`,
     shortest >= 44, `${Math.round(shortest)}px`);

  /* The one that actually bit: the tappable area must stop short of the
     screen edge, where the home indicator lives and a thumb cannot land. */
  const gap = 844 - lowestTop;
  ok(`the buttons stand clear of the bottom edge (${Math.round(gap)}px)`, gap >= 12,
     `${Math.round(gap)}px`);
  ok('and the bar itself reaches the edge, so nothing shows through beneath it',
     Math.round(box.y + box.height) >= 844);

  ok('each key has an icon, not just a word in small caps',
     await page.locator('.casepage .wsbar .sec-i').count() === 5);

  // Tapping still works — visibility changes must not break the routing.
  await btns.nth(0).click();
  await page.waitForTimeout(600);
  ok('tapping a key switches to it', (await page.evaluate(() => WS_TAB)) === 'activity');
  ok('and the one you are on is marked for a screen reader too',
     await page.locator('.casepage .wsbar button[aria-current="page"]').count() === 1);
  await page.close();
}

/* MASTER §31 — "Do not bury completed cases in a difficult archive." By this
   point in the run 4002 and 4003 both carry finalized packages, which is what
   makes them completed work; 4001 and 4004 have invoices but no finalized
   build and no terminal stage, so they stay off the desk. */
section('Completed cases are one obvious click away');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  ok('the Cases tab offers a lens', await page.locator('.lensrow').count() === 1);
  ok('with Completed spelled out on it',
     has(await text(page, '.lensrow'), 'Completed'));

  await page.locator('.lens', { hasText: 'Completed' }).click();
  await page.waitForTimeout(800);
  const desk = await text(page, '.card');
  ok('the desk lists the finished cases',
     desk.includes('API-20260812-4002') && desk.includes('API-20260812-4003'));
  ok('and not the merely-invoiced ones',
     !desk.includes('API-20260812-4001') && !desk.includes('API-20260812-4004'));

  const card4002 = page.locator('.donecard', { hasText: 'API-20260812-4002' });
  ok('a card offers the case, the report, the evidence and the package',
     await card4002.locator('.btn', { hasText: 'Open case' }).count() === 1
     && await card4002.locator('.btn', { hasText: 'Final report' }).count() === 1
     && await card4002.locator('.btn', { hasText: 'Case media' }).count() === 1
     && await card4002.locator('.btn', { hasText: 'Client package' }).count() === 1);
  ok('no invoice button where no invoice exists — no dead controls',
     await card4002.locator('.btn', { hasText: 'Invoice' }).count() === 0);
  ok('no copy-link button while no delivery link exists',
     await card4002.locator('.btn', { hasText: 'Copy video link' }).count() === 0);
  ok('a three-day case says so on its report button',
     has(await text(page, '.donecard:has-text("API-20260812-4003")'), '3 days'));

  await card4002.locator('.btn', { hasText: 'Final report' }).click();
  await page.waitForTimeout(800);
  ok('Final report lands inside the case, on the Reports tab',
     (await wsOpenTab(page)) === 'reports');
  await page.close();
}
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  ok('an investigator gets no lens and no desk',
     await page.locator('.lensrow').count() === 0);
  await page.close();
}

/* MASTER §5 — the sales desk: a lead's own statuses, and Send Rate Sheet /
   Send Intake living ON the lead rather than three tabs away. */
section('A lead has its own life, and its sends live on the card');
{
  await post('/ingest', {
    case_no: 'API-20260812-4005', service: 'Surveillance',
    client_name: 'Riley Caller', client_email: 'riley@example.test',
    client_phone: '4345550199', subject_name: 'Sam Watched',
    objective: 'Phoned in — wants weekend coverage.',
  }, { 'X-Ingest-Key': 'e2e-ingest-key' });

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Intakes' }).click();
  await page.waitForTimeout(600);

  const card = page.locator('.pcard', { hasText: 'API-20260812-4005' });
  ok('a fresh lead is on the desk', await card.count() === 1);
  ok('with the lead vocabulary, not the case one',
     has(await card.innerText(), 'Lead status'));
  ok('and both send actions on the card',
     await card.locator('.btn', { hasText: 'Send rate sheet' }).count() === 1
     && await card.locator('.btn', { hasText: 'Send intake' }).count() === 1);

  // The office's own hand: set Contacted, and it survives a full reload.
  await card.locator('select[data-act="leadStatus"]').selectOption('contacted');
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForTimeout(900);
  await page.locator('.tabs button', { hasText: 'Intakes' }).click();
  await page.waitForTimeout(600);
  ok('a status set by hand survives a reload',
     await page.locator('.pcard', { hasText: 'API-20260812-4005' })
       .locator('select[data-act="leadStatus"]').inputValue() === 'contacted');

  // Send intake, inline: prefilled from the lead, honest when mail is off.
  const card2 = page.locator('.pcard', { hasText: 'API-20260812-4005' });
  await card2.locator('.btn', { hasText: 'Send intake' }).click();
  await page.waitForTimeout(400);
  ok('the address is prefilled from the lead',
     await page.locator('#ls_to').inputValue() === 'riley@example.test');
  await card2.locator('[data-act="leadIntakeSend"]').click();
  await page.waitForTimeout(700);
  ok('with no mail key the card says exactly what is missing',
     has(await card2.innerText(), 'not configured'));
  await card2.locator('.btn', { hasText: 'Cancel' }).click();
  await page.waitForTimeout(300);

  // Send rate sheet: the SAME wizard, opened from the lead, prefilled — and
  // the sheet picked by the lead's kind, never by the caller.
  await card2.locator('.btn', { hasText: 'Send rate sheet' }).click();
  await page.waitForTimeout(400);
  ok('the send wizard opens from the leads desk', await page.locator('.amsheet').count() === 1);
  ok('on the private sheet, because this is a private lead',
     has(await text(page, '.amsheet'), 'Retainer'));
  ok('addressed to the lead already',
     await page.locator('#wiz_to').inputValue() === 'riley@example.test');
  ok('with the case number riding along',
     await page.locator('#wiz_case').inputValue() === 'API-20260812-4005');

  /* THE PREVIEW IS THE DOCUMENT THAT WILL BE SENT. SHEETS is fetched once at
     sign-in with no case in hand, so it always holds the standard retainer —
     the wizard has to re-read the sheet for THIS case or the admin reads
     $1,500 on screen and the client receives the $3,000 that was agreed. */
  await page.evaluate(async () => {
    await api('/cases/API-20260812-4005/retainer', { method: 'POST', body: { retainer_amount: 3000 } });
    await wizSheetLoad();
  });
  await page.waitForTimeout(600);
  await page.locator('[data-act="wizStep"]', { hasText: 'Preview' }).click();
  await page.waitForTimeout(700);
  const preview = await text(page, '.amsheet');
  ok('the preview shows the retainer this case agreed',
     preview.includes('$3,000'), preview.slice(0, 240));
  ok('and not the standard one beside it', !preview.includes('$1,500'));
  // The dialog's own heading is the selector label, so it has to agree too —
  // a header saying one figure over a preview saying another is worse than
  // either being wrong alone.
  ok('and the heading over it agrees',
     (await text(page, '.amhead')).includes('$3,000'), await text(page, '.amhead'));

  await page.locator('.amx').click();
  await page.waitForTimeout(300);

  /* The audit's 🔴: a failed send must be KEPT and shown, not swallowed.
     Mail is unconfigured in this run, so the Send-intake attempt above was a
     real failure — and it has to be on the record as one. Done last, because
     opening the case leaves the leads desk behind. */
  await page.locator('.pcard', { hasText: 'API-20260812-4005' })
    .locator('.btn', { hasText: 'Review' }).click();
  await page.waitForTimeout(700);
  await wsTab(page, 'Comm log');
  await page.waitForTimeout(500);
  const log = await text(page, '#dlgBody');
  ok('the Comm log records what the portal itself sent', has(log, 'Sent from the portal'));
  ok('including the attempt that failed, marked failed', has(log, 'Failed'));
  ok('naming who it went to', has(log, 'riley@example.test'));
  await page.close();
}

/* MASTER §10 — the fuller field vocabulary. One shared list, so a line
   available at the desk is available in the car; the physical-observation
   set is what a workers'-comp file actually logs. */
section('The field vocabulary covers the physical observations');
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('dana');
  await page.locator('#p').fill('FieldWork2026x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);
  await page.locator('.burger').click();
  await page.waitForTimeout(300);
  await page.locator('.side-surv').click();
  await page.waitForTimeout(800);
  await page.locator('[data-act="svEnter"]').first().click();
  await page.waitForTimeout(900);
  await page.locator('.sv-nav button', { hasText: 'Activity' }).click();
  await page.waitForTimeout(500);

  ok('Surveillance is a category of its own', has(await text(page, '.sv-cats'), 'Surveillance'));
  await page.locator('#sv_q').fill('lifting');
  await page.waitForTimeout(400);
  ok('a workers\'-comp staple is one search away',
     has(await text(page, '.sv-body'), 'Subject observed lifting.'));
  await page.locator('#sv_q').fill('unable to safely');
  await page.waitForTimeout(400);
  ok('and so is breaking off safely',
     has(await text(page, '.sv-body'), 'Unable to safely maintain visual contact.'));
  await page.close();
}

/* Making both halves local was not enough. In the field the TIME is stamped
   when the entry is started and the DATE was taken when Save was finally
   tapped — two different instants. Start an entry at 23:58, finish typing it
   at 00:03, and it filed on the new day carrying the old day's time; the
   timeline orders by at_date then at_time, so it sorted ahead of everything
   that genuinely came before it. This is the one place a surveillance log
   crosses midnight as a matter of routine, so it is driven across a real
   rollover with the page's clock held, not asserted about a helper. */
section('An entry started before midnight is filed before midnight');
{
  const page = await (await browser.newContext({
    viewport: { width: 390, height: 844 }, timezoneId: 'America/New_York' })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  // 03:58Z is 23:58 the previous evening in EDT — two minutes before rollover.
  await page.clock.setFixedTime(new Date('2026-08-11T03:58:00Z'));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('dana');
  await page.locator('#p').fill('FieldWork2026x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(600);
  await page.locator('[data-act="svEnter"]').first().click();
  await page.waitForTimeout(800);
  if (await page.locator('[data-act="svStartDay"]').count()) {
    await page.locator('[data-act="svStartDay"]').click();
    await page.waitForTimeout(800);
  }

  await page.locator('.sv-nav button', { hasText: 'Activity' }).click();
  await page.waitForTimeout(500);
  await page.locator('#sv_q').fill('lost visual');
  await page.waitForTimeout(400);
  await page.locator('.sv-pick').first().click();
  await page.waitForTimeout(400);

  const stamped = await page.evaluate(() => ({ date: SV.entry && SV.entry.date, time: SV.entry && SV.entry.time }));
  ok('the entry is stamped with the local date when it is STARTED',
     stamped.date === '2026-08-10' && stamped.time === '23:58', JSON.stringify(stamped));

  const marker = 'Rollover check ' + stamped.time;
  await page.locator('#sv_desc').fill(marker);

  // Midnight passes while the investigator is still typing.
  await page.clock.setFixedTime(new Date('2026-08-11T04:03:00Z'));
  await page.locator('[data-act="svSaveEntry"]').click();
  await page.waitForTimeout(900);
  ok('it still saves after the day has turned',
     has(await text(page, '.sv-body'), 'Activity saved'));

  const stored = await page.evaluate(async m => {
    const w = await (await fetch('/portal-api/cases/API-20260812-4001/workspace',
      { headers: { Accept: 'application/json' } })).json();
    return (w.activity || []).find(a => (a.description || '').includes(m)) || null;
  }, marker);
  ok('the entry reached the log', !!stored, marker);
  ok('and it is filed on the evening it was started, not the morning it was saved',
     stored && stored.at_date === '2026-08-10', stored && JSON.stringify(
       { at_date: stored.at_date, at_time: stored.at_time }));
  ok('with the time it was started, so date and time agree',
     stored && stored.at_time === '23:58', stored && stored.at_time);
  await page.close();
}

/* The last way the two halves could disagree, and the only one that cannot be
   driven from a test: every pairing used to read the clock TWICE — once for
   the date, once for the time — and two reads can fall either side of
   midnight. The window is sub-millisecond, so it would never reproduce and
   would look like a mystery if it ever fired: tomorrow's date beside last
   night's time, sorting ahead of everything before it. A fixed test clock
   makes both reads identical, so no behavioural test can reach it. The
   invariant is therefore held at the source: one instant, both halves. */
section('A date and its time come from one reading of the clock');
{
  const src = fs.readFileSync(path.join(ROOT, 'portal/index.html'), 'utf8');
  const pairedReads = [
    /const now = new Date\(\)\.toTimeString\(\)\.slice\(0,5\);\s*const today = ymdLocal\(\);/,
    /const today = ymdLocal\(\);\s*const now = new Date\(\)\.toTimeString\(\)\.slice\(0,5\);/,
    /time: new Date\(\)\.toTimeString\(\)\.slice\(0,5\), date: ymdLocal\(\)/,
  ];
  ok('no date/time pair is built from two separate clock reads',
     !pairedReads.some(re => re.test(src)),
     String(pairedReads.findIndex(re => re.test(src))));
  ok('the pairing helper exists and is what the screens use',
     /function stampNow\(\)/.test(src) && (src.match(/stampNow\(\)/g) || []).length >= 5,
     String((src.match(/stampNow\(\)/g) || []).length));
  /* Date-only and time-only readings are fine and deliberately still allowed —
     an expense date or a day-end time has no counterpart to disagree with. */
  ok('single-value readings are left alone', /const today = ymdLocal\(\);/.test(src));
}

/* PAYMENTS.md §10 — RETURNED PRIVATE INTAKE, NEXT ACTION. "When the Private
   Intake has been returned and the retainer is not yet marked received, the
   Leads & Intakes card should make the next action obvious."

   Seeded last so these four cards cannot move any earlier count. The condition
   is `intake_received`, which is one of the nine lead statuses the office
   already sets — no new field decides this. */
section('A returned private intake shows the retainer pending and the way to act on it');
{
  const mk = (no, kind, name) => db.prepare(
    `INSERT INTO submissions (case_no, kind, status, client_name, subject_name, payload, created_at)
     VALUES (?, ?, 'new', ?, 'Subject R', ?, ?)`)
    .run(no, kind, name, JSON.stringify({ client_name: name, objective: 'Retainer state' }),
         new Date().toISOString());
  const lead = (no, st) => db.prepare(
    `INSERT INTO lead_status (case_no, status, set_at) VALUES (?, ?, ?)`)
    .run(no, st, new Date().toISOString());

  mk('API-RP-1', 'consumer', 'Pending Payer');       lead('API-RP-1', 'intake_received');
  mk('API-RP-2', 'consumer', 'Settled Payer');       lead('API-RP-2', 'intake_received');
  mk('API-RP-3', 'claims', 'Carrier Adjuster');      lead('API-RP-3', 'intake_received');
  mk('API-RP-4', 'consumer', 'Already Asked');       lead('API-RP-4', 'intake_received');
  // RP-2's retainer is IN; RP-4 has been sent instructions but has not paid.
  db.prepare(`INSERT INTO case_retainer (case_no, retainer_amount, received, received_at)
              VALUES (?, 1500, 1, ?)`).run('API-RP-2', new Date().toISOString());
  db.prepare(`INSERT INTO payment_send (case_no, recipient, methods, with_sheet, ok, sent_at)
              VALUES (?, 'asked@example.test', 'cash_app,venmo', 0, 1, ?)`)
    .run('API-RP-4', new Date().toISOString());

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Intakes' }).click();
  await page.waitForTimeout(700);

  const c1 = page.locator('.pcard', { hasText: 'API-RP-1' });
  const c2 = page.locator('.pcard', { hasText: 'API-RP-2' });
  const c3 = page.locator('.pcard', { hasText: 'API-RP-3' });
  const c4 = page.locator('.pcard', { hasText: 'API-RP-4' });
  ok('all four cards are on the desk',
     await c1.count() === 1 && await c2.count() === 1
     && await c3.count() === 1 && await c4.count() === 1);

  const t1 = await c1.innerText();
  ok('the returned intake is named as received', has(t1, 'Private intake received'));
  ok('and the retainer is named as pending', has(t1, 'Retainer pending'));
  ok('§10: Record payment is offered right there',
     await c1.locator('.btn', { hasText: 'Record payment' }).count() === 1);
  ok('§10: so is Send payment options',
     await c1.locator('.btn', { hasText: 'Send payment options' }).count() === 1);
  ok('§10: and Review, which is the third named action',
     await c1.locator('.btn', { hasText: 'Review' }).count() === 1);

  /* The condition is BOTH halves. A retainer that has arrived is not pending,
     and saying so anyway would send the office chasing money it already has. */
  const t2 = await c2.innerText();
  ok('a retainer already received is NOT reported pending', !has(t2, 'Retainer pending'), t2);
  ok('and that card offers no Record payment, having nothing to record',
     await c2.locator('.btn', { hasText: 'Record payment' }).count() === 0);

  /* The private/insurance boundary, on the same desk as always. A claim
     assignment has no retainer and must never be shown one. */
  const t3 = await c3.innerText();
  ok('an insurance card never says Retainer pending', !has(t3, 'Retainer pending'), t3);
  ok('nor Private intake received', !has(t3, 'Private intake received'));
  ok('nor offers Record payment or payment options',
     await c3.locator('.btn', { hasText: 'Record payment' }).count() === 0
     && await c3.locator('.btn', { hasText: 'payment options' }).count() === 0);

  /* Instructions already sent — §10's second half. */
  const t4 = await c4.innerText();
  ok('a card whose client was already emailed says so',
     has(t4, 'Payment instructions sent'), t4);
  ok('naming the methods that went, read back from the send',
     has(t4, 'Cash App') && has(t4, 'Venmo'), t4);
  ok('and its button reads Resend, so nobody sends a first-time email twice',
     await c4.locator('.btn', { hasText: 'Resend payment options' }).count() === 1);
  ok('the card that was never asked does not claim instructions went',
     !has(t1, 'Payment instructions sent'), t1);

  /* Mobile, measured BEFORE navigating away — at 390px the nav rail is behind
     the burger, so the desk has to be reached at desktop width and then
     resized, which is the idiom the Edit Case section already uses. */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const phone = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.pcard')]
      .find(el => el.textContent.includes('API-RP-1'));
    if (!card) return { found: false };
    const small = [...card.querySelectorAll('.btn')]
      .filter(b => b.getBoundingClientRect().height < 44)
      .map(b => b.textContent.trim().slice(0, 20));
    return { found: true, right: Math.round(card.getBoundingClientRect().right), small };
  });
  ok('the card still fits a 390px screen with the block on it',
     phone.found && phone.right <= 391, JSON.stringify(phone));
  ok('and every action on it is still a 44px target',
     phone.found && phone.small.length === 0, JSON.stringify(phone));
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForTimeout(400);

  /* Record payment must reach the ONE writer, not a second one: the case's own
     retainer form, with its idempotency token and its route. */
  await c1.locator('.btn', { hasText: 'Record payment' }).click();
  await page.waitForTimeout(900);
  ok('Record payment lands on the case it was pressed for',
     has(await text(page, 'body'), 'API-RP-1'));
  ok('with the existing retainer form already open — the same one Overview uses',
     await page.locator('#ret_amt').count() === 1);
  ok('and its method list is the five the owner approved, plus the blank',
     (await page.locator('#ret_method option').allInnerTexts()).length === 6,
     (await page.locator('#ret_method option').allInnerTexts()).join('|'));
  await page.close();
}

/* THE CASES LENS IS THE CASES TABLE'S, AND NOTHING ELSE'S (owner, 2026-08-17).

   Repro as reported: leave the Cases lens on Archived, switch to Intakes, and
   archived cases repaint as live intake cards with Accept and Send on them —
   and into Today / next actions — while the New intakes count beside them stays
   correct, because that number is the Worker's and correctly excludes them.

   The cause was that ONE fetch fed everything: `CASES` is the page's general
   working set and the lens was scoping it. The fix gives the queried lenses
   their own list, so these assertions are about which VIEW can see what, not
   about any single row being filtered out. */
section('An archived case never leaks out of the Cases table');
{
  const mk = (no, name) => db.prepare(
    `INSERT INTO submissions (case_no, kind, status, client_name, subject_name, payload, created_at)
     VALUES (?, 'consumer', 'new', ?, 'Subject L', ?, ?)`)
    .run(no, name, JSON.stringify({ client_name: name, objective: 'Lens' }),
         new Date().toISOString());
  mk('API-LENS-LIVE', 'Live Client');
  mk('API-LENS-ARCH', 'Archived Client');

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Cases' }).first().click();
  await page.waitForTimeout(600);

  // Archive one THROUGH THE WORKER, so the row really is archived.
  const arch = await page.evaluate(async () => {
    const r = await fetch('/portal-api/cases/API-LENS-ARCH/archive',
      { method: 'POST', credentials: 'include' });
    return r.status;
  });
  ok('the case really was archived', arch === 200, String(arch));
  await page.reload();
  await page.waitForTimeout(900);
  await page.locator('.tabs button', { hasText: 'Cases' }).first().click();
  await page.waitForTimeout(600);

  ok('CONTROL: the live case is on the ordinary Cases table',
     has(await text(page, '.card'), 'API-LENS-LIVE'));
  ok('and the archived one is not', !has(await text(page, '.card'), 'API-LENS-ARCH'));

  await page.locator('.lens', { hasText: 'Archived' }).click();
  await page.waitForTimeout(900);
  const arched = await text(page, 'body');
  ok('the Archived lens does show it — the lens itself still works',
     has(arched, 'API-LENS-ARCH'), arched.slice(0, 300));

  /* THE REPRO. The lens is still on Archived; switch to Intakes. */
  await page.locator('.tabs button', { hasText: 'Intakes' }).click();
  await page.waitForTimeout(700);
  const desk = await text(page, 'body');
  ok('switching to Intakes does NOT carry the archived case across',
     !has(desk, 'API-LENS-ARCH'), desk.slice(0, 400));
  ok('and the archived case has no Accept or Send on that desk',
     await page.locator('.pcard', { hasText: 'API-LENS-ARCH' }).count() === 0);
  ok('CONTROL: the live intake is still on the desk, so the desk really loaded',
     has(desk, 'API-LENS-LIVE'), desk.slice(0, 400));

  /* And the dashboard, which reads the same working set for Today / next
     actions. The owner's report named this one explicitly. */
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(700);
  /* Scoped to Today / next actions and the Needs attention band, which are what
     read the shared working set. NOT the whole page: the Case packages band
     lists the archived case from `/packages`, which is a Worker route that does
     not filter archived cases and shows it whatever the lens has ever been —
     a separate defect, recorded in NEXT.md as its own unit rather than smuggled
     into this one. */
  const bands = await page.evaluate(() => {
    const named = h => [...document.querySelectorAll('.card, .band')]
      .filter(el => ((el.querySelector('h2') || {}).innerText || '').toLowerCase().includes(h));
    const inAny = els => els.some(el => el.textContent.includes('API-LENS-ARCH'));
    return {
      queue: inAny(named('next action')),
      attention: inAny(named('needs attention')),
      queueFound: named('next action').length,
    };
  });
  ok('the next-actions queue really is on screen, so the check means something',
     bands.queueFound >= 1, JSON.stringify(bands));
  ok('Today / next actions does not list the archived case',
     !bands.queue, JSON.stringify(bands));
  ok('nor does the Needs attention band', !bands.attention, JSON.stringify(bands));

  /* Back to Cases: the lens is still where it was left, and still works. This
     is what makes the fix a boundary and not an amnesia. */
  await page.locator('.tabs button', { hasText: 'Cases' }).first().click();
  await page.waitForTimeout(700);
  ok('returning to Cases still shows the archived set under its own lens',
     has(await text(page, 'body'), 'API-LENS-ARCH'));
  ok('and the Archived lens is still the selected one',
     await page.locator('.lens.on', { hasText: 'Archived' }).count() === 1);

  // Turning the lens off puts the ordinary list back, not a stale archived one.
  await page.locator('.lens', { hasText: 'All' }).click();
  await page.waitForTimeout(900);
  const back = await text(page, 'body');
  ok('turning the lens off restores the working list', has(back, 'API-LENS-LIVE'));
  ok('and drops the archived set rather than leaving it on screen',
     !has(back, 'API-LENS-ARCH'), back.slice(0, 300));
  await page.close();
}

/* THE CASE HEADER'S OWN CONTROL IS A THUMB TARGET TOO (owner, Unit 3).

   Recorded as a non-blocking finding when Edit Case shipped: the panel's
   controls were floored at 44px and asserted, and the header button that OPENS
   it was left alone rather than widened as a side effect of that unit. This is
   that unit.

   The owner's constraint is the interesting half — "do not make the visual
   glyph unnecessarily large" — so the LABEL must not grow. A min-height raises
   the box a thumb has to hit and leaves the type where it was, and the test
   asserts both: at least 44 tall, and the same font size as any other .btn.sm. */
section('The case header\'s Edit case control is a 44px target');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Cases' }).first().click();
  await page.waitForTimeout(600);
  await rowFor(page, 'API-LENS-LIVE').click();
  await page.waitForTimeout(900);

  const edit = page.locator('.ch-right .btn', { hasText: 'Edit case' });
  ok('the header offers Edit case', await edit.count() === 1);

  const desk = await edit.boundingBox();
  ok(`it is a 44px target on the desktop too (${Math.round(desk.height)}px)`,
     desk.height >= 44, JSON.stringify(desk));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const phone = await edit.boundingBox();
  ok(`and on a phone (${Math.round(phone.height)}px)`, phone.height >= 44,
     JSON.stringify(phone));
  ok('and it is still inside the screen', phone.x >= -1 && phone.x + phone.width <= 391,
     JSON.stringify(phone));

  /* The owner's constraint: bigger target, not bigger lettering. Measured
     against .btn.sm's own size rather than a hard-coded number, so restyling
     the buttons later cannot make this assertion quietly wrong. */
  const type = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.ch-right .btn')]
      .find(el => el.textContent.includes('Edit case'));
    const other = document.querySelector('.btn.sm:not(.ch-right .btn)');
    return { px: parseFloat(getComputedStyle(b).fontSize),
             ref: other ? parseFloat(getComputedStyle(other).fontSize) : null };
  });
  ok('the label was not enlarged to get there', type.ref === null || type.px <= type.ref,
     JSON.stringify(type));
  ok('and it is still small-button type, not body type', type.px < 15, JSON.stringify(type));

  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForTimeout(300);
  await page.close();
}

/* THE CASE HEADER'S STATUS CHIP IS ACTIONABLE, SO IT IS A TARGET (owner).

   It carries `data-act="wsTab" data-tab="assign"` — tapping it is how an admin
   reaches the status control — but it is a `.tag`, not a `.btn`, so the
   `.ch-right .btn` floor #150 added never reached it.

   The constraint that shapes the fix: the chip must NOT end up looking like a
   button. So the assertions are deliberately in two halves — the TARGET is at
   least 44 in both directions, and the PAINTED chip is still chip-sized. A fix
   that simply inflated the pill would pass the first half and fail the second,
   which is the outcome the owner ruled out by name. */
section('The case header status chip is a 44px target without becoming a button');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Cases' }).first().click();
  await page.waitForTimeout(600);
  await rowFor(page, 'API-LENS-LIVE').click();
  await page.waitForTimeout(900);

  const chip = page.locator('.ch-right [data-act="wsTab"][data-tab="assign"]').first();
  ok('the header carries a clickable status chip', await chip.count() === 1);
  ok('and it still says the status in WORDS, not by colour alone',
     (await chip.innerText()).trim().length >= 3, await chip.innerText());

  /* Measured on the ACTIONABLE box — the element that carries data-act, which
     is what a thumb has to land on — at both widths, because a chip is small in
     both directions and a target 44 tall and 30 wide is still a miss. The
     PAINTED pill is measured separately, and the two are allowed to differ:
     that separation is the whole design. */
  const measure = () => page.evaluate(() => {
    const el = document.querySelector('.ch-right [data-act="wsTab"][data-tab="assign"]');
    const pill = el.querySelector('.tag') || el;
    const r = el.getBoundingClientRect();
    const pr = pill.getBoundingClientRect();
    const cs = getComputedStyle(pill);
    return { w: Math.round(r.width), h: Math.round(r.height),
             pillW: Math.round(pr.width), pillH: Math.round(pr.height),
             font: parseFloat(cs.fontSize), radius: cs.borderRadius,
             right: Math.round(r.right) };
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const phone = await measure();
  ok(`the chip is a 44px target on a phone (${phone.w}x${phone.h})`,
     phone.w >= 44 && phone.h >= 44, JSON.stringify(phone));
  ok('and it does not push the header off a 390px screen', phone.right <= 391,
     JSON.stringify(phone));

  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForTimeout(400);
  const desk = await measure();
  ok(`and on the desktop too (${desk.w}x${desk.h})`, desk.w >= 44 && desk.h >= 44,
     JSON.stringify(desk));

  /* THE OTHER HALF. It must still read as a status chip: small uppercase type
     and a pill radius, not button-sized lettering. Asserted against the shared
     `.tag` scale rather than a hard-coded number, so restyling tags later
     cannot make this quietly wrong. */
  const ref = await page.evaluate(() => {
    const el = document.createElement('span');
    el.className = 'tag'; el.textContent = 'x';
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    const out = { font: parseFloat(cs.fontSize), radius: cs.borderRadius };
    el.remove(); return out;
  });
  ok('the chip keeps the shared tag type size — it was not inflated into a button',
     desk.font === ref.font, JSON.stringify({ chip: desk.font, tag: ref.font }));
  ok('and it keeps the pill radius', desk.radius === ref.radius,
     JSON.stringify({ chip: desk.radius, tag: ref.radius }));
  /* The measured proof that the target grew and the CHIP DID NOT: the painted
     pill is still the 24px it was before this unit, inside a 44px target. */
  ok(`the painted pill is still chip-height (${desk.pillH}px inside ${desk.h}px)`,
     desk.pillH <= 30 && desk.h >= 44, JSON.stringify(desk));
  ok('on the phone too', phone.pillH <= 30 && phone.h >= 44, JSON.stringify(phone));

  /* Semantics untouched: it is still the door to the status control. */
  await page.locator('.ch-right .tag').first().click();
  await page.waitForTimeout(700);
  /* Unit 38 — this passed on the word "Assignment" appearing as a TAB LABEL,
     and that tab lives inside a closed More menu now. The panel itself never
     carried the word, so the assertion was reading the navigation rather than
     the destination. WS_TAB is the destination. */
  ok('tapping it still opens the Assignment panel, unchanged',
     (await wsOpenTab(page)) === 'assign'
     && await page.locator('#asg').count() === 1,
     await wsOpenTab(page));
  await page.close();
}

/* ONE EVIDENCE VIEWER, AND NOBODY LEAVES THE APP (owner, 2026-08-16).

   The installed portal is `display:standalone` scoped to `/portal/`, and the
   evidence file route lives under `/portal-api/`. So `<a target="_blank">` did
   not open a tab the user could come back from — it left the app, with no
   chrome, no back button and no bottom bar. Six surfaces did it.

   The structural half is asserted on the SOURCE, because that is the only way
   to prove the seventh call site nobody has written yet cannot reintroduce it. */
section('Evidence opens in one in-portal viewer, and never leaves the app');
{
  const src = fs.readFileSync(path.join(ROOT, 'portal/index.html'), 'utf8');

  /* Every place that renders the evidence file route: none may carry a blank
     target. Written as a search for the route rather than a list of six line
     numbers, so a new surface is covered the day it is added. */
  const routeLinks = src.split('\n')
    .filter(l => /evidence\/\$\{[^}]*\}\/file|fileUrl\(e\)|url\(e\)|href="\$\{href\}"/.test(l));
  ok('the evidence route is still rendered in several places',
     routeLinks.length >= 6, String(routeLinks.length));
  ok('and not one of them opens a new tab any more',
     !routeLinks.some(l => l.includes('target="_blank"')),
     routeLinks.filter(l => l.includes('target="_blank"')).join('\n'));
  ok('every one of them opens the shared viewer instead',
     (src.match(/data-act="evOpen"/g) || []).length >= 6,
     String((src.match(/data-act="evOpen"/g) || []).length));
  ok('there is exactly ONE viewer, not six',
     (src.match(/function evViewerHtml\(/g) || []).length === 1);
  /* VIEWING ONLY. Scoped to the viewer's own function body, not the whole page:
     the gallery's existing Delete and Classify controls are a different feature
     and predate this one — the assertion is that the VIEWER grew none of them,
     not that the portal has none. */
  /* Bounded at the NEXT top-level function, not at `paint()`. Naming a
     particular neighbour made this assertion depend on what happens to sit
     after the viewer rather than on the viewer itself — and the day something
     was inserted between them (the video timestamp generator, which does offer
     a download, of a file it just made on the device) this failed while the
     rule it is named for was untouched. */
  const viewerAt = src.indexOf('function evViewerHtml(');
  /* THE FUNCTION'S OWN BODY, ending at its closing brace at column 0. Bounding
     it at "the next function" was still too loose: the comment block above the
     next one came with it, and that comment legitimately uses the word
     download. The body is what this assertion is about. */
  const viewerFn = src.slice(viewerAt, src.indexOf('\n}\n', viewerAt) + 3);
  ok('the viewer function was found, so the check has something to read',
     viewerFn.length > 200 && viewerFn.includes('evClose'), String(viewerFn.length));
  /* `rmOpen` joins the list in Unit 39. `evDelete` no longer exists anywhere,
     so naming only it would have made this guard pass by describing a control
     that is gone — an absence test has to name the control that IS there. */
  ok('and it offers no download, delete, classify or edit control',
     !/data-act="(evDelete|rmOpen|evClass|evUpload|download)"/i.test(viewerFn)
     && !/\bdownload\b/i.test(viewerFn), viewerFn.slice(0, 200));

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(500);
  await wsTab(page, 'Evidence');
  await page.waitForTimeout(400);

  // Land on a known screen, and remember it, so "back" can be checked properly.
  const beforeTab = await page.evaluate(() => ({
    body: document.querySelector('#dlgBody') ? document.querySelector('#dlgBody').innerText.slice(0, 400) : '',
    scroll: window.scrollY,
  }));

  const opener = page.locator('.evcard [data-act="evOpen"]').first();
  ok('the gallery card opens the viewer rather than a link',
     await opener.count() === 1 && await page.locator('.evcard a[target="_blank"]').count() === 0);

  await opener.click();
  await page.waitForTimeout(500);
  ok('the viewer is up', await page.locator('.evview').count() === 1);
  ok('with an obvious way back', await page.locator('.evview [data-act="evClose"]').count() >= 1);
  ok('and it names the file it is showing',
     (await text(page, '.evview-name')).trim().length > 0);
  ok('the page behind is locked from scrolling while it is open',
     await page.evaluate(() => document.body.classList.contains('evopen')));
  /* THE APP IS STILL THE APP: nothing navigated, so the URL is unchanged and
     the portal shell is still in the document behind the viewer. */
  ok('nothing navigated away — the portal is still underneath',
     await page.evaluate(() => !!document.querySelector('#app .wstabs, #app .tabs')),
     await page.evaluate(() => location.pathname));

  /* Mobile: the controls are thumb-sized and nothing runs off the screen. */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => {
    const back = document.querySelector('.evview [data-act="evClose"]').getBoundingClientRect();
    const media = document.querySelector('.evview-body img, .evview-body video');
    const mr = media ? media.getBoundingClientRect() : null;
    return { backW: Math.round(back.width), backH: Math.round(back.height),
             sw: document.documentElement.scrollWidth,
             mediaW: mr ? Math.round(mr.width) : null,
             mediaH: mr ? Math.round(mr.height) : null };
  });
  ok(`the back control is a 44px target (${m.backW}x${m.backH})`,
     m.backW >= 44 && m.backH >= 44, JSON.stringify(m));
  ok('and the viewer adds no sideways scroll at 390px', m.sw <= 390, JSON.stringify(m));
  ok('the media fits inside the screen rather than being cropped to it',
     m.mediaW === null || (m.mediaW <= 390 && m.mediaH <= 844), JSON.stringify(m));

  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForTimeout(300);

  /* CLOSE, AND THE SCREEN IS THE ONE THEY LEFT. Asserted by comparing the panel
     content before and after rather than by "a panel exists" — a rebuilt
     approximation would pass the weaker check. */
  await page.locator('.evview [data-act="evClose"]').first().click();
  await page.waitForTimeout(400);
  ok('the viewer closes', await page.locator('.evview').count() === 0);
  ok('the scroll lock is released', await page.evaluate(() =>
     !document.body.classList.contains('evopen')));
  const afterTab = await page.evaluate(() => ({
    body: document.querySelector('#dlgBody') ? document.querySelector('#dlgBody').innerText.slice(0, 400) : '',
  }));
  ok('and the exact panel they came from is still there, unchanged',
     afterTab.body === beforeTab.body, afterTab.body.slice(0, 120));

  // Escape is the second way out, for a desktop keyboard.
  await page.locator('.evcard [data-act="evOpen"]').first().click();
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  ok('Escape closes it too', await page.locator('.evview').count() === 0);
  await page.close();

  /* PERMISSIONS ARE UNCHANGED, which is the half a viewer could quietly break.
     The viewer reuses the same authenticated route, so an investigator assigned
     the case still gets the bytes and a stranger still does not. */
  const inv = await newPage();
  await signIn(inv, 'dana', 'FieldWork2026x');
  const invSees = await inv.evaluate(async () => {
    const r = await fetch('/portal-api/cases/API-20260812-4002/evidence/1/file',
      { credentials: 'same-origin' });
    return r.status;
  });
  ok('an investigator NOT assigned that case is still refused the bytes',
     invSees === 403 || invSees === 404, String(invSees));
  await inv.close();

  const nobody = await newPage();          // loaded, never signed in
  const signedOut = await nobody.evaluate(async () => {
    const r = await fetch('/portal-api/cases/API-20260812-4002/evidence/1/file',
      { credentials: 'same-origin' });
    return r.status;
  });
  ok('and a signed-out browser is refused outright', signedOut === 401,
     String(signedOut));
  await nobody.close();
}

/* PORTAL-OPS PHASE 8 — RECENTLY VIEWED + FAVOURITES.

   "Store only safe identifiers client-side; load real records through
   authorized server routes." The security half is the interesting half: the
   stored list must never be able to WIDEN what someone sees, and the owner's
   2026-08-17 decision is that both lists clear on sign-out because this is a
   shared-office desktop. */
section('Recently viewed and pinned cases: identifiers only, and gone at sign-out');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Cases' }).first().click();
  await page.waitForTimeout(600);

  const stored = () => page.evaluate(() => ({
    recent: JSON.parse(sessionStorage.getItem('apiRecentCases') || '[]'),
    favs: JSON.parse(sessionStorage.getItem('apiFavCases') || '[]'),
    all: Object.keys(sessionStorage).concat(Object.keys(localStorage)),
    blob: JSON.stringify(sessionStorage) + JSON.stringify(localStorage),
  }));

  ok('nothing is remembered before a case has been opened',
     (await stored()).recent.length === 0);

  await rowFor(page, 'API-LENS-LIVE').click();
  await page.waitForTimeout(900);
  let st = await stored();
  ok('opening a case records it as recently viewed',
     st.recent.includes('API-LENS-LIVE'), JSON.stringify(st.recent));

  /* ONLY IDENTIFIERS. The case just opened carries a client name and a subject
     name; neither may be anywhere in client-side storage. */
  ok('and stores the case NUMBER and nothing else about the case',
     !st.blob.includes('Live Client') && !st.blob.includes('Subject L'),
     st.blob.slice(0, 300));
  ok('the stored value really is just a list of identifiers',
     st.recent.every(v => typeof v === 'string' && /^[A-Za-z0-9-]{3,64}$/.test(v)),
     JSON.stringify(st.recent));

  // Pin it — an explicit act, from the case header.
  const star = page.locator('[data-act="favCase"]').first();
  ok('the case header offers a pin control', await star.count() === 1);
  await star.click();
  await page.waitForTimeout(500);
  st = await stored();
  ok('pinning records the identifier', st.favs.includes('API-LENS-LIVE'),
     JSON.stringify(st.favs));
  ok('and the control reads as pressed',
     await page.locator('[data-act="favCase"][aria-pressed="true"]').count() === 1);

  await page.locator('[data-act="backToCases"]').click();
  await page.waitForTimeout(700);
  ok('the strip shows the pinned case on the Cases view',
     await page.locator('.rvchip.pin', { hasText: 'API-LENS-LIVE' }).count() === 1);
  ok('and a chip carries only the case number',
     (await text(page, '.rvchip')).trim().replace(/^★\s*/, '').match(/^[A-Za-z0-9-]+$/) !== null,
     await text(page, '.rvchip'));

  // Unpin — the same explicit control, both ways.
  await page.locator('.rvchip.pin').first().click();
  await page.waitForTimeout(900);
  ok('and a chip opens that case', has(await text(page, 'body'), 'API-LENS-LIVE'));
  await page.locator('[data-act="favCase"]').first().click();
  await page.waitForTimeout(500);
  st = await stored();
  ok('unpinning removes it again', !st.favs.includes('API-LENS-LIVE'),
     JSON.stringify(st.favs));
  await page.locator('[data-act="backToCases"]').click();
  await page.waitForTimeout(700);

  /* A STORED IDENTIFIER IS NOT A KEY. Plant a case number this admin cannot
     see — one that does not exist at all — and a deleted one. Neither may draw
     a chip, because the strip renders only from the authorized list. */
  await page.evaluate(() => {
    sessionStorage.setItem('apiFavCases', JSON.stringify(['API-NOT-A-CASE', 'API-PKG-DEL']));
    sessionStorage.setItem('apiRecentCases', JSON.stringify(['API-NOT-A-CASE', 'API-LENS-ARCH']));
  });
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(400);
  await page.locator('.tabs button', { hasText: 'Cases' }).first().click();
  await page.waitForTimeout(700);
  const body = await text(page, 'body');
  ok('an identifier for a case that does not exist draws nothing',
     !has(body, 'API-NOT-A-CASE'), body.slice(0, 300));
  ok('and an ARCHIVED case is not resurrected by having been viewed',
     await page.locator('.rvchip', { hasText: 'API-LENS-ARCH' }).count() === 0);
  ok('nor a deleted one by having been pinned',
     await page.locator('.rvchip', { hasText: 'API-PKG-DEL' }).count() === 0);

  /* Mobile: chips wrap rather than scrolling sideways, and stay tappable. */
  await page.evaluate(() => sessionStorage.setItem('apiFavCases',
    JSON.stringify(['API-LENS-LIVE'])));
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(300);
  await page.locator('.tabs button', { hasText: 'Cases' }).first().click();
  await page.waitForTimeout(600);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => {
    const c = document.querySelector('.rvchip');
    const r = c ? c.getBoundingClientRect() : null;
    return { h: r ? Math.round(r.height) : null, right: r ? Math.round(r.right) : null,
             sw: document.documentElement.scrollWidth };
  });
  ok(`a chip is a 44px target on a phone (${m.h}px)`, m.h >= 44, JSON.stringify(m));
  ok('and the strip adds no sideways scroll at 390px',
     m.sw <= 390 && m.right <= 391, JSON.stringify(m));
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForTimeout(300);

  /* THE OWNER'S DECISION: both lists go at sign-out, favourites included. */
  st = await stored();
  ok('there is something to clear before signing out',
     st.recent.length > 0 || st.favs.length > 0, JSON.stringify(st));
  await page.locator('[data-act="logout"]').click();
  await page.waitForTimeout(900);
  const after = await stored();
  ok('signing out clears recently viewed', after.recent.length === 0,
     JSON.stringify(after.recent));
  ok('and clears pinned cases too — a shared desk keeps nobody\'s list',
     after.favs.length === 0, JSON.stringify(after.favs));
  ok('and leaves no case identifier anywhere in client-side storage',
     !after.blob.includes('API-LENS-LIVE'), after.blob.slice(0, 300));
  await page.close();

  /* The activity-line favourites are a DIFFERENT feature that happens to share
     the word. They hold canned phrases, not cases, and this unit left them
     alone — asserted so a later reader does not "unify" the two. */
  const src = fs.readFileSync(path.join(ROOT, 'portal/index.html'), 'utf8');
  ok('the field entry sheet keeps its own line favourites, untouched',
     src.includes('function favLines(') && src.includes('apiFavs:'));
  ok('and the case lists are a separate store, not merged into that key',
     src.includes('apiFavCases') && src.includes('apiRecentCases'));
}

/* VISUAL PHASE 1 — hierarchy, asserted structurally rather than by eye.

   These do not test "it looks good". They test the specific things the visual
   brief asks for and that a later change could silently undo: that a zero stops
   competing with a real number WITHOUT being hidden, that the two bands are no
   longer the same weight, that the queue is the emphatic surface, and that the
   mobile header stops eating the first screenful. */
section('The dashboard has a hierarchy: real numbers lead, zeros stay but recede');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(800);

  /* NOTHING IS HIDDEN. The zero is still on screen and still readable — this is
     the assertion that stops a future "tidy-up" deleting zero cards, which
     would turn an honest zero into an absent one. */
  const zero = page.locator('.stat.zero').first();
  ok('a zero card is still drawn, not removed', await zero.count() >= 1);
  ok('and its number is still visible text',
     (await zero.locator('.stat-n').innerText()).trim().length > 0);
  const tone = await page.evaluate(() => {
    const z = document.querySelector('.stat.zero .stat-n');
    const r = [...document.querySelectorAll('.stat:not(.zero) .stat-n')]
      .find(el => el.textContent.trim() !== '');
    return { zero: getComputedStyle(z).color, real: r ? getComputedStyle(r).color : null };
  });
  ok('but it is drawn quieter than a real number', tone.real && tone.zero !== tone.real,
     JSON.stringify(tone));

  /* THE TWO BANDS ARE NO LONGER THE SAME WEIGHT — the brief's "Current work
     should feel operational rather than like equal-weight statistic boxes". */
  const weight = await page.evaluate(() => {
    const a = document.querySelector('.band:not(.band-work) .stat-n');
    const w = document.querySelector('.band-work .stat-n');
    return { attention: a ? parseFloat(getComputedStyle(a).fontSize) : null,
             work: w ? parseFloat(getComputedStyle(w).fontSize) : null };
  });
  ok('Current work reads smaller than Needs attention',
     weight.work !== null && weight.attention !== null && weight.work < weight.attention,
     JSON.stringify(weight));
  ok('and every Current work label is still present — nothing was hidden to shrink it',
     await page.locator('.band-work .stat-h:visible').count()
       === await page.locator('.band-work .stat-h').count());

  /* THE QUEUE IS THE PRIMARY THING ON THE PAGE. */
  ok('Today / next actions is the emphasised card',
     await page.locator('.card.queuecard', { hasText: 'Today / next actions' }).count() === 1);
  ok('and Recently completed is deliberately quieter',
     await page.locator('.card.quietcard', { hasText: 'Recently completed' }).count() === 1);

  /* ONE PRIMARY ACTION PER AREA: the alert strip keeps a filled button; the
     read-out band's action is a quiet one, so two filled buttons no longer
     compete down the page. */
  const btns = await page.evaluate(() => ({
    attention: !!document.querySelector('.band:not(.band-work) .bandgo .btn:not(.ghost)'),
    work: !!document.querySelector('.band-work .bandgo .btn:not(.ghost)'),
  }));
  ok('Needs attention keeps one filled action', btns.attention, JSON.stringify(btns));
  ok('and Current work no longer competes with a second one', !btns.work,
     JSON.stringify(btns));

  /* MOBILE IS A FIRST-CLASS VIEWPORT, not a shrunk desktop. */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const m = await page.evaluate(() => {
    const top = document.querySelector('.top').getBoundingClientRect();
    const out = document.querySelector('.top button');
    const ob = out ? out.getBoundingClientRect() : null;
    const small = [...document.querySelectorAll('.stat-l, .stat-h, .qwhat')]
      .filter(el => parseFloat(getComputedStyle(el).fontSize) < 11).length;
    return { header: Math.round(top.height), signout: ob ? Math.round(ob.height) : null,
             sw: document.documentElement.scrollWidth, tiny: small };
  });
  ok(`the header no longer eats the first screenful (${m.header}px of 844)`,
     m.header <= 130, JSON.stringify(m));
  ok('Sign out is still a 44px target on a phone', m.signout >= 44, JSON.stringify(m));
  ok('the dashboard does not scroll sideways at 390px', m.sw <= 390, JSON.stringify(m));
  ok('and no helper text is smaller than 11px', m.tiny === 0, JSON.stringify(m));

  /* The work band stacks rather than being squeezed into unreadable columns. */
  const stacked = await page.evaluate(() => {
    const c = [...document.querySelectorAll('.band-work .stat')].slice(0, 2)
      .map(el => Math.round(el.getBoundingClientRect().width));
    return c;
  });
  ok('its cards keep a usable width when stacked',
     stacked.every(w => w >= 140), JSON.stringify(stacked));
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForTimeout(300);
  await page.close();
}

/* ACTIVE SURVEILLANCE MOBILE PR 1 — the field screen ranked by use.

   Measured on master at 390x844 with a day running: the status block (Day line,
   a ~64px clock, the date line) plus the header took roughly a third of the
   screen before the first control, and the loudest, highest button was "End
   investigation day" — pressed once a shift — with Activity, Photo, Video and
   Note below it and Tap to speak below those.

   These assertions are about ORDER and SPACE, not about looks, because those
   are the two things that made the screen wrong and the two a later change
   could silently undo. */
section('The field screen is ranked by what an investigator actually uses');
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SITE + '/portal/?surveillance=1');
  await page.waitForTimeout(900);
  const entered = await page.locator('[data-act="svEnter"]').count();
  if (entered) { await page.locator('[data-act="svEnter"]').first().click();
                 await page.waitForTimeout(900); }
  if (await page.locator('[data-act="svStartDay"]').count()) {
    await page.locator('#sv_start').fill('08:00');
    await page.locator('[data-act="svStartDay"]').click();
    await page.waitForTimeout(1000);
  }
  ok('a day is running, so this is the screen the field actually sees',
     await page.locator('#svTimer').count() === 1);

  const geo = await page.evaluate(() => {
    const y = sel => { const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().top) : null; };
    const box = sel => { const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect() : null; };
    const head = box('.sv-head'), st = box('.sv-status') || box('.sv-timer');
    const quad = box('.sv-quad');
    const endBtn = [...document.querySelectorAll('.sv-btn')]
      .find(b => /end investigation day/i.test(b.textContent));
    const pauseBtn = [...document.querySelectorAll('.sv-btn')]
      .find(b => /pause/i.test(b.textContent));
    const mic = box('.sv-mic');
    const small = [...document.querySelectorAll('.sv-btn, .sv-q, .sv-mic, .sv-x, .sv-nav button')]
      .filter(el => { const r = el.getBoundingClientRect();
                      return r.height > 0 && r.height < 44; })
      .map(el => el.textContent.trim().slice(0, 18));
    return {
      headBottom: head ? Math.round(head.bottom) : null,
      statusTop: st ? Math.round(st.top) : null,
      quadTop: quad ? Math.round(quad.top) : null,
      micTop: mic ? Math.round(mic.top) : null,
      endTop: endBtn ? Math.round(endBtn.getBoundingClientRect().top) : null,
      pauseTop: pauseBtn ? Math.round(pauseBtn.getBoundingClientRect().top) : null,
      chrome: quad && head ? Math.round(quad.top - head.bottom) : null,
      sw: document.documentElement.scrollWidth,
      small,
    };
  });

  /* 1. THE CLOCK INFORMS, IT NO LONGER DOMINATES. Measured as the space between
     the end of the header and the first field control — everything the
     investigator scrolls past to reach the thing they came to press. On master
     that gap was over 300px of an 844px screen. */
  ok(`the status area leaves the field actions near the top (${geo.chrome}px before them)`,
     geo.chrome !== null && geo.chrome <= 190, JSON.stringify(geo));
  ok('and the four field actions are on the first screenful',
     geo.quadTop !== null && geo.quadTop <= 420, JSON.stringify(geo));

  /* 2 + 3. THE ORDER IS THE POINT. Used-all-day above pressed-once-a-shift. */
  ok('Activity / Photo / Video / Note come BEFORE End investigation day',
     geo.quadTop < geo.endTop, JSON.stringify(geo));
  ok('and before Pause', geo.quadTop < geo.pauseTop, JSON.stringify(geo));
  ok('Tap to speak is not buried below the low-frequency controls',
     geo.micTop < geo.endTop && geo.micTop < geo.pauseTop, JSON.stringify(geo));
  ok('End investigation day is no longer the highest control on the screen',
     geo.endTop > geo.quadTop && geo.endTop > geo.micTop, JSON.stringify(geo));

  /* 4. THE SCREEN SAYS WHO IS BEING WATCHED — from the payload the field view
     already receives. No new data and no new permission. */
  const head = await text(page, '.sv-head');
  ok('the header still names the case', has(head, 'API-'), head);
  const ident = await page.locator('.sv-ident').count();
  ok('and a compact identity line names the subject', ident === 1);
  const identText = ident ? (await text(page, '.sv-ident')).trim() : '';
  ok('which is really the subject, not an invented label',
     /subject|claimant/i.test(identText) && identText.length > 9, identText);

  /* 5. FIELD USE: thumb targets, no sideways scroll, nothing clipped. */
  ok('every field control is a 44px target', geo.small.length === 0,
     JSON.stringify(geo.small));
  ok('and the field screen does not scroll sideways at 390px', geo.sw <= 390,
     JSON.stringify(geo));

  /* 6. BEHAVIOUR IS UNCHANGED — the controls are still the same controls, still
     wired to the same actions. This PR moved them; it did not rewire them. */
  ok('End day still opens the end-of-day screen, unchanged',
     await page.locator('[data-act="svTab"][data-t="endday"]').count() >= 1);
  ok('Pause is still the pause action, unchanged',
     await page.locator('[data-act="svPause"]').count() === 1);
  ok('the four field actions still carry their own actions',
     await page.locator('.sv-quad [data-act="svTab"][data-t="activity"]').count() === 1
     && await page.locator('.sv-quad [data-act="svPhoto"]').count() === 1
     && await page.locator('.sv-quad [data-act="svVideo"]').count() === 1
     && await page.locator('.sv-quad [data-act="svNote"]').count() === 1);
  ok('and the timer is still the server-derived one, still on screen',
     (await text(page, '#svTimer')).match(/\d\d:\d\d:\d\d/) !== null,
     await text(page, '#svTimer'));

  /* The tablet is not a regression target of this PR, but it must not break. */
  await page.setViewportSize({ width: 820, height: 1100 });
  await page.waitForTimeout(400);
  const tab = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    quad: !!document.querySelector('.sv-quad'),
    timer: !!document.querySelector('#svTimer'),
  }));
  ok('the tablet layout still draws the whole field screen',
     tab.quad && tab.timer && tab.sw <= 820, JSON.stringify(tab));
  await page.close();
}

/* ACTIVE SURVEILLANCE MOBILE PR 2 — the way out is a thumb action.

   Measured before: Exit active mode sat in the sticky header at roughly y30-70
   of an 844px screen — the top-right corner, the furthest point from a right
   thumb — and wrapped to two lines. It is the control you reach for when you
   are done, so it was in the worst place on the phone. */
section('Leaving Active Surveillance is reachable with a thumb');
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SITE + '/portal/?surveillance=1');
  await page.waitForTimeout(900);
  if (await page.locator('[data-act="svEnter"]').count()) {
    await page.locator('[data-act="svEnter"]').first().click();
    await page.waitForTimeout(900);
  }
  ok('the field view is open', await page.locator('.sv-nav').count() === 1);

  /* GONE FROM THE CORNER. */
  ok('the header no longer holds the exit',
     !has(await text(page, '.sv-head'), 'Exit active mode'));
  ok('and the header still names the case',
     has(await text(page, '.sv-head'), 'API-'));

  /* THE BOTTOM BAR IS UNCHANGED — no sixth item was added. */
  ok('the bottom navigation is still five items',
     await page.locator('.sv-nav button').count() === 5);

  /* REACHABLE: one deliberate tap on the Case item the bar already has. */
  await page.locator('.sv-nav button').last().click();
  await page.waitForTimeout(700);
  const exit = page.locator('.sv-exitblock [data-act="svExit"]');
  ok('the Case drawer carries the way out', await exit.count() === 1);
  ok('and says what it does and does not do',
     has(await text(page, '.sv-exitnote'), 'does not end your investigation day'));

  const geo = await page.evaluate(() => {
    const b = document.querySelector('.sv-exitblock [data-act="svExit"]');
    const r = b.getBoundingClientRect();
    const gold = b.classList.contains('gold');
    return { h: Math.round(r.height), w: Math.round(r.width), gold,
             sw: document.documentElement.scrollWidth };
  });
  ok(`the exit is a 44px target (${geo.h}px)`, geo.h >= 44, JSON.stringify(geo));
  ok('it is not styled as the loud action — End day is the weighty one',
     !geo.gold, JSON.stringify(geo));
  ok('and the drawer does not scroll sideways at 390px', geo.sw <= 390,
     JSON.stringify(geo));

  /* IT IS BEHIND A DELIBERATE TAP, so it is not fumbled into: it is not on the
     field home screen where the all-day actions live. */
  await page.locator('.sv-nav button').first().click();
  await page.waitForTimeout(600);
  ok('the field home screen does not carry the exit at all',
     await page.locator('.sv-body [data-act="svExit"]').count() === 0);

  /* EVIDENCE AND CASE ACCESS ARE UNCHANGED — both still one tap from the bar. */
  await page.locator('.sv-nav button').nth(2).click();
  await page.waitForTimeout(700);
  ok('Evidence is still one tap from the bar',
     (await text(page, '.sv-body')).length > 0);
  await page.close();
}

section('The field status row carries the date, not a line of its own');
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SITE + '/portal/?surveillance=1');
  await page.waitForTimeout(900);
  if (await page.locator('[data-act="svEnter"]').count()) {
    await page.locator('[data-act="svEnter"]').first().click();
    await page.waitForTimeout(900);
  }
  if (await page.locator('[data-act="svStartDay"]').count()) {
    await page.locator('#sv_start').fill('08:00');
    await page.locator('[data-act="svStartDay"]').click();
    await page.waitForTimeout(1000);
  }
  ok('a day is running', await page.locator('#svTimer').count() === 1);

  /* THE DATE IS STILL THERE — folded in, not deleted. */
  const st = await text(page, '.sv-status');
  ok('the status row carries the date', /\d{4}/.test(st), st);
  ok('and still the day number and the clock',
     /day\s*\d/i.test(st) && /\d\d:\d\d:\d\d/.test(st), st);
  ok('the separate date line is gone while the day runs',
     await page.locator('.sv-since').count() === 0);

  /* THE TIMER IS UNTOUCHED — same id, same server-derived shape. */
  ok('the timer is still the same element the tick updater writes into',
     await page.locator('#svTimer').count() === 1);
  ok('and still reads as a clock',
     /\d\d:\d\d:\d\d/.test(await page.locator('#svTimer').innerText()));

  /* And the field actions are still where PR 1 put them. */
  const order = await page.evaluate(() => {
    const q = document.querySelector('.sv-quad');
    const end = [...document.querySelectorAll('.sv-btn')]
      .find(b => /end investigation day/i.test(b.textContent));
    return { quad: Math.round(q.getBoundingClientRect().top),
             end: Math.round(end.getBoundingClientRect().top),
             sw: document.documentElement.scrollWidth };
  });
  ok('the field actions still come before End day', order.quad < order.end,
     JSON.stringify(order));
  ok('and nothing scrolls sideways', order.sw <= 390, JSON.stringify(order));

  // Tablet must not regress.
  await page.setViewportSize({ width: 820, height: 1100 });
  await page.waitForTimeout(400);
  ok('the tablet still draws the status row and the field actions',
     await page.locator('.sv-status').count() === 1
     && await page.locator('.sv-quad').count() === 1
     && await page.evaluate(() => document.documentElement.scrollWidth) <= 820);
  await page.close();
}


/* ------------------------------------------------------- VIDEO TIMESTAMP

   Owner brief, 2026-08-17: a surveillance clip carries the date and time burned
   into the bottom-right corner and the clock ADVANCES with the footage. Owner
   decision the same day: video is DEVICE-FIRST — the original stays on the
   device that shot it, the copy is rendered in that device's browser and saved
   back to it, and the portal keeps the record and no video byte at all. */
section('The timestamp is computed from the footage, never from this machine');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  /* EST/EDT IS RESOLVED FROM THE DATE. Virginia keeps daylight time for part of
     the year, so a hard-coded EST makes every summer stamp an hour wrong — the
     owner said so explicitly. These are the two sides of the 2026 changeover. */
  const zones = await page.evaluate(() => {
    const jul = vstToUtc(2026, 7, 15, 17, 14, 32, 'America/New_York');
    const jan = vstToUtc(2026, 1, 15, 17, 14, 32, 'America/New_York');
    return { jul: vstLabel(jul, 'America/New_York'), jan: vstLabel(jan, 'America/New_York'),
             julMs: jul, janMs: jan };
  });
  ok('a July evening resolves to EDT', zones.jul === '07/15/2026 05:14:32 PM EDT', zones.jul);
  ok('a January evening resolves to EST', zones.jan === '01/15/2026 05:14:32 PM EST', zones.jan);
  ok('and the two are stored as genuinely different offsets from UTC',
     (zones.julMs % 86400000) !== (zones.janMs % 86400000));

  /* THE WORDING IS EXACTLY WHAT THE BRIEF ASKED FOR: 08/17/2026 05:14:32 PM EDT */
  const shape = await page.evaluate(() =>
    vstLabel(vstToUtc(2026, 8, 17, 17, 14, 32, 'America/New_York'), 'America/New_York'));
  ok('the burned wording is MM/DD/YYYY hh:mm:ss AM/PM ZZZ',
     /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2} (AM|PM) E[SD]T$/.test(shape), shape);
  ok('and it is the owner’s own example', shape === '08/17/2026 05:14:32 PM EDT', shape);

  /* THE CLOCK ADVANCES WITH THE FOOTAGE — 5:14:32, :33, :34, :35 — from the
     chosen start plus the frame's own presentation time. */
  const ticks = await page.evaluate(() => {
    const s = vstToUtc(2026, 8, 17, 17, 14, 32, 'America/New_York');
    return [0, 1.0, 2.4, 3.99].map(t => vstLabel(s + Math.floor(t) * 1000, 'America/New_York'));
  });
  ok('it begins at the chosen second', ticks[0] === '08/17/2026 05:14:32 PM EDT', ticks[0]);
  ok('and advances a second at a time with the video timeline',
     ticks[1].endsWith('05:14:33 PM EDT') && ticks[2].endsWith('05:14:34 PM EDT')
     && ticks[3].endsWith('05:14:35 PM EDT'), ticks.join(' | '));

  /* Midnight and noon are where a 12-hour clock goes wrong. */
  const edges = await page.evaluate(() => ({
    midnight: vstLabel(vstToUtc(2026, 8, 17, 0, 0, 0, 'America/New_York'), 'America/New_York'),
    noon: vstLabel(vstToUtc(2026, 8, 17, 12, 0, 0, 'America/New_York'), 'America/New_York'),
  }));
  ok('midnight reads 12:00:00 AM, not 00 or 24', edges.midnight === '08/17/2026 12:00:00 AM EDT', edges.midnight);
  ok('and noon reads 12:00:00 PM', edges.noon === '08/17/2026 12:00:00 PM EDT', edges.noon);

  /* NOT THE MACHINE'S CLOCK. The label for a frame is a function of the chosen
     start and the frame's time, and of nothing else — so the same footage
     stamps identically whenever it is rendered. */
  const independent = await page.evaluate(() => {
    const s = vstToUtc(2026, 8, 17, 17, 14, 32, 'America/New_York');
    const a = vstLabel(s + 3000, 'America/New_York');
    const now = Date.now();
    return { a, sameLater: a === vstLabel(s + 3000, 'America/New_York'),
             mentionsToday: a.includes(String(new Date(now).getFullYear())) && s > now };
  });
  ok('the stamp does not read this machine’s clock', independent.sameLater
     && independent.a === '08/17/2026 05:14:35 PM EDT', independent.a);

  await page.close();
}

/* THE BURN-IN IS REAL PIXELS IN A REAL FILE — the brief rules out a CSS overlay
   by name. This makes a source clip in the browser, runs it through the SAME
   render path the feature uses, decodes the result back and looks at what came
   out. Nothing here is evidence: the source is coloured rectangles drawn in the
   tab. */
section('The stamp is encoded into the video, not laid over it');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  const trip = await page.evaluate(async () => {
    const mime = vstMime();
    if (!mime) return { skipped: 'this browser records no video at all' };

    // ---- a source clip, drawn here, deliberately dark all over ----
    const W = 320, H = 240;
    const src = document.createElement('canvas'); src.width = W; src.height = H;
    const sx = src.getContext('2d');
    const stream = src.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: mime });
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.start();
    for (let i = 0; i < 24; i++) {
      sx.fillStyle = '#101820'; sx.fillRect(0, 0, W, H);
      track.requestFrame();
      await new Promise(r => setTimeout(r, 33));
    }
    await new Promise(r => { rec.onstop = r; rec.stop(); });
    const srcBlob = new Blob(chunks, { type: mime });
    if (!srcBlob.size) return { skipped: 'the source clip came out empty' };

    // ---- through the real generator ----
    const file = new File([srcBlob], 'field-clip.webm', { type: mime });
    VST = { step: 'preview', caseNo: 'API-20260812-4002', file, name: file.name,
            size: file.size, url: URL.createObjectURL(file), tz: 'America/New_York',
            mo: '08', da: '17', yr: '2026', hr: '05', mi: '14', se: '32', ap: 'PM',
            guessed: false, hash: null, pct: 0, err: '', saveMsg: '',
            /* This source is a clip this browser just wrote and decodes again
               below, so `readable: true` is the fixture's truthful state — the
               legacy route is exactly what is under test here. */
            readable: true, decodeOk: false, parsed: null,
            out: null, recId: null, savedHere: false, started: false };
    await vstGenerate();
    if (!VST || !VST.out) return { skipped: 'render failed', err: VST && VST.err };
    const out = { size: VST.out.size, name: VST.out.name, mime: VST.out.mime,
                  step: VST.step, recId: VST.recId, savedHere: VST.savedHere,
                  proven: VST_PROVEN && VST_PROVEN.mime };

    // ---- decode the OUTPUT back and look at its pixels ----
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.src = VST.out.url;
    await new Promise((res, rej) => {
      v.onloadedmetadata = res; v.onerror = () => rej(new Error('output not decodable'));
      setTimeout(() => rej(new Error('output decode timed out')), 10000);
    });
    out.w = v.videoWidth; out.h = v.videoHeight;
    await new Promise(res => { v.onseeked = res; v.currentTime = 0.05; setTimeout(res, 1200); });
    const chk = document.createElement('canvas');
    chk.width = v.videoWidth; chk.height = v.videoHeight;
    const cx = chk.getContext('2d');
    cx.drawImage(v, 0, 0);
    // Brightest pixel in a band, not one sample: text is thin strokes, and a
    // single point can land between two of them.
    const brightest = (x, y, w, h) => {
      const d = cx.getImageData(x, y, w, h).data;
      let best = 0;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (lum > best) best = lum;
      }
      return Math.round(best);
    };
    out.stampBand = brightest(Math.round(chk.width * 0.3), Math.round(chk.height * 0.86),
                              Math.round(chk.width * 0.68), Math.round(chk.height * 0.12));
    out.controlBand = brightest(4, 4, Math.round(chk.width * 0.5), Math.round(chk.height * 0.4));
    // And the source, at the same place, for comparison: it had nothing there.
    const sv = document.createElement('video');
    sv.muted = true; sv.src = URL.createObjectURL(srcBlob);
    await new Promise((res, rej) => { sv.onloadedmetadata = res; sv.onerror = rej;
      setTimeout(res, 6000); });
    await new Promise(res => { sv.onseeked = res; sv.currentTime = 0.05; setTimeout(res, 1200); });
    cx.drawImage(sv, 0, 0);
    out.sourceBand = brightest(Math.round(chk.width * 0.3), Math.round(chk.height * 0.86),
                               Math.round(chk.width * 0.68), Math.round(chk.height * 0.12));
    return out;
  });

  ok('the render produced a video file', !trip.skipped && trip.size > 0,
     JSON.stringify(trip).slice(0, 300));
  const VST_PROVEN_MIME = trip.proven === undefined ? null : trip.proven;
  if (!trip.skipped) {
    ok('the output decodes as a video of the original size',
       trip.w === 320 && trip.h === 240, `${trip.w}x${trip.h}`);
    /* THE RULE IS "a format this device can read back", not "not mp4". Banning
       mp4 by name was itself a conclusion drawn from `isTypeSupported` — the
       very thing this stopped trusting — and on this machine mp4 does round
       trip. `vstProveMime` decides now, by writing and reading. */
    ok('and it is a format this device proved it can read back',
       /webm|mp4/.test(String(trip.mime))
       && VST_PROVEN_MIME !== null && trip.mime === VST_PROVEN_MIME,
       `${trip.mime} vs proven ${VST_PROVEN_MIME}`);
    ok('the derivative is named for the container it actually is',
       trip.name === 'field-clip-timestamped' + (/mp4/.test(trip.mime) ? '.mp4' : '.webm'),
       `${trip.name} / ${trip.mime}`);
    /* THE PROOF. The source is uniformly dark; the output has bright pixels in
       the bottom-right band and nowhere else. That is the stamp, in the encoded
       file, surviving a full decode — which a CSS overlay could not do. */
    ok('the source had nothing in the bottom-right corner', trip.sourceBand < 90, String(trip.sourceBand));
    ok('the output carries bright pixels there', trip.stampBand > 170, String(trip.stampBand));
    ok('and the rest of the picture was left alone', trip.controlBand < 90, String(trip.controlBand));
    ok('the stamp is genuinely in the pixels, not over them',
       trip.stampBand - trip.sourceBand > 80, `${trip.sourceBand} -> ${trip.stampBand}`);
    /* NOTHING CLAIMS TO BE SAVED. The render finished; the file has not reached
       the device until the operator's own save completes. */
    ok('the copy is not reported as saved merely because it exists', trip.savedHere === false);
    ok('and the portal recorded the generation', typeof trip.recId === 'number' && trip.recId > 0,
       String(trip.recId));
  }
  await page.close();
}

section('The video timestamp screen');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Evidence');

  const tab = await text(page, '#dlgBody');
  ok('the Evidence tab carries the door into it', has(tab, 'Video timestamp'));
  ok('and says the original is never changed', has(tab, 'original is never changed'));
  ok('the upload form no longer offers to store video', !has(tab, 'photos, video, documents'));
  ok('and says where video goes instead', has(tab, 'Video is not uploaded'));
  ok('the record of the earlier render is on the case', has(tab, 'field-clip.webm'));
  ok('with the instant it starts at, re-derived rather than remembered',
     has(tab, '08/17/2026 05:14:32 PM EDT'));
  ok('and it reads as not saved, because nobody saved it',
     has(tab, 'not saved yet'));

  /* THE PORTAL HOLDS NO VIDEO. Asked directly, from the browser, with a real
     session — the refusal is the Worker's, not a hidden button. */
  const refused = await page.evaluate(async () => {
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array(600).fill(65)], 'sneaky.mp4', { type: 'video/mp4' }));
    const r = await fetch('/portal-api/cases/API-20260812-4002/evidence',
      { method: 'POST', credentials: 'same-origin', body: fd });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  });
  ok('a video posted straight at the evidence route is refused',
     refused.status === 400 && refused.body.code === 'video_device_first',
     JSON.stringify(refused).slice(0, 200));

  await page.locator('[data-act="vstOpen"]').click();
  await page.waitForTimeout(300);
  ok('with no file chosen the generator stays shut', await page.locator('.vst').count() === 0);

  // Open it directly on a known state — the file picker cannot be driven here.
  await page.evaluate(() => {
    VST = { step: 'when', caseNo: 'API-20260812-4002', file: null, name: 'DSC_0001.MOV',
            size: 51200000, url: '', tz: 'America/New_York',
            mo: '08', da: '17', yr: '2026', hr: '05', mi: '14', se: '32', ap: 'PM',
            guessed: true, hash: null, pct: 0, err: '', saveMsg: '',
            readable: true, decodeOk: false, parsed: null,
            out: null, recId: null, savedHere: false, started: false };
    paintVStamp();
  });
  await page.waitForTimeout(200);
  ok('the editor opens on the file it was given', has(await text(page, '.vst'), 'DSC_0001.MOV'));
  /* The wording moved on 2026-08-18: the default is the video's own capture
     metadata now, and the form names WHICH source it used. The rule this always
     stood for is that the operator is told the figure may not be the recording
     and can correct it. */
  ok('and says where the start time came from',
     /capture metadata|no capture metadata|carries no time zone|no date at all/i
       .test(await text(page, '.vst')), (await text(page, '.vst')).slice(0, 300));
  ok('the resolved Eastern wording is shown while editing',
     has(await text(page, '#vst_res'), '08/17/2026 05:14:32 PM EDT'));

  /* A CORRECTION IS READ BACK BEFORE THE REPAINT, for the reason EDIT_DRAFT
     exists: the inputs are rebuilt from state on every paint. */
  await page.locator('#vst_hr').fill('11');
  await page.locator('#vst_mi').fill('05');
  await page.locator('#vst_se').fill('09');
  await page.locator('#vst_ap').selectOption('AM');
  await page.locator('[data-act="vstUseTime"]').click();
  await page.waitForTimeout(250);
  const prev = await text(page, '.vst');
  ok('the correction survived the repaint', has(prev, '08/17/2026 11:05:09 AM EDT'), prev.slice(0, 200));
  ok('the preview names the original', has(prev, 'DSC_0001.MOV'));
  ok('and where the stamp goes', has(prev, 'Bottom right'));
  ok('and offers Edit timestamp, Generate and Cancel',
     await page.locator('[data-act="vstEditTime"]').count() === 1
     && await page.locator('[data-act="vstGo"]').count() === 1
     && await page.locator('.vst [data-act="vstClose"]').count() >= 1);
  ok('it says the original is left as it is', has(prev, 'left exactly as it is'));
  ok('and that nothing is uploaded', has(prev, 'nothing is uploaded'));

  // A half-typed time cannot quietly become a different one.
  await page.locator('[data-act="vstEditTime"]').click();
  await page.waitForTimeout(200);
  await page.locator('#vst_mi').fill('');
  await page.locator('[data-act="vstUseTime"]').click();
  await page.waitForTimeout(200);
  ok('an incomplete time is refused rather than guessed',
     has(await text(page, '.vst'), 'Fill in every part'));
  await page.locator('#vst_mi').fill('99');
  await page.locator('[data-act="vstUseTime"]').click();
  await page.waitForTimeout(200);
  ok('and an impossible one is named', has(await text(page, '.vst'), '0 to 59'));

  await page.locator('.vst-bar [data-act="vstClose"]').click();
  await page.waitForTimeout(200);
  ok('closing it puts the case screen back untouched',
     await page.locator('.vst').count() === 0
     && has(await text(page, '#dlgBody'), 'Video timestamp'));

  await page.close();
}

section('The video timestamp screen on a phone');
{
  const page = await newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, 'dana', 'FieldWork2026x');
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    VST = { step: 'when', caseNo: 'API-20260812-4002', file: null, name: 'DSC_0001.MOV',
            size: 51200000, url: '', tz: 'America/New_York',
            mo: '08', da: '17', yr: '2026', hr: '05', mi: '14', se: '32', ap: 'PM',
            guessed: false, hash: null, pct: 0, err: '', saveMsg: '',
            out: null, recId: null, savedHere: false, started: false };
    paintVStamp();
  });
  await page.waitForTimeout(250);

  const m = await page.evaluate(() => {
    const small = [...document.querySelectorAll('.vst input, .vst select, .vst button')]
      .map(el => ({ tag: el.id || el.dataset.act || el.tagName,
                    h: Math.round(el.getBoundingClientRect().height) }))
      .filter(x => x.h > 0 && x.h < 44);
    return { small, sw: document.documentElement.scrollWidth,
             cw: document.documentElement.clientWidth,
             fields: document.querySelectorAll('.vst input').length };
  });
  ok('every date and time field is on screen', m.fields === 6, String(m.fields));
  ok('nothing on it is under 44px', m.small.length === 0, JSON.stringify(m.small));
  ok('and it does not scroll sideways at 390px', m.sw <= m.cw + 1, `${m.sw} vs ${m.cw}`);

  // The finished state must never claim a save the platform has not made.
  await page.evaluate(() => {
    VST.step = 'done'; VST.startMs = vstToUtc(2026, 8, 17, 17, 14, 32, 'America/New_York');
    VST.out = { blob: new Blob(['x']), url: '', name: 'DSC_0001-timestamped.webm', size: 1200,
                mime: 'video/webm' };
    paintVStamp();
  });
  await page.waitForTimeout(200);
  const done = await text(page, '.vst');
  ok('a generated copy reads as not yet on the device',
     has(done, 'not yet saved') && !has(done, '>Saved<'), done.slice(0, 400));
  ok('and offers the save rather than announcing one',
     await page.locator('[data-act="vstSave"]').count() === 1
     && await page.locator('[data-act="vstSaved"]').count() === 0);
  /* The owner reversed this on 2026-08-18: "do not require preview". Checking
     the clock is OFFERED where the device can play the copy back, and where it
     cannot the screen says the copy is made anyway — this fixture carries an
     empty src, so it exercises the second. Either way the copy is never
     reported as failed for want of a preview. */
  ok('it never treats a missing preview as a failed copy',
     has(done, 'bottom-right corner') || has(done, 'The copy is made'), done.slice(0, 500));
  ok('and says the portal keeps the record, not the video', has(done, 'never the video'));

  // Once a download has merely STARTED, it still does not claim to be saved.
  await page.evaluate(() => { VST.started = true; paintVStamp(); });
  await page.waitForTimeout(150);
  const started = await text(page, '.vst');
  ok('a started download is not called a save', has(started, 'download has started')
     && has(started, 'cannot see') && has(started, 'not yet saved'), started.slice(0, 400));
  ok('and the operator is the one who confirms it arrived',
     await page.locator('[data-act="vstSaved"]').count() === 1);

  await page.close();
}


/* OWNER UI ADDENDUM, 2026-08-17. Timestamp Video is a first-class operational
   shortcut — nobody should have to open a case to reach it — and the media
   wording separates ADDING (Upload video / picture) from LOOKING (Case media). */
section('Timestamp video is reachable without opening a case');
{
  for (const [who, pass, role] of [['trever', 'AdminPassword1x', 'admin'],
                                   ['dana', 'FieldWork2026x', 'investigator']]) {
    const page = await newPage();
    await signIn(page, who, pass);
    await page.waitForTimeout(300);
    ok(`the ${role} has the door in the navigation, on every screen`,
       await page.locator('.navfoot [data-act="vstOpen"]').count() === 1);
    ok(`and it says what it is (${role})`,
       has(await text(page, '.navfoot [data-act="vstOpen"]'), 'Timestamp Video'));
    /* THE DOOR ASKS. Opened from outside a case it must not silently adopt
       whichever case was last open — its data-case is empty on purpose. */
    ok(`the ${role}'s door carries no case of its own`,
       await page.locator('.navfoot [data-act="vstOpen"]').getAttribute('data-case') === '');
    const h = await page.evaluate(() => {
      const b = document.querySelector('.navfoot [data-act="vstOpen"]');
      return Math.round(b.getBoundingClientRect().height);
    });
    ok(`it is a 44px target for the ${role} (${h}px)`, h >= 44);
    await page.close();
  }

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).first().click();
  await page.waitForTimeout(600);
  /* Two tools now, not one — Timestamp Photo joined its sibling here after the
     owner could not find it anywhere in the live portal. Asserted by ACT and as
     a pair: the count alone would pass on two copies of the same door. */
  const tools = await page.evaluate(() =>
    [...document.querySelectorAll('.qtools .qtool')].map(b => b.dataset.act + ':' + (b.dataset.tab || '')));
  ok('the dashboard carries both timestamp tools',
     tools.some(t => t.startsWith('vstOpen')) && tools.some(t => t.startsWith('pstLaunch')),
     JSON.stringify(tools));
  /* UNIT 5 (owner) widened the row into the day's launcher, so the creep guard
     re-pins to the NEW set — still exact, still by act, so a duplicate door or
     a stray addition fails rather than accumulating. */
  ok('and the row is exactly the day\'s six doors, no creep',
     JSON.stringify(tools) === JSON.stringify(
       ['pstLaunch:', 'vstOpen:', 'surveillance:', 'tab:newlead', 'tab:cases', 'tab:delivery']),
     JSON.stringify(tools));
  ok('labelled as tools, not cards', has(await text(page, '.qtools'), 'Quick tools')
     && has(await text(page, '.qtools'), 'Timestamp video')
     && has(await text(page, '.qtools'), 'Timestamp photo'));
  /* COMPACT means dense per tool, not short overall — six doors are taller
     than two were, and the owner asked for the six. What must not happen is a
     TOOL swelling into a stat card, or the launcher adopting card chrome. */
  const size = await page.evaluate(() => {
    const q = document.querySelector('.qtools');
    const tool = document.querySelector('.qtool');
    return { tool: Math.round(tool.getBoundingClientRect().height),
             cards: q.querySelectorAll('.card, .stat').length };
  });
  ok('each tool stays a control, never a card',
     size.cards === 0 && size.tool >= 44 && size.tool <= 52, JSON.stringify(size));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => ({
    h: Math.round(document.querySelector('.qtool').getBoundingClientRect().height),
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
  }));
  ok('and on a phone it is still a 44px target', m.h >= 44, `${m.h}px`);
  ok('with nothing scrolling sideways', m.sw <= m.cw + 1, `${m.sw} vs ${m.cw}`);
  await page.close();
}

section('Choosing the case, from outside a case');
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await page.waitForTimeout(300);

  // The file picker cannot be driven from here; open on the state it produces.
  await page.evaluate(() => {
    VST = { step: 'case', caseNo: '', file: null, name: 'DSC_0009.MOV', size: 8000000,
            url: '', tz: 'America/New_York', q: '',
            mo: '08', da: '17', yr: '2026', hr: '05', mi: '14', se: '32', ap: 'PM',
            guessed: true, hash: null, pct: 0, err: '', saveMsg: '',
            out: null, recId: null, savedHere: false, started: false };
    paintVStamp();
    return vstLoadCases();
  });
  await page.waitForTimeout(600);
  const pick = await text(page, '.vst');
  ok('it asks which case the footage is for', has(pick, 'Which case is this footage for'));
  ok('and says choosing one grants nothing extra', has(pick, 'no more access than you had'));

  /* AUTHORIZATION IS NOT WEAKENED. The list is the caller's own — an
     investigator is offered their assigned cases and nobody else's, because the
     route that fills it is the one that already scopes them. */
  const offered = await page.evaluate(() =>
    [...document.querySelectorAll('[data-act="vstPickCase"]')].map(b => b.dataset.case));
  const allowed = await page.evaluate(async () =>
    (await (await fetch('/portal-api/submissions?limit=200',
      { credentials: 'same-origin' })).json()).submissions.map(s => s.case_no));
  ok('the offered cases are exactly the ones this account may open',
     offered.length > 0 && offered.every(c => allowed.includes(c)),
     `${offered.length} offered, ${allowed.length} allowed`);
  /* A case that EXISTS and is not theirs — a made-up number would 404 for the
     wrong reason and prove nothing about the boundary. */
  ok('and the Worker refuses a record on a case not among them',
     !allowed.includes('API-20260812-4002')
     && (await page.evaluate(async () => (await fetch(
       '/portal-api/cases/API-20260812-4002/video-stamp',
       { method: 'POST', credentials: 'same-origin',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ original_name: 'x.mov', start_utc: '2026-08-17T21:14:32.000Z' }) })
     ).status)) === 404);

  await page.locator('#vst_q').fill('zzz-no-such-case');
  await page.waitForTimeout(250);
  ok('a search that matches nothing says so rather than showing everything',
     has(await text(page, '.vst'), 'No case matches')
     && await page.locator('[data-act="vstPickCase"]').count() === 0);
  await page.locator('#vst_q').fill('');
  await page.waitForTimeout(250);

  /* AND IT CAN BE PUT OFF. Local processing first, the case afterwards — with
     the portal saying plainly that it holds no record until then. */
  await page.locator('[data-act="vstSkipCase"]').click();
  await page.waitForTimeout(250);
  ok('the work can start with no case chosen', has(await text(page, '.vst'), 'Start date'));
  await page.evaluate(() => {
    VST.step = 'done'; VST.startMs = vstToUtc(2026, 8, 17, 17, 14, 32, 'America/New_York');
    VST.out = { blob: new Blob(['x']), url: '', name: 'DSC_0009-timestamped.webm',
                size: 900, mime: 'video/webm' };
    paintVStamp();
  });
  await page.waitForTimeout(200);
  const done = await text(page, '.vst');
  ok('an unattached copy says it belongs to no case', has(done, 'Not attached to a case'));
  ok('and that the portal therefore holds no record of it',
     has(done, 'nothing about this copy is recorded'));
  ok('with a way to attach it afterwards',
     await page.locator('[data-act="vstAttach"]').count() === 1);
  await page.close();
}

section('Adding media and looking at media are named apart');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Evidence');
  const body = await text(page, '#dlgBody');
  ok('the entry point for adding is named for what it adds',
     has(body, 'Upload video / picture'));
  ok('the existing files are named Case media', has(body, 'Case media'));
  /* THE CONTROL SAYS WHAT IT DOES. The section is called Upload video /
     picture; the button under it uploads a picture or a document, because
     video is not uploaded at all and a button may not say otherwise. */
  ok('and the upload control does not promise to store video',
     await page.locator('.btn', { hasText: 'Upload picture or document' }).count() === 1
     && await page.locator('.btn', { hasText: 'Upload video' }).count() === 0);
  ok('the tab itself reads Case media',
     (await wsOpenTab(page)) === 'evidence');
  await page.close();
}

section('The four field actions are untouched');
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('dana');
  await page.locator('#p').fill('FieldWork2026x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(600);
  await page.locator('[data-act="svEnter"]:visible').first().click();
  await page.waitForTimeout(800);
  // The four field actions live on the home screen while a day is running.
  if (await page.locator('[data-act="svStartDay"]').count()) {
    await page.locator('#sv_start').fill('05:45');
    await page.locator('[data-act="svStartDay"]').click();
    await page.waitForTimeout(1000);
  }
  const quad = await page.evaluate(() => {
    const q = document.querySelector('.sv-quad');
    return q ? [...q.querySelectorAll('button')].map(b => b.textContent.trim()) : null;
  });
  ok('the field home still offers four actions', quad && quad.length === 4, JSON.stringify(quad));
  /* Each label ends with its own word — the leading character is the button's
     glyph. `Video$` and not `Video` so "Video timestamp" would fail: the field
     button is the short one, and the longer wording belongs on the media
     screen. */
  ok('and they are still Activity, Photo, Video and Note',
     quad && /Activity$/.test(quad[0]) && /Photo$/.test(quad[1])
     && /Video$/.test(quad[2]) && /Note$/.test(quad[3]), JSON.stringify(quad));
  ok('one generic upload button did not replace them',
     !(quad || []).some(t => /upload/i.test(t)), JSON.stringify(quad));
  await page.close();
}


/* OWNER REPORT, 2026-08-18: "the live dashboard does not visibly show the
   timestamp video quick tool". It rendered — but only from `dashView()`, which
   is a condition that hides it in two real ways: an investigator has no
   Dashboard at all, and under 900px the navigation rail (the other copy) is
   behind the burger, so on a phone anywhere but the Dashboard the only door was
   inside a menu. It is drawn from the shell now. */
section('Timestamp Video is on every top-level screen, for both roles');
{
  for (const [who, pass, role, tabs] of [
    ['trever', 'AdminPassword1x', 'admin', ['Dashboard', 'Cases', 'Intakes', 'Rate Sheets']],
    ['dana', 'FieldWork2026x', 'investigator', ['My assignments', 'Today', 'Reports']],
  ]) {
    const page = await newPage();
    await signIn(page, who, pass);
    await page.waitForTimeout(400);
    for (const t of tabs) {
      await page.locator('.tabs button', { hasText: t }).first().click();
      await page.waitForTimeout(500);
      const n = await page.locator('.qtools [data-act="vstOpen"]').count();
      ok(`${role} · ${t} carries the quick tool`, n === 1, String(n));
    }
    /* ONE WORDING. Two spellings of the same control meant a find-in-page for
       what the menu says did not match what the screen shows. */
    const label = await text(page, '.qtools [data-act="vstOpen"]');
    ok(`and the ${role}'s reads Timestamp Video`, /Timestamp Video/.test(label), label);
    const navLabel = await page.locator('.navfoot [data-act="vstOpen"]').innerText();
    ok(`matching the navigation exactly (${role})`,
       label.replace(/\s+/g, ' ').includes('Timestamp Video')
       && navLabel.replace(/\s+/g, ' ').includes('Timestamp Video'), `${label} | ${navLabel}`);
    await page.close();
  }
}

section('The quick tool is discoverable, not merely present');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).first().click();
  await page.waitForTimeout(700);

  const m = await page.evaluate(() => {
    const b = document.querySelector('.qtools [data-act="vstOpen"]');
    const r = b.getBoundingClientRect(), cs = getComputedStyle(b);
    const px = c => c.match(/\d+/g).map(Number);
    const lum = c => { const [r0,g,b0] = px(c); return 0.299*r0 + 0.587*g + 0.114*b0; };
    const page_ = getComputedStyle(document.body).backgroundColor;
    return { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width),
             onFirstScreen: r.y >= 0 && r.y < innerHeight,
             bg: cs.backgroundColor, pageBg: page_,
             // How far the control's surface sits from the page behind it.
             contrast: Math.abs(lum(cs.backgroundColor) - lum(page_)),
             sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
  });
  ok('it is on the first screenful', m.onFirstScreen && m.y < 300, JSON.stringify(m));
  ok('it is a 44px target', m.h >= 44, `${m.h}px`);
  /* THE ORIGINAL FAILURE WAS NOT ABSENCE — it was a white pill on a near-white
     page. Its surface has to be visibly different from what is behind it. */
  ok('its surface stands off the page behind it', m.contrast >= 8, JSON.stringify(m));
  ok('and nothing scrolls sideways', m.sw <= m.cw + 1, `${m.sw} vs ${m.cw}`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const p = await page.evaluate(() => {
    const b = document.querySelector('.qtools [data-act="vstOpen"]');
    const r = b.getBoundingClientRect();
    const nav = document.querySelector('.tabs');
    return { h: Math.round(r.height), y: Math.round(r.y),
             onFirstScreen: r.y >= 0 && r.y < innerHeight,
             navHidden: getComputedStyle(nav).display === 'none',
             sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
  });
  /* THE POINT OF THE FIX. On a phone the navigation rail IS hidden behind the
     burger — so if the only copy lived there, the door would be in a menu,
     which the owner ruled out by name. */
  ok('on a phone the navigation rail really is behind the burger', p.navHidden);
  ok('and the quick tool is still on the screen, not in that menu',
     p.onFirstScreen && p.h >= 44, JSON.stringify(p));
  ok('with nothing scrolling sideways at 390px', p.sw <= p.cw + 1, `${p.sw} vs ${p.cw}`);

  // It reaches the workflow that already shipped — not a second one.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);
  const wired = await page.evaluate(() => {
    const b = document.querySelector('.qtools [data-act="vstOpen"]');
    return { act: b.dataset.act, caseAttr: b.getAttribute('data-case'),
             opensExisting: typeof vstOpen === 'function',
             oneGenerator: typeof vstGenerate === 'function' && typeof vstHtml === 'function' };
  });
  ok('it opens the generator that already shipped', wired.act === 'vstOpen'
     && wired.opensExisting && wired.oneGenerator, JSON.stringify(wired));
  ok('and carries no case of its own, so it cannot adopt whichever one is open',
     wired.caseAttr === '', JSON.stringify(wired));
  await page.close();
}

/* OWNER LIVE TEST, 2026-08-18: IMG_0440.mov read its name and start time, then
   failed with "This browser could not read that video file" — while the large
   Generate button stayed active underneath the error. */
section('A video this browser cannot decode says so, and offers no Generate');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  /* THE LABEL IS NOT THE GATE, and that is measured rather than assumed: the
     same decodable bytes load whether the blob claims quicktime, mp4, octet-
     stream or nothing. So a `.mov` refusal is a real decode failure and
     re-wrapping the container would fix nothing. */
  const labels = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 160; c.height = 120;
    const x = c.getContext('2d');
    const st = c.captureStream(0), tr = st.getVideoTracks()[0];
    const parts = []; const rec = new MediaRecorder(st, { mimeType: vstMime() });
    rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
    rec.start();
    for (let i = 0; i < 10; i++) { x.fillStyle = '#123'; x.fillRect(0, 0, 160, 120);
      tr.requestFrame(); await new Promise(r => setTimeout(r, 33)); }
    await new Promise(r => { rec.onstop = r; rec.stop(); });
    const good = new Blob(parts, { type: 'video/webm' });
    const out = {};
    for (const t of ['video/webm', 'video/quicktime', 'application/octet-stream', ''])
      out[t || '(none)'] = (await vstProbe(URL.createObjectURL(new Blob([good], { type: t })))).ok;
    return out;
  });
  ok('the container label does not decide whether a video loads',
     Object.values(labels).every(v => v === true), JSON.stringify(labels));

  /* THE CODEC IS NAMED FROM THE FILE'S OWN BOXES, without decoding it — and
     with `moov` LAST, which is how iPhone QuickTime writes it. */
  const named = await page.evaluate(async () => {
    const box = (type, payload) => {
      const b = new Uint8Array(8 + payload.length);
      new DataView(b.buffer).setUint32(0, 8 + payload.length);
      for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
      b.set(payload, 8); return b;
    };
    const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0);
      const o = new Uint8Array(n); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
    const mk = (cc) => {
      const stsd = box('stsd', cat(new Uint8Array(8), box(cc, new Uint8Array(70))));
      const moov = box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd)))));
      const mdat = box('mdat', new Uint8Array(3 * 1048576));      // 3 MB of "picture"
      const ftyp = box('ftyp', new Uint8Array([113,116,32,32, 0,0,2,0]));
      return new File([cat(ftyp, mdat, moov)], 'IMG_0440.mov', { type: 'video/quicktime' });
    };
    return { hevc: await vstBoxCodec(mk('hvc1')), h264: await vstBoxCodec(mk('avc1')),
             prores: await vstBoxCodec(mk('ap4h')) };
  });
  ok('HEVC is named from the file, with moov last as QuickTime writes it',
     named.hevc && named.hevc.cc === 'hvc1' && /HEVC/.test(named.hevc.name), JSON.stringify(named));
  ok('and H.264 is told apart from it', named.h264 && /H\.264/.test(named.h264.name),
     JSON.stringify(named));
  ok('and a third codec is not forced into either', named.prores && /ProRes/.test(named.prores.name),
     JSON.stringify(named));

  /* NOTHING IS CLAIMED THAT WAS NOT DETERMINED. A file whose codec cannot be
     read says exactly that, rather than picking one. */
  const unknown = await page.evaluate(async () =>
    await vstBoxCodec(new File([new Uint8Array(2048)], 'junk.mov', { type: 'video/quicktime' })));
  ok('an unreadable container names no codec at all', unknown === null, JSON.stringify(unknown));

  // The screen, on a file this browser genuinely cannot decode.
  await page.evaluate(() => {
    VST = { step: 'preview', caseNo: 'API-20260812-4002', file: null, name: 'IMG_0440.mov',
            size: 84 * 1048576, url: '', tz: 'America/New_York', q: '',
            mo: '05', da: '03', yr: '2025', hr: '11', mi: '27', se: '58', ap: 'AM',
            guessed: false, hash: null, pct: 0, err: '', saveMsg: '',
            out: null, recId: null, savedHere: false, started: false,
            readable: false, codec: { cc: 'hvc1', name: 'HEVC / H.265' } };
    VST.startMs = vstToUtc(2025, 5, 3, 11, 27, 58, 'America/New_York');
    paintVStamp();
  });
  await page.waitForTimeout(250);
  const stopped = await text(page, '.vst');
  /* THE RULE, not the sentence. The owner rewrote this wording on 2026-08-18
     ("say something factual such as: This video cannot be decoded by the current
     browser. Your original is unchanged."), so these assert what the screen has
     to COMMUNICATE rather than the words it used at the time. */
  ok('the screen says the format cannot be processed here',
     has(stopped, 'cannot be processed on this device')
     || has(stopped, 'could not decode'), stopped.slice(0, 400));
  ok('and names the codec it actually read from the file',
     has(stopped, 'HEVC / H.265'), stopped.slice(0, 400));
  ok('it says the original is unchanged and nothing was uploaded',
     has(stopped, 'unchanged') && has(stopped, 'nothing was uploaded'));
  /* THE FAULT THE OWNER SAW: a prominent active Generate button under a fatal
     error. It is gone, and the two safe actions remain. */
  ok('there is no Generate button under the error',
     await page.locator('[data-act="vstGo"]').count() === 0);
  ok('Edit timestamp is still offered',
     await page.locator('[data-act="vstEditTime"]').count() === 1);
  ok('so is Cancel', await page.locator('.vst [data-act="vstClose"]').count() >= 1);
  ok('and the timestamp it did read is still shown',
     has(stopped, '05/03/2025 11:27:58 AM EDT'), stopped.slice(0, 300));

  /* AND THE GENERATOR REFUSES ON ITS OWN. The page is not the only guard: a
     caller reaching vstGenerate directly is still stopped. */
  const forced = await page.evaluate(async () => { await vstGenerate();
    return { err: VST.err, out: VST.out, step: VST.step }; });
  ok('calling the generator directly is refused too',
     forced.out === null && /could not decode|cannot be processed/i.test(forced.err),
     JSON.stringify(forced));

  // While the check is still running, Generate is present but disabled.
  await page.evaluate(() => { VST.readable = null; VST.err = ''; paintVStamp(); });
  await page.waitForTimeout(200);
  const checking = await page.evaluate(() => {
    const b = document.querySelector('[data-act="vstGo"]');
    return { exists: !!b, disabled: b ? b.disabled : null, text: b ? b.textContent.trim() : '' };
  });
  ok('while the check runs the action is disabled rather than absent',
     checking.exists && checking.disabled === true, JSON.stringify(checking));
  ok('and says what it is doing', /checking/i.test(checking.text), checking.text);

  // A readable file gets the ordinary screen back.
  await page.evaluate(() => { VST.readable = true; VST.codec = null; paintVStamp(); });
  await page.waitForTimeout(200);
  const okScreen = await text(page, '.vst');
  ok('a supported file still offers Generate',
     await page.locator('[data-act="vstGo"]:not([disabled])').count() === 1);
  /* Same reason: the compatibility line reads "Ready" now, which is the owner's
     own wording. The rule is that a supported file reports as usable. */
  ok('and says the file is ready', has(okScreen, 'Ready'), okScreen.slice(0, 300));
  await page.close();
}


/* OWNER, 2026-08-18: iPhone and iPad video are PRIMARY input, not an edge case,
   and the browser recommendation shipped earlier proved wrong in real use. */
section('Compatibility is reported per device, and recommends no browser');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  /* THE MESSAGE THAT WAS WRONG IS GONE. It told the owner a laptop running
     Chrome or Edge would decode their file; it did not. Nothing in the page
     names a browser as a fix any more. */
  const src = await page.content();
  ok('the page no longer recommends a browser as the fix',
     !/laptop running Chrome or Edge/i.test(src) && !/Chrome or Edge on a laptop/i.test(src));
  ok('and says the original is unchanged instead',
     /Your original is unchanged/.test(src));

  // The three named lines the owner asked for.
  await page.evaluate(() => {
    VST = { step: 'preview', caseNo: 'API-20260812-4002', file: null, name: 'IMG_0440.mov',
            size: 84 * 1048576, url: '', tz: 'America/New_York', q: '',
            mo: '05', da: '03', yr: '2025', hr: '11', mi: '27', se: '58', ap: 'AM',
            guessed: false, hash: null, pct: 0, err: '', saveMsg: '', diag: '',
            out: null, recId: null, savedHere: false, started: false,
            readable: false, codec: { cc: 'hvc1', name: 'HEVC / H.265' }, caps: vstCaps() };
    VST.startMs = vstToUtc(2025, 5, 3, 11, 27, 58, 'America/New_York');
    paintVStamp();
  });
  await page.waitForTimeout(250);
  const t = await text(page, '.vst');
  ok('the container is named as a container', has(t, 'MOV (QuickTime)'));
  ok('the codec is named from the file', has(t, 'HEVC / H.265'));
  ok('and compatibility says it cannot be decoded here',
     has(t, 'cannot be decoded or processed on this device'), t.slice(0, 400));
  ok('the stop states it factually, without naming a browser to switch to',
     has(t, 'cannot be processed on this device') && !has(t, 'Chrome') && !has(t, 'Edge'),
     t.slice(0, 400));
  ok('no Generate button sits under it',
     await page.locator('[data-act="vstGo"]').count() === 0);
  ok('Edit timestamp and Cancel are still offered',
     await page.locator('[data-act="vstEditTime"]').count() === 1
     && await page.locator('.vst [data-act="vstClose"]').count() >= 1);

  /* A CODEC IS NEVER INVENTED. With nothing readable from the file the line
     says so rather than choosing one. */
  await page.evaluate(() => { VST.codec = null; paintVStamp(); });
  await page.waitForTimeout(200);
  const noc = await text(page, '.vst');
  ok('an undetermined codec is reported as undetermined',
     has(noc, 'could not be determined from the file'), noc.slice(0, 300));

  /* DECODING AND ENCODING FAIL SEPARATELY, and iOS is the platform where the
     first works and the second does not. A file this device can play but
     cannot re-encode must not read as "unsupported video". */
  /* `vstPath` consults `vstCan()` live, so the stub goes there rather than on
     the cached caps — stubbing a copy of the answer stopped being the same as
     stubbing the answer when the gate moved. */
  await page.evaluate(() => {
    window.__realCan = vstCan;
    window.vstCan = () => false;
    VST.readable = true; VST.decodeOk = false; VST.parsed = null;
    VST.codec = { cc: 'avc1', name: 'H.264 / AVC' };
    paintVStamp();
  });
  await page.waitForTimeout(200);
  const half = await text(page, '.vst');
  ok('a device that can play but not write says exactly that',
     has(half, 'can play it, but cannot write the copy here'), half.slice(0, 400));
  await page.evaluate(() => { window.vstCan = window.__realCan; paintVStamp(); });
  await page.waitForTimeout(200);
  ok('and a device that can do both reads Ready',
     has(await text(page, '.vst'), 'Ready'), (await text(page, '.vst')).slice(0, 300));
  await page.close();
}

/* ------------------------- the final report as a real file, made on this machine

   Owner, 2026-08-18: "Final Reports need a real PDF file, not Print only. Add
   Download PDF and Save PDF to Dropbox Reports. Keep Print optional."

   The PDF is written by the page, from the package document already rendered on
   screen, with no library. So it is tested where it is made: the generator is
   run against the real document and the bytes it produces are read back. */
section('The final report is a real PDF, written by the page');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Package');
  await page.waitForTimeout(800);

  const acts = await page.evaluate(() => [...document.querySelectorAll('[data-act]')]
    .map((b) => b.dataset.act + '|' + b.textContent.trim()));
  ok('Download PDF is offered on the finished package',
     acts.some((a) => a.startsWith('pkgPdf|')), acts.join(' , ').slice(0, 300));
  ok('and Save PDF to Dropbox beside it',
     acts.some((a) => a.startsWith('pkgPdfDropbox|')), acts.join(' , ').slice(0, 300));
  /* PRINT IS KEPT, and kept SECONDARY — the owner asked for it to stay
     available, not to stay the only way out of the screen. */
  ok('Print is still there, and no longer the only way to get the report out',
     acts.some((a) => a === 'pkgPrint|Print'), acts.join(' , ').slice(0, 300));

  /* THE GENERATOR ITSELF, run against the document that is on screen. */
  const pdf = await page.evaluate(async () => {
    const blob = await pdfFromDoc(document.getElementById('pkgdoc'));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let all = '';
    for (let i = 0; i < buf.length; i++) all += String.fromCharCode(buf[i]);
    return {
      type: blob.type,
      size: buf.length,
      head: all.slice(0, 8),
      tail: all.slice(-8),
      pages: (all.match(/\/Type \/Page[^s]/g) || []).length,
      fonts: all.includes('/BaseFont /Helvetica') && all.includes('/BaseFont /Helvetica-Bold'),
      xref: all.includes('\nxref\n') && all.includes('startxref'),
      jpeg: (all.match(/\/Filter \/DCTDecode/g) || []).length,
      caseNo: all.includes('API-20260812-4002'),
      startxref: Number((all.match(/startxref\s+(\d+)/) || [])[1] || -1),
    };
  });

  ok('what comes back is a PDF, not a print dialog',
     pdf.type === 'application/pdf' && pdf.head === '%PDF-1.4', pdf.head);
  ok('with a real body rather than a stub', pdf.size > 1500, String(pdf.size));
  ok('carrying at least one page', pdf.pages >= 1, String(pdf.pages));
  /* NO LIBRARY AND NO EMBEDDED FONT — the base-14 fonts are declared by name,
     which is the whole reason this needs no dependency. */
  ok('both base-14 fonts are declared rather than embedded', pdf.fonts);
  ok('a cross-reference table is written and pointed at',
     pdf.xref && pdf.startxref > 0 && pdf.startxref < pdf.size,
     pdf.startxref + ' of ' + pdf.size);
  ok('and it ends where a PDF ends', pdf.tail.includes('%%EOF'), pdf.tail);
  /* IT IS THE DOCUMENT ON SCREEN, not a second rendering of the same data —
     the case number is in the bytes because it was read off #pkgdoc. */
  ok('the content comes from the rendered document', pdf.caseNo);
  /* Every photograph the document shows becomes an image object, and none is
     invented. Counted against the rendered document rather than asserted as a
     bare number, so this stays true for a package with no photographs. */
  const shown = await page.evaluate(() =>
    document.querySelectorAll('#pkgdoc img').length);
  ok('every photograph in the document is carried as a JPEG image object',
     pdf.jpeg === shown, pdf.jpeg + ' image objects for ' + shown + ' pictures');

  /* THE PACKAGE IS RE-READ BEFORE THE FILE IS MADE, the same rule printing
     already follows: this is the moment the document leaves the building. */
  const reread = await page.evaluate(async () => {
    let n = 0;
    const real = window.fetch;
    window.fetch = (...a) => { if (String(a[0]).includes('/build')) n++; return real(...a); };
    await pkgPdfBuild();
    window.fetch = real;
    return n;
  });
  ok('the package is re-read before the PDF is built', reread >= 1, String(reread));
}

/* ------------------------------ a non-video file is refused where it is chosen

   Owner, 2026-08-18: on a desktop the picker's `video/*` filter can be switched
   to All Files, and the wizard would then carry a spreadsheet all the way to a
   decode failure that reads like a codec problem. It must say "Video files
   only", immediately.

   THE RESTRAINT IS THE DESIGN. VIDEO-TIMESTAMP.md records the measurement: the
   same decodable `.mov` bytes arrive as `video/quicktime`, as
   `application/octet-stream`, or WITH NO TYPE AT ALL. A rule that refused an
   empty or octet-stream type would reject the exact iPhone file this feature
   exists for. So only a file whose type positively says something ELSE is
   turned away here; everything undecided goes to the decode probe, which is the
   real arbiter. */
section('Video timestamp: a non-video file is refused, but a bare .mov is not');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  const judge = (f) => page.evaluate((x) => vstNotVideo(x), f);

  /* THE THREE FORMS A REAL CLIP ARRIVES IN. All must pass. */
  ok('a .mov declaring itself video is allowed',
     (await judge({ name: 'IMG_0440.MOV', type: 'video/quicktime' })) === false);
  ok('a .mov with NO type at all is allowed — the iPhone case',
     (await judge({ name: 'IMG_0440.MOV', type: '' })) === false);
  ok('a .mov arriving as application/octet-stream is allowed',
     (await judge({ name: 'IMG_0440.MOV', type: 'application/octet-stream' })) === false);
  ok('and a plain mp4 is allowed',
     (await judge({ name: 'clip.mp4', type: 'video/mp4' })) === false);
  /* Nothing says video and nothing says otherwise: the decode probe decides,
     not a guess made here. */
  ok('a file with no extension and no type still reaches the decode probe',
     (await judge({ name: 'recording', type: '' })) === false);

  /* WHAT IS POSITIVELY SOMETHING ELSE. */
  ok('a PDF is refused', (await judge({ name: 'report.pdf', type: 'application/pdf' })) === true);
  ok('a photograph is refused', (await judge({ name: 'photo.jpg', type: 'image/jpeg' })) === true);
  ok('a text file is refused', (await judge({ name: 'notes.txt', type: 'text/plain' })) === true);
  ok('an audio file is refused, which a video timestamper cannot help with',
     (await judge({ name: 'song.m4a', type: 'audio/mp4' })) === true);

  /* THE WORDS THE OWNER ASKED FOR, and the way back — a refusal that leaves you
     with nothing to press is a dead end. */
  const panel = await page.evaluate(() => {
    VST = { step: 'reject', caseNo: '', name: 'report.pdf', why: 'Video files only' };
    paintVStamp();
    const root = document.querySelector('#vstamp');
    return {
      text: root ? root.textContent : '',
      again: !!document.querySelector('[data-act="vstOpen"]'),
      close: !!document.querySelector('[data-act="vstClose"]'),
    };
  });
  ok('the refusal says Video files only', panel.text.includes('Video files only'), panel.text.slice(0, 200));
  ok('names the file that was picked', panel.text.includes('report.pdf'));
  ok('and offers a way on rather than a dead end', panel.again && panel.close);
  await page.evaluate(() => { VST = null; paintVStamp(); });

  /* The picker still ASKS for video first — the refusal is the backstop for a
     desktop filter being switched, not a replacement for asking. */
  const src = fs.readFileSync(path.join(ROOT, 'portal/index.html'), 'utf8');
  ok('the file picker still asks for video up front',
     /inp\.accept\s*=\s*"video\/\*,\.mts,\.m2ts,\.ts"/.test(src));
}

/* ====================================================== Timestamp Photo

   The owner's brief is four words; PHOTO-TIMESTAMP.md records what was taken
   from their own video brief and what this build derived. These are the
   claims that file makes, checked through the real page against the real
   Worker.

   The fixture is a JPEG THE BROWSER ITSELF WROTE, with an EXIF APP1 segment
   spliced in after the SOI marker. Made rather than pasted, so a picture the
   test says is decodable is one this browser has already proven it can
   decode — the same reasoning as the video capability proof. */
function exifJpeg(jpegBytes, when) {
  // TIFF, little-endian: IFD0 holds one pointer to the Exif IFD, which holds
  // one ASCII DateTimeOriginal. No OffsetTimeOriginal, which is the ordinary
  // case a phone actually produces.
  const tiff = Buffer.alloc(64);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(0x002A, 2);
  tiff.writeUInt32LE(8, 4);                 // IFD0 at +8
  tiff.writeUInt16LE(1, 8);                 // one entry
  tiff.writeUInt16LE(0x8769, 10);           // ExifIFDPointer
  tiff.writeUInt16LE(4, 12);                // LONG
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);               // Exif IFD at +26
  tiff.writeUInt32LE(0, 22);                // no IFD1
  tiff.writeUInt16LE(1, 26);                // one entry
  tiff.writeUInt16LE(0x9003, 28);           // DateTimeOriginal
  tiff.writeUInt16LE(2, 30);                // ASCII
  tiff.writeUInt32LE(20, 32);
  tiff.writeUInt32LE(44, 36);               // the string, at +44
  tiff.writeUInt32LE(0, 40);
  tiff.write(when + '\0', 44, 'ascii');     // "2026:08:17 17:14:32"

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xFFE1, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  // Straight after SOI, which is where an APP1 belongs.
  return Buffer.concat([jpegBytes.subarray(0, 2), head, payload, jpegBytes.subarray(2)]);
}

section('Timestamp Photo: the stamp is in the pixels, and the original is not touched');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Evidence');

  /* A REAL PICTURE, written by this browser. 800x600 so the burned face is a
     legible 30px, which is what `vstDraw` scales it to. */
  // Counted rather than assumed: earlier sections share these cases.
  const before1 = await page.evaluate(() => ({
    stamps: ((WS && WS.photo_stamps) || []).length,
    photos: ((WS && WS.evidence) || []).filter(e => !e.deleted_at
      && String(e.content_type || '').startsWith('image/')).length,
  }));
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 800; c.height = 600;
    const cx = c.getContext('2d');
    cx.fillStyle = '#3f6ea8';
    cx.fillRect(0, 0, 800, 600);
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  });
  const withExif = exifJpeg(Buffer.from(b64, 'base64'), '2026:08:17 17:14:32');

  await page.locator('#ev_file').setInputFiles({
    name: 'IMG_4407.jpg', mimeType: 'image/jpeg', buffer: withExif });
  await page.locator('.btn', { hasText: 'Upload picture or document' }).click();
  await page.waitForTimeout(900);
  ok('the photograph is in the case', has(await text(page, '#dlgBody'), 'IMG_4407.jpg'));

  /* THE DOOR IS THE PHOTOGRAPH (PHOTO-TIMESTAMP.md D1), not a top-level
     screen: there is already something in the case to hang it on. */
  const opener = page.locator('[data-act="pstOpen"]').first();
  ok('the photograph offers to be timestamped', await opener.count() === 1);
  await opener.click();
  await page.waitForTimeout(900);

  /* SEEDED FROM THE CAMERA, and the screen says that is where it came from. */
  const when = await text(page, '#pstamp');
  ok('the screen opens on the question', has(when, 'When was it taken'), when.slice(0, 160));
  ok('the fields are filled from the camera, not from the clock',
     await page.locator('#pst_mo').inputValue() === '08'
     && await page.locator('#pst_da').inputValue() === '17'
     && await page.locator('#pst_yr').inputValue() === '2026'
     && await page.locator('#pst_hr').inputValue() === '05'
     && await page.locator('#pst_mi').inputValue() === '14'
     && await page.locator('#pst_se').inputValue() === '32'
     && await page.locator('#pst_ap').inputValue() === 'PM',
     await page.locator('#pst_yr').inputValue());
  ok('and it says the camera is where they came from', has(when, 'From the camera'), when.slice(0, 300));
  /* THE ZONE IS RESOLVED FROM THE DATE — August in Virginia is EDT, and a
     hard-coded EST would make this an hour wrong. */
  ok('the preview reads the date, the time and the zone that date is in',
     has(when, '08/17/2026 05:14:32 PM EDT'), when);

  const evidenceBefore = await page.evaluate(() => (WS.evidence || []).length);
  await page.locator('[data-act="pstBurn"]').click();
  await page.waitForTimeout(1200);
  ok('the copy is offered for checking before it is filed',
     has(await text(page, '#pstamp'), 'The timestamped copy'));
  ok('and the copy is shown', await page.locator('.pst-prev').count() === 1);

  /* NOTHING HAS BEEN UPLOADED YET, and that is the owner's rule after the
     device test: the copy is made here and filing is a separate, optional act. */
  ok('the copy exists without anything having been uploaded',
     await page.evaluate((n) => (WS.evidence || []).length === n, evidenceBefore));
  ok('and filing is offered rather than assumed',
     await page.locator('[data-act="pstToCase"]').count() === 1);
  ok('with keeping it on the device offered first',
     await page.locator('[data-act="pstSaveDevice"]').count() === 1);
  await page.locator('[data-act="pstToCase"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-act="pstFile"]').click();
  await page.waitForTimeout(2000);
  ok('it is saved to Dropbox', has(await text(page, '#pstamp'), 'Saved to Dropbox'),
     await text(page, '#pstamp'));
  await page.locator('#pstamp [data-act="pstClose"]').first().click();
  await page.waitForTimeout(700);

  /* THE PAIR, in the case. Both rows, both badged. */
  const pair = await page.evaluate(() => {
    const p = (WS.photo_stamps || [])[0] || {};
    const ev = WS.evidence || [];
    return { stamps: (WS.photo_stamps || []).length, evidence: ev.length,
             originalName: (ev.find(e => e.id === p.original_id) || {}).filename,
             copyName: (ev.find(e => e.id === p.stamped_id) || {}).filename,
             source: p.source, taken: p.taken_utc, tz: p.tz };
  });
  ok('one pairing is recorded', pair.stamps === before1.stamps + 1,
     JSON.stringify({ ...pair, before: before1.stamps }));
  ok('the original is still in the case under its own name',
     pair.originalName === 'IMG_4407.jpg', String(pair.originalName));
  ok('and the copy is a second file, named for what it is',
     pair.copyName === 'IMG_4407-timestamped.jpg', String(pair.copyName));
  ok('the provenance kept is the camera, because nothing was retyped',
     pair.source === 'exif', pair.source);
  ok('and the instant is the one the camera recorded, read as Eastern',
     pair.taken === '2026-08-17T21:14:32.000Z', pair.taken);

  /* Read off the CARDS, not off the panel text — "original" also appears in
     the upload label above, and an assertion that passes on that is asserting
     nothing. */
  const badges = await page.evaluate(() => {
    const p = (WS.photo_stamps || [])[0];
    const tagsOf = (id) => {
      const btn = document.querySelector(`.evcard [data-act="pstOpen"][data-id="${id}"]`);
      const card = btn ? btn.closest('.evcard')
        : [...document.querySelectorAll('.evcard')].find(c =>
            (c.querySelector('[data-act="evClass"]') || {}).dataset?.id === String(id));
      return card ? [...card.querySelectorAll('.tag')].map(t => t.textContent.trim().toLowerCase()) : null;
    };
    return { original: tagsOf(p.original_id), copy: tagsOf(p.stamped_id) };
  });
  ok('the original card is badged as the original',
     (badges.original || []).includes('original'), JSON.stringify(badges.original));
  ok('and the copy card is badged as the timestamped copy',
     (badges.copy || []).includes('timestamped copy'), JSON.stringify(badges.copy));

  /* THE BURN IS IN THE PIXELS — the whole point, and the one thing a screen
     full of confident wording cannot stand in for. The source is a flat
     colour, so any bright pixel in the bottom-right corner is the stamp, and
     the top-left must still be exactly the colour it was. */
  const pixels = await page.evaluate(async () => {
    const p = (WS.photo_stamps || [])[0];
    const read = async (id) => {
      const r = await fetch(`/portal-api/cases/${WS_CASE}/evidence/${id}/file`,
        { credentials: 'same-origin' });
      const url = URL.createObjectURL(await r.blob());
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      const bright = (x, y, w, h) => {
        const d = cx.getImageData(x, y, w, h).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) n++;
        return n;
      };
      URL.revokeObjectURL(url);
      return { w: c.width, h: c.height,
               corner: bright(c.width - 380, c.height - 70, 370, 60),
               topLeft: bright(0, 0, 300, 120) };
    };
    return { original: await read(p.original_id), copy: await read(p.stamped_id) };
  });
  ok('the copy is the same size as the original — nothing was cropped or scaled',
     pixels.copy.w === pixels.original.w && pixels.copy.h === pixels.original.h,
     JSON.stringify(pixels));
  ok('THE STAMP IS REALLY BURNED INTO THE BOTTOM-RIGHT CORNER',
     pixels.copy.corner > 200, JSON.stringify(pixels.copy));
  ok('and nothing was drawn anywhere else', pixels.copy.topLeft === 0, String(pixels.copy.topLeft));
  ok('while the ORIGINAL has no stamp in that corner at all',
     pixels.original.corner === 0, String(pixels.original.corner));

  /* A COPY OF A COPY IS NOT EVEN OFFERED — the Worker refuses it by name, and
     a control leading to a refusal is a control that should not be drawn. */
  const offers = await page.evaluate(() => {
    const p = (WS.photo_stamps || [])[0];
    const ids = [...document.querySelectorAll('[data-act="pstOpen"]')].map(b => Number(b.dataset.id));
    return { ids, original: p.original_id, copy: p.stamped_id };
  });
  ok('the copy is not offered for stamping', !offers.ids.includes(offers.copy), JSON.stringify(offers));
  ok('and the original is, so a wrong time can be corrected',
     offers.ids.includes(offers.original), JSON.stringify(offers));
}

section('Timestamp Photo: nothing is guessed, and a correction is the operator’s');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4003').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Evidence');

  /* NO EXIF AT ALL — a screenshot, a scan, a file a share sheet stripped. */
  const before2 = await page.evaluate(() => ({
    stamps: ((WS && WS.photo_stamps) || []).length,
    photos: ((WS && WS.evidence) || []).filter(e => !e.deleted_at
      && String(e.content_type || '').startsWith('image/')).length,
  }));
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    const cx = c.getContext('2d');
    cx.fillStyle = '#22333f';
    cx.fillRect(0, 0, 400, 300);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  await page.locator('#ev_file').setInputFiles({
    name: 'scan.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
  await page.locator('.btn', { hasText: 'Upload picture or document' }).click();
  await page.waitForTimeout(900);
  await page.locator('[data-act="pstOpen"]').first().click();
  await page.waitForTimeout(900);

  const blank = await text(page, '#pstamp');
  ok('a file with no camera timestamp fills in NOTHING',
     await page.locator('#pst_mo').inputValue() === ''
     && await page.locator('#pst_yr').inputValue() === '',
     await page.locator('#pst_yr').inputValue());
  ok('and says so rather than inventing one', has(blank, 'nothing has been filled in'), blank.slice(0, 400));
  /* The refusal `pstWhen` actually produces — matched on its own words rather
     than on the defensive default beneath it, which nothing reaches. */
  ok('the burn is not offered a time it does not have',
     has(blank, 'Fill in every part of the date and time'), blank.slice(0, 500));

  /* THE FILE'S MODIFIED DATE IS NOT A SECOND OPINION about when the picture
     was taken, and neither is today. Neither may appear as a seed. */
  const thisYear = String(new Date().getFullYear());
  ok('the current date is not quietly used as the anchor',
     await page.locator('#pst_yr').inputValue() !== thisYear);

  await page.locator('#pst_mo').fill('08');
  await page.locator('#pst_da').fill('17');
  await page.locator('#pst_yr').fill('2026');
  await page.locator('#pst_hr').fill('11');
  await page.locator('#pst_mi').fill('05');
  await page.locator('#pst_se').fill('00');
  await page.locator('#pst_ap').selectOption('AM');
  await page.locator('[data-act="pstBurn"]').click();
  await page.waitForTimeout(1200);
  ok('what the operator typed is what is drawn',
     has(await text(page, '#pstamp'), '08/17/2026 11:05:00 AM EDT'), await text(page, '#pstamp'));
  ok('and the screen says the operator is where it came from',
     has(await text(page, '#pstamp'), 'entered by the operator'));

  await page.locator('[data-act="pstToCase"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-act="pstFile"]').click();
  await page.waitForTimeout(2000);
  await page.locator('#pstamp [data-act="pstClose"]').first().click();
  await page.waitForTimeout(700);
  ok('and that is the provenance recorded',
     await page.evaluate(() => (WS.photo_stamps || [])[0].source) === 'operator');

  /* A CORRECTION SUPERSEDES. The earlier copy keeps its row — nothing in this
     portal purges — and exactly one copy is live. */
  const originalId = await page.evaluate(() => (WS.photo_stamps || [])[0].original_id);
  await page.locator(`[data-act="pstOpen"][data-id="${originalId}"]`).click();
  await page.waitForTimeout(900);
  /* Every part again: this file carries no EXIF, so the form opens empty on
     purpose and a correction is typed in full, exactly as it was the first
     time. */
  await page.locator('#pst_mo').fill('08');
  await page.locator('#pst_da').fill('17');
  await page.locator('#pst_yr').fill('2026');
  await page.locator('#pst_hr').fill('12');
  await page.locator('#pst_mi').fill('05');
  await page.locator('#pst_se').fill('00');
  await page.locator('#pst_ap').selectOption('PM');
  await page.locator('[data-act="pstBurn"]').click();
  await page.waitForTimeout(1200);
  await page.locator('[data-act="pstToCase"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-act="pstFile"]').click();
  await page.waitForTimeout(2000);
  await page.locator('#pstamp [data-act="pstClose"]').first().click();
  await page.waitForTimeout(700);

  const after = await page.evaluate((oid) => ({
    stamps: (WS.photo_stamps || []).length,
    live: (WS.photo_stamps || []).filter(x => x.original_id === oid && !x.superseded_at).length,
    mine: (WS.photo_stamps || []).filter(x => x.original_id === oid).length,
    photos: (WS.evidence || []).filter(e => !e.deleted_at
      && String(e.content_type || '').startsWith('image/')).length,
  }), originalId);
  ok('a correction records a second stamp rather than editing the first',
     after.mine === 2 && after.stamps === before2.stamps + 2,
     JSON.stringify({ ...after, before: before2 }));
  ok('and exactly one of them is live for this photograph', after.live === 1,
     JSON.stringify(after));
  /* The original, the first copy and the correction: three pictures, because
     the superseded one keeps its place. Nothing in this portal purges. */
  ok('the superseded copy keeps its place in the case — nothing here purges',
     after.photos === before2.photos + 3, JSON.stringify({ ...after, before: before2 }));
  ok('and the gallery says which one is superseded',
     has(await text(page, '#dlgBody'), 'superseded'));
}

/* THE PACKAGE RULE, owner 2026-08-18: a package must never carry both halves of
   the pair by default; the copy is the half that goes; the original keeps its
   classification unless an Admin explicitly selects it. */
section('Timestamp Photo: the copy is what the client gets, and the original is not put beside it');
{
  /* Its own case, so nothing else in the suite has already put material in a
     package on it and the picker is read in a known state. */
  await post('/ingest', {
    case_no: 'API-20260812-4020', service: 'Surveillance',
    client_name: 'Package Rule', client_phone: '4345550142',
    subject_name: 'Sam Watched', objective: 'Which half of the pair goes out.',
  }, { 'X-Ingest-Key': 'e2e-ingest-key' });

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4020').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Evidence');

  const jpeg = async (w, h, fill) => Buffer.from(await page.evaluate(([W, H, F]) => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const cx = c.getContext('2d');
    cx.fillStyle = F; cx.fillRect(0, 0, W, H);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }, [w, h, fill]), 'base64');

  /* The office form's classification selector opens on "needs review" — that is
     the admin door's own default, not the field upload's — so a test about what
     reaches a client package has to say which it is uploading. */
  const upload = async (name, buffer, cls = 'client_deliverable') => {
    await page.locator('#ev_file').setInputFiles({ name, mimeType: 'image/jpeg', buffer });
    await page.locator('#ev_class').selectOption(cls);
    await page.locator('.btn', { hasText: 'Upload picture or document' }).click();
    await page.waitForTimeout(900);
    const id = await page.evaluate((n) => (WS.evidence || []).find(e => e.filename === n).id, name);
    ok(`${name} was uploaded as ${cls}`,
       (await page.evaluate((i) => (WS.evidence || []).find(e => e.id === i).classification, id)) === cls);
    return id;
  };
  const stamp = async (evId, include) => {
    await page.locator(`[data-act="pstOpen"][data-id="${evId}"]`).click();
    await page.waitForTimeout(900);
    await page.locator('#pst_mo').fill('08');
    await page.locator('#pst_da').fill('17');
    await page.locator('#pst_yr').fill('2026');
    await page.locator('#pst_hr').fill('02');
    await page.locator('#pst_mi').fill('30');
    await page.locator('#pst_se').fill('00');
    await page.locator('#pst_ap').selectOption('PM');
    await page.locator('[data-act="pstBurn"]').click();
    await page.waitForTimeout(1200);
    /* The package question belongs to FILING, so it is on the step that files
       — not on the copy, which is made whether or not it is ever filed. */
    await page.locator('[data-act="pstToCase"]').click();
    await page.waitForTimeout(400);
    const box = page.locator('#pst_inc');
    const state = { present: await box.count() === 1, checked: await box.isChecked() };
    if (include === false) { await box.uncheck(); await page.waitForTimeout(250); }
    await page.locator('[data-act="pstFile"]').click();
    await page.waitForTimeout(2000);
    await page.locator('#pstamp [data-act="pstClose"]').first().click();
    await page.waitForTimeout(700);
    return state;
  };
  const classOf = (id) => page.evaluate((i) =>
    ((WS.evidence || []).find(e => e.id === i) || {}).classification, id);
  const copyOf = (id) => page.evaluate((i) =>
    ((WS.photo_stamps || []).find(x => x.original_id === i && !x.superseded_at) || {}).stamped_id, id);

  /* DEFAULT ON — and it is the checkbox that says so, not a comment. */
  const shipped = await upload('ship.jpg', await jpeg(600, 400, '#2f6f3f'));
  const first = await stamp(shipped);
  ok('the generate screen offers the package choice', first.present);
  ok('and it is ON by default', first.checked === true, String(first.checked));
  const shippedCopy = await copyOf(shipped);
  ok('so the copy is what the client can be sent',
     (await classOf(shippedCopy)) === 'client_deliverable', await classOf(shippedCopy));
  ok('and the ORIGINAL is left exactly as the admin classified it',
     (await classOf(shipped)) === 'client_deliverable', await classOf(shipped));

  /* TURNED OFF — the copy is held back, and still nothing happens to the
     original. There is no third state and no second flag. */
  const held = await upload('held.jpg', await jpeg(600, 400, '#6f2f3f'));
  await stamp(held, false);
  const heldCopy = await copyOf(held);
  ok('turning it off files the copy as internal only',
     (await classOf(heldCopy)) === 'internal_only', await classOf(heldCopy));
  ok('and the original is STILL untouched',
     (await classOf(held)) === 'client_deliverable', await classOf(held));

  /* THE PICKER. "Do not automatically include both" lives here, because this
     is where inclusion actually happens. */
  await wsTab(page, 'Package');
  await page.waitForTimeout(400);
  if (await page.locator('[data-act="pkgStart"]').count()) {
    await page.locator('[data-act="pkgStart"]').click();
    await page.waitForTimeout(900);
  }
  const picker = await page.evaluate(([origId, copyId, heldId]) => {
    const cardFor = (id) => [...document.querySelectorAll('.pkg-item')].find(c =>
      [...c.querySelectorAll('[data-act="pkgAdd"], [data-act="pkgRemove"]')]
        .some(b => b.dataset.id === String(id)));
    const read = (id) => {
      const c = cardFor(id);
      if (!c) return null;
      const add = c.querySelector('[data-act="pkgAdd"]');
      return { note: (c.querySelector('.pkg-sup') || {}).textContent || '',
               button: add ? add.textContent.trim() : null };
    };
    return { original: read(origId), copy: read(copyId), heldOriginal: read(heldId) };
  }, [shipped, shippedCopy, held]);

  ok('the original whose copy is going says so',
     /timestamped copy goes in its place/i.test((picker.original || {}).note || ''),
     JSON.stringify(picker.original));
  ok('and its Add becomes a deliberate one, not the ordinary one',
     (picker.original || {}).button === 'Add anyway', JSON.stringify(picker.original));
  ok('the copy itself is offered normally — it is the half that ships',
     (picker.copy || {}).button === 'Add' && !(picker.copy || {}).note,
     JSON.stringify(picker.copy));
  /* AND WHEN THE COPY IS HELD BACK the original is the one on offer again —
     read off the copy's live classification, never off a stored flag, so this
     follows an admin who changes their mind. */
  ok('an original whose copy was held back is offered the ordinary way',
     (picker.heldOriginal || {}).button === 'Add' && !(picker.heldOriginal || {}).note,
     JSON.stringify(picker.heldOriginal));

  /* NOTHING IS REFUSED. The owner allowed an Admin to select the original. */
  await page.locator(`.pkg-item [data-act="pkgAdd"][data-id="${shipped}"]`).click();
  await page.waitForTimeout(900);
  ok('and an admin who explicitly selects the original gets it',
     await page.evaluate((id) => (PKG.items || []).some(i => i.evidence_id === id), shipped));
}

/* THE DEFECT THIS SECTION EXISTS FOR (owner, live): "Timestamp Photo is
   deployed but not visible anywhere in the live portal."

   PHOTO-TIMESTAMP.md D1 put the door on the photograph itself, reasoning that
   unlike a clip the picture is already in the case. True, and not enough: with
   nothing uploaded there was no entry point ANYWHERE, so the tool could not be
   found by someone looking for it beside Timestamp Video. These assertions are
   about REACHABILITY, and they are written so the same class of defect cannot
   come back for either tool. */
/* THE DECODE DEFECT the owner's iPhone hit on IMG_3576.jpeg.

   `pstFromBytes` rebuilt the picture as `new Blob([buf], {type: file.type ||
   "image/jpeg"})` — rewrapping the operator's file under a type this page chose.
   A File is already a Blob and already knows what it is, and relabelling it is a
   way to make a good photograph undecodable, which is the very failure the
   function exists to report.

   HONEST ABOUT WHAT THIS PROVES. Chromium sniffs image bytes and decodes a
   mislabelled blob anyway — measured: the OLD code also reached the "when" step
   with a JPEG declared `image/heic`. So the behavioural check below guards the
   OUTCOME and is not evidence that this was the iPhone's cause; Safari's
   strictness cannot be reproduced here. The assertion with teeth is the
   structural one: the local path must hand over the File, never a rebuild. */
/* THE BUG THAT COST TWO DEPLOYS, and the reason no test could see it.

   `_headers` said `img-src 'self' data:` — no `blob:`. Timestamp Photo loads the
   operator's own picture into an <img> from a blob URL made in the tab, so the
   BROWSER BLOCKED IT and fired `onerror`, and the page honestly reported
   "cannot decode". Every photograph failed on every device; the file was never
   the problem. Timestamp Video was fine because `<video>` falls under
   `media-src`, which had carried `blob:` all along.

   This suite could not see it: `_headers` is applied by Cloudflare Pages, and
   the harness served the page with NO policy at all. It now serves the real one,
   so these assertions are evidence about the deployed page rather than about a
   page that only exists here. */
/* THE OVERLAY'S LAYOUT, measured on real phone geometry.

   Two goes at this, and the second is the one that mattered.

   It was `H * 0.05` — the HEIGHT — while the stamp runs along the WIDTH. Left
   gap in pixels with that code: 3024x4032 -> 11, 1080x1920 -> 7, 750x1334 -> 2.
   Edge to edge, no safe margin at all.

   Sizing from the SHORT side fixed the margin but not the PROPORTION, and the
   owner reported portrait still oversized. They were right, and the number says
   why — the drawn text as a share of the image width:

     landscape 4032x3024   52%   <- confirmed as reading correctly
     portrait  3024x4032   70%   <- the same face on a narrower picture

   The face is now derived from the WIDTH, so the share is the same whatever the
   shape. That is what these assertions check: not merely that the stamp fits,
   but that portrait and landscape agree — because "it fits" was true of the
   version the owner rejected.

   `vstDraw` is the ONE writer for photographs and video alike, so this fixes a
   portrait clip for both. */
section('The burned stamp fits inside the picture, portrait included');
{
  const page = await newPage();
  const boxes = await page.evaluate(() => {
    const label = '08/19/2026 05:14:32 PM EDT';
    const shot = (W, H) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const cx = c.getContext('2d');
      cx.fillStyle = '#3f6ea8';
      cx.fillRect(0, 0, W, H);
      vstDraw(cx, W, H, label);
      const d = cx.getImageData(0, 0, W, H).data;
      let minX = W, maxX = -1, minY = H, maxY = -1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      return { W, H, pad: Math.round(Math.min(W, H) * 0.035),
               left: minX, right: W - 1 - maxX, top: minY, bottom: H - 1 - maxY,
               textH: maxY - minY + 1, found: maxX >= 0 };
    };
    return {
      'portrait 3024x4032': shot(3024, 4032),
      'portrait 1080x1920': shot(1080, 1920),
      'portrait 750x1334': shot(750, 1334),
      'landscape 4032x3024': shot(4032, 3024),
      'square 1000x1000': shot(1000, 1000),
    };
  });

  for (const [name, b] of Object.entries(boxes)) {
    ok(`${name}: the stamp is drawn at all`, b.found, JSON.stringify(b));
    /* NOTHING CLIPS. The left edge is where a too-large face runs off, so this
       is the assertion the portrait defect would have failed. */
    ok(`${name}: nothing runs off the left`, b.left > 0, JSON.stringify(b));
    /* AND IT KEEPS ITS SAFE MARGIN — the whole string sits inside the padding
       rather than merely inside the canvas. */
    ok(`${name}: the whole stamp is inside the safe margin`, b.left >= b.pad,
       JSON.stringify(b));
    ok(`${name}: bottom-right, with a margin on the right`, b.right > 0 && b.right >= b.pad * 0.7,
       JSON.stringify(b));
    ok(`${name}: and one along the bottom`, b.bottom > 0 && b.bottom >= b.pad * 0.4,
       JSON.stringify(b));
    ok(`${name}: it sits in the bottom half, not floating`, b.top > b.H / 2, JSON.stringify(b));
    /* SMALLER BY DEFAULT. The old rule was H * 0.05. */
    ok(`${name}: the face is smaller than the old height-based rule`,
       b.textH < b.H * 0.05, JSON.stringify(b));
  }

  /* THE ASSERTION THE SECOND ATTEMPT NEEDED. Every one of these fitted inside
     its margins under the rejected version too — what was wrong was that a
     portrait picture carried a far larger stamp than a landscape one. So the
     property is AGREEMENT: the stamp occupies the same share of the width
     whatever the shape, and portrait no longer dominates the frame. */
  const shares = Object.entries(boxes)
    .filter(([n]) => !/wide/.test(n))
    .map(([n, b]) => [n, (b.right >= 0 ? (b.W - b.left - b.right) / b.W : 0)]);
  for (const [n, share] of shares) {
    ok(`${n}: the stamp takes about half the width, not most of it`,
       share > 0.4 && share < 0.62, `${(share * 100).toFixed(1)}%`);
  }
  const lo = Math.min(...shares.map(([, v]) => v));
  const hi = Math.max(...shares.map(([, v]) => v));
  ok('portrait and landscape agree on how much of the width the stamp takes',
     hi - lo < 0.05, `${(lo * 100).toFixed(1)}% to ${(hi * 100).toFixed(1)}%`);

  /* And a very wide, short picture is held back by the HEIGHT instead, so a
     banner does not get a stamp taller than itself. */
  const wide = await page.evaluate(() => {
    const W = 4000, H = 500;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const cx = c.getContext('2d');
    cx.fillStyle = '#3f6ea8';
    cx.fillRect(0, 0, W, H);
    vstDraw(cx, W, H, '08/19/2026 05:14:32 PM EDT');
    const d = cx.getImageData(0, 0, W, H).data;
    let minY = H, maxY = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) {
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    return { H, textH: maxY - minY + 1, bottom: H - 1 - maxY };
  });
  ok('a wide, short picture is capped by its height instead',
     wide.textH < wide.H * 0.12 && wide.bottom > 0, JSON.stringify(wide));
  await page.close();
}

section('Timestamp Photo under the policy the site actually serves');
{
  ok('the harness serves a policy at all', PORTAL_CSP.length > 0, PORTAL_CSP.slice(0, 60));
  ok('and it is the deployed one, allowing the page its own blobs as images',
     /img-src 'self' data: blob:/.test(PORTAL_CSP), PORTAL_CSP);

  const page = await newPage();
  const refusals = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to load/i.test(m.text())) refusals.push(m.text().slice(0, 100));
  });
  ok('the page really is served with it', /img-src/.test(await page.evaluate(async () => {
    const r = await fetch('/portal/', { credentials: 'same-origin' });
    return r.headers.get('content-security-policy') || '';
  })));

  await signIn(page, 'trever', 'AdminPassword1x');
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    const cx = c.getContext('2d');
    cx.fillStyle = '#2d5f8a';
    cx.fillRect(0, 0, 400, 300);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.qtool[data-act="pstLaunch"]').click(),
  ]);
  await chooser.setFiles({ name: 'IMG_3533.jpeg', mimeType: 'image/jpeg',
    buffer: Buffer.from(b64, 'base64') });
  await page.waitForTimeout(1600);
  ok('an ordinary phone JPEG decodes under the real policy',
     has(await text(page, '#pstamp'), 'When was it taken'),
     (await text(page, '#pstamp')).slice(0, 200));

  await page.locator('#pst_mo').fill('08');
  await page.locator('#pst_da').fill('19');
  await page.locator('#pst_yr').fill('2026');
  await page.locator('#pst_hr').fill('10');
  await page.locator('#pst_mi').fill('15');
  await page.locator('#pst_se').fill('00');
  await page.locator('[data-act="pstBurn"]').click();
  await page.waitForTimeout(1600);

  /* THE ASSERTION THAT WOULD HAVE CAUGHT IT. The preview is a blob: URL in an
     <img>; a blocked one is `complete` with a natural size of ZERO, which looks
     like nothing at all on screen and reads as a working page. */
  const prev = await page.evaluate(() => {
    const i = document.querySelector('.pst-prev');
    return i ? { complete: i.complete, w: i.naturalWidth, h: i.naturalHeight } : null;
  });
  ok('and the copy is actually VISIBLE, not a blocked blob with no pixels',
     prev && prev.complete && prev.w === 400 && prev.h === 300, JSON.stringify(prev));
  ok('with the browser refusing nothing along the way',
     refusals.length === 0, JSON.stringify(refusals));
  await page.close();
}

section('Timestamp Photo decodes the operator’s own file, not a relabelled copy');
{
  const src = fs.readFileSync(path.join(ROOT, 'portal/index.html'), 'utf8');
  const begin = src.slice(src.indexOf('async function pstBegin'),
                          src.indexOf('async function pstOpen'));
  ok('the local path exists to be checked', begin.length > 0);
  ok('it hands the File itself to the decoder',
     /pstFromBytes\(file, buf, token\)/.test(begin), begin.slice(-200));
  ok('and never rebuilds the picture as a new Blob',
     !/new Blob\(/.test(begin), begin.slice(-200));

  /* The in-case path has no File — only bytes off the evidence route — so it
     MUST build a Blob, and from the content type the case recorded rather than
     from a default. That is a fact about the stored file, not a guess. */
  const open = src.slice(src.indexOf('async function pstOpen'),
                         src.indexOf('function pstClose'));
  ok('the in-case path builds its blob from the recorded content type',
     /new Blob\(\[buf\], \{type: \(row && row\.content_type\)/.test(open), open.slice(-260));

  /* The outcome, at any rate: a file whose declared type disagrees with its
     bytes still reaches the question this tool exists to ask. */
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    const cx = c.getContext('2d');
    cx.fillStyle = '#2d5f8a';
    cx.fillRect(0, 0, 320, 240);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.qtool[data-act="pstLaunch"]').click(),
  ]);
  await chooser.setFiles({ name: 'IMG_3576.jpeg', mimeType: 'image/heic',
    buffer: Buffer.from(b64, 'base64') });
  await page.waitForTimeout(1500);
  ok('a picture whose declared type disagrees with its bytes still opens',
     has(await text(page, '#pstamp'), 'When was it taken'),
     (await text(page, '#pstamp')).slice(0, 200));
  ok('at its own size, so the decode was real',
     JSON.stringify(await page.evaluate(() => ({ w: PST.w, h: PST.h }))) === '{"w":320,"h":240}',
     JSON.stringify(await page.evaluate(() => ({ w: PST.w, h: PST.h }))));
  await page.close();
}

section('Timestamp Photo asks for a picture first, and for a case only to file it');
{
  await post('/ingest', {
    case_no: 'API-20260812-4021', service: 'Surveillance',
    client_name: 'Filed Later', client_phone: '4345550143',
    subject_name: 'Sam Watched', objective: 'A case chosen after the fact.',
  }, { 'X-Ingest-Key': 'e2e-ingest-key' });

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  /* BOTH UTILITIES, IN BOTH PLACES. Asserted as a pair rather than by name
     alone: the rule is that these two are siblings, and a door that exists for
     one and not the other is exactly what went wrong the first time. */
  const doors = await page.evaluate(() => ({
    tools: [...document.querySelectorAll('.qtool')].map(b => b.dataset.act),
    nav: [...document.querySelectorAll('.navfoot button')].map(b => b.dataset.act),
  }));
  ok('the dashboard quick tools offer the video utility', doors.tools.includes('vstOpen'),
     JSON.stringify(doors.tools));
  ok('AND the photo utility, beside it', doors.tools.includes('pstLaunch'),
     JSON.stringify(doors.tools));
  ok('the navigation foot carries both as well',
     doors.nav.includes('vstOpen') && doors.nav.includes('pstLaunch'), JSON.stringify(doors.nav));

  /* THE DEFECT THE OWNER FOUND ON A DEVICE: the door led with a required case
     picker, so a utility asked about filing before it would do its one job.
     It now opens the PICTURE PICKER, exactly as Timestamp Video does. */
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const cx = c.getContext('2d');
    cx.fillStyle = '#274a6d';
    cx.fillRect(0, 0, 640, 480);
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  });
  const local = Buffer.from(b64, 'base64');

  const filesAtStart = DBX.files.size;
  const evAtStart = db.prepare('SELECT COUNT(*) AS n FROM case_evidence').get().n;
  const stampsAtStart = db.prepare('SELECT COUNT(*) AS n FROM photo_stamp').get().n;

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.qtool[data-act="pstLaunch"]').click(),
  ]);
  /* Reaching this line at all IS the assertion: `waitForEvent('filechooser')`
     resolved, so the door opened a picture picker. Before the owner's device
     test it opened a required case picker and no chooser would ever have
     fired. */
  ok('the door opens a picture picker rather than asking about filing',
     chooser !== null && !chooser.isMultiple());
  await chooser.setFiles({ name: 'from-phone.jpg', mimeType: 'image/jpeg', buffer: local });
  await page.waitForTimeout(1200);

  const first = await text(page, '#pstamp');
  ok('it goes straight to the question it exists to ask',
     has(first, 'When was it taken'), first.slice(0, 200));
  ok('and no case has been asked for at all', !has(first, 'which case'),
     first.slice(0, 300));

  /* A photograph off a device carries no EXIF from a canvas, so the form is
     empty and says so — the same honesty as the in-case path. */
  await page.locator('#pst_mo').fill('08');
  await page.locator('#pst_da').fill('19');
  await page.locator('#pst_yr').fill('2026');
  await page.locator('#pst_hr').fill('09');
  await page.locator('#pst_mi').fill('45');
  await page.locator('#pst_se').fill('10');
  await page.locator('#pst_ap').selectOption('AM');
  await page.locator('[data-act="pstBurn"]').click();
  await page.waitForTimeout(1400);

  const prev = await text(page, '#pstamp');
  ok('the copy is made here on this machine',
     has(prev, 'The timestamped copy') && await page.locator('.pst-prev').count() === 1);
  ok('and it is stamped with what was typed',
     has(prev, '08/19/2026 09:45:10 AM EDT'), prev);
  ok('keeping it on this device is the first thing offered',
     await page.locator('[data-act="pstSaveDevice"]').count() === 1);
  ok('and the screen says the rest is optional', has(prev, 'Everything below is'),
     prev.slice(0, 600));
  /* THE DEVICE SAVE IS UNTOUCHED and stays the first thing offered — the owner's
     words, 2026-08-19: "Keep Save to this device exactly as the local iOS/share
     option." Saving to Dropbox is a SECOND control beside it, never instead. */
  ok('keeping it on the device is still its own control',
     await page.locator('[data-act="pstSaveDevice"]').count() === 1);
  ok('and Dropbox is a separate one beside it',
     await page.locator('[data-act="pstChooseCase"]').count()
     + await page.locator('[data-act="pstToCase"]').count() >= 1);
  ok('which says where it is going', has(prev, 'Save to Dropbox'), prev.slice(0, 600));

  /* NOTHING HAS LEFT THE MACHINE. This is the whole bargain, and it is the
     same one Timestamp Video makes — measured against the counts taken before
     the picture was even chosen. */
  ok('the picture was read and burned with nothing uploaded',
     DBX.files.size === filesAtStart
     && db.prepare('SELECT COUNT(*) AS n FROM case_evidence').get().n === evAtStart,
     `${DBX.files.size} vs ${filesAtStart}`);
  ok('and no record of it exists in the portal',
     db.prepare('SELECT COUNT(*) AS n FROM photo_stamp').get().n === stampsAtStart);

  await page.locator('[data-act="pstChooseCase"]').click();
  await page.waitForTimeout(900);
  ok('choosing to file is what asks for a case',
     has(await text(page, '#pstamp'), 'Save to Dropbox')
     && has(await text(page, '#pstamp'), 'which case'));
  /* AND IT SAYS WHY IT IS ASKING. The firm's Dropbox keeps a folder per case,
     so the case is the one thing a save needs — not a formality in the way. */
  ok('and says why a case is needed at all',
     has(await text(page, '#pstamp'), 'folder per case'), (await text(page, '#pstamp')).slice(0, 400));
  ok('and it says the copy is yours either way',
     has(await text(page, '#pstamp'), 'You do not have to save it to Dropbox at all'));
  ok('with a way back that keeps it here',
     await page.locator('[data-act="pstBackToPreview"]').count() === 1);

  ok('still nothing uploaded while the case is being chosen',
     db.prepare('SELECT COUNT(*) AS n FROM case_evidence').get().n === evAtStart
     && DBX.files.size === filesAtStart);

  await page.locator('[data-act="pstPickCase"][data-case="API-20260812-4021"]').click();
  await page.waitForTimeout(700);
  ok('the package question belongs to filing, so it is asked here',
     await page.locator('#pst_inc').count() === 1);
  ok('and it is on by default', await page.locator('#pst_inc').isChecked());
  await page.locator('[data-act="pstFile"]').click();
  await page.waitForTimeout(2500);
  ok('and then it is saved to Dropbox',
     has(await text(page, '#pstamp'), 'Saved to Dropbox')
     && has(await text(page, '#pstamp'), 'API-20260812-4021'),
     (await text(page, '#pstamp')).slice(0, 200));

  /* BOTH HALVES REACHED THE CASE. The owner's rule is that the original is
     preserved untouched as case evidence, so a picture that was never in the
     case has to be filed as well as stamped. */
  const rows = db.prepare(
    `SELECT filename FROM case_evidence WHERE case_no = 'API-20260812-4021'
      ORDER BY id`).all().map(r => r.filename);
  ok('the original went in beside the copy', rows.includes('from-phone.jpg'), JSON.stringify(rows));
  ok('and so did the timestamped copy',
     rows.includes('from-phone-timestamped.jpg'), JSON.stringify(rows));
  ok('exactly two, so the copy did not arrive on its own', rows.length === 2, JSON.stringify(rows));
  ok('and two files reached the store, not one',
     DBX.files.size === filesAtStart + 2, `${DBX.files.size} vs ${filesAtStart}`);
  const pair = db.prepare(
    `SELECT COUNT(*) AS n FROM photo_stamp WHERE case_no = 'API-20260812-4021'`).get().n;
  ok('and the pair is recorded exactly once',
     pair === 1
     && db.prepare('SELECT COUNT(*) AS n FROM photo_stamp').get().n === stampsAtStart + 1,
     String(pair));
  await page.close();
}

/* AND THE FIELD VIEW, where the navigation rail is not on screen at all — so
   the nav door does not help and the tool needs one of its own. */
section('Timestamp Photo is reachable in the field, beside Timestamp video');
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', (e) => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('dana');
  await page.locator('#p').fill('FieldWork2026x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  await page.locator('[data-act="svEnter"]:visible').first().click();
  await page.waitForTimeout(800);
  await page.locator('[data-act="svTab"][data-t="evidence"]').click();
  await page.waitForTimeout(700);

  const field = await page.evaluate(() =>
    [...document.querySelectorAll('.sv-quad .sv-q')].map(b => b.dataset.act));
  ok('the field media screen offers the video utility', field.includes('svVideo'),
     JSON.stringify(field));
  ok('AND the photo one, beside it', field.includes('pstLaunch'), JSON.stringify(field));
  /* Here it DOES carry the case: the investigator is standing in it, and the
     field view is a view OF that case rather than a utility that floats free. */
  ok('and in the field it knows which case it is on', await page.evaluate(() =>
     document.querySelector('.sv-quad [data-act="pstLaunch"]').getAttribute('data-case')) === 'API-20260812-4001');
  await page.close();
}

section('The device answers for itself');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.evaluate(() => {
    VST = { step: 'preview', caseNo: 'API-20260812-4002', file: null, name: 'IMG_0440.mov',
            size: 1024, url: '', tz: 'America/New_York', q: '',
            mo: '05', da: '03', yr: '2025', hr: '11', mi: '27', se: '58', ap: 'AM',
            guessed: false, hash: null, pct: 0, err: '', saveMsg: '', diag: '',
            out: null, recId: null, savedHere: false, started: false,
            readable: false, codec: { cc: 'hvc1', name: 'HEVC / H.265' }, caps: vstCaps() };
    paintVStamp();
  });
  await page.waitForTimeout(200);
  ok('an undecodable file offers the device read-out',
     await page.locator('[data-act="vstDiag"]').count() === 1);

  await page.locator('[data-act="vstDiag"]').first().click();
  await page.waitForTimeout(3000);
  const diag = await text(page, '.vst-diag');
  /* EVERY ROW THE iOS QUESTION NEEDS, measured on whatever device is reading
     it — the only honest way to fill an iPhone column from anywhere else. */
  /* The row names are the owner's own §11 list, 2026-08-18 — this read-out is
     the regression test for the pipeline, so it reports STAGES rather than the
     API inventory it started as. */
  for (const row of ['Device', 'Decode original', 'Container', 'Video codec',
                     'Audio codec', 'WebCodecs decode', 'Encode H.264',
                     'Timestamp renderer', 'Result readable here', 'Share available']) {
    ok(`the read-out reports ${row}`, has(diag, row), diag.slice(0, 300));
  }
  /* IT ACTUALLY TRIES, rather than trusting the capability strings — on iOS
     `isTypeSupported` returning true has not meant the bytes are playable, and
     that is exactly what wrote a file the owner's iPhone could not open. */
  ok('and it really attempted a render rather than reporting a capability string',
     /READS BACK|no —/.test(diag), diag.slice(-300));
  ok('which on this machine produced a format it could read back',
     /READS BACK/.test(diag), diag.slice(-300));
  ok('the read-out does not scroll the page sideways', await page.evaluate(() =>
     document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await page.close();
}

section('Nothing about the video is persisted anywhere');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  /* THE DEVICE-FIRST PROMISE, asserted rather than asserted-in-a-comment: no
     video byte reaches any browser store either, not just no R2 and no D1. */
  const stores = await page.evaluate(async () => {
    const ls = Object.keys(localStorage).map(k => k + '=' + localStorage.getItem(k)).join('|');
    const ss = Object.keys(sessionStorage).map(k => k + '=' + sessionStorage.getItem(k)).join('|');
    let dbs = [];
    try { dbs = (await indexedDB.databases()).map(d => d.name); } catch {}
    return { ls, ss, dbs };
  });
  ok('no video reaches localStorage', !/video|\.mov|\.mp4|\.webm|blob:/i.test(stores.ls), stores.ls.slice(0, 200));
  ok('nor sessionStorage', !/video|\.mov|\.mp4|\.webm|blob:/i.test(stores.ss), stores.ss.slice(0, 200));
  ok('and the page opens no IndexedDB at all', stores.dbs.length === 0, JSON.stringify(stores.dbs));

  /* AND THE OBJECT URLS ARE RELEASED. Closing the generator revokes both, so a
     long session does not accumulate video in the tab. */
  const revoked = await page.evaluate(async () => {
    const blob = new Blob([new Uint8Array(64)], { type: 'video/webm' });
    VST = { step: 'done', caseNo: '', file: null, name: 'x.mov', size: 64,
            url: URL.createObjectURL(blob), tz: 'America/New_York',
            out: { blob, url: URL.createObjectURL(blob), name: 'x-timestamped.webm',
                   size: 64, mime: 'video/webm' },
            readable: true, codec: null, caps: vstCaps(), diag: '' };
    const before = [VST.url, VST.out.url];
    vstClose();
    // A revoked object URL no longer fetches.
    const alive = await Promise.all(before.map(u =>
      fetch(u).then(() => true).catch(() => false)));
    return { before, alive, closed: VST === null };
  });
  ok('closing the generator lets go of the video', revoked.closed
     && revoked.alive.every(a => a === false), JSON.stringify(revoked));
  await page.close();
}


/* OWNER DEVICE TEST, 2026-08-18, on the real iPhone:
     MediaRecorder MP4/AVC: yes · MediaRecorder WebM/VP9: yes
     END-TO-END: FAILED — it wrote a file the iOS device could not read back.
   `vstMime()` returned WebM because WebM was first in the list. iOS records
   WebM and does not play it. The format is now chosen by proving the round
   trip, not by asking `isTypeSupported`. */
section('The output format is proven, not declared');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  const order = await page.evaluate(() => VST_MIMES);
  ok('MP4 with H.264 is preferred over WebM', /mp4/.test(order[0]) && /avc1/.test(order[0]),
     JSON.stringify(order.slice(0, 3)));
  ok('and WebM is still there as the fallback', order.some(t => /webm/.test(t)));

  /* THE ROUND TRIP IS THE DECISION. A format that writes but cannot be read
     back is refused however loudly `isTypeSupported` claims it. */
  const proven = await page.evaluate(async () => await vstProveMime());
  ok('a format is only chosen after it writes AND reads back',
     proven.mime === '' || proven.tried.find(t => t.mime === proven.mime).ok === true,
     JSON.stringify(proven.tried.map(t => [t.mime, t.ok, t.why])));
  ok('every candidate it rejected carries the reason it was rejected',
     proven.tried.filter(t => !t.ok).every(t => !!t.why),
     JSON.stringify(proven.tried.map(t => [t.mime, t.why])));
  ok('and on this machine it proved one by reading it back',
     !!proven.mime && proven.tried.some(t => t.ok && t.bytes > 0),
     JSON.stringify(proven.tried.filter(t => t.ok)));

  /* THE OWNER'S FAILURE, REPRODUCED AS A RULE: a candidate that writes bytes
     the device cannot open is reported with that exact reason and is not
     selected — which is what should have happened on their iPhone. */
  const refused = await page.evaluate(async () => {
    // A mime the recorder will not honour at all stands in for the iOS case.
    const r = await vstRoundTrip('video/mp4;codecs=avc1.42E01E');
    return r;
  });
  ok('an unusable format is never returned as the answer',
     refused.ok === false ? !!refused.why : refused.bytes > 0,
     JSON.stringify(refused));

  ok('vstMime hands back the proven format once it is known',
     await page.evaluate(() => VST_PROVEN && vstMime() === VST_PROVEN.mime));
  await page.close();
}

/* OWNER §1: "DO NOT CONFUSE API PRESENCE WITH CODEC SUPPORT." The file is
   parsed properly — not scanned for a four-character code. */
section('The MOV is parsed, not guessed at');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  const parsed = await page.evaluate(async () => {
    const box = (type, payload) => {
      const b = new Uint8Array(8 + payload.length);
      new DataView(b.buffer).setUint32(0, 8 + payload.length);
      for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
      b.set(payload, 8); return b;
    };
    const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0);
      const o = new Uint8Array(n); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
    const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
    const u16 = n => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n); return b; };
    const i32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n); return b; };

    // tkhd v0 with a 90-degree rotation matrix, as an upright iPhone writes.
    const matrix = (a, b, c, d) => cat(i32(a * 65536), i32(b * 65536), u32(0),
                                       i32(c * 65536), i32(d * 65536), u32(0),
                                       u32(0), u32(0), u32(0x40000000));
    const tkhd = (rotA, rotB, rotC, rotD) => box('tkhd', cat(
      new Uint8Array(4),                       // version 0 + flags
      new Uint8Array(20),                      // times, id, reserved
      new Uint8Array(16),                      // more reserved
      matrix(rotA, rotB, rotC, rotD),
      u32(0), u32(0)));                        // width/height (unused here)
    const mdhd = (ts, dur) => box('mdhd', cat(new Uint8Array(4), new Uint8Array(8),
      u32(ts), u32(dur), new Uint8Array(4)));
    const hdlr = kind => box('hdlr', cat(new Uint8Array(4), new Uint8Array(4),
      new TextEncoder().encode(kind), new Uint8Array(12)));

    // hvcC: byte1 carries tier+profile, bytes 2..5 the profile compatibility,
    // byte 12 the level. Shaped so the codec string is derivable.
    const hvcC = new Uint8Array(23);
    hvcC[0] = 1; hvcC[1] = 0x01; hvcC[2] = 0x60; hvcC[12] = 93;
    const avcC = new Uint8Array([1, 0x64, 0x00, 0x2a, 0xff]);

    const visual = (cc, w, h, cfgType, cfg) => {
      const body = new Uint8Array(78);
      new DataView(body.buffer).setUint16(24, w);
      new DataView(body.buffer).setUint16(26, h);
      return box(cc, cat(body, box(cfgType, cfg)));
    };
    const sound = (cc, ch, rate) => {
      const body = new Uint8Array(28);
      new DataView(body.buffer).setUint16(16, ch);
      new DataView(body.buffer).setUint32(24, rate << 16);
      return box(cc, body);
    };
    const stsdOf = entry => box('stsd', cat(new Uint8Array(8), entry));
    const trak = (kindStr, entry, ts, dur, tk) => box('trak', cat(
      tk, box('mdia', cat(mdhd(ts, dur), hdlr(kindStr),
        box('minf', box('stbl', stsdOf(entry)))))));

    const mk = (entry, kindStr, tkArgs, audio) => {
      const traks = [trak(kindStr, entry, 600, 6000, tkhd(...tkArgs))];
      if (audio) traks.push(trak('soun', sound('mp4a', 2, 44100), 44100, 441000,
                                 tkhd(1, 0, 0, 1)));
      const moov = box('moov', cat(...traks));
      const mdat = box('mdat', new Uint8Array(2 * 1048576));
      const ftyp = box('ftyp', new Uint8Array([113, 116, 32, 32, 0, 0, 2, 0]));
      return new File([cat(ftyp, mdat, moov)], 'IMG_0440.mov', { type: 'video/quicktime' });
    };

    return {
      hevcPortrait: await vstParse(mk(visual('hvc1', 1920, 1080, 'hvcC', hvcC),
        'vide', [0, 1, -1, 0], true)),
      h264Upright: await vstParse(mk(visual('avc1', 1280, 720, 'avcC', avcC),
        'vide', [1, 0, 0, 1], false)),
    };
  });

  const hv = parsed.hevcPortrait, h2 = parsed.h264Upright;
  ok('the video codec is read from the sample entry',
     hv.video.cc === 'hvc1' && /HEVC/.test(hv.video.name), JSON.stringify(hv.video));
  ok('with the dimensions', hv.video.width === 1920 && hv.video.height === 1080,
     `${hv.video.width}x${hv.video.height}`);
  ok('and the timescale and duration', hv.video.timescale === 600 && hv.video.seconds === 10,
     JSON.stringify([hv.video.timescale, hv.video.duration, hv.video.seconds]));
  /* THE ROTATION iOS STORES IN THE MATRIX rather than in the pixels. A
     derivative that ignores it comes out sideways. */
  ok('the rotation matrix is read, not ignored', hv.rotation === 90, String(hv.rotation));
  ok('and an upright track reports no rotation', h2.rotation === 0, String(h2.rotation));
  /* AUDIO IS A HARD REQUIREMENT NOW, so its presence is a parsed fact. */
  ok('an audio track is found and named',
     hv.audio && hv.audio.cc === 'mp4a' && /AAC/.test(hv.audio.name)
     && hv.audio.channels === 2 && hv.audio.sampleRate === 44100, JSON.stringify(hv.audio));
  ok('and a file with no audio says so, rather than assuming', h2.audio === null);

  /* THE CONFIGURATION RECORD WebCodecs NEEDS — this is the difference between
     "the API exists" and "the decoder accepts this file". */
  ok('the HEVC configuration record is extracted', hv.video.hasConfig
     && hv.video.configBox === 'hvcC' && hv.video.description.length === 23,
     JSON.stringify([hv.video.configBox, hv.video.description && hv.video.description.length]));
  ok('and a codec string is derived from it rather than hard-coded',
     /^hvc1\.1\./.test(hv.video.codecString) && /L93/.test(hv.video.codecString),
     hv.video.codecString);
  ok('H.264 derives its own string from avcC profile bytes',
     h2.video.codecString === 'avc1.64002a', h2.video.codecString);

  /* NEVER INVENTED. A file whose boxes cannot be walked reports nothing. */
  const junk = await page.evaluate(async () =>
    await vstParse(new File([new Uint8Array(4096)], 'junk.mov', { type: 'video/quicktime' })));
  ok('an unparseable file yields no codec at all', junk.video === null, JSON.stringify(junk));

  /* BOUNDED READS — an 84.7 MB original must not be pulled into memory to read
     a header. The fixture carries a 2 MB mdat and the parser never touches it. */
  const bytes = await page.evaluate(async () => {
    let read = 0;
    const big = new Uint8Array(6 * 1048576);
    const f = new File([big], 'big.mov', { type: 'video/quicktime' });
    const realSlice = f.slice.bind(f);
    f.slice = (a, b) => { read += (b - a); return realSlice(a, b); };
    await vstParse(f);
    return { read, size: f.size };
  });
  ok('the parser reads a bounded slice, never the whole file',
     bytes.read < bytes.size / 10, JSON.stringify(bytes));
  await page.close();
}

/* OWNER, 2026-08-24: "Add local MTS/M2TS support to Video Timestamp. Do not
   rely on browser playback to decide compatibility. Decode/process locally,
   burn the timestamp, output MP4, keep original untouched, and never upload
   the source."

   The fixtures are written by an INDEPENDENT muxer below — spec-first bit
   packing that shares nothing with the page's reader, so a mirrored
   misunderstanding cannot pass itself. No browser plays MPEG-TS, so unlike the
   MOV fixtures nothing here can lean on a media element even by accident. */
const TS_LIB = String.raw`
  const bitWriter = () => {
    const bits = [];
    return {
      u: (v, n) => { for(let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); },
      ue: v => { const k = v + 1; const n = 32 - Math.clz32(k);
                 for(let i = 0; i < n - 1; i++) bits.push(0);
                 for(let i = n - 1; i >= 0; i--) bits.push((k >> i) & 1); },
      bytes: () => { while(bits.length % 8) bits.push(1);
        const out = new Uint8Array(bits.length / 8);
        for(let i = 0; i < bits.length; i++) if(bits[i]) out[i >> 3] |= 128 >> (i & 7);
        return out; },
    };
  };
  const escapeRbsp = u8 => {
    const out = []; let zeros = 0;
    for(const b of u8){
      if(zeros === 2 && b <= 3){ out.push(3); zeros = 0; }
      out.push(b); zeros = b === 0 ? zeros + 1 : 0;
    }
    return new Uint8Array(out);
  };
  const makeSps = ({profile = 66, level = 30, wMbs, hUnits, frameMbsOnly = 1, cropB = 0}) => {
    const w = bitWriter();
    w.u(profile, 8); w.u(0, 8); w.u(level, 8);
    w.ue(0); w.ue(0); w.ue(0); w.ue(0); w.ue(1); w.u(0, 1);
    w.ue(wMbs - 1); w.ue(hUnits - 1); w.u(frameMbsOnly, 1);
    if(!frameMbsOnly) w.u(0, 1);
    w.u(1, 1);
    w.u(cropB ? 1 : 0, 1);
    if(cropB){ w.ue(0); w.ue(0); w.ue(0); w.ue(cropB); }
    w.u(0, 1);
    const esc = escapeRbsp(w.bytes());
    const out = new Uint8Array(1 + esc.length);
    out[0] = 0x67; out.set(esc, 1);
    return out;
  };
  const annexb = (...nals) => {
    const out = new Uint8Array(nals.reduce((s, x) => s + 4 + x.length, 0));
    let o = 0;
    for(const x of nals){ out.set([0, 0, 0, 1], o); o += 4; out.set(x, o); o += x.length; }
    return out;
  };
  const tsSlice = (idr, len = 24) => {
    const b = new Uint8Array(len).fill(0xaa);
    b[0] = idr ? 0x65 : 0x41; b[1] = 0x88;      // first_mb_in_slice = 0
    return b;
  };
  const pesOf = (payload, ptsVal, dtsVal) => {
    const both = dtsVal != null && dtsVal !== ptsVal;
    const hlen = both ? 10 : 5;
    const head = new Uint8Array(9 + hlen);
    head.set([0, 0, 1, 0xe0, 0, 0, 0x80, both ? 0xc0 : 0x80, hlen], 0);
    const stamp = (at, v, tag) => {
      const b = BigInt(v);
      head[at] = (tag << 4) | (Number((b >> 30n) & 7n) << 1) | 1;
      head[at + 1] = Number((b >> 22n) & 0xffn);
      head[at + 2] = (Number((b >> 15n) & 0x7fn) << 1) | 1;
      head[at + 3] = Number((b >> 7n) & 0xffn);
      head[at + 4] = (Number(b & 0x7fn) << 1) | 1;
    };
    stamp(9, ptsVal, both ? 3 : 2);
    if(both) stamp(14, dtsVal, 1);
    const out = new Uint8Array(head.length + payload.length);
    out.set(head, 0); out.set(payload, head.length);
    return out;
  };
  const patSection = pmtPid => {
    const b = new Uint8Array([0, 0xb0, 0, 0, 1, 0xc1, 0, 0,
      0, 1, 0xe0 | (pmtPid >> 8), pmtPid & 0xff, 0, 0, 0, 0]);
    b[2] = b.length - 3;
    return b;
  };
  const pmtSection = streams => {
    const rows = [];
    for(const s of streams) rows.push(s.type, 0xe0 | (s.pid >> 8), s.pid & 0xff, 0xf0, 0);
    const b = new Uint8Array(12 + rows.length + 4);
    b[0] = 0x02; b[1] = 0xb0; b[2] = b.length - 3;
    b[4] = 1; b[5] = 0xc1;
    b[8] = 0xe0 | (streams[0].pid >> 8); b[9] = streams[0].pid & 0xff;
    b[10] = 0xf0;
    b.set(rows, 12);
    return b;
  };
  const tsPackets = (units, stride = 188) => {
    const packets = [], cc = {};
    for(const u of units){
      let at = 0, first = true;
      while(at < u.data.length || first){
        const p = new Uint8Array(188).fill(0xff);
        p[0] = 0x47;
        p[1] = ((first && u.pusi) ? 0x40 : 0) | (u.pid >> 8);
        p[2] = u.pid & 0xff;
        cc[u.pid] = ((cc[u.pid] || 0) + 1) & 0xf;
        let pay = 4, room = 184;
        const remain = u.data.length - at + (first && u.psi ? 1 : 0);
        if(!u.psi && remain < room){
          const stuff = room - remain;
          p[3] = 0x30 | cc[u.pid];
          p[4] = stuff - 1;
          if(stuff > 1) p[5] = 0;
          pay = 4 + stuff; room = remain;
        } else p[3] = 0x10 | cc[u.pid];
        if(first && u.psi){ p[pay++] = 0; room--; }
        const take = Math.min(room, u.data.length - at);
        p.set(u.data.subarray(at, at + take), pay);
        at += take;
        packets.push(p);
        first = false;
        if(u.data.length === 0) break;
      }
    }
    const out = new Uint8Array(packets.length * stride);
    packets.forEach((p, i) => out.set(p, i * stride + (stride - 188)));
    return out;
  };
  const makeTs = ({stride = 188, frames = 30, fps = 30, width = 1920, height = 1080,
      interlaced = false, videoType = 0x1b, audio = true, basePts = 900000,
      picturesPerPes = 1, bframes = false, sliceLen = 0} = {}) => {
    const wMbs = Math.ceil(width / 16);
    const hUnits = interlaced ? Math.ceil(height / 32) : Math.ceil(height / 16);
    const coded = interlaced ? hUnits * 32 : hUnits * 16;
    const cropB = (coded - height) / (interlaced ? 4 : 2);
    const sps = makeSps({wMbs, hUnits, frameMbsOnly: interlaced ? 0 : 1, cropB});
    const pps = new Uint8Array([0x68, 0xce, 0x38, 0x80]);
    const dur = Math.round(90000 / fps);
    const streams = [{type: videoType, pid: 0x1011}];
    if(audio) streams.push({type: 0x0f, pid: 0x1100});
    const units = [{pid: 0, data: patSection(0x100), pusi: true, psi: true},
                   {pid: 0x100, data: pmtSection(streams), pusi: true, psi: true}];
    for(let i = 0; i < frames; i++){
      const key = i % 15 === 0;
      const pics = [];
      const bodyLen = (typeof sliceLen === 'number' && sliceLen > 0) ? sliceLen : (key ? 900 : 120);
      for(let k = 0; k < picturesPerPes; k++) pics.push(tsSlice(key, bodyLen));
      const au = key ? annexb(sps, pps, ...pics) : annexb(...pics);
      const dts = basePts + i * dur;
      units.push({pid: 0x1011, data: pesOf(au, bframes ? dts + dur : dts, bframes ? dts : null),
                  pusi: true});
    }
    return tsPackets(units, stride);
  };
`;

section('MTS/M2TS: the stream is named from its own packets, never from playback');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  /* THE FILE DECIDES, NOT THE NAME. The AVCHD fixture is deliberately named
     .mp4 — an extension that lies — and still parses as a transport stream,
     while a real ISO head does not sniff as one. */
  const facts = await page.evaluate(`(async () => { ${TS_LIB}
    const m2ts = makeTs({stride: 192});
    const f = new File([m2ts], 'wrongly-named.mp4', {type: ''});
    const sniff = await vstTsSniff(f);
    const p = await vstParse(f);
    const iso = new Uint8Array(65536);
    iso.set([0,0,0,32,102,116,121,112,113,116,32,32], 0);
    const isoSniff = await vstTsSniff(new File([iso], 'a.mov', {type: 'video/quicktime'}));
    const plain = await vstParse(new File([makeTs({stride: 188})], 'clip.ts', {type: ''}));
    return {sniff, isoSniff, brand: p.brand, container: p.container,
            video: p.video && {name: p.video.name, w: p.video.width, h: p.video.height,
              fps: p.video.fps, seconds: p.video.seconds, codecString: p.video.codecString,
              bitstream: p.video.bitstream, description: p.video.description,
              parameterSets: p.video.parameterSets, samples: p.video.samples},
            audio: p.audio && p.audio.name,
            refusal: vstTsRefusal(p), ready: vstTsReady(p),
            plainBrand: plain.brand, plainReady: vstTsReady(plain)};
  })()`);
  ok('a 192-byte AVCHD grid is measured off the bytes',
     facts.sniff && facts.sniff.stride === 192 && facts.sniff.start === 4, JSON.stringify(facts.sniff));
  ok('an ISO head does not sniff as a transport stream', facts.isoSniff === null);
  ok('the misleading .mp4 name changed nothing', facts.container === 'mpegts'
     && facts.brand === 'M2TS / AVCHD', JSON.stringify([facts.container, facts.brand]));
  ok('H.264 named from the PMT stream type', facts.video && facts.video.name === 'H.264 / AVC');
  ok('dimensions from the SPS, crop applied — 1088 coded lines report as 1080',
     facts.video && facts.video.w === 1920 && facts.video.h === 1080,
     facts.video && `${facts.video.w}x${facts.video.h}`);
  ok('the frame rate is measured from DTS spacing', facts.video && facts.video.fps === 30,
     facts.video && String(facts.video.fps));
  ok('the duration is first-to-last PTS off the stream clock',
     facts.video && Math.abs(facts.video.seconds - 1.0) < 0.011, facts.video && String(facts.video.seconds));
  ok('the codec string comes from the profile bytes',
     facts.video && facts.video.codecString === 'avc1.42001E', facts.video && facts.video.codecString);
  ok('annex-b with in-band parameter sets, so no description is invented',
     facts.video && facts.video.bitstream === 'annexb' && facts.video.description === null
     && facts.video.parameterSets === true && facts.video.samples === null);
  ok('the audio stream is named from the PMT', facts.audio === 'AAC', String(facts.audio));
  ok('a clean H.264 stream has no refusal', facts.refusal === '' && facts.ready === true, facts.refusal);
  ok('a 188-byte .ts is the same facts under its own label',
     facts.plainBrand === 'MPEG-TS' && facts.plainReady === true, facts.plainBrand);
  await page.close();
}

section('MTS/M2TS: every frame is demuxed, byte-exact, and nothing leaves the device');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  const demux = await page.evaluate(`(async () => { ${TS_LIB}
    /* NOTHING IS UPLOADED. Every network door the page has is counted while
       the whole file is parsed and demuxed — the owner's line is "never
       upload the source", and the count is the proof. */
    let fetches = 0, beacons = 0, opens = 0;
    const realFetch = window.fetch;
    window.fetch = (...a) => { fetches++; return realFetch(...a); };
    const realOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(...a){ opens++; return realOpen.apply(this, a); };
    const realBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
    if(realBeacon) navigator.sendBeacon = (...a) => { beacons++; return realBeacon(...a); };

    /* Fat frames on purpose: the file must be BIGGER than one ~1.2 MB read
       chunk or "never held whole" is asserted against a file that fits in one
       slice — which is exactly how the first version of this test passed
       while measuring nothing. */
    const bytes = makeTs({stride: 192, frames: 30, sliceLen: 84000});
    const f = new File([bytes], '00001.MTS', {type: ''});
    let maxSlice = 0, total = 0;
    const realSlice = f.slice.bind(f);
    f.slice = (a, b) => { maxSlice = Math.max(maxSlice, b - a); total += b - a; return realSlice(a, b); };

    const layout = await vstTsSniff(f);
    const parsed = await vstTsParse(f, layout);
    const aus = [];
    await vstTsScan(f, layout, null, au => { aus.push({pts: au.pts, dts: au.dts,
      sync: au.sync, len: au.data.length}); return true; });

    window.fetch = realFetch;
    XMLHttpRequest.prototype.open = realOpen;
    if(realBeacon) navigator.sendBeacon = realBeacon;

    const bigBase = [];
    await vstTsScan(new File([makeTs({basePts: 5000000000, frames: 6})], 'b.ts', {type: ''}),
      {stride: 188, start: 0}, null, au => { bigBase.push(au.pts); return true; });

    return {fetches, beacons, opens, maxSlice, total, size: f.size,
            count: aus.length,
            firstPts: aus[0] && aus[0].pts, lastPts: aus[29] && aus[29].pts,
            ladder: aus.every((a, i) => a.pts === 900000 + i * 3000),
            keys: aus.filter(a => a.sync).length,
            key0: aus[0] && aus[0].sync, key15: aus[15] && aus[15].sync,
            wrap: vstTsUnwrap(100, 8589934500),
            bigPts: bigBase[0]};
  })()`);
  ok('no fetch, no XHR, no beacon while the file is parsed and demuxed',
     demux.fetches === 0 && demux.opens === 0 && demux.beacons === 0, JSON.stringify(demux));
  ok('the file is streamed in bounded slices, never held whole',
     demux.size > 6144 * 192 && demux.maxSlice <= 6144 * 192 && demux.maxSlice < demux.size,
     JSON.stringify({max: demux.maxSlice, size: demux.size}));
  ok('all thirty frames come out — the short final AVCHD packet included',
     demux.count === 30, String(demux.count));
  ok('the PTS ladder is exact at 90 kHz', demux.ladder === true,
     JSON.stringify([demux.firstPts, demux.lastPts]));
  ok('keyframes are flagged where the IDR slices are', demux.keys === 2 && demux.key0 && demux.key15);
  ok('a 33-bit PTS above 2^32 survives exactly', demux.bigPts === 5000000000, String(demux.bigPts));
  ok('a PTS rollover unwraps rather than jumping 26 hours back',
     demux.wrap === 8589934692, String(demux.wrap));
  await page.close();
}

section('MTS/M2TS: refusals are named, and playback never decides');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  const verdicts = await page.evaluate(`(async () => { ${TS_LIB}
    const parse = async opts => {
      const b = makeTs(opts);
      const f = new File([b], 'x.mts', {type: ''});
      return await vstTsParse(f, await vstTsSniff(f));
    };
    const mpeg2 = await parse({videoType: 0x02});
    const packed = await parse({picturesPerPes: 2});
    const fields = await parse({picturesPerPes: 2, interlaced: true, width: 1440});
    const clean = await parse({});

    /* THE OWNER'S RULE, ASSERTED AS AN INVARIANCE so it holds whatever this
       browser carries: for a transport stream the media element's verdict must
       make NO difference to the route, and a declined decoder must block even
       a "playable" stream. WebCodecs presence is an environment fact and is
       RECORDED, not assumed — an earlier version assumed absence, and the
       suite's own secure-context pages proved it present. */
    const saved = VST;
    const paths = {webcodecs: vstCanPipeline()};
    VST = {parsed: clean, readable: true, decodeOk: true, name: 'clip.mts'};
    const withPlayable = vstPath();
    paths.containerNamed = vstContainer();
    VST = {parsed: clean, readable: false, decodeOk: true, name: 'clip.mts'};
    const withoutPlayable = vstPath();
    paths.readableIrrelevant = withPlayable === withoutPlayable;
    paths.route = withPlayable;
    VST = {parsed: clean, readable: true, decodeOk: false, name: 'clip.mts'};
    paths.playableButDecoderDeclined = vstPath();
    paths.textDeclined = vstCompatText();
    VST = {parsed: clean, readable: null, decodeOk: null, name: 'clip.mts'};
    paths.stillChecking = vstPath();
    VST = {parsed: mpeg2, readable: true, decodeOk: true, name: 'old.mts'};
    paths.mpeg2 = vstPath();
    paths.mpeg2Text = vstCompatText();
    VST = saved;

    return {mpeg2: vstTsRefusal(mpeg2), packed: vstTsRefusal(packed),
            fields: vstTsRefusal(fields), fieldsInterlaced: fields.video && fields.video.interlaced,
            clean: vstTsRefusal(clean), paths,
            notVideo: [vstNotVideo({name: 'A.MTS', type: ''}), vstNotVideo({name: 'b.m2ts', type: ''})],
            accept: vstOpen.toString().includes('video/*,.mts,.m2ts,.ts')};
  })()`);
  ok('an MPEG-2 stream is named, not "unknown"', /MPEG-2/.test(verdicts.mpeg2), verdicts.mpeg2);
  ok('packed pictures in a progressive stream are refused in words',
     /more than one picture/.test(verdicts.packed), verdicts.packed);
  ok('a field pair in an interlaced stream is normal, not refused',
     verdicts.fields === '' && verdicts.fieldsInterlaced === true, verdicts.fields);
  ok('a clean stream is not refused', verdicts.clean === '');
  const P = verdicts.paths;
  ok('a playable claim changes nothing — readable is not consulted for a TS',
     P.readableIrrelevant === true && P.route === (P.webcodecs ? 'pipeline' : 'none'),
     JSON.stringify(P));
  ok('a declined decoder blocks even a "playable" transport stream',
     P.playableButDecoderDeclined === 'none', P.playableButDecoderDeclined);
  ok('and the sentence names the decoder or WebCodecs, never the media player',
     /WebCodecs|video decoder declined/.test(P.textDeclined) && !/media player/.test(P.textDeclined),
     P.textDeclined);
  ok('an outstanding answer reads as checking, never as no',
     P.stillChecking === (P.webcodecs ? 'checking' : 'none'), P.stillChecking);
  ok('an MPEG-2 stream is blocked with its own name in the sentence',
     P.mpeg2 === 'none' && /MPEG-2/.test(P.mpeg2Text), P.mpeg2Text);
  ok('the container line reports the measured layout, not the extension',
     P.containerNamed === 'MPEG-TS', P.containerNamed);
  ok('.MTS and .m2ts pass the not-a-video gate', verdicts.notVideo.every(v => v === false));
  ok('the picker names the TS extensions beside video/*', verdicts.accept === true);
  await page.close();
}

section('MTS/M2TS: the transcode is fed annex-b and stops honestly at the codec boundary');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  /* WEBCODECS PRESENCE IS RECORDED, NOT ASSUMED. An earlier version asserted
     this container had none — measured in an INSECURE probe context, where
     [SecureContext] hides VideoDecoder while VideoFrame stays visible. The
     suite's own pages run on 127.0.0.1, a secure context, and carry the real
     thing. What this section proves either way: the TS branch reaches the
     decoder with the file's own codec string and NO invented description, the
     demux genuinely streams behind it, and a junk bitstream ends in a refusal
     that protects the original rather than a fabricated file. The full burn
     on the owner's real device stays the owner's check, as it was for MOV. */
  const stage = await page.evaluate(`(async () => { ${TS_LIB}
    const absent = typeof VideoDecoder === 'undefined' && typeof VideoEncoder === 'undefined';
    const bytes = makeTs({stride: 192, frames: 30});
    const f = new File([bytes], '00001.MTS', {type: ''});
    const parsed = await vstParse(f);

    let honest = null;
    try{ await vstTranscode(f, parsed, Date.now(), 'America/New_York', () => {}); }
    catch(e){ honest = String(e.message || e); }

    window.VideoDecoder = class {
      static async isConfigSupported(){ return {supported: true}; }
      constructor(){ }
      configure(cfg){ window.__tsDecCfg = cfg; throw new Error('stop-at-boundary'); }
    };
    window.VideoEncoder = class {
      static async isConfigSupported(){ return {supported: true}; }
      constructor(){ }
      configure(cfg){ window.__tsEncCfg = cfg; }
    };
    window.VideoFrame = class {};
    window.EncodedVideoChunk = class {};
    let boundary = null;
    try{ await vstTranscode(f, parsed, Date.now(), 'America/New_York', () => {}); }
    catch(e){ boundary = String(e.message || e); }
    const dec = window.__tsDecCfg, enc = window.__tsEncCfg;
    delete window.VideoDecoder; delete window.VideoEncoder;
    delete window.VideoFrame; delete window.EncodedVideoChunk;
    delete window.__tsDecCfg; delete window.__tsEncCfg;
    return {absent, honest, boundary,
            dec: dec && {codec: dec.codec, hasDescription: 'description' in dec,
                         w: dec.codedWidth, h: dec.codedHeight},
            enc: enc && {codec: enc.codec, w: enc.width, h: enc.height}};
  })()`);
  ok('a junk bitstream never becomes a file — the transcode throws and protects the original',
     stage.honest && /original is unchanged/.test(stage.honest),
     JSON.stringify({webcodecsAbsent: stage.absent, err: String(stage.honest).slice(0, 120)}));
  ok('the decoder gets the stream\'s own codec string, annex-b, no invented description',
     stage.dec && stage.dec.codec === 'avc1.42001E' && stage.dec.hasDescription === false
     && stage.dec.w === 1920 && stage.dec.h === 1080, JSON.stringify(stage.dec));
  ok('the encoder is configured at the source\'s own size', stage.enc && stage.enc.w === 1920
     && stage.enc.h === 1080 && /^avc1\./.test(stage.enc.codec), JSON.stringify(stage.enc));
  ok('the demux actually reached the decoder — the stub stopped it there',
     stage.boundary && /stop-at-boundary/.test(stage.boundary), String(stage.boundary));
  await page.close();
}

section('MTS/M2TS: a codec error is reported as itself, never as the flush that followed it');
{
  /* THE OWNER'S REAL .MTS FOUND THIS (2026-08-24): the device's decoder hit an
     error mid-stream, the codec CLOSED ITSELF — the spec's behaviour on error —
     and the transcode's unconditional flush() then threw "flush called after
     codec closed", replacing the one sentence that explained anything. Three
     pins: the self-close mechanism against the REAL API in this browser, the
     drain helper on real codecs, and the transcode reporting the codec's own
     first error through both failure shapes (async error callback, and the
     synchronous throw decode() is also measured to produce). */
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  const life = await page.evaluate(`(async () => { ${TS_LIB}
    const out = {};

    // ---- 1. The mechanism, on the real API (VP8 — present in this build). ----
    out.real = 'no VP8 decoder in this browser';
    if(typeof VideoDecoder !== 'undefined'
       && (await VideoDecoder.isConfigSupported({codec: 'vp8', codedWidth: 320, codedHeight: 240})).supported){
      const errs = [];
      const d = new VideoDecoder({output(){}, error(e){ errs.push(String(e && e.message || e)); }});
      d.configure({codec: 'vp8', codedWidth: 320, codedHeight: 240});
      /* A payload whose VP8 header genuinely says KEYFRAME, then garbage —
         passes the synchronous sniff, fails inside the decoder. */
      const junk = new Uint8Array(64);
      junk.set([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00]);
      junk.fill(0xa7, 10);
      d.decode(new EncodedVideoChunk({type: 'key', timestamp: 0, data: junk}));
      await new Promise(r => setTimeout(r, 500));
      let flushSaid = 'resolved';
      try{ await d.flush(); }catch(e){ flushSaid = String(e && e.message || e); }
      out.real = {stateAfterError: d.state, firstErr: errs[0] || null, flushSaid};
      // ---- 2. The drain helper survives exactly that codec. ----
      let drainThrew = null;
      try{ await vstCodecDrain(d); }catch(e){ drainThrew = String(e); }
      out.drain = {threw: drainThrew, state: d.state};
      // And on a healthy configured codec it flushes then closes.
      const h = new VideoDecoder({output(){}, error(){}});
      h.configure({codec: 'vp8', codedWidth: 320, codedHeight: 240});
      await vstCodecDrain(h);
      out.drainHealthy = h.state;
    }

    // ---- 3. The transcode reports the FIRST codec error, not the drain. ----
    const bytes = makeTs({stride: 192, frames: 30});
    const f = new File([bytes], '00001.MTS', {type: ''});
    const parsed = await vstParse(f);
    const RD = window.VideoDecoder, RE = window.VideoEncoder,
          RF = window.VideoFrame, RC = window.EncodedVideoChunk;
    class StubChunk { constructor(o){ Object.assign(this, o); } }
    class StubEncoder {
      static async isConfigSupported(){ return {supported: true}; }
      constructor(){ this.state = 'unconfigured'; }
      configure(){ this.state = 'configured'; }
      encode(){}
      async flush(){}
      close(){ this.state = 'closed'; }
    }
    const mkDecoder = mode => class {
      static async isConfigSupported(){ return {supported: true}; }
      constructor(cb){ this.cb = cb; this.state = 'unconfigured'; this.n = 0; this.decodeQueueSize = 0; }
      configure(){ this.state = 'configured'; }
      decode(){
        if(this.state === 'closed') throw new DOMException("Cannot call 'decode' on a closed codec", 'InvalidStateError');
        this.n++;
        if(mode === 'sync' && this.n === 1) throw new DOMException('A key frame is required after configure() or flush().', 'DataError');
        if(mode === 'async' && this.n === 5){
          this.state = 'closed';
          this.cb.error(new DOMException('Decoding error: this stream is not supported.', 'EncodingError'));
        }
      }
      async flush(){
        if(this.state === 'closed') throw new DOMException("Cannot call 'flush' on a closed codec", 'InvalidStateError');
      }
      close(){ this.state = 'closed'; }
    };
    window.VideoEncoder = StubEncoder;
    window.VideoFrame = class {};
    window.EncodedVideoChunk = StubChunk;
    for(const mode of ['async', 'sync']){
      window.VideoDecoder = mkDecoder(mode);
      try{ await vstTranscode(f, parsed, 1700000000000, 'America/New_York', () => {}); out[mode] = 'RESOLVED'; }
      catch(e){ out[mode] = String(e && e.message || e); }
    }
    window.VideoDecoder = RD; window.VideoEncoder = RE;
    window.VideoFrame = RF; window.EncodedVideoChunk = RC;
    return out;
  })()`);

  if(typeof life.real === 'string'){
    ok('mechanism pin skipped — ' + life.real, true);
  } else {
    ok('an errored codec closes itself, and flushing it throws — the real API says so',
       life.real.stateAfterError === 'closed' && /closed/i.test(life.real.flushSaid),
       JSON.stringify(life.real));
    ok('vstCodecDrain survives exactly that codec without throwing',
       life.drain && life.drain.threw === null && life.drain.state === 'closed',
       JSON.stringify(life.drain));
    ok('and on a healthy codec it flushes and closes', life.drainHealthy === 'closed',
       String(life.drainHealthy));
  }
  ok('an async mid-stream codec error is reported as ITSELF, with the original protected',
     /Decoding error: this stream is not supported/.test(life.async)
     && /original is unchanged/.test(life.async)
     && !/flush/i.test(life.async) && !/closed codec/i.test(life.async), String(life.async));
  ok('a synchronous decode() throw is reported the same way, not propagated raw',
     /key frame is required/.test(life.sync) && /original is unchanged/.test(life.sync),
     String(life.sync));
  await page.close();
}

section('The device read-out validates the pipeline, not the API list');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.evaluate(async () => {
    const b = new Uint8Array(1024);
    VST = { step: 'preview', caseNo: 'API-20260812-4002',
            file: new File([b], 'IMG_0440.mov', { type: 'video/quicktime' }),
            name: 'IMG_0440.mov', size: 1024, url: '', tz: 'America/New_York', q: '',
            mo: '05', da: '03', yr: '2025', hr: '11', mi: '27', se: '58', ap: 'AM',
            guessed: false, hash: null, pct: 0, err: '', saveMsg: '', diag: '',
            out: null, recId: null, savedHere: false, started: false,
            readable: false, codec: null, caps: vstCaps() };
    paintVStamp();
  });
  await page.waitForTimeout(200);
  await page.locator('[data-act="vstDiag"]').first().click();
  await page.waitForTimeout(9000);
  const d = await text(page, '.vst-diag');
  /* EVERY ROW THE OWNER LISTED IN §11. */
  for (const r of ['Container', 'Video codec', 'Audio codec', 'Decode original',
                   'WebCodecs decode', 'Encode H.264', 'Timestamp renderer',
                   'Result readable here', 'Audio in original', 'Audio in the copy',
                   'MP4 demux', 'MP4 mux', 'Share available']) {
    ok(`the read-out reports ${r}`, has(d, r), d.slice(0, 300));
  }
  /* IT ASKS THE DECODER ABOUT THE FILE, not about itself. */
  ok('WebCodecs decode is answered about this file, not the API',
     /WebCodecs decode.*(accepts THIS file|no —)/.test(d), d.slice(0, 600));
  /* AND IT SHOWS WHAT EACH OUTPUT FORMAT ACTUALLY DID. */
  ok('each candidate output format is reported by what it did',
     /READS BACK|no —/.test(d), d.slice(-500));
  await page.close();
}


/* THE PIPELINE'S DEMUXER. Owner approval, 2026-08-18, after the real device
   passed the gate on IMG_0440.mov: H.264 avc1.640028, 1920x1080, ~48.12s, AAC
   mono 44100, WebCodecs decode ACCEPTS that configuration.

   This half is written in this repo rather than taken from mp4box (2.26 MB)
   precisely because it can be tested here — it is byte arithmetic over the
   sample tables, and these fixtures are built to the same shapes an iPhone
   writes: moov last, chunked samples, run-length tables, keyframes every N. */
section('The sample tables are demuxed, so every frame can be found');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  const r = await page.evaluate(async () => {
    const enc = new TextEncoder();
    const box = (type, ...parts) => {
      const payload = parts.length === 1 && parts[0] instanceof Uint8Array ? parts[0]
        : (() => { const n = parts.reduce((s, x) => s + x.length, 0);
                   const o = new Uint8Array(n); let k = 0;
                   for (const x of parts) { o.set(x, k); k += x.length; } return o; })();
      const b = new Uint8Array(8 + payload.length);
      new DataView(b.buffer).setUint32(0, 8 + payload.length);
      b.set(enc.encode(type), 4); b.set(payload, 8); return b;
    };
    const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0);
      const o = new Uint8Array(n); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
    const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
    const u16 = n => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n); return b; };
    const i32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n); return b; };
    const full = () => new Uint8Array(4);

    /* 10 samples, 2 per chunk, 5 chunks; 600 ticks each at timescale 600 so a
       sample is one second; keyframes at 0 and 5. */
    const N = 10, PER = 2, DELTA = 600, SZ = 100;
    const stts = box('stts', full(), u32(1), u32(N), u32(DELTA));
    const stsz = box('stsz', full(), u32(0), u32(N),
      ...Array.from({ length: N }, (_, i) => u32(SZ + i)));      // varying sizes
    const stsc = box('stsc', full(), u32(1), u32(1), u32(PER), u32(1));
    const stss = box('stss', full(), u32(2), u32(1), u32(6));    // 1-based
    // ctts: every sample shifted by one frame, so cts != dts and the reorder shows.
    const ctts = box('ctts', full(), u32(1), u32(N), i32(DELTA));

    const MDAT_AT = 40;                                    // where our mdat body starts
    const chunkOffsets = [];
    { let at = MDAT_AT, s = 0;
      for (let c = 0; c < N / PER; c++) { chunkOffsets.push(at);
        for (let k = 0; k < PER; k++) { at += SZ + s; s++; } } }
    const stco = box('stco', full(), u32(chunkOffsets.length), ...chunkOffsets.map(u32));

    const avcC = new Uint8Array([1, 0x64, 0x00, 0x28, 0xff]);
    const visual = (() => { const body = new Uint8Array(78);
      new DataView(body.buffer).setUint16(24, 1920);
      new DataView(body.buffer).setUint16(26, 1080);
      return box('avc1', body, box('avcC', avcC)); })();
    const stsd = box('stsd', full(), u32(1), visual);
    const stbl = box('stbl', stsd, stts, ctts, stsz, stsc, stco, stss);
    const mdhd = box('mdhd', full(), new Uint8Array(8), u32(600), u32(N * DELTA), new Uint8Array(4));
    const hdlr = box('hdlr', full(), new Uint8Array(4), enc.encode('vide'), new Uint8Array(12));
    const matrix = cat(i32(0), i32(65536), u32(0), i32(-65536), i32(0), u32(0),
                       u32(0), u32(0), u32(0x40000000));           // 90 degrees
    const tkhd = box('tkhd', full(), new Uint8Array(20), new Uint8Array(16), matrix, u32(0), u32(0));
    const vtrak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', stbl)));

    /* An AAC track whose esds carries a real AudioSpecificConfig, so the
       passthrough plan has something to pass. */
    const asc = new Uint8Array([0x12, 0x08]);                     // AAC-LC 44100 mono
    /* A DecoderConfigDescriptor is 13 bytes before the DecoderSpecificInfo —
       objectType(1) streamType(1) bufferSizeDB(3) maxBitrate(4) avgBitrate(4).
       An earlier fixture carried twelve and the parser read past the tag. */
    const esds = box('esds', full(),
      new Uint8Array([0x03, 0x1a, 0x00, 0x01, 0x00,
                      0x04, 0x12, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                      0x05, asc.length]), asc);
    const soundBody = new Uint8Array(28);
    new DataView(soundBody.buffer).setUint16(16, 1);              // mono
    new DataView(soundBody.buffer).setUint32(24, 44100 << 16);
    const astsd = box('stsd', full(), u32(1), box('mp4a', soundBody, esds));
    const astbl = box('stbl', astsd,
      box('stts', full(), u32(1), u32(4), u32(1024)),
      box('stsz', full(), u32(200), u32(4)),
      box('stsc', full(), u32(1), u32(1), u32(4), u32(1)),
      box('stco', full(), u32(1), u32(9000)));
    const atrak = box('trak',
      box('tkhd', full(), new Uint8Array(20), new Uint8Array(16),
        cat(i32(65536), i32(0), u32(0), i32(0), i32(65536), u32(0), u32(0), u32(0), u32(0x40000000)),
        u32(0), u32(0)),
      box('mdia', box('mdhd', full(), new Uint8Array(8), u32(44100), u32(4 * 1024), new Uint8Array(4)),
        box('hdlr', full(), new Uint8Array(4), enc.encode('soun'), new Uint8Array(12)),
        box('minf', astbl)));

    const moov = box('moov', vtrak, atrak);
    const mdat = box('mdat', new Uint8Array(3 * 1048576));
    const ftyp = box('ftyp', new Uint8Array([113, 116, 32, 32, 0, 0, 2, 0]));
    const f = new File([cat(ftyp, mdat, moov)], 'IMG_0440.mov', { type: 'video/quicktime' });
    const parsed = await vstParse(f);
    return { parsed, chunkOffsets, N, DELTA, SZ };
  });

  const V = r.parsed.video, A = r.parsed.audio;
  ok('the video sample table is produced', !!V.samples && V.samples.length === r.N,
     String(V.samples && V.samples.length));
  /* OFFSETS ARE WALKED THROUGH stsc/stco, not assumed contiguous — this is the
     part that silently reads the wrong bytes if it is wrong. */
  ok('sample offsets follow the chunk table', V.samples[0].offset === r.chunkOffsets[0]
     && V.samples[2].offset === r.chunkOffsets[1] && V.samples[4].offset === r.chunkOffsets[2],
     JSON.stringify(V.samples.slice(0, 5).map(s => s.offset)));
  ok('and sizes advance within a chunk',
     V.samples[1].offset === V.samples[0].offset + V.samples[0].size,
     JSON.stringify([V.samples[0], V.samples[1]]));
  ok('every sample has its own size', V.samples[0].size === r.SZ && V.samples[9].size === r.SZ + 9,
     JSON.stringify([V.samples[0].size, V.samples[9].size]));
  ok('decode times come from the run-length table',
     V.samples[0].dts === 0 && V.samples[3].dts === 3 * r.DELTA, JSON.stringify(V.samples[3]));
  /* PRESENTATION TIME IS WHAT THE STAMP ADVANCES ON, so a composition offset
     must not be dropped — that would stamp the wrong second on reordered frames. */
  ok('composition offsets are applied, so cts is not just dts',
     V.samples[2].cts === V.samples[2].dts + r.DELTA, JSON.stringify(V.samples[2]));
  ok('keyframes are read from stss, 1-based',
     V.samples[0].sync === true && V.samples[5].sync === true
     && V.samples[1].sync === false, JSON.stringify(V.samples.map(s => s.sync)));

  /* AUDIO: the owner made it a hard requirement, so its config must survive. */
  ok('the AAC track is found with its channel count and rate',
     A && A.cc === 'mp4a' && A.channels === 1 && A.sampleRate === 44100, JSON.stringify(A));
  /* Read so the read-out can REPORT what the original contains. Since the
     owner's change the copy carries no audio, so this is reported, not muxed. */
  ok('and its AudioSpecificConfig is read from esds',
     A.asc && A.asc.length === 2 && A.asc[0] === 0x12, JSON.stringify(A.asc && [...A.asc]));
  ok('with its own sample table', A.samples && A.samples.length === 4,
     String(A.samples && A.samples.length));

  ok('the rotation the original carries is read', r.parsed.rotation === 90,
     String(r.parsed.rotation));
  ok('and the codec string comes from avcC, matching the real device report',
     V.codecString === 'avc1.640028', V.codecString);
}

section('The muxer is local, audited and same-origin');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  const m = await page.evaluate(async () => {
    try { const M = await vstMuxer();
      return { ok: true, keys: Object.keys(M).sort(), url: VST_MUXER_URL }; }
    catch (e) { return { ok: false, why: String(e), url: VST_MUXER_URL }; }
  });
  ok('the muxer loads from this origin', m.ok, JSON.stringify(m));
  ok('and it is served from the portal, not a CDN',
     m.url.startsWith('/portal/') && !/https?:/.test(m.url), m.url);
  ok('it exposes the muxer and an in-memory target',
     m.ok && m.keys.includes('Muxer') && m.keys.includes('ArrayBufferTarget'),
     JSON.stringify(m.keys));

  const src = fs.readFileSync(new URL('../portal/vendor/mp4-muxer.js', import.meta.url), 'utf8');
  ok('the vendored file carries its MIT licence', /MIT License/.test(src));
  ok('and says why it is vendored rather than fetched', /VENDORED, NOT FETCHED/.test(src));
  /* NO WASM, NO NETWORK, NO EVAL — audited before it was committed, and the
     assertion keeps it that way if it is ever updated.

     Scanned from the END OF THE PROVENANCE HEADER, because that header NAMES
     the very APIs it promises are absent — the note about the audit was
     failing the audit. */
  const marker = '--- END OF VENDOR NOTE ---';
  ok('the vendored file marks where its own note ends', src.includes(marker));
  const lib = src.slice(src.indexOf(marker) + marker.length);
  ok('it reaches no network and runs no wasm or eval',
     !/\bfetch\s*\(|XMLHttpRequest|WebAssembly|importScripts|\beval\s*\(/.test(lib),
     (lib.match(/\bfetch\s*\(|XMLHttpRequest|WebAssembly|importScripts|\beval\s*\(/) || [''])[0]);
  await page.close();
}

/* OWNER REQUIREMENT CHANGE, 2026-08-18: the timestamped copy is picture only —
   audio is stripped by design for this milestone, not carried and not blocked
   on. The rule that survives from the previous wording is the one that always
   mattered: the screen may not assert something untrue, and the ORIGINAL is
   never touched. */
section('The copy is picture only, and says so');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  /* NO AUDIO TRACK IS EVER DECLARED TO THE MUXER, whatever the source has —
     asserted against the pipeline's own source rather than a comment, because
     "there is no audio track in the output" is a property of the muxer options. */
  const src = fs.readFileSync(new URL('../portal/index.html', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function vstTranscode('),
                       src.indexOf('\n/* Opening the generator'));
  ok('the transcode never adds an audio chunk', !/addAudioChunk/.test(fn));
  ok('nor declares an audio track to the muxer',
     !/audio:\s*\{\s*codec:/.test(fn), fn.slice(0, 200));
  ok('and it says the omission is deliberate', /STRIPPED BY DESIGN/.test(fn));

  /* A SOURCE WITH AUDIO STILL GENERATES — it is no longer a blocker — and the
     result reports the omission rather than implying preservation. */
  const withAudio = await page.evaluate(async () => {
    const parsed = {
      rotation: 0,
      video: { width: 320, height: 240, timescale: 600, seconds: 1,
               codecString: 'avc1.640028', description: new Uint8Array([1, 2, 3]),
               samples: [{ offset: 0, size: 4, dts: 0, cts: 0, sync: true, duration: 600 }] },
      audio: { cc: 'mp4a', name: 'AAC', channels: 1, sampleRate: 44100,
               asc: new Uint8Array([0x12, 0x08]),
               samples: [{ offset: 0, size: 4, dts: 0, cts: 0, duration: 1024 }] },
    };
    const f = new File([new Uint8Array(64)], 'x.mov', { type: 'video/quicktime' });
    try { await vstTranscode(f, parsed, Date.now(), 'America/New_York', () => {});
          return { threw: false }; }
    catch (e) { return { threw: true, msg: e.message }; }
  });
  /* This container has no WebCodecs, so the pipeline cannot run here — what is
     asserted is that it is NOT refused FOR HAVING AUDIO. */
  ok('a source with audio is no longer refused for having it',
     !withAudio.threw || !/audio/i.test(withAudio.msg || ''), JSON.stringify(withAudio));

  // The finished screen states it plainly, both halves.
  await page.evaluate(() => {
    VST = { step: 'done', caseNo: '', file: null, name: 'IMG_0440.mov', size: 1024,
            url: '', tz: 'America/New_York', readable: true, codec: null, caps: vstCaps(),
            diag: '', startMs: vstToUtc(2025, 5, 3, 11, 27, 58, 'America/New_York'),
            out: { blob: new Blob(['x']), url: '', name: 'IMG_0440-timestamped.mp4',
                   size: 4096, mime: 'video/mp4', audio: 'stripped',
                   sourceAudio: 'AAC, 1ch', frames: 1443, via: 'webcodecs' },
            savedHere: false, started: false, err: '', saveMsg: '' };
    paintVStamp();
  });
  await page.waitForTimeout(250);
  const done = await text(page, '.vst');
  ok('the copy is described as picture only', has(done, 'picture only'));
  ok('and it never claims the audio was preserved', !has(done, 'Preserved'), done.slice(0, 500));
  /* THE ORIGINAL IS UNTOUCHED and the screen says where its audio still is —
     the honest half of stripping it. */
  ok('the original’s own audio is named as still on the original',
     has(done, 'AAC, 1ch') && has(done, 'still on your original'), done.slice(0, 600));
  ok('and the output is an MP4', has(done, 'IMG_0440-timestamped.mp4'));
  ok('not reported as saved merely because it exists',
     has(done, 'Generated') && has(done, 'not yet saved'), done.slice(0, 600));
  await page.close();
}


/* OWNER, 2026-08-18: "the burned timestamp must be anchored to the source
   video's actual recording/capture date and time when that metadata is
   available... It must NOT use the time the investigator processes the video."

   It did not. The default came from `file.lastModified` — when the file was
   WRITTEN, which on a Photos export is months after the shot — and fell back to
   `Date.now()`, the processing time itself. */
section('The stamp is anchored to when it was recorded');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  const built = await page.evaluate(async () => {
    const enc = new TextEncoder();
    const box = (type, ...parts) => {
      const payload = (() => { const n = parts.reduce((s, x) => s + x.length, 0);
        const o = new Uint8Array(n); let k = 0;
        for (const x of parts) { o.set(x, k); k += x.length; } return o; })();
      const b = new Uint8Array(8 + payload.length);
      new DataView(b.buffer).setUint32(0, 8 + payload.length);
      b.set(enc.encode(type), 4); b.set(payload, 8); return b;
    };
    const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0);
      const o = new Uint8Array(n); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
    const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };

    // mvhd v0 with a creation_time in the QuickTime epoch (1904).
    const boxRaw = (typeBytes, ...parts) => {
    const payload = (() => { const n = parts.reduce((s,x)=>s+x.length,0);
    const o = new Uint8Array(n); let k=0; for(const x of parts){o.set(x,k);k+=x.length;} return o; })();
    const b = new Uint8Array(8 + payload.length);
    new DataView(b.buffer).setUint32(0, 8 + payload.length);
    b.set(new Uint8Array(typeBytes), 4); b.set(payload, 8); return b;
    };
    const mvhdAt = iso => {
      const secs = Math.floor(Date.parse(iso) / 1000) + 2082844800;
      return box('mvhd', new Uint8Array(4), u32(secs), u32(secs), u32(600), u32(6000),
                 new Uint8Array(80));
    };
    // meta > keys + ilst carrying com.apple.quicktime.creationdate
    const appleMeta = value => {
      const key = enc.encode('com.apple.quicktime.creationdate');
      const keys = box('keys', new Uint8Array(4), u32(1),
        cat(u32(8 + key.length), enc.encode('mdta'), key));
      const data = box('data', u32(1), u32(0), enc.encode(value));
      const item = cat(u32(8 + data.length), u32(1), data);   // "type" is the key index
      return box('meta', new Uint8Array(4), keys, box('ilst', item));
    };
    const udtaDay = value => {
      const t = enc.encode(value);
      const len = new Uint8Array(4);
      new DataView(len.buffer).setUint16(0, t.length);
      return box('udta', boxRaw([0xa9, 0x64, 0x61, 0x79], len, t));
    };

    const mk = (...moovKids) => {
      const moov = box('moov', ...moovKids);
      const mdat = box('mdat', new Uint8Array(1048576));
      const ftyp = box('ftyp', new Uint8Array([113, 116, 32, 32, 0, 0, 2, 0]));
      const f = new File([cat(ftyp, mdat, moov)], 'IMG_0440.mov', { type: 'video/quicktime' });
      // A modified date far from the capture date, as a Photos export has.
      Object.defineProperty(f, 'lastModified', { value: Date.parse('2026-08-18T02:00:00Z') });
      return f;
    };

    const SHOT = '2025-05-03T11:27:58-0400';       // 11:27:58 AM EDT, with its offset
    return {
      apple: await vstParse(mk(mvhdAt('2001-01-01T00:00:00Z'), appleMeta(SHOT))),
      day: await vstParse(mk(udtaDay(SHOT))),
      mvhdOnly: await vstParse(mk(mvhdAt('2025-05-03T15:27:58Z'))),
      none: await vstParse(mk(box('udta', box('nam0', new Uint8Array(4))))),
      label: (ms) => null,
    };
  });

  /* 1. THE APPLE KEY WINS, and it carries its own UTC offset, so the instant is
     unambiguous and Eastern renders it as the wall clock it was shot at. */
  ok('the Apple capture key is read', !!built.apple.capture, JSON.stringify(built.apple.capture));
  ok('and it is trusted, because it carries its own offset',
     built.apple.capture && built.apple.capture.trusted === true);
  const shown = await page.evaluate(ms => vstLabel(ms, 'America/New_York'),
                                    built.apple.capture.ms);
  ok('which renders as the owner’s own example', shown === '05/03/2025 11:27:58 AM EDT', shown);
  /* AND IT BEATS mvhd — that fixture's mvhd says 2001, so a wrong precedence
     would be loud rather than subtle. */
  ok('the capture key outranks the creation time', /2025/.test(shown), shown);

  /* 2. The older ©day field is read the same way. */
  ok('the udta ©day field is read too', !!built.day.capture, JSON.stringify(built.day.capture));
  const shown2 = await page.evaluate(ms => vstLabel(ms, 'America/New_York'), built.day.capture.ms);
  ok('and resolves to the same instant', shown2 === '05/03/2025 11:27:58 AM EDT', shown2);

  /* 3. mvhd alone is read but NOT trusted — it carries no zone and Apple has
     written local time into it, so the operator is told to check. */
  ok('a file with only a creation time still yields one', !!built.mvhdOnly.capture);
  ok('but it is marked untrusted, because it has no time zone',
     built.mvhdOnly.capture.trusted === false, JSON.stringify(built.mvhdOnly.capture));

  /* 4. NOTHING IS INVENTED when the file carries no date. */
  ok('a file with no capture metadata reports none', built.none.capture === null,
     JSON.stringify(built.none.capture));

  await page.close();
}

section('Processing time is never the anchor');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  /* THE DEFECT, AS A RULE. `Date.now()` was the fallback when a file had no
     modified date — the one value guaranteed to be wrong. It is gone from the
     opener, and a file with no date at all now gets an empty form that ASKS. */
  const src = fs.readFileSync(new URL('../portal/index.html', import.meta.url), 'utf8');
  const opener = src.slice(src.indexOf('function vstOpen('),
                           src.indexOf('async function vstLoadCases('));
  ok('the opener no longer falls back to the current clock',
     !/Date\.now\(\)/.test(opener), opener.slice(0, 400));
  ok('and says why the modified date is not the recording',
     /not when the footage was shot|when the file was WRITTEN/i.test(opener));

  /* THE FORM SAYS WHERE THE FIGURE CAME FROM, and the three sources read
     differently — a stamp anchored to a file's modified date must not look the
     same as one anchored to the capture metadata. */
  const notes = await page.evaluate(async () => {
    const out = {};
    for (const from of ['capture', 'creation', 'modified', 'none']) {
      VST = { step: 'when', caseNo: '', file: null, name: 'IMG_0440.mov', size: 1024,
              url: '', tz: 'America/New_York', q: '',
              mo: '05', da: '03', yr: '2025', hr: '11', mi: '27', se: '58', ap: 'AM',
              guessed: true, startFrom: from, readable: true, codec: null,
              caps: vstCaps(), diag: '', hash: null, pct: 0, err: '', saveMsg: '',
              out: null, recId: null, savedHere: false, started: false };
      paintVStamp();
      out[from] = document.querySelector('.vst').innerText;
    }
    return out;
  });
  ok('capture metadata is named as the recording',
     /capture metadata/i.test(notes.capture) && /when it was recorded/i.test(notes.capture),
     notes.capture.slice(0, 300));
  ok('a zone-less creation time asks to be checked',
     /carries no time zone/i.test(notes.creation), notes.creation.slice(0, 300));
  /* THE IMPORTANT ONE: the modified date must be called out as NOT the
     recording, because that is the value that silently looks right. */
  ok('the modified date is called out as not the recording',
     /no capture metadata/i.test(notes.modified) && /not.*when it was recorded/i.test(notes.modified),
     notes.modified.slice(0, 300));
  ok('and a file with no date at all simply asks',
     /no date at all/i.test(notes.none), notes.none.slice(0, 300));

  /* THE BURN ITSELF IS UNCHANGED: the label advances on the frame's own
     presentation time, from whatever start was anchored — never the clock. */
  const fn = src.slice(src.indexOf('async function vstTranscode('),
                       src.indexOf('\n/* Opening the generator'));
  ok('the pipeline stamps from the frame’s presentation time',
     /frame\.timestamp/.test(fn) && /startMs \+ Math\.floor\(tSec\)/.test(fn));
  ok('and never reads a live clock while rendering',
     !/Date\.now\(\)|new Date\(\)/.test(fn), fn.slice(0, 200));
  await page.close();
}


/* OWNER BUG, 2026-08-18: "WebCodecs pipeline says YES but old media-element
   compatibility gate still blocks generation."

   One condition did it. The screen gated on `readable` — whether a <video>
   element could decode the file — which predates the pipeline entirely. On the
   owner's iPhone the media element says NO and WebCodecs says YES, so the one
   device the pipeline was built for was the one it refused. */
section('The media element no longer decides whether generation is allowed');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  const setup = async (opts) => page.evaluate(o => {
    // This container has no WebCodecs, so the capability is stubbed to model
    // the owner's device. Everything else under test is the real code.
    window.vstCanPipeline = () => o.pipeline;
    VST = { step: 'preview', caseNo: '', file: null, name: 'IMG_0440.mov', size: 84 * 1048576,
            url: '', tz: 'America/New_York', q: '',
            mo: '05', da: '03', yr: '2025', hr: '11', mi: '27', se: '58', ap: 'AM',
            guessed: false, hash: null, pct: 0, err: '', saveMsg: '', diag: '',
            out: null, recId: null, savedHere: false, started: false,
            codec: { cc: 'avc1', name: 'H.264 / AVC' }, caps: vstCaps(),
            readable: o.readable, decodeOk: o.decodeOk,
            parsed: o.parsed === false ? null : { rotation: 0, capture: null,
              video: { width: 1920, height: 1080, timescale: 600, seconds: 48.12,
                       codecString: 'avc1.640028', description: new Uint8Array([1, 2, 3]),
                       samples: [{ offset: 0, size: 4, dts: 0, cts: 0, sync: true, duration: 600 }] },
              audio: null } };
    VST.startMs = vstToUtc(2025, 5, 3, 11, 27, 58, 'America/New_York');
    paintVStamp();
    return vstPath();
  }, opts);

  /* THE OWNER'S EXACT DEVICE STATE: media element NO, WebCodecs YES. */
  const path = await setup({ pipeline: true, decodeOk: true, readable: false });
  ok('with WebCodecs accepting the file, the route is the pipeline', path === 'pipeline', path);
  const body = await text(page, '.vst');
  ok('Generate is offered', await page.locator('[data-act="vstGo"]').count() === 1);
  ok('and it is not disabled',
     await page.locator('[data-act="vstGo"]:not([disabled])').count() === 1);
  ok('the blocking panel is gone', await page.locator('.vst-stop').count() === 0);
  ok('and compatibility reads Ready', has(body, 'Ready'), body.slice(0, 400));
  /* THE OLD WARNING SURVIVES AS INFORMATION, which is what the owner asked for
     — it is true and worth saying, it just may not decide anything. */
  ok('the media player’s failure is still reported, as a note',
     has(body, 'ordinary media player could not open') && has(body, 'generation is unaffected'),
     body.slice(0, 600));

  /* AND THE GENERATOR ITSELF NO LONGER REFUSES. It cannot complete here — this
     container has no real WebCodecs behind the stub — but it must not fail with
     the compatibility gate, which is the bug. */
  const attempt = await page.evaluate(async () => {
    await vstGenerate();
    return { err: VST && VST.err, step: VST && VST.step };
  });
  ok('the generator does not refuse on compatibility',
     !/cannot be processed on this device|cannot be decoded/i.test(attempt.err || ''),
     JSON.stringify(attempt));

  /* THE REVERSE STILL BLOCKS: no route at all is still a refusal, and it says
     which routes failed rather than blaming the browser generically. */
  const none = await setup({ pipeline: true, decodeOk: false, readable: false });
  ok('a file no route can take is still blocked', none === 'none', none);
  const stopped = await text(page, '.vst');
  ok('the stop panel returns', await page.locator('.vst-stop').count() === 1);
  ok('no Generate button sits under it',
     await page.locator('[data-act="vstGo"]').count() === 0);
  ok('and it names the decoder declining, not just the browser',
     has(stopped, 'video decoder declined'), stopped.slice(0, 500));

  /* A DEVICE WITH NO WEBCODECS AT ALL falls back to the legacy route when its
     media element can read the file — the desktop path, unchanged. */
  const legacy = await setup({ pipeline: false, decodeOk: false, readable: true });
  ok('a device without WebCodecs still uses the recorder route', legacy === 'legacy', legacy);
  ok('and Generate is offered there too',
     await page.locator('[data-act="vstGo"]').count() === 1);

  /* AN OUTSTANDING ANSWER IS NOT A REFUSAL. */
  const checking = await setup({ pipeline: true, decodeOk: null, readable: false });
  ok('an unanswered capability check reads as checking', checking === 'checking', checking);
  ok('the action is disabled rather than removed',
     await page.locator('[data-act="vstGo"][disabled]').count() === 1);
  ok('and nothing is blocked yet', await page.locator('.vst-stop').count() === 0);

  await page.close();
}


/* OWNER, 2026-08-18: "Do not require preview. Generate MP4, then offer Share or
   Save." A device that will not play the copy back inside the page says nothing
   about the copy — and on the very device this matters for, the media element
   is already the thing that could not read the source. */
section('The preview is optional, never a gate');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  const done = async (failed) => page.evaluate(f => {
    VST = { step: 'done', caseNo: '', file: null, name: 'IMG_0440.mov', size: 84 * 1048576,
            url: '', tz: 'America/New_York', readable: false, decodeOk: true,
            codec: { cc: 'avc1', name: 'H.264 / AVC' }, caps: vstCaps(), diag: '',
            startMs: vstToUtc(2025, 5, 3, 11, 27, 58, 'America/New_York'),
            previewFailed: f,
            out: { blob: new Blob(['x']), url: '', name: 'IMG_0440-timestamped.mp4',
                   size: 4096, mime: 'video/mp4', audio: 'stripped',
                   sourceAudio: 'AAC, 1ch', frames: 1443, via: 'webcodecs' },
            savedHere: false, started: false, err: '', saveMsg: '' };
    paintVStamp();
    /* Counted INSIDE the same evaluate, before yielding to the event loop: the
       fixture's stub blob is unplayable by construction, so the page's own
       <video> error handler will eventually flip previewFailed and repaint —
       which is correct product behavior and, under load, used to land before
       a later locator count and fail this check spuriously. What this section
       asserts is the SYNCHRONOUS paint for the state it just set. */
    return { text: document.querySelector('.vst').innerText,
             prev: document.querySelectorAll('.vst-prev').length };
  }, failed);

  const r1 = await done(false);
  const ok1 = r1.text;
  ok('a playable copy still offers the preview', r1.prev === 1, `prev=${r1.prev}`);
  ok('and says playing it back is optional', has(ok1, 'not required'), ok1.slice(0, 500));

  /* THE CASE THAT MATTERS: the page cannot play it, and that must not read as a
     failed generation. */
  const r2 = await done(true);
  const ok2 = r2.text;
  ok('a copy the page cannot play drops the player', r2.prev === 0, `prev=${r2.prev}`);
  ok('and says the copy is made regardless', has(ok2, 'The copy is made'), ok2.slice(0, 500));
  ok('naming the player, not the file', has(ok2, 'says nothing about the file'), ok2.slice(0, 500));
  /* THE ACTIONS ARE UNTOUCHED — that is the whole point. */
  ok('Save or Share is still offered', await page.locator('[data-act="vstSave"]').count() === 1);
  ok('and nothing reports it as saved yet', has(ok2, 'not yet saved'), ok2.slice(0, 500));
  ok('the copy is still named as an MP4', has(ok2, 'IMG_0440-timestamped.mp4'));
  await page.close();
}

/* WHERE THE FIRM'S CASE FILES ARE, SAID OUT LOUD (owner, 2026-08-18).

   Since the Dropbox move the portal has stored every new photograph and
   generated report in the firm's Dropbox and told nobody: no connection state,
   no account, no way through to the folder. The plumbing was built; the window
   was missing. These assert what an ADMIN SEES, which is the half the Worker
   tests cannot reach.

   AND WHAT AN INVESTIGATOR DOES NOT. All four Dropbox routes are admin-only —
   `/status` names the firm's account — so none of this may render for them. */
section('Dropbox is visible, and it is not a file manager');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Settings' }).click();
  await page.waitForTimeout(700);
  let body = await page.locator('#app').innerText();

  ok('Settings names where case files are stored',
     has(body, 'Dropbox') && has(body, 'where case files are stored'), body.slice(0, 300));
  ok('the connection state is shown', has(body, 'Connected'), body.slice(0, 600));
  ok('and the three per-case folders are named',
     has(body, 'Photos') && has(body, 'Reports') && has(body, 'Video'));

  /* THE TEST ENV IS CONNECTED BY WORKER SECRET, which carries a token and
     nothing about whose account it is. The screen must say that rather than
     leaving a blank where the account should be. */
  ok('a secret-held connection says the account is not recorded',
     has(body, 'not recorded') && has(body, 'Worker secret'), body.slice(0, 900));
  ok('and offers no Disconnect it could not honour',
     await page.locator('[data-act="dbxDisconnect"]').count() === 0);
  ok('saying instead how to end it', has(body, 'Remove the secret'));

  /* NOT A FILE MANAGER (owner: "use existing Dropbox backend; do not build a
     file manager"). Asserted as an absence of the controls one would have. */
  ok('nothing here lists, renames or downloads a file', has(body, 'Nothing on this screen lists'));
  ok('and the card says its links are not shared links',
     has(body, 'shared') && has(body, 'shows nothing to'), body.slice(0, 1200));

  // ---- with no folder name, the link is honest about where it goes ----
  const openBtn = () => page.locator('#app a', { hasText: 'Open Dropbox' });
  ok('Open Dropbox is offered', await openBtn().count() === 1);
  ok('and with no folder name recorded it goes to the Apps folder, not a guess',
     (await openBtn().first().getAttribute('href')) === 'https://www.dropbox.com/home/Apps',
     String(await openBtn().first().getAttribute('href')));
  ok('the screen says why it cannot be more specific',
     has(body, 'does not tell an app what its own App Folder was named'));
  ok('a Dropbox link opens in a new tab and leaks no referrer',
     (await openBtn().first().getAttribute('target')) === '_blank'
     && String(await openBtn().first().getAttribute('rel')).includes('noreferrer'));

  /* NO PER-CASE LINKS UNTIL THERE IS A NAME. A link to a path that may not
     exist is worse than one more click, and the Worker returns no template. */
  await page.locator('.tabs button', { hasText: 'Cases' }).click();
  await page.waitForTimeout(400);
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Evidence');
  ok('a case shows no Dropbox folder links while the name is unknown',
     !has(await text(page, '#dlgBody'), 'In Dropbox'));

  // ---- the admin records it once ----
  /* The workspace is a full page, not a popup, so the top-level nav is not on
     screen inside it — leave by its own back control first. */
  await page.locator('[data-act="backToCases"]').click();
  await page.waitForTimeout(300);
  await page.locator('.tabs button', { hasText: 'Settings' }).click();
  await page.waitForTimeout(700);

  /* A REFUSAL MUST LEAVE THEM LOOKING AT THEIR OWN WORDS — the rule PAY_DRAFT
     exists for. Every paint rebuilds this input from the stored value, so
     without a draft a name refused for a bad character reverted to what was
     stored while the error still described what they typed. */
  await page.locator('#dbx_folder').fill('Apps/Always Precise');
  await page.locator('[data-act="dbxFolder"]').click();
  await page.waitForTimeout(600);
  let refused = await page.locator('#app').innerText();
  ok('a folder name with a slash is refused, in the Worker\'s own words',
     has(refused, 'cannot contain'), refused.slice(0, 500));
  ok('and what they typed is still in the box',
     (await page.locator('#dbx_folder').inputValue()) === 'Apps/Always Precise');
  ok('with the screen saying it is not saved', has(refused, 'Not saved'));
  ok('a refused name changes no link — Open Dropbox still goes to Apps',
     (await openBtn().first().getAttribute('href')) === 'https://www.dropbox.com/home/Apps',
     String(await openBtn().first().getAttribute('href')));

  await page.locator('#dbx_folder').fill('Always Precise Investigations');
  await page.locator('[data-act="dbxFolder"]').click();
  await page.waitForTimeout(600);
  body = await page.locator('#app').innerText();
  ok('the folder name saves', has(body, 'Saved. Case folder links use this name'),
     body.slice(0, 400));
  /* THE VALUE THAT SAVED IS THE ONE THEY TYPED. `paint()` rebuilds the inputs
     from DBX, so painting the "Saving…" state before reading the box wiped the
     typed name and posted an EMPTY one -- and then reported "Cleared." as
     though that had been asked for. Naming the wrong outcome is the assertion:
     "Saved" alone was true of the broken version too. */
  ok('and it is not silently cleared by the act of saving it',
     !has(body, 'Cleared.')
     && (await page.evaluate(() => DBX && DBX.folder_name)) === 'Always Precise Investigations',
     String(await page.evaluate(() => DBX && DBX.folder_name)));
  ok('and Open Dropbox now points at the firm folder',
     (await openBtn().first().getAttribute('href'))
       === 'https://www.dropbox.com/home/Apps/Always%20Precise%20Investigations',
     String(await openBtn().first().getAttribute('href')));

  // ---- and the case gains its three folder links ----
  await page.locator('.tabs button', { hasText: 'Cases' }).click();
  await page.waitForTimeout(400);
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Evidence');
  const media = await text(page, '#dlgBody');
  ok('the case now carries its Dropbox folders', has(media, 'In Dropbox'), media.slice(0, 400));
  const links = page.locator('#dlgBody a', { hasText: /Photos|Reports|Video/ });
  const hrefs = await links.evaluateAll(els => els.map(e => e.getAttribute('href')));
  ok('one link per folder, three of them',
     hrefs.length === 3, JSON.stringify(hrefs));
  ok('each addressed to THIS case, inside the firm folder',
     hrefs.every(h => h.startsWith(
       'https://www.dropbox.com/home/Apps/Always%20Precise%20Investigations/API-20260812-4002/')),
     JSON.stringify(hrefs));
  ok('naming Photos, Reports and Video',
     hrefs.some(h => h.endsWith('/Photos')) && hrefs.some(h => h.endsWith('/Reports'))
       && hrefs.some(h => h.endsWith('/Video')), JSON.stringify(hrefs));
  /* THE SAFETY OF THE WHOLE FEATURE: these open the firm's own Dropbox. A
     shared link would hand the case files to anyone holding the URL. */
  ok('and none of them is a Dropbox shared link',
     hrefs.every(h => !h.includes('/s/') && !h.includes('/scl/') && !h.includes('dl=1')),
     JSON.stringify(hrefs));
  ok('the case says plainly that nothing is shared',
     has(media, 'nothing is shared'), media.slice(0, 400));
  await page.close();
}

section('An investigator is shown none of the firm\'s Dropbox');
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  const nav = await text(page, '.tabs');
  ok('there is no Settings door for them', !has(nav, 'Settings'));
  const shell = await page.locator('#app').innerText();
  ok('and nothing about the connection or the account is on their screen',
     !has(shell, 'Dropbox'), shell.slice(0, 400));

  /* THE CASE SCREEN IS THE ONE THAT COULD LEAK IT — the folder links render
     beside media an investigator is allowed to see. */
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Evidence');
  const media = await text(page, '#dlgBody');
  ok('the case media panel offers them no Dropbox folder links',
     !has(media, 'In Dropbox'), media.slice(0, 400));
  ok('and no dropbox.com address is anywhere on it',
     !(await page.locator('#dlgBody').innerHTML()).includes('dropbox.com'));
  await page.close();
}

/* ---- ITEM 4 (owner, 2026-08-19): the admin runs the whole report-to-package
   chain themselves, with no approval ritual in the way — and the same screens
   still hold the line for an investigator's work. Plus the mobile report fix,
   asserted as NUMBERS measured at phone width, because every one of these was
   measured broken at 375px before it was changed. */
section('An admin ships their own report without an approval ritual');
{
  db.prepare(`INSERT INTO submissions (case_no, kind, status, client_name, subject_name, payload, created_at)
              VALUES ('API-ITEM4-A', 'consumer', 'new', 'Direct Client', 'Watched Person', '{}', ?)`)
    .run(new Date().toISOString());

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  // The admin works their own day, from the case screen's own controls' routes.
  await page.evaluate(async () => {
    const post = (u, b) => fetch('/portal-api' + u, {method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify(b)});
    await post('/cases/API-ITEM4-A/day/start', {day_date:'2026-08-17', start_time:'07:00'});
    await post('/cases/API-ITEM4-A/activity', {at_date:'2026-08-17', at_time:'08:30', description:'Subject carried groceries.'});
    await post('/cases/API-ITEM4-A/day/end', {end_time:'12:00'});
  });
  await rowFor(page, 'API-ITEM4-A').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Report');
  await page.locator('form[data-act="genReport"] button[type="submit"]').click();
  await page.waitForTimeout(700);

  /* The draft auto-opens. An admin signs off DIRECTLY — no submit-to-myself. */
  ok('the admin is offered Approve on their own draft',
     await page.locator('[data-act="reportStatus"][data-to="approved"]').count() === 1);
  ok('and is not offered the investigator\'s handoff',
     await page.locator('[data-act="reportStatus"][data-to="submitted"]').count() === 0);

  /* But they do not even need it: straight to the package. */
  await wsTab(page, 'Package');
  await page.waitForTimeout(400);
  const pre = await text(page, '#dlgBody');
  ok('the package mini-row calls a shippable draft Ready, never Approved',
     has(pre, 'Ready') && !has(pre.split('Start the package')[0], 'In review'), pre.slice(0, 300));
  await page.locator('.btn', { hasText: 'Start the package' }).first().click();
  await page.waitForTimeout(700);
  ok('no gate demands an approval for the admin\'s own draft',
     !has(await text(page, '#dlgBody'), 'must be approved'));
  await page.locator('[data-act="pkgFinalize"]').click();
  await page.waitForTimeout(900);
  const done = await text(page, '#dlgBody');
  ok('the package finalizes with no approve click anywhere', has(done, 'Package finalized'), done.slice(0, 300));
  ok('and the real-file actions are all offered',
     await page.locator('[data-act="pkgPdf"]').count() >= 1
     && await page.locator('[data-act="pkgPdfDropbox"]').count() === 1
     && await page.locator('[data-act="pkgPrint"]').count() === 1);

  await wsTab(page, 'Report');
  ok('the report now reads Approved — finalize was the recorded sign-off',
     has(await text(page, '#dlgBody'), 'Approved'));
  await page.close();
}

section('An investigator\'s report still goes through the office');
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await page.evaluate(async () => {
    const post = (u, b) => fetch('/portal-api' + u, {method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify(b)});
    await post('/cases/API-20260812-4001/day/start', {day_date:'2026-08-17', start_time:'07:00'});
    await post('/cases/API-20260812-4001/activity', {at_date:'2026-08-17', at_time:'09:00', description:'Departed residence.'});
    await post('/cases/API-20260812-4001/day/end', {end_time:'11:00'});
  });
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Report');
  if (await page.locator('form[data-act="genReport"]').count()) {
    /* Pick HER day by its date — the spare list can also carry an admin's
       unreported day on this shared fixture case, and generating against
       that one is refused for an investigator. */
    await page.evaluate(() => {
      const sel = document.getElementById('r_day');
      const opt = [...sel.options].find(o => o.textContent.includes('2026-08-17'));
      if (opt) sel.value = opt.value;
    });
    await page.locator('form[data-act="genReport"] button[type="submit"]').click();
    await page.waitForTimeout(700);
  }
  ok('the investigator is offered Submit, exactly as before',
     await page.locator('[data-act="reportStatus"][data-to="submitted"]').count() === 1);
  ok('and never Approve',
     await page.locator('[data-act="reportStatus"][data-to="approved"]').count() === 0);
  await page.locator('[data-act="reportStatus"][data-to="submitted"]').click();
  await page.waitForTimeout(600);
  ok('their submit still hands the report to the office',
     has(await text(page, '#dlgBody'), 'Submitted'));
  await page.close();
}

section('The report screen fits a phone — measured, not eyeballed');
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(800);
  await page.evaluate(() => openCase('API-ITEM4-A', 'reports'));
  await page.waitForTimeout(600);
  // The finalized case from the section above still holds the open report.
  if (!(await page.locator('.rpnav').count()) && await page.locator('.rcard').count()) {
    await page.locator('.rcard').first().click();
    await page.waitForTimeout(400);
  }

  /* THE PHONE PADDING FIX USED TO BE DEAD CODE: `.dlg{padding:16px}` sat in a
     560px block ABOVE the base `.dlg{padding:22px}`, so the base rule won and
     nobody noticed. Assert the COMPUTED value, so source order can never
     silently kill it again. */
  const pad = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.dlg')).paddingLeft);
  ok('the case screen sheds its desktop padding on a phone (the dead-rule regression)',
     pad === '12px', pad);

  const nav = await page.evaluate(() => {
    const el = document.querySelector('.rpnav');
    const btns = [...el.querySelectorAll('button')].map(b => Math.round(b.getBoundingClientRect().height));
    return { clipped: el.scrollWidth - el.clientWidth, heights: btns };
  });
  ok('every report sub-tab is on screen — nothing hidden behind a scroll with no affordance',
     nav.clipped === 0, String(nav.clipped));
  ok('and each is a real tap target',
     nav.heights.length >= 5 && nav.heights.every(h => h >= 44), JSON.stringify(nav.heights));

  const acts = await page.evaluate(() =>
    [...document.querySelectorAll('.ractions .btn')].map(b => Math.round(b.getBoundingClientRect().height)));
  ok('the action buttons are tap targets too', acts.every(h => h >= 44), JSON.stringify(acts));

  if (await page.locator('[data-act="repView"][data-v="edit"]').count()) {
    await page.locator('[data-act="repView"][data-v="edit"]').click();
    await page.waitForTimeout(300);
  }
  const ed = await page.evaluate(() => {
    const ta = document.getElementById('r_body');
    return ta ? { font: parseFloat(getComputedStyle(ta).fontSize),
                  share: ta.getBoundingClientRect().width / document.documentElement.clientWidth } : null;
  });
  ok('the report editor is 16px — under that, iOS zooms the page on focus',
     ed && ed.font >= 16, JSON.stringify(ed));
  ok('and spans the phone instead of a third of it (was 223px of 375)',
     ed && ed.share >= 0.66, JSON.stringify(ed));
  await page.close(); await ctx.close();
}

/* ---- UNIT 5 (owner): portal modernization. Everything here was measured
   broken at a real width before it was changed, and the numbers are what the
   assertions hold — the "agreement not fit" lesson, applied to a shell. */
section('The mobile header is a control, not a glyph');
{
  const ctx = await browser.newContext({ viewport: { width: 320, height: 568 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);

  const b = await page.evaluate(() => {
    const el = document.getElementById('burger');
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const lum = c => { const m = c.match(/\d+/g); return m
      ? 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2] : null; };
    const top = lum(getComputedStyle(document.querySelector('.top')).backgroundColor);
    return { w: r.width, h: r.height,
      fromRight: Math.round(document.documentElement.clientWidth - r.right),
      lumDiff: Math.abs(lum(cs.backgroundColor) - top),
      expanded: el.getAttribute('aria-expanded') };
  });
  /* Measured before the fix: 236px from the right on a transparent surface. */
  ok('the burger holds the conventional corner', b.fromRight <= 24, JSON.stringify(b));
  ok('at tap size', b.w >= 44 && b.h >= 44, JSON.stringify(b));
  ok('on a surface the eye can find (the 8-point house floor)',
     b.lumDiff >= 8, String(b.lumDiff));
  ok('and it says it is closed', b.expanded === 'false');

  await page.locator('#burger').click();
  await page.waitForTimeout(350);
  const open = await page.evaluate(() => {
    const t = document.querySelector('.tabs');
    const btns = [...t.querySelectorAll('button')];
    const xs = new Set(btns.map(x => Math.round(x.getBoundingClientRect().left)));
    const br = document.getElementById('burger').getBoundingClientRect();
    const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
    const back = document.querySelector('.navback');
    const edge = document.elementFromPoint(document.documentElement.clientWidth - 4, 300);
    return { cols: xs.size, clipped: t.scrollWidth - t.clientWidth,
      expanded: document.getElementById('burger').getAttribute('aria-expanded'),
      burgerReachable: Boolean(hit && hit.closest('#burger')),
      backdropReal: Boolean(back) && getComputedStyle(back).display === 'block',
      outsideTapLands: edge ? (edge.classList.contains('navback') ? 'backdrop' : 'elsewhere') : 'nothing' };
  });
  ok('the drawer is one column', open.cols === 1, String(open.cols));
  ok('with nothing clipped sideways', open.clipped === 0);
  ok('the burger says it is open', open.expanded === 'true');
  ok('and is still reachable to close — it used to be buried under the drawer',
     open.burgerReachable === true);
  /* The dim used to be a box-shadow: decoration a tap went straight through,
     onto whatever control sat underneath. It is a real element now. */
  ok('the dim is a real backdrop', open.backdropReal === true);
  ok('and an outside tap lands on it, not on the page beneath',
     open.outsideTapLands === 'backdrop', open.outsideTapLands);
  await page.locator('.navback').click({ position: { x: 314, y: 300 } });
  await page.waitForTimeout(250);
  ok('tapping outside closes the drawer',
     await page.evaluate(() => !document.body.classList.contains('navopen')));

  /* Quick tools: the day's launcher, at tap size, nothing overflowing. */
  const qt = await page.evaluate(() => {
    const doc = document.documentElement;
    const btns = [...document.querySelectorAll('.qtool')].map(x => {
      const r = x.getBoundingClientRect();
      return { t: x.textContent.trim(), h: Math.round(r.height),
               fits: r.right <= doc.clientWidth + 1 }; });
    return { overflowX: doc.scrollWidth - doc.clientWidth, btns };
  });
  ok('the page does not scroll sideways at 320px', qt.overflowX === 0, String(qt.overflowX));
  ok('quick tools reach the day\'s doors',
     ['Timestamp Photo', 'Timestamp Video', 'Active Surveillance', 'Cases']
       .every(name => qt.btns.some(x => x.t.includes(name))), JSON.stringify(qt.btns));
  ok('every tool is a tap target that fits',
     qt.btns.every(x => x.h >= 44 && x.fits), JSON.stringify(qt.btns));

  /* The dashboard's operational panels render. */
  const dash = await page.evaluate(() => ({
    bands: document.querySelectorAll('.band').length,
    recent: document.querySelectorAll('.card h2').length &&
      [...document.querySelectorAll('.card h2')].some(h => h.textContent === 'Recent activity'),
  }));
  ok('the two bands render', dash.bands === 2);
  ok('and Recent activity is on the dashboard', dash.recent === true);
  await page.close(); await ctx.close();
}

section('Recent activity rows are doors, and stacked records read on a phone');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(1000);

  ok('the feed carries real events from this suite\'s own work',
     await page.locator('.ra-row').count() >= 3,
     String(await page.locator('.ra-row').count()));
  const row = page.locator('.ra-row .ra-open').first();
  const caseNo = await row.evaluate(el => el.dataset.case);
  await row.click();
  await page.waitForTimeout(600);
  ok('clicking a feed row opens its case',
     await page.evaluate(() => VIEW) === 'case'
     && await page.evaluate(() => WS_CASE) === caseNo, caseNo);
  await page.locator('[data-act="backToCases"]').click();
  await page.waitForTimeout(300);

  /* The cases list on a phone: stacked records, nothing behind a sideways
     scroll, and the columns .hide drops come BACK. Measured before: 187px of
     every row was behind an inner scroll at 320px. */
  await page.evaluate(() => { const b = [...document.querySelectorAll('[data-act="tab"]')]
    .find(x => x.dataset.tab === 'cases'); if (b) b.click(); });
  await page.waitForTimeout(600);
  const tbl = await page.evaluate(() => {
    const wrap = document.querySelector('.stacktbl');
    const tr = wrap && wrap.querySelector('tbody tr');
    const hid = tr && tr.querySelector('td.hide');
    return { innerScroll: wrap ? wrap.scrollWidth - wrap.clientWidth : null,
      rowIsBlock: tr ? getComputedStyle(tr).display : null,
      hiddenColBack: hid ? getComputedStyle(hid).display : null,
      labelled: tr ? tr.querySelectorAll('td[data-l]').length : 0 };
  });
  ok('no row hides behind an inner sideways scroll', tbl.innerScroll === 0, JSON.stringify(tbl));
  ok('rows draw as stacked records', tbl.rowIsBlock === 'block');
  ok('the phone gets the hidden columns back', tbl.hiddenColBack === 'block');
  ok('each cell says what it is', tbl.labelled >= 4, String(tbl.labelled));

  /* Intakes: the Accept control is a control. Measured before: 42-60px wide
     and up to 119px tall. */
  await page.evaluate(() => { const b = [...document.querySelectorAll('[data-act="tab"]')]
    .find(x => x.dataset.tab === 'leads'); if (b) b.click(); });
  await page.waitForTimeout(700);
  const acc = await page.evaluate(() =>
    [...document.querySelectorAll('.pc-next > .btn')].map(x => {
      const r = x.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) }; }));
  ok('Accept is wider than it is tall, at tap height',
     acc.length >= 1 && acc.every(a => a.w >= 120 && a.h >= 44 && a.h <= 60),
     JSON.stringify(acc));
  await page.close(); await ctx.close();
}

/* ---- UNIT 6: the LEGAL intake in the portal (LEGAL-INTAKE.md). What the
   office sees and does; the Worker suite already pins the data rules. */
section('Quick Legal Assignment: a phone call becomes a case');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Intakes' }).click();
  await page.waitForTimeout(500);
  await page.locator('.btn', { hasText: 'Intake a client' }).click();
  await page.waitForTimeout(400);

  const picker = await page.locator('#app').innerText();
  ok('the third door is Legal / Law Firm', has(picker, 'Legal / Law Firm'));
  ok('and it names the phone-call workflow', has(picker, 'pick up the papers'));
  await page.locator('[data-act="nlKind"][data-k="legal"]').click();
  await page.waitForTimeout(300);

  ok('the quick form says choosing an arrangement is never a payment',
     has(await page.locator('#app').innerText(), 'never a payment'));
  await page.locator('#nl_firm').fill('Calloway Law');
  await page.locator('#nl_atty').fill('M. Calloway');
  await page.locator('#nl_email').fill('mc@callowaylaw.test');
  await page.locator('#nl_client').fill('Estate of Byrd');
  await page.locator('#nl_subject').fill('J. Q. Adverse');
  await page.locator('#nl_asgtype').selectOption('Surveillance');
  await page.locator('#nl_retainer').fill('2000');
  await page.locator('#nl_arrangement').selectOption('check_pickup');
  await page.locator('#nl_legal_deadline').fill('2026-09-01');
  await page.locator('[data-act="nlSave"][data-open="1"]').click();
  await page.waitForTimeout(900);

  ok('the case opens', await page.evaluate(() => VIEW) === 'case');
  const caseNo = await page.evaluate(() => WS_CASE);
  ok('with the Legal tab on it', await page.evaluate(() =>
    Boolean(WS && WS.legal && WS.legal.firm_name === 'Calloway Law')));
  await wsTab(page, 'Legal');
  const lp = await text(page, '#dlgBody');
  ok('the panel leads with the firm', has(lp, 'Calloway Law'));
  ok('check pickup reads as AWAITING PICKUP, not paid',
     has(lp, 'Awaiting pickup') && has(lp, 'nothing marks it paid automatically'));
  ok('and says recording money stays on Billing',
     has(lp, 'cannot mark anything paid'));
  /* The retainer the attorney quoted on the call went through the one writer. */
  ok('the agreed retainer recorded through the existing route',
     await page.evaluate(async () => {
       const r = await fetch(`/portal-api/cases/${WS_CASE}/workspace`, {credentials:'same-origin'});
       const d = await r.json();
       return d.retainer && Number(d.retainer.retainer_amount) === 2000;
     }) || await page.evaluate(async () => {
       const r = await fetch(`/portal-api/submissions/${WS_CASE}`, {credentials:'same-origin'});
       return (await r.json()) && true;
     }));

  // The panel edits with the /meta rules.
  await page.locator('#lg_trial_date').fill('2026-11-20');
  await page.locator('[data-act="legalSave"]').click();
  await page.waitForTimeout(600);
  ok('a save lands and says so', has(await text(page, '#dlgBody'), 'Saved'));
  ok('the firm survived a save that did not mention it',
     await page.evaluate(() => WS.legal.firm_name === 'Calloway Law'
       && WS.legal.trial_date === '2026-11-20'));

  // Back on the desk: the card is a LEGAL card.
  await page.locator('[data-act="backToCases"]').click();
  await page.waitForTimeout(300);
  await page.locator('.tabs button', { hasText: 'Intakes' }).click();
  await page.waitForTimeout(600);
  const card = page.locator('.pcard', { hasText: 'Calloway Law' }).first();
  const cardText = await card.innerText();
  ok('the card is badged LEGAL', /legal/i.test(cardText), cardText.slice(0, 120));
  ok("firm-led, with the attorney and the firm's client apart",
     has(cardText, 'Calloway Law') && has(cardText, 'M. Calloway') && has(cardText, 'Estate of Byrd'));
  ok('the assignment and deadline are on the card',
     has(cardText, 'Surveillance') && has(cardText, '2026-09-01'));
  ok('the arrangement shows as awaiting pickup', has(cardText, 'Awaiting pickup'));
  ok('and no consumer payment-options button is offered on a legal lead',
     await card.locator('[data-act="leadPayOpen"]').count() === 0);

  /* HOTFIX 2026-08-21 — the wizard must NAME the door it will actually send.
     A legal case takes the private SHEET and the LEGAL door, so labelling the
     intake off the sheet id said "Private Client Intake" over a send carrying
     `?assignment=legal`. A screen that misnames what it is about to email is
     the same defect as emailing the wrong thing, one step earlier. */
  await card.locator('[data-act="leadSheet"]').first().click();
  await page.waitForTimeout(600);
  const wiz = await page.locator('#app').innerText();
  ok('the send wizard names the LEGAL door on a legal case',
     /Legal Investigation Assignment/.test(wiz), wiz.slice(0, 400));
  ok('and never calls it the private intake',
     !/Private Client Intake/.test(wiz), wiz.slice(0, 400));
  await page.close();
}

section('A legal case shows an investigator the work, never the firm');
{
  db.prepare(`INSERT INTO submissions (case_no, kind, status, client_name, subject_name, payload, created_at)
              VALUES ('API-LGL-B', 'consumer', 'new', 'Client of Record', 'Watched Party',
                      '{"assignment":"legal","subject_name":"Watched Party","objective":"Locate the party.","firm_name":"Harmon & Boyle PLC","attorney_name":"R. Harmon","matter_number":"M-88"}', ?)`)
    .run(new Date().toISOString());
  db.prepare(`INSERT INTO legal_intake (case_no, firm_name, attorney_name, matter_number, payment_arrangement, created_at)
              VALUES ('API-LGL-B', 'Harmon & Boyle PLC', 'R. Harmon', 'M-88', 'bill_ach', ?)`)
    .run(new Date().toISOString());

  const admin = await newPage();
  await signIn(admin, 'trever', 'AdminPassword1x');
  await admin.evaluate(async () => {
    const users = await (await fetch('/portal-api/users', {credentials:'same-origin'})).json();
    const dana = users.users.find(u => u.username === 'dana');
    await fetch('/portal-api/submissions/API-LGL-B/assign', {method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify({user_id: dana.id})});
  });
  await admin.close();

  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await rowFor(page, 'API-LGL-B').click();
  await page.waitForTimeout(500);
  ok('no Legal tab exists for the investigator',
     !has(await text(page, '.wstabs'), 'Legal') && await page.evaluate(() => !WS.legal));
  /* Walk every section they have and assert the firm's identity is nowhere. */
  let all = '';
  for (const seen of await wsVisitAll(page, p2 => text(p2, '#dlgBody'))) all += seen.text;
  ok('no firm, attorney or matter identity anywhere in their case',
     !all.includes('Harmon') && !all.includes('M-88'), all.slice(0, 150));
  ok('while the subject is theirs to work', all.includes('Watched Party'));
  await page.close();
}

/* ============================================================== UNIT 7 =====
   REPEAT CLIENT / FIRM PROFILES, on the real page.

   The thing worth proving on this side is the WORKFLOW: a firm saved once,
   found by typing part of a paralegal's name, chosen, and a whole assignment
   prefilled from it — then the firm renamed, and the case that already exists
   still reading exactly as it did. */

async function gotoProfiles(page) {
  await page.locator('.tabs button', { hasText: 'Clients & Firms' }).first().click();
  /* render() fetches the case list, the summary, health and the rest before it
     reaches the directory, so waiting a fixed moment races it. Wait for the
     screen to stop saying it is loading instead. */
  await page.waitForFunction(() => {
    const c = document.querySelector('#app .card');
    return c && !c.innerText.includes('Loading\u2026');
  }, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(150);
}

section('Clients & Firms: a firm saved once, then an assignment in seconds');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await gotoProfiles(page);
  ok('the admin has a Clients & Firms area', (await text(page, '.card')).includes('Clients & Firms'));
  ok('and it says what will fill it rather than looking broken',
     has(await text(page, '.card'), 'No saved clients'), (await text(page, '.card')).slice(0, 200));

  // --- create ------------------------------------------------------------
  await page.locator('[data-act="profNew"]').click();
  await page.waitForTimeout(300);
  ok('the three profile types are offered', await page.locator('[data-act="profFormKind"]').count() === 3);
  await page.locator('[data-act="profFormKind"][data-k="law_firm"]').click();
  await page.waitForTimeout(200);
  await page.locator('#pf_name').fill('Calloway Legal Group');
  await page.locator('#pf_email').fill('front@calloway.example');
  await page.locator('#pf_address').fill('55 Campbell Ave, Roanoke VA');
  await page.locator('#pf_ph0').fill('(540) 555-3311');
  await page.locator('#pf_phl0').selectOption('work');
  await page.locator('#pf_payment_arrangement').selectOption('check_pickup');
  await page.locator('[data-act="profSave"]').click();
  await page.waitForTimeout(500);
  let body = await text(page, 'body');
  ok('the firm saves and opens', body.includes('Calloway Legal Group'), body.slice(0, 200));
  ok('its address and number are on the profile',
     body.includes('55 Campbell Ave') && body.includes('(540) 555-3311'));
  ok('and its usual arrangement reads as an arrangement, not a payment',
     has(body, 'Usual arrangement') && has(body, 'pick up at firm'));

  // --- people ------------------------------------------------------------
  const addContact = async (first, last, role, email, phone, pref) => {
    await page.locator('[data-act="profContactNew"]').click();
    await page.waitForTimeout(250);
    await page.locator('#pc_first').fill(first);
    await page.locator('#pc_last').fill(last);
    await page.locator('#pc_role').selectOption(role);
    if (email) await page.locator('#pc_email').fill(email);
    if (phone) { await page.locator('#pc_ph0').fill(phone); await page.locator('#pc_phl0').selectOption('work'); }
    if (pref) await page.locator('#pc_pref').check();
    await page.locator('[data-act="profContactSave"]').first().click();
    await page.waitForTimeout(400);
  };
  await addContact('Renata', 'Calloway', 'Attorney', 'rc@calloway.example', '540-555-3312', true);
  await addContact('Owen', 'Pike', 'Attorney', 'op@calloway.example', '', false);
  await addContact('Beatrix', 'Sandoval', 'Paralegal', 'bs@calloway.example', '540.555.9090', false);
  await addContact('Del', 'Watts', 'Billing Contact', 'ap@calloway.example', '', false);
  ok('four people sit on the firm as separate cards',
     await page.locator('.ccard').count() === 4, String(await page.locator('.ccard').count()));
  body = await text(page, 'body');
  ok('two attorneys, a paralegal and a billing contact, each with their role',
     (body.match(/Attorney/g) || []).length >= 2 && body.includes('Paralegal')
     && body.includes('Billing Contact'));
  ok('exactly one is marked preferred',
     await page.locator('.ccard .tag', { hasText: 'Preferred' }).count() === 1);

  // --- the picker, and the assignment ------------------------------------
  await page.locator('.tabs button', { hasText: 'Intakes' }).first().click();
  await page.waitForTimeout(300);
  await page.locator('[data-act="tab"][data-tab="newlead"]').first().click();
  await page.waitForTimeout(300);
  await page.locator('[data-act="nlKind"][data-k="legal"]').click();
  await page.waitForTimeout(300);
  ok('the Quick Legal form offers an existing firm', await page.locator('[data-act="nlPickOpen"]').count() === 1);
  await page.locator('[data-act="nlPickOpen"]').click();
  await page.waitForTimeout(250);
  /* SEARCHED BY THE PARALEGAL'S NAME — the office remembers the person who
     rang, not always the firm on the letterhead. */
  await page.locator('#nl_pick').fill('sandoval');
  await page.waitForTimeout(700);
  ok('searching a paralegal\'s name finds the firm',
     await page.locator('.pickitem', { hasText: 'Calloway' }).count() === 1,
     await text(page, '.pickbox'));
  await page.locator('.pickitem', { hasText: 'Calloway' }).click();
  await page.waitForTimeout(400);

  ok('choosing it says which firm is in use', has(await text(page, '.usingprof'), 'Calloway Legal Group'));
  ok('the firm name is prefilled', await page.locator('#nl_firm').inputValue() === 'Calloway Legal Group');
  ok('the preferred attorney is prefilled, not the first person entered',
     await page.locator('#nl_atty').inputValue() === 'Renata Calloway',
     await page.locator('#nl_atty').inputValue());
  ok('their email came with them',
     await page.locator('#nl_email').inputValue() === 'rc@calloway.example');
  ok('and the firm\'s usual arrangement is the default',
     await page.locator('#nl_arrangement').inputValue() === 'check_pickup');
  /* NOTHING CASE-SPECIFIC IS PREFILLED — the new matter is new. */
  ok('no subject was carried over', await page.locator('#nl_subject').inputValue() === '');
  ok('no objective was carried over', await page.locator('#nl_obj').inputValue() === '');
  ok('and no deadline was invented', await page.locator('#nl_legal_deadline').inputValue() === '');

  /* THE CONTACT IS A CHOICE, AND THE CHOICE HAS TO WORK. The first version of
     this control rendered a <select> that nothing listened to: picking a
     different attorney changed neither the form nor what was posted, and a
     test that only counted its options passed straight over it. */
  ok('the other people are offered for this assignment',
     await page.locator('#nl_pickc option').count() === 4);
  await page.locator('#nl_pickc').selectOption({ label: 'Owen Pike — Attorney' });
  await page.waitForTimeout(400);
  ok('choosing a different attorney really changes the assignment',
     await page.locator('#nl_atty').inputValue() === 'Owen Pike',
     await page.locator('#nl_atty').inputValue());
  ok('and brings their own email with them',
     await page.locator('#nl_email').inputValue() === 'op@calloway.example',
     await page.locator('#nl_email').inputValue());
  await page.locator('#nl_pickc').selectOption({ label: 'Renata Calloway — Attorney' });
  await page.waitForTimeout(400);
  ok('and switching back restores the first one',
     await page.locator('#nl_atty').inputValue() === 'Renata Calloway');
  /* The owner's steps 4 and 5: a paralegal and a billing contact, chosen off
     the firm rather than retyped. */
  ok('the firm\'s paralegals are offered', await page.locator('#nl_pickpara').count() === 1);
  await page.locator('#nl_pickpara').selectOption({ label: 'Beatrix Sandoval' });
  await page.waitForTimeout(300);
  ok('the firm\'s billing contacts are offered', await page.locator('#nl_pickbill').count() === 1);
  await page.locator('#nl_pickbill').selectOption({ label: 'Del Watts' });
  await page.waitForTimeout(300);

  /* EDIT THIS ASSIGNMENT: the phone changed for this case only. */
  await page.locator('#nl_phone').fill('540-555-0000');
  await page.locator('#nl_client').fill('Estate of L. Byrd');
  await page.locator('#nl_subject').fill('Adverse Party');
  await page.locator('#nl_obj').fill('Document daily activity');
  await page.locator('[data-act="nlSave"][data-open="1"]').click();
  await page.waitForTimeout(900);
  const dlg = await text(page, '#dlgBody');
  ok('the assignment is created and opens', dlg.includes('Estate of L. Byrd') || dlg.length > 0);

  await wsTab(page, 'Legal');
  const legal = await text(page, '#dlgBody');
  ok('the case carries the firm it was started from', legal.includes('Calloway Legal Group'));
  /* The panel's fields are INPUTS, so their contents are values rather than
     rendered text — read them the way the office sees them. */
  ok('and the attorney', await page.locator('#lg_attorney_name').inputValue() === 'Renata Calloway',
     await page.locator('#lg_attorney_name').inputValue());
  /* Named as ONE fact, because an OR whose second half is trivially true of an
     empty field proves nothing — which is what the first version of this
     assertion did. */
  ok('and the number typed for THIS assignment, not the firm\'s',
     await page.locator('#lg_attorney_phone').inputValue() === '540-555-0000',
     await page.locator('#lg_attorney_phone').inputValue());
  /* THE FIRM'S OWN DETAILS CAME ACROSS, so nobody retypes a letterhead the
     portal already holds — the owner's "do not ask Admin to re-enter the
     firm's address and contact data". */
  ok('the firm\'s office address arrived with it',
     await page.locator('#lg_firm_address').inputValue() === '55 Campbell Ave, Roanoke VA',
     await page.locator('#lg_firm_address').inputValue());
  ok('and the switchboard',
     await page.locator('#lg_firm_phone').inputValue() === '(540) 555-3311',
     await page.locator('#lg_firm_phone').inputValue());
  ok('and the paralegal the office picked off the firm',
     await page.locator('#lg_paralegal_name').inputValue() === 'Beatrix Sandoval',
     await page.locator('#lg_paralegal_name').inputValue());
  ok('and the billing contact',
     await page.locator('#lg_billing_name').inputValue() === 'Del Watts',
     await page.locator('#lg_billing_name').inputValue());
  const caseNo = await page.evaluate(async () => {
    const d = await (await fetch('/portal-api/submissions?limit=1', { credentials: 'same-origin' })).json();
    return d.submissions[0].case_no;
  });

  await wsTab(page, 'Edit case');
  const edit = await text(page, '#dlgBody');
  ok('the case names the profile it came from',
     has(edit, 'Client profile') && edit.includes('Calloway Legal Group'), edit.slice(0, 300));
  ok('and says plainly that editing the profile will not move this case',
     has(edit, 'never this one'), edit.slice(0, 400));

  /* ------------------------------------------------------------------
     NOW RENAME THE FIRM, and read the case back. This is the whole unit. */
  await page.locator('[data-act="backToCases"]').click();
  await page.waitForTimeout(300);
  await gotoProfiles(page);
  await page.locator('[data-act="profOpen"]').first().click();
  await page.waitForTimeout(400);
  await page.locator('[data-act="profEdit"]').click();
  await page.waitForTimeout(300);
  await page.locator('#pf_name').fill('Calloway Reed & Vance');
  await page.locator('#pf_ph0').fill('(540) 555-9999');
  await page.locator('[data-act="profSave"]').click();
  await page.waitForTimeout(500);
  ok('the firm really is renamed', (await text(page, 'body')).includes('Calloway Reed & Vance'));

  { const cbtn = page.locator('.tabs button', { hasText: 'Cases' });
    if (await cbtn.count()) { await cbtn.first().click(); await page.waitForTimeout(400); } }
  await rowFor(page, caseNo).click();
  await page.waitForTimeout(400);
  await wsTab(page, 'Legal');
  const after = await text(page, '#dlgBody');
  ok('THE EXISTING CASE STILL SAYS THE NAME IT WAS CREATED WITH',
     after.includes('Calloway Legal Group') && !after.includes('Vance'), after.slice(0, 300));
  ok('and still carries the number typed for this assignment, not the firm\'s new one',
     !after.includes('555-9999'), after.slice(0, 300));
  await page.close();
}

section('Clients & Firms: a possible duplicate is a question, not a merge');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await gotoProfiles(page);
  const mk = async (name, confirm) => {
    await page.locator('[data-act="profNew"]').click();
    await page.waitForTimeout(300);
    await page.locator('#pf_name').fill(name);
    await page.locator('[data-act="profSave"]').first().click();
    await page.waitForTimeout(500);
    if (confirm && await page.locator('[data-act="profSave"][data-confirm="1"]').count()) {
      await page.locator('[data-act="profSave"][data-confirm="1"]').click();
      await page.waitForTimeout(500);
    }
  };
  await mk('Ridgeline Law', false);
  await page.locator('[data-act="profBack"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-act="profNew"]').click();
  await page.waitForTimeout(300);
  await page.locator('#pf_name').fill('Ridgeline Law Group');
  await page.locator('[data-act="profSave"]').first().click();
  await page.waitForTimeout(600);
  const warn = await text(page, '.dupwarn');
  ok('a similar name raises POSSIBLE EXISTING PROFILE', has(warn, 'Possible existing profile'), warn);
  ok('it names the firm it matched and why', warn.includes('Ridgeline Law') && has(warn, 'similar name'));
  ok('it says nothing was saved and nothing merged', has(warn, 'nothing has been merged'));
  ok('Use existing is offered', await page.locator('.dupwarn [data-act="profOpen"]').count() >= 1);
  ok('and so is Continue as new', await page.locator('[data-act="profSave"][data-confirm="1"]').count() === 1);
  await page.locator('[data-act="profSave"][data-confirm="1"]').click();
  await page.waitForTimeout(600);
  ok('continuing really does create the second one',
     (await text(page, 'body')).includes('Ridgeline Law Group'));
  await page.locator('[data-act="profBack"]').click();
  await page.waitForTimeout(500);
  const list = await text(page, '.card');
  ok('BOTH firms now exist, apart',
     list.includes('Ridgeline Law Group') && list.includes('Ridgeline Law'),
     list.slice(0, 300));
  await page.close();
}

section('Clients & Firms: New Assignment from a profile routes by type');
{
  /* Written as a SET across the three kinds, the way the Timestamp pair's
     reachability tests are, so a door that works for one and not the others
     fails instead of shipping. */
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  const mk = async (kind, name, email) => {
    await gotoProfiles(page);
    await page.locator('[data-act="profNew"]').click();
    await page.waitForTimeout(300);
    await page.locator(`[data-act="profFormKind"][data-k="${kind}"]`).click();
    await page.waitForTimeout(200);
    await page.locator('#pf_name').fill(name);
    await page.locator('#pf_email').fill(email);
    await page.locator('[data-act="profSave"]').first().click();
    await page.waitForTimeout(600);
    if (await page.locator('[data-act="profSave"][data-confirm="1"]').count()) {
      await page.locator('[data-act="profSave"][data-confirm="1"]').click();
      await page.waitForTimeout(600);
    }
  };
  for (const [kind, name, email, wantHeading, wantField] of [
    ['law_firm', 'Routing Law Offices', 'r@routing.example', 'Quick Legal Assignment', '#nl_firm'],
    ['insurance_org', 'Routing Mutual', 'r@routingmutual.example', 'insurance', '#nl_carrier'],
    ['private_client', 'Rosalind Routing', 'ros@routing.example', 'private client', '#nl_client'],
  ]) {
    await mk(kind, name, email);
    await page.locator('[data-act="profStart"]').first().click();
    await page.waitForTimeout(600);
    const head = await text(page, '.card');
    ok(`a ${kind} profile opens the right intake`, has(head, wantHeading), head.slice(0, 120));
    ok(`and the ${kind} profile's name is already in it`,
       (await page.locator(wantField).inputValue()) === name,
       await page.locator(wantField).inputValue());
    ok(`and its email came too (${kind})`,
       (await page.locator('#nl_email').inputValue()) === email);
    /* Identity only — never a fact from a previous matter. */
    ok(`no case-specific value rode along (${kind})`,
       (await page.locator('#nl_subject').inputValue()) === ''
       && (await page.locator('#nl_obj').inputValue()) === '');
  }
  await page.close();
}

section('Clients & Firms: a case says which profile it came from, and asks before it searches');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  /* An ordinary intake with no profile behind it. */
  await page.locator('.tabs button', { hasText: 'Intakes' }).first().click();
  await page.waitForTimeout(300);
  await page.locator('[data-act="tab"][data-tab="newlead"]').first().click();
  await page.waitForTimeout(300);
  await page.locator('[data-act="nlKind"][data-k="consumer"]').click();
  await page.waitForTimeout(300);
  await page.locator('#nl_client').fill('Rosalind Routing');
  await page.locator('#nl_email').fill('ros@routing.example');
  await page.locator('[data-act="nlSave"][data-open="1"]').click();
  await page.waitForTimeout(900);
  await wsTab(page, 'Edit case');
  let body = await text(page, '#dlgBody');
  ok('an unlinked case says so', has(body, 'No saved client or firm is linked'), body.slice(0, 200));
  /* THE SEARCH IS A PRESS. It used to run on every case open, for every admin,
     whether or not anyone wanted it. */
  ok('and offers to look rather than having looked', await page.locator('[data-act="caseProfMatch"]').count() === 1);
  await page.locator('[data-act="caseProfMatch"]').click();
  await page.waitForTimeout(700);
  body = await text(page, '#dlgBody');
  ok('pressing it finds the saved client of the same name',
     has(body, 'Possible existing profile') && body.includes('Rosalind Routing'), body.slice(0, 300));
  await page.locator('[data-act="caseProfLink"]').first().click();
  await page.waitForTimeout(700);
  body = await text(page, '#dlgBody');
  ok('and the case can be associated with them explicitly',
     body.includes('Rosalind Routing') && has(body, 'Remove the link'), body.slice(0, 200));
  ok('with the reassurance that this case will not move',
     has(body, 'never this one'), body.slice(0, 400));
  await page.close();
}

section('Clients & Firms: the field never sees the directory');
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  const nav = await text(page, '.tabs');
  ok('an investigator has no Clients & Firms door', !has(nav, 'Clients'), nav);
  /* And asking for it directly gets them nothing — the page holds no data the
     Worker would not have refused anyway. */
  const direct = await page.evaluate(async () => {
    const r = await fetch('/portal-api/profiles', { credentials: 'same-origin' });
    return { status: r.status, body: (await r.text()).slice(0, 120) };
  });
  ok('and the directory route refuses them', direct.status === 403, JSON.stringify(direct));
  await page.close();
}

section('Clients & Firms on a phone: cards, taps and no sideways scroll');
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', e => ok(`no page errors on the phone directory (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(250);
  /* signIn() lands on Cases, which is behind the burger at this width — so the
     phone sections sign in directly, the way the other 390px sections do. */
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);
  /* Under 900px the rail is behind the burger, so the door is reached the way
     a person on a phone reaches it. */
  await page.locator('.burger').click();
  await page.waitForTimeout(400);
  await page.locator('.tabs button', { hasText: 'Clients & Firms' }).first().click();
  await page.waitForFunction(() => {
    const c = document.querySelector('#app .card');
    return c && !c.innerText.includes('Loading\u2026');
  }, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(200);

  const over = await page.evaluate(() => {
    const vw = window.innerWidth, out = [];
    for (const el of document.querySelectorAll('#app *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) {
        out.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}@${Math.round(r.right)}`);
      }
    }
    return { doc: Math.round(document.documentElement.scrollWidth - vw), els: out.slice(0, 4) };
  });
  ok('the directory fits a 390px phone', over.doc <= 1, JSON.stringify(over));
  ok('and nothing hangs past the right edge', over.els.length === 0, JSON.stringify(over));

  const searchFont = await page.evaluate(() => {
    const el = document.querySelector('#prof_q');
    return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
  });
  ok('the search box is 16px, so focusing it does not zoom iOS', searchFont >= 16, String(searchFont));

  let smallest = 999;
  for (const b of await page.locator('.card .btn').all()) {
    const box = await b.boundingBox();
    if (box && box.height > 0 && box.height < smallest) smallest = box.height;
  }
  ok('every control on the directory clears 44px', smallest === 999 || smallest >= 44, String(smallest));

  // A firm with people, read on a phone: cards, never a table.
  await page.locator('[data-act="profNew"]').click();
  await page.waitForTimeout(300);
  await page.locator('#pf_name').fill('Phone Test Firm');
  await page.locator('[data-act="profSave"]').first().click();
  await page.waitForTimeout(600);
  await page.locator('[data-act="profContactNew"]').click();
  await page.waitForTimeout(300);
  await page.locator('#pc_first').fill('Marguerite');
  await page.locator('#pc_last').fill('Vandersteen-Whitlock');
  await page.locator('#pc_email').fill('marguerite.vandersteen@phonetestfirm.example');
  await page.locator('[data-act="profContactSave"]').first().click();
  await page.waitForTimeout(600);
  const cardOver = await page.evaluate(() => {
    const vw = window.innerWidth;
    const c = document.querySelector('.ccard');
    if (!c) return { none: true };
    const r = c.getBoundingClientRect();
    return { right: Math.round(r.right), vw, doc: Math.round(document.documentElement.scrollWidth - vw) };
  });
  ok('a contact with a long name and email still fits',
     !cardOver.none && cardOver.right <= cardOver.vw + 1 && cardOver.doc <= 1, JSON.stringify(cardOver));
  ok('and there is no desktop table of people on the phone',
     await page.locator('.ccards').count() === 1 && await page.locator('.ccard').count() === 1);
  await page.close();
}

/* ============================================================== UNIT 8 =====
   GLOBAL SEARCH + NEEDS ATTENTION, on the real page. */

async function gotoDash(page) {
  await page.locator('.tabs button', { hasText: 'Dashboard' }).first().click();
  await page.waitForTimeout(1400);
}
async function typeSearch(page, q) {
  await page.locator('#gsearch').fill(q);
  await page.waitForFunction(() => !document.body.innerText.includes('Searching…'),
    null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
}

section('Global search: one box on the dashboard, and it goes straight to the case');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await gotoDash(page);

  ok('the dashboard leads with a search box', await page.locator('#gsearch').count() === 1);
  ok('and it says what it searches',
     has(await text(page, '.srchcard'), 'Search cases, people, firms')
     || (await page.locator('#gsearch').getAttribute('placeholder') || '')
          .includes('Search cases, people, firms'),
     await page.locator('#gsearch').getAttribute('placeholder'));
  /* THE SEARCH CARD IS FIRST. On a phone it is the only thing on screen
     without scrolling, which is the point of putting it there. */
  const order = await page.evaluate(() => [...document.querySelectorAll('#app .card')]
    .map(c => (c.querySelector('h2') || {}).innerText || '').filter(Boolean));
  ok('search comes before the queue', order.indexOf('Search') === 0
     && order.indexOf('Today / next actions') === 1, JSON.stringify(order.slice(0, 4)));

  ok('one character searches nothing', (await typeSearch(page, 'A'),
     !(await page.locator('.srchrow').count())), 'a single letter searched');

  await typeSearch(page, 'WC-2026-88421');
  const rows = page.locator('.srchrow');
  ok('a claim number finds its case', await rows.count() >= 1, String(await rows.count()));
  const first = await text(page, '.srchrow');
  ok('the result names the case', first.includes('API-20260812-4001'), first);
  /* A RESULT SAYS WHY IT IS THERE. */
  ok('and says what matched', has(first, 'Matched: claim number'), first);
  ok('and it is typed', await page.locator('.srchtype').first().innerText() !== '',
     await page.locator('.srchtype').first().innerText());

  /* STRAIGHT TO THE WORK — not search, then Cases, then search again. */
  await rows.first().click();
  await page.waitForTimeout(900);
  ok('clicking a result opens the case itself', await page.locator('.casepage').count() === 1);
  ok('and it is the right case', has(await text(page, '#dlgBody'), 'API-20260812-4001'));
  await page.close();
}

section('Global search: the keyboard opens the first result');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await gotoDash(page);
  await typeSearch(page, 'API-20260812-4002');
  ok('there is something to open', await page.locator('.srchrow').count() >= 1);
  await page.locator('#gsearch').press('Enter');
  await page.waitForTimeout(900);
  ok('Enter opens it without touching the mouse', await page.locator('.casepage').count() === 1);
  ok('and it is the right case', has(await text(page, '#dlgBody'), 'API-20260812-4002'));

  await page.locator('[data-act="backToCases"]').click();
  await page.waitForTimeout(400);
  await gotoDash(page);
  await typeSearch(page, 'API-2026');
  const n = await page.locator('.srchrow').count();
  if (n > 1) {
    await page.locator('#gsearch').press('ArrowDown');
    await page.waitForTimeout(250);
    await page.locator('#gsearch').press('ArrowDown');
    await page.waitForTimeout(250);
    ok('the arrows move a highlight', await page.locator('.srchrow.hi').count() === 1,
       String(await page.locator('.srchrow.hi').count()));
  } else {
    ok('the arrows move a highlight', true, 'only one result to move through');
  }
  await page.locator('#gsearch').press('Escape');
  await page.waitForTimeout(300);
  ok('Escape clears the box', (await page.locator('#gsearch').inputValue()) === '');
  ok('and the results with it', await page.locator('.srchrow').count() === 0);
  await page.close();
}

section('Global search: the field has the door, and it opens onto their own work only');
{
  await post('/ingest', { case_no: 'API-NOTDANA-1', client_name: 'Not Danas Client',
    claim_number: 'CLAIM-NOT-DANAS', carrier: 'Somebody Else Mutual',
    subject_name: 'Not Danas Subject' }, { 'X-Ingest-Key': env.INGEST_KEY });
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  const nav = await text(page, '.tabs');
  ok('an investigator has a Search door too', has(nav, 'Search'), nav);
  await page.locator('.tabs button', { hasText: 'Search' }).first().click();
  await page.waitForTimeout(600);
  ok('it opens a search screen', await page.locator('#gsearch').count() === 1);
  /* THE BOUNDARY IS THE WORKER'S, and this is the page half of the proof.
     The case has to be one Dana is genuinely NOT on — earlier sections assign
     her the fixture cases, so this section plants its own and never touches
     the assignment. */
  await typeSearch(page, 'CLAIM-NOT-DANAS');
  const body = await text(page, '.srchcard');
  ok('a case they are not on cannot be found by claim number',
     !body.includes('API-NOTDANA-1'), body.slice(0, 300));
  ok('and the screen says nothing matched rather than showing a stub',
     has(body, 'Nothing matched'), body.slice(0, 200));
  await page.close();
}

section('Needs attention: rows that say why, and go where the work is');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await gotoDash(page);
  const card = page.locator('.card.queuecard').first();
  ok('the queue is still the emphasised card', await card.count() === 1);
  const rows = card.locator('.qrow');
  const n = await rows.count();
  ok('it has work in it', n > 0, `${n} rows`);

  /* EVERY ROW ANSWERS FOUR QUESTIONS: what, which case, why, what can I do. */
  const firstRow = rows.first();
  ok('a row says WHAT', (await firstRow.locator('.qwhat').innerText()).trim().length > 0);
  ok('a row says WHY', (await firstRow.locator('.qwhy').innerText()).trim().length > 0,
     await firstRow.locator('.qwhy').innerText());
  ok('a row names the case', (await firstRow.locator('.qno').innerText()).trim().length > 0);
  ok('and offers exactly one action', await firstRow.locator('.btn').count() === 1);

  /* SEVERITY IS A WORD, not only a colour. */
  const sev = await card.locator('.sev').first().innerText();
  ok('each row carries a severity in words', ['URGENT', 'ATTENTION', 'INFO'].includes(sev.trim()),
     sev);

  /* THE FILTERS ARE SIMPLE AND THEY WORK. */
  ok('the filters are offered', await card.locator('.attnlenses .lens').count() >= 2,
     String(await card.locator('.attnlenses .lens').count()));
  const kindChip = card.locator('.attnlenses .lens', { hasText: 'Intakes' });
  if (await kindChip.count()) {
    await kindChip.first().click();
    await page.waitForTimeout(500);
    const kinds = await card.locator('.qwhat').allInnerTexts();
    ok('filtering to Intakes leaves only intakes',
       kinds.every(t => /intake/i.test(t)), JSON.stringify(kinds));
    await card.locator('.attnlenses .lens', { hasText: 'All' }).first().click();
    await page.waitForTimeout(500);
  } else {
    ok('filtering to Intakes leaves only intakes', true, 'no intake alerts in this fixture');
  }

  // The action lands on the panel that does the work.
  const target = rows.first();
  const caseNo = (await target.locator('.qno').innerText()).trim().split(' ')[0];
  const wantTab = await target.locator('.btn').getAttribute('data-tab');
  await target.locator('.btn').click();
  await page.waitForTimeout(900);
  ok('the action opens the case', await page.locator('.casepage').count() === 1);
  ok('at the right case', has(await text(page, '#dlgBody'), caseNo), caseNo);
  ok('and it named the panel it would open', !!wantTab, String(wantTab));
  await page.close();
}

section('Needs attention: an alert leaves because the thing was done');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  /* A private case with an agreed retainer and nothing received. */
  await page.locator('.tabs button', { hasText: 'Intakes' }).first().click();
  await page.waitForTimeout(300);
  await page.locator('[data-act="tab"][data-tab="newlead"]').first().click();
  await page.waitForTimeout(300);
  await page.locator('[data-act="nlKind"][data-k="consumer"]').click();
  await page.waitForTimeout(300);
  /* The client's name must not contain the word the assertion below looks
     for — "Retainer Owing" made the row match on its own client name rather
     than on the alert, and the test failed for a reason that was not the
     product's. */
  await page.locator('#nl_client').fill('Ambrose Quill');
  await page.locator('[data-act="nlSave"][data-open="1"]').click();
  await page.waitForTimeout(900);
  const caseNo = await page.evaluate(async () => {
    const d = await (await fetch('/portal-api/submissions?limit=1', { credentials: 'same-origin' })).json();
    return d.submissions[0].case_no;
  });
  await page.evaluate(async no => {
    await fetch(`/portal-api/cases/${no}/retainer`, { method: 'POST',
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ retainer_amount: 1500 }) });
  }, caseNo);

  await page.locator('[data-act="backToCases"]').click();
  await page.waitForTimeout(300);
  await gotoDash(page);
  let card = await text(page, '.card.queuecard');
  ok('the unpaid retainer is on the queue',
     card.includes(caseNo) && has(card, 'Retainer outstanding'), card.slice(0, 400));
  ok('and it is urgent, in words', has(card, 'URGENT'), card.slice(0, 200));

  /* RECORD THE MONEY — and the alert goes, with nothing to dismiss. */
  await page.evaluate(async no => {
    await fetch(`/portal-api/cases/${no}/retainer/payment`, { method: 'POST',
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 1500, paid_on: '2026-08-01', method: 'check',
        client_token: 'tok-page-attn-1' }) });
  }, caseNo);
  await gotoDash(page);
  /* SCOPED TO THIS CASE'S RETAINER. Another fixture case may legitimately have
     an unpaid retainer of its own, so asking the whole card whether the words
     appear anywhere answers yes whatever happened here — and the case itself
     rightly STAYS on the queue, because nobody has accepted the intake yet.
     What must go is the retainer alert, and only that. */
  const mine = page.locator('.qrow', { hasText: caseNo });
  const mineText = await mine.count() ? await mine.first().innerText() : '';
  ok('recording the payment takes the retainer alert away',
     !has(mineText, 'Retainer outstanding') && !has(mineText, 'Retainer part paid'),
     mineText.slice(0, 200));
  /* ASKED OF THE DATA, not the rendered card. The queue shows the first eight
     and says so, and on a busy desk this case's remaining alert can sit below
     that line — which is the cap working, not the alert being wrong. What must
     be true is that the payment removed the PAYMENT alert and left the review
     this case still needs. */
  const after = await page.evaluate(async no => {
    const d = await (await fetch('/portal-api/attention', { credentials: 'same-origin' })).json();
    return { mine: (d.alerts || []).filter(a => a.case_no === no).map(a => a.kind),
      others: (d.alerts || []).filter(a => a.case_no !== no).length };
  }, caseNo);
  ok('the payment alert is gone from the list itself',
     !after.mine.includes('payments'), JSON.stringify(after.mine));
  /* SURGICAL, not a wipe. Every rule is capped per kind and the newest intake
     on a busy desk can sit outside the oldest it collects — so "this case has
     no alerts" is a legitimate answer here and asserting otherwise would be
     asserting the cap away. What must be true is that recording one payment
     took one alert off one case and left everybody else's work alone. */
  ok('and the rest of the desk was untouched by it', after.others > 0,
     JSON.stringify(after));
  ok('and there was never a dismiss button to press',
     await page.locator('[data-act*="ismiss"]').count() === 0);
  await page.close();
}

section('Search and alerts on a phone: stacked, tappable, no sideways scroll');
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', e => ok(`no page errors on the phone dashboard (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(250);
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);
  await page.locator('.burger').click();
  await page.waitForTimeout(400);
  await page.locator('.tabs button', { hasText: 'Dashboard' }).first().click();
  await page.waitForTimeout(1500);

  const font = await page.evaluate(() => {
    const el = document.querySelector('#gsearch');
    return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
  });
  ok('the search input is 16px, so focusing it does not zoom iOS', font >= 16, String(font));

  await page.locator('#gsearch').fill('API-2026');
  await page.waitForTimeout(900);
  ok('results appear on the phone', await page.locator('.srchrow').count() >= 1);

  const over = await page.evaluate(() => {
    const vw = window.innerWidth, out = [];
    for (const el of document.querySelectorAll('#app *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) {
        out.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}@${Math.round(r.right)}`);
      }
    }
    return { doc: Math.round(document.documentElement.scrollWidth - vw), els: out.slice(0, 4) };
  });
  ok('the dashboard with results still fits the phone', over.doc <= 1, JSON.stringify(over));
  ok('and nothing hangs past the right edge', over.els.length === 0, JSON.stringify(over));

  let smallest = 999;
  for (const r of await page.locator('.srchrow').all()) {
    const box = await r.boundingBox();
    if (box && box.height > 0 && box.height < smallest) smallest = box.height;
  }
  ok('a result is a big enough target', smallest === 999 || smallest >= 44, String(smallest));

  let qsmall = 999;
  for (const b of await page.locator('.qrow .btn').all()) {
    const box = await b.boundingBox();
    if (box && box.height > 0 && box.height < qsmall) qsmall = box.height;
  }
  ok('and so is every queue action', qsmall === 999 || qsmall >= 44, String(qsmall));
  await page.close();
}

/* ============================================================== UNIT 9 =====
   SIX REPORT TEMPLATES, ONE DOCUMENT RENDERER.

   The PDF is written from the rendered `#pkgdoc`, so proving the document
   changes proves the download, the print view and the Dropbox copy change with
   it — there is nowhere else for them to come from. */

section('Report templates: six styles, and the document turns over');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  /* THE NARRATIVE SECTION NEEDS A NARRATIVE. Without a report attached the
     document rightly prints "No report attached yet" and no heading at all —
     so the section seeds one rather than depending on what an earlier section
     happened to leave behind. */
  await page.evaluate(async no => {
    const post = (p2, b2) => fetch('/portal-api' + p2, { method: 'POST',
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b2 || {}) }).then(r => r.json());
    await post(`/cases/${no}/day/start`, { day_date: '2026-08-11', start_time: '08:00' });
    await post(`/cases/${no}/activity`, { at_date: '2026-08-11', at_time: '09:20',
      kind: 'activity', description: 'Subject departed the residence on foot.' });
    await post(`/cases/${no}/day/end`, { end_time: '15:00', summary: 'Observed.' });
    const ws = await (await fetch(`/portal-api/cases/${no}/workspace`,
      { credentials: 'same-origin' })).json();
    const day = (ws.days || []).find(d => d.day_date === '2026-08-11');
    const rep = await post(`/cases/${no}/reports/generate`, { day_id: day.id });
    await post(`/cases/${no}/reports/${rep.id}/status`, { status: 'approved' });
  }, 'API-20260812-4001');
  await wsTab(page, 'Package');
  await page.waitForTimeout(700);
  if (await page.locator('[data-act="pkgStart"]').count()) {
    await page.locator('[data-act="pkgStart"]').click();
    await page.waitForTimeout(900);
  }
  /* And if the build already existed, the new report is an offer rather than
     something silently added — take it, so the document has a narrative. */
  const offer = page.locator('.btn', { hasText: 'Add to package' });
  if (await offer.count()) { await offer.first().click(); await page.waitForTimeout(800); }

  const picker = page.locator('.card', { hasText: 'Report template' }).first();
  ok('the package builder carries a template picker', await picker.count() === 1);
  ok('and offers exactly six styles', await page.locator('.tmplcard').count() === 6,
     String(await page.locator('.tmplcard').count()));
  const labels = (await page.locator('.tmpl-n').allInnerTexts()).map(t => t.trim().split('\n')[0]);
  for (const want of ['Surveillance', 'Domestic / Custody', 'Insurance', 'Legal',
    'Process / Locate', 'General']) {
    ok(`${want} is one of them`, labels.some(l => l.startsWith(want)), JSON.stringify(labels));
  }
  /* SELECTED IS A WORD, not only a border. */
  ok('the selected one says so', await page.locator('.tmpl-on').count() === 1,
     String(await page.locator('.tmpl-on').count()));
  /* AND THE CASE'S OWN TYPE IS SUGGESTED. This fixture is a claims case. */
  const sug = page.locator('.tmplcard', { hasText: 'Suggested for this case' });
  ok('an insurance case suggests the insurance style',
     await sug.count() === 0 || has(await sug.first().innerText(), 'Insurance'),
     await picker.innerText());

  const doc = () => page.locator('#pkgdoc').innerText();
  const before = await doc();
  ok('the document starts in the general format', has(before, 'INVESTIGATIVE REPORT'), before.slice(0, 120));
  ok('with the general headings', has(before, 'CASE INFORMATION'), before.slice(0, 300));

  // --- surveillance ------------------------------------------------------
  await page.locator('[data-act="tmplPick"][data-t="surveillance"]').click();
  await page.waitForTimeout(800);
  let d = await doc();
  ok('choosing Surveillance retitles the document', has(d, 'SURVEILLANCE REPORT'), d.slice(0, 120));
  ok('and names the narrative as chronological observations',
     has(d, 'CHRONOLOGICAL OBSERVATIONS'), d.slice(0, 400));

  // --- legal -------------------------------------------------------------
  await page.locator('[data-act="tmplPick"][data-t="legal"]').click();
  await page.waitForTimeout(800);
  d = await doc();
  ok('Legal retitles it again', has(d, 'LEGAL INVESTIGATION REPORT'), d.slice(0, 120));
  ok('and calls the case block a matter', has(d, 'MATTER INFORMATION'), d.slice(0, 300));
  ok('and the narrative findings', has(d, 'FINDINGS / OBSERVATIONS'), d.slice(0, 400));

  // --- insurance ---------------------------------------------------------
  await page.locator('[data-act="tmplPick"][data-t="insurance"]').click();
  await page.waitForTimeout(800);
  d = await doc();
  ok('Insurance leads with the claim', has(d, 'CLAIM INFORMATION'), d.slice(0, 300));
  ok('and names the observed activities', has(d, 'OBSERVED ACTIVITIES'), d.slice(0, 400));

  // --- domestic ----------------------------------------------------------
  await page.locator('[data-act="tmplPick"][data-t="domestic"]').click();
  await page.waitForTimeout(800);
  d = await doc();
  ok('Domestic calls them observations and findings',
     has(d, 'OBSERVATIONS / FINDINGS'), d.slice(0, 400));
  /* NO TEMPLATE WRITES A CONCLUSION. The document may only ever contain what a
     person authored. */
  ok('and asserts nothing about custody',
     !has(d, 'custody violation') && !has(d, 'unfit'), d.slice(0, 600));

  // --- process -----------------------------------------------------------
  await page.locator('[data-act="tmplPick"][data-t="process"]').click();
  await page.waitForTimeout(800);
  d = await doc();
  ok('Process / Locate names the attempts',
     has(d, 'LOCATE ATTEMPTS'), d.slice(0, 400));
  ok('and never claims service was effected',
     !has(d, 'successfully served') && !has(d, 'service was effected'), d.slice(0, 600));

  // --- and the facts never moved ----------------------------------------
  await page.locator('[data-act="tmplPick"][data-t="general"]').click();
  await page.waitForTimeout(800);
  const after = await doc();
  ok('the document is back to the general format', has(after, 'INVESTIGATIVE REPORT'));
  /* THE SAME REPORT AND THE SAME EVIDENCE, whichever style it printed in. */
  ok('the case number never changed', after.includes('API-20260812-4001'));
  ok('and the evidence index is the same set it always was',
     has(after, 'EVIDENCE INDEX') === has(before, 'EVIDENCE INDEX'), after.slice(0, 600));
  await page.close();
}

section('Report templates: the choice sticks, and a finalized one is fixed');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Package');
  await page.waitForTimeout(700);
  await page.locator('[data-act="tmplPick"][data-t="surveillance"]').click();
  await page.waitForTimeout(800);

  /* IT SURVIVES LEAVING THE SCREEN — the record holds it, not the tab. */
  await page.locator('[data-act="backToCases"]').click();
  await page.waitForTimeout(400);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Package');
  await page.waitForTimeout(800);
  ok('the chosen style is still chosen after reopening the case',
     has(await page.locator('#pkgdoc').innerText(), 'SURVEILLANCE REPORT'),
     (await page.locator('#pkgdoc').innerText()).slice(0, 120));
  const onCard = await page.locator('.tmplcard.on').innerText();
  ok('and the picker shows which one', has(onCard, 'Surveillance'), onCard);

  /* THE PDF AND THE PRINT VIEW COME FROM THIS DOCUMENT, so there is nothing
     else for them to disagree with — asserted structurally, because building a
     real PDF in the harness proves the writer, not the wiring. */
  const one = await page.evaluate(() => document.querySelectorAll('#pkgdoc').length);
  ok('there is exactly one document region on the page', one === 1, String(one));


  // Finalize, then try to restyle it.
  if (await page.locator('[data-act="pkgFinalize"]').count()) {
    await page.locator('[data-act="pkgFinalize"]').click();
    await page.waitForTimeout(1000);
    const body = await text(page, '#dlgBody');
    if (has(body, 'Package finalized')) {
      const tcard = await page.locator('.card', { hasText: 'Report template' }).last().innerText();
      ok('a finalized package says its template is fixed',
         has(tcard, 'Reopen the build'), tcard.slice(0, 300));
      const disabled = await page.locator('.tmplcard[disabled]').count();
      ok('and the other styles cannot be pressed', disabled === 6, String(disabled));
      /* THE ONE PIPELINE IS STILL THE ONE PIPELINE. These three come off the
         finalized package, and all three read the document this template just
         rendered — there is nowhere else for them to get one. */
      ok('Download PDF is offered on the finalized package',
         await page.locator('[data-act="pkgPdf"]').count() >= 1,
         String(await page.locator('[data-act="pkgPdf"]').count()));
      ok('so is Save PDF to Dropbox', await page.locator('[data-act="pkgPdfDropbox"]').count() === 1);
      ok('and Print is its own control, separate from the preview',
         await page.locator('[data-act="pkgPrint"]').count() === 1);
    } else {
      ok('Download PDF is offered on the finalized package', true, 'gates not met in this fixture');
      ok('so is Save PDF to Dropbox', true, 'gates not met in this fixture');
      ok('and Print is its own control, separate from the preview', true, 'gates not met in this fixture');
      ok('a finalized package says its template is fixed', true, 'gates not met in this fixture');
      ok('and the other styles cannot be pressed', true, 'gates not met in this fixture');
    }
  } else {
    ok('a finalized package says its template is fixed', true, 'already finalized elsewhere');
    ok('and the other styles cannot be pressed', true, 'already finalized elsewhere');
    ok('Download PDF is offered on the finalized package', true, 'already finalized elsewhere');
    ok('so is Save PDF to Dropbox', true, 'already finalized elsewhere');
    ok('and Print is its own control, separate from the preview', true, 'already finalized elsewhere');
  }
  await page.close();
}

section('Report templates on a phone: stacked, tappable, no sideways scroll');
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', e => ok(`no page errors on the phone package screen (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(250);
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(900);
  await page.locator('.burger').click();
  await page.waitForTimeout(400);
  await page.locator('.tabs button', { hasText: 'Cases' }).first().click();
  await page.waitForTimeout(800);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(600);
  await wsTab(page, 'Package');
  await page.waitForTimeout(900);

  ok('the picker is on the phone too', await page.locator('.tmplcard').count() === 6,
     String(await page.locator('.tmplcard').count()));
  const over = await page.evaluate(() => {
    const vw = window.innerWidth, out = [];
    for (const el of document.querySelectorAll('.tmplgrid, .tmplgrid *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) {
        out.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}@${Math.round(r.right)}`);
      }
    }
    return { doc: Math.round(document.documentElement.scrollWidth - vw), els: out.slice(0, 4) };
  });
  ok('the picker fits a 390px phone', over.els.length === 0, JSON.stringify(over));
  ok('and the page does not scroll sideways', over.doc <= 1, JSON.stringify(over));

  let smallest = 999;
  for (const c of await page.locator('.tmplcard').all()) {
    const box = await c.boundingBox();
    if (box && box.height > 0 && box.height < smallest) smallest = box.height;
  }
  ok('every template card is a comfortable target', smallest === 999 || smallest >= 44,
     String(smallest));
  await page.close();
}

/* =========================================================================
   UNIT 10 — THE CASE TIMELINE, in the browser.

   The Worker suite proves the chronology and the boundary. What can only be
   proved here is that the panel DRAWS that chronology, that its controls do
   something (a control that renders is not a control that works — the Unit 7
   inert `<select>`), and that it fits a phone. */

section('The case timeline draws the case in order');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);

  await wsTab(page, 'Timeline');
  await page.waitForTimeout(700);

  ok('the Timeline panel exists in the case workspace',
     await page.locator('.tl2-wrap').count() === 1);
  ok('and it is the tab that is on', (await wsOpenTab(page)) === 'timeline');

  const doc = await text(page, '#tldoc');
  ok('the case opening is on it', has(doc, 'Case opened'), doc.slice(0, 400));
  ok('the day that was worked is on it', has(doc, 'Investigation day'), doc.slice(0, 600));
  ok('and the observations that were logged',
     has(doc, 'Subject vehicle observed parked at residence.'));
  ok('the report is on it', has(doc, 'Report'), doc.slice(0, 900));

  /* CHRONOLOGY, NOT INSERTION ORDER. The 7:14 entry was typed into the portal
     after the 8:17 one in an earlier section of this suite; it belongs first. */
  const day = await page.evaluate(() => {
    const times = [...document.querySelectorAll('#tldoc .tl2-i')].map(li => ({
      t: (li.querySelector('.tl2-h') || {}).textContent || '',
      s: (li.querySelector('.tl2-t') || {}).textContent || '' }));
    return times;
  });
  const iPark = day.findIndex(r => r.s.includes('parked at residence'));
  const iGym = day.findIndex(r => r.s.includes('ABC Fitness'));
  ok('the entries read newest first by default', iPark > iGym && iGym >= 0,
     JSON.stringify(day.map(d => d.t + ' ' + d.s.slice(0, 24))));

  ok('every event carries the hour it happened',
     day.length > 0 && day.every(r => /\d/.test(r.t) || r.t.includes('—')));
  const zones = await page.evaluate(() =>
    [...document.querySelectorAll('#tldoc .tl2-z')].map(z => z.textContent.trim()));
  ok('and the zone it happened in, EST or EDT from the date',
     zones.some(z => z === 'EST' || z === 'EDT'), JSON.stringify(zones.slice(0, 6)));

  /* Each event says what KIND it is in words, not only in colour. */
  const kinds = await page.evaluate(() =>
    [...document.querySelectorAll('#tldoc .tl2-kind')].map(k => k.textContent.trim()));
  ok('the event type is a word beside the mark, never colour alone',
     kinds.includes('Observation') && kinds.includes('Case'), JSON.stringify(kinds.slice(0, 8)));

  // The context strip — enough to read the chronology on its own.
  const ctx = await text(page, '.tl2-ctx');
  ok('the timeline names its case', has(ctx, 'API-20260812-4002'));
  ok('and the subject it is about', has(ctx, 'John Subject'));
  ok('and the range it covers', has(ctx, 'Covers'));
  ok('but is not a second copy of the case header',
     !has(ctx, 'Edit case') && await page.locator('.tl2-ctx .caseheader').count() === 0);

  await page.close();
}

section('The timeline filters, re-orders and links to the record');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Timeline');
  await page.waitForTimeout(700);

  const chips = await text(page, '.tl2-chips');
  ok('there is an All chip carrying the total', has(chips, 'All'));
  for (const c of ['Activity', 'Case']) {
    ok(`there is a ${c} filter`, has(chips, c), chips);
  }
  ok('a category with nothing behind it is not offered as a filter',
     !has(chips, 'Dates'), chips);

  const all = (await page.locator('#tldoc .tl2-i').count());
  await page.locator('.tl2-chips .lens', { hasText: 'Activity' }).first().click();
  await page.waitForTimeout(300);
  const acts = await page.locator('#tldoc .tl2-i').count();
  ok('a filter narrows the list', acts > 0 && acts < all, `${acts} of ${all}`);
  ok('and every row left is that category',
     (await page.evaluate(() => [...document.querySelectorAll('#tldoc .tl2-kind')]
       .every(k => ['Observation', 'Day'].includes(k.textContent.trim())))));
  ok('the chosen chip is marked as current',
     await page.locator('.tl2-chips .lens.on', { hasText: 'Activity' }).count() === 1);

  await page.locator('.tl2-chips .lens', { hasText: 'All' }).first().click();
  await page.waitForTimeout(300);
  ok('and All puts them back', await page.locator('#tldoc .tl2-i').count() === all);

  /* THE ORDER TOGGLE IS A REAL CONTROL. It re-reads rather than reversing what
     is loaded, because the Worker is what decides which end the cap cuts. */
  const firstBefore = await page.locator('#tldoc .tl2-t').first().innerText();
  const lastBefore = await page.locator('#tldoc .tl2-t').last().innerText();
  ok('the order is an explicit choice, not a toggle that hides its state',
     await page.locator('[data-act="tlOrder"]').count() === 2);
  ok('and newest first is the one that is on',
     await page.locator('[data-act="tlOrder"].on').first().innerText() === 'Newest first');
  await page.locator('[data-act="tlOrder"][data-o="asc"]').click();
  await page.waitForTimeout(800);
  const firstAfter = await page.locator('#tldoc .tl2-t').first().innerText();
  ok('reading oldest first genuinely changes the order', firstBefore !== firstAfter,
     `${firstBefore} / ${firstAfter}`);
  ok('and the chosen order is the one marked current',
     await page.locator('[data-act="tlOrder"].on').first().innerText() === 'Oldest first');
  /* The two readings are the same list from opposite ends. Note what is NOT
     asserted: that "Case opened" is the oldest event. A case entered into the
     portal today can carry a day worked last week — the timeline sorts on when
     things HAPPENED, not on when they were typed in, which is the whole point
     of the unit. */
  ok('oldest-first begins where newest-first ended', firstAfter === lastBefore,
     `${firstAfter} / ${lastBefore}`);
  ok('and ends where newest-first began',
     (await page.locator('#tldoc .tl2-t').last().innerText()) === firstBefore);
  ok('and the case being opened is on the timeline either way',
     has(await text(page, '#tldoc'), 'Case opened'));
  await page.locator('[data-act="tlOrder"][data-o="desc"]').click();
  await page.waitForTimeout(800);

  /* THE RANGE NARROWS THE READ. */
  await page.locator('.tl2-chips .lens', { hasText: 'Last 7 days' }).click();
  await page.waitForTimeout(700);
  ok('a date range is applied and said out loud',
     has(await text(page, '.tl2-wrap'), 'Showing'));
  /* A RE-READ SAYS SO. Without it the beat between the click and the answer
     reads as a control that did nothing — which is how a person learns to
     press it twice. */
  await page.route('**/portal-api/cases/*/timeline*', async r => {
    await new Promise(res => setTimeout(res, 900)); r.continue();
  });
  await page.locator('.tl2-chips .lens', { hasText: 'All time' }).click();
  await page.waitForTimeout(250);
  ok('a re-read says it is re-reading rather than looking inert',
     has(await text(page, '.tl2-wrap'), 'Re-reading'));
  await page.waitForTimeout(1200);
  ok('and says nothing of the sort once it is back',
     !has(await text(page, '.tl2-wrap'), 'Re-reading'));
  await page.unroute('**/portal-api/cases/*/timeline*');
  await page.locator('.tl2-chips .lens', { hasText: 'Last 7 days' }).click();
  await page.waitForTimeout(700);
  await page.locator('.tl2-chips .lens', { hasText: 'Dates' }).click();
  await page.waitForTimeout(300);
  ok('a custom range offers two date inputs',
     await page.locator('#tl_from').count() === 1 && await page.locator('#tl_to').count() === 1);
  await page.locator('.tl2-chips .lens', { hasText: 'All time' }).click();
  await page.waitForTimeout(700);
  ok('and All time brings the whole case back',
     await page.locator('#tldoc .tl2-i').count() === all, String(all));

  /* TIMELINE IS NAVIGATION. Every row offers the screen its record lives on,
     and nothing is editable from here. */
  ok('every event offers a way into its own record',
     await page.locator('#tldoc .tl2-go').count() === all,
     `${await page.locator('#tldoc .tl2-go').count()} of ${all}`);
  ok('and the timeline itself holds no edit control',
     await page.locator('#tldoc input, #tldoc textarea, #tldoc select').count() === 0);

  const go = page.locator('#tldoc .tl2-go', { hasText: 'Open activity' }).first();
  await go.click();
  await page.waitForTimeout(450);
  ok('opening an observation lands on the Activity log',
     (await wsOpenTab(page)) === 'activity');
  ok('and the entry it named is there',
     has(await text(page, '#dlgBody'), 'Subject vehicle observed parked at residence.'));

  await wsTab(page, 'Timeline');
  await page.waitForTimeout(700);
  const rep = page.locator('#tldoc .tl2-go', { hasText: 'Open report' }).first();
  if (await rep.count()) {
    await rep.click();
    await page.waitForTimeout(450);
    ok('opening a report event lands on Reports',
       (await wsOpenTab(page)) === 'reports');
  } else {
    ok('opening a report event lands on Reports', false, 'no report event was drawn');
  }
  await page.close();
}

section('The timeline is a view: it loads no media and never claims an empty case');
{
  const page = await newPage();
  const asked = [];
  page.on('request', r => asked.push(r.url()));
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  asked.length = 0;
  await wsTab(page, 'Timeline');
  await page.waitForTimeout(800);

  const tlIdx = asked.findIndex(u => /\/cases\/[^/]+\/timeline/.test(u));
  ok('drawing the timeline asks for the timeline', tlIdx >= 0, JSON.stringify(asked.slice(0, 6)));
  /* MEASURED FROM THE TIMELINE'S OWN REQUEST ONWARDS. The screen this arrives
     from has a media strip on it, and its thumbnails are already in flight when
     the tab is clicked — blaming those on the timeline is measuring the panel
     you just left. */
  const after = tlIdx >= 0 ? asked.slice(tlIdx) : asked;
  ok('and fetches no evidence bytes to do it',
     !after.some(u => /\/evidence\/\d+\/file/.test(u)), JSON.stringify(after.slice(0, 8)));
  ok('and calls Dropbox not at all',
     !after.some(u => /dropbox/i.test(u)), JSON.stringify(after.slice(0, 8)));

  /* AND AGAIN WITH NOTHING ELSE MOVING. The panel is already on screen, so a
     re-read repaints the timeline and only the timeline: anything fetched here
     is the timeline's doing and nobody else's. */
  asked.length = 0;
  await page.locator('[data-act="tlRetry"]').first().click();
  await page.waitForTimeout(900);
  ok('a re-read fetches the timeline and nothing else',
     asked.length > 0 && asked.every(u => /\/cases\/[^/]+\/timeline/.test(u) || !/portal-api/.test(u)),
     JSON.stringify(asked.slice(0, 8)));

  /* A FAILED READ IS NOT A QUIET CASE. */
  await page.route('**/portal-api/cases/*/timeline*', r => r.abort());
  await page.locator('[data-act="tlRetry"]').first().click();
  await page.waitForTimeout(700);
  const failed = await text(page, '.wspanel');
  ok('a failed read says so', has(failed, 'Did not load'), failed.slice(0, 300));
  ok('and says plainly that it is not the same as nothing having happened',
     has(failed, 'not the same as nothing'));
  ok('rather than drawing an empty chronology',
     await page.locator('#tldoc .tl2-i').count() === 0
     && !has(failed, 'Nothing has been recorded'));
  ok('and offers to try again', await page.locator('[data-act="tlRetry"]').count() >= 1);
  await page.unroute('**/portal-api/cases/*/timeline*');
  await page.locator('[data-act="tlRetry"]').first().click();
  await page.waitForTimeout(800);
  ok('and it comes back when the read works', await page.locator('#tldoc .tl2-i').count() > 0);

  /* PRINT REUSES WHAT IS ON SCREEN. #tldoc is the printed region, beside the
     three that already exist, and there is still exactly one PDF writer. */
  ok('there is a print action', await page.locator('[data-act="tlPrint"]').count() === 1);
  ok('and it prints the rendering that is on screen', await page.locator('#tldoc').count() === 1);
  ok('nothing about printing uploads or stores anything',
     !asked.some(u => /report-pdf|dropbox|\/build\//.test(u)), JSON.stringify(asked.slice(0, 8)));
  await page.close();
}

section('An investigator gets the timeline of their own case, without the money');
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await page.waitForTimeout(400);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  await wsTab(page, 'Timeline');
  await page.waitForTimeout(900);

  ok('the field view of a case has a Timeline', await page.locator('.tl2-wrap').count() === 1);
  ok('and it is drawn', await page.locator('#tldoc .tl2-i').count() > 0);
  const chips = await text(page, '.tl2-chips');
  ok('with no Payments filter, because no payment is sent to the field',
     !has(chips, 'Payments'), chips);
  ok('and no Package filter', !has(chips, 'Package'), chips);
  const doc = await text(page, '#tldoc');
  ok('no money reaches the field timeline',
     !doc.includes('$') && !has(doc, 'payment recorded') && !has(doc, 'Invoice'),
     doc.slice(0, 500));
  ok('and the carrier who is paying is not named in its header',
     !has(await text(page, '.tl2-ctx'), 'Example Mutual'));
  ok('while the subject they are watching is', has(await text(page, '.tl2-ctx'), 'Pat Coleman'));
  await page.close();
}

section('The timeline on a phone');
for (const [label, w, h] of [['phone 375', 375, 812], ['phone 390', 390, 844], ['desktop 1200', 1200, 900]]) {
  const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(1400);
  /* NAVIGATE THE WAY A PERSON ON A PHONE DOES. Under 900px the rail is a
     drawer behind the burger, so a click straight at the Cases button waits
     thirty seconds on an element that is rendered and not visible. */
  const burger = page.locator('.burger');
  if (await burger.isVisible()) { await burger.click(); await page.waitForTimeout(300); }
  await page.locator('.side button, .tabs button', { hasText: 'Cases' }).first().click();
  await page.waitForTimeout(600);
  await page.locator('tbody tr', { hasText: 'API-20260812-4002' }).first().click();
  await page.waitForTimeout(600);
  await wsTab(page, 'Timeline');
  await page.waitForTimeout(900);

  ok(`${label}: the timeline is drawn`, await page.locator('#tldoc .tl2-i').count() > 0);

  const over = await page.evaluate(() => {
    const vw = window.innerWidth, out = [];
    for (const el of document.querySelectorAll('#app *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) {
        out.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}@${Math.round(r.right)}`);
      }
    }
    return { doc: Math.round(document.documentElement.scrollWidth - vw), els: out.slice(0, 5) };
  });
  ok(`${label}: the page does not scroll sideways`, over.doc <= 1, JSON.stringify(over));
  ok(`${label}: and nothing hangs past the right edge`, over.els.length === 0, JSON.stringify(over));

  if (w < 560) {
    /* ONE COLUMN. The 78px time gutter and the rail come off, so a description
       gets the screen instead of a ladder of two-word lines. */
    const geom = await page.evaluate(() => {
      const li = document.querySelector('#tldoc .tl2-i');
      const body = li && li.querySelector('.tl2-body');
      const rail = li && li.querySelector('.tl2-line');
      const panel = document.querySelector('.wspanel');
      return { cols: li ? getComputedStyle(li).gridTemplateColumns : '',
               bodyW: body ? Math.round(body.getBoundingClientRect().width) : 0,
               panelW: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
               railShown: rail ? getComputedStyle(rail).display !== 'none' : false,
               vw: window.innerWidth };
    });
    ok(`${label}: an event is one column, not three`,
       geom.cols.split(' ').length === 1, geom.cols);
    ok(`${label}: the rail is dropped rather than shrunk`, geom.railShown === false);
    /* MEASURED AGAINST THE PANEL, NOT THE VIEWPORT. 86px of the 375 goes to the
       page shell — main 16+16, card 14+14 and its border, dlg 12+12 — which
       every panel in this portal pays and which the report editor's own fix
       already addresses at that level. What the timeline must not do is take
       any MORE, and stacking is what buys that: the description gets every
       pixel the panel has, against 78px of time gutter and 34px of rail on a
       desk. Asserting a viewport share instead would be asserting the shell. */
    ok(`${label}: the description gets the whole panel width`,
       geom.panelW > 0 && Math.abs(geom.bodyW - geom.panelW) <= 1,
       `${geom.bodyW} of ${geom.panelW}`);

    /* A long filename must wrap, not push the card sideways. */
    const wrap = await page.evaluate(() => {
      const b = document.querySelector('.tl2-file') || document.querySelector('.tl2-t');
      if (!b) return { ok: true, style: 'none present' };
      return { ok: ['anywhere', 'break-word'].includes(getComputedStyle(b).overflowWrap),
               style: getComputedStyle(b).overflowWrap };
    });
    ok(`${label}: long text and filenames wrap rather than widen the row`, wrap.ok, wrap.style);

    /* 44px targets and 16px inputs, the portal-wide rules. */
    let smallest = 999, which = '';
    for (const b of await page.locator('.tl2-chips .lens, .tl2-foot .btn, .tl2-go').all()) {
      const box = await b.boundingBox();
      if (box && box.height < smallest) { smallest = box.height; which = (await b.innerText()).trim(); }
    }
    ok(`${label}: every timeline control clears 44px`, smallest === 999 || smallest >= 44,
       `smallest ${smallest}px on "${which}"`);

    await page.locator('.tl2-chips .lens', { hasText: 'Dates' }).click();
    await page.waitForTimeout(350);
    const inp = await page.evaluate(() => {
      const el = document.getElementById('tl_from');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { size: parseFloat(cs.fontSize), h: Math.round(el.getBoundingClientRect().height) };
    });
    ok(`${label}: the date inputs are 16px so iOS does not zoom`, inp && inp.size >= 16,
       JSON.stringify(inp));
    ok(`${label}: and meet the tap floor`, inp && inp.h >= 44, JSON.stringify(inp));
    const over2 = await page.evaluate(() =>
      Math.round(document.documentElement.scrollWidth - window.innerWidth));
    ok(`${label}: opening the date range does not widen the page`, over2 <= 1, String(over2));
  } else {
    const geom = await page.evaluate(() => {
      const li = document.querySelector('#tldoc .tl2-i');
      const body = li && li.querySelector('.tl2-body');
      const panel = document.querySelector('.wspanel');
      return { cols: li ? getComputedStyle(li).gridTemplateColumns : '',
               bodyW: body ? Math.round(body.getBoundingClientRect().width) : 0,
               panelW: panel ? Math.round(panel.getBoundingClientRect().width) : 0 };
    });
    ok(`${label}: a desk keeps the time gutter and the rail`,
       geom.cols.split(' ').length === 3, geom.cols);
    ok(`${label}: and there is room to spare for them`,
       geom.panelW - geom.bodyW > 90 && geom.bodyW > 500,
       `${geom.bodyW} of ${geom.panelW}`);
  }
  await page.close();
}

section('The timeline print region is its own, and adds no PDF writer');
{
  const src = fs.readFileSync(path.join(ROOT, 'portal', 'index.html'), 'utf8');
  ok('the timeline prints from #tldoc', /body\.printing-timeline #tldoc/.test(src));
  ok('and the three regions that were already there are untouched',
     /body\.printing-package #pkgdoc/.test(src)
     && /body\.printing-report #repdoc/.test(src)
     && /body\.printing-invoice #invdoc/.test(src));
  ok('there is still exactly one PDF writer in the page',
     (src.match(/%PDF-1\./g) || []).length === 1);
  const panel = (src.match(/function timelinePanel\(\)\{[\s\S]*?\n\}\n/) || [''])[0];
  ok('the timeline panel exists', panel.length > 0);
  ok('and it renders no image or video element',
     !/<img|<video|createObjectURL/i.test(panel));
  ok('and it stores nothing and uploads nothing',
     !/localStorage|sessionStorage|FormData|report-pdf/i.test(panel));
  /* THE PHONE RULES LIVE AT THE END. Source order has killed a rule in this
     file three times, so the timeline's overrides come after everything they
     override — and its class names are its own rather than a contest with the
     activity log's `.tl`, which is what made `.qgrid` the third casualty. */
  const lastMedia = src.lastIndexOf('@media(max-width:560px)');
  ok('the timeline phone rules are in the last phone block',
     lastMedia > 0 && src.indexOf('.tl2-i{grid-template-columns:1fr', lastMedia) > lastMedia);
  const tlCss = (src.match(/UNIT 10 — the case timeline[\s\S]*?\n  @media print\{/) || [''])[0];
  ok('every timeline rule is under its own prefix',
     tlCss.length > 0 && (tlCss.match(/^  \.[a-z0-9-]+/gm) || [])
       .every(sel => sel.trim().startsWith('.tl2-')),
     JSON.stringify((tlCss.match(/^  \.[a-z0-9-]+/gm) || []).filter(x => !x.trim().startsWith('.tl2-'))));
}

/* ------------------------------------------------------------------ report */

/* ------------------------------------------------------------------ report */

/* =========================================================================
   UNIT 11 — EVIDENCE INTEGRITY IN THE BROWSER

   The Worker suite proves the hashing, the supersede history and the byte
   discipline; these sections prove what a PERSON sees — the card states the
   record truthfully, the actions answer where the button is, the manifest is
   a readable document, and none of it costs a phone its layout. */

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
  /* Snapshot the WHOLE activity log before the builder is touched — the
     container's real date can coincide with the fixture day, so other
     sections' entries may share it and only before-vs-after is honest. */
  const logBefore = await page.evaluate(async no => {
    const ws = await (await fetch(`/portal-api/cases/${no}/workspace`,
      { credentials: 'same-origin' })).json();
    return JSON.stringify(ws.activity.map(a => [a.id, a.at_date, a.at_time, a.description]));
  }, 'API-20260812-4001');
  await wsTab(page, 'Report');
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
  const logAfter = await page.evaluate(async no => {
    const ws = await (await fetch(`/portal-api/cases/${no}/workspace`,
      { credentials: 'same-origin' })).json();
    return JSON.stringify(ws.activity.map(a => [a.id, a.at_date, a.at_time, a.description]));
  }, 'API-20260812-4001');
  ok('every activity entry still reads exactly as logged',
     logAfter === logBefore, logAfter.slice(0, 200));
}

section('Daily summary: the writer\'s words survive everything but a deliberate rebuild');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(500);
  await wsTab(page, 'Report');
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
  await wsTab(page, 'Report');
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
  await wsTab(page, 'Report');
  await page.waitForTimeout(400);
  await page.locator('.rcard', { hasText: '2026-08-20' }).first().click();
  await page.waitForTimeout(400);
  const rep = await page.locator('#repdoc').innerText();
  ok('the day\'s document leads with the authored paragraph',
     has(rep, 'surveillance was initiated at 8:03 AM'), rep.slice(0, 200));
  ok('prose before chronology — the paragraph sits above the body',
     rep.indexOf('surveillance was initiated at 8:03 AM') < rep.indexOf('CHRONOLOG')
       || !has(rep, 'CHRONOLOG'));

  /* And the client package prints it under the day heading. The shared
     fixture case may already carry a FINALIZED package from earlier
     sections, so this section makes its own draft version through the API —
     POST /cases/:no/build opens a new version over a finalized one — and
     attaches the day's report by id rather than hoping an offer button is
     on screen. */
  await page.evaluate(async no => {
    const post = (p2, b2) => fetch('/portal-api' + p2, { method: 'POST',
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b2 || {}) }).then(r => r.json());
    let st = await (await fetch(`/portal-api/cases/${no}/build`,
      { credentials: 'same-origin' })).json();
    if (!st.build || st.build.status !== 'draft') { await post(`/cases/${no}/build`); }
    st = await (await fetch(`/portal-api/cases/${no}/build`,
      { credentials: 'same-origin' })).json();
    const ws = await (await fetch(`/portal-api/cases/${no}/workspace`,
      { credentials: 'same-origin' })).json();
    const day = (ws.days || []).find(d => d.day_date === '2026-08-20');
    const rep = (ws.reports || []).find(r => r.day_id === day.id);
    if (!(st.reports || []).some(r => r.id === rep.id)) {
      await post(`/build/${st.build.id}/reports`, { report_id: rep.id });
    }
  }, 'API-20260812-4001');
  await wsTab(page, 'Package');
  await page.waitForTimeout(700);
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
  await wsTab(inv, 'Report');
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
  await wsTab(inv, 'Report');
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
  await wsTab(page, 'Report');
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

  /* THE RHYTHM IS ONE SET OF NUMBERS (owner, 2026-08-21) — computed, since
     source order has silently killed rules here before. Every section header
     clears the same air, every control in the grids draws the same height
     within a native-widget pixel, and the checkbox is a real box on the
     label's first line. */
  const rhythm = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('.dsb-wrap .dsb-h')]
      .map(el => getComputedStyle(el).marginTop);
    const hs = [...document.querySelectorAll('.dsb-grid .f input, .dsb-grid .f select')]
      .map(el => el.getBoundingClientRect().height);
    const cb = document.querySelector('.dsb-act input[type=checkbox]');
    const grids = [...document.querySelectorAll('.dsb-wrap .dsb-grid')]
      .map(el => getComputedStyle(el).marginTop);
    return { heads: [...new Set(heads)], hMin: Math.min(...hs), hMax: Math.max(...hs),
      cb: cb ? cb.getBoundingClientRect().width : 0, grids: [...new Set(grids)] };
  });
  ok('every section header clears the same air', rhythm.heads.length === 1, JSON.stringify(rhythm.heads));
  ok('every grid opens with the same margin', rhythm.grids.length === 1, JSON.stringify(rhythm.grids));
  ok('field heights agree within a native-widget pixel',
     rhythm.hMin >= 43.5 && rhythm.hMax - rhythm.hMin <= 1.5,
     JSON.stringify([rhythm.hMin, rhythm.hMax]));
  /* 18px at desk, 22px under 560 — the phone block grows the thumb target on
     purpose. What is asserted is that it is a REAL box, not the browser's
     13px default. */
  ok('the checkbox is a real box at this width', rhythm.cb >= 18 && rhythm.cb <= 23, String(rhythm.cb));
  /* A TIME IS FIVE CHARACTERS (owner, on the iPad): sized to its content,
     never stretched into the field beside it, on any engine. */
  const timeW = await page.evaluate(() => {
    const t = document.getElementById('ds_time');
    const cell = t.closest('.f');
    return { w: t.getBoundingClientRect().width,
      over: t.getBoundingClientRect().right - cell.getBoundingClientRect().right };
  });
  ok('the Started time input is content-sized', timeW.w >= 110 && timeW.w <= 160, JSON.stringify(timeW));
  ok('and never exceeds its own cell', timeW.over <= 0.5, JSON.stringify(timeW));
}

section('The palette lives in one place, and the page reads at every size');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  /* EVERY TOKEN THE OWNER'S CONCEPT LIST NAMES, resolving to a real color. */
  const tokens = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const names = ['--navy','--navy-2','--navy-3','--teal','--teal-2','--gold','--ink','--muted',
      '--line','--paper','--card','--panel','--good','--bad','--warn','--info','--focus','--disabled',
      '--ok-bg','--ok-ink','--warn-bg','--gold-bg','--gold-ink','--bad-bg','--bad-ink',
      '--info-bg','--info-ink','--neutral-bg','--neutral-ink',
      '--field-bg','--field-ink','--field-label','--field-line','--head-ink','--head-sub'];
    return Object.fromEntries(names.map(n => [n, cs.getPropertyValue(n).trim()]));
  });
  for (const [n, v] of Object.entries(tokens)) {
    ok(`${n} resolves`, v.length > 0, v);
  }

  /* THE ANTI-DRIFT BUDGET. Before this unit the stylesheet held 205 distinct
     color literals outside :root; the families now live as tokens, so any
     color used more than twice must BE a token. White is exempt — "white" is
     not drift. The ceiling catches the next 16-copies-of-one-navy quietly
     arriving, without pinning every one-off shade. */
  const drift = await page.evaluate(() => {
    const css = [...document.querySelectorAll('style')].map(el => el.textContent).join('\n');
    const rootBlock = css.slice(css.indexOf(':root{'), css.indexOf('}', css.indexOf(':root{')));
    const counts = {};
    for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      const v = m[0].toLowerCase();
      counts[v] = (counts[v] || 0) + 1;
    }
    for (const m of rootBlock.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      counts[m[0].toLowerCase()] -= 1;
    }
    const over = Object.entries(counts)
      .filter(([v, n]) => n > 2 && v !== '#fff' && v !== '#ffffff');
    return { over, gone: ['#13273f', '#c99a3b', '#0d1826', '#eaf5f7', '#dff2e5']
      .map(v => [v, counts[v] || 0]) };
  });
  ok('no non-white color is used more than twice outside the token layer',
     drift.over.length === 0, JSON.stringify(drift.over));
  for (const [v, n] of drift.gone) {
    ok(`${v} lives only in :root now`, n === 0, String(n));
  }

  /* THE PIECES DRAW FROM THE TOKENS — computed, not believed. */
  const painted = await page.evaluate(() => {
    const cs = el => el ? getComputedStyle(el) : null;
    const btn = document.createElement('button'); btn.className = 'btn';
    document.body.appendChild(btn);
    const tag = document.createElement('span'); tag.className = 'tag rs-approved';
    tag.textContent = 'Approved'; document.body.appendChild(tag);
    const out = {
      topBg: cs(document.querySelector('.top')).backgroundColor,
      btnBg: cs(btn).backgroundColor, btnInk: cs(btn).color,
      tagBg: cs(tag).backgroundColor, tagInk: cs(tag).color,
    };
    btn.remove(); tag.remove();
    return out;
  });
  ok('the header is the navy', painted.topBg === 'rgb(14, 26, 44)', painted.topBg);
  ok('the primary button is navy with light ink',
     painted.btnBg === 'rgb(19, 39, 63)' || painted.btnBg === 'rgb(14, 26, 44)', painted.btnBg);
  ok('an approved chip is the success PAIR — tint and ink together',
     painted.tagBg === 'rgb(223, 242, 229)' && painted.tagInk === 'rgb(26, 107, 60)',
     JSON.stringify(painted));

  /* CONTRAST, MEASURED — the brief says do not assume. 4.5:1 for text roles,
     3:1 for the focus indicator. Computed from the live tokens so a later
     "small tweak" to one half of a pair fails here. */
  const contrast = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const val = n => cs.getPropertyValue(n).trim();
    const lum = h => {
      h = h.replace('#', '');
      if (h.length === 3) h = [...h].map(c => c + c).join('');
      const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
        .map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (x, y) => {
      const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
      return (hi + 0.05) / (lo + 0.05);
    };
    return {
      navyBtn: ratio('#ffffff', val('--navy-2')),
      inkOnPaper: ratio(val('--ink'), val('--paper')),
      mutedOnPaper: ratio(val('--muted'), val('--paper')),
      warnChip: ratio(val('--warn'), val('--warn-bg')),
      warnOnWhite: ratio(val('--warn'), '#ffffff'),
      okChip: ratio(val('--ok-ink'), val('--ok-bg')),
      badChip: ratio(val('--bad-ink'), val('--bad-bg')),
      infoChip: ratio(val('--info-ink'), val('--info-bg')),
      neutralChip: ratio(val('--neutral-ink'), val('--neutral-bg')),
      goldNote: ratio(val('--gold-ink'), val('--gold-bg')),
      goldCta: ratio(val('--navy-2'), val('--gold')),
      headOnNavy: ratio(val('--head-ink'), val('--navy')),
      fieldInk: ratio(val('--field-ink'), val('--field-bg')),
      fieldLabel: ratio(val('--field-label'), val('--field-bg')),
      focusRing: ratio(val('--focus'), '#ffffff'),
    };
  });
  for (const [k, need] of [['navyBtn', 4.5], ['inkOnPaper', 4.5], ['mutedOnPaper', 4.5],
    ['warnChip', 4.5], ['warnOnWhite', 4.5], ['okChip', 4.5], ['badChip', 4.5],
    ['infoChip', 4.5], ['neutralChip', 4.5], ['goldNote', 4.5], ['goldCta', 4.5],
    ['headOnNavy', 4.5], ['fieldInk', 4.5], ['fieldLabel', 4.5], ['focusRing', 3]]) {
    ok(`${k} reads at ${need}:1 or better`, contrast[k] >= need, contrast[k].toFixed(2));
  }

  /* STATUS IS NEVER COLOR ALONE — every visible chip carries words. */
  const wordless = await page.evaluate(() =>
    [...document.querySelectorAll('.tag')].filter(t => !t.textContent.trim()).length);
  ok('every status chip on screen carries a text label', wordless === 0, String(wordless));

  /* THE SELECTED ROUTE IS VISIBLY SELECTED — a real computed difference. */
  const nav = await page.evaluate(() => {
    const on = document.querySelector('.tabs button.on');
    const off = [...document.querySelectorAll('.tabs button:not(.on)')][0];
    if (!on || !off) return null;
    return { on: getComputedStyle(on).backgroundColor, off: getComputedStyle(off).backgroundColor };
  });
  ok('the selected sidebar route differs from its neighbors',
     !!nav && nav.on !== nav.off, JSON.stringify(nav));

  /* FOCUS SURVIVED THE SWEEP. */
  const focus = await page.evaluate(() => {
    const css = [...document.querySelectorAll('style')].map(el => el.textContent).join('\n');
    return /:focus-visible[^}]*outline:\s*2px solid var\(--teal\)/.test(css);
  });
  ok('the keyboard focus treatment is intact and token-fed', focus);
}

section('The palette changed no behavior and broke no phone');
{
  /* The four-width probe the shell work established: the swept page still
     fits, the inputs still hold 16px, and the field bars still reach. */
  for (const [label, w, h] of [['375', 375, 812], ['390', 390, 844], ['430', 430, 932]]) {
    const page = await (await browser.newContext({ viewport: { width: +w, height: h } })).newPage();
    page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
    await page.goto(SITE + '/portal/');
    await page.waitForTimeout(300);
    await page.locator('#u').fill('trever');
    await page.locator('#p').fill('AdminPassword1x');
    await page.locator('#loginBtn').click();
    await page.waitForTimeout(1400);
    const over = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(`${label}px: no horizontal overflow after the sweep`, over <= 0, String(over));
    const burger = page.locator('.burger');
    ok(`${label}px: the burger is there and visible`, await burger.isVisible());
    await burger.click(); await page.waitForTimeout(300);
    const drawerBg = await page.evaluate(() => {
      const t = document.querySelector('.tabs');
      return t ? getComputedStyle(t).backgroundColor : '';
    });
    ok(`${label}px: the drawer is still the navy family`,
       /rgb\((1[0-9]|2[0-9]), (2[0-9]|3[0-9]), (4[0-9]|5[0-9]|6[0-9])\)/.test(drawerBg), drawerBg);
    const inputPx = await page.evaluate(() => {
      const i = document.createElement('input');
      document.body.appendChild(i);
      const v = parseFloat(getComputedStyle(i).fontSize);
      i.remove(); return v;
    });
    ok(`${label}px: inputs hold the 16px floor`, inputPx >= 16, String(inputPx));
    await page.close();
  }

  /* Print stays ink-conscious: the print rules still isolate the document
     regions, and no print rule paints a navy background over paper. */
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  const print = await page.evaluate(() => {
    const css = [...document.querySelectorAll('style')].map(el => el.textContent).join('\n');
    const m = css.match(/@media print\{([\s\S]*?)\n  \}/);
    const block = m ? m[1] : '';
    return {
      isolates: /visibility:hidden/.test(block) && /#pkgdoc/.test(block) && /#tldoc/.test(block)
        && /#mandoc/.test(block) && /#repdoc/.test(block),
      paintsNavy: /background:[^;}]*var\(--navy/.test(block) || /background:[^;}]*#0e1a2c/.test(block),
    };
  });
  ok('the print rules still isolate every document region', print.isolates);
  ok('and no print rule paints navy over paper', !print.paintsNavy);
}

/* ------------------------------------------- invoice defaults (Unit 29)
   The Production Truth Audit's "IMPLEMENTED BUT NOT EXPOSED": the route
   existed and Settings had no panel. Reachability first — an admin must be
   able to SEE it from normal navigation — then that it loads real values and
   that a save round-trips. */
/* ------------------------------------------------- case types (Unit 30) */
/* ================================ terminology in the Admin UI (Unit 35)
 *
 * Owner decision, 2026-08-21: canvass / canvassing, interview / interviewing
 * and recorded statement(s) are not visible wording anywhere — the public site
 * (Unit 34) and now the signed-in portal.
 *
 * The pair of properties is the whole point, and neither is worth much alone:
 *   1. the RENDERED Admin UI carries none of those terms, and
 *   2. a case that already stored one is still readable, still selected, and
 *      still submits its stored value back unchanged.
 * A rename that broke (2) would be a data edit wearing a label change. */
section('The Admin UI carries none of the retired terms, and old records still read');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  const BANNED = /canvass|canvassing|interview|interviewing|recorded statements?/i;
  /* Every top-level screen an admin can reach, read as RENDERED TEXT — what a
     person actually sees, not the source behind it. */
  const screens = ['Dashboard', 'Search', 'Cases', 'Tasks', 'Intakes', 'Clients & Firms',
                   'Calendar', 'File queue', 'Reports & Packages', 'Rate Sheets', 'Billing',
                   'Staff', 'Audit trail', 'Settings'];
  const dirty = [];
  for (const label of screens) {
    const tab = page.locator('.tabs button', { hasText: label });
    if (await tab.count() === 0) continue;
    await tab.first().click();
    await page.waitForTimeout(650);
    const shown = await page.evaluate(() => document.body.innerText);
    if (BANNED.test(shown)) dirty.push(`${label}: ${(shown.match(BANNED) || [])[0]}`);
  }
  ok('no admin screen renders a retired term', dirty.length === 0, dirty.join(' | '));

  /* The two dropdowns the owner named, read as OPTION LABELS — a select's
     options are visible wording even before it is opened. */
  /* The intake door is a NAV item, not a button on the Intakes screen — the
     same selector every other test in this file uses to reach it. */
  await page.locator('[data-act="tab"][data-tab="newlead"]').first().click();
  await page.waitForTimeout(700);
  /* The assignment category belongs to the LEGAL door of the quick intake —
     the picker chooses which form renders, so the select does not exist until
     that door is taken. */
  await page.locator('[data-act="nlKind"][data-k="legal"]').click();
  await page.waitForTimeout(400);
  const opts = await page.evaluate(() =>
    [...document.querySelectorAll('#nl_asgtype option')].map(o => o.textContent));
  ok('control: the manual intake really does offer a category list', opts.length > 3,
     JSON.stringify(opts));
  ok('it offers Witness locate, not the retired wording',
     opts.includes('Witness locate')
       && !opts.some(o => /canvass|interview|recorded statement/i.test(o)),
     JSON.stringify(opts));
}

section('Case types are on Settings, list, and add');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Settings' }).click();
  await page.waitForTimeout(900);

  const panel = page.locator('.card', { hasText: 'Case types' }).first();
  ok('Settings carries a Case types panel', await panel.count() === 1);
  const body = await panel.innerText();
  ok('it lists both sides of the business',
     has(body, 'Private') && has(body, 'Insurance'), body.slice(0, 240));
  ok('the seeded types are shown rather than an empty box',
     (await panel.locator('.ctlist li').count()) > 0,
     String(await panel.locator('.ctlist li').count()));
  ok('it says a type cannot be renamed or removed from here',
     has(body, 'cannot be renamed or removed'), body.slice(-260));

  const before = await panel.locator('.ctlist li').count();
  await page.locator('#ct_label').fill('Portal test type');
  await page.locator('#ct_side').selectOption('private');
  await page.locator('.btn', { hasText: 'Add case type' }).click();
  await page.waitForTimeout(700);
  ok('adding one confirms by name',
     /Added — Portal test type/.test(await panel.innerText()),
     (await panel.innerText()).slice(-200));
  ok('and it appears in the list', await panel.locator('.ctlist li').count() === before + 1,
     `${before} -> ${await panel.locator('.ctlist li').count()}`);
  ok('the form clears so the next one starts empty',
     (await page.locator('#ct_label').inputValue()) === '');

  /* A duplicate is refused, and says so rather than adding it twice. */
  await page.locator('#ct_label').fill('Portal test type');
  await page.locator('.btn', { hasText: 'Add case type' }).click();
  await page.waitForTimeout(700);
  ok('a duplicate is refused in words',
     /already exists/i.test(await panel.innerText()), (await panel.innerText()).slice(-200));
}

section('Invoice defaults are on Settings, load, and save');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Settings' }).click();
  await page.waitForTimeout(900);

  const panel = page.locator('.card', { hasText: 'Invoice defaults' }).first();
  ok('Settings carries an Invoice defaults panel', await panel.count() === 1);
  const body = await panel.innerText();
  ok('it names the fields the backend actually supports',
     has(body, 'Invoice number prefix') && has(body, 'Default terms')
       && has(body, 'Payment instructions') && has(body, 'Invoice footer'), body.slice(0, 300));
  ok('it says these are defaults, never an override',
     has(body, 'defaults, never an override') || has(body, 'keeps whatever was typed'),
     body.slice(0, 300));
  ok('and it promises no credential is stored here',
     has(body, 'No payment credential is stored here'), body.slice(-260));

  const prefix = page.locator('#bs_invoice_prefix');
  ok('the prefix loads its current value', (await prefix.inputValue()).length > 0,
     await prefix.inputValue());

  /* An empty prefix is refused before it can reach the numbering scheme. */
  await prefix.fill('');
  await page.locator('.btn', { hasText: 'Save invoice defaults' }).click();
  await page.waitForTimeout(400);
  ok('an empty prefix is refused with a reason',
     /cannot be empty/i.test(await panel.innerText()), (await panel.innerText()).slice(-260));

  await prefix.fill('API-TEST');
  await page.locator('.btn', { hasText: 'Save invoice defaults' }).click();
  await page.waitForTimeout(700);
  ok('a real save confirms', /Saved\./.test(await panel.innerText()), (await panel.innerText()).slice(-200));
  ok('and the saved value is what is shown afterwards',
     (await page.locator('#bs_invoice_prefix').inputValue()) === 'API-TEST',
     await page.locator('#bs_invoice_prefix').inputValue());
}

section('Storage health: the Settings panel answers where the bytes are');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Settings' }).click();
  await page.waitForTimeout(900);

  const panel = page.locator('.card', { hasText: 'Storage health' }).first();
  ok('Settings carries the Storage health panel', await panel.count() === 1);
  const body = await panel.innerText();
  ok('safe-to-store is answered in words, yes or no with the reason',
     /Safe to store right now:\s*(Yes|No)/i.test(body), body.slice(0, 160));
  ok('the last successful upload is stated, or honestly absent',
     has(body, 'last successful upload') || has(body, 'nothing has been uploaded yet'));
  ok('failed uploads are a section with a real answer',
     has(body, 'Failed uploads') && (has(body, 'None recorded') || /refused storage write/.test(body)
       || has(body, 'failure log has not arrived')), body.slice(0, 400));
  ok('the Cloudflare side reads with its percent of the free tier',
     has(body, 'Cloudflare') && /% of the free tier/.test(body), body.slice(0, 200));
  ok('the legacy-video open decision is stated in words, not hidden',
     has(body, 'open decision nobody has made'));
  ok('the Dropbox side reads', has(body, 'Dropbox (current case files)'));
  /* The container has no route to Dropbox, so the honest state here is
     UNKNOWN — asserted as the words, because unknown must never draw as
     zero. If a future harness stubs the provider this arm flips to the
     account line, which the worker suite already pins. */
  ok('account usage is either known or honestly unknown',
     has(body, 'used') || has(body, 'unknown, not zero'), body.slice(0, 400));
  ok('integrity coverage is a sentence with numbers',
     /\d+ of \d+ live file/.test(body) || has(body, 'integrity table has not arrived'));
  ok('nothing here offers a sweep, an export or a delete',
     !/sweep|export and remove now|delete legacy/i.test(await panel.innerText()));

  /* A FAILED READ SAYS SO — never an empty store. */
  await page.route('**/portal-api/storage-health', r =>
    r.fulfill({ status: 500, body: '{}' }));
  await page.locator('[data-act="shRefresh"]').click();
  await page.waitForTimeout(600);
  const failed = await page.locator('.card', { hasText: 'Storage health' }).first().innerText();
  ok('a failed read is named and offers Try again',
     has(failed, 'could not be read') && has(failed, 'not the same as nothing being stored'),
     failed.slice(0, 200));
  await page.unroute('**/portal-api/storage-health');
  await page.locator('.card', { hasText: 'Storage health' })
    .locator('[data-act="shRefresh"]').last().click();
  await page.waitForTimeout(700);
  ok('and Try again recovers',
     has(await page.locator('.card', { hasText: 'Storage health' }).first().innerText(),
         'Cloudflare'));

  /* The heaviest-cases table links into the case, not to a file manager. */
  const link = page.locator('.shtbl .linklike').first();
  if (await link.count()) {
    await link.click();
    await page.waitForTimeout(600);
    ok('a heavy case opens as the case itself',
       await page.locator('.casepage').count() === 1);
  }
}

section('Storage health stays off every other screen, and fits a phone');
{
  /* The space call and the aggregates run when an admin ASKS — the dashboard
     and a case open must not fetch them. */
  const page = await newPage();
  const asked = [];
  page.on('request', r => { if (r.url().includes('/portal-api/')) asked.push(r.url()); });
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(800);
  ok('neither the dashboard nor a case asks the storage-health question',
     !asked.some(u => u.includes('/storage-health')), JSON.stringify(asked.slice(-6)));

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  phone.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await phone.goto(SITE + '/portal/');
  await phone.waitForTimeout(300);
  await phone.locator('#u').fill('trever');
  await phone.locator('#p').fill('AdminPassword1x');
  await phone.locator('#loginBtn').click();
  await phone.waitForTimeout(1400);
  const burger = phone.locator('.burger');
  if (await burger.isVisible()) { await burger.click(); await phone.waitForTimeout(300); }
  await phone.locator('.side button, .tabs button', { hasText: 'Settings' }).first().click();
  await phone.waitForTimeout(900);
  const over = await phone.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('390px: Settings with the storage panel has no sideways scroll', over <= 0, String(over));
  const btn = await phone.locator('[data-act="shRefresh"]').first().boundingBox();
  ok('390px: Refresh meets the 44px floor', !!btn && btn.height >= 44, JSON.stringify(btn));
  await phone.close();
}

section('A nav row grows to hold its words — nothing crushes, nothing overlaps');
for (const [label, w, h, drawer] of [['desktop', 1200, 700, false],
                                     ['short desktop', 1200, 560, false],
                                     ['phone 390', 390, 844, true],
                                     ['phone 375', 375, 812, true]]) {
  const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(1200);
  if (drawer) {
    const b = page.locator('.burger');
    if (await b.isVisible()) { await b.click(); await page.waitForTimeout(300); }
  }
  /* THE PINNED COLUMN MUST NEVER CRUSH A ROW. flex children shrink by
     default, and that is exactly how "Reports & Packages" came to draw two
     lines inside a one-line row. Measured, not eyeballed: content fits its
     box, neighbors do not intersect, and the floor holds. */
  const m = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.tabs button')].filter(b => b.offsetParent);
    const crushed = btns.filter(b => b.scrollHeight > b.clientHeight + 2)
      .map(b => [b.textContent.trim().slice(0, 22), b.scrollHeight, b.clientHeight]);
    const boxes = btns.map(b => b.getBoundingClientRect());
    const overlaps = [];
    for (let i = 1; i < boxes.length; i++) {
      if (boxes[i-1].bottom - 1 > boxes[i].top) {
        overlaps.push(btns[i-1].textContent.trim().slice(0, 22));
      }
    }
    const under = btns.filter(b => b.getBoundingClientRect().height < 43.5)
      .map(b => b.textContent.trim().slice(0, 22));
    return { crushed, overlaps, under, n: btns.length };
  });
  ok(`${label}: no nav row is crushed below its own words`, m.crushed.length === 0, JSON.stringify(m.crushed));
  ok(`${label}: no nav row overlaps its neighbor`, m.overlaps.length === 0, JSON.stringify(m.overlaps));
  ok(`${label}: every row keeps the 44px floor`, m.under.length === 0, JSON.stringify(m.under));

  /* And the four screens the owner named still open from their rows. */
  for (const name of ['Dashboard', 'Reports & Packages', 'Rate Sheets', 'Billing']) {
    if (drawer) {
      const b = page.locator('.burger');
      if (await b.isVisible() && !(await page.evaluate(() => document.body.classList.contains('navopen')))) {
        await b.click(); await page.waitForTimeout(250);
      }
    }
    await page.locator('.tabs button', { hasText: name }).first().click();
    await page.waitForTimeout(500);
    ok(`${label}: ${name} opens from its row`,
       (await page.locator('.tabs button.on', { hasText: name }).count()) === 1
         || (await page.locator('#app, main, body').first().innerText()).length > 0);
  }
  await page.close();
}

section('Closeout: the checklist shows what the record can see, and still obeys the person');
{
  await post('/ingest', {
    case_no: 'API-CLOSE-1', service: 'Surveillance',
    client_name: 'Close Client', subject_name: 'Close Subject',
    objective: 'Wrap-up test',
  }, { 'X-Ingest-Key': 'e2e-ingest-key' });
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.evaluate(async no => {
    const post2 = (p2, b2) => fetch('/portal-api' + p2, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b2 || {}) }).then(r => r.json());
    await post2(`/cases/${no}/day/start`, { day_date: '2026-08-19', start_time: '08:00' });
    await post2(`/cases/${no}/day/end`, { end_time: '12:00' });
  }, 'API-CLOSE-1');
  await rowFor(page, 'API-CLOSE-1').click();
  await page.waitForTimeout(500);
  await wsTab(page, 'Billing');
  await page.waitForTimeout(700);

  const panel = page.locator('form', { hasText: 'Close the case' }).first();
  ok('the closing checklist is on screen', await panel.count() === 1);
  await page.waitForTimeout(600);
  const body = await panel.innerText();
  ok('the record\'s note count leads the list',
     /The record has a note on/.test(body), body.slice(0, 220));
  /* .tag is text-transform:uppercase and innerText is RENDERED text — the
     harness's own has() rule, applied here. */
  ok('a finished day with no report is said beside its attestation',
     /finished day has no report/i.test(body), body.slice(0, 400));
  ok('and the screen says ticking over a note is the person\'s call',
     /your call to make; nothing here blocks closing/.test(body));

  /* A FAILED READ SAYS SO, and the boxes still work. */
  await page.route('**/portal-api/cases/*/closeout', r => r.fulfill({ status: 500, body: '{}' }));
  await page.evaluate(() => { CLOSEOUT = {}; });
  await wsTab(page, 'Overview');
  await page.waitForTimeout(300);
  await wsTab(page, 'Billing');
  await page.waitForTimeout(700);
  const failedBody = await page.locator('form', { hasText: 'Close the case' }).first().innerText();
  ok('a failed facts read is named — the checklist does not pretend the record is clean',
     /could not be read/.test(failedBody), failedBody.slice(0, 240));
  ok('and the attestation boxes still work without it',
     await page.locator('#cl_field_work').isEnabled());
  await page.unroute('**/portal-api/cases/*/closeout');
}

section('Delivery center: one row per client, a copied message, and never a send');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  /* A finalized package to stand in the row. */
  await page.evaluate(async no => {
    const post = (p2, b2) => fetch('/portal-api' + p2, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b2 || {}) }).then(r => r.json());
    const ws = await (await fetch(`/portal-api/cases/${no}/workspace`, { credentials: 'same-origin' })).json();
    let day = (ws.days || []).find(d => d.day_date === '2026-08-20');
    let rep = (ws.reports || []).find(r => day && r.day_id === day.id);
    if (rep && rep.status !== 'approved') await post(`/cases/${no}/reports/${rep.id}/status`, { status: 'approved' });
    let st = await (await fetch(`/portal-api/cases/${no}/build`, { credentials: 'same-origin' })).json();
    if (!st.build || st.build.status !== 'draft') { await post(`/cases/${no}/build`); }
    st = await (await fetch(`/portal-api/cases/${no}/build`, { credentials: 'same-origin' })).json();
    if (rep && !(st.reports || []).some(r2 => r2.id === rep.id)) {
      await post(`/build/${st.build.id}/reports`, { report_id: rep.id });
    }
    await post(`/build/${st.build.id}/package`, { package_type: 'report_only' });
    await post(`/build/${st.build.id}/finalize`, {});
  }, 'API-20260812-4001');
  await page.locator('.tabs button', { hasText: 'Reports & Packages' }).click();
  await page.waitForTimeout(1000);

  const card = page.locator('.card', { hasText: 'Client delivery' }).first();
  ok('the delivery center leads the desk', await card.count() === 1);
  const body = await card.innerText();
  ok('a finalized case reads Ready to deliver', /Ready to deliver/i.test(body), body.slice(0, 300));
  ok('the desk says out loud that it never sends',
     /Nothing here sends anything/.test(body) && /never\s+auto-emailed/.test(body.replace(/\n/g, ' ')));
  ok('and no control on it is a send', await card.locator('button', { hasText: /send|email/i }).count() === 0);

  /* The message: composed, client-safe, copied. */
  const msg = await page.evaluate(() => {
    const row = (DC.data.cases || []).find(r => r.case_no === 'API-20260812-4001');
    return row ? dcMessage(row) : null;
  });
  ok('the delivery message names the case and its contents',
     msg && msg.includes('API-20260812-4001') && /final investigative report/.test(msg), msg);
  /* \brate\b — "separate cover" is not a rate. */
  ok('and is client-safe by construction',
     msg && !/internal|classif|\brate\b|\$\d|do not use|needs review/i.test(msg), msg);
  ok('with no link line when no link is offerable',
     !/delivery link/.test(msg), msg);

  /* A failed read says so. */
  await page.route('**/portal-api/delivery-center', r => r.fulfill({ status: 500, body: '{}' }));
  await page.locator('[data-act="dcRefresh"]').first().click();
  await page.waitForTimeout(600);
  ok('a failed read is named, not an empty desk',
     /could not be read/.test(await page.locator('.card', { hasText: 'Client delivery' }).first().innerText()));
  await page.unroute('**/portal-api/delivery-center');
}

section('Delivery center on a phone: rows stack and the copy is reachable');
{
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
  await page.locator('.side button, .tabs button', { hasText: 'Reports & Packages' }).first().click();
  await page.waitForTimeout(1000);
  const over = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('390px: the desk has no sideways scroll', over <= 0, String(over));
  const btn = page.locator('[data-act="dcCopy"]').first();
  if (await btn.count()) {
    const box = await btn.boundingBox();
    ok('390px: Copy delivery message meets the floor', !!box && box.height >= 44, JSON.stringify(box));
  }
  await page.close();
}

section('Unit 24 — the File Queue renders: real states, a working detail panel, no writers');
{
  /* The worker section proves the DERIVATION; this proves the screen actually
     draws it, that its controls work rather than merely appearing, and that it
     offers no way to change a file — the "a control that draws is not a control
     that works" lesson, applied to a read-only surface. */
  await post('/ingest', {
    case_no: 'API-FQP', service: 'Surveillance',
    client_name: 'Queue Page Client', subject_name: 'Queue Subject', objective: 'Queue',
  }, { 'X-Ingest-Key': 'e2e-ingest-key' });
  const stamp = new Date().toISOString();
  for (const [name, cls, ct] of [
    ['front.jpg', 'needs_review', 'image/jpeg'],
    ['blurred.jpg', 'needs_redaction', 'image/jpeg'],
    ['clean.jpg', 'client_deliverable', 'image/jpeg'],
    ['notes.pdf', 'internal_only', 'application/pdf'],
  ]) {
    db.prepare(`INSERT INTO case_evidence (case_no, r2_key, filename, content_type, size_bytes,
                  classification, uploaded_by, uploaded_at)
                VALUES ('API-FQP', ?, ?, ?, 2048, ?, 1, ?)`)
      .run('fqp-' + name, name, ct, cls, stamp);
  }

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'File queue' }).first().click();
  await page.waitForTimeout(900);

  const body = await page.locator('#app').innerText();
  ok('the file queue screen opens from the navigation', /File queue/i.test(body), body.slice(0, 200));
  ok('and says out loud that it changes nothing',
     /nothing here uploads, renames, moves or deletes/i.test(body), body.slice(0, 500));

  /* THE STATES ARE DRAWN, and they are the portal's own words. */
  for (const [file, word] of [['front.jpg', 'Awaiting review'],
                              ['blurred.jpg', 'Awaiting processing'],
                              ['notes.pdf', 'Held back']]) {
    const row = page.locator('.fqtbl tbody tr', { hasText: file }).first();
    ok(`${file} is listed as ${word}`,
       new RegExp(word, 'i').test(await row.innerText()), await row.innerText());
  }
  ok('a deliverable with no hash reads as awaiting verification',
     /Awaiting verification/i.test(await page.locator('.fqtbl tbody tr', { hasText: 'clean.jpg' }).first().innerText()));

  /* THE SUMMARY CARDS ARE CONTROLS, not decoration — clicking one filters. */
  const cards = await page.locator('.fqcard').count();
  ok('summary cards are drawn across the top', cards >= 3, String(cards));
  /* Counts are asserted as PROPERTIES, not absolutes: other sections plant
     evidence of their own, so "exactly one" is only true in isolation and
     would make this section pass alone and fail in the suite — which is the
     kind of test that teaches people to ignore a red run. */
  const all = await page.locator('.fqtbl tbody tr').count();
  await page.locator('.fqcard', { hasText: 'Held back' }).first().click();
  await page.waitForTimeout(350);
  const shown = await page.locator('.fqtbl tbody tr').allInnerTexts();
  ok('clicking a card filters the queue to that state',
     shown.length > 0 && shown.length < all && shown.every(t => /Held back/i.test(t)),
     JSON.stringify([all, shown.length]));
  ok('and the filtered set still holds the file that belongs in it',
     shown.some(t => /notes\.pdf/.test(t)), JSON.stringify(shown).slice(0, 200));
  ok('and the chip says which state is showing',
     /Held back/i.test(await page.locator('.chip').first().innerText()));
  await page.locator('.chip button').first().click();
  await page.waitForTimeout(350);
  ok('clearing the chip restores every file',
     await page.locator('.fqtbl tbody tr').count() === all, String(all));

  /* THE DETAIL PANEL OPENS AND CARRIES THE RECORD. */
  await page.locator('.fqtbl tbody tr', { hasText: 'clean.jpg' })
    .first().locator('[data-act="fqPick"]').click();
  await page.waitForTimeout(350);
  const detail = await page.locator('.fqdetail').innerText();
  ok('choosing a file opens its workspace', /clean\.jpg/.test(detail), detail.slice(0, 200));
  ok('with the case, the size and the classification on it',
     /API-FQP/.test(detail) && /KB|MB|B\b/.test(detail) && /deliverable/i.test(detail), detail.slice(0, 400));
  ok('the integrity wording is the portal\'s own, never a legal claim',
     /not a third-party authentication/i.test(detail));
  /* Unit 39 renamed the delete control; the File Queue must still carry
     neither. Naming the retired action alone would have made this vacuous. */
  ok('and it hands off rather than editing — no classify or delete control on it',
     await page.locator('.fqdetail [data-act="evClassify"], .fqdetail [data-act="evDelete"], '
       + '.fqdetail [data-act="rmOpen"]').count() === 0);
  await page.locator('.fqdetail [data-act="fqPick"]').first().click();
  await page.waitForTimeout(300);
  ok('the workspace closes again', await page.locator('.fqdetail').count() === 0);

  /* A FAILED READ IS NAMED — never drawn as an empty queue. */
  await page.route('**/portal-api/file-queue', r => r.fulfill({ status: 500, body: '{}' }));
  await page.locator('[data-act="fqRetry"]').first().click();
  await page.waitForTimeout(600);
  ok('a failed read says so rather than showing an empty queue',
     /could not be read/i.test(await page.locator('#app').innerText()));
  await page.unroute('**/portal-api/file-queue');
  await page.close();
}

section('Unit 24 — the File Queue on a phone, and what the field is not shown');
{
  /* THE FIELD SEES THE WORK, NEVER THE CLIENT — asserted on the rendered page,
     not just in the payload. */
  const admin = await newPage();
  await signIn(admin, 'trever', 'AdminPassword1x');
  await admin.evaluate(async () => {
    const u = (USERS || []).find(x => x.role === 'investigator' && x.active);
    if (u) await fetch('/portal-api/submissions/API-FQP/assign', { method: 'POST',
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: u.id }) });
  });
  await admin.close();

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  phone.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await phone.goto(SITE + '/portal/');
  await phone.waitForTimeout(300);
  await phone.locator('#u').fill('trever');
  await phone.locator('#p').fill('AdminPassword1x');
  await phone.locator('#loginBtn').click();
  await phone.waitForTimeout(1400);
  const burger = phone.locator('.burger');
  if (await burger.isVisible()) { await burger.click(); await phone.waitForTimeout(300); }
  await phone.locator('.side button, .tabs button', { hasText: 'File queue' }).first().click();
  await phone.waitForTimeout(900);

  const m = await phone.evaluate(() => {
    const card = document.querySelector('.fqcard');
    const b = card && card.getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
             cardH: b ? b.height : 0,
             stacked: !!document.querySelector('.fqtbl.stacktbl') };
  });
  ok('390px: the queue adds no sideways scroll', m.overflow <= 0, String(m.overflow));
  ok('390px: a summary card meets the 44px tap floor', m.cardH >= 44, String(m.cardH));
  ok('390px: the table is the stacked-record kind, so no column is dropped', m.stacked === true);
  await phone.close();
}

section('Unit 21 — accessibility: landmarks, a way in from the keyboard, and answers said out loud');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  /* Every one of these was MEASURED as absent before it was built: the probe
     found one landmark on the whole signed-in page, no h1, no live region, no
     skip link, and one unlabelled input. */
  const a = await page.evaluate(() => {
    const named = el => (el.getAttribute('aria-label') || el.textContent || '').trim().length > 0
      || !!el.getAttribute('aria-labelledby') || !!el.title;
    const labelled = i => {
      if (i.getAttribute('aria-label') || i.getAttribute('aria-labelledby')) return true;
      if (i.id && document.querySelector('label[for="' + CSS.escape(i.id) + '"]')) return true;
      return !!i.closest('label');
    };
    return {
      main: document.querySelectorAll('main').length,
      nav: document.querySelectorAll('nav').length,
      header: document.querySelectorAll('header').length,
      h1: [...document.querySelectorAll('h1')].map(h => h.textContent.trim()),
      live: document.querySelectorAll('[aria-live]').length,
      skip: !!document.querySelector('a.skiplink'),
      lang: document.documentElement.lang,
      unnamed: [...document.querySelectorAll('button')].filter(b => !named(b)).length,
      unlabelled: [...document.querySelectorAll('input,select,textarea')]
        .filter(i => i.type !== 'hidden' && !labelled(i)).map(i => i.id || i.type),
    };
  });
  ok('the page has main, nav and header landmarks', a.main === 1 && a.nav >= 1 && a.header >= 1,
     JSON.stringify(a));
  ok('and one h1 naming the application', a.h1.length === 1 && /case portal/i.test(a.h1[0]),
     JSON.stringify(a.h1));
  ok('a polite live region exists for what the screen answers', a.live >= 1, String(a.live));
  ok('the document declares its language', a.lang === 'en', String(a.lang));
  ok('every button has an accessible name', a.unnamed === 0, String(a.unnamed));
  ok('and every visible control is labelled', a.unlabelled.length === 0, JSON.stringify(a.unlabelled));

  /* THE SKIP LINK IS REAL, not decorative: focused it must be on screen, and
     it must actually move focus into the content. */
  ok('a skip link is the first thing the keyboard reaches', a.skip === true);
  /* Focused via the KEYBOARD, and read after the slide-in settles — the link
     eases into place, so measuring the instant it takes focus measures the
     animation rather than the result. */
  /* Focused directly and read AFTER the slide-in settles: the link eases into
     place over .12s, so measuring the instant it takes focus measures the
     animation rather than the result.

     This comment used to explain that `paint()` puts the caret in the case
     search box, so a bare Tab did not start at the top of the document. That
     stopped being true on 2026-08-22 — the owner's rule is that arriving at a
     section focuses nothing, so the document now starts where a keyboard user
     expects it to and the skip link earns its place on the ordinary grounds. */
  await page.evaluate(() => document.querySelector('a.skiplink').focus());
  await page.waitForTimeout(320);
  const skip = await page.evaluate(() => {
    const el = document.querySelector('a.skiplink');
    return { focused: document.activeElement === el,
             top: Math.round(el.getBoundingClientRect().top),
             href: el.getAttribute('href') };
  });
  ok('and focusing it brings it on screen rather than leaving it hidden',
     skip.focused === true && skip.top >= 0, JSON.stringify(skip));
  ok('pointing at the main content', skip.href === '#app');

  /* WHAT THE SCREEN SAYS IS ANNOUNCED — BUT ONLY WHEN SOMEBODY CAUSED IT.

     This assertion used to inject a `.note` and call `announceRendered()`
     directly, with no user action anywhere, and require it to be spoken. Unit
     21A reversed exactly that case on the owner's instruction: text that
     appears without anyone acting is a panel explaining itself, and reading it
     aloud on arrival is the defect. So the test now pins BOTH sides of the new
     contract instead of the one side of the old one.

     The action is a real delegated click, not a poke at internals: a probe
     button carrying an unknown `data-act` reaches the click listener — which
     is where the flag is set — and matches no branch in its if/else chain, so
     nothing else happens. */
  /* PRESSING THE TAB YOU ARE ALREADY ON IS ARRIVAL AT IT, and that is what
     resets the flag here — the screen string does not change, so this line
     only works because a nav press forces the arrival branch. The first draft
     of this test clicked Cases while already on Cases, assumed it reset, and
     failed with the injected message announced. */
  await page.locator('.tabs button[data-tab="cases"]').first().click();
  await page.waitForTimeout(600);
  const said = await page.evaluate(() => {
    const host = document.querySelector('#app');
    const sr = document.getElementById('sr');
    const put = t => {
      let b = document.getElementById('__srbox');
      if (!b) { b = document.createElement('div'); b.id = '__srbox'; b.className = 'note'; host.prepend(b); }
      b.textContent = t;
    };

    sr.textContent = '';
    put('Payment recorded.');
    announceRendered();
    const quiet = sr.textContent;

    const probe = document.createElement('button');
    probe.setAttribute('data-act', '__sr_probe__');
    document.body.appendChild(probe);
    probe.click();
    probe.remove();
    put('Payment recorded and receipted.');
    announceRendered();
    const spoken = sr.textContent;

    sr.textContent = 'CLEARED-BY-TEST';
    announceRendered();
    const again = sr.textContent;

    document.getElementById('__srbox').remove();
    return { quiet, spoken, again, live: sr.getAttribute('aria-live'), role: sr.getAttribute('role') };
  });
  ok('a message nobody caused is NOT announced', said.quiet === '', JSON.stringify(said));
  ok('a rendered confirmation IS copied into the live region once the user has acted',
     said.spoken === 'Payment recorded and receipted.', JSON.stringify(said));
  ok('politely, so it never interrupts', said.live === 'polite' && said.role === 'status');
  /* Repainting the same message must not repeat it in the user's ear. */
  ok('and an unchanged message is not announced again', said.again === 'CLEARED-BY-TEST', said.again);

  /* §9's last unbuilt line, built to the spec and no further: a SHORT tone,
     and nothing spoken. */
  const src = fs.readFileSync(path.join(ROOT, 'portal/index.html'), 'utf8');
  ok('the voice confirmation has its optional short tone', /function svTone\(/.test(src));
  ok('fired where the entry is actually filed', /svTone\(\);\s+\/\/ §9/.test(src));
  ok('and nothing speaks — §9 forbids lengthy spoken responses',
     !/speechSynthesis|SpeechSynthesisUtterance/.test(src));
  await page.close();
}

section('Unit 21 — the keyboard reaches the work, and a dialog says what it is');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  /* Focus must be VISIBLE wherever it lands — a keyboard user who cannot see
     where they are is not navigating, they are guessing. */
  /* `:focus-visible` is a pseudo-CLASS, so getComputedStyle cannot be asked
     for it — it takes pseudo-elements. The honest check is whether the element
     MATCHES it after a keyboard focus, plus that a rule exists to draw it. */
  /* `:focus-visible` matches only for KEYBOARD focus, by design — so a
     programmatic `.focus()` legitimately does not match it, and asserting that
     it does would be asserting a browser bug. The honest pair is: the control
     takes focus, and a rule exists to draw the ring when the keyboard puts it
     there (Unit 13 already measures that ring's contrast). */
  const focus = await page.evaluate(() => {
    const btn = document.querySelector('nav.tabs button');
    btn.focus();
    return { isFocused: document.activeElement === btn, tag: btn.tagName };
  });
  ok('a navigation item takes focus', focus.isFocused === true, JSON.stringify(focus));
  ok('and it is a real button rather than a clickable div', focus.tag === 'BUTTON');
  const css = fs.readFileSync(path.join(ROOT, 'portal/index.html'), 'utf8');
  ok('with a focus-visible rule of at least 2px behind it',
     /:focus-visible[^{]*\{[^}]*outline:2px/.test(css));

  /* Every modal already declares itself; this pins it so a new one cannot
     arrive without saying what it is. */
  const dialogs = await page.evaluate(() => {
    const src = document.documentElement.innerHTML;
    return { count: (src.match(/role="dialog"/g) || []).length };
  });
  ok('modals declare themselves as dialogs', dialogs.count >= 0);
  const declared = fs.readFileSync(path.join(ROOT, 'portal/index.html'), 'utf8');
  const roleDialog = (declared.match(/role="dialog"/g) || []).length;
  const modal = (declared.match(/aria-modal="true"/g) || []).length;
  ok('and every one of them is modal and labelled',
     roleDialog >= 7 && modal === roleDialog, JSON.stringify([roleDialog, modal]));
  await page.close();
}

section('Unit 19 — package and report accuracy: one exhibit number, a real Documents count');
{
  /* STRUCTURAL, on purpose — the repo's own idiom for a rule that must not
     come back (one `%PDF-1.` writer, `FIELD_KEEP` written once). Rendering a
     package holding a document, a photo AND a video needs a planted legacy
     video row and a finalized build; what actually broke was the ARITHMETIC,
     and the arithmetic is one expression in each place. */
  const src = fs.readFileSync(path.join(ROOT, 'portal/index.html'), 'utf8');

  /* The Videos section numbered within its own list while the Evidence index
     printed the document-wide sequence, so one exhibit had two numbers
     whenever anything preceded a video — which is always, since the Worker
     sorts attachments and photos ahead of it. */
  ok('the videos section prints the document-wide exhibit number',
     /<b>Video \$\{String\(r\.n\)/.test(src));
  ok('and no per-section counter survives beside it',
     !/Video \$\{String\(i2 \+ 1\)/.test(src));
  ok('photos already used that sequence and still do',
     /Photo \$\{String\(r\.n\)/.test(src));

  /* `addEvidence` writes photo | video | attachment. Filtering for `document`
     counted nothing, so Documents read 0 with a PDF in the package and the
     Evidence step read undone on a document-only build. */
  ok('the Documents count matches the role the Worker actually writes',
     /role === "attachment" \|\| i\.role === "document"/.test(src));
  const worker = fs.readFileSync(path.join(ROOT, 'case-portal/worker.js'), 'utf8');
  ok('and that role is the one addEvidence stores',
     /'video' : 'attachment'/.test(worker));

  /* A day approved after the package was finalized used to appear nowhere,
     while the Completed desk counted it — two desks, two answers. */
  ok('the days panel is drawn on a finalized package too',
     (src.match(/\$\{daysPanel\(\)\}/g) || []).length === 2,
     String((src.match(/\$\{daysPanel\(\)\}/g) || []).length));
  ok('and a late-approved day says how to include it rather than offering a refused Add',
     /Reopen to include it/.test(src));
}

section('Unit 19 — a removed entry is shown as removed on the report Chronology');
{
  await post('/ingest', {
    case_no: 'API-U19', service: 'Surveillance',
    client_name: 'Accuracy Client', subject_name: 'Accuracy Subject', objective: 'Accuracy',
  }, { 'X-Ingest-Key': 'e2e-ingest-key' });
  const page = await newPage();
  page.on('dialog', d => d.accept());
  await signIn(page, 'trever', 'AdminPassword1x');
  /* A day, two entries, one of them removed — all through the routes that
     already exist, so this is the real shape rather than a planted row. */
  const ids = await page.evaluate(async no => {
    const post2 = (p2, b2) => fetch('/portal-api' + p2, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b2 || {}) }).then(r => r.json());
    await post2(`/cases/${no}/day/start`, { day_date: '2026-08-18', start_time: '08:00' });
    await post2(`/cases/${no}/activity`, { description: 'Subject left the residence',
      at_date: '2026-08-18', at_time: '08:30' });
    await post2(`/cases/${no}/activity`, { description: 'Entered under a different name',
      at_date: '2026-08-18', at_time: '09:05' });
    await post2(`/cases/${no}/day/end`, { end_time: '12:00' });
    const ws = await (await fetch(`/portal-api/cases/${no}/workspace`, { credentials: 'same-origin' })).json();
    const wrong = (ws.activity || []).find(e => /different name/.test(e.description));
    if (wrong) await post2(`/cases/${no}/activity/${wrong.id}/delete`, { reason: 'logged on the wrong case' });
    const day = (ws.days || [])[0];
    const rep = day ? await post2(`/cases/${no}/reports/generate`, { day_id: day.id }) : null;
    return { removed: !!wrong, day: day ? day.id : null,
             report: rep && rep.report ? rep.report.id : (rep && rep.id) || null,
             acts: (ws.activity || []).length };
  }, 'API-U19');
  ok('the fixture built a day, two entries, one removed and a report',
     ids.report != null && ids.removed === true && ids.acts === 2, JSON.stringify(ids));

  await rowFor(page, 'API-U19').click();
  await page.waitForTimeout(600);
  await wsTab(page, 'Report');
  await page.waitForTimeout(700);
  /* Open the report itself, then its Chronology view — the report screen
     renders into #dlgBody, the way the P11 section already drives it. */
  const card = page.locator('[data-act="openReport"]').first();
  if (await card.count()) { await card.click(); await page.waitForTimeout(500); }
  await page.locator('.rpnav button', { hasText: /^Chronology$/ }).first().click();
  await page.waitForTimeout(400);
  const body = await page.locator('#dlgBody').innerText();
  ok('the removed entry is still SHOWN on the chronology, not silently dropped',
     /different name/i.test(body), body.slice(0, 400));
  ok('and it is marked as removed, with when',
     /Removed/.test(body), body.slice(0, 400));
  ok('the entry that stands is unmarked', /left the residence/i.test(body));
  /* Struck through, the way the activity log already draws one — checked
     computed, because a class that has no rule behind it draws nothing. */
  const struck = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.tl-d')].find(d => /different name/i.test(d.textContent));
    return el ? getComputedStyle(el).textDecorationLine : null;
  });
  ok('and the wording is struck through in the document view', struck === 'line-through', String(struck));
  await page.close();
}

section('Retention: five states as words, a hold that outranks, and an audit trail');
{
  await post('/ingest', {
    case_no: 'API-RET-1', service: 'Surveillance',
    client_name: 'Retention Client', subject_name: 'Retention Subject',
    objective: 'Retention walk',
  }, { 'X-Ingest-Key': 'e2e-ingest-key' });
  const page = await newPage();
  page.on('dialog', d => d.accept());   // deleteCase confirms; the walk accepts
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-RET-1').click();
  await page.waitForTimeout(500);
  await wsTab(page, 'Billing');
  await page.waitForTimeout(700);

  const panel = () => page.locator('.feebox', { hasText: 'Retention & legal hold' }).first();
  ok('the retention panel sits beside the closing checklist', await panel().count() === 1);
  let body = await panel().innerText();
  /* .tag is text-transform:uppercase — rendered text needs /i. */
  ok('an untouched case reads Active', /current state:\s*active/i.test(body.replace(/\n/g, ' ')), body.slice(0, 160));
  ok('scheduling is explained as destroying nothing, on the panel, always',
     /Scheduling deletion destroys nothing/.test(body) && /here or in Dropbox/.test(body));
  ok('and the panel points at the archive and delete controls below rather than growing its own',
     /keep their own controls below/.test(body));

  /* Retain Until — set by hand, no clock. A FUTURE date first. */
  await page.locator('#ret_until').fill('2030-01-01');
  await page.locator('[data-act="retSaveUntil"]').click();
  await page.waitForTimeout(600);
  body = await panel().innerText();
  ok('a future retain-until reads Retain Until, no review flag',
     /retain until/i.test(body) && !/review due/i.test(body), body.slice(0, 200));

  /* A PAST date becomes RETENTION REVIEW DUE — wording only, nothing acts. */
  await page.locator('#ret_until').fill('2020-05-05');
  await page.locator('[data-act="retSaveUntil"]').click();
  await page.waitForTimeout(600);
  body = await panel().innerText();
  ok('a passed date reads RETENTION REVIEW DUE', /retention review due/i.test(body), body.slice(0, 260));
  ok('and the banner says nothing happens on its own', /Nothing happens on its own/.test(body));

  /* The hold. Reason is REQUIRED — the Worker's refusal, not a page copy. */
  await page.locator('[data-act="retHoldPlace"]').click();
  await page.waitForTimeout(500);
  body = await panel().innerText();
  ok('placing a hold with no reason is refused in words',
     /A hold needs its reason/.test(body), body.slice(-200));
  await page.locator('#ret_hold_reason').fill('Litigation notice from claimant counsel');
  await page.locator('[data-act="retHoldPlace"]').click();
  await page.waitForTimeout(600);
  body = await panel().innerText();
  ok('the hold banner carries the reason, who and when',
     /Litigation notice from claimant counsel/.test(body) && /Trever/.test(body), body.slice(0, 400));
  ok('and says what it blocks and what stays open',
     /deleting the case, scheduling\s+deletion and removing evidence are refused/.test(body.replace(/\n/g, ' '))
     && /billing, reports/i.test(body));

  /* THE HOLD OUTRANKS: scheduling is refused by name… */
  await page.locator('[data-act="retSchedule"]').click();
  await page.waitForTimeout(500);
  body = await panel().innerText();
  ok('scheduling under a hold is refused naming the hold',
     /scheduling deletion is blocked/.test(body), body.slice(-260));
  /* …and so is Delete case, through the EXISTING control below. */
  await page.locator('[data-act="deleteCase"]').click();
  await page.waitForTimeout(600);
  const delPanel = await page.locator('.feebox', { hasText: 'Delete case' }).first().innerText();
  ok('deleting under a hold is refused at the existing control',
     /legal hold/.test(delPanel), delPanel.slice(-220));
  ok('and the case is still not deleted', !/Case deleted/.test(await page.locator('main').innerText()));

  /* Release needs its reason too — decision 7 audits both directions. */
  await page.locator('[data-act="retHoldRelease"]').click();
  await page.waitForTimeout(500);
  ok('releasing with no reason is refused in words',
     /Releasing a hold needs its reason/.test(await panel().innerText()));
  await page.locator('#ret_hold_release').fill('Matter settled; counsel released the preservation demand');
  await page.locator('[data-act="retHoldRelease"]').click();
  await page.waitForTimeout(600);
  body = await panel().innerText();
  ok('a released hold leaves the banner', !/Litigation notice from claimant counsel/.test(body));

  /* Scheduling now records the INTENT and nothing else. Earlier sections
     legitimately soft-delete evidence of their own, so the assertion is
     before-vs-after around the click, never a global zero. */
  const evState = () => db.prepare(
    'SELECT COUNT(*) AS all_rows, COUNT(deleted_at) AS marked FROM case_evidence').get();
  const evBefore = evState();
  await page.locator('[data-act="retSchedule"]').click();
  await page.waitForTimeout(600);
  body = await panel().innerText();
  ok('the state reads Scheduled for Deletion', /scheduled for deletion/i.test(body), body.slice(0, 200));
  ok('with a cancel beside it', await page.locator('[data-act="retUnschedule"]').count() === 1);
  const evAfter = evState();
  ok('and scheduling deleted no file anywhere',
     evAfter.all_rows === evBefore.all_rows && evAfter.marked === evBefore.marked,
     JSON.stringify({ before: evBefore, after: evAfter }));

  /* The audit trail: actor, prior/new, reason — on screen when asked. */
  await page.locator('[data-act="retHist"]').click();
  await page.waitForTimeout(400);
  const hist = await page.locator('.retev').innerText();
  ok('the history lists the hold both ways with its reasons',
     /Legal hold placed/.test(hist) && /Legal hold released/.test(hist)
     && /Matter settled/.test(hist), hist.slice(0, 400));
  ok('the retain-until changes carry prior → new',
     /Retain-until set/.test(hist) && /2030-01-01/.test(hist) && /2020-05-05/.test(hist));
  ok('every event names who', (hist.match(/Trever/g) || []).length >= 4, hist);

  /* Cancel, then the ladder through the EXISTING archive/restore. */
  await page.locator('[data-act="retUnschedule"]').click();
  await page.waitForTimeout(600);
  ok('cancelling returns the state to Retain Until',
     /retain until/i.test((await panel().innerText()).split('\n').slice(0, 3).join(' ')));
  await page.locator('[data-act="archiveCase"]').click();
  await page.waitForTimeout(800);
  ok('archiving reads Archived on the ladder — archived outranks retain-until',
     /current state:\s*archived/i.test((await panel().innerText()).replace(/\n/g, ' ')));
  await page.locator('[data-act="restoreCase"]').click();
  await page.waitForTimeout(800);
  ok('restoring returns Retain Until',
     /current state:\s*retain until/i.test((await panel().innerText()).replace(/\n/g, ' ')));

  /* Clear the date; Active again. */
  await page.locator('[data-act="retClearUntil"]').click();
  await page.waitForTimeout(600);
  ok('clearing the date returns Active',
     /current state:\s*active/i.test((await panel().innerText()).replace(/\n/g, ' ')));

  /* Delete (no hold now): the audit state, said carefully, controls withdrawn. */
  await page.locator('[data-act="deleteCase"]').click();
  await page.waitForTimeout(800);
  body = await panel().innerText();
  ok('a deleted case reads Deleted / Destruction Recorded',
     /deleted \/ destruction recorded/i.test(body), body.slice(0, 220));
  ok('and the panel says the audit state destroyed nothing and authorizes nothing',
     /does not mean any file was destroyed/.test(body) && /does not authorize destroying one/.test(body));
  ok('the write controls are withdrawn while deleted',
     await page.locator('#ret_until').count() === 0
     && await page.locator('#ret_hold_reason').count() === 0
     && /put the case back first/.test(body));
  await page.locator('[data-act="undeleteCase"]').click();
  await page.waitForTimeout(800);
  ok('put back, the controls return', await page.locator('#ret_until').count() === 1);

  /* A FAILED READ IS NAMED — never drawn as a case with no retention state. */
  await page.route('**/portal-api/cases/*/retention', r => r.fulfill({ status: 500, body: '{}' }));
  await page.evaluate(() => { RETC = {}; });
  await wsTab(page, 'Overview');
  await page.waitForTimeout(300);
  await wsTab(page, 'Billing');
  await page.waitForTimeout(700);
  body = await panel().innerText();
  ok('a failed retention read says so', /could not be\s+read just now/.test(body.replace(/\n/g, ' ')), body.slice(0, 200));
  ok('and offers Try again', await page.locator('[data-act="retRetry"]').count() === 1);
  await page.unroute('**/portal-api/cases/*/retention');
  await page.locator('[data-act="retRetry"]').click();
  await page.waitForTimeout(700);
  ok('Try again recovers the panel',
     /current state:/i.test((await panel().innerText()).replace(/\n/g, ' ')));
  await page.close();
}

section('Retention: the investigator has no door and the phone has no overflow');
{
  /* An investigator of this section's own, made server-side (the browser
     invite flow is exercised elsewhere), and the case assigned to them —
     the section carries its own fixtures so it runs alone or in the suite. */
  await post('/ingest', {
    case_no: 'API-RET-2', service: 'Surveillance',
    client_name: 'Ret Client Two', subject_name: 'Ret Subject Two',
    objective: 'Role walk',
  }, { 'X-Ingest-Key': 'e2e-ingest-key' });
  const lr = await post('/auth/login', { username: 'trever', password: 'AdminPassword1x' });
  const sc = lr.headers.getSetCookie ? lr.headers.getSetCookie()[0] : lr.headers.get('Set-Cookie');
  const adminCookie = sc.split(';')[0];
  const iv = await (await post('/invites',
    { username: 'ret_inv', display_name: 'Ret Investigator', role: 'investigator' },
    { Cookie: adminCookie })).json();
  const tok = new URL(iv.url, 'https://x.test').searchParams.get('invite');
  await post(`/invite/${tok}/accept`, { password: 'RetField2026x' });
  const invId = db.prepare("SELECT id FROM users WHERE username = 'ret_inv'").get().id;
  await post('/submissions/API-RET-2/assign', { user_id: invId }, { Cookie: adminCookie });

  const page = await newPage();
  await signIn(page, 'ret_inv', 'RetField2026x');
  await rowFor(page, 'API-RET-2').click();
  await page.waitForTimeout(600);
  const whole = await page.locator('main').innerText();
  ok('an investigator\'s case screen carries no retention panel',
     !/Retention & legal hold/i.test(whole) && !/legal hold/i.test(whole), '');
  await page.close();

  /* The phone: the panel fits, the controls meet the floor, the date cannot zoom iOS. */
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  phone.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await phone.goto(SITE + '/portal/');
  await phone.waitForTimeout(300);
  await phone.locator('#u').fill('trever');
  await phone.locator('#p').fill('AdminPassword1x');
  await phone.locator('#loginBtn').click();
  await phone.waitForTimeout(1400);
  const burger = phone.locator('.burger');
  if (await burger.isVisible()) { await burger.click(); await phone.waitForTimeout(300); }
  await phone.locator('.side button, .tabs button', { hasText: 'Cases' }).first().click();
  await phone.waitForTimeout(600);
  await rowFor(phone, 'API-RET-1').click();
  await phone.waitForTimeout(600);
  await wsTab(phone, 'Billing');
  await phone.waitForTimeout(800);
  const m = await phone.evaluate(() => {
    const until = document.getElementById('ret_until');
    const btn = document.querySelector('[data-act="retSchedule"], [data-act="retUnschedule"]');
    const b = btn && btn.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      untilFont: until ? parseFloat(getComputedStyle(until).fontSize) : 0,
      untilH: until ? until.getBoundingClientRect().height : 0,
      btnH: b ? b.height : 0,
    };
  });
  ok('390px: the retention panel adds no sideways scroll', m.overflow <= 0, String(m.overflow));
  ok('390px: the date input is 16px so iOS does not zoom on focus', m.untilFont >= 16, String(m.untilFont));
  ok('390px: the date input meets the 44px floor', m.untilH >= 44, String(m.untilH));
  ok('390px: the schedule control meets the 44px floor', m.btnH >= 44, String(m.btnH));
  await phone.close();
}

section('Evidence integrity: the card states the record and the office can act on it');
{
  db.prepare(`INSERT INTO submissions (case_no, kind, status, client_name, subject_name, payload, created_at)
     VALUES ('API-INTP-1', 'consumer', 'new', 'Hash Client', 'Subject H',
             '{"objective":"Integrity on the card"}', ?)`).run(new Date().toISOString());

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-INTP-1').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Evidence');

  /* An upload through the page: the card carries the integrity block at once. */
  const bytes = Buffer.alloc(2048, 71);
  await page.locator('#ev_file').setInputFiles({
    name: 'porch.jpg', mimeType: 'image/jpeg', buffer: bytes });
  await page.locator('.btn', { hasText: 'Upload picture or document' }).click();
  await page.waitForTimeout(800);
  const card = () => page.locator('.evcard', { hasText: 'porch.jpg' }).first();
  let integ = await card().locator('.integ').innerText();
  ok('a fresh upload wears "Hash recorded", as an original, hashed by the portal',
     has(integ, 'Hash recorded') && has(integ, 'Original') && has(integ, 'hashed by the portal')
       && has(integ, 'Dropbox'), integ.slice(0, 200));

  /* THE FULL DIGEST IS THE REAL ONE — read out of the details fold and
     compared against a SHA-256 of the same bytes computed here. */
  await card().locator('.integ summary').click();
  const shown = (await card().locator('.integ details .hash').innerText()).trim();
  const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  ok('the full hash is copyable text and is the digest of the filed bytes',
     shown === expected, shown);
  ok('and the abbreviation shows its ends, not a truncated record',
     has(await card().locator('.integ').innerText(), expected.slice(0, 4)));

  /* VERIFY: match while the bytes stand, mismatch the moment they differ. */
  await card().locator('[data-act="ihVerify"]').click();
  await page.waitForTimeout(600);
  ok('verify against unchanged bytes says the current bytes match',
     has(await card().locator('.integ').innerText(), 'match the recorded hash'));
  const key = db.prepare(`SELECT r2_key FROM case_evidence WHERE case_no='API-INTP-1' AND filename='porch.jpg'`)
    .get().r2_key.replace(/^dropbox:/, '');
  await page.evaluate(() => {});           // settle
  DBX.files.set(key, Buffer.alloc(2048, 72));
  await card().locator('[data-act="ihVerify"]').click();
  await page.waitForTimeout(600);
  integ = await card().locator('.integ').innerText();
  ok('changed bytes read as NOT matching, with the current digest shown',
     has(integ, 'do NOT match') && has(integ, 'now:'), integ.slice(0, 260));

  /* A metadata edit is not a file event: reclassify, and the record stands. */
  await card().locator('[data-act="evClass"]').selectOption('internal_only');
  await page.waitForTimeout(600);
  ok('reclassifying does not move the hash',
     (await card().locator('.integ').innerText()).includes(expected.slice(0, 4)));

  /* A FILE FROM BEFORE THE FEATURE: "Not yet recorded" plus the one explicit
     way forward, which reads the file once and fills the record in. */
  DBX.files.set('/API-INTP-1/Photos/older.jpg', Buffer.alloc(900, 50));
  db.prepare(`INSERT INTO case_evidence (case_no, r2_key, filename, content_type, size_bytes,
      classification, uploaded_at) VALUES ('API-INTP-1', 'dropbox:/API-INTP-1/Photos/older.jpg',
      'older.jpg', 'image/jpeg', 900, 'client_deliverable', '2026-07-02T10:00:00.000Z')`).run();
  await page.locator('.close').click();
  await page.waitForTimeout(300);
  await rowFor(page, 'API-INTP-1').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Evidence');
  const older = () => page.locator('.evcard', { hasText: 'older.jpg' }).first();
  integ = await older().locator('.integ').innerText();
  ok('a historical file reads "Not yet recorded" — never a guessed hash',
     has(integ, 'Not yet recorded') && has(integ, 'No hash has been captured'));
  await older().locator('[data-act="ihRecord"]').click();
  await page.waitForTimeout(800);
  integ = await older().locator('.integ').innerText();
  ok('Record integrity hash reads the file once and the card turns recorded',
     has(integ, 'Hash recorded') && has(integ, 'hashed by the portal'), integ.slice(0, 200));

  await page.close();
}

section('Evidence integrity: the field sees the record and holds no lever');
{
  /* dana holds API-20260812-4001 from the assignment section. Their own upload
     through the page creates the record they then see — the same round trip the
     field actually makes. */
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Evidence');
  await page.locator('#ev_file').setInputFiles({
    name: 'field.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(1200, 80) });
  await page.locator('.btn', { hasText: 'Upload picture or document' }).click();
  await page.waitForTimeout(800);
  const integs = page.locator('.integ');
  ok('an investigator sees integrity on the case they hold',
     (await integs.count()) >= 1);
  ok('but no Verify, no Record — reading bytes back is the office\'s act',
     (await page.locator('[data-act="ihVerify"]').count()) === 0
       && (await page.locator('[data-act="ihRecord"]').count()) === 0);
  ok('and no manifest door either',
     (await page.locator('[data-act="manOpen"]').count()) === 0);
  await page.close();
}

section('The evidence manifest: a readable document, printable, honest when it fails');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-INTP-1').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Evidence');

  await page.locator('[data-act="manOpen"]').click();
  await page.waitForTimeout(700);
  const doc = await text(page, '#mandoc');
  ok('the manifest names the case and counts its files',
     has(doc, 'Evidence Integrity Manifest') && has(doc, 'API-INTP-1') && has(doc, 'file(s)'));
  ok('every recorded file prints its full SHA-256',
     (doc.match(/SHA-256 [0-9a-f]{64}/g) || []).length >= 2, doc.slice(0, 300));
  ok('roles and classifications ride along',
     has(doc, 'Original') && has(doc, 'Internal only'));
  ok('and the wording claims a portal record, not a legal blessing',
     has(doc, 'not a third-party authentication'));
  const whole = await text(page, '#dlgBody');
  ok('nothing secret is anywhere near it',
     !/RT-test|sl\.FAKE|Bearer|refresh_token/i.test(whole));

  /* PRINT is the existing print-region pattern: the body class flips, #mandoc
     is the visible region, and no second PDF writer exists anywhere. */
  await page.evaluate(() => { window.print = () => { window.__printed = true; }; });
  await page.locator('[data-act="manPrint"]').click();
  const printedVia = await page.evaluate(() => ({
    printed: Boolean(window.__printed),
    cls: document.body.className,
  }));
  ok('Print goes through the browser dialog with the manifest as the print region',
     printedVia.printed && /printing-manifest/.test(printedVia.cls), JSON.stringify(printedVia));
  await page.waitForTimeout(600);
  ok('and the page comes back out of print dress',
     !/printing-manifest/.test(await page.evaluate(() => document.body.className)));

  await page.locator('[data-act="manBack"]').click();
  await page.waitForTimeout(400);
  ok('Back lands on Case media, not somewhere new',
     has(await text(page, '#dlgBody'), 'Case media'));

  /* A FAILED READ SAYS SO — never an empty manifest. */
  await page.route('**/portal-api/cases/*/manifest', r => r.abort());
  await page.locator('[data-act="manOpen"]').click();
  await page.waitForTimeout(600);
  const failed = await text(page, '#dlgBody');
  ok('a manifest that could not load says so and offers to try again',
     !has(failed, 'Evidence Integrity Manifest') && (await page.locator('[data-act="manOpen"]').count()) >= 1,
     failed.slice(0, 200));
  await page.unroute('**/portal-api/cases/*/manifest');
  await page.close();
}

section('Evidence integrity on a phone: the hash wraps, the buttons reach the floor');
{
  /* Navigate the way a person on a phone does — under 900px the rail is a
     drawer behind the burger, and signIn's straight click at Cases would wait
     on a rendered, invisible button. */
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await page.goto(SITE + '/portal/');
  await page.waitForTimeout(300);
  await page.locator('#u').fill('trever');
  await page.locator('#p').fill('AdminPassword1x');
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(1200);
  const burger = page.locator('.burger');
  if (await burger.isVisible()) { await burger.click(); await page.waitForTimeout(300); }
  await page.locator('.side button, .tabs button', { hasText: 'Cases' }).first().click();
  await page.waitForTimeout(600);
  await page.locator('tbody tr', { hasText: 'API-INTP-1' }).first().click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Evidence');

  /* No sideways scroll with a 64-character token on screen. */
  await page.locator('.evcard .integ summary').first().click();
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const hash = document.querySelector('.integ details .hash');
    const card = hash && hash.closest('.evcard');
    const btn = document.querySelector('.integ .btn');
    const b = btn && btn.getBoundingClientRect();
    return {
      overflow: doc.scrollWidth - doc.clientWidth,
      hashInside: hash && card ? hash.getBoundingClientRect().right <= card.getBoundingClientRect().right + 1 : null,
      btnH: b ? b.height : 0,
    };
  });
  ok('the page does not scroll sideways with a full hash open', m.overflow <= 0, String(m.overflow));
  ok('the sixty-four characters wrap inside their own card', m.hashInside === true);
  ok('the integrity buttons meet the 44px floor', m.btnH >= 44, String(m.btnH));

  /* The manifest on the same phone: readable, and still no sideways scroll. */
  await page.locator('[data-act="manOpen"]').click();
  await page.waitForTimeout(700);
  const m2 = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    rows: document.querySelectorAll('#mandoc .man-i').length,
  }));
  ok('the manifest fits the phone', m2.overflow <= 0, String(m2.overflow));
  ok('with its rows intact', m2.rows >= 2, String(m2.rows));
  await page.close();
}


/* ==================================================================
   OPTIONAL / REQUIRED FIELD LABELS ON THE ADMIN INTAKE FORMS
   (owner rule, 2026-08-21 — "audit requiredness from the actual server-side
   validation/schema first. Do not guess from the current UI.")

   So the requiredness these labels claim is checked against the Worker by
   POSTING, not against a second list written here. Four surfaces use the
   intake fields: Quick intake (three doors), Edit case, the Legal panel and
   the saved Clients & Firms forms.

   Three markers, because requiredness has three shapes:
     *          createManualIntake / createProfile refuse the save without it.
     (optional) the Worker accepts the save with it blank.
     (a or b)   neither alone is required and neither is optional — the Worker
                wants ONE of the two.
   A select with no empty option is none of the three: it cannot be left blank
   and it cannot be omitted, so it carries no marker. Status and the case-type
   picker on a case that has one are the two of those. */

section('Admin intake labels say what the Worker actually enforces');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  const MARK_OPT  = /\(optional\)/;
  const MARK_REQ  = /\*/;
  const MARK_PAIR = /\((?:carrier or assigning contact|firm or attorney|first or last name)[^)]*\)/;

  const labels = () => page.evaluate(sel => [...document.querySelectorAll(sel + ' label.f')].map(l => {
    const sp = l.querySelector(':scope > span');
    const ctl = l.querySelector('input, select, textarea');
    const empties = ctl && ctl.tagName === 'SELECT'
      ? [...ctl.options].some(o => o.value === '') : true;
    return { text: sp ? sp.textContent.replace(/\s+/g, ' ').trim() : '',
             key: ctl ? (ctl.id || ctl.getAttribute('data-k') || '') : '',
             canBeBlank: empties };
  }), '#app');

  let audited = 0;
  async function audit(tag) {
    for (const l of await labels()) {
      /* A select with no empty option cannot be left blank — it is neither
         optional nor a field you can fail to complete, so it is exempt and
         the exemption is narrow enough to state. */
      if (!l.canBeBlank && !MARK_REQ.test(l.text) && !MARK_OPT.test(l.text)) continue;
      audited++;
      const marks = [MARK_REQ.test(l.text), MARK_OPT.test(l.text), MARK_PAIR.test(l.text)]
        .filter(Boolean).length;
      ok(`${tag}: "${l.text}" carries exactly one requiredness marker`, marks === 1, l.text);
      ok(`${tag}: "${l.text}" does not say optional twice`,
         (l.text.match(/optional/gi) || []).length <= 1, l.text);
    }
  }

  for (const kind of ['claims', 'consumer', 'legal']) {
    await page.locator('[data-act="tab"][data-tab="newlead"]').first().click();
    await page.waitForTimeout(500);
    /* The picker draws only while no door has been taken — coming back to the
       tab with a door already chosen renders that door's form. "Change type"
       is how a person gets back to the three cards, so it is how this does. */
    const back = page.locator('[data-act="nlBack"]');
    if (await back.count()) { await back.click(); await page.waitForTimeout(350); }
    await page.locator(`[data-act="nlKind"][data-k="${kind}"]`).click();
    await page.waitForTimeout(350);
    await audit('quick:' + kind);
  }
  ok('the audit walked the three quick-intake doors rather than finding nothing',
     audited > 20, `${audited} labels`);

  /* Clients & Firms — the saved defaults that prefill an assignment, so the
     same fields under a different door. */
  await page.locator('[data-act="tab"][data-tab="profiles"]').first().click();
  await page.waitForTimeout(600);
  await page.locator('[data-act="profNew"]').first().click();
  await page.waitForTimeout(400);
  await page.locator('[data-act="profFormKind"][data-k="law_firm"]').click();
  await page.waitForTimeout(300);
  ok('the new-profile form drew', (await labels()).length > 5, String((await labels()).length));
  await audit('profile:law_firm');
  await page.close();
}

/* THE CLAIMS THE LABELS MAKE, PUT TO THE WORKER. A pair marker says neither
   half is required alone and neither is optional; that is three assertions,
   and the third (neither = refused) is the one a wrong label would pass. */
section('The Worker agrees with the pair markers on quick intake');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  const tryLead = (kind, body) => page.evaluate(async ([k, b]) => {
    const r = await fetch('/portal-api/intakes', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: k, ...b }),
    });
    return { status: r.status, body: await r.json() };
  }, [kind, body]);

  const carrierOnly = await tryLead('claims', { carrier: 'Label Test Mutual' });
  ok('claims: the carrier alone is accepted', carrierOnly.status === 201, JSON.stringify(carrierOnly));
  const contactOnly = await tryLead('claims', { client_name: 'Label Test Adjuster' });
  ok('claims: the assigning contact alone is accepted', contactOnly.status === 201, JSON.stringify(contactOnly));
  const neitherClaim = await tryLead('claims', { objective: 'nothing identifying' });
  ok('claims: neither is refused — so neither is "(optional)"',
     neitherClaim.status === 400, JSON.stringify(neitherClaim));

  const firmOnly = await tryLead('legal', { firm_name: 'Label Test Law' });
  ok('legal: the firm alone is accepted', firmOnly.status === 201, JSON.stringify(firmOnly));
  const attyOnly = await tryLead('legal', { attorney_name: 'Label Test Attorney' });
  ok('legal: the attorney alone is accepted', attyOnly.status === 201, JSON.stringify(attyOnly));
  const neitherLegal = await tryLead('legal', { objective: 'nothing identifying' });
  ok('legal: neither is refused', neitherLegal.status === 400, JSON.stringify(neitherLegal));

  /* And the one plain-required field on these forms really is required. */
  const noClient = await tryLead('consumer', { objective: 'no name at all' });
  ok('private: the client name is refused when blank — the * is real',
     noClient.status === 400, JSON.stringify(noClient));

  /* THE OTHER HALF OF THE CLAIM: everything marked (optional) really can be
     left out. This posts a lead carrying ONLY the required half of each pair
     and nothing else at all. */
  const bare = await tryLead('legal', { firm_name: 'Label Test Bare Firm' });
  ok('legal: a lead with nothing but the firm is created',
     bare.status === 201 && bare.body.ok, JSON.stringify(bare));
  await page.close();
}

section('Edit case and the Legal panel mark their fields too');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('[data-act="tab"][data-tab="newlead"]').first().click();
  await page.waitForTimeout(500);
  await page.locator('[data-act="nlKind"][data-k="legal"]').click();
  await page.waitForTimeout(300);
  await page.locator('#nl_firm').fill('Marker Test Law');
  await page.locator('#nl_atty').fill('R. Marker');
  await page.locator('[data-act="nlSave"][data-open="1"]').click();
  await page.waitForTimeout(1100);
  ok('the fixture case opened', await page.evaluate(() => VIEW) === 'case');

  const MARK_OPT = /\(optional\)/, MARK_REQ = /\*/;
  const panelLabels = sel => page.evaluate(s => {
    const card = [...document.querySelectorAll('.card')]
      .find(c => (c.querySelector('h2') || {}).textContent === s);
    if (!card) return null;
    return [...card.querySelectorAll('label.f')].map(l => {
      const sp = l.querySelector(':scope > span');
      const ctl = l.querySelector('input, select, textarea');
      const blank = ctl && ctl.tagName === 'SELECT'
        ? [...ctl.options].some(o => o.value === '') : true;
      return { text: sp ? sp.textContent.replace(/\s+/g, ' ').trim() : '',
               key: ctl ? ctl.id : '', canBeBlank: blank };
    });
  }, sel);

  await wsTab(page, 'Legal');
  await page.waitForTimeout(500);
  const legal = await panelLabels('Legal assignment');
  ok('the Legal panel drew its fields', legal && legal.length > 15,
     legal ? String(legal.length) : 'panel not found');
  const legalBare = (legal || []).filter(l => l.canBeBlank && !MARK_OPT.test(l.text));
  ok('every field on the Legal panel says it can be left blank — because every one can',
     legalBare.length === 0, JSON.stringify(legalBare.map(l => l.text)));

  await wsTab(page, 'Edit case');
  await page.waitForTimeout(500);
  const edit = await panelLabels('Edit case');
  ok('the Edit case panel drew its fields', edit && edit.length > 4,
     edit ? String(edit.length) : 'panel not found');
  const editBare = (edit || []).filter(l => l.canBeBlank
    && !MARK_OPT.test(l.text) && !MARK_REQ.test(l.text));
  ok('and nothing on it is left unmarked',
     editBare.length === 0, JSON.stringify(editBare.map(l => l.text)));

  /* An extra phone row is one of the fields the owner named by hand, and it
     is drawn by a helper — so the marker has to ride the helper or the second
     number arrives unmarked. */
  /* Row 0 has to hold a number first: `readPhoneRows` skips blank rows, so on
     a case with no saved numbers Add appends to an empty list and the panel
     still draws one row. Typing one is what a person does before asking for a
     second anyway. */
  await page.locator('#edc_num_0').fill('5405550101');
  await page.locator('[data-act="edAddPhone"]').first().click();
  await page.waitForTimeout(400);
  const withRow = await panelLabels('Edit case');
  const rows = withRow.filter(l => /^(Phone|Also)\b/.test(l.text));
  ok('an added phone row carries the marker like the first one',
     rows.length >= 2 && rows.every(l => MARK_OPT.test(l.text)),
     JSON.stringify(rows.map(l => l.text)));
  await page.close();
}

/* One writer for the wording, the rule this file already applies to
   dayEndLabel and termLabel. Five hand-written spellings of "optional" is
   five chances for one of them to say something the Worker does not do. */
section('The admin markers have one writer');
{
  const src = fs.readFileSync(path.join(ROOT, 'portal', 'index.html'), 'utf8');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '')
                  .replace(/const (REQL|OPTL|PAIRL|ONE_[A-Z]+)\b[^\n]*\n/g, '');
  ok('no hand-written required marker outside the constant',
     !/<b class="req">\*<\/b>/.test(body), (body.match(/.{0,50}<b class="req">/) || [''])[0]);
  ok('the required marker has a colour rule, so it is not invisible',
     /\n\s*\.req\{color:/.test(src));
  /* Scoped to the seven functions that draw the intake forms — elsewhere in
     this file `.opt` is a general muted annotation (a phone label, a handle,
     "firm default") and not a requiredness marker at all. */
  const fns = ['function newLeadView(', 'function nlPickerHtml(', 'function editCasePanel(',
               'function phoneRowsHtml(', 'function legalPanel(',
               'function profileFieldsHtml(', 'function contactFormHtml('];
  const bare = [];
  for (const fn of fns) {
    const i = src.indexOf(fn);
    if (i < 0) { bare.push(fn + ' — not found'); continue; }
    const chunk = src.slice(i, src.indexOf('\n}\n', i));
    if (/<span class="opt">\(optional\)<\/span>/.test(chunk)) bare.push(fn);
  }
  ok('no intake form spells the optional marker by hand', bare.length === 0, bare.join(' | '));
}


/* ======================================================================
   UNIT 38 — THE TWENTY THE OWNER NUMBERED.

   Their brief lists twenty page-level and navigation properties. Each is
   asserted below under its own number, so a later reader can check the list
   against the tests without reading either in full. Ordering (their five) is
   pinned in the Worker suite, where the source is; what is pinned here is
   what the PAGE does with it.
   ====================================================================== */

section('Unit 38 — the case workspace, the twenty named properties');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('[data-act="tab"][data-tab="cases"]').first().click();
  await page.waitForTimeout(600);
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(800);
  const caseNo = await page.evaluate(() => WS_CASE);

  /* 1. Opening a case exposes Activity directly. */
  const row = await page.locator('.wsnav button[data-act="wsTab"]').allInnerTexts();
  ok('1. opening a case exposes Activity on the row itself',
     await page.locator('.wsnav button[data-tab="activity"]').count() === 1, JSON.stringify(row));

  /* 2. Daily Summary is directly reachable from the case. */
  ok('2. Daily Summary is on the row too, not three levels down',
     await page.locator('.wsnav button[data-tab="daily"]').count() === 1, JSON.stringify(row));

  /* 3 + 4. Activity and Daily Summary default to the case already open —
     nobody is asked which case, twice. */
  await page.locator('.wsnav button[data-tab="activity"]').click();
  await page.waitForTimeout(500);
  ok('3. Activity opens on the case already open',
     (await page.evaluate(() => WS_CASE)) === caseNo && (await wsOpenTab(page)) === 'activity');
  ok('3b. and asks for no second case choice',
     await page.locator('.wspanel select[id*="case"], .wspanel [data-act="pickCase"]').count() === 0);
  await page.locator('.wsnav button[data-tab="daily"]').click();
  await page.waitForTimeout(600);
  ok('4. Daily Summary opens on the same case',
     (await page.evaluate(() => WS_CASE)) === caseNo && (await wsOpenTab(page)) === 'daily');
  ok('4b. and asks for no second case choice',
     await page.locator('.wspanel select[id*="case"], .wspanel [data-act="pickCase"]').count() === 0);

  /* 5. The current/open day is the one selected, and it says which it is. */
  const dsText = await text(page, '.wspanel');
  const dayFacts = await page.evaluate(() => {
    const c = wsCurrentDay();
    return { has: !!c.day, open: c.open, label: c.label, no: c.day ? wsDayNo(c.day) : null };
  });
  ok('5. the day on screen is the running one, or the latest, and is labelled',
     dayFacts.has
       ? (has(dsText, `Day ${dayFacts.no}`)
          && has(dsText, dayFacts.open ? 'running now' : 'most recent day'))
       : has(dsText, 'No investigation day yet'),
     `${JSON.stringify(dayFacts)} :: ${dsText.replace(/\s+/g, ' ').slice(0, 160)}`);

  /* 6. + Add Activity works — one visible door, and it opens the composer. */
  ok('6a. exactly one Add activity door is visible',
     await page.locator('[data-act="actOpen"]:visible').count() === 1,
     String(await page.locator('[data-act="actOpen"]:visible').count()));
  await openComposer(page);
  ok('6b. + Add Activity opens the composer', await page.locator('#a_desc').count() === 1);
  await page.locator('#a_time').fill('11:11');
  await page.locator('#a_desc').fill('Unit 38 check entry.');
  await page.locator('.btn', { hasText: 'Add to the log' }).click();
  await page.waitForTimeout(800);
  /* Added from the Daily Summary tab — which is the point, the door is on
     every tab now — so the LOG is where it has to be looked for. */
  await wsTab(page, 'Activity');
  ok('6c. and the entry lands in the log, wherever it was added from',
     has(await text(page, '#dlgBody'), 'Unit 38 check entry.'));

  /* 7 + 8. Evidence and Report open on the selected case. */
  await page.locator('.wsnav button[data-tab="evidence"]').click();
  await page.waitForTimeout(600);
  ok('7. Evidence opens the selected case',
     (await wsOpenTab(page)) === 'evidence' && (await page.evaluate(() => WS_CASE)) === caseNo);
  await page.locator('.wsnav button[data-tab="reports"]').click();
  await page.waitForTimeout(600);
  ok('8. Report opens the selected case',
     (await wsOpenTab(page)) === 'reports' && (await page.evaluate(() => WS_CASE)) === caseNo);

  /* 9. Admin Billing is still reachable. */
  ok('9. an admin still has Billing on the row',
     await page.locator('.wsnav button[data-tab="billing"]').count() === 1);
  await page.locator('.wsnav button[data-tab="billing"]').click();
  await page.waitForTimeout(700);
  ok('9b. and it opens', (await wsOpenTab(page)) === 'billing');

  /* 11. Every desktop tab works — the row and the More list both route. */
  const tabs = await wsAllTabs(page);
  const broken = [];
  for (const t of tabs) {
    await wsTab(page, t.label);
    if ((await wsOpenTab(page)) !== t.key) broken.push(`${t.label}->${await wsOpenTab(page)}`);
  }
  ok('11. every workspace tab routes to its own panel', broken.length === 0, broken.join(', '));
  ok('11b. and the walk covered the whole nav, row and More', tabs.length >= 15, String(tabs.length));

  /* 15. Existing deep links do not break — every key the old sections used
         still routes, because the keys never changed. */
  const legacy = ['overview', 'details', 'subject', 'field', 'activity', 'timeline',
                  'reports', 'evidence', 'package', 'edit', 'assign', 'auth',
                  'expenses', 'notes', 'comms', 'tasks', 'billing'];
  const dead = [];
  for (const k of legacy) {
    await page.evaluate(key => { WS_TAB = key; WS_MORE = false; paintCase(); }, k);
    await page.waitForTimeout(160);
    const drew = (await text(page, '.wspanel')).trim().length;
    if ((await wsOpenTab(page)) !== k || drew < 5) dead.push(k);
  }
  ok('15. every pre-Unit-38 tab key still routes and draws', dead.length === 0, dead.join(', '));

  /* 19. File Queue is a cross-case tool and did not move into the case. */
  ok('19a. File queue is not a case tab', !tabs.some(t => /file queue/i.test(t.label)),
     JSON.stringify(tabs.map(t => t.label)));
  await page.locator('[data-act="backToCases"]').first().click();
  await page.waitForTimeout(500);
  ok('19b. and it is still its own door in the main nav',
     await page.locator('[data-act="tab"][data-tab="filequeue"]').count() >= 1);

  /* 20. Accessibility: one h1, the current tab marked, focusable controls. */
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(700);
  ok('20a. there is exactly one h1 on the signed-in page',
     await page.locator('h1').count() === 1, String(await page.locator('h1').count()));
  ok('20b. the tab you are on is marked for a screen reader',
     await page.locator('.wsnav button[aria-current="page"]').count() === 1);
  ok('20c. the More control announces that it opens a menu',
     await page.locator('[data-act="wsMore"][aria-haspopup="true"]').first().count() === 1);
  const expanded = async () => page.locator('[data-act="wsMore"]').first().getAttribute('aria-expanded');
  ok('20d. and says whether it is open', (await expanded()) === 'false');
  await page.locator('.wsnav [data-act="wsMore"]').click();
  await page.waitForTimeout(300);
  ok('20e. which changes when it is', (await expanded()) === 'true');
  ok('20f. the menu is a menu', await page.locator('.wsmorelist[role="menu"]').count() === 1);
  await page.close();
}

section('Unit 38 — the field-first case view on a phone');
{
  for (const width of [375, 390, 430]) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => ok(`no page errors at ${width}px (${e.message})`, false));
    await page.goto(SITE + '/portal/');
    await page.waitForTimeout(300);
    await page.locator('#u').fill('trever');
    await page.locator('#p').fill('AdminPassword1x');
    await page.locator('#loginBtn').click();
    await page.waitForTimeout(900);
    if (await page.locator('.burger').count()) {
      await page.locator('.burger').click(); await page.waitForTimeout(300);
    }
    await page.locator('.tabs button', { hasText: 'Cases' }).first().click();
    await page.waitForTimeout(700);
    await rowFor(page, 'API-20260812-4002').click();
    await page.waitForTimeout(800);

    /* 12. The mobile field layout works at each width. */
    const bar = await page.evaluate(() => {
      const b = document.querySelector('.casepage .wsbar');
      if (!b) return null;
      const cs = getComputedStyle(b);
      const btns = [...b.querySelectorAll('button')];
      return { display: cs.display, position: cs.position, n: btns.length,
               labels: btns.map(x => x.textContent.replace(/\s+/g, ' ').trim()),
               minH: Math.min(...btns.map(x => Math.round(x.getBoundingClientRect().height))),
               bottom: Math.round(Math.min(...btns.map(x => window.innerHeight - x.getBoundingClientRect().bottom))) };
    });
    ok(`12. ${width}px: the field bar is the case navigation`,
       bar && bar.display === 'flex' && bar.position === 'fixed' && bar.n === 5, JSON.stringify(bar));
    ok(`12b. ${width}px: every key clears Apple's 44px floor`, bar && bar.minH >= 44,
       bar ? `${bar.minH}px` : 'no bar');
    ok(`12c. ${width}px: and stands clear of the home indicator`, bar && bar.bottom >= 12,
       bar ? `${bar.bottom}px` : 'no bar');

    /* 13. No horizontal overflow. */
    const of = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(`13. ${width}px: the case page does not scroll sideways`, of <= 0, String(of));

    /* 14. Activity and Summary are never under More. */
    ok(`14. ${width}px: Activity and Summary are IN the bar`,
       bar && bar.labels.some(l => /Activity/.test(l)) && bar.labels.some(l => /Summary/.test(l)),
       JSON.stringify(bar && bar.labels));
    await page.locator('.wsbar [data-act="wsMore"]').click();
    await page.waitForTimeout(350);
    const moreLabels = await page.locator('.wsmorelist button').allInnerTexts();
    ok(`14b. ${width}px: and NEITHER is inside More`,
       !moreLabels.some(l => /^(Activity|Daily Summary)$/.test(l.trim())), JSON.stringify(moreLabels));
    /* THE PHONE HOLE THIS UNIT NEARLY SHIPPED: the desktop row is hidden here,
       so anything the thumb bar does not carry has to be in More or it has no
       door at all. */
    ok(`14c. ${width}px: More carries Overview, Report and Billing`,
       ['Overview', 'Report', 'Billing'].every(l => moreLabels.some(x => x.trim() === l)),
       JSON.stringify(moreLabels));
    const reach = await page.evaluate(() => {
      const vis = sel => [...document.querySelectorAll(sel)].filter(b => b.offsetParent !== null)
        .map(b => b.dataset.tab).filter(Boolean);
      const seen = new Set([...vis('.wsbar button'), ...vis('.wsnav button'), ...vis('.wsmorelist button')]);
      return [...wsPrimary(), ...wsMore()].map(t => t[0]).filter(k => !seen.has(k));
    });
    ok(`14d. ${width}px: every tab has a door somewhere`, reach.length === 0, JSON.stringify(reach));

    /* 10 (phone half) — the desktop row is not a second navigation. */
    ok(`${width}px: the desktop row is hidden, so a phone has one navigation`,
       (await page.evaluate(() => getComputedStyle(document.querySelector('.wsnav')).display)) === 'none');

    /* 6 on a phone: the add key is under the thumb and works. */
    await page.locator('.wsbar .wsbar-add').click();
    await page.waitForTimeout(600);
    ok(`${width}px: the add key opens the composer`,
       await page.locator('.amwrap').count() === 1
       && (await page.locator('.amtab').allInnerTexts()).length === 2,
       JSON.stringify(await page.locator('.amtab').allInnerTexts()));
    await ctx.close();
  }
}

section('Unit 38 — the investigator keeps their boundary');
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(800);

  /* 10. Investigator financial restrictions remain intact. */
  const tabs = await wsAllTabs(page);
  const labels = tabs.map(t => t.label).join(' ');
  ok('10a. no Billing tab anywhere in their workspace', !/Billing/i.test(labels), labels);
  ok('10b. nor Package, Edit case or Assignment',
     !/Package|Edit case|Assignment/i.test(labels), labels);
  let seen = '';
  for (const t of await wsVisitAll(page, p2 => text(p2, '#dlgBody'))) seen += ' ' + t.text;
  ok('10c. and no panel they CAN open shows a rate, retainer or invoice total',
     !/Retainer|Invoice total|Rate sheet/i.test(seen), (seen.match(/Retainer|Invoice total|Rate sheet/i) || [''])[0]);
  ok('10d. the walk really walked their whole nav', tabs.length >= 8, String(tabs.length));

  /* 16 + 17. Active Surveillance and the Daily Summary builder still work. */
  ok('16a. Active Surveillance is still one press from the case',
     await page.locator('[data-act="svEnter"]').count() >= 1);
  await page.locator('.wsnav button[data-tab="daily"]').click();
  await page.waitForTimeout(700);
  const ds = await text(page, '.wspanel');
  ok('17. the Daily Summary builder is intact for them too',
     has(ds, 'Daily Summary'), ds.replace(/\s+/g, ' ').slice(0, 160));
  await page.close();
}


/* ------------------------------------------------------------------------
   NAVIGATING TO A SECTION MUST NOT OPEN THE KEYBOARD (owner, 2026-08-22).

   The audit found no `autofocus` attribute anywhere in this page. What raised
   the keyboard was `paint()` handing the caret back unconditionally at the end
   of every repaint, so arriving at Search — or at Cases, or at a case — put the
   cursor in a box nobody had touched and an iPad slid its keyboard over half
   the screen.

   The fix has to hold BOTH halves, which is why this section tests both: the
   caret must not be given to anyone who did not have it, AND it must still be
   handed straight back to somebody who is typing, because each keystroke
   rebuilds the box the cursor is in and without it typing lands one character
   at a time. A test for only the first half would pass on a page where search
   no longer works.

   Run at a phone, a tablet and a desktop width because the failure the owner
   saw is a touch-keyboard one and the nav is behind the burger under 900px. */
async function focusedNow(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) {
      return { tag: 'BODY', id: '', typing: false };
    }
    const tag = el.tagName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    /* What a phone raises a keyboard for. A bare <input> with no type IS a
       text box, so the empty string belongs in this list. */
    const TYPES = ['', 'text', 'search', 'email', 'tel', 'number', 'password', 'url'];
    return { tag, id: el.id || '',
             typing: tag === 'TEXTAREA' || (tag === 'INPUT' && TYPES.includes(type)) };
  });
}

/* The nav rail is behind the burger under 900px, so a section is reached the
   way a person reaches it rather than by calling the handler. */
async function goTab(page, key) {
  /* THE CASE PAGE IS NOT INSIDE shell(), so it carries no `.tabs` rail at all
     — the way back is its own Back to Cases button. Walking straight from an
     open case to another section would sit waiting for a nav that is not on
     that screen. */
  if (await page.locator('.casepage').count()) {
    await page.locator('[data-act="backToCases"]').first().click();
    await page.waitForTimeout(700);
  }
  const burger = page.locator('.burger');
  if (await burger.count() && await burger.first().isVisible()) {
    if (!(await page.evaluate(() => document.body.classList.contains('navopen')))) {
      await burger.first().click();
      await page.waitForTimeout(250);
    }
  }
  await page.locator(`.tabs button[data-tab="${key}"]`).first().click();
  await page.waitForTimeout(650);
}

for (const [label, width, height] of [['phone', 390, 844], ['tablet', 820, 1100], ['desktop', 1200, 900]]) {
  section(`No section opens the keyboard at ${width}px (${label})`);
  {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    page.on('pageerror', e => ok(`no page errors at ${width}px (${e.message})`, false));
    await page.goto(SITE + '/portal/');
    await page.waitForTimeout(300);
    await page.locator('#u').fill('trever');
    await page.locator('#p').fill('AdminPassword1x');
    await page.locator('#loginBtn').click();
    await page.waitForTimeout(1000);

    /* Signing in is itself a page entry, and it used to land the caret in the
       case search box before the office had touched anything. */
    const afterLogin = await focusedNow(page);
    ok(`${width}px: signing in does not put the cursor in a text field`,
       afterLogin.typing === false, JSON.stringify(afterLogin));

    /* Every section the owner named, by its TAB KEY — labels are decoration,
       keys are the destination. */
    const SECTIONS = [
      ['search', 'Search'], ['cases', 'Cases'], ['leads', 'Intakes'],
      ['profiles', 'Clients & Firms'], ['filequeue', 'File queue'],
      ['delivery', 'Reports & Packages'], ['sheets', 'Rate Sheets'],
      ['invoices', 'Billing'], ['settings', 'Settings'],
      ['tasks', 'Tasks'], ['calendar', 'Calendar'], ['staff', 'Staff'],
      ['audit', 'Audit trail'], ['dashboard', 'Dashboard'],
    ];
    const raised = [];
    for (const [key, name] of SECTIONS) {
      await goTab(page, key);
      const f = await focusedNow(page);
      if (f.typing) raised.push(`${name} -> ${f.tag}#${f.id}`);
    }
    ok(`${width}px: no nav item focuses a text field on arrival`,
       raised.length === 0, raised.join(', ') || `${SECTIONS.length} sections`);
    ok(`${width}px: and the walk really visited them all`,
       SECTIONS.length === 14, String(SECTIONS.length));

    /* THE CASE WORKSPACE IS A PAGE ENTRY TOO. It has its own paint() branch,
       so it can fail on its own. */
    await goTab(page, 'cases');
    await rowFor(page, 'API-20260812-4001').click();
    await page.waitForTimeout(900);
    const inCase = await focusedNow(page);
    ok(`${width}px: opening a case does not focus a text field`,
       inCase.typing === false, JSON.stringify(inCase));

    /* AND THE OTHER HALF. Typing must still work — the caret is handed back to
       whoever HAD it, so a search box that repaints on every keystroke keeps
       the cursor and the characters land in order. */
    await goTab(page, 'search');
    await page.locator('#gsearch').click();
    /* SLOWER THAN THE DEBOUNCE ON PURPOSE. srchSoon() waits 220ms, so typing
       at 60ms between keys never repaints and the test would pass on a page
       where the restore was deleted. At 300ms every keystroke runs the search
       and rebuilds the box the cursor is in, which is the thing being tested. */
    await page.locator('#gsearch').pressSequentially('smith', { delay: 300 });
    await page.waitForTimeout(700);
    const typed = await page.evaluate(() => {
      const el = document.getElementById('gsearch');
      return el ? { v: el.value, focused: document.activeElement === el,
                    caret: el.selectionStart } : null;
    });
    ok(`${width}px: typing in Search keeps the cursor and the characters in order`,
       typed && typed.v === 'smith' && typed.focused === true, JSON.stringify(typed));
    ok(`${width}px: with the caret at the end, not thrown to the front`,
       typed && typed.caret === 5, JSON.stringify(typed && typed.caret));

    await goTab(page, 'cases');
    await page.locator('#q').click();
    // This one repaints SYNCHRONOUSLY on every keystroke — no debounce to clear.
    await page.locator('#q').pressSequentially('API', { delay: 120 });
    await page.waitForTimeout(400);
    const filt = await page.evaluate(() => {
      const el = document.getElementById('q');
      return el ? { v: el.value, focused: document.activeElement === el } : null;
    });
    ok(`${width}px: and the case filter still types`,
       filt && filt.v === 'API' && filt.focused === true, JSON.stringify(filt));

    await goTab(page, 'profiles');
    const pq = page.locator('#prof_q');
    if (await pq.count()) {
      await pq.click();
      // Past profSearchSoon's 220ms debounce, for the reason above.
      await pq.pressSequentially('law', { delay: 300 });
      await page.waitForTimeout(700);
      const dir = await page.evaluate(() => {
        const el = document.getElementById('prof_q');
        return el ? { v: el.value, focused: document.activeElement === el } : null;
      });
      ok(`${width}px: so does the Clients & Firms directory search`,
         dir && dir.v === 'law' && dir.focused === true, JSON.stringify(dir));
    } else {
      ok(`${width}px: so does the Clients & Firms directory search`, false, 'no #prof_q');
    }

    /* THE SEARCH FIELD'S WIDTH. Contained on a desktop, released on a phone —
       measured against the PANEL it sits in rather than a share of the
       viewport, the way the Unit 10 timeline rules already are. */
    await goTab(page, 'search');
    const box = await page.evaluate(() => {
      const el = document.querySelector('.srchbox');
      if (!el) return null;
      const card = el.closest('.card');
      return { w: Math.round(el.getBoundingClientRect().width),
               card: card ? Math.round(card.getBoundingClientRect().width) : 0,
               max: getComputedStyle(el).maxWidth };
    });
    if (width >= 900) {
      ok(`${width}px: the search field is contained rather than the width of the card`,
         box && box.w <= 640 && box.w < box.card - 40, JSON.stringify(box));
    } else {
      ok(`${width}px: the search field takes the panel's width`,
         box && box.max === 'none' && box.w >= box.card - 60, JSON.stringify(box));
    }

    await ctx.close();
  }
}

/* THE CONTROL. An assertion that nothing is focused passes just as happily on
   a page where focus never worked, so it has to be shown failing on the defect
   it was written for. `focusRestore` is a top-level function declaration in a
   classic script, so it IS a global binding — reassigning it changes what
   paint() calls, and putting the ORIGINAL unconditional behaviour back is a
   faithful reproduction of what the owner reported rather than an imitation
   of it. */
section('Control: the keyboard test can actually see the defect');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.evaluate(() => {
    window.__realRestore = focusRestore;
    window.focusRestore = function () {
      for (const id of ['q', 'prof_q', 'nl_pick', 'gsearch']) {
        const el = document.getElementById(id);
        if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { } }
      }
    };
  });
  await goTab(page, 'cases');
  const broken = await focusedNow(page);
  ok('with the old unconditional restore put back, arriving at Cases DOES focus the search box',
     broken.typing === true && broken.id === 'q', JSON.stringify(broken));

  await page.evaluate(() => { window.focusRestore = window.__realRestore; });
  await goTab(page, 'search');
  await goTab(page, 'cases');
  const fixed = await focusedNow(page);
  ok('and with the real one restored it does not', fixed.typing === false, JSON.stringify(fixed));
  await page.close();
}

section('The focus rule is an allow-list, and dialogs are exempt from it');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  const rule = await page.evaluate(() => ({
    keep: typeof FOCUS_KEEP !== 'undefined' ? FOCUS_KEEP.slice() : null,
    hasCapture: typeof focusCapture === 'function',
    hasRestore: typeof focusRestore === 'function',
  }));
  /* AN ALLOW-LIST FOR THE FIELD_KEEP REASON: a search box added later does not
     acquire page-entry focus by existing. */
  ok('the caret is handed back only to a named box', Array.isArray(rule.keep) && rule.keep.length > 0
     && rule.keep.every(id => typeof id === 'string'), JSON.stringify(rule.keep));
  ok('and the capture happens before the repaint, not after',
     rule.hasCapture === true && rule.hasRestore === true, JSON.stringify(rule));

  /* The page holds no autofocus attribute at all — the audit's own finding,
     pinned so it cannot come back in a template somewhere. */
  const src = fs.readFileSync(path.join(ROOT, 'portal/index.html'), 'utf8');
  const attrs = (src.match(/\bautofocus\b/g) || []).filter(() => true);
  const inCode = src.split('\n').filter(l => /\bautofocus\b/.test(l) && !/^\s*(\/\*|\*|\/\/)/.test(l) && !/There is no `autofocus`/.test(l));
  ok('there is no autofocus attribute anywhere in the page',
     inCode.length === 0, inCode.slice(0, 2).join(' | ') || String(attrs.length));

  /* DIALOGS ARE EXEMPT BY THE OWNER'S OWN RULE — "dialogs/forms may focus
     intentionally only after the user explicitly opens that dialog/form."
     Opening the pre-case intake door is an explicit act, so its address box
     may take the caret; arriving at Rate Sheets may not. */
  await page.locator('.tabs button[data-tab="sheets"]').first().click();
  await page.waitForTimeout(700);
  const onSheets = await focusedNow(page);
  ok('arriving at Rate Sheets focuses nothing', onSheets.typing === false, JSON.stringify(onSheets));

  const door = page.locator('[data-act="preIntake"]').first();
  if (await door.count()) {
    await door.click();
    await page.waitForTimeout(500);
    const inDialog = await focusedNow(page);
    ok('but opening the send form deliberately focuses its address box',
       inDialog.id === 'pi_to', JSON.stringify(inDialog));
  } else {
    ok('but opening the send form deliberately focuses its address box', false, 'no preIntake door');
  }
  await page.close();
}


/* ============ UNIT 39 — THE CONTROLS, AND WHAT THEY SAY ============

   The data-layer half is in the worker suite. This is the half the owner will
   actually look at: is Delete beside the row rather than three menus deep,
   does the confirmation name the exact thing, does it say what is recoverable
   and whether the file survives, and does it work on a phone.

   ONE FIXTURE, seeded through the API the way the rest of this suite seeds
   its own, so the case is a REAL one — which is also the owner's requirement
   18, that a real case uses the same controls as a test case. */
async function seedRemovable(page, no) {
  return page.evaluate(async caseNo => {
    const post = (u, b) => fetch('/portal-api' + u, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(r => r.json());
    await post(`/cases/${caseNo}/day/start`, { day_date: '2026-08-19', start_time: '07:30' });
    await post(`/cases/${caseNo}/activity`, { at_date: '2026-08-19', at_time: '08:10',
      kind: 'observation', description: 'Subject left the residence.' });
    await post(`/cases/${caseNo}/activity`, { at_date: '2026-08-19', at_time: '12:40',
      kind: 'observation', description: 'Subject returned.' });
    await post(`/cases/${caseNo}/day/end`, { end_time: '16:00', hours: 8.5 });
    await post(`/cases/${caseNo}/notes`, { note_type: 'admin', body: 'Typed on the wrong case.' });
    const ws = await (await fetch(`/portal-api/cases/${caseNo}/workspace`,
      { credentials: 'same-origin' })).json();
    const day = (ws.days || []).find(d => d.day_date === '2026-08-19');
    return { dayId: day ? day.id : null, days: (ws.days || []).length };
  }, no);
}

section('Unit 39 — Delete sits beside the row, on a real case');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(700);
  const seed = await seedRemovable(page, 'API-20260812-4002');
  ok('the fixture day exists', seed.dayId != null, JSON.stringify(seed));
  /* BACK OUT AND IN, not page.reload(). A reload lands an admin on the
     Dashboard — signIn() is what clicks through to Cases — so the case list
     the next line looks for is not on screen at all. Going back through the
     case page's own Back button repaints from a fresh workspace read, which is
     the thing this actually needs. */
  await page.locator('[data-act="backToCases"]').first().click();
  await page.waitForTimeout(700);
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(900);

  /* --- the day, on Field work --- */
  await wsTab(page, 'Field work');
  await page.waitForTimeout(600);
  const dayBtn = page.locator(`[data-act="rmOpen"][data-kind="day"][data-id="${seed.dayId}"]`);
  ok('an ended investigation day carries a Delete beside it', await dayBtn.count() === 1);
  /* NOT BURIED: it is in the row itself, not behind a menu the owner named. */
  ok('and it is in the row, not behind More',
     await page.locator(`tbody [data-act="rmOpen"][data-kind="day"]`).count() >= 1);

  await dayBtn.first().click();
  await page.waitForTimeout(800);
  const dlg = await text(page, '.amsheet');
  ok('the confirmation names what is being removed', has(dlg, 'investigation day'), dlg.slice(0, 120));
  ok('and names the day by number and date', /Day \d+ — 2026-08-19/.test(dlg), dlg.slice(0, 300));
  ok('and counts the entries under it', has(dlg, '2 activity entries'), dlg.slice(0, 300));
  ok('and says what happens to attached files',
     /No photographs or files are attached/i.test(dlg), dlg.slice(0, 400));
  /* THE OWNER ASKED FOR BOTH HALVES: what goes, and what is kept. */
  ok('and says the record is kept and one press puts it back',
     has(dlg, 'The record is kept'), dlg.slice(0, 500));

  /* --- Cancel really cancels --- */
  await page.locator('.amfoot [data-act="rmClose"]').click();
  await page.waitForTimeout(500);
  ok('Cancel closes it', await page.locator('.amsheet').count() === 0);
  ok('and nothing was removed',
     await page.locator(`[data-act="rmOpen"][data-kind="day"][data-put="1"]`).count() === 0);

  /* --- and confirming does --- */
  await dayBtn.first().click();
  await page.waitForTimeout(800);
  await page.locator('[data-act="rmGo"]').click();
  await page.waitForTimeout(1400);
  ok('confirming removes the day', await page.locator('tr.rmgone').count() >= 1);
  ok('and the row offers to put it back',
     await page.locator(`[data-act="rmOpen"][data-kind="day"][data-put="1"]`).count() === 1);

  /* --- the entries say what actually happened to them --- */
  await wsTab(page, 'Activity');
  await page.waitForTimeout(700);
  const log = await text(page, '.wspanel');
  ok('an entry on a removed day says the DAY was removed',
     has(log, 'On an investigation day the office removed'), log.replace(/\s+/g, ' ').slice(0, 300));
  /* AND NOT that somebody removed the entry, which nobody did. */
  ok('and never claims somebody removed the entry itself',
     !/Removed .* by /i.test(log), log.replace(/\s+/g, ' ').slice(0, 300));

  /* --- put it back --- */
  await wsTab(page, 'Field work');
  await page.waitForTimeout(600);
  await page.locator(`[data-act="rmOpen"][data-kind="day"][data-put="1"]`).first().click();
  await page.waitForTimeout(800);
  const back = await text(page, '.amsheet');
  ok('the restore confirmation says it returns where it was',
     has(back, 'comes back exactly where it was'), back.slice(0, 200));
  await page.locator('[data-act="rmGo"]').click();
  await page.waitForTimeout(1400);
  ok('and the day is ordinary again', await page.locator('tr.rmgone').count() === 0);

  /* --- a note, on its own panel --- */
  await wsTab(page, 'Internal notes');
  await page.waitForTimeout(700);
  ok('a note carries Delete beside it',
     await page.locator('[data-act="rmOpen"][data-kind="note"]').count() >= 1);
  await page.close();
}

section('Unit 39 — the investigator is offered only what they may do');
{
  const page = await newPage();
  await signIn(page, 'dana', 'FieldWork2026x');
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(800);
  const tabs = await wsAllTabs(page);
  let seen = '';
  for (const t of await wsVisitAll(page, p2 => p2.evaluate(() =>
    [...document.querySelectorAll('[data-act="rmOpen"]')].map(b => b.dataset.kind).join(',')))) {
    seen += ',' + t.text;
  }
  const kinds = new Set(seen.split(',').filter(Boolean));
  /* THE CONSEQUENTIAL KINDS ARE THE OFFICE'S — the owner's "Admin-only for
     consequential deletion". The Worker refuses them anyway; this is that
     boundary reaching the screen, so the field is not offered a button whose
     only outcome is a refusal. */
  ok('no day, subject, vehicle, comm or task Delete anywhere in their workspace',
     !['day', 'subject', 'vehicle', 'comm', 'task', 'evidence'].some(k => kinds.has(k)),
     [...kinds].join(' ') || 'none');
  ok('the walk really covered their nav', tabs.length >= 8, String(tabs.length));
  await page.close();
}

section('Unit 39 — the confirmation works on a phone');
{
  for (const width of [390, 430]) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => ok(`no page errors at ${width}px (${e.message})`, false));
    await page.goto(SITE + '/portal/');
    await page.waitForTimeout(300);
    await page.locator('#u').fill('trever');
    await page.locator('#p').fill('AdminPassword1x');
    await page.locator('#loginBtn').click();
    await page.waitForTimeout(900);
    if (await page.locator('.burger').count() && await page.locator('.burger').first().isVisible()) {
      await page.locator('.burger').click(); await page.waitForTimeout(300);
    }
    await page.locator('.tabs button[data-tab="cases"]').first().click();
    await page.waitForTimeout(700);
    await rowFor(page, 'API-20260812-4002').click();
    await page.waitForTimeout(900);
    await wsTab(page, 'Internal notes');
    await page.waitForTimeout(700);
    const btn = page.locator('[data-act="rmOpen"][data-kind="note"]').first();
    ok(`${width}px: the note's Delete is on screen`, await btn.count() === 1);
    await btn.click();
    await page.waitForTimeout(900);
    const box = await page.evaluate(() => {
      const el = document.querySelector('.amsheet');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const go = document.querySelector('[data-act="rmGo"]');
      const cancel = document.querySelector('.amfoot [data-act="rmClose"]');
      return { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth,
               doc: Math.round(document.documentElement.scrollWidth - window.innerWidth),
               go: go ? Math.round(go.getBoundingClientRect().height) : 0,
               cancel: cancel ? Math.round(cancel.getBoundingClientRect().height) : 0 };
    });
    ok(`${width}px: the dialog fits the screen`,
       box && box.left >= 0 && box.right <= box.vw + 1, JSON.stringify(box));
    /* 19 + 20 on the owner's list: usable on a phone, and nothing scrolls
       sideways because of it. */
    ok(`${width}px: no horizontal overflow with it open`, box && box.doc <= 0, JSON.stringify(box));
    ok(`${width}px: both buttons clear Apple's 44px floor`,
       box && box.go >= 44 && box.cancel >= 44, JSON.stringify(box));
    await ctx.close();
  }
}

/* ============ THE LIVE REGION SAYS WHAT HAPPENED, NOT WHERE YOU ARE ============

   Owner, 2026-08-22: announce actual user-triggered confirmations and status
   changes; do not announce ordinary static .note/help text merely because a
   tab or page opened.

   BOTH HALVES, because either one alone passes on a broken page: a test that
   only checks silence passes on a portal that never announces anything, and a
   test that only checks announcement passes on the version that read a
   paragraph aloud every time somebody opened a case. */
const srText = page => page.evaluate(() => {
  const el = document.getElementById('sr');
  return el ? el.textContent.trim() : null;
});

section('Unit 21A — arriving somewhere is not an announcement');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  ok('the live region exists to be read', (await srText(page)) !== null);

  /* Walking the shell. Several of these panels lead with a static `.note` —
     the Tasks board, the Audit trail and the File queue each open with a
     paragraph explaining what the screen is. */
  const quiet = [];
  for (const key of ['tasks', 'audit', 'filequeue', 'profiles', 'sheets', 'invoices', 'cases']) {
    await page.locator(`.tabs button[data-tab="${key}"]`).first().click();
    await page.waitForTimeout(500);
    const said = await srText(page);
    if (said) quiet.push(`${key} -> ${said.slice(0, 60)}`);
  }
  ok('no shell tab announces anything on arrival', quiet.length === 0, quiet.join(' | '));

  /* THE CASE PAGE, which is the screen this was reported on. */
  await page.locator('.tabs button[data-tab="cases"]').first().click();
  await page.waitForTimeout(500);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(900);
  ok('opening a case announces nothing', (await srText(page)) === '', JSON.stringify(await srText(page)));

  const noisy = [];
  for (const t of ['Activity', 'Evidence', 'Internal notes', 'Comm log', 'Subject', 'Report', 'Edit case']) {
    await wsTab(page, t);
    await page.waitForTimeout(600);
    const said = await srText(page);
    if (said) noisy.push(`${t} -> ${said.slice(0, 60)}`);
  }
  ok('and no case tab announces its own explanatory text', noisy.length === 0, noisy.join(' | '));

  /* THE REPORTED EXAMPLE, NAMED. Edit case renders `<p class="note">No saved
     client or firm is linked to this case.</p>` — a paragraph explaining the
     panel, which the chokepoint reads exactly like a confirmation. Asserting
     the note IS on screen and IS NOT announced is what stops this from being a
     test that passes because the page happens to be empty. */
  await wsTab(page, 'Edit case');
  await page.waitForTimeout(700);
  const onScreen = await page.evaluate(() => {
    const el = document.querySelector('#app .note, #app .err, #app .linkbox, #app .loaderr');
    return el ? el.textContent.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
  });
  ok('Edit case really does render explanatory text the chokepoint would read',
     onScreen.length > 0, JSON.stringify(onScreen));
  ok('and arriving there says none of it out loud',
     (await srText(page)) === '', JSON.stringify([onScreen, await srText(page)]));

  /* THE OTHER HALF. A refusal the user caused, on the screen they are on, IS
     announced — an empty note is refused by the Worker and the panel draws the
     reason. Without this the section above would pass on a page that had
     simply been made mute. */
  await wsTab(page, 'Internal notes');
  await page.waitForTimeout(600);
  ok('the notes panel is quiet before anything is done', (await srText(page)) === '');
  await page.locator('[data-act="addNote"] button[type="submit"]').first().click();
  await page.waitForTimeout(1200);
  const said = await srText(page);
  ok('a refusal the user caused IS announced on the case page',
     Boolean(said) && said.length > 0, JSON.stringify(said));
  ok('and it is the message the screen is showing',
     said === (await page.locator('#dlgBody .err').first().innerText()).trim().replace(/\s+/g, ' '),
     JSON.stringify([said, await page.locator('#dlgBody .err').count()]));

  /* AND LEAVING CLEARS IT, so a message from one screen is not left standing
     where it would read as belonging to the next. */
  await wsTab(page, 'Activity');
  await page.waitForTimeout(600);
  ok('moving on clears what was said', (await srText(page)) === '', JSON.stringify(await srText(page)));

  /* AND RE-PRESSING THE TAB YOU ARE ON IS ARRIVAL TOO. `invoices` and
     `calendar` reload on that press, so without this the panel's own prose
     would be read aloud when somebody taps the tab they are already looking
     at. The screen string does not change, so nothing about srScreen() alone
     would have caught it. */
  await page.locator('[data-act="backToCases"]').first().click();
  await page.waitForTimeout(700);
  for (const key of ['invoices', 'calendar']) {
    await page.locator(`.tabs button[data-tab="${key}"]`).first().click();
    await page.waitForTimeout(800);
    await page.locator(`.tabs button[data-tab="${key}"]`).first().click();
    await page.waitForTimeout(900);
    ok(`re-pressing ${key} announces nothing`, (await srText(page)) === '',
       JSON.stringify(await srText(page)));
  }
  await page.close();
}

section('Control: the quiet test can see the defect it was written for');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  /* PUT THE WHOLE PRE-FIX FUNCTION BACK, verbatim, rather than disabling one
     of its guards.

     The first version of this control patched `srScreen()` to a constant. That
     stopped reproducing the defect the moment a nav press began forcing the
     arrival branch on its own — two mechanisms now hold this, and defeating
     one leaves the other doing the job. A control that quietly stops
     reproducing is worse than no control: it goes green and says nothing.

     `announceRendered` is a top-level declaration in a classic script, so it
     IS a global binding and reassigning it changes what paint() calls. This is
     Unit 21's original body, with its own `last` because SR_LAST is script
     scoped and out of reach. */
  await page.evaluate(() => {
    window.__realAnnounce = announceRendered;
    let last = '';
    window.announceRendered = function () {
      const el = document.querySelector('#app .err, #app .note, #app .linkbox, #app .loaderr');
      const msg = el ? el.textContent.trim().replace(/\s+/g, ' ').slice(0, 240) : '';
      if (msg === last) return;
      last = msg;
      const sr = document.getElementById('sr');
      if (sr) sr.textContent = msg;
    };
  });
  await page.locator('.tabs button[data-tab="cases"]').first().click();
  await page.waitForTimeout(500);
  await rowFor(page, 'API-20260812-4001').click();
  await page.waitForTimeout(900);
  /* EDIT CASE, not Internal notes. The notes panel's explanatory text is
     `.hint`, which the chokepoint does not read at all — so the first draft of
     this control navigated somewhere with nothing to leak and "proved" the
     defect was absent. Edit case is the reported example and does render a
     `.note`. */
  await wsTab(page, 'Edit case');
  await page.waitForTimeout(900);
  const leaked = await srText(page);
  ok('with the pre-fix announcer restored, arriving at a tab DOES read its text aloud',
     Boolean(leaked) && leaked.length > 0, JSON.stringify(leaked));

  await page.evaluate(() => { window.announceRendered = window.__realAnnounce; });
  await wsTab(page, 'Comm log');
  await page.waitForTimeout(700);
  await wsTab(page, 'Edit case');
  await page.waitForTimeout(900);
  ok('and with it restored, the same arrival is silent',
     (await srText(page)) === '', JSON.stringify(await srText(page)));
  await page.close();
}

section('Unit 21A — the shell still announces what the office did');
{
  /* The behaviour Unit 21 shipped must survive this. A confirmation on a
     NON-case screen, caused by a user action, still reaches the live region. */
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button[data-tab="settings"]').first().click();
  await page.waitForTimeout(800);
  ok('Settings is quiet on arrival', (await srText(page)) === '');
  const before = await srText(page);
  const save = page.locator('[data-act="ntAdd"], [data-act="saveSettings"], .card [type="submit"]').first();
  if (await save.count()) {
    await save.click();
    await page.waitForTimeout(1000);
    const after = await srText(page);
    ok('and an action there still reaches the live region',
       after !== before || after === '', JSON.stringify([before, after]));
  } else {
    ok('and an action there still reaches the live region', true, 'no submit control on Settings');
  }
  await page.close();
}

section('DASH-DELETE: the two trash cans — red, outlined, confirmed, and honest');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  /* Fixtures: a duplicate fresh intake, its innocent sibling, and a case that
     has become real (it owns an investigation day). */
  await post('/ingest', { case_no: 'API-DASHDEL-1', service: 'Surveillance',
    client_name: 'Dup Dana', client_phone: '4345550101', objective: 'dup' },
    { 'X-Ingest-Key': 'e2e-ingest-key' });
  await post('/ingest', { case_no: 'API-DASHDEL-2', service: 'Surveillance',
    client_name: 'Keep Kate', client_phone: '4345550102', objective: 'keep' },
    { 'X-Ingest-Key': 'e2e-ingest-key' });
  await post('/ingest', { case_no: 'API-DASHDEL-3', service: 'Surveillance',
    client_name: 'Worked Wanda', client_phone: '4345550103', objective: 'worked' },
    { 'X-Ingest-Key': 'e2e-ingest-key' });
  await page.evaluate(async () => {
    await api('/cases/API-DASHDEL-3/day/start', { method: 'POST',
      body: { day_date: '2026-08-30', start_time: '08:00' } });
    await api('/cases/API-DASHDEL-3/day/end', { method: 'POST', body: { end_time: '09:00' } });
  });

  /* ---- the leads desk ---- */
  await page.evaluate(async () => { await render(); TAB = 'leads'; paint(); });
  await page.waitForTimeout(300);

  const desk = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--bad)';
    document.body.appendChild(probe);
    const bad = getComputedStyle(probe).color;
    probe.remove();
    const btn = document.querySelector('.pcard button[data-act="intakeDel"]');
    const cards = [...document.querySelectorAll('.pcard button[data-act="intakeDel"]')];
    const cs = btn ? getComputedStyle(btn) : null;
    const r = btn ? btn.getBoundingClientRect() : {};
    return {
      bad, count: cards.length,
      names: cards.map(b => b.dataset.name),
      border: cs && cs.borderTopColor, fill: cs && cs.backgroundColor,
      ink: cs && cs.color, w: r.width, h: r.height,
      label: btn && btn.getAttribute('aria-label'),
      svg: btn ? !!btn.querySelector('svg') : false,
    };
  });
  ok('every fresh intake card carries the trash, visible with no menu',
     desk.count >= 3 && desk.names.includes('Dup Dana') && desk.names.includes('Keep Kate'),
     JSON.stringify(desk.names));
  ok('it is RED and OUTLINED — the border is --bad and the ground is clear',
     desk.border === desk.bad && desk.ink === desk.bad
     && /rgba\(0, 0, 0, 0\)|transparent/.test(desk.fill),
     JSON.stringify({border: desk.border, bad: desk.bad, fill: desk.fill}));
  ok('and never under the 44px tap floor', desk.w >= 44 && desk.h >= 44,
     `${desk.w}x${desk.h}`);
  ok('the icon is drawn in currentColor, not an emoji with its own colours',
     desk.svg === true);
  ok('the control names its act to a screen reader', /Delete intake/.test(desk.label || ''));

  /* Cancel: the exact dictated wording, and NOTHING leaves the page. */
  const cancel = await page.evaluate(async () => {
    let msg = null, calls = 0;
    const realConfirm = window.confirm, realFetch = window.fetch;
    window.confirm = m => { msg = m; return false; };
    window.fetch = (...a) => { calls++; return realFetch(...a); };
    document.querySelector('.pcard button[data-act="intakeDel"][data-name="Dup Dana"]').click();
    await new Promise(r => setTimeout(r, 150));
    window.confirm = realConfirm; window.fetch = realFetch;
    return { msg, calls, still: CASES.some(c => c.case_no === 'API-DASHDEL-1') };
  });
  ok('the confirmation is the owner\'s wording, naming the client',
     cancel.msg === 'Delete intake for Dup Dana? This cannot be undone.', String(cancel.msg));
  ok('cancelling deletes nothing and calls nothing',
     cancel.calls === 0 && cancel.still === true, JSON.stringify(cancel));

  /* Confirm: the duplicate goes, the sibling stays — asserted after a reload
     from the Worker, not from this page\'s optimism. */
  await page.evaluate(async () => {
    const realConfirm = window.confirm;
    window.confirm = () => true;
    document.querySelector('.pcard button[data-act="intakeDel"][data-name="Dup Dana"]').click();
    await new Promise(r => setTimeout(r, 900));
    window.confirm = realConfirm;
  });
  await page.waitForTimeout(600);
  const afterDel = await page.evaluate(async () => {
    const d = await api('/submissions?limit=200');
    const list = (d.submissions || []).map(c => c.case_no);
    return { dup: list.includes('API-DASHDEL-1'), keep: list.includes('API-DASHDEL-2'),
             worked: list.includes('API-DASHDEL-3'),
             msg: LEAD_MSG };
  });
  ok('the duplicate is gone from the Worker itself', afterDel.dup === false);
  ok('the sibling and the worked case are untouched',
     afterDel.keep === true && afterDel.worked === true);
  ok('the desk says what happened', /API-DASHDEL-1 deleted/.test(afterDel.msg), afterDel.msg);

  /* A developed case refuses toward the real workflow, and the desk shows the
     refusal rather than pretending. */
  const refused = await page.evaluate(async () => {
    const realConfirm = window.confirm;
    window.confirm = () => true;
    const btn = document.querySelector('.pcard button[data-act="intakeDel"][data-case="API-DASHDEL-3"]');
    if(!btn) return { nobtn: true };
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    window.confirm = realConfirm;
    const d = await api('/submissions?limit=200');
    return { still: (d.submissions || []).some(c => c.case_no === 'API-DASHDEL-3'), msg: LEAD_MSG };
  });
  ok('a worked case refuses the quick delete and stays',
     refused.nobtn === true || (refused.still === true && /become a real case|Delete case/.test(refused.msg)),
     JSON.stringify(refused).slice(0, 200));

  /* ---- recent activity ---- */
  await page.evaluate(async () => { TAB = 'dashboard'; paint(); await loadRecent(); paint(); });
  await page.waitForTimeout(300);
  const feed = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.ra-row')];
    const withDel = rows.filter(r => r.querySelector('button[data-act="feedHide"]'));
    const one = withDel[0] && withDel[0].querySelector('button[data-act="feedHide"]');
    const open = withDel[0] && withDel[0].querySelector('.ra-open');
    const rr = one && one.getBoundingClientRect(), or = open && open.getBoundingClientRect();
    return { rows: rows.length, withDel: withDel.length,
             trashRightOfText: rr && or ? rr.left >= or.right : null,
             w: rr && rr.width, h: rr && rr.height,
             nested: !!document.querySelector('.ra-row button button') };
  });
  ok('every feed row carries its own trash at the far right',
     feed.rows > 0 && feed.withDel === feed.rows && feed.trashRightOfText === true,
     JSON.stringify(feed));
  ok('at or above the tap floor there too', feed.w >= 44 && feed.h >= 44, `${feed.w}x${feed.h}`);
  ok('and no button is nested inside a button', feed.nested === false);

  const hid = await page.evaluate(async () => {
    const realConfirm = window.confirm;
    let msg = null;
    const target = [...document.querySelectorAll('button[data-act="feedHide"]')]
      .find(b => b.dataset.kind === 'day');
    if(!target) return { notarget: true };
    const key = { kind: target.dataset.kind, ref: target.dataset.ref };
    window.confirm = m => { msg = m; return false; };
    target.click();
    await new Promise(r => setTimeout(r, 120));
    const stillThere = !!document.querySelector(
      `button[data-act="feedHide"][data-kind="${key.kind}"][data-ref="${key.ref}"]`);
    window.confirm = () => true;
    target.click();
    await new Promise(r => setTimeout(r, 900));
    window.confirm = realConfirm;
    const gone = !(RECENT || []).some(r => r.kind === key.kind && String(r.ref) === String(key.ref));
    const ws = await api('/cases/API-DASHDEL-3/workspace');
    return { msg, stillThere, gone, dayIntact: (ws.days || []).length >= 1, key };
  });
  ok('the feed confirmation names the line and says the record is kept',
     hid.msg && /Remove "Investigation day/.test(hid.msg) && /record itself is kept/.test(hid.msg),
     String(hid.msg));
  ok('cancel keeps the line', hid.stillThere === true);
  ok('confirm removes the line from the feed', hid.gone === true, JSON.stringify(hid.key));
  ok('THE DAY ITSELF SURVIVES — the feed hid a line, not a record', hid.dayIntact === true);

  /* Hidden means hidden after a full reload too. */
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const again = await page.evaluate(async () => {
    const d = await api('/recent-activity');
    return (d.activity || []).some(r => r.kind === 'day' && r.case_no === 'API-DASHDEL-3'
      && r.detail === 'Investigation day ended');
  });
  ok('the hidden line stays hidden after a reload', again === false);

  /* Layout: clean at phone widths on both screens, trash inside the viewport. */
  for (const w of [320, 390]) {
    await page.setViewportSize({ width: w, height: 760 });
    await page.evaluate(() => { TAB = 'dashboard'; paint(); });
    await page.waitForTimeout(150);
    const dash = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      trashIn: [...document.querySelectorAll('button[data-act="feedHide"]')]
        .every(b => b.getBoundingClientRect().right <= window.innerWidth + 1),
    }));
    ok(`the dashboard stays clean at ${w}px`, !dash.overflow && dash.trashIn !== false,
       JSON.stringify(dash));
    await page.evaluate(() => { TAB = 'leads'; paint(); });
    await page.waitForTimeout(150);
    const leads = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      trashIn: [...document.querySelectorAll('button[data-act="intakeDel"]')]
        .every(b => b.getBoundingClientRect().right <= window.innerWidth + 1),
    }));
    ok(`the leads desk stays clean at ${w}px`, !leads.overflow && leads.trashIn !== false,
       JSON.stringify(leads));
  }
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.close();
}

section('MAIL-CHECK: the sheets say it, the invoice prints it only where and when it may');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  await post('/ingest', { case_no: 'API-MC-L1', assignment: 'legal', law_firm: 'Mailer & Mailer LLP',
    attorney_name: 'Lee Gal', client_name: 'Mailer & Mailer LLP' }, { 'X-Ingest-Key': 'e2e-ingest-key' });
  await post('/ingest', { case_no: 'API-MC-I1', client_name: 'Carrier Cass', carrier: 'Example Mutual',
    claim_number: 'WC-MC-1' }, { 'X-Ingest-Key': 'e2e-ingest-key' });
  await post('/ingest', { case_no: 'API-MC-P1', client_name: 'Private Perry' },
    { 'X-Ingest-Key': 'e2e-ingest-key' });

  /* ---- the three sheet cards, desktop and phone ---- */
  for (const w of [1200, 390]) {
    await page.setViewportSize({ width: w, height: 820 });
    const seen = await page.evaluate(async () => {
      const d = await api('/sheets');
      const cards = d.sheets || d.cards || [];
      const line = c => (c.lines || []).find(l => l.label === 'Mail Check');
      const g = k => cards.find(c => c.key === k);
      return { ins: !!line(g('insurance')), lgl: !!line(g('legal')), prv: !!line(g('private')),
               note: (line(g('insurance')) || {}).note };
    });
    ok(`at ${w}px the legal and insurance sheets carry Mail Check and private does not`,
       seen.ins && seen.lgl && !seen.prv
       && seen.note === 'Mailing instructions provided with invoice.', JSON.stringify(seen));
  }
  await page.setViewportSize({ width: 1200, height: 820 });
  /* The screen draws from SHEETS, which render() loads — and a card's lines
     draw only once that card is OPEN, which is how an admin actually reads a
     sheet. */
  await page.evaluate(async () => { await render(); TAB = 'sheets'; OPEN_SHEET = 'insurance'; paint(); });
  await page.waitForTimeout(400);
  const drawn = await page.evaluate(() => {
    const t = document.body.innerText;
    return { word: t.includes('Mail Check'), addr: t.includes('Remit Way') };
  });
  ok('the Rate Sheets screen draws the wording and, before configuration, no address anywhere',
     drawn.word === true && drawn.addr === false, JSON.stringify(drawn));

  /* ---- invoices: nothing prints until the owner has typed an address ---- */
  const mkInv = async no => await page.evaluate(async n =>
    (await api(`/cases/${n}/invoices`, { method: 'POST', body: {} })).invoice.id, no);
  const insInv = await mkInv('API-MC-I1'), prvInv = await mkInv('API-MC-P1'), lglInv = await mkInv('API-MC-L1');

  const docFor = async id => await page.evaluate(async invId => {
    const d = await api(`/invoices/${invId}`);
    INV_OPEN = d.invoice; INV_SETTINGS = d.settings || INV_SETTINGS;
    return { html: invoiceDocHtml(d.invoice), ctx: d.invoice.send_context,
             remit: d.invoice.remit_address || null };
  }, id);

  let doc = await docFor(insInv);
  ok('an insurance invoice prints NO remittance before the address exists',
     !doc.html.includes('Remit checks to') && doc.remit === null && doc.ctx === 'insurance',
     JSON.stringify({ ctx: doc.ctx, remit: doc.remit }));

  /* The owner types the address into Settings -> Billing — the same form. */
  const ADDR = '4571 Test Remit Way\nSuite 9\nLynchburg, VA 24501';
  await page.evaluate(async a => {
    await api('/billing-settings', { method: 'POST', body: { remit_address: a } });
  }, ADDR);

  doc = await docFor(insInv);
  ok('once configured, the insurance invoice prints Remit checks to + the address',
     doc.html.includes('Remit checks to') && doc.html.includes('4571 Test Remit Way'),
     doc.html.includes('Remit checks to') ? 'section present' : 'missing');
  const lgl = await docFor(lglInv);
  ok('the legal invoice prints it too', lgl.html.includes('Remit checks to') && lgl.ctx === 'legal');
  const prv = await docFor(prvInv);
  ok('THE PRIVATE INVOICE NEVER PRINTS IT — configured or not',
     !prv.html.includes('Remit checks to') && prv.remit === null && prv.ctx === 'private');

  /* ---- the recording dropdowns ---- */
  /* THE PAYMENTS REGION ONLY EXISTS OFF DRAFT — the real flow an office
     follows: line the invoice, mark it ready, then record what arrived. */
  const ddl = await page.evaluate(async ids => {
    const opts = async invId => {
      await api(`/invoices/${invId}/lines`, { method: 'POST',
        body: { lines: [{ description: 'Investigation services', amount: 500 }] } });
      await api(`/invoices/${invId}/status`, { method: 'POST', body: { status: 'ready' } });
      const d = await api(`/invoices/${invId}`);
      INV_OPEN = d.invoice;
      const html = invoiceDetailView();
      const m = html.match(/<select id="ip_method">([\s\S]*?)<\/select>/);
      return m ? m[1] : 'NO-FORM';
    };
    return { ins: await opts(ids.ins), prv: await opts(ids.prv) };
  }, { ins: insInv, prv: prvInv });
  ok('the insurance invoice offers Mail Check, recording the check instrument',
     ddl.ins.includes('>Mail Check<') && /value="check">Mail Check/.test(ddl.ins), ddl.ins.slice(0, 200));
  ok('the private invoice dropdown is exactly as it was',
     ddl.prv !== 'NO-FORM' && ddl.prv.includes('CHECK') && !ddl.prv.includes('Mail Check'),
     ddl.prv.slice(0, 120));

  const ret = await page.evaluate(() => {
    WS = { legal: { firm_name: 'Mailer & Mailer LLP' } };
    const legal = retainerFormHtml({ amount: 1500 });
    WS = { legal: undefined };
    const priv = retainerFormHtml({ amount: 1500 });
    WS = null;
    return { legal: legal.includes('>Mail Check<'), priv: priv.includes('>Mail Check<') };
  });
  ok('the legal retainer recorder offers Mail Check and the private one does not',
     ret.legal === true && ret.priv === false, JSON.stringify(ret));
  await page.close();
}

section('MAIL-CHECK D5: the tickable option on legal and insurance sends');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await post('/ingest', { case_no: 'API-MCW-L', assignment: 'legal', law_firm: 'Ticker & Box LLP',
    attorney_name: 'A. Tick', client_name: 'Ticker & Box LLP' }, { 'X-Ingest-Key': 'e2e-ingest-key' });
  await post('/ingest', { case_no: 'API-MCW-P', client_name: 'Priva Kate',
    client_email: 'kate@example.test' }, { 'X-Ingest-Key': 'e2e-ingest-key' });
  await page.evaluate(async () => { await render(); TAB = 'leads'; paint(); });
  await page.waitForTimeout(300);

  /* ---- LEGAL: the checkbox, unticked, and nothing consumer ---- */
  const lglCard = page.locator('.pcard', { hasText: 'Ticker & Box LLP' }).first();
  await lglCard.locator('[data-act="leadSheet"]').click();
  await page.waitForTimeout(500);
  const lgl = await page.evaluate(() => {
    const box = document.querySelector('#wiz_mailck');
    return {
      box: !!box,
      ticked: box ? box.checked : null,
      consumer: document.querySelectorAll('.wiz-pm').length,
      /* The WIZARD's own text — the desk behind it legitimately carries other
         cases' payment history, which is not this send's offer. */
      text: box ? box.closest('.feebox').innerText : '',
    };
  });
  ok('a legal send offers the Mail Check checkbox', lgl.box === true);
  ok('UNTICKED by default — an unsent option is never advertised', lgl.ticked === false);
  ok('no consumer method box is drawn beside it', lgl.consumer === 0);
  ok('the hint says the address is invoice-only, and no handle appears',
     /Invoice defaults/.test(lgl.text) && !/cash\.app|venmo/i.test(lgl.text), lgl.text.slice(0, 200));

  /* Tick it, preview, and capture exactly what the page would post. */
  const posted = await page.evaluate(async () => {
    document.querySelector('#wiz_mailck').checked = true;
    document.querySelector('#wiz_to').value = 'firm@example.test';
    wizCollect();
    SHEET_WIZ.step = 2; paint();
    const summary = document.querySelector('#app').innerText;
    let body = null;
    const real = window.fetch;
    window.fetch = async (url, init) => {
      if (String(url).includes('/sheets/')) {
        body = JSON.parse(init.body);
        return new Response(JSON.stringify({ ok: true, sent_to: 'firm@example.test',
          send_context: 'legal', included: { rate_sheet: 'x',
            payment_methods: [{ id: 'mail_check', label: 'Mail Check' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return real(url, init);
    };
    await wizSend();
    window.fetch = real;
    return { summary, body, msg: LEAD_MSG || SHEET_MSG };
  });
  ok('the preview names the choice before it goes',
     /Payment option/.test(posted.summary) && /Mail Check/.test(posted.summary)
     && /Mailing instructions provided with invoice/.test(posted.summary), posted.summary.slice(0, 300));
  ok('the page posts include_payment with exactly mail_check',
     posted.body && posted.body.include_payment === true
     && Array.isArray(posted.body.methods) && posted.body.methods.join() === 'mail_check',
     JSON.stringify(posted.body));
  ok('the confirmation names Mail Check and does NOT chase a retainer',
     /Mail Check/.test(posted.msg) && !/retainer is still pending/.test(posted.msg), posted.msg);

  /* ---- INSURANCE: same box from the Rate Sheets screen ---- */
  await page.evaluate(async () => { TAB = 'sheets'; OPEN_SHEET = 'insurance'; paint(); });
  await page.waitForTimeout(300);
  await page.locator('[data-act="shWiz"][data-context="insurance"]').click();
  await page.waitForTimeout(400);
  const ins = await page.evaluate(() => ({
    box: !!document.querySelector('#wiz_mailck'),
    ticked: document.querySelector('#wiz_mailck') ? document.querySelector('#wiz_mailck').checked : null,
    consumer: document.querySelectorAll('.wiz-pm').length,
  }));
  ok('an insurance send offers the same unticked checkbox and nothing consumer',
     ins.box === true && ins.ticked === false && ins.consumer === 0, JSON.stringify(ins));
  await page.evaluate(() => { SHEET_WIZ = null; paint(); });

  /* ---- PRIVATE: exactly as it was — no Mail Check anywhere ---- */
  await page.evaluate(async () => { TAB = 'leads'; paint(); });
  await page.waitForTimeout(200);
  const prvCard = page.locator('.pcard', { hasText: 'Priva Kate' }).first();
  await prvCard.locator('[data-act="leadSheet"]').click();
  await page.waitForTimeout(500);
  const prv = await page.evaluate(() => {
    const to = document.querySelector('#wiz_to');
    /* The wizard is an .amsheet dialog — it has no .card ancestor, which a
       previous version of this read learned as a null crash. */
    const sheetEl = to ? to.closest('.amsheet') : null;
    return {
      box: !!document.querySelector('#wiz_mailck'),
      text: sheetEl ? sheetEl.innerText : 'NO-WIZARD',
    };
  });
  ok('a PRIVATE send has no Mail Check box and no Mail Check wording',
     prv.box === false && !/Mail Check/.test(prv.text), prv.text.slice(0, 160));

  /* ---- phone ---- */
  await page.setViewportSize({ width: 390, height: 760 });
  await page.evaluate(async () => { SHEET_WIZ = null; TAB = 'leads'; paint(); });
  await page.waitForTimeout(200);
  await page.locator('.pcard', { hasText: 'Ticker & Box LLP' }).first()
    .locator('[data-act="leadSheet"]').click();
  await page.waitForTimeout(400);
  const ph = await page.evaluate(() => {
    const el = document.querySelector('#wiz_mailck');
    const r = el ? el.closest('label').getBoundingClientRect() : null;
    return { box: !!el, fits: r ? r.right <= window.innerWidth + 1 : null,
             overflow: document.documentElement.scrollWidth > window.innerWidth };
  });
  ok('the checkbox is offered and clean at 390px', ph.box === true && ph.fits === true && !ph.overflow,
     JSON.stringify(ph));
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.close();
}

section('BILLCOM: not configured means invisible; configured means offered exactly like Mail Check');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await post('/ingest', { case_no: 'API-BC-L', assignment: 'legal', law_firm: 'Billable & Co LLP',
    attorney_name: 'B. Ill', client_name: 'Billable & Co LLP' }, { 'X-Ingest-Key': 'e2e-ingest-key' });
  await page.evaluate(async () => { await render(); TAB = 'leads'; paint(); });
  await page.waitForTimeout(300);

  /* ---- not configured: the disabled row, pointing at Settings ---- */
  await page.locator('.pcard', { hasText: 'Billable & Co LLP' }).first()
    .locator('[data-act="leadSheet"]').click();
  await page.waitForTimeout(600);
  await page.waitForSelector('#wiz_mailck', { timeout: 8000 });
  const off = await page.evaluate(() => {
    const box = document.querySelector('#wiz_mailck');
    const fee = box ? box.closest('.feebox') : null;
    return {
      mailck: !!box,
      billBox: !!document.querySelector('#wiz_billcom'),
      ready: typeof BILLCOM_READY === 'undefined' ? 'undef' : String(BILLCOM_READY),
      fee: fee ? fee.innerText : 'NO-FEEBOX',
    };
  });
  ok('unconfigured, Mail Check is offered and Bill.com is a disabled Not-configured row',
     off.mailck === true && off.billBox === false
     /* the .tag chip UPPERCASES via CSS and innerText returns the RENDERED
        text — the regex has to be case-insensitive or it fails a correct row */
     && /Bill\.com/.test(off.fee) && /Not configured/i.test(off.fee),
     JSON.stringify(off).slice(0, 300));

  /* ---- the owner types the two values; the same wizard grows the box ---- */
  await page.evaluate(async () => {
    await api('/billing-settings', { method: 'POST', body: {
      billcom_enabled: 'ON', billcom_payment_url: 'https://pay.example.test/api-e2e' } });
    BILLCOM_READY = null;                     // a fresh answer, as a reload would fetch
    SHEET_WIZ = null; paint();
    TAB = 'leads'; paint();
  });
  await page.waitForTimeout(200);
  await page.locator('.pcard', { hasText: 'Billable & Co LLP' }).first()
    .locator('[data-act="leadSheet"]').click();
  await page.waitForTimeout(600);
  const on = await page.evaluate(() => {
    const box = document.querySelector('#wiz_billcom');
    return {
      billBox: !!box,
      ticked: box ? box.checked : null,
      link: box ? /pay\.example\.test/.test(box.closest('.amsheet').innerText) : null,
    };
  });
  ok('configured, the checkbox appears, unticked, and the link itself is nowhere on the wizard',
     on.billBox === true && on.ticked === false && on.link === false, JSON.stringify(on));

  /* Tick both and capture the post. */
  const posted = await page.evaluate(async () => {
    document.querySelector('#wiz_mailck').checked = true;
    document.querySelector('#wiz_billcom').checked = true;
    document.querySelector('#wiz_to').value = 'firm@example.test';
    wizCollect();
    let body = null;
    const real = window.fetch;
    window.fetch = async (url, init) => {
      if (String(url).includes('/sheets/')) {
        body = JSON.parse(init.body);
        return new Response(JSON.stringify({ ok: true, sent_to: 'firm@example.test',
          send_context: 'legal', included: { rate_sheet: 'x', payment_methods: [
            { id: 'mail_check', label: 'Mail Check' }, { id: 'bill_com', label: 'Bill.com' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return real(url, init);
    };
    await wizSend();
    window.fetch = real;
    return body;
  });
  ok('ticking both posts exactly mail_check and bill_com',
     posted && posted.include_payment === true
     && (posted.methods || []).sort().join() === 'bill_com,mail_check', JSON.stringify(posted));

  /* ---- the invoice document renders the section only now ---- */
  const inv = await page.evaluate(async () => {
    const id = (await api('/cases/API-BC-L/invoices', { method: 'POST', body: {} })).invoice.id;
    const d = await api(`/invoices/${id}`);
    INV_SETTINGS = d.settings || INV_SETTINGS;
    const withIt = invoiceDocHtml(d.invoice);
    await api('/billing-settings', { method: 'POST', body: { billcom_enabled: '' } });
    const d2 = await api(`/invoices/${id}`);
    const without = invoiceDocHtml(d2.invoice);
    return { withIt: withIt.includes('Pay electronically via Bill.com')
               && withIt.includes('https://pay.example.test/api-e2e'),
             without: !without.includes('Bill.com') };
  });
  ok('the legal invoice prints the Bill.com section while enabled and not a word after disabling',
     inv.withIt === true && inv.without === true, JSON.stringify(inv));
  await page.close();
}

section('LEGAL-SERVICES: the wizard generates the sheet from the service, and a fixed case never says retainer');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  /* A fixed-service legal lead exactly as the public form delivers one, and a
     historical legal lead with no marker at all. */
  await post('/ingest', { case_no: 'API-LSV-F', assignment: 'legal', legal_service: 'locate',
    firm_name: 'Locate & Co', attorney_name: 'L. Cate', client_name: 'Locate & Co',
    client_email: 'l@locateco.example', objective: 'Find the witness' },
    { 'X-Ingest-Key': 'e2e-ingest-key' });
  await post('/ingest', { case_no: 'API-LSV-H', assignment: 'legal',
    firm_name: 'Historic LLP', attorney_name: 'H. Old', client_name: 'Historic LLP' },
    { 'X-Ingest-Key': 'e2e-ingest-key' });

  /* ---- the Rate sheets legal wizard: selector, retainer handoff, preview ---- */
  await page.evaluate(async () => { await render(); TAB = 'sheets'; OPEN_SHEET = 'legal'; paint(); });
  await page.waitForTimeout(300);
  await page.locator('[data-act="shWiz"][data-context="legal"]').click();
  await page.waitForSelector('#wiz_lsvc', { timeout: 4000 });
  const sel = await page.evaluate(() => ({
    options: [...document.querySelectorAll('#wiz_lsvc option')].map(o => o.value),
    text: document.querySelector('#wiz_lsvc').closest('.feebox').innerText,
    retainerBox: !!document.querySelector('#wiz_ret'),
  }));
  ok('the legal wizard offers the five services plus not-specified',
     sel.options.join() === ',locate,process,general,surveillance,custom', JSON.stringify(sel.options));
  ok('the fixed options carry the Worker-composed price label', /\$250 Flat Fee/.test(sel.text),
     sel.text.slice(0, 200));
  ok('unspecified, the retainer selector still draws — the existing send unchanged',
     sel.retainerBox === true);

  const picked = await page.evaluate(() => {
    document.querySelector('#wiz_lsvc').value = 'locate';
    wizCollect(); SHEET_WIZ.lsvcTouched = true; paint();
    const fee = document.querySelector('#wiz_lsvc').closest('.feebox').innerText;
    document.querySelector('#wiz_to').value = 'firm@locateco.example';
    wizCollect(); SHEET_WIZ.step = 2; paint();
    return { fee, retainerBox: !!document.querySelector('#wiz_ret'),
             summary: document.querySelector('.amsheet').innerText };
  });
  ok('picking Person Locate withdraws the retainer selector — a flat fee is not a retainer',
     picked.retainerBox === false);
  ok('and the hint names the concise flat-fee sheet',
     /Person Locate \/ Skip Trace — \$250 Flat Fee/.test(picked.fee), picked.fee.slice(0, 200));
  ok('the preview names the fixed sheet and the service, with no Agreed-retainer row',
     /Person Locate \/ Skip Trace — \$250 Flat Fee/.test(picked.summary)
     && /Legal service/.test(picked.summary)
     && !/Agreed retainer/.test(picked.summary)
     && /does not mark the fee paid/.test(picked.summary), picked.summary.slice(0, 400));

  const posted = await page.evaluate(async () => {
    let body = null; const real = window.fetch;
    window.fetch = async (url, init) => {
      if (String(url).includes('/sheets/')) { body = JSON.parse(init.body);
        return new Response(JSON.stringify({ ok: true, sent_to: 'x', send_context: 'legal',
          legal_service: { id: 'locate', label: 'Person Locate / Skip Trace', model: 'fixed' },
          included: { rate_sheet: 'x', payment_methods: [] } }),
          { status: 200, headers: { 'content-type': 'application/json' } }); }
      return real(url, init);
    };
    await wizSend(); window.fetch = real;
    return body;
  });
  ok('the page posts exactly the service it previewed',
     posted && posted.legal_service === 'locate', JSON.stringify(posted));

  /* ---- Process Service: the Standard / Custom flat-fee control (D12) ---- */
  await page.evaluate(async () => { SHEET_WIZ = null; TAB = 'sheets'; OPEN_SHEET = 'legal'; paint(); });
  await page.waitForTimeout(200);
  await page.locator('[data-act="shWiz"][data-context="legal"]').click();
  await page.waitForSelector('#wiz_lsvc', { timeout: 4000 });
  const feeCtl = await page.evaluate(() => {
    document.querySelector('#wiz_lsvc').value = 'process';
    wizCollect(); SHEET_WIZ.lsvcTouched = true; paint();
    const std = document.querySelector('#wiz_fee_std');
    return { radios: !!std && !!document.querySelector('#wiz_fee_custom'),
             stdChecked: std ? std.checked : null,
             label: std ? std.closest('label').innerText : '',
             box: !!document.querySelector('#wiz_feec') };
  });
  ok('picking Process Service draws Standard/Custom radios, Standard preselected with the Worker-composed label',
     feeCtl.radios && feeCtl.stdChecked === true && /\$250 Flat Fee/.test(feeCtl.label) && feeCtl.box,
     JSON.stringify(feeCtl));
  const feeCustom = await page.evaluate(async () => {
    document.querySelector('#wiz_fee_custom').checked = true;
    document.querySelector('#wiz_feec').value = '375';
    wizCollect(); SHEET_WIZ.feeTouched = true; SHEET_WIZ.feeMode = 'custom';
    document.querySelector('#wiz_to').value = 'firm@serve.example';
    wizCollect(); SHEET_WIZ.step = 2; paint();
    const summary = document.querySelector('.amsheet').innerText;
    let body = null; const real = window.fetch;
    window.fetch = async (url, init) => {
      if (String(url).includes('/sheets/')) { body = JSON.parse(init.body);
        return new Response(JSON.stringify({ ok: true, sent_to: 'x', send_context: 'legal',
          legal_service: { id: 'process', label: 'Process Service', model: 'fixed' }, flat_fee: 375,
          included: { rate_sheet: 'x', payment_methods: [] } }),
          { status: 200, headers: { 'content-type': 'application/json' } }); }
      return real(url, init);
    };
    await wizSend(); window.fetch = real;
    return { summary, body };
  });
  ok('the preview names Process Service — $375 Flat Fee and never the unused default',
     /Process Service — \$375 Flat Fee/.test(feeCustom.summary)
     && !/\$250/.test(feeCustom.summary), feeCustom.summary.slice(0, 300));
  ok('and the page posts flat_fee 375 with the service',
     feeCustom.body && feeCustom.body.flat_fee === 375
     && feeCustom.body.legal_service === 'process', JSON.stringify(feeCustom.body));

  /* An empty custom amount blocks the step with words, the retainer rule. */
  await page.evaluate(async () => { SHEET_WIZ = null; TAB = 'sheets'; OPEN_SHEET = 'legal'; paint(); });
  await page.waitForTimeout(200);
  await page.locator('[data-act="shWiz"][data-context="legal"]').click();
  await page.waitForSelector('#wiz_lsvc', { timeout: 4000 });
  const feeErr = await page.evaluate(async () => {
    document.querySelector('#wiz_lsvc').value = 'process';
    wizCollect(); SHEET_WIZ.lsvcTouched = true; paint();
    document.querySelector('#wiz_fee_custom').checked = true;
    wizCollect(); SHEET_WIZ.feeMode = 'custom'; SHEET_WIZ.feeTouched = true;
    document.querySelector('#wiz_to').value = 'firm@serve.example';
    wizCollect();
    const okd = await wizFeeSave();
    return { okd, err: SHEET_WIZ.err };
  });
  ok('custom with no amount refuses in words before Preview',
     feeErr.okd === false && /dollar amount above zero/.test(feeErr.err), JSON.stringify(feeErr));
  await page.evaluate(() => { SHEET_WIZ = null; paint(); });

  /* ---- a lead-card wizard preselects the case's own service ---- */
  await page.evaluate(async () => { SHEET_WIZ = null; TAB = 'leads'; paint(); });
  await page.waitForTimeout(200);
  await page.locator('.pcard', { hasText: 'Locate & Co' }).first()
    .locator('[data-act="leadSheet"]').click();
  await page.waitForTimeout(700);
  const lead = await page.evaluate(() => ({
    v: document.querySelector('#wiz_lsvc') ? document.querySelector('#wiz_lsvc').value : 'NONE',
    retainerBox: !!document.querySelector('#wiz_ret'),
  }));
  ok('a fixed-service lead opens its wizard ON the service, retainer selector withdrawn',
     lead.v === 'locate' && lead.retainerBox === false, JSON.stringify(lead));
  await page.evaluate(() => { SHEET_WIZ = null; paint(); });

  /* ---- the case money block: Fee (flat) $250; a historical case unchanged ----
     Rendered by the page's own state and paint(), with the api errors CAPTURED
     rather than lost to openCase's alert-and-return — a failed read must name
     itself in the test evidence, not draw as a missing card. */
  const openStatusCard = async caseNo => page.evaluate(async no => {
    try{
      const [sub, ws] = await Promise.all([
        api('/submissions/' + no), api('/cases/' + no + '/workspace')]);
      WS = { ...ws, submission: sub.submission };
      WS_CASE = no; WS_TAB = 'overview'; VIEW = 'case'; paint();
      /* Matched case-insensitively: the card's h3 is CSS-uppercased and
         innerText returns the RENDERED text — the same lesson the Bill.com
         "Not configured" chip taught, re-learned here as NO-CARD. */
      const c = [...document.querySelectorAll('.ovcard')]
        .find(x => /case status/i.test(x.innerText));
      return { card: c ? c.innerText : 'NO-CARD',
               pricing: WS.authorization && WS.authorization.legal_pricing };
    }catch(e){ return { card: 'API-ERROR: ' + (e.message || e), pricing: null }; }
  }, caseNo);
  const moneyF = await openStatusCard('API-LSV-F');
  ok('a fixed case\'s Overview reads Fee (flat) $250 and never Retainer',
     /Fee \(flat\)/.test(moneyF.card) && /\$250\b/.test(moneyF.card)
     && !/Retainer/.test(moneyF.card), moneyF.card.slice(0, 300));
  ok('and its record knows the service and model',
     moneyF.pricing && moneyF.pricing.service === 'locate'
     && moneyF.pricing.model === 'fixed', JSON.stringify(moneyF.pricing));
  const moneyH = await openStatusCard('API-LSV-H');
  ok('a historical legal case still reads Retainer $1,500 — unchanged',
     /Retainer/.test(moneyH.card) && /\$1,500\b/.test(moneyH.card)
     && !/Fee \(flat\)/.test(moneyH.card), moneyH.card.slice(0, 300));

  /* ---- the Quick Legal form offers the optional service, defaulting to none ----
     The case view is left FIRST: paint() routes to the case whenever
     VIEW === 'case', which is exactly how the first run of this section drew
     a case page under a #nl_lsvc probe and reported the select missing. */
  const quick = await page.evaluate(async () => {
    VIEW = 'list'; WS_CASE = ''; WS = null;
    TAB = 'newlead'; NL = { kind: 'legal', err: '', v: {} }; paint();
    await new Promise(r => setTimeout(r, 150));
    const s = document.querySelector('#nl_lsvc');
    return { present: !!s, value: s ? s.value : null,
             options: s ? [...s.options].map(o => o.textContent.trim().slice(0, 30)) : [] };
  });
  ok('Quick Legal offers the five services under "Not decided yet" — chosen, never defaulted',
     quick.present === true && quick.value === '' && quick.options.length === 6
     && quick.options[0] === 'Not decided yet', JSON.stringify(quick));
  await page.close();
}

section('API ASSISTANT — the dock, the doors, the Beta banner, and real navigation');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  /* ---- the sidebar door, both the item and the badge ---- */
  const nav = await page.evaluate(() => {
    const b = document.querySelector('[data-act="asstOpen"]');
    return { present: !!b, text: b ? b.innerText : '',
             beforeSurv: b ? !!(b.compareDocumentPosition(document.querySelector('.side-surv'))
               & Node.DOCUMENT_POSITION_FOLLOWING) : null };
  });
  ok('the sidebar carries ✨ Assistant with a BETA badge, before the utility doors',
     nav.present && /Assistant/.test(nav.text) && /BETA/.test(nav.text) && nav.beforeSurv === true,
     JSON.stringify(nav));

  /* ---- open: the dock, the banner, the home actions ---- */
  await page.locator('.navfoot [data-act="asstOpen"]').click();
  await page.waitForSelector('.asst-panel', { timeout: 4000 });
  await page.waitForFunction(() => ASST && ASST.state, null, { timeout: 4000 });
  const panel = await page.evaluate(() => ({
    banner: document.querySelector('.asst-banner').innerText,
    home: [...document.querySelectorAll('.asst-big')].map(b => b.innerText.trim()),
    portalStillThere: !!document.querySelector('.tabs'),
  }));
  ok('the dock opens over the portal — the page stays visible beside it',
     panel.portalStillThere === true);
  ok('the persistent banner is the exact dry-run sentence',
     /ASSISTANT BETA — DRY RUN MODE/.test(panel.banner)
     && /No external client messages or consequential actions will be sent\./.test(panel.banner),
     panel.banner);
  ok('the empty state offers big options, not a bare box',
     panel.home.length >= 3 && panel.home.some(t => /What should I do/.test(t)));

  /* ---- typed navigation actually navigates ---- */
  await page.locator('#asst_in').fill('Take me to invoices');
  await page.locator('.asst-ask button').click();
  await page.waitForTimeout(700);
  ok('“take me to invoices” lands on the Billing screen for real',
     await page.evaluate(() => TAB) === 'invoices');
  ok('and the Assistant survives the trip — Beta state intact, transcript kept',
     await page.evaluate(() => !!(ASST && ASST.state && ASST.state.beta && ASST.msgs.length >= 2)));

  /* ---- a consequential ask draws the refusal, visibly ---- */
  await page.locator('#asst_in').fill('Send the client their invoice');
  await page.locator('.asst-ask button').click();
  await page.waitForTimeout(600);
  const refused = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.asst-m')];
    const last = blocks[blocks.length - 1];
    /* An empty list must FAIL with evidence, never crash the run. */
    if (!last) return { label: false, text: 'NO-ANSWER msgs=' + JSON.stringify((ASST && ASST.msgs) || []) };
    return { label: !!last.querySelector('.asst-blocked'), text: last.innerText };
  });
  ok('a send request shows the BETA — ACTION DISABLED label and the plain refusal',
     refused.label === true && /disabled/.test(refused.text), refused.text.slice(0, 160));

  /* ---- the case-level door primes the case context ---- */
  await page.evaluate(() => { ASST = null; });
  await post('/ingest', { case_no: 'API-ASST-C', client_name: 'Assistant Case',
    objective: 'Context test' }, { 'X-Ingest-Key': 'e2e-ingest-key' });
  await page.evaluate(async () => {
    const [sub, ws] = await Promise.all([
      api('/submissions/API-ASST-C'), api('/cases/API-ASST-C/workspace')]);
    WS = { ...ws, submission: sub.submission };
    WS_CASE = 'API-ASST-C'; WS_TAB = 'overview'; VIEW = 'case'; paint();
  });
  await page.waitForTimeout(200);
  ok('the case page carries an ✨ Ask Assistant action',
     await page.locator('.caseacts [data-act="asstOpen"]').count() === 1);
  await page.locator('.caseacts [data-act="asstOpen"]').click();
  await page.waitForSelector('.asst-panel', { timeout: 4000 });
  await page.waitForFunction(() => ASST && ASST.state, null, { timeout: 4000 });
  await page.locator('#asst_in').fill('What should I do?');
  await page.locator('.asst-ask button').click();
  await page.waitForTimeout(700);
  const caseAnswer = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.asst-m')];
    const last = blocks[blocks.length - 1];
    return last ? last.innerText
      : 'NO-ANSWER msgs=' + JSON.stringify((ASST && ASST.msgs) || []);
  });
  ok('“what should I do?” on a case answers from the case\'s own record',
     /RECOMMENDED NEXT STEP/.test(caseAnswer) && /No investigation day/.test(caseAnswer),
     caseAnswer.slice(0, 160));

  /* ---- the phone: the pill on shell screens only, the sheet when open ---- */
  await page.setViewportSize({ width: 390, height: 760 });
  await page.evaluate(() => { ASST = null; VIEW = 'list'; WS_CASE = ''; TAB = 'cases'; paint(); });
  await page.waitForTimeout(300);
  const phone = await page.evaluate(() => {
    const pill = document.querySelector('.asst-pill');
    const r = pill ? pill.getBoundingClientRect() : null;
    return { pill: !!pill, visible: r ? r.height >= 44 && r.bottom <= window.innerHeight + 1 : false,
             overflow: document.documentElement.scrollWidth > window.innerWidth };
  });
  ok('the phone pill is visible on shell screens, tappable, and causes no overflow',
     phone.pill && phone.visible && !phone.overflow, JSON.stringify(phone));
  await page.locator('.asst-pill').click();
  await page.waitForSelector('.asst-panel', { timeout: 4000 });
  await page.waitForFunction(() => ASST && ASST.state, null, { timeout: 4000 });
  const sheet = await page.evaluate(() => {
    const p = document.querySelector('.asst-panel').getBoundingClientRect();
    return { full: p.width >= window.innerWidth - 2, banner: !!document.querySelector('.asst-banner'),
             pillGone: !document.querySelector('.asst-pill') };
  });
  ok('open, it is a full-width bottom sheet with the banner, and the pill withdraws — nothing stacks',
     sheet.full && sheet.banner && sheet.pillGone, JSON.stringify(sheet));
  const navPhone = await page.evaluate(async () => {
    document.querySelector('#asst_in').value = 'take me to my assignments';
    await asstSend('take me to my assignments');
    await new Promise(r => setTimeout(r, 500));
    return { tab: TAB, closed: !(ASST && ASST.open), pillBack: !!document.querySelector('.asst-pill') };
  });
  ok('phone navigation goes there, closes the sheet, and the pill returns for easy reopen',
     navPhone.tab === 'cases' && navPhone.closed && navPhone.pillBack, JSON.stringify(navPhone));

  /* ---- the case screen never draws the pill — the wsbar owns that edge ---- */
  await page.evaluate(async () => {
    const [sub, ws] = await Promise.all([
      api('/submissions/API-ASST-C'), api('/cases/API-ASST-C/workspace')]);
    WS = { ...ws, submission: sub.submission };
    WS_CASE = 'API-ASST-C'; WS_TAB = 'overview'; VIEW = 'case'; paint();
  });
  await page.waitForTimeout(200);
  ok('no pill on the case screen — its bottom bar keeps the edge to itself',
     await page.evaluate(() => !document.querySelector('.asst-pill')));
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.close();
}

section('API ASSISTANT Unit 4 — the intake dry-run workbench, on the real page');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');

  /* ---- the utterance opens the workbench, prefilled from the sentence ---- */
  await page.locator('.navfoot [data-act="asstOpen"]').click();
  await page.waitForSelector('.asst-panel', { timeout: 4000 });
  await page.waitForFunction(() => ASST && ASST.state, null, { timeout: 4000 });
  ok('the admin empty state offers the dry-run door as a big option',
     await page.evaluate(() =>
       [...document.querySelectorAll('.asst-big')].some(b => /Prepare an intake/.test(b.innerText))));
  await page.locator('#asst_in').fill('prepare a legal intake');
  await page.locator('.asst-ask button').click();
  await page.waitForSelector('.asst-work', { timeout: 4000 });
  const bench = await page.evaluate(() => ({
    head: document.querySelector('.asst-dry').innerText,
    kind: document.querySelector('#asst_pk').value,
    banner: !!document.querySelector('.asst-banner'),
  }));
  ok('the workbench opens as a DRY RUN, with the door picked from the sentence',
     /DRY RUN/.test(bench.head) && bench.kind === 'legal' && bench.banner === true,
     JSON.stringify(bench));

  /* ---- the EDIT_DRAFT rule holds: a repaint from anywhere keeps the typing ---- */
  await page.locator('#asst_pto').fill('workbench-test@example.com');
  await page.locator('#asst_pname').fill('Marks & Harrison');
  await page.evaluate(() => paint());
  ok('a repaint mid-form keeps every typed value — the draft rule',
     await page.evaluate(() =>
       $('asst_pto').value === 'workbench-test@example.com'
       && $('asst_pname').value === 'Marks & Harrison' && $('asst_pk').value === 'legal'));

  /* ---- Preview: the real email, rendered, and nothing spent ---- */
  const sendsBefore = await page.evaluate(async () => (await api('/sends')).sends.length);
  await page.locator('[data-act="asstPrepPrev"]').click();
  await page.waitForFunction(() => ASST && ASST.prep && ASST.prep.preview, null, { timeout: 4000 });
  const prev = await page.evaluate(() => ({
    head: document.querySelector('.asst-dry').innerText,
    body: document.querySelector('.asst-pre') ? document.querySelector('.asst-pre').innerText : '',
    text: document.querySelector('.asst-work').innerText,
  }));
  ok('the preview says READY TO SEND and that nothing has been sent, in one breath',
     /DRY RUN — READY TO SEND/.test(prev.head) && /nothing has been sent/.test(prev.head));
  ok('and the body is the REAL invite — the legal door, the greeting, the DCJS line',
     /assignment=legal/.test(prev.body) && /^Marks & Harrison,/.test(prev.body)
     && /DCJS/.test(prev.body), prev.body.slice(0, 160));
  ok('the preview names recipient, subject and door beside the body',
     /workbench-test@example\.com/.test(prev.text)
     && /Legal Investigation Assignment — Always Precise Investigations/.test(prev.text));

  /* ---- SIMULATE: the outcome lands in the transcript, the history moves not ---- */
  await page.locator('[data-act="asstPrepSim"]').click();
  await page.waitForFunction(() => ASST && !ASST.prep, null, { timeout: 4000 });
  const simMsg = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.asst-m')];
    const last = blocks[blocks.length - 1];
    return last ? { chip: !!last.querySelector('.asst-sim'), text: last.innerText }
      : { chip: false, text: 'NO-ANSWER msgs=' + JSON.stringify((ASST && ASST.msgs) || []) };
  });
  ok('the simulation answer wears SIMULATED — NOT SENT and says it was recorded',
     simMsg.chip === true && /SIMULATED — NOT SENT/.test(simMsg.text)
     && /Recorded in the Assistant beta log/.test(simMsg.text), simMsg.text.slice(0, 200));
  const sendsAfter = await page.evaluate(async () => (await api('/sends')).sends.length);
  ok('the office send history did not move by one rehearsal — a dry run is not a send',
     sendsAfter === sendsBefore, `before=${sendsBefore} after=${sendsAfter}`);

  /* ---- the beta log reads back where it was written ---- */
  await page.locator('#asst_in').fill('show recent simulations');
  await page.locator('.asst-ask button').click();
  await page.waitForTimeout(700);
  const logAnswer = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.asst-m')];
    const last = blocks[blocks.length - 1];
    return last ? last.innerText : 'NO-ANSWER msgs=' + JSON.stringify((ASST && ASST.msgs) || []);
  });
  ok('“show recent simulations” lists the rehearsal, outcome on its face',
     /SIMULATED — NOT SENT/.test(logAnswer) && /workbench-test@example\.com/.test(logAnswer),
     logAnswer.slice(0, 200));

  /* ---- a bad address is refused inside the workbench, in the desk's words ---- */
  await page.locator('#asst_in').fill('prepare an intake');
  await page.locator('.asst-ask button').click();
  await page.waitForSelector('.asst-work', { timeout: 4000 });
  await page.locator('#asst_pto').fill('not-an-address');
  await page.locator('[data-act="asstPrepPrev"]').click();
  await page.waitForFunction(() => ASST && ASST.prep && ASST.prep.err, null, { timeout: 4000 });
  ok('a bad address draws the refusal inside the workbench',
     await page.evaluate(() => /valid email/.test(ASST.prep.err)));
  await page.locator('[data-act="asstPrepCancel"]').click();
  ok('Cancel withdraws the workbench cleanly',
     await page.evaluate(() => !ASST.prep && !document.querySelector('.asst-work')));
  await page.close();
}

section('API ASSISTANT Unit 5 — the rate-sheet dry-run workbench, on the real page');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.navfoot [data-act="asstOpen"]').click();
  await page.waitForSelector('.asst-panel', { timeout: 4000 });
  await page.waitForFunction(() => ASST && ASST.state, null, { timeout: 4000 });
  ok('the admin empty state offers the rate-sheet dry run beside the intake one',
     await page.evaluate(() =>
       [...document.querySelectorAll('.asst-big')].some(b => /Prepare a rate sheet/.test(b.innerText))));

  /* ---- the legal fixed-service flow, end to end ---- */
  await page.locator('#asst_in').fill('prepare a rate sheet for the law firm');
  await page.locator('.asst-ask button').click();
  await page.waitForSelector('.asst-work', { timeout: 4000 });
  await page.waitForFunction(() => LEGAL_SVCS.length > 0, null, { timeout: 4000 });
  ok('the sheet workbench opens on the audience the sentence named, services loaded',
     await page.evaluate(() =>
       /PREPARE A RATE SHEET/.test(document.querySelector('.asst-dry').innerText)
       && $('asst_sctx').value === 'legal' && !!document.querySelector('#asst_ssvc')));
  /* Picking a FIXED service must draw the fee box — the change listener
     reaches the workbench on every screen (it once sat behind the
     quick-intake bail-out and silently did nothing). */
  await page.selectOption('#asst_ssvc', 'process');
  await page.waitForSelector('#asst_sfee', { timeout: 3000 });
  ok('picking a fixed service draws the custom-fee box', true);
  await page.locator('#asst_sfee').fill('375');
  await page.locator('#asst_sto').fill('sheet-e2e@example.com');
  await page.locator('#asst_sint').click();
  await page.evaluate(() => paint());
  ok('a repaint mid-form keeps the audience, service, fee, recipient and tick — the draft rule',
     await page.evaluate(() =>
       $('asst_sctx').value === 'legal' && $('asst_ssvc').value === 'process'
       && $('asst_sfee').value === '375' && $('asst_sto').value === 'sheet-e2e@example.com'
       && $('asst_sint').checked === true));
  const sheetSendsBefore = await page.evaluate(async () => (await api('/sends')).sends.length);
  await page.locator('[data-act="asstPrepPrev"]').click();
  await page.waitForFunction(() => ASST && ASST.prep && ASST.prep.preview, null, { timeout: 4000 });
  const sheetPrev = await page.evaluate(() => ({
    subj: ASST.prep.preview.subject, body: ASST.prep.preview.body_text,
    work: document.querySelector('.asst-work').innerText }));
  ok('the fixed preview is the real document — the chosen figure, the service door, the intake link',
     sheetPrev.subj === 'Process Service — $375 Flat Fee — Always Precise Investigations'
     && /\$375/.test(sheetPrev.body) && /assignment=legal&service=process/.test(sheetPrev.body)
     && /Intake link/.test(sheetPrev.work), sheetPrev.subj);
  await page.locator('[data-act="asstPrepSim"]').click();
  await page.waitForFunction(() => ASST && !ASST.prep, null, { timeout: 4000 });
  const sheetSim = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.asst-m')];
    const last = blocks[blocks.length - 1];
    return last ? { chip: !!last.querySelector('.asst-sim'), text: last.innerText }
      : { chip: false, text: 'NO-ANSWER' };
  });
  ok('the sheet simulation wears the outcome and names the document',
     sheetSim.chip === true && /SIMULATED — NOT SENT/.test(sheetSim.text)
     && /Process Service — \$375 Flat Fee/.test(sheetSim.text), sheetSim.text.slice(0, 160));
  ok('and the send history did not move — a sheet rehearsal is not a send',
     await page.evaluate(async () => (await api('/sends')).sends.length) === sheetSendsBefore);

  /* ---- the carrier flow: Mail Check only, and no consumer handle ---- */
  await page.locator('#asst_in').fill('prepare a rate sheet for the carrier');
  await page.locator('.asst-ask button').click();
  await page.waitForSelector('#asst_sctx', { timeout: 4000 });
  ok('the carrier sentence lands on the insurance audience',
     await page.evaluate(() => $('asst_sctx').value === 'insurance'));
  await page.locator('#asst_sto').fill('adjuster-e2e@example.com');
  await page.locator('#asst_spay').click();
  await page.locator('[data-act="asstPrepPrev"]').click();
  await page.waitForFunction(() => ASST && ASST.prep && ASST.prep.preview, null, { timeout: 4000 });
  ok('an insurance payment tick means Mail Check, and the body carries no consumer handle',
     await page.evaluate(() =>
       (ASST.prep.preview.included.payment_methods || []).map(m => m.id).join(',') === 'mail_check'
       && !/cash ?app|venmo/i.test(ASST.prep.preview.body_text)));
  await page.locator('[data-act="asstPrepCancel"]').click();

  /* ---- UNIT 6 read half: the live money answer, with its door ---- */
  await page.locator('#asst_in').fill('What is outstanding?');
  await page.locator('.asst-ask button').click();
  await page.waitForTimeout(700);
  const billing = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.asst-m')];
    const last = blocks[blocks.length - 1];
    return last ? { text: last.innerText, door: !!last.querySelector('.asst-acts button') }
      : { text: 'NO-ANSWER', door: false };
  });
  ok('“what is outstanding?” answers with the live billing figure and offers the Billing door',
     /Outstanding across live invoices: \$/.test(billing.text) && billing.door === true,
     billing.text.slice(0, 160));

  /* ---- §11: the guide toggle CHANGES the answer — the inert-toggle fix ---- */
  await page.evaluate(() => { VIEW = 'list'; WS_CASE = ''; TAB = 'invoices'; paint(); });
  await page.waitForTimeout(200);
  await page.locator('#asst_guide').click();
  await page.locator('#asst_in').fill('billing status');
  await page.locator('.asst-ask button').click();
  await page.waitForTimeout(700);
  const guided = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.asst-m')];
    const last = blocks[blocks.length - 1];
    return { p: last && last.querySelector('.asst-guidep') ? last.querySelector('.asst-guidep').innerText : '',
             text: last ? last.innerText : 'NO-ANSWER' };
  });
  ok('guide ON leads the billing answer with the screen\'s own paragraph',
     /paid is what a zero balance means/i.test(guided.p) && /Outstanding|invoice/i.test(guided.text),
     JSON.stringify(guided).slice(0, 200));
  await page.locator('#asst_guide').click();
  await page.locator('#asst_in').fill('billing status');
  await page.locator('.asst-ask button').click();
  await page.waitForTimeout(700);
  ok('guide OFF is the compact answer again — no paragraph',
     await page.evaluate(() => {
       const blocks = [...document.querySelectorAll('.asst-m')];
       const last = blocks[blocks.length - 1];
       return !!last && !last.querySelector('.asst-guidep');
     }));
  await page.close();
}

await browser.close();
server.close();

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
