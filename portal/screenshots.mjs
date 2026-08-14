/**
 * Screenshots of the portal, for looking at rather than asserting on.
 *
 * Runs the REAL page against the REAL Worker against real SQLite — the same
 * stack test-portal.mjs uses — seeds a case with a day, activity and evidence,
 * and photographs every screen at desktop, tablet and phone widths.
 *
 *   node portal/screenshots.mjs [outdir]
 *
 * Needs Playwright. Nothing here touches the live site or the real database.
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
const OUT = process.argv[2] || path.join(ROOT, '.screenshots');
fs.mkdirSync(OUT, { recursive: true });

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

/* ------------------------------------------------- the same stack as the e2e */

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

const db = new DatabaseSync(':memory:');
db.exec(SCHEMA);
const r2store = new Map();
const env = {
  DB: d1(db), SITE_ORIGIN: '', INGEST_KEY: 'shot-key', BOOTSTRAP_TOKEN: 'shot-boot',
  PBKDF2_ITER: '10000', INGEST_PER_MINUTE: '500',
  EVIDENCE: {
    async put(key, body) { r2store.set(key, { body }); },
    async get(key) { const o = r2store.get(key); return o ? { body: o.body } : null; },
    async delete(key) { r2store.delete(key); },
  },
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml',
                '.webp': 'image/webp', '.png': 'image/png',
                '.webmanifest': 'application/manifest+json' };
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
const API = SITE + '/portal-api';

const post = (p, body, headers = {}) => worker.fetch(new Request(API + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: SITE, ...headers },
  body: JSON.stringify(body),
}), env);

/* ------------------------------------------------------------- seed data */

await post('/setup', { username: 'trever', display_name: 'Trever Brown', password: 'AdminPassword1x' },
  { 'X-Bootstrap-Token': 'shot-boot' });

await post('/ingest', {
  case_no: 'API-20260812-4001', service: 'Insurance Claim Assignment',
  carrier: 'Example Mutual Insurance', claim_number: 'WC-2026-88421', policy_number: 'POL-77123',
  claim_type: "Workers' compensation", date_of_loss: '03/14/2026',
  adjuster: 'Dana Reyes', adjuster_email: 'dreyes@examplemutual.com',
  client_name: 'Dana Reyes', subject_name: 'Pat Coleman',
  subject_address: '2214 Old Forest Rd, Lynchburg VA',
  subject_description: 'White GMC Sierra, VA plate XKT-2209',
  subject_relationship: 'Lumbar strain; no lifting over 10 lbs',
  objective: 'Activity level versus stated restrictions', timeline: 'Hearing 9/12',
  authorized_hours: '24 hours — 3 days', start_date: '2026-09-01',
  permitted_days: 'Any day', permitted_times: '0600-1400',
  weekend_authorized: 'Yes — weekends authorized', priority: 'Expedited',
  geographic_limits: 'Within 50 miles of Roanoke',
  signed_name: 'Dana Reyes', payment_method: 'Invoiced to carrier', fee_due: 0,
}, { 'X-Ingest-Key': 'shot-key' });

await post('/ingest', {
  case_no: 'API-20260812-4002', service: 'Surveillance',
  client_name: 'Jane Client', client_phone: '4345550111',
  subject_name: 'John Subject', subject_relationship: 'spouse',
  objective: 'Establish whereabouts', fee_due: 0,
}, { 'X-Ingest-Key': 'shot-key' });

// A partial carrier intake, to photograph the INTAKE-NA admin view.
db.prepare(`INSERT INTO submissions (case_no, kind, status, carrier, client_name,
              subject_name, payload, created_at)
            VALUES (?, 'claims', 'new', ?, ?, ?, ?, ?)`)
  .run('API-20260813-7788', 'Urgent Mutual', 'A. Adjuster', 'Chris Nolan',
    JSON.stringify({
      carrier: 'Urgent Mutual', client_name: 'A. Adjuster', client_email: 'a@urgent.example',
      subject_name: 'Chris Nolan', objective: 'Activity versus stated restrictions',
      claim_number: '', claim_number_status: 'not_available',
      date_of_loss: '', date_of_loss_status: 'unknown',
      subject_address: '', subject_address_status: 'not_available',
      subject_description: '', subject_description_status: 'not_available',
      authorized_hours: 'Authorization pending', authorized_hours_status: 'pending',
      start_date: '', start_date_status: 'flexible',
    }), new Date().toISOString());

/* an investigator, assigned, with a day's worth of real work behind them */
const admin = await (async () => {
  const r = await post('/auth/login', { username: 'trever', password: 'AdminPassword1x' });
  return (r.headers.getSetCookie ? r.headers.getSetCookie() : [])[0].split(';')[0];
})();
const call = (p, opts = {}) => worker.fetch(new Request(API + p, {
  method: opts.method || 'GET',
  headers: { 'Content-Type': 'application/json', Origin: SITE, Cookie: opts.cookie || '', ...(opts.headers || {}) },
  body: opts.body ? JSON.stringify(opts.body) : undefined,
}), env);

const invUrl = (await (await call('/invites', { method: 'POST', cookie: admin,
  body: { username: 'dana', display_name: 'Dana Field', role: 'investigator' } })).json()).url;
await call(`/invite/${new URL(invUrl, 'https://x.test').searchParams.get('invite')}/accept`,
  { method: 'POST', body: { password: 'FieldWork2026x' } });
const users = await (await call('/users', { cookie: admin })).json();
const danaId = users.users.find(u => u.username === 'dana').id;
await call('/submissions/API-20260812-4001/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });
await call('/cases/API-20260812-4001/meta', { method: 'POST', cookie: admin,
  body: { authorized_hours: 24, authorized_budget: 3300 } });

const dana = await (async () => {
  const r = await post('/auth/login', { username: 'dana', password: 'FieldWork2026x' });
  return (r.headers.getSetCookie ? r.headers.getSetCookie() : [])[0].split(';')[0];
})();

// A completed day, so the timeline and the report have something in them.
await call('/cases/API-20260812-4001/day/start', { method: 'POST', cookie: dana,
  body: { day_date: '2026-08-12', start_time: '06:30', start_mileage: 52000 } });
for (const [t, d] of [
  ['06:42', 'Arrived in vicinity of subject residence. White GMC Sierra present in the driveway.'],
  ['07:15', 'Established stationary surveillance position with a clear view of the front door.'],
  ['08:03', 'No change was noted during this period.'],
  ['09:20', 'Subject observed exiting the residence carrying a large toolbox to the vehicle.'],
  ['09:26', 'Subject departed residence.'],
  ['10:48', 'Subject returned to residence and unloaded lumber from the truck bed.'],
]) {
  await call('/cases/API-20260812-4001/activity', { method: 'POST', cookie: dana,
    body: { at_date: '2026-08-12', at_time: t, description: d,
            subject_documented: t === '09:20', photo_acquired: t === '09:20' } });
}
await call('/cases/API-20260812-4001/day/end', { method: 'POST', cookie: dana,
  body: { end_time: '11:30', end_mileage: 52062, summary: 'Subject active throughout the morning, lifting and carrying without visible restriction.' } });

// Evidence: a real PNG so the gallery has a thumbnail rather than a placeholder.
const png = fs.readFileSync(path.join(ROOT, 'portal/icon-192.png'));
async function upload(name, type, bytes, entryId) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  if (entryId) fd.append('entry_id', String(entryId));
  return worker.fetch(new Request(API + '/cases/API-20260812-4001/evidence', {
    method: 'POST', headers: { Origin: SITE, Cookie: dana }, body: fd }), env);
}
const wsNow = await (await call('/cases/API-20260812-4001/workspace', { cookie: dana })).json();
const shot = wsNow.activity.find(a => a.at_time === '09:20');
await upload('subject-loading-0920.png', 'image/png', png, shot && shot.id);
await upload('subject-vehicle.png', 'image/png', png);
await upload('clip-0920.mp4', 'video/mp4', Buffer.alloc(4096, 65), shot && shot.id);

// A report to photograph, taken to approved so Case Build can open.
const day = wsNow.days[0];
const rep = await (await call('/cases/API-20260812-4001/reports/generate', { method: 'POST', cookie: dana,
  body: { day_id: day.id } })).json();
await call(`/cases/API-20260812-4001/reports/${rep.id}/status`, { method: 'POST', cookie: dana, body: { status: 'submitted' } });
await call(`/cases/API-20260812-4001/reports/${rep.id}/status`, { method: 'POST', cookie: admin, body: { status: 'approved' } });

/* ------------------------------------------------------------ the camera */

const launch = {};
const bundled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (fs.existsSync(bundled)) launch.executablePath = bundled;
const browser = await chromium.launch(launch);

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TABLET = { width: 834, height: 1112 };

let n = 0;
const shots = [];
async function snap(page, name, opts = {}) {
  n += 1;
  const file = path.join(OUT, `${String(n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: opts.full !== false });
  shots.push(file);
  console.log('  ' + path.basename(file));
}
async function open(viewport, who = 'trever', pass = 'AdminPassword1x', url = '/portal/') {
  const page = await (await browser.newContext({ viewport, deviceScaleFactor: 2 })).newPage();
  await page.goto(SITE + url);
  await page.waitForTimeout(300);
  await page.locator('#u').fill(who);
  await page.locator('#p').fill(pass);
  await page.locator('#loginBtn').click();
  await page.waitForTimeout(1100);
  return page;
}
const row = (page, c) => page.locator('tbody tr', { hasText: c }).first();
async function sec(page, name) {
  await page.locator('.wsecs button', { hasText: name }).click();
  await page.waitForTimeout(350);
}
async function tab(page, name) {
  const t = () => page.locator('.wstabs button', { hasText: name });
  if (!(await t().count())) {
    for (const s of await page.locator('.wsecs button').all()) {
      await s.click(); await page.waitForTimeout(200);
      if (await t().count()) break;
    }
  }
  await t().click();
  await page.waitForTimeout(400);
}

console.log('\nDESKTOP — the office');
{
  const page = await open(DESKTOP);
  await snap(page, 'desktop-dashboard-sidebar');

  await page.locator('.tabs button', { hasText: 'Cases' }).click();
  await page.waitForTimeout(500);
  await snap(page, 'desktop-cases-list');

  await page.locator('.tabs button', { hasText: 'Leads' }).click();
  await page.waitForTimeout(600);
  await snap(page, 'desktop-leads-and-intakes');

  await page.locator('.side-intake').click();
  await page.waitForTimeout(500);
  await snap(page, 'desktop-intake-a-client');
  await page.locator('.sheet-card', { hasText: 'Insurance' }).click();
  await page.waitForTimeout(400);
  await snap(page, 'desktop-manual-intake-form');

  await page.locator('.tabs button', { hasText: 'Rate sheets' }).click();
  await page.waitForTimeout(700);
  await page.locator('.sheet-card', { hasText: 'Insurance' }).click();
  await page.waitForTimeout(500);
  await snap(page, 'desktop-rate-sheet');
  await page.locator('.btn', { hasText: 'Send this sheet' }).click();
  await page.waitForTimeout(400);
  await page.locator('#wiz_to').fill('adjuster@examplemutual.com');
  await page.locator('.btn', { hasText: 'Next' }).click();
  await page.waitForTimeout(400);
  await snap(page, 'desktop-send-wizard-options', { full: false });
  await page.locator('.amx').click();
  await page.waitForTimeout(300);

  await page.locator('.tabs button', { hasText: 'Settings' }).click();
  await page.waitForTimeout(400);
  await snap(page, 'desktop-settings-developer');
  await page.close();
}

console.log('\nDESKTOP — inside a case');
{
  const page = await open(DESKTOP);
  await page.locator('.tabs button', { hasText: 'Cases' }).click();
  await page.waitForTimeout(500);
  await row(page, 'API-20260812-4001').click();
  await page.waitForTimeout(800);
  await snap(page, 'case-overview-admin');

  await tab(page, 'Intake details');
  await snap(page, 'case-intake-details');

  await tab(page, 'Activity log');
  await snap(page, 'case-activity-timeline');
  await page.locator('[data-act="actOpen"]').click();
  await page.waitForTimeout(500);
  await snap(page, 'case-add-activity-sheet', { full: false });
  await page.locator('.ampick', { hasText: 'Arrived in vicinity' }).click();
  await page.waitForTimeout(400);
  await snap(page, 'case-add-activity-compose', { full: false });
  await page.locator('.amx').click();
  await page.waitForTimeout(300);

  await tab(page, 'Reports');
  await page.waitForTimeout(600);
  // The list shows report cards; open one so the preview screen is on screen.
  if (await page.locator('.rcard').count()) {
    await page.locator('.rcard').first().click();
    await page.waitForTimeout(700);
  }
  await snap(page, 'case-report-preview');
  if (await page.locator('.rpnav button', { hasText: 'Versions' }).count()) {
    await page.locator('.rpnav button', { hasText: 'Versions' }).click();
    await page.waitForTimeout(800);
    await snap(page, 'case-report-versions');
  }

  await tab(page, 'Evidence');
  await page.waitForTimeout(600);
  await snap(page, 'case-evidence-gallery');

  await tab(page, 'Package');
  await page.waitForTimeout(900);
  await snap(page, 'case-build-start');
  if (await page.locator('[data-act="pkgStart"]').count()) {
    await page.locator('[data-act="pkgStart"]').click();
    await page.waitForTimeout(900);
    await snap(page, 'case-build-steps');
  }
  await page.close();
}

console.log('\nDESKTOP — a partial intake (INTAKE-NA)');
{
  const page = await open(DESKTOP);
  await page.locator('.tabs button', { hasText: 'Cases' }).click();
  await page.waitForTimeout(500);
  await row(page, 'API-20260813-7788').click();
  await page.waitForTimeout(700);
  await tab(page, 'Intake details');
  await snap(page, 'intake-na-information-still-needed');
  await page.close();
}

console.log('\nTABLET');
{
  const page = await open(TABLET);
  await snap(page, 'ipad-portrait-dashboard');
  await page.locator('.burger').click();
  await page.waitForTimeout(400);
  await snap(page, 'ipad-portrait-drawer', { full: false });
  await page.close();
}

console.log('\nPHONE — the office');
{
  const page = await open(PHONE);
  await snap(page, 'phone-dashboard');
  await page.locator('.burger').click();
  await page.waitForTimeout(400);
  await snap(page, 'phone-drawer-navigation', { full: false });
  await page.close();
}

console.log('\nPHONE — the field');
{
  const page = await open(PHONE, 'dana', 'FieldWork2026x');
  await snap(page, 'phone-my-assignments');
  await row(page, 'API-20260812-4001').click();
  await page.waitForTimeout(800);
  await snap(page, 'phone-field-case-home');
  await snap(page, 'phone-bottom-nav', { full: false });
  await page.close();
}

console.log('\nPHONE — Active Surveillance Mode');
{
  const page = await open(PHONE, 'dana', 'FieldWork2026x', '/portal/?surveillance=1');
  await page.waitForTimeout(900);
  await snap(page, 'surveillance-launcher');

  await page.locator('[data-act="svEnter"]').first().click();
  await page.waitForTimeout(900);
  await snap(page, 'surveillance-start-day');

  await page.locator('#sv_start').fill('06:30');
  await page.locator('#sv_smiles').fill('52062');
  await page.locator('[data-act="svStartDay"]').click();
  await page.waitForTimeout(1200);
  await snap(page, 'surveillance-home-running');

  await page.locator('.sv-nav button', { hasText: 'Activity' }).click();
  await page.waitForTimeout(500);
  await snap(page, 'surveillance-quick-actions');
  await page.locator('.sv-pick', { hasText: 'Arrived in vicinity' }).click();
  await page.waitForTimeout(500);
  await snap(page, 'surveillance-entry-details');
  await page.locator('[data-act="svSaveEntry"]').click();
  await page.waitForTimeout(1000);

  await page.locator('.sv-nav button', { hasText: 'Home' }).click();
  await page.waitForTimeout(500);
  await page.locator('[data-act="svTab"][data-t="timeline"]').first().click();
  await page.waitForTimeout(500);
  await snap(page, 'surveillance-timeline');

  await page.locator('.sv-nav button', { hasText: 'Evidence' }).click();
  await page.waitForTimeout(600);
  await snap(page, 'surveillance-evidence');

  await page.locator('.sv-nav button', { hasText: 'Report' }).click();
  await page.waitForTimeout(500);
  await snap(page, 'surveillance-report');

  await page.locator('.sv-nav button', { hasText: 'Case' }).click();
  await page.waitForTimeout(500);
  await snap(page, 'surveillance-case-drawer');

  await page.locator('.sv-nav button', { hasText: 'Home' }).click();
  await page.waitForTimeout(500);
  await page.locator('.sv-btn.gold', { hasText: 'End investigation day' }).click();
  await page.waitForTimeout(600);
  await snap(page, 'surveillance-end-day');
  await page.close();
}

console.log('\nDESKTOP — the office watching the field');
{
  const page = await open(DESKTOP);
  await page.waitForTimeout(700);
  await snap(page, 'desktop-dashboard-out-now');
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${shots.length} screenshots in ${OUT}`);
