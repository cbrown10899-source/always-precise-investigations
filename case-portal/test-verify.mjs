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
const server = http.createServer(async (req, res) => {
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
function runVerify() {
  return new Promise(resolve => {
    const child = spawn('bash', [VERIFY, BASE], { stdio: ['ignore', 'pipe', 'pipe'] });
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

server.close();
fs.rmSync(SITE_DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
