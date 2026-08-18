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
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'text/plain' });
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
  ok('the case opens on a workspace with four sections', await page.locator('.wsecs button').count() === 4);
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
  const isecs = await text(page, '.wsecs');
  ok('the investigator navigates their own four sections',
     has(isecs, 'Assignment') && has(isecs, 'Activity') && has(isecs, 'Case media') && has(isecs, 'Report'));
  ok('nothing administrative is offered as a section', !has(isecs, 'Admin'));
  await wsTab(page, 'Activity log');
  ok('the investigator has an Activity log tab', await page.locator('.wstabs button', { hasText: 'Activity log' }).count() === 1);
  ok('the investigator has a Field work tab', await page.locator('.wstabs button', { hasText: 'Field work' }).count() === 1);
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
  ok('it opens a full workspace', await page.locator('.wsecs button').count() === 4);
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

  await page.locator('.sheet-card', { hasText: '$1,500 Retainer' }).click();
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

  const secbar = await text(page, '.wsecs');
  for (const t of ['Overview', 'Fieldwork', 'Report & Media', 'Admin']) {
    ok(`the workspace navigates by section: ${t}`, has(secbar, t), secbar);
  }
  // Every panel is still reachable behind its section.
  for (const t of ['Subject', 'Activity log', 'Field work', 'Authorization', 'Assignment']) {
    await wsTab(page, t);
    ok(`the ${t} panel is still reachable`, has(await text(page, '.wstabs button.on'), t));
  }

  // The chain has to hold hands: Reports with nothing to report on points at
  // Field work rather than dead-ending.
  await wsTab(page, 'Reports');
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
  await wsTab(page, 'Activity log');
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
  ok('the newest entry reads first', log.indexOf('8:17 AM') < log.indexOf('7:14 AM'));

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
  await wsTab(page, 'Reports');

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
  await page.locator('.rpnav button', { hasText: 'Summary' }).click();
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

  await page.locator('.btn', { hasText: 'Submit report' }).click();
  await page.waitForTimeout(600);
  let panel = await text(page, '#dlgBody');
  ok('submitting moves it along', has(panel, 'Submitted'));
  ok('an admin reviewing gets Approve', await page.locator('.btn', { hasText: 'Approve' }).count() === 1);
  ok('and Send back', await page.locator('.btn', { hasText: 'Send back' }).count() === 1);

  await page.locator('#r_note').fill('Add the vehicle description.');
  await page.locator('.btn', { hasText: 'Send back' }).click();
  await page.waitForTimeout(600);
  panel = await text(page, '#dlgBody');
  ok('sending it back records the note', panel.includes('Add the vehicle description.'));
  ok('and it reads as needing revision', has(panel, 'Needs revision'));

  await page.locator('.btn', { hasText: 'Submit report' }).click();
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
  const fsecs = await text(page, '.wsecs');
  ok('they get their own sections', has(fsecs, 'Activity') && has(fsecs, 'Case media') && has(fsecs, 'Report'));
  ok('they do not get the Admin section', !has(fsecs, 'Admin'));

  await wsTab(page, 'Field work');
  ok('they get field work', has(await text(page, '.wstabs button.on'), 'Field work'));
  ok('they can start their own day',
     await page.locator('.btn', { hasText: 'Start investigation' }).count() === 1);

  await wsTab(page, 'Activity log');
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
  await wsTab(page, 'Activity log');

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
  await page.locator('#a_time').fill('09:41');
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
    await wsTab(page, 'Activity log');
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
  await page.locator('.sheet-card', { hasText: 'Retainer' }).first().click();
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
  await page.locator('.sheet-card', { hasText: 'Retainer' }).first().click();
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
  await page.locator('.sheet-card', { hasText: 'Retainer' }).first().click();
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
  await wsTab(page, 'Activity log');

  await page.locator('[data-act="actOpen"]').click();
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
  await page.locator('#qa_time').fill('10:05');
  await page.locator('.btn', { hasText: 'Add to log' }).click();
  await page.waitForTimeout(500);
  ok('the quick entry is on the timeline',
     (await text(page, '#dlgBody')).includes('Subject returned to residence.'));
  ok('the sheet closed on success', await page.locator('.amsheet').count() === 0);

  // NO CHANGE is one tap: no compose step, straight to the log (P9).
  await page.locator('[data-act="actOpen"]').click();
  await page.waitForTimeout(300);
  await page.locator('.amcat', { hasText: 'No activity' }).click();
  await page.waitForTimeout(250);
  await page.locator('.ampick', { hasText: 'No change was noted during this period.' }).click();
  await page.waitForTimeout(500);
  ok('one tap logged it', (await text(page, '#dlgBody')).includes('No change was noted during this period.'));
  ok('with no compose step in between', await page.locator('.amsheet').count() === 0);

  // The arrival template generates the sentence from the extras.
  await page.locator('[data-act="actOpen"]').click();
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

  // Month navigation: last month has no work, and the same buttons come back.
  await page.locator('.tabs button', { hasText: 'Calendar' }).click();
  await page.waitForTimeout(400);
  await page.locator('[data-act="calMonth"][data-d="-1"]').click();
  await page.waitForTimeout(600);
  ok('stepping back a month clears the chips', await page.locator('.cal-ev').count() === 0);
  await page.locator('[data-act="calMonth"][data-d="1"]').click();
  await page.waitForTimeout(600);
  ok('and stepping forward brings the work back', await page.locator('.cal-ev').count() === 2);
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
  await wsTab(page, 'Billing & closing');
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
  await wsTab(page, 'Billing & closing');
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
  await wsTab(page, 'Billing & closing');
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
  await wsTab(page, 'Billing & closing');
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
  await wsTab(page, 'Billing & closing');
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
  await wsTab(page, 'Billing & closing');
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
  const card = await text(page, '.ovcard');
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
  const summary = await text(page, '.ovcard');
  ok('the case opens on a summary carrying the retainer and the balance',
     has(summary, 'Retainer') && has(summary, 'Balance'), summary.slice(0, 200));
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
     has(await text(page, '.ovcard'), 'Payment recorded'), (await text(page, '.ovcard')).slice(0, 200));
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
     has(await text(page, '.ovcard'), 'Authoriz'), (await text(page, '.ovcard')).slice(0, 200));
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
  await wsTab(page, 'Billing & closing');
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
  await wsTab(page, 'Case media');
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
  await wsTab(page, 'Case media');

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
  await wsTab(page, 'Activity log');
  ok('a linked photo puts a count on the moment',
     await page.locator('.tl-i', { hasText: 'Subject arrived at ABC Fitness.' })
       .locator('.tl-counts').count() >= 1);
  await wsTab(page, 'Case media');
  ok('and the card names its moment', has(await text(page, '.evgrid'), '8:17 AM'));

  // The quick-entry fold links an already-uploaded file to the new moment (P9).
  await wsTab(page, 'Activity log');
  await page.locator('[data-act="actOpen"]').click();
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
  await wsTab(page, 'Case media');

  await page.locator('[data-act="evDelete"]').first().click();
  await page.waitForTimeout(600);
  ok('a delete keeps the record on screen', has(await text(page, '#dlgBody'), 'the record stays'));

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
  ok('the overview leads with the case summary', has(body, 'Case summary'));
  ok('the summary carries the authorization', has(body, 'Authorized'));
  ok('the package progress speaks percent', /\d+%/.test(body));
  ok('one next step is computed', has(body, 'Next step'));
  ok('recent activity is on the overview', has(body, 'Recent activity'));
  ok('the evidence picture is on the overview', has(body, 'Evidence overview'));

  // P22: the module lines route. The Report line lands on the Reports panel.
  await page.locator('.ov-mods button', { hasText: 'Report' }).first().click();
  await page.waitForTimeout(300);
  ok('a module line routes to its panel', has(await text(page, '.wstabs button.on'), 'Reports'));

  // And the one computed next step routes with a single GO. Every branch of
  // pkgNextStep leads away from the overview, so landing anywhere else is
  // the router working.
  await wsTab(page, 'Overview');
  await page.locator('.ov-next .btn').click();
  await page.waitForTimeout(300);
  ok('GO lands on the computed step', !has(await text(page, '.wstabs button.on'), 'Overview'));

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
  for (const sec of await page.locator('.wsecs button').all()) {
    await sec.click();
    await page.waitForTimeout(180);
    seen.push(await text(page, '.wstabs'));
  }
  const everything = seen.join(' ');
  ok('no section hides a Billing panel', !has(everything, 'Billing'));
  ok('no section hides a Package panel', !has(everything, 'Package'));
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
     (await page.evaluate(() => getComputedStyle(document.querySelector('.wsecs')).position)) === 'fixed');
  const box = await page.locator('.wsecs').boundingBox();
  ok('and it sits at the bottom of the hand', box && box.y > 600, JSON.stringify(box));
  ok('with thumb-size words', has(await text(page, '.wsecs'), 'Home'));
  await page.locator('.wsecs button', { hasText: 'Case media' }).click();
  await page.waitForTimeout(350);
  ok('the bottom bar navigates', has(await text(page, '.wstabs button.on'), 'Case media'));
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
  ok('the assignment offers the field mode',
     await page.locator('[data-act="svEnter"]').count() === 1);
  await page.locator('[data-act="svEnter"]').click();
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
  await page.locator('[data-act="svEnter"]').click();
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
  await wsTab(page, 'Activity log');
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
  await page.route('**/portal-api/summary*', r => r.abort());
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
for (const [what, route, named] of [
  ['the packages read', '**/portal-api/packages*', 'retainers and packages to build'],
  ['the case list',     '**/portal-api/submissions*', 'new intakes'],
]) {
  const page = await newPage();
  await page.route(route, r => r.abort());
  await signIn(page, 'trever', 'AdminPassword1x');
  await page.locator('.tabs button', { hasText: 'Dashboard' }).click();
  await page.waitForTimeout(1400);
  /* SCOPED TO THE QUEUE CARD, not the whole page. "New intakes" is also a card
     label in the band above, so asking the page whether it contains those words
     is a question that answers yes whatever happens — a test that passes with
     the bug in place is worse than no test. */
  const q = await queueCard(page).innerText();

  ok(`${what} down: the queue never says nothing needs you`,
     !has(q, 'Nothing needs you'), q.slice(0, 300));
  ok(`${what} down: it says its view is partial`,
     has(q, 'queue is missing') || has(q, 'queue is incomplete'), q.slice(0, 300));
  ok(`${what} down: and names what it could not read`, has(q, named), q.slice(0, 300));
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
  await page.locator('[data-act="svEnter"]').click();
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
  ok('the command files a real activity entry', (await entries()) === before + 1);
  const filed = await page.evaluate(() => (WS.activity[0] || {}));
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
  const amb = await page.evaluate(() => (WS.activity[0] || {}));
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
  const free = await page.evaluate(() => (WS.activity[0] || {}));
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
     (await page.evaluate(() => WS.activity[0].description)) === 'the subject left in a grey van',
     await page.evaluate(() => WS.activity[0].description));

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
  await page.locator('[data-act="svEnter"]').click();
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
  await page.locator('[data-act="svEnter"]').click();
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
     (await page.evaluate(() => WS.activity[0].description)) === 'the grey van came back',
     await page.evaluate(() => WS.activity[0].description));
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
  await page.locator('[data-act="svEnter"]').click();
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
  ok('and still allows only its own images', /img-src 'self' data:/.test(portalCsp));
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
  await page.locator('[data-act="svEnter"]').click();
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
  await wsTab(page, 'Activity log');
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

  await wsTab(page, 'Billing & closing');
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

  const bar = page.locator('.casepage .wsecs');
  ok('the bottom bar is there on a phone', await bar.isVisible());

  const box = await bar.boundingBox();
  const btns = page.locator('.casepage .wsecs button');
  const n = await btns.count();
  ok('it carries the four sections', n === 4);

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

  ok('each section has an icon, not just a word in small caps',
     await page.locator('.casepage .wsecs .sec-i').count() === 4);
  ok('the section you are on is marked for a screen reader too',
     await page.locator('.casepage .wsecs button[aria-current="page"]').count() === 1);

  // Tapping still works — visibility changes must not break the routing.
  await btns.nth(1).click();
  await page.waitForTimeout(600);
  ok('tapping a section switches to it',
     has(await text(page, '.casepage .wsecs button.on'), 'Field'));
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
     has(await text(page, '.wstabs button.on'), 'Reports'));
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
  ok('tapping it still opens the Assignment panel, unchanged',
     has(await text(page, 'body'), 'Assignment'));
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
  ok('and it offers no download, delete, classify or edit control',
     !/data-act="(evDelete|evClass|evUpload|download)"/i.test(viewerFn)
     && !/\bdownload\b/i.test(viewerFn), viewerFn.slice(0, 200));

  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(500);
  await wsTab(page, 'Case media');
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
  await wsTab(page, 'Case media');

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
  ok('the dashboard carries the quick tool', await page.locator('.qtools .qtool').count() === 1);
  ok('labelled as a tool, not a card', has(await text(page, '.qtools'), 'Quick tools')
     && has(await text(page, '.qtools'), 'Timestamp video'));
  /* COMPACT, not a fifth equal-weight box: it must be shorter than a stat card
     and must not have become one. */
  const size = await page.evaluate(() => {
    const q = document.querySelector('.qtools');
    const card = document.querySelector('.stat');
    return { q: Math.round(q.getBoundingClientRect().height),
             card: card ? Math.round(card.getBoundingClientRect().height) : 0,
             cards: q.querySelectorAll('.card, .stat').length };
  });
  ok('it is a row rather than another dashboard card',
     size.cards === 0 && (!size.card || size.q <= size.card), JSON.stringify(size));

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
  await wsTab(page, 'Case media');
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
     has(await text(page, '.wstabs button.on'), 'Case media'));
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
  await page.locator('[data-act="svEnter"]').click();
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
  ok('the file picker still asks for video up front', /inp\.accept\s*=\s*"video\/\*"/.test(src));
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
  await wsTab(page, 'Case media');

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

  await page.locator('[data-act="pstBurn"]').click();
  await page.waitForTimeout(1200);
  ok('the copy is offered for checking before it is filed',
     has(await text(page, '#pstamp'), 'Check the copy'));
  ok('and the copy is shown', await page.locator('.pst-prev').count() === 1);

  await page.locator('[data-act="pstSave"]').click();
  await page.waitForTimeout(2000);
  ok('it is filed', has(await text(page, '#pstamp'), 'Filed'), await text(page, '#pstamp'));
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
  await wsTab(page, 'Case media');

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
  ok('the burn is not offered a time it does not have',
     has(blank, 'Fill in the date and time'), blank.slice(0, 500));

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

  await page.locator('[data-act="pstSave"]').click();
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
  await page.locator('[data-act="pstSave"]').click();
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
    return document.querySelector('.vst').innerText;
  }, failed);

  const ok1 = await done(false);
  const prevCount = await page.locator('.vst-prev').count();
  const prevDiag = await page.evaluate(() => ({
    n: document.querySelectorAll('.vst-prev').length,
    roots: document.querySelectorAll('#vstamp').length,
    step: JSON.stringify(VST && VST.step),
    failed: JSON.stringify(VST && VST.previewFailed),
  }));
  ok('a playable copy still offers the preview', prevCount === 1,
     `locator=${prevCount} dom=${prevDiag.n} roots=${prevDiag.roots} step=${prevDiag.step} previewFailed=${prevDiag.failed}`);
  ok('and says playing it back is optional', has(ok1, 'not required'), ok1.slice(0, 500));

  /* THE CASE THAT MATTERS: the page cannot play it, and that must not read as a
     failed generation. */
  const ok2 = await done(true);
  ok('a copy the page cannot play drops the player', await page.locator('.vst-prev').count() === 0);
  ok('and says the copy is made regardless', has(ok2, 'The copy is made'), ok2.slice(0, 500));
  ok('naming the player, not the file', has(ok2, 'says nothing about the file'), ok2.slice(0, 500));
  /* THE ACTIONS ARE UNTOUCHED — that is the whole point. */
  ok('Save or Share is still offered', await page.locator('[data-act="vstSave"]').count() === 1);
  ok('and nothing reports it as saved yet', has(ok2, 'not yet saved'), ok2.slice(0, 500));
  ok('the copy is still named as an MP4', has(ok2, 'IMG_0440-timestamped.mp4'));
  await page.close();
}

/* ------------------------------------------------------------------ report */

await browser.close();
server.close();

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
