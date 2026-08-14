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
  };
}

/* --------------------------------------------------------------- servers */

const db = new DatabaseSync(':memory:');
db.exec(SCHEMA);

const r2store = new Map();
const env = {
  DB: d1(db),
  SITE_ORIGIN: '',              // filled in once the port is known
  INGEST_KEY: 'e2e-ingest-key',
  BOOTSTRAP_TOKEN: 'e2e-bootstrap',
  PBKDF2_ITER: '10000',
  INGEST_PER_MINUTE: '500',
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
     has(isecs, 'Assignment') && has(isecs, 'Activity') && has(isecs, 'Evidence') && has(isecs, 'Report'));
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

section('Example view');
{
  const page = await newPage();
  const calls = [];
  page.on('request', r => { if (r.url().includes('/portal-api/')) calls.push(r.url()); });
  await signIn(page, 'trever', 'AdminPassword1x');
  ok('an admin with real cases is not shown the example unasked',
     !(await text(page, '.card')).includes('EXAMPLE-CLAIM-0001'));
  // P20: the working material lives under Settings now, not on the case list.
  ok('the case list bar carries no test controls',
     !has(await text(page, '.bar'), 'test case') && !has(await text(page, '.bar'), 'example'));
  await page.locator('.tabs button', { hasText: 'Settings' }).click();
  await page.waitForTimeout(300);
  ok('Settings holds the developer area', has(await text(page, '.card'), 'Developer & testing'));
  await page.locator('.btn', { hasText: 'Show the example cases' }).click();
  await page.waitForTimeout(300);
  ok('showing the example lands where the example is',
     has(await text(page, '.tabs button.on'), 'Cases'));
  const listed = await text(page, '.card');
  ok('an admin can call up the carrier example', listed.includes('EXAMPLE-CLAIM-0001'));
  ok('an admin also gets the client example', listed.includes('EXAMPLE-INTAKE-0002'));
  ok('the example rows are labelled as examples', has(listed, 'Example'));
  ok('the banner says they are not real cases', has(listed, 'not real cases'));
  ok('the real cases are still listed alongside', listed.includes('API-20260812-4001'));

  calls.length = 0;
  await rowFor(page, 'EXAMPLE-CLAIM-0001').click();
  await page.waitForTimeout(350);
  const dlg = await text(page, '#dlgBody');
  ok('opening an example makes no API call', calls.length === 0, calls.join(' '));
  ok('the dialog says it is not a real case', has(dlg, 'not a real case'));
  for (const [what, value] of Object.entries({
    carrier: 'Blue Ridge Mutual', 'claim number': 'WC-2026-104871',
    'policy number': 'BRM-88-441209', adjuster: 'Karen Whitfield',
    'defense counsel': 'Poe & Marsden', claimant: 'Marcus Ellery',
    injury: 'Lumbar disc herniation', 'authorized hours': '8 hours authorized',
    'billing reference': 'PO-77412',
  })) ok(`the admin example fills in the ${what}`, dlg.includes(value), value);
  ok('the admin example carries a signature', await page.locator('#dlgBody img.sig').count() === 1);
  ok('the example offers no assignment controls', await page.locator('#asg').count() === 0);

  await page.locator('.close').click();
  await page.waitForTimeout(200);
  await page.locator('.btn', { hasText: 'Hide the example' }).click();
  await page.waitForTimeout(250);
  const hidden = await text(page, '.card');
  ok('hiding the example removes it', !hidden.includes('EXAMPLE-CLAIM-0001'));
  ok('hiding the example leaves the real cases', hidden.includes('API-20260812-4001'));
  await page.close();

  const planted = db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE case_no LIKE 'EXAMPLE-%'").get().n;
  ok('no example was ever written to the database', planted === 0);
}

section('Example view — a new investigator');
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
  ok('a new investigator lands on the example without asking for it',
     body.includes('EXAMPLE-CLAIM-0001'));
  ok('an investigator is not shown the consumer intake example',
     !body.includes('EXAMPLE-INTAKE-0002'));
  ok('the example is labelled', has(body, 'Example'));
  ok('the carrier is not on the example row', !body.includes('Blue Ridge Mutual'));

  await rowFor(page, 'EXAMPLE-CLAIM-0001').click();
  await page.waitForTimeout(350);
  const dlg = await text(page, '#dlgBody');
  ok('the example shows the claimant', dlg.includes('Marcus Ellery'));
  ok('the example shows the injury and restrictions', dlg.includes('Lumbar disc herniation'));
  ok('the example shows the scope', has(dlg, 'Establish activity level'));
  ok('the example shows the field notes', has(dlg, 'retired deputy'));
  for (const [what, value] of Object.entries({
    carrier: 'Blue Ridge Mutual', 'claim number': 'WC-2026-104871',
    'policy number': 'BRM-88-441209', adjuster: 'Karen Whitfield',
    'defense counsel': 'Poe & Marsden', 'billing reference': 'PO-77412',
  })) ok(`the investigator example hides the ${what}`, !dlg.includes(value), value);
  ok('the investigator example carries no signature',
     await page.locator('#dlgBody img.sig').count() === 0);
  ok('the example explains that the client stays with the office', has(dlg, 'stays with the office'));
  await page.close();
}

/* The page redacts the example so a new investigator is shown the truth. The
   Worker is what actually enforces it. If the two lists drift, the example
   starts promising a view that does not match the one they get. */
section('The page example matches what the Worker sends');
{
  const list = src => (src.match(/FIELD_KEEP = \[([\s\S]*?)\]/) || [, ''])[1]
    .match(/['"]([a-z_]+)['"]/g)?.map(s => s.slice(1, -1)) || [];
  const fromWorker = list(fs.readFileSync(path.join(ROOT, 'case-portal/worker.js'), 'utf8'));
  const fromPage = list(fs.readFileSync(path.join(ROOT, 'portal/index.html'), 'utf8'));
  ok('the Worker declares a field allow-list', fromWorker.length > 0);
  ok('the page mirrors it exactly', JSON.stringify(fromWorker) === JSON.stringify(fromPage),
     `worker=${fromWorker} page=${fromPage}`);
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
  const body = await text(page, '.card');
  ok('and the example comes up unasked', body.includes('EXAMPLE-CLAIM-0001'));
  ok('an admin sees both examples', body.includes('EXAMPLE-INTAKE-0002'));
  const stats = await text(page, '.stats');
  ok('the totals count the example so the cards are not all zero', /[1-9]/.test(stats), stats);
  ok('and it says the totals include it', has(await text(page, '.ex-note'), 'include the example'));

  await page.locator('.btn', { hasText: 'Hide the example' }).click();
  await page.waitForTimeout(250);
  ok('hiding it leaves the real empty state', !(await text(page, '.card')).includes('EXAMPLE-CLAIM-0001'));
  ok('the dashboard is still drawn when empty', await page.locator('.stats').count() === 1);
  ok('and there is a button to bring the example back',
     await page.locator('.btn', { hasText: 'Show an example' }).count() > 0);
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

  // The important part: the example must NOT stand in for real data here.
  ok('a broken load does not quietly show the example instead',
     !body.includes('EXAMPLE-CLAIM-0001'), body.slice(0, 200));
  ok('and does not claim there are simply no submissions',
     !body.includes('No submissions yet'), body.slice(0, 200));

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
  await page.locator('.tabs button', { hasText: 'Rate sheets' }).click();
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

  // UIBUILD P18: the 3-step wizard — Recipient, Options (the paired intake),
  // Preview. On the carrier sheet the paired intake is the carrier door.
  await page.locator('.btn', { hasText: 'Send this sheet' }).click();
  await page.waitForTimeout(300);
  ok('the wizard opens on Recipient', has(await text(page, '.amsheet'), 'Send it to'));
  await page.locator('.btn', { hasText: 'Next' }).click();
  await page.waitForTimeout(250);
  ok('an empty address is refused before moving on',
     has(await text(page, '.amsheet'), 'Enter the address'));
  await page.locator('#wiz_to').fill('adjuster@example.test');
  await page.locator('.btn', { hasText: 'Next' }).click();
  await page.waitForTimeout(250);
  const opts = await text(page, '.amsheet');
  ok('Options pairs the carrier intake, by name', has(opts, 'Insurance Assignment Intake'));
  ok('and says the consumer picker is never offered', has(opts, 'never the consumer picker'));
  await page.locator('.btn', { hasText: 'Next' }).click();
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
  ok('there is no Rate sheets tab', !(await text(page, '.tabs')).includes('Rate sheets'));

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
  for (const t of ['Overview', 'Fieldwork', 'Report & Evidence', 'Admin']) {
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
  ok('they get their own sections', has(fsecs, 'Activity') && has(fsecs, 'Evidence') && has(fsecs, 'Report'));
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
  ok('and none of the office', !has(tabs, 'Rate sheets') && !has(tabs, 'Staff'));

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
  ok('received is recorded', has(auth, 'Received') && has(auth, 'Yes'));
  ok('six recorded hours at the private rate leave $900', auth.includes('900'), auth.slice(0, 400));
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

/* The invoice workflow (INVOICING.md): CASE -> CREATE -> REVIEW -> document ->
   BILL -> payment -> PAID, driven through the page. */
section('An invoice from case to PAID');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  ok('the office gets an Invoices tab', has(await text(page, '.tabs'), 'Invoices'));

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
  ok('an investigator has no Invoices tab', !has(await text(page, '.tabs'), 'Invoices'));
  const st = await page.evaluate(async () =>
    (await fetch('/portal-api/invoices', { credentials: 'same-origin' })).status);
  ok('and the invoice book refuses them', st === 403);
  await page.close();
}

/* Priority 6: evidence through the browser — upload, classify, serve, delete,
   and the storage meter on the dashboard. */
section('Evidence in the browser');
{
  const page = await newPage();
  await signIn(page, 'trever', 'AdminPassword1x');
  await rowFor(page, 'API-20260812-4002').click();
  await page.waitForTimeout(450);
  await wsTab(page, 'Evidence');
  ok('the tab says the failsafe is on', has(await text(page, '#dlgBody'), 'free-plan failsafe'));

  await page.locator('#ev_file').setInputFiles({
    name: 'clip1.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(4096, 65) });
  await page.locator('#ev_note').fill('Subject loading lumber, clip 1.');
  await page.locator('.btn', { hasText: 'Upload evidence' }).click();
  await page.waitForTimeout(700);
  let body = await text(page, '#dlgBody');
  ok('the upload lands with its note', has(body, 'clip1.mp4') && has(body, 'loading lumber'));
  ok('and reports the meter', has(body, '% of the free plan'));

  const served = await page.evaluate(async () => {
    const link = document.querySelector('.evcard a');
    const r = await fetch(link.getAttribute('href'), { credentials: 'same-origin' });
    return { status: r.status, type: r.headers.get('content-type'), len: (await r.arrayBuffer()).byteLength };
  });
  ok('the file streams back through the Worker', served.status === 200
     && served.type === 'video/mp4' && served.len === 4096);

  await page.locator('[data-act="evClass"]').selectOption('client_deliverable');
  await page.waitForTimeout(600);
  ok('the office classifies it', has(await text(page, '#dlgBody'), 'Client deliverable'));

  // Attach a photo to the subject built earlier: it appears on the card.
  await page.locator('#ev_file').setInputFiles({
    name: 'subject.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(600, 66) });
  await page.locator('#ev_link').selectOption({ label: 'John Subject' });
  await page.locator('.btn', { hasText: 'Upload evidence' }).click();
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
  ok('a video card says where it lives', has(gal, 'Portal'));
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
  await page.locator('.btn', { hasText: 'Upload evidence' }).click();
  await page.waitForTimeout(700);
  await wsTab(page, 'Activity log');
  ok('a linked photo puts a count on the moment',
     await page.locator('.tl-i', { hasText: 'Subject arrived at ABC Fitness.' })
       .locator('.tl-counts').count() >= 1);
  await wsTab(page, 'Evidence');
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
  await wsTab(page, 'Evidence');

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
  ok('and offers no Edit case', await page.locator('.caseheader .btn').count() === 0);

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
  ok('the office navigation carries Leads & intakes', has(await text(page, '.tabs'), 'Leads'));
  await page.locator('.tabs button', { hasText: 'Leads' }).click();
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
  ok('an investigator gets no leads desk', !has(await text(page, '.tabs'), 'Leads'));
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
  await page.locator('.wsecs button', { hasText: 'Evidence' }).click();
  await page.waitForTimeout(350);
  ok('the bottom bar navigates', has(await text(page, '.wstabs button.on'), 'Evidence'));
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
  ok('there is an obvious way out', has(await text(page, '.sv-head'), 'Exit active mode'));
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
  ok('ending the day is the gold action', await page.locator('.sv-btn.gold').count() >= 1);
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
  await page.locator('.sv-btn.gold', { hasText: 'End investigation day' }).click();
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

  // THE POINT: leave the mode and the work is simply there in the portal.
  await page.locator('[data-act="svExit"]').click();
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
  for (const t of ['Dashboard', 'Cases', 'Leads', 'Invoices', 'Settings']) {
    ok(`the drawer carries ${t}`, has(drawer, t), drawer);
  }
  await page.locator('.tabs button', { hasText: 'Leads' }).click();
  await page.waitForTimeout(700);
  ok('and navigating from it works', has(await text(page, '#app'), 'Leads'));
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
  await page.locator('.sv-nav button', { hasText: 'Evidence' }).click();
  await page.waitForTimeout(500);
  ok('every other screen has one', await page.locator('.sv-backbar').count() === 1);
  ok('and it goes back WITHOUT leaving the mode',
     has(await text(page, '.sv-backbar'), 'Back to active surveillance'));
  await page.locator('.sv-back').first().click();
  await page.waitForTimeout(500);
  ok('tapping it lands on the field home, still in the mode',
     await page.locator('.sv-nav').count() === 1 && await page.locator('.sv-backbar').count() === 0);
  ok('and Exit active mode is still the separate thing',
     has(await text(page, '.sv-head'), 'Exit active mode'));

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
  await page.locator('.sv-nav button', { hasText: 'Evidence' }).click();
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
  await page.locator('.sv-btn.gold', { hasText: 'End investigation day' }).click();
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

/* ------------------------------------------------------------------ report */

await browser.close();
server.close();

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
