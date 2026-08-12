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

const env = {
  DB: d1(db),
  SITE_ORIGIN: '',              // filled in once the port is known
  INGEST_KEY: 'e2e-ingest-key',
  BOOTSTRAP_TOKEN: 'e2e-bootstrap',
  PBKDF2_ITER: '10000',
  INGEST_PER_MINUTE: '500',
};

// ONE server serves the page and mounts the Worker at /portal-api/*, because
// that is how it is deployed. Serving the API from a second origin would let a
// cross-site cookie bug pass unnoticed — which is exactly what it did before.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
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
async function signIn(page, u, p) {
  await page.locator('#u').fill(u);
  await page.locator('#p').fill(p);
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(500);
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
  ok('the claimant is labelled as a claimant', dlg.includes('Claimant'));
  ok('the injury and restrictions are shown', dlg.includes('Lumbar strain'));
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
  await page.waitForTimeout(350);
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
  ok('the investigator gets the injury and restrictions', dlg.includes('Lumbar strain'));
  ok('the investigator gets the scope', dlg.includes('Activity level versus stated restrictions'));
  ok('the investigator gets the deadline', dlg.includes('Hearing 9/12'));
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

  await page.locator('.btn', { hasText: 'Show an example' }).click();
  await page.waitForTimeout(250);
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

/* ------------------------------------------------------------------ report */

await browser.close();
server.close();

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
