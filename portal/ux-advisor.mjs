/* PORTAL UX ADVISOR — Assistant Unit 9 (owner brief 2026-09-02).

   A MEASUREMENT sweep, not an opinion generator: the signed-in portal is
   rendered at desktop / tablet / iPhone widths and each screen is probed for
   the defect classes the owner named that a machine can actually measure —
   overlap, overflow, wrapped controls, tiny tap targets, scroll depth,
   duplicated action labels, mixed terminology. Every finding carries its
   evidence (numbers, names, sizes); classes that need human judgment
   (confusing hierarchy, irrelevant information, click-depth of high-frequency
   actions) are LISTED as needing a person rather than decided by pattern-
   matching — the Assistant Beta invents nothing, here included.

   Output: case-portal/UX-FINDINGS.json (structured: page, width, severity,
   class, observation, evidence, recommendation, status, seen) and a human
   summary printed to stdout. The Assistant does not — and cannot — change or
   deploy source from findings; this script only ever writes the two findings
   files.

   Run: node portal/ux-advisor.mjs   (needs Playwright's chromium, like the
   e2e; binds an ephemeral port, so it can run beside the suite.) */

import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'case-portal/schema.sql'), 'utf8');
const worker = (await import(path.join(ROOT, 'case-portal/worker.js'))).default;

async function loadChromium() {
  for (const dir of ['/opt/node22/lib/node_modules', '/usr/lib/node_modules', '/usr/local/lib/node_modules']) {
    const p = path.join(dir, 'playwright', 'index.mjs');
    if (fs.existsSync(p)) return (await import(p)).chromium;
  }
  return (await import('playwright')).chromium;
}
const chromium = await loadChromium();

function d1(db) {
  const mk = (sql, args = []) => ({
    bind: (...a) => mk(sql, a),
    async first() { const r = db.prepare(sql).get(...args); return r === undefined ? null : r; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() { const info = db.prepare(sql).run(...args); return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }; },
  });
  return {
    prepare: sql => mk(sql),
    async batch(stmts) {
      const out = []; db.exec('BEGIN');
      try { for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); }
      catch (e) { try { db.exec('ROLLBACK'); } catch { /* rolled */ } throw e; }
      return out;
    },
  };
}

const db = new DatabaseSync(':memory:');
db.exec(SCHEMA);
const REAL_FETCH = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url && url.url ? url.url : url);
  if (u.includes('dropboxapi.com')) return new Response('{"entries":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('api.resend.com')) return new Response('{"id":"ux"}', { status: 200 });
  return REAL_FETCH(url, init);
};
const env = {
  DB: d1(db), SITE_ORIGIN: '', INGEST_KEY: 'ux-ingest', BOOTSTRAP_TOKEN: 'ux-boot',
  PBKDF2_ITER: '10000', INGEST_PER_MINUTE: '500',
  EVIDENCE: { async put() {}, async get() { return null; }, async delete() {} },
};
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/portal-api')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const request = new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
      method: req.method, headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const out = await worker.fetch(request, env);
    const headers = {}; const cookies = out.headers.getSetCookie ? out.headers.getSetCookie() : [];
    for (const [k, v] of out.headers) if (k.toLowerCase() !== 'set-cookie') headers[k] = v;
    if (cookies.length) headers['set-cookie'] = cookies.map(c => c.replace(/;\s*Secure/i, ''));
    res.writeHead(out.status, headers);
    return res.end(Buffer.from(await out.arrayBuffer()));
  }
  let p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': p.endsWith('.html') ? 'text/html' : 'text/plain' });
  res.end(fs.readFileSync(p));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${server.address().port}`;
env.SITE_ORIGIN = SITE;

const post = (p, body, headers = {}) => worker.fetch(new Request(SITE + '/portal-api' + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: SITE, ...headers },
  body: JSON.stringify(body) }), env);
const cookieOf = res => (res.headers.getSetCookie ? res.headers.getSetCookie() : [])
  .map(c => c.split(';')[0]).join('; ');
const authed = (cookie) => (p, body) => worker.fetch(new Request(SITE + '/portal-api' + p, {
  method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Origin: SITE, Cookie: cookie },
  body: body === undefined ? undefined : JSON.stringify(body) }), env);

/* ---- seed: enough real content that screens draw their real shapes ---- */
await post('/setup', { username: 'trever', display_name: 'Trever Brown', password: 'AdvisorPass1x' },
  { 'X-Bootstrap-Token': 'ux-boot' });
const admin = cookieOf(await post('/login', { username: 'trever', password: 'AdvisorPass1x' }));
const call = authed(admin);
await post('/ingest', { case_no: 'UX-CASE-1', client_name: 'Advisor Client', subject_name: 'S. Ubject',
  objective: 'Observe and document activity.' }, { 'X-Ingest-Key': 'ux-ingest' });
await post('/ingest', { case_no: 'UX-CASE-2', carrier: 'Advisor Mutual', claim_number: 'UX-9',
  adjuster: 'A. Djuster', client_name: 'Advisor Mutual', objective: 'AOE/COE' }, { 'X-Ingest-Key': 'ux-ingest' });
await call('/cases/UX-CASE-1/day/start', { day_date: '2026-09-01', start_time: '07:00' });
for (const [t, d2] of [['07:05', 'Arrived in vicinity of subject residence.'],
                       ['07:31', 'Subject departed residence in a gray sedan.'],
                       ['08:02', 'Surveillance concluded for the period.']]) {
  await call('/cases/UX-CASE-1/activity', { at_date: '2026-09-01', at_time: t, description: d2 });
}
await call('/cases/UX-CASE-1/day/end', { end_time: '12:00' });
const inv = await (await call('/cases/UX-CASE-1/invoices', {})).json();
if (inv.invoice) {
  await call(`/invoices/${inv.invoice.id}/lines`, { lines: [{ description: 'Surveillance day', qty: 1, rate: 450 }] });
  await call(`/invoices/${inv.invoice.id}/status`, { status: 'ready' });
}

/* ---- the measurement battery, run inside the page ---- */
const MEASURE = `((rootSel) => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const doc = document.documentElement;
  const root = rootSel ? document.querySelector(rootSel) || document : document;
  const els = [...root.querySelectorAll('button, a[href], input, select, textarea, [data-act]')]
    .filter(el => { const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < Math.max(vh, doc.scrollHeight)
        && getComputedStyle(el).visibility !== 'hidden'; })
    .slice(0, 150);
  const name = el => (el.getAttribute('aria-label') || el.innerText || el.value || el.tagName)
    .trim().replace(/\\s+/g, ' ').slice(0, 40);
  const rects = els.map(el => ({ el, r: el.getBoundingClientRect() }));

  const overflow = doc.scrollWidth - vw;
  let worstRight = null;
  if (overflow > 1) {
    for (const { el, r } of rects) if (!worstRight || r.right > worstRight.right)
      worstRight = { name: name(el), right: Math.round(r.right) };
  }

  const clickableAtCenter = ({ el, r }) => {
    const cx = Math.min(Math.max(r.left + r.width / 2, 1), vw - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 1), vh - 1);
    if (r.top > vh || r.bottom < 0) return false;   // off-screen: cannot compete
    const hit = document.elementFromPoint(cx, cy);
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  };
  const overlaps = [];
  for (let i = 0; i < rects.length && overlaps.length < 8; i++) {
    for (let j = i + 1; j < rects.length && overlaps.length < 8; j++) {
      const a = rects[i], b = rects[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      /* Only when BOTH controls are hittable at their own centers: an overlay
         covering the page, or rows scrolled beneath a sticky footer, occlude
         by design and are not two controls fighting for one spot. */
      if (x > 8 && y > 8 && clickableAtCenter(a) && clickableAtCenter(b)) {
        overlaps.push({ a: name(a.el), b: name(b.el), x: Math.round(x), y: Math.round(y) });
      }
    }
  }

  const tiny = rects
    .filter(({ el }) => ['BUTTON', 'SELECT', 'INPUT', 'TEXTAREA'].includes(el.tagName) && el.type !== 'checkbox')
    .filter(({ r }) => r.height < 44 || r.width < 44)
    .slice(0, 10)
    .map(({ el, r }) => ({ name: name(el), w: Math.round(r.width), h: Math.round(r.height) }));

  const wrapped = rects
    .filter(({ el }) => el.tagName === 'BUTTON')
    .filter(({ el }) => {
      /* A tall button is usually the 44px tap floor plus flex centering — a
         WRAPPED one is a button whose TEXT actually renders on multiple
         lines. A Range over the contents measures the inline lines
         themselves, immune to padding and centering. */
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight) || 18;
      const rg = document.createRange(); rg.selectNodeContents(el);
      return rg.getBoundingClientRect().height >= lh * 1.9;
    }).slice(0, 6).map(({ el, r }) => ({ name: name(el), h: Math.round(r.height) }));

  const counts = {};
  for (const { el } of rects) if (el.tagName === 'BUTTON') {
    const n = name(el); if (n) counts[n] = (counts[n] || 0) + 1;
  }
  const dup = Object.entries(counts).filter(([, n]) => n > 2).map(([t, n]) => ({ label: t, times: n }));

  const bodyText = document.body.innerText;
  const term = [];
  for (const [a, b] of [['Intake', 'Lead'], ['Package', 'Build'], ['Evidence', 'Case media']]) {
    const na = (bodyText.match(new RegExp('\\\\b' + a + 's?\\\\b', 'g')) || []).length;
    const nb = (bodyText.match(new RegExp('\\\\b' + b + 's?\\\\b', 'g')) || []).length;
    if (na && nb) term.push({ pair: a + ' / ' + b, a: na, b: nb });
  }

  return { overflow: Math.round(overflow), worstRight, overlaps, tiny, wrapped, dup, term,
           scrollRatio: Math.round((doc.scrollHeight / vh) * 10) / 10, controls: rects.length };
})`;

const WIDTHS = [[1200, 800, 'desktop'], [820, 1000, 'tablet'], [390, 760, 'iPhone']];
const findings = [];
const seen = new Date().toISOString().slice(0, 10);
const add = (page, width, severity, cls, observation, evidence, recommendation) =>
  findings.push({ page, width, severity, class: cls, observation, evidence, recommendation,
                  status: 'open', first_seen: seen, last_seen: seen });

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
const page = await (await browser.newContext()).newPage();
await page.goto(SITE + '/portal/');
await page.fill('#u', 'trever'); await page.fill('#p', 'AdvisorPass1x');
await page.click('#loginBtn');
await page.waitForTimeout(1200);

const SCREENS = [
  ['Dashboard', () => { VIEW = 'list'; WS_CASE = ''; TAB = 'dashboard'; paint(); }],
  ['Cases', () => { VIEW = 'list'; WS_CASE = ''; TAB = 'cases'; paint(); }],
  ['Leads & Intakes', () => { VIEW = 'list'; WS_CASE = ''; TAB = 'leads'; paint(); }],
  ['Rate Sheets', () => { VIEW = 'list'; WS_CASE = ''; TAB = 'sheets'; paint(); }],
  ['Billing', () => { VIEW = 'list'; WS_CASE = ''; TAB = 'invoices'; loadInvoices(); paint(); }],
  ['Search', () => { VIEW = 'list'; WS_CASE = ''; TAB = 'search'; paint(); }],
  ['Settings', () => { VIEW = 'list'; WS_CASE = ''; TAB = 'settings'; paint(); }],
  ['Case overview', async () => {
    const [sub, ws] = await Promise.all([api('/submissions/UX-CASE-1'), api('/cases/UX-CASE-1/workspace')]);
    WS = { ...ws, submission: sub.submission }; WS_CASE = 'UX-CASE-1'; WS_TAB = 'overview'; VIEW = 'case'; paint();
  }],
  ['Case activity', () => { WS_TAB = 'activity'; paint(); }],
  ['Case billing', () => { WS_TAB = 'billing'; paint(); }],
];

for (const [w, h, label] of WIDTHS) {
  await page.setViewportSize({ width: w, height: h });
  for (const [screen, go] of SCREENS) {
    await page.evaluate(go);
    await page.waitForTimeout(350);
    const m = await page.evaluate(MEASURE + '(null)');
    const where = `${screen} @ ${label} (${w}px)`;
    if (m.overflow > 1) {
      add(screen, label, 'high', 'overflow',
        `The page scrolls sideways by ${m.overflow}px`,
        `documentElement.scrollWidth exceeds the ${w}px viewport; widest control: ${m.worstRight ? `${m.worstRight.name} (right edge ${m.worstRight.right}px)` : 'n/a'}`,
        'Constrain the widest element (minmax(0,1fr) tracks, overflow-x:auto wrappers) — the body must never scroll sideways.');
    }
    for (const o of m.overlaps) {
      add(screen, label, 'medium', 'overlap',
        `"${o.a}" and "${o.b}" overlap ${o.x}×${o.y}px`,
        `Measured at ${where}; both are interactive and neither contains the other`,
        'Separate the two controls or stack them at this width.');
    }
    if ((label !== 'desktop') && m.tiny.length) {
      add(screen, label, label === 'iPhone' ? 'high' : 'medium', 'tap-target',
        `${m.tiny.length} control(s) under the 44px tap floor`,
        m.tiny.map(t => `${t.name}: ${t.w}×${t.h}px`).join('; '),
        'Raise to the portal\'s own 44px floor (min-height/min-width) at touch widths.');
    }
    for (const wr of m.wrapped) {
      add(screen, label, 'low', 'wrapped-control',
        `Button "${wr.name}" wraps to ~${wr.h}px tall`,
        `Height ≥ 2.2 line-heights at ${where}`,
        'Shorten the label or let the control take a wider track.');
    }
    for (const dd of m.dup) {
      add(screen, label, 'info', 'duplicated-action',
        `The label "${dd.label}" appears ${dd.times}× among visible buttons`,
        `Counted at ${where} — repetition across rows can be legitimate; flagged for a human eye`,
        'If these are one action, keep one primary door plus one contextual one (the house rule).');
    }
    for (const t of m.term) {
      add(screen, label, 'info', 'terminology',
        `Both "${t.pair.split(' / ')[0]}" (${t.a}×) and "${t.pair.split(' / ')[1]}" (${t.b}×) are on screen`,
        `Counted in body text at ${where}`,
        'If they name the same thing here, pick the label the owner uses and keep the other for the record.');
    }
    if (m.scrollRatio > 6) {
      add(screen, label, 'info', 'scroll-depth',
        `The screen is ${m.scrollRatio}× the viewport tall`,
        `scrollHeight / viewport at ${where}, ${m.controls} interactive controls`,
        'Long is not wrong — but if a high-frequency action lives at the bottom, give it a door up top.');
    }
  }
  /* The Assistant panel itself, once per width — from a shell screen, where
     both of its doors exist. */
  await page.evaluate(() => { VIEW = 'list'; WS_CASE = ''; TAB = 'cases'; paint(); });
  await page.waitForTimeout(250);
  const opener = w < 900 ? '.asst-pill' : '.navfoot [data-act="asstOpen"]';
  if (await page.locator(opener).count()) {
    await page.locator(opener).first().click();
    await page.waitForTimeout(500);
    const m = await page.evaluate(MEASURE + "('.asst-panel')");
    if ((label !== 'desktop') && m.tiny.length) {
      add('Assistant panel', label, label === 'iPhone' ? 'high' : 'medium', 'tap-target',
        `${m.tiny.length} control(s) under 44px inside the panel`,
        m.tiny.map(t => `${t.name}: ${t.w}×${t.h}px`).join('; '),
        'Raise to the 44px floor.');
    }
    for (const o of m.overlaps) {
      add('Assistant panel', label, 'medium', 'overlap',
        `"${o.a}" and "${o.b}" overlap ${o.x}×${o.y}px`, `Panel open at ${label}`,
        'Separate or stack.');
    }
    await page.evaluate(() => { if (ASST) ASST.open = false; paint(); });
  }
}
await browser.close(); server.close();

/* Judgment classes the machine deliberately does not decide. */
const judgment = [
  'confusing hierarchy — needs a person (or an owner-approved provider) to judge',
  'irrelevant information per screen — needs a person to judge against real workflows',
  'click-depth of high-frequency actions — needs the owner\'s own frequency ranking first',
];

/* Shell chrome repeats on every screen; one defect is one finding. Dedupe by
   (class, width, observation), recording how widely it was seen. */
const seenMap = new Map();
for (const f of findings) {
  const key = `${f.class}|${f.width}|${f.observation}`;
  const prior = seenMap.get(key);
  if (prior) { prior.pages = prior.pages || [prior.page]; if (!prior.pages.includes(f.page)) prior.pages.push(f.page); }
  else seenMap.set(key, f);
}
const deduped = [...seenMap.values()].map(f => f.pages && f.pages.length > 1
  ? { ...f, page: f.pages[0], evidence: `${f.evidence} — seen on ${f.pages.length} screens (${f.pages.slice(0, 5).join(', ')}${f.pages.length > 5 ? '…' : ''})`, pages: undefined }
  : f);
findings.length = 0; findings.push(...deduped);

const out = { generated: new Date().toISOString(), widths: WIDTHS.map(w => w[2]),
  screens: SCREENS.map(s => s[0]).concat('Assistant panel'),
  findings, needs_human_judgment: judgment };
fs.writeFileSync(path.join(ROOT, 'case-portal/UX-FINDINGS.json'), JSON.stringify(out, null, 2));

const bySev = s => findings.filter(f => f.severity === s).length;
console.log(`UX ADVISOR — ${findings.length} finding(s): ${bySev('high')} high, ${bySev('medium')} medium, ${bySev('low')} low, ${bySev('info')} info`);
for (const f of findings.slice(0, 40)) {
  console.log(`  [${f.severity}] ${f.page} @ ${f.width} — ${f.class}: ${f.observation}`);
}
if (findings.length > 40) console.log(`  … ${findings.length - 40} more in UX-FINDINGS.json`);
console.log('Needs human judgment: ' + judgment.length + ' classes (listed in the JSON).');
process.exit(0);
