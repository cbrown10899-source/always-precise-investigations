/**
 * verify.sh against the real Worker — and proof that it writes nothing.
 *
 * verify.sh is the live security probe harden-check.yml runs against
 * production every week. It calls itself read-only, and until 2026-10-22 it
 * was not: its sign-in probe posted a wrong password for "__verify__", a name
 * inside the account alphabet, so every run left a row in login_fails on the
 * production database.
 *
 * This runs the UNMODIFIED script, with real curl, against a local server
 * that answers /portal-api/* from the real worker.js over real SQLite and
 * every other path from the real deploy artifact (the stager's own output,
 * with _headers applied). It then asserts:
 *
 *   - every probe passes, so the security assertions still hold;
 *   - the database did not change at all — SQLite's own change counter, a
 *     hash of every row of every table, and a log of every write-shaped
 *     statement the Worker executed all agree;
 *   - the probes really reached the database (a forged session is a READ of
 *     sessions/users), so "no writes" is not the vacuous answer of a script
 *     that never got there;
 *   - and the instrument can see failure: the old probe, sent to the same
 *     server, IS recorded as a write, and a database missing its session
 *     tables makes the script fail by name.
 *
 * No network beyond 127.0.0.1, no deployed resources.
 *
 *   node case-portal/test-verify.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './worker.js';
import { stage } from '../.github/stage-site.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(HERE, 'worker.js'), 'utf8');
const VERIFY = path.join(HERE, 'verify.sh');
const VERIFY_SRC = fs.readFileSync(VERIFY, 'utf8');

let passed = 0, failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(name) { console.log(`\n${name}`); }

/* ------------------------------------------- D1 adapter that logs every call */

/* The same shape as test-worker.mjs's adapter, plus a log: every statement the
   Worker executes is recorded with the method that ran it. */
const WRITE_SQL = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;
function d1(db, log) {
  return {
    prepare(sql) {
      const stmt = { sql, params: [] };
      stmt.bind = (...p) => ({ ...stmt, params: p, bind: stmt.bind, first: stmt.first, all: stmt.all, run: stmt.run });
      stmt.first = function (col) {
        log.push({ via: 'first', sql: this.sql });
        const row = db.prepare(this.sql).get(...this.params);
        if (row === undefined) return null;
        return col ? row[col] : row;
      };
      stmt.all = function () {
        log.push({ via: 'all', sql: this.sql });
        return { results: db.prepare(this.sql).all(...this.params), success: true };
      };
      stmt.run = function () {
        log.push({ via: 'run', sql: this.sql });
        const r = db.prepare(this.sql).run(...this.params);
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      };
      return stmt;
    },
    batch(stmts) {
      const out = [];
      db.exec('BEGIN');
      try { for (const st of stmts) out.push(st.run()); db.exec('COMMIT'); }
      catch (e) { try { db.exec('ROLLBACK'); } catch { /* already unwound */ } throw e; }
      return out;
    },
  };
}

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const totalChanges = db => Number(db.prepare('SELECT total_changes() AS n').get().n);
function snapshot(db) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const h = crypto.createHash('sha256');
  for (const { name } of tables) {
    h.update(name);
    h.update(JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()));
  }
  return { tables: tables.length, hash: h.digest('hex') };
}

/* A database that looks like a live one: an admin, a signed-in session, and a
   lockout row for somebody else — so "unchanged" is said about real rows. */
const LIVE_TOKEN = crypto.randomBytes(32).toString('hex');
function freshDb({ drop = [] } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 3600_000).toISOString();
  db.prepare(`INSERT INTO users (username, display_name, pass_hash, pass_salt, iterations, role, active, created_at)
              VALUES ('owner', 'Owner', ?, ?, 10000, 'admin', 1, ?)`).run('ab'.repeat(32), 'cd'.repeat(16), now);
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)')
    .run(sha(LIVE_TOKEN), now, later);
  db.prepare("INSERT INTO login_fails (username, fails, locked_until) VALUES ('someone.else', 1, NULL)").run();
  for (const t of drop) db.exec(`DROP TABLE ${t}`);
  return db;
}

/* --------------------------------------------- the site, as Pages serves it */

const SITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-site-'));
const staged = stage(SITE_DIR);
if (staged.problems.length) { console.error(staged.problems.join('\n')); process.exit(1); }

/* _headers, read the way Pages reads it: a path line, then indented headers.
   A trailing * matches as a prefix; "! Name" removes; "#" lines are comments. */
const HEADER_RULES = [];
for (const raw of fs.readFileSync(path.join(SITE_DIR, '_headers'), 'utf8').split('\n')) {
  if (!raw.trim() || raw.trim().startsWith('#')) continue;
  if (!/^\s/.test(raw)) { HEADER_RULES.push({ pattern: raw.trim(), set: [], drop: [] }); continue; }
  const rule = HEADER_RULES[HEADER_RULES.length - 1];
  const line = raw.trim();
  if (line.startsWith('!')) rule.drop.push(line.slice(1).trim().toLowerCase());
  else { const i = line.indexOf(':'); rule.set.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]); }
}
function pagesHeaders(p) {
  const out = {};
  for (const r of HEADER_RULES) {
    const hit = r.pattern.endsWith('*') ? p.startsWith(r.pattern.slice(0, -1)) : p === r.pattern;
    if (!hit) continue;
    for (const [k, v] of r.set) out[k.toLowerCase()] = v;
    for (const k of r.drop) delete out[k];
  }
  return out;
}
function servePage(req, res) {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(SITE_DIR, p.endsWith('/') ? p + 'index.html' : p);
  if (!file.startsWith(SITE_DIR + path.sep)) file = '';
  const found = file && fs.existsSync(file) && fs.statSync(file).isFile();
  res.writeHead(found ? 200 : 404, pagesHeaders(p));
  res.end(found ? fs.readFileSync(file) : fs.readFileSync(path.join(SITE_DIR, '404.html')));
}

/* ------------------------------------------------- the server both answer on */

let ENV = null;
let workerCalls = 0;

/* A scenario can make one path answer badly: a status and body of its own, a
   delay before anything is sent, or headers followed by a body that never
   finishes. Only the failure sections below set it; the Worker and the staged
   site are untouched, so every other path answers as production does. */
let OVERRIDE = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function answerOverride(req, res, ov) {
  req.socket.on('error', () => {});
  for await (const c of req) void c;
  if (ov.delay) await sleep(ov.delay);
  if (res.destroyed) return;
  try {
    res.writeHead(ov.status, { 'content-type': ov.type || 'text/html' });
    if (ov.stall) { res.write(' '); setTimeout(() => { try { res.end(); } catch {} }, ov.stall); return; }
    res.end(ov.body ?? '');
  } catch {}
}

const server = http.createServer(async (req, res) => {
  const ov = OVERRIDE[new URL(req.url, 'http://x').pathname];
  if (ov) return answerOverride(req, res, ov);
  if (!req.url.startsWith('/portal-api/') && req.url !== '/portal-api') return servePage(req, res);
  workerCalls++;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const r = await worker.fetch(new Request(`${BASE}${req.url}`, { method: req.method, headers, body }), ENV);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

function makeEnv(db, log) {
  return { DB: d1(db, log), SITE_ORIGIN: BASE, INGEST_KEY: 'ingest-test-key', PBKDF2_ITER: '10000' };
}
function runVerify(base = BASE, env = process.env) {
  return new Promise(resolve => {
    const child = spawn('bash', [VERIFY, base], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
  });
}
const line = (out, name) => out.split('\n').find(l => l.includes(name)) || '';

/* ----------------------------------------------------------------- the runs */

section('The probes are still the security checks they were');
const db = freshDb();
const log = [];
ENV = makeEnv(db, log);

/* Control first: the harness's session path really works, so a 401 for a
   forged cookie below means "refused", not "nothing here can sign in". */
{
  const name = WORKER_SRC.match(/const SESSION_COOKIE = '([^']+)'/)[1];
  const r = await worker.fetch(new Request(`${BASE}/portal-api/auth/me`, { headers: { Cookie: `${name}=${LIVE_TOKEN}` } }), ENV);
  ok('control: a session the server did issue is accepted here', r.status === 200, String(r.status));
}

const before = { changes: totalChanges(db), snap: snapshot(db) };
log.length = 0; workerCalls = 0;
const run = await runVerify();
const after = { changes: totalChanges(db), snap: snapshot(db) };

ok('verify.sh exits 0', run.code === 0, `exit ${run.code}\n${run.out}`);
ok('and reports no failures', /\b0 failed\b/.test(run.out), line(run.out, 'failed'));
for (const name of [
  'the Worker answers at /portal-api/',
  'the D1 binding and INGEST_KEY are both set',
  'every table this build expects is on the database',
  'a session the server never issued is refused',
  'sign-in answers and refuses a name no account can have',
  'a sign-in from another site is refused',
  'ingest refuses a submission with no key',
  'case data is refused to anyone not signed in',
  '/portal-api/pricing is closed', '/portal-api/sheets is closed', '/portal-api/summary is closed',
  '/portal-api/users is closed', '/portal-api/invites is closed',
  'the portal is marked noindex by header',
  'the portal carries a Content-Security-Policy',
  'internal file is not served: /CLAUDE.md',
  'internal file is not served: /case-portal/worker.js',
  'the intake form is wired to the portal',
  'the intake form publishes no price',
  'robots.txt is served',
  'robots.txt points crawlers at the sitemap',
  'robots.txt does not advertise the portal',
]) ok(`PASS: ${name}`, /^\s*PASS\s/.test(line(run.out, name)), line(run.out, name) || 'line not printed');

section('And they wrote nothing to the database');
ok('the probes reached the Worker', workerCalls >= 10, `${workerCalls} Worker requests`);
ok('the forged session was checked against the database (a read, so "no writes" is not vacuous)',
   log.some(e => /FROM sessions s JOIN users u/.test(e.sql)));
ok("SQLite's own change counter did not move", after.changes === before.changes,
   `${before.changes} → ${after.changes}`);
ok('every row of every table is byte-identical', after.snap.hash === before.snap.hash && after.snap.tables > 50,
   `${after.snap.tables} tables`);
const writes = log.filter(e => e.via === 'run' || WRITE_SQL.test(e.sql));
ok('the Worker executed no write-shaped statement', writes.length === 0,
   writes.map(w => w.sql.trim().split('\n')[0]).join(' | '));
ok('login_fails holds only the row it started with',
   JSON.stringify(db.prepare('SELECT username FROM login_fails').all().map(r => r.username)) === '["someone.else"]');

section('No probe can be one the Worker would remember');
{
  const src = WORKER_SRC.match(/if \(!(\/\^\[[^/]+\$\/)\.test\(username\)\)/);
  ok("the Worker's account alphabet is where this test reads it", Boolean(src));
  const alphabet = src ? new RegExp(src[1].slice(1, -1)) : /$^/;
  const names = [...VERIFY_SRC.matchAll(/"username":"([^"]*)"/g)].map(m => m[1]);
  ok('verify.sh carries at least one sign-in probe to check', names.length > 0);
  ok('every sign-in probe uses a name outside the account alphabet, so it is refused before login_fails',
     names.length > 0 && names.every(n => !alphabet.test(n.trim().toLowerCase())), JSON.stringify(names));
  const cookie = WORKER_SRC.match(/const SESSION_COOKIE = '([^']+)'/);
  ok("the forged-session probe uses the Worker's own cookie name",
     Boolean(cookie) && VERIFY_SRC.includes(`Cookie: ${cookie[1]}=`), cookie && cookie[1]);
}

section('The instrument can see a write, and the script can fail');
{
  /* The probe this replaced, sent to the same server: it MUST register as a
     write, or every "no writes" above proves nothing. */
  const c0 = totalChanges(db);
  log.length = 0;
  const r = await fetch(`${BASE}/portal-api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '__verify__', password: '__not-a-real-password__' }),
  });
  ok('the old probe was refused 401, as it always was', r.status === 401, String(r.status));
  ok('and it is recorded as a write by the change counter', totalChanges(db) > c0);
  ok('and by the statement log', log.some(e => e.via === 'run' && /login_fails/.test(e.sql)));
  ok('leaving the login_fails row the live database has been collecting',
     Boolean(db.prepare("SELECT 1 FROM login_fails WHERE username = '__verify__'").get()));
}
{
  /* With the session tables missing, the forged-session probe is the schema
     check the old probe was: the script must fail and say why. */
  ENV = makeEnv(freshDb({ drop: ['sessions'] }), []);
  const bare = await runVerify();
  ok('a database missing its session table fails verify.sh', bare.code !== 0, `exit ${bare.code}`);
  ok('naming the missing tables on the forged-session check',
     /FAIL\s+a session the server never issued is refused/.test(bare.out) && /missing tables/.test(bare.out),
     line(bare.out, 'never issued'));
}

section('harden-check.yml runs this proof first, and a failure stops the live run');
{
  /* GitHub runs steps in order and skips the rest once one fails, unless a
     step opts out. So the property is: the proof is a step BEFORE the live
     probe, and nothing lets the live probe run past a failed proof. */
  const wf = fs.readFileSync(path.join(HERE, '..', '.github', 'workflows', 'harden-check.yml'), 'utf8');
  const steps = wf.split(/\n(?=\s*- (?:name|uses):)/);
  const at = re => steps.findIndex(s => re.test(s));
  const proof = at(/run:\s*node case-portal\/test-verify\.mjs\s*$/m);
  const liveRun = at(/run:\s*bash case-portal\/verify\.sh https:\/\//m);
  const nodeSetup = at(/uses:\s*actions\/setup-node@\S+[\s\S]*node-version-file:\s*'\.node-version'/);
  ok('the workflow runs the local proof', proof > 0);
  ok('it runs the live probe against the site', liveRun > 0);
  ok('the proof comes BEFORE the live probe', proof > 0 && liveRun > proof, `proof step ${proof}, live step ${liveRun}`);
  ok('Node comes from .node-version before the proof (node:sqlite needs 22)', nodeSetup > 0 && nodeSetup < proof);
  ok('nothing lets a step run past a failure (no continue-on-error, no if: on any step)',
     !/continue-on-error/.test(wf) && !steps.some(s => /^\s*if:/m.test(s)));
  ok('the live probe is the last step, so nothing after it can mask its exit code', liveRun === steps.length - 1);
}

/* ------------------------------------------- a page that cannot be read fails */

/* Until 2026-10-23 four checks judged a page by its body alone, never its
   status: robots.txt (11), the Worker's health (1), the intake form (7) and
   its price check (8). A 404 page, a server error, an empty answer, a timeout
   or a site that was not there at all therefore read as PASS. Each scenario
   makes ONE path answer badly and runs the unmodified script: the check must
   fail and say why, and every check that reads what it fetched must say
   NOT CHECKED — never PASS. VERIFY_MAX_TIME only shortens curl's limit so a
   timeout costs two seconds instead of twenty; production uses the default. */
const FAST = { ...process.env, VERIFY_MAX_TIME: '2' };
const verdict = (out, name) => {
  const l = line(out, name);
  return /^\s*PASS\s/.test(l) ? 'PASS' : /^\s*FAIL\s/.test(l) ? 'FAIL' : 'missing';
};
const why = (out, name) => {
  const lines = out.split('\n');
  const i = lines.findIndex(l => l.includes(name));
  return i >= 0 ? (lines[i + 1] || '').trim() : '';
};
const notChecked = (out, names) => names.every(n => verdict(out, n) === 'FAIL' && /NOT CHECKED/.test(why(out, n)));
const showing = (out, names) => names.map(n => `${line(out, n).trim() || n + ': not printed'} / ${why(out, n)}`).join(' | ');
async function scenario(paths) {
  OVERRIDE = paths;
  try { return await runVerify(BASE, FAST); } finally { OVERRIDE = {}; }
}
const failDb = freshDb();
ENV = makeEnv(failDb, []);
const failBefore = { changes: totalChanges(failDb), snap: snapshot(failDb) };

const ROBOTS = fs.readFileSync(path.join(SITE_DIR, 'robots.txt'), 'utf8');
const PAGE404 = fs.readFileSync(path.join(SITE_DIR, '404.html'), 'utf8');
const HOME = fs.readFileSync(path.join(SITE_DIR, 'index.html'), 'utf8');
const INTAKE_PAGE = fs.readFileSync(path.join(SITE_DIR, 'intake', 'index.html'), 'utf8');
const R_SERVED = 'robots.txt is served';
const R_SITEMAP = 'robots.txt points crawlers at the sitemap';
const R_PORTAL = 'robots.txt does not advertise the portal';
const W_ANSWERS = 'the Worker answers at /portal-api/';
const W_DEPENDS = ['the D1 binding and INGEST_KEY are both set', 'every table this build expects is on the database'];
const I_WIRED = 'the intake form is wired to the portal';
const I_PRICE = 'the intake form publishes no price';

section('robots.txt that cannot be read fails, and nothing that reads it passes');
for (const [label, ov, reason] of [
  ['a 404 page', { status: 404, body: PAGE404 }, /HTTP 404/],
  ['a server error', { status: 500, body: 'Internal error', type: 'text/plain' }, /HTTP 500/],
  ['an empty 200', { status: 200, body: '', type: 'text/plain' }, /empty/],
  ['an HTML page served with 200', { status: 200, body: '<!doctype html><title>Home</title><p>Welcome</p>' }, /no User-agent/],
  ['a 200 with no directives', { status: 200, body: '# nothing here\n', type: 'text/plain' }, /no User-agent/],
  ['a timeout', { status: 200, body: ROBOTS, type: 'text/plain', delay: 4000 }, /no complete response/],
  /* Only the status test refuses this one: the body is a valid robots file. */
  ['a 500 carrying a valid robots file', { status: 500, body: ROBOTS, type: 'text/plain' }, /HTTP 500/],
]) {
  const r = await scenario({ '/robots.txt': ov });
  ok(`robots.txt as ${label}: "${R_SERVED}" fails`, verdict(r.out, R_SERVED) === 'FAIL', line(r.out, R_SERVED) || 'not printed');
  ok(`robots.txt as ${label}: the failure says why`, reason.test(why(r.out, R_SERVED)), why(r.out, R_SERVED));
  ok(`robots.txt as ${label}: the sitemap and portal checks say NOT CHECKED, never PASS`,
     notChecked(r.out, [R_SITEMAP, R_PORTAL]), showing(r.out, [R_SITEMAP, R_PORTAL]));
  ok(`robots.txt as ${label}: verify.sh exits non-zero`, r.code !== 0, `exit ${r.code}`);
}
{
  const r = await scenario({ '/robots.txt': { status: 200, type: 'text/plain', body: 'User-agent: *\nAllow: /\n' } });
  ok('robots.txt with no Sitemap line: it is still served', verdict(r.out, R_SERVED) === 'PASS', line(r.out, R_SERVED));
  ok('robots.txt with no Sitemap line: "points crawlers at the sitemap" fails, saying so',
     verdict(r.out, R_SITEMAP) === 'FAIL' && /Sitemap/.test(why(r.out, R_SITEMAP)), showing(r.out, [R_SITEMAP]));
  ok('robots.txt with no Sitemap line: the portal check still runs, and passes', verdict(r.out, R_PORTAL) === 'PASS',
     line(r.out, R_PORTAL));
  ok('robots.txt with no Sitemap line: verify.sh exits non-zero', r.code !== 0, `exit ${r.code}`);
}
{
  const r = await scenario({ '/robots.txt': { status: 200, type: 'text/plain', body: ROBOTS + 'Disallow: /portal/\n' } });
  ok('robots.txt naming the portal still fails as it always did',
     verdict(r.out, R_PORTAL) === 'FAIL' && /points straight at it/.test(why(r.out, R_PORTAL)), showing(r.out, [R_PORTAL]));
  ok('robots.txt naming the portal: it is served and has its sitemap, so only that check fails',
     verdict(r.out, R_SERVED) === 'PASS' && verdict(r.out, R_SITEMAP) === 'PASS', showing(r.out, [R_SERVED, R_SITEMAP]));
}
{
  /* No false alarm: a valid file written differently — comments, lower case,
     CRLF line ends, another host's sitemap URL — passes, and so does the run. */
  const body = '# robots\r\nuser-agent: *\r\nallow: /\r\n\r\nsitemap: https://example.test/sitemap.xml\r\n';
  const r = await scenario({ '/robots.txt': { status: 200, type: 'text/plain', body } });
  ok('a valid robots.txt in another style passes all three robots checks',
     [R_SERVED, R_SITEMAP, R_PORTAL].every(n => verdict(r.out, n) === 'PASS'), showing(r.out, [R_SERVED, R_SITEMAP, R_PORTAL]));
  ok('and the whole run still exits 0 with no failures', r.code === 0 && /\b0 failed\b/.test(r.out), line(r.out, 'failed'));
}

section('A site that is not there: nothing passes');
{
  const probe = http.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const closed = `http://127.0.0.1:${probe.address().port}`;
  await new Promise(r => probe.close(r));
  const refused = await runVerify(closed, FAST);
  /* .invalid never resolves (RFC 6761). Proxies are dropped so the failure is
     the lookup itself rather than whatever a proxy answers in its place. */
  const direct = { ...FAST };
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete direct[k];
  const dns = await runVerify('http://verify.invalid', direct);
  for (const [label, r] of [['connection refused', refused], ['a name that does not resolve', dns]]) {
    const passes = r.out.split('\n').filter(l => /^\s*PASS\s/.test(l));
    ok(`${label}: no check passes`, passes.length === 0, passes.map(l => l.trim()).join(' | '));
    ok(`${label}: robots.txt fails for want of a response`,
       verdict(r.out, R_SERVED) === 'FAIL' && /no complete response/.test(why(r.out, R_SERVED)), showing(r.out, [R_SERVED]));
    ok(`${label}: the Worker check fails and the two checks that read it say NOT CHECKED`,
       verdict(r.out, W_ANSWERS) === 'FAIL' && notChecked(r.out, W_DEPENDS), showing(r.out, [W_ANSWERS, ...W_DEPENDS]));
    ok(`${label}: the intake check fails and the price check says NOT CHECKED`,
       verdict(r.out, I_WIRED) === 'FAIL' && notChecked(r.out, [I_PRICE]), showing(r.out, [I_WIRED, I_PRICE]));
    ok(`${label}: verify.sh exits non-zero`, r.code !== 0, `exit ${r.code}`);
  }
}

section("The Worker's health and the intake form are read with their status");
for (const [label, ov] of [
  ['a 404 page', { status: 404, body: PAGE404 }],
  ['a 200 that is not the health report', { status: 200, body: 'OK', type: 'text/plain' }],
]) {
  const r = await scenario({ '/portal-api/health': ov });
  ok(`/portal-api/health as ${label}: "${W_ANSWERS}" fails`, verdict(r.out, W_ANSWERS) === 'FAIL', showing(r.out, [W_ANSWERS]));
  ok(`/portal-api/health as ${label}: the two checks that read it say NOT CHECKED`,
     notChecked(r.out, W_DEPENDS), showing(r.out, W_DEPENDS));
}
for (const [label, ov, reason] of [
  ['a 404 page', { status: 404, body: PAGE404 }, /HTTP 404/],
  ['a timeout', { status: 200, body: INTAKE_PAGE, delay: 4000 }, /no complete response/],
  ['the homepage served in its place', { status: 200, body: HOME }, /not the intake form/],
  /* The status test is the only thing that refuses this one: the body IS the
     intake page, but a server that answers 500 is not serving it. */
  ['a 500 carrying the intake page itself', { status: 500, body: INTAKE_PAGE }, /HTTP 500/],
]) {
  const r = await scenario({ '/intake/': ov });
  ok(`/intake/ as ${label}: "${I_WIRED}" fails`, verdict(r.out, I_WIRED) === 'FAIL', showing(r.out, [I_WIRED]));
  ok(`/intake/ as ${label}: the failure says why`, reason.test(why(r.out, I_WIRED)), why(r.out, I_WIRED));
  ok(`/intake/ as ${label}: the price check says NOT CHECKED`, notChecked(r.out, [I_PRICE]), showing(r.out, [I_PRICE]));
}
{
  /* What these two checks always caught, they still catch. */
  const key = /const PORTAL_INGEST_KEY = "[^"]*"/;
  ok('the staged intake page carries the key line these checks read', key.test(INTAKE_PAGE));
  const placeholder = INTAKE_PAGE.replace(key, 'const PORTAL_INGEST_KEY = "PASTE_INGEST_KEY"');
  const r1 = await scenario({ '/intake/': { status: 200, body: placeholder } });
  ok('an intake page still holding the placeholder key fails, as it always did',
     verdict(r1.out, I_WIRED) === 'FAIL' && /placeholder/.test(why(r1.out, I_WIRED)), showing(r1.out, [I_WIRED]));
  ok('and its price check still runs on the page it read', verdict(r1.out, I_PRICE) === 'PASS', showing(r1.out, [I_PRICE]));
  const priced = INTAKE_PAGE.replace('</body>', () => '<p>Surveillance from $500</p></body>');
  const r2 = await scenario({ '/intake/': { status: 200, body: priced } });
  ok('an intake page publishing a dollar figure fails the price check, as it always did',
     verdict(r2.out, I_PRICE) === 'FAIL' && /dollar figure/.test(why(r2.out, I_PRICE)), showing(r2.out, [I_PRICE]));
  /* The two checks above used to read the page through `printf | grep -q`
     under pipefail. The intake page is larger than a pipe buffer, so when
     grep found its match early and exited, printf died of SIGPIPE, the
     pipeline answered 141, and a FOUND match read as "not found". A price
     near the top of the page therefore passed; only one near the end (as
     above) was ever caught. Both checks read the fetched file now. */
  ok('the staged intake page is larger than a pipe buffer, so this case is real', INTAKE_PAGE.length > 65536,
     `${INTAKE_PAGE.length} bytes`);
  const early = INTAKE_PAGE.replace(/<head[^>]*>/, m => `${m}<meta name="price" content="from $500">`);
  const r3 = await scenario({ '/intake/': { status: 200, body: early } });
  ok('a dollar figure near the TOP of a large intake page fails the price check too',
     verdict(r3.out, I_PRICE) === 'FAIL' && /dollar figure/.test(why(r3.out, I_PRICE)), showing(r3.out, [I_PRICE]));
}

section('A status code only counts when the response finished');
{
  /* code() used to print whatever status curl had seen, even when the body
     then timed out — so a 401 whose response never completed read as a 401. */
  const r = await scenario({ '/portal-api/submissions': { status: 401, stall: 4000, type: 'application/json' } });
  const name = 'case data is refused to anyone not signed in';
  ok('a 401 whose body never finishes is not taken as a 401', verdict(r.out, name) === 'FAIL', showing(r.out, [name]));
  ok('it is reported as no response (000)', /\b000\b/.test(why(r.out, name)), why(r.out, name));
}

section('Reading pages this way still writes nothing, and never reaches the Worker');
{
  ok('none of the failure runs wrote to the database (change counter and every row)',
     totalChanges(failDb) === failBefore.changes && snapshot(failDb).hash === failBefore.snap.hash,
     `${failBefore.changes} → ${totalChanges(failDb)}`);
  ok('robots.txt and the intake form are read with fetch_page, which sees the status',
     /fetch_page "\$SITE\/robots\.txt"/.test(VERIFY_SRC) && /fetch_page "\$SITE\/intake\/"/.test(VERIFY_SRC));
  /* test-worker.mjs finds the Worker probes as $(code …)/$(curljson …) lines;
     a Worker probe written through fetch_page would escape its no-write guard. */
  ok('fetch_page is never pointed at the Worker ($API)', !/fetch_page[^\n]*\$API/.test(VERIFY_SRC));
}

server.close();
fs.rmSync(SITE_DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
