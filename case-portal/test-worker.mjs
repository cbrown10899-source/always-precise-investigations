/**
 * Tests for the case-portal Worker.
 *
 * Runs the real worker module against a real SQLite database (node:sqlite)
 * behind a small D1-shaped adapter, so the SQL in worker.js is genuinely
 * executed rather than mocked. No network, no deployed resources.
 *
 *   node case-portal/test-worker.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './worker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8');

/* ------------------------------------------------------------ test harness */

let passed = 0, failed = 0;
const results = [];
function ok(name, cond, detail = '') {
  if (cond) { passed++; results.push(`  PASS  ${name}`); }
  else { failed++; results.push(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(name) { results.push(`\n${name}`); }

/* --------------------------------------------------- D1 adapter over sqlite */

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
      stmt.all = function () {
        return { results: db.prepare(this.sql).all(...this.params), success: true };
      };
      stmt.run = function () {
        const r = db.prepare(this.sql).run(...this.params);
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      };
      return stmt;
    },
    /* D1's batch() runs its statements in ONE transaction: all commit or none
       do. Mirrored here because the Worker depends on that atomicity to write a
       payment and claim its idempotency token as a single fact. If the mock ran
       them separately the tests would pass while production kept a gap between
       the two — which is exactly the gap that let a double-click duplicate a
       payment. */
    batch(stmts) {
      const out = [];
      db.exec('BEGIN');
      try {
        for (const st of stmts) out.push(st.run());
        db.exec('COMMIT');
      } catch (e) {
        /* Rolling back must not replace the error that caused it. If ROLLBACK
           throws — SQLite may already have unwound the transaction itself —
           the original cause is lost, and worse, every later statement runs
           inside a transaction nobody closed. */
        try { db.exec('ROLLBACK'); } catch { /* already unwound */ }
        throw e;
      }
      return out;
    },
  };
}

const ORIGIN = 'https://alwayspreciseinvestigations.net';
// The rate the firm decided it would not go below. Written out here rather than
// read from the Worker on purpose: if someone lowers the floor to make a cheap
// block pass, that is a decision, and it should take editing the test too.
const RATES_FLOOR = 125;
function freshEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return {
    DB: d1(db),
    SITE_ORIGIN: ORIGIN,
    INGEST_KEY: 'ingest-test-key',
    BOOTSTRAP_TOKEN: 'bootstrap-test-token',
    PBKDF2_ITER: '10000',   // keep the suite quick; production uses the default
    INGEST_PER_MINUTE: '5', // ditto — production defaults far higher
    /* NEW CASE FILES GO TO DROPBOX (owner, 2026-08-18), so a connected Dropbox
       is the default state of a test environment the same way it is the
       default state of production. The three Dropbox OAuth sections delete
       these again, because their whole subject is how the connection is made. */
    DROPBOX_APP_KEY: 'test-app-key',
    DROPBOX_APP_SECRET: 'test-app-secret',
    DROPBOX_REFRESH_TOKEN: 'RT-test',
  };
}

/* ------------------------------------------------------------ fake Dropbox

   Installed ONCE for the whole suite rather than stubbed per section, because
   new photos and reports go to Dropbox now and almost every evidence test
   needs one that works. It answers the five calls the Worker makes and keeps
   the files in memory, so a test can assert `DBX.files` directly — "the photo
   landed in Photos/" as a fact rather than something inferred from a 201.

   Sections that stub `globalThis.fetch` and fall through to the fetch they
   captured reach this automatically, because it is installed before any of
   them runs. */
const DBX = {
  files: new Map(),      // path -> bytes
  folders: new Set(),
  calls: [],
  sessions: new Map(),   // id -> { parts: [], offset }
  down: false,           // Dropbox unreachable
  uploadFails: false,    // reachable, refuses the write
  deleteFails: false,
  reset() {
    this.files.clear(); this.folders.clear(); this.calls = []; this.sessions.clear();
    this.down = false; this.uploadFails = false; this.deleteFails = false;
  },
  paths() { return [...this.files.keys()]; },
  inFolder(folder) { return this.paths().filter((f) => f.includes('/' + folder + '/')); },
};

async function fakeDropbox(url, init) {
  const u = String(url && url.url ? url.url : url);
  if (!u.includes('dropboxapi.com')) return null;
  DBX.calls.push(u);
  if (DBX.down) return new Response('service unavailable', { status: 503 });
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
    if (DBX.uploadFails) return new Response('conflict', { status: 409 });
    const a = arg();
    let path = a.path;
    if (!path) return new Response('malformed_path', { status: 400 });
    if (DBX.files.has(path) && a.autorename) path = path + '-1';
    const body = init.body;
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body)
      : ArrayBuffer.isView(body) ? new Uint8Array(body.buffer) : new Uint8Array(0);
    DBX.files.set(path, bytes);
    return new Response(JSON.stringify({ path_display: path, path_lower: path.toLowerCase(),
      rev: 'r' + DBX.files.size, size: bytes.length }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  /* SESSIONS, modelled with real offsets. Dropbox is the authority on where a
     session has got to, so the fake refuses a wrong offset the way Dropbox
     does — otherwise "retry" and "resume" would pass without ever being
     exercised. */
  if (u.includes('/2/files/upload_session/start')) {
    if (DBX.uploadFails) return new Response('nope', { status: 500 });
    const id = 'sess-' + (DBX.sessions.size + 1);
    DBX.sessions.set(id, { parts: [], offset: 0 });
    return new Response(JSON.stringify({ session_id: id }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('/2/files/upload_session/append_v2')) {
    if (DBX.uploadFails) return new Response('nope', { status: 500 });
    const cur = arg().cursor || {};
    const sess = DBX.sessions.get(cur.session_id);
    if (!sess) return new Response('closed_session', { status: 409 });
    if (cur.offset !== sess.offset) return new Response('incorrect_offset', { status: 409 });
    const body = init.body;
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body)
      : ArrayBuffer.isView(body) ? new Uint8Array(body.buffer) : new Uint8Array(0);
    sess.parts.push(bytes);
    sess.offset += bytes.length;
    return new Response('', { status: 200 });
  }
  if (u.includes('/2/files/upload_session/finish')) {
    if (DBX.uploadFails) return new Response('nope', { status: 500 });
    const a = arg();
    const sess = DBX.sessions.get((a.cursor || {}).session_id);
    if (!sess) return new Response('closed_session', { status: 409 });
    if ((a.cursor || {}).offset !== sess.offset) return new Response('incorrect_offset', { status: 409 });
    let total = 0;
    for (const part of sess.parts) total += part.length;
    const joined = new Uint8Array(total);
    let at = 0;
    for (const part of sess.parts) { joined.set(part, at); at += part.length; }
    let path = (a.commit || {}).path;
    if (!path) return new Response('malformed_path', { status: 400 });
    if (DBX.files.has(path)) path = path + '-1';
    DBX.files.set(path, joined);
    DBX.sessions.delete((a.cursor || {}).session_id);
    return new Response(JSON.stringify({ path_display: path, path_lower: path.toLowerCase(),
      rev: 'r' + DBX.files.size, size: total }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('/2/files/download')) {
    const f = DBX.files.get(arg().path);
    if (!f) return new Response('not_found', { status: 409 });
    return new Response(f, { status: 200 });
  }
  if (u.includes('/2/files/delete_v2')) {
    if (DBX.deleteFails) return new Response('error', { status: 500 });
    /* 409 is Dropbox's "already gone", which the Worker treats as success when
       it is the one doing the removing. */
    return new Response('{}', { status: DBX.files.delete(JSON.parse(init.body).path) ? 200 : 409 });
  }
  return new Response('{}', { status: 200 });
}

const REAL_FETCH = globalThis.fetch;
globalThis.fetch = async (url, init) => (await fakeDropbox(url, init)) || REAL_FETCH(url, init);

/* --------------------------------------------------------------- request kit */

const API = 'https://portal.example.workers.dev';
function req(p, { method = 'GET', body, cookie, headers = {}, origin = ORIGIN } = {}) {
  const h = { Origin: origin, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  return new Request(API + p, {
    method, headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}
const call = (env, p, opts) => worker.fetch(req(p, opts), env);
async function jsonOf(res) { try { return await res.json(); } catch { return {}; } }
function cookieFrom(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie()[0] : res.headers.get('Set-Cookie');
  return sc ? sc.split(';')[0] : '';
}

async function bootstrapAdmin(env) {
  const res = await call(env, '/setup', {
    method: 'POST',
    headers: { 'X-Bootstrap-Token': env.BOOTSTRAP_TOKEN },
    body: { username: 'trever', display_name: 'Trever', password: 'FirstAdminPass1' },
  });
  return res;
}
async function login(env, username, password) {
  const res = await call(env, '/auth/login', { method: 'POST', body: { username, password } });
  return { res, cookie: cookieFrom(res) };
}
async function ingest(env, payload) {
  return call(env, '/ingest', {
    method: 'POST', headers: { 'X-Ingest-Key': env.INGEST_KEY }, body: payload,
  });
}

/* A STORED VIDEO EVIDENCE ROW, planted straight into the database.

   Since 2026-08-17 video is device-first and `uploadEvidence` refuses a new
   `video/*` upload outright — but legacy video already in R2 was deliberately
   left untouched, so rows shaped exactly like this still exist and every rule
   downstream of them must still be right: the package type's video gate, the
   build item's role, the gallery. Planting it is not a way round the refusal;
   it IS the legacy case, and it is the only way that case can be reached now. */
async function plantLegacyVideo(env, caseNo, filename, cls = 'client_deliverable', bytes = 900) {
  const r = await env.DB.prepare(
    `INSERT INTO case_evidence (case_no, r2_key, filename, content_type, size_bytes,
       classification, uploaded_at) VALUES (?, ?, ?, 'video/mp4', ?, ?, ?)`)
    .bind(caseNo, `cases/${caseNo}/legacy-${filename}`, filename, bytes, cls,
          new Date().toISOString()).run();
  return r.meta.last_row_id;
}

/* ------------------------------------------------------------------- setup */

section('Setup and first admin');
{
  const env = freshEnv();
  let res = await call(env, '/health');
  ok('health reports configured', (await jsonOf(res)).configured === true);

  res = await call(env, '/setup', {
    method: 'POST', headers: { 'X-Bootstrap-Token': 'wrong' },
    body: { username: 'x', password: 'Password12345' },
  });
  ok('bootstrap rejects a bad token', res.status === 401);

  res = await bootstrapAdmin(env);
  ok('bootstrap creates the first admin', res.status === 201);

  res = await bootstrapAdmin(env);
  ok('bootstrap refuses once an account exists', res.status === 409);
}

/* ------------------------------------------------------------------- login */

section('Login');
{
  const env = freshEnv();
  await bootstrapAdmin(env);

  let { res, cookie } = await login(env, 'trever', 'FirstAdminPass1');
  ok('correct credentials sign in', res.status === 200 && cookie.startsWith('api_portal='));
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie()[0] : res.headers.get('Set-Cookie');
  ok('session cookie is HttpOnly, Secure and SameSite=Strict',
     /HttpOnly/.test(sc) && /Secure/.test(sc) && /SameSite=Strict/.test(sc));

  res = await call(env, '/auth/me', { cookie });
  ok('the cookie identifies the caller', (await jsonOf(res)).user.username === 'trever');

  res = await call(env, '/auth/me');
  ok('no cookie means not signed in', res.status === 401);

  const bad = await login(env, 'trever', 'WrongPassword99');
  const missing = await login(env, 'nobody-here', 'WrongPassword99');
  ok('a wrong password is refused', bad.res.status === 401);
  ok('an unknown user gives the identical answer (no account enumeration)',
     missing.res.status === bad.res.status &&
     (await jsonOf(missing.res)).error === (await jsonOf(bad.res)).error);

  res = await call(env, '/auth/logout', { method: 'POST', cookie });
  ok('logout succeeds', res.status === 200);
  res = await call(env, '/auth/me', { cookie });
  ok('the session is dead after logout', res.status === 401);
}

section('Login throttling');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  for (let i = 0; i < 8; i++) await login(env, 'trever', 'DefinitelyWrong1');
  const { res } = await login(env, 'trever', 'FirstAdminPass1');
  ok('locks out after 8 failures, even with the right password', res.status === 429);

  const other = freshEnv();
  await bootstrapAdmin(other);
  for (let i = 0; i < 7; i++) await login(other, 'trever', 'DefinitelyWrong1');
  const good = await login(other, 'trever', 'FirstAdminPass1');
  ok('7 failures still allows a correct login', good.res.status === 200);
  const after = await login(other, 'trever', 'DefinitelyWrong1');
  ok('a successful login clears the failure count', after.res.status === 401);
}

/* ------------------------------------------------------------------ ingest */

section('Submission ingest');
{
  const env = freshEnv();
  let res = await ingest(env, { case_no: 'API-1', client_name: 'Jane' });
  ok('a valid submission is stored', res.status === 200);

  res = await call(env, '/ingest', { method: 'POST', body: { case_no: 'API-2' } });
  ok('ingest without the key is refused', res.status === 401);

  res = await call(env, '/ingest', {
    method: 'POST', headers: { 'X-Ingest-Key': 'wrong-key' }, body: { case_no: 'API-3' },
  });
  ok('ingest with the wrong key is refused', res.status === 401);

  res = await ingest(env, { client_name: 'No case number' });
  ok('a submission without a case number is refused', res.status === 400);

  res = await ingest(env, { case_no: 'API-1', client_name: 'Jane again' });
  ok('a duplicate case number is accepted quietly, not an error',
     res.status === 200 && (await jsonOf(res)).duplicate === true);

  res = await call(env, '/ingest', {
    method: 'POST', headers: { 'X-Ingest-Key': env.INGEST_KEY },
    body: JSON.stringify({ case_no: 'API-BIG', blob: 'x'.repeat(600_000) }),
  });
  ok('an oversized payload is rejected', res.status === 413);

  await ingest(env, { case_no: 'API-C1', carrier: 'Example Mutual', claim_number: 'WC-1' });
  await ingest(env, { case_no: 'API-P1', client_name: 'Consumer Person' });
  await bootstrapAdmin(env);
  const { cookie } = await login(env, 'trever', 'FirstAdminPass1');
  const list = await jsonOf(await call(env, '/submissions', { cookie }));
  const byCase = Object.fromEntries(list.submissions.map(s => [s.case_no, s]));
  ok('a submission with a claim number is classified as a claim', byCase['API-C1'].kind === 'claims');
  ok('a submission without one is classified as consumer', byCase['API-P1'].kind === 'consumer');
}

/* ------------------------------------------------- roles and case visibility */

async function invite(env, cookie, body) {
  return call(env, '/invites', { method: 'POST', cookie, body });
}

section('Roles and case visibility');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  let res = await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' });
  ok('an admin can invite an investigator', res.status === 201);
  const link = (await jsonOf(res)).url;
  const token = new URL(link, 'https://x.test').searchParams.get('invite');
  res = await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  ok('the invitee sets their own password and the account is created', res.status === 201);

  await ingest(env, { case_no: 'API-A', client_name: 'Assigned Case' });
  await ingest(env, { case_no: 'API-B', client_name: 'Other Case' });

  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const dana = users.users.find(u => u.username === 'dana');

  res = await call(env, `/submissions/API-A/assign`, { method: 'POST', cookie: admin, body: { user_id: dana.id } });
  ok('an admin can assign a case', res.status === 200 && (await jsonOf(res)).status === 'assigned');

  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const invList = await jsonOf(await call(env, '/submissions', { cookie: inv }));
  ok('an investigator sees only their assigned case',
     invList.submissions.length === 1 && invList.submissions[0].case_no === 'API-A');
  ok('the investigator total reflects their scope, not the whole table', invList.total === 1);

  const adminList = await jsonOf(await call(env, '/submissions', { cookie: admin }));
  ok('an admin sees every case', adminList.total === 2);

  ok('an investigator cannot open a case they were not assigned',
     (await call(env, '/submissions/API-B', { cookie: inv })).status === 404);
  ok('an investigator can open their own case',
     (await call(env, '/submissions/API-A', { cookie: inv })).status === 200);
  ok('an investigator cannot list staff accounts',
     (await call(env, '/users', { cookie: inv })).status === 403);
  ok('an investigator cannot issue invitations',
     (await invite(env, inv, { username: 'sneak', role: 'admin' })).status === 403);
  ok('an investigator cannot assign cases',
     (await call(env, '/submissions/API-B/assign', { method: 'POST', cookie: inv, body: { user_id: dana.id } })).status === 403);
}

/* --------------------------------------------------- the commercial boundary */

/* An investigator gets the fieldwork and nothing that identifies who is paying
   for it. Everything below is what someone would need to solicit the client
   directly, so it must not leave the Worker for a non-admin caller. */
section('An investigator is not sent the client');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const token = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });

  await ingest(env, {
    case_no: 'API-C', service: 'Insurance Claim Assignment',
    carrier: 'Example Mutual Insurance', claim_number: 'WC-2026-88421', policy_number: 'POL-77123',
    claim_type: "Workers' compensation", date_of_loss: '03/14/2026',
    adjuster: 'Dana Reyes', adjuster_email: 'dreyes@examplemutual.com', adjuster_phone: '5405550173',
    defense_counsel: 'Poe & Marsden', prior_surveillance: 'Yes — by another vendor',
    client_name: 'Dana Reyes', client_phone: '5405550173', client_email: 'dreyes@examplemutual.com',
    subject_name: 'Pat Coleman', subject_address: '2214 Old Forest Rd',
    subject_description: 'White GMC Sierra', subject_relationship: 'Lumbar strain; no lifting over 10 lbs',
    objective: 'Activity level versus stated restrictions', authorized_hours: '8 hours',
    timeline: 'Hearing 9/12', notes: 'Neighbour is a retired deputy', attachments: 'claim-file.pdf',
    billing_reference: 'PO-77412', billing_email: 'ap@examplemutual.com', billing_notes: 'PO on the invoice',
    signed_name: 'Dana Reyes', payment_method: 'Invoiced to carrier', fee_due: 0,
    signature: 'data:image/png;base64,iVBORw0KGgo=',
  });

  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const dana = users.users.find(u => u.username === 'dana');
  await call(env, '/submissions/API-C/assign', { method: 'POST', cookie: admin, body: { user_id: dana.id } });

  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const detail = await jsonOf(await call(env, '/submissions/API-C', { cookie: inv }));
  const seen = JSON.stringify(detail);

  for (const [what, value] of Object.entries({
    'the carrier': 'Example Mutual Insurance',
    'the claim number': 'WC-2026-88421',
    'the policy number': 'POL-77123',
    'the adjuster': 'Dana Reyes',
    "the adjuster's email": 'dreyes@examplemutual.com',
    "the adjuster's phone": '5405550173',
    'defense counsel': 'Poe & Marsden',
    'the billing reference': 'PO-77412',
    'the billing contact': 'ap@examplemutual.com',
    'the signature': 'iVBORw0KGgo=',
  })) ok(`an investigator is not sent ${what}`, !seen.includes(value), value);

  ok('the raw payload column is not passed through either', typeof detail.submission.payload === 'object');
  ok('an investigator is sent the subject', detail.submission.payload.subject_name === 'Pat Coleman');
  ok('an investigator is sent the address to watch', detail.submission.payload.subject_address === '2214 Old Forest Rd');
  ok('an investigator is sent the vehicle', detail.submission.payload.subject_description === 'White GMC Sierra');
  ok('an investigator is sent the restrictions', /Lumbar strain/.test(detail.submission.payload.subject_relationship));
  ok('an investigator is sent the scope', /Activity level/.test(detail.submission.payload.objective));
  ok('an investigator is sent the authorized hours', detail.submission.payload.authorized_hours === '8 hours');
  ok('an investigator is sent the deadline', detail.submission.payload.timeline === 'Hearing 9/12');
  ok('an investigator is sent the field notes', /retired deputy/.test(detail.submission.payload.notes));
  ok('an investigator is still told the case number', detail.submission.case_no === 'API-C');
  ok('an investigator is still told the status', detail.submission.status === 'assigned');

  const list = JSON.stringify(await jsonOf(await call(env, '/submissions', { cookie: inv })));
  ok('the list is redacted too, not only the detail',
     !list.includes('Example Mutual Insurance') && !list.includes('WC-2026-88421'));
  ok('the list still names the subject', list.includes('Pat Coleman'));

  // The admin's own view is untouched — this is a per-role filter, not deletion.
  const adminView = JSON.stringify(await jsonOf(await call(env, '/submissions/API-C', { cookie: admin })));
  ok('an admin still sees the carrier', adminView.includes('Example Mutual Insurance'));
  ok('an admin still sees the claim number', adminView.includes('WC-2026-88421'));
  ok('an admin still sees the billing reference', adminView.includes('PO-77412'));
  ok('an admin still sees the signature', adminView.includes('iVBORw0KGgo='));

  // A field nobody has classified yet must default to admin-only. This is the
  // difference between an allow-list and a delete-list, and it is the whole
  // reason for the former.
  await ingest(env, {
    case_no: 'API-D', client_name: 'New Client', subject_name: 'Watch Me',
    some_future_field: 'CARRIER-CONFIDENTIAL',
  });
  await call(env, '/submissions/API-D/assign', { method: 'POST', cookie: admin, body: { user_id: dana.id } });
  const future = JSON.stringify(await jsonOf(await call(env, '/submissions/API-D', { cookie: inv })));
  ok('a field added to the intake later does not leak by default',
     !future.includes('CARRIER-CONFIDENTIAL'));

  /* INTAKE-NA: a partial assignment ingests, and its availability statuses
     obey the same wall as the values they describe. An investigator needs to
     know the address is not known yet — that is fieldwork. Whether the CLAIM
     NUMBER or the BILLING CONTACT is known is the office's business. */
  await ingest(env, {
    case_no: 'API-NA1', carrier: 'Urgent Mutual', client_name: 'A. Adjuster',
    subject_name: 'Pat Claimant', objective: 'Activity versus restrictions',
    claim_number: '', claim_number_status: 'not_available',
    date_of_loss: '', date_of_loss_status: 'unknown',
    subject_address: '', subject_address_status: 'not_available',
    subject_description: '', subject_description_status: 'not_available',
    authorized_hours: 'Authorization pending', authorized_hours_status: 'pending',
    start_date: '', start_date_status: 'flexible',
    billing_email: '', billing_email_status: 'not_available',
  });
  const naAdmin = await jsonOf(await call(env, '/submissions/API-NA1', { cookie: admin }));
  ok('an intake with no claim number is accepted, not refused',
     naAdmin.submission && naAdmin.submission.case_no === 'API-NA1');
  ok('the office sees every status', naAdmin.submission.payload.claim_number_status === 'not_available'
     && naAdmin.submission.payload.billing_email_status === 'not_available');
  ok('and no fake value was stored in its place', !naAdmin.submission.payload.claim_number);

  await call(env, '/submissions/API-NA1/assign', { method: 'POST', cookie: admin, body: { user_id: dana.id } });
  const naInv = await jsonOf(await call(env, '/submissions/API-NA1', { cookie: inv }));
  const naKept = naInv.submission.payload;
  ok('the field is told the address is not known yet',
     naKept.subject_address_status === 'not_available');
  ok('and that the vehicle is not known yet',
     naKept.subject_description_status === 'not_available');
  ok('and that the authorization is still pending',
     naKept.authorized_hours_status === 'pending');
  ok('and that the start is flexible', naKept.start_date_status === 'flexible');
  ok('but never whether the CLAIM NUMBER is known — that names the carrier',
     naKept.claim_number_status === undefined);
  ok('nor anything about the billing contact',
     naKept.billing_email_status === undefined);
}

/* ------------------------------------------------------------- pricing */

/* Carrier rates are internal. They are not published, and the endpoint that
   holds them is admin-only — an investigator knowing the billing rate is how a
   rate sheet reaches a competitor. */
section('Internal rates are admin-only');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const token = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  ok('an investigator cannot read the rate card',
     (await call(env, '/pricing', { cookie: inv })).status === 403);
  ok('a signed-out visitor cannot read the rate card',
     (await call(env, '/pricing')).status === 401);

  const res = await call(env, '/pricing', { cookie: admin });
  ok('an admin can read the rate card', res.status === 200);
  const d = await jsonOf(res);
  ok('the standard surveillance rate is $150/hr', d.rates.surveillance.standard === 150);
  ok('the surveillance day minimum is 8 hours', d.rates.surveillance.minHoursPerDay === 8);
  ok('the typical initial authorization is 24 hours', d.rates.surveillance.typicalAuthHours === 24);
  ok('the preferred-volume band is 135–150', d.rates.surveillance.volumeMin === 135 && d.rates.surveillance.volumeMax === 150);
  ok('the floor is 125', d.rates.surveillance.floor === 125);
  ok('rush and holiday multipliers are configured',
     d.rates.multipliers.rush === 1.25 && d.rates.multipliers.holiday === 1.5);
  ok('testimony is rated separately', d.rates.services.testimony[0] === 200);
  ok('nothing is billed on top of the quoted price', d.rates.expenses.billedSeparately === false);
  ok('mileage is inside the block', d.rates.expenses.includedInBlock.includes('Mileage'));
  ok('travel time is inside the block', d.rates.expenses.includedInBlock.includes('Travel time'));
  ok('report writing is inside the block', d.rates.expenses.includedInBlock.includes('Report writing'));
  ok('out-of-area travel is quoted up front, not added later',
     /before the assignment is accepted/.test(d.rates.expenses.outsideServiceArea));
  ok('reporting counts as billable investigator time',
     d.rates.billableAsInvestigatorTime.includes('Report writing'));
  ok('the authorization presets are 8, 16 and 24 hours',
     JSON.stringify(d.auth_presets) === JSON.stringify([8, 16, 24]));

  // The number the handoff exists to protect: 24 hours at the standard rate.
  const q = await jsonOf(await call(env, '/pricing?hours=24', { cookie: admin }));
  ok('a 3-day authorization quotes at $3,600', q.quote.subtotal === 3600);
  ok('and it is not flagged as below the band', q.quote.belowVolumeBand === false);

  const vol = await jsonOf(await call(env, '/pricing?hours=24&rate=135', { cookie: admin }));
  ok('the bottom of the volume band quotes at $3,240', vol.quote.subtotal === 3240);
  ok('a volume rate is not below the floor', vol.quote.belowFloor === false);

  const cheap = await jsonOf(await call(env, '/pricing?hours=24&rate=100', { cookie: admin }));
  ok('$100/hr is flagged as below the floor', cheap.quote.belowFloor === true);
  ok('the $800/day the handoff rejects quotes at $2,400', cheap.quote.subtotal === 2400);

  const rush = await jsonOf(await call(env, '/pricing?hours=8', { cookie: admin }));
  ok('a rush day applies the 1.25x multiplier', rush.quote.rush === 1500);
  ok('a bad hours value yields no quote',
     (await jsonOf(await call(env, '/pricing?hours=abc', { cookie: admin }))).quote === null);

  /* The flat-fee carrier ladder. */
  const pk = d.packages;
  ok('three blocks are offered', pk.length === 3);
  ok('the blocks match the authorization presets the form offers',
     JSON.stringify(pk.map(p => p.hours)) === JSON.stringify(d.auth_presets));
  ok('one day is $1,200', pk[0].price === 1200 && pk[0].hours === 8);
  ok('two days is $2,300', pk[1].price === 2300 && pk[1].hours === 16);
  ok('three days is $3,300', pk[2].price === 3300 && pk[2].hours === 24);
  ok('the one-day block is at the standard rate', pk[0].effective === 150);
  ok('two days works out at $143.75/hr', pk[1].effective === 143.75);
  ok('three days works out at $137.50/hr', pk[2].effective === 137.5);
  ok('the three-day block saves the carrier $300 against standard', pk[2].savingVsStandard === 300);
  ok('the three-day block stays inside the preferred-volume band', pk[2].belowVolumeBand === false);

  /* THE GUARD. A block priced below the floor is the mistake this whole rate
     strategy exists to prevent, and a round number can hide it — $2,600 for
     three days reads fine and is $108.33/hr. If someone re-prices the ladder,
     this fails rather than quietly shipping a discount nobody approved. */
  for (const p of pk) {
    ok(`${p.hours}h is not below the $${RATES_FLOOR} floor`, p.belowFloor === false,
       `$${p.price} = $${p.effective}/hr`);
    ok(`${p.hours}h is at or above the floor by arithmetic too`,
       p.price / p.hours >= RATES_FLOOR, `$${p.price / p.hours}/hr`);
  }
  ok('the floor the blocks are checked against is still $125', d.rates.surveillance.floor === 125);

  // The rejected draft, asserted so the reasoning survives in the tests.
  ok('the 1000/1800/2600 draft would have breached the floor twice',
     1000 / 8 >= RATES_FLOOR && 1800 / 16 < RATES_FLOOR && 2600 / 24 < RATES_FLOOR);
  ok('and would have cost $1,000 a case against standard on a 3-day',
     (150 * 24) - 2600 === 1000);

  /* The blocks absorb travel now, so the floor has to survive that too — an
     all-in price is only affordable if it is priced for it. Roughly 60 miles a
     day at the internal costing rate. */
  const mile = d.rates.expenses.mileagePerMile;
  for (const p of pk) {
    const absorbed = (p.hours / 8) * 60 * mile;
    ok(`${p.hours}h still clears the floor after absorbing travel`,
       (p.price - absorbed) / p.hours >= RATES_FLOOR,
       `$${((p.price - absorbed) / p.hours).toFixed(2)}/hr`);
  }
  ok('the rejected $2,600 draft would NOT have cleared it after travel',
     (2600 - (3 * 60 * mile)) / 24 < RATES_FLOOR);
}

/* ------------------------------------------------------- invitation-only */

section('Invitation-only account creation');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  ok('there is no public route that creates an account',
     (await call(env, '/users', { method: 'POST', body: { username: 'walkin', password: 'Password1234' } })).status === 401);
  ok('not even an admin can create an account directly — only invite',
     (await call(env, '/users', { method: 'POST', cookie: admin, body: { username: 'walkin', password: 'Password1234' } })).status === 404);
  ok('an anonymous visitor cannot issue an invitation',
     (await invite(env, undefined, { username: 'walkin', role: 'admin' })).status === 401);

  let res = await invite(env, admin, { username: 'pat', display_name: 'Pat', email: 'pat@example.com', role: 'investigator' });
  ok('an invitation is issued', res.status === 201);
  const body = await jsonOf(res);
  const token = new URL(body.url, 'https://x.test').searchParams.get('invite');
  ok('the invitation link carries a 64-hex token', /^[0-9a-f]{64}$/.test(token));
  ok('the link points at the portal page', body.url.includes('/portal/?invite='));

  const pending = await jsonOf(await call(env, '/invites', { cookie: admin }));
  ok('the invitation shows as pending', pending.invites.some(i => i.username === 'pat'));
  ok('the stored invitation never exposes the token',
     pending.invites.every(i => !('token_hash' in i) && !JSON.stringify(i).includes(token)));

  res = await call(env, `/invite/${token}`);
  ok('the acceptance page can look the invitation up', (await jsonOf(res)).valid === true);
  res = await call(env, `/invite/${'a'.repeat(64)}`);
  ok('an unknown token is not valid', res.status === 404);

  ok('a weak password is refused at acceptance',
     (await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'short' } })).status === 400);

  res = await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'ChosenByPat1x' } });
  ok('accepting creates the account', res.status === 201);
  ok('accepting signs them straight in', cookieFrom(res).startsWith('api_portal='));
  ok('the new account can sign in with the password they chose',
     (await login(env, 'pat', 'ChosenByPat1x')).res.status === 200);

  ok('the invitation cannot be redeemed twice',
     (await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'SomeoneElse1x' } })).status === 404);
  const after = await jsonOf(await call(env, '/invites', { cookie: admin }));
  ok('a redeemed invitation leaves the pending list', !after.invites.some(i => i.username === 'pat'));

  ok('inviting a username that already exists is refused',
     (await invite(env, admin, { username: 'pat', role: 'investigator' })).status === 409);
  ok('a malformed username is refused',
     (await invite(env, admin, { username: 'has spaces', role: 'investigator' })).status === 400);
  ok('an invalid role is refused',
     (await invite(env, admin, { username: 'newbie', role: 'superuser' })).status === 400);
  ok('a malformed email is refused',
     (await invite(env, admin, { username: 'newbie', role: 'investigator', email: 'not-an-email' })).status === 400);

  res = await invite(env, admin, { username: 'gone', role: 'investigator' });
  const goneTok = new URL((await jsonOf(res)).url, 'https://x.test').searchParams.get('invite');
  const list = await jsonOf(await call(env, '/invites', { cookie: admin }));
  const goneId = list.invites.find(i => i.username === 'gone').id;
  ok('an admin can revoke an invitation',
     (await call(env, `/invites/${goneId}/revoke`, { method: 'POST', cookie: admin })).status === 200);
  ok('a revoked invitation stops working',
     (await call(env, `/invite/${goneTok}/accept`, { method: 'POST', body: { password: 'TooLate1234x' } })).status === 404);

  res = await invite(env, admin, { username: 'twice', role: 'investigator' });
  const t1 = new URL((await jsonOf(res)).url, 'https://x.test').searchParams.get('invite');
  res = await invite(env, admin, { username: 'twice', role: 'investigator' });
  const t2 = new URL((await jsonOf(res)).url, 'https://x.test').searchParams.get('invite');
  ok('reissuing an invitation invalidates the previous link',
     (await call(env, `/invite/${t1}`)).status === 404 && (await call(env, `/invite/${t2}`)).status === 200);
}

/* ---------------------------------------------------------- account handling */

section('Account handling');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const res0 = await invite(env, admin, { username: 'pat', display_name: 'Pat', role: 'investigator' });
  const tok = new URL((await jsonOf(res0)).url, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tok}/accept`, { method: 'POST', body: { password: 'ChosenByPat1x' } });

  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  ok('the account list never exposes hashes',
     users.users.every(u => !('pass_hash' in u) && !('pass_salt' in u)));
  const pat = users.users.find(u => u.username === 'pat');

  const patCookie = (await login(env, 'pat', 'ChosenByPat1x')).cookie;
  let res = await call(env, `/users/${pat.id}/active`, { method: 'POST', cookie: admin, body: { active: false } });
  ok('an admin can disable an account', res.status === 200);
  ok("disabling ends that account's live session",
     (await call(env, '/auth/me', { cookie: patCookie })).status === 401);
  ok('a disabled account cannot sign back in',
     (await login(env, 'pat', 'ChosenByPat1x')).res.status === 401);

  const me = await jsonOf(await call(env, '/auth/me', { cookie: admin }));
  const selfId = (await jsonOf(await call(env, '/users', { cookie: admin }))).users
    .find(u => u.username === me.user.username).id;
  ok('an admin cannot lock themselves out',
     (await call(env, `/users/${selfId}/active`, { method: 'POST', cookie: admin, body: { active: false } })).status === 400);

  await call(env, `/users/${pat.id}/active`, { method: 'POST', cookie: admin, body: { active: true } });
  const patAgain = (await login(env, 'pat', 'ChosenByPat1x')).cookie;
  res = await call(env, `/users/${pat.id}/password`, { method: 'POST', cookie: admin, body: { password: 'BrandNewPass1x' } });
  ok('an admin can reset a password', res.status === 200);
  ok('a password reset ends existing sessions',
     (await call(env, '/auth/me', { cookie: patAgain })).status === 401);
  ok('the old password stops working', (await login(env, 'pat', 'ChosenByPat1x')).res.status === 401);
  ok('the new password works', (await login(env, 'pat', 'BrandNewPass1x')).res.status === 200);
  ok('an investigator cannot reset anyone\'s password',
     (await call(env, `/users/${selfId}/password`, {
       method: 'POST', cookie: (await login(env, 'pat', 'BrandNewPass1x')).cookie, body: { password: 'Hijacked123x' },
     })).status === 403);
}

/* -------------------------------------------------- security regressions */

section('Security regressions');
{
  const env = freshEnv();
  env.INGEST_PER_MINUTE = '500';   // the rate limit has its own block below

  // A case number is rendered in the admin's browser. It must not be able to
  // carry a quote, an angle bracket, or anything else that leaves plain text.
  const hostile = [
    "x'); alert(1); ('",
    '<script>alert(1)</script>',
    'x" onmouseover="alert(1)',
    'x\\u0027);fetch(\\u0027//evil\\u0027);(\\u0027',
    'a'.repeat(200),
    'sp ace',
  ];
  let allRejected = true;
  for (const c of hostile) {
    const res = await ingest(env, { case_no: c, client_name: 'x' });
    if (res.status !== 400) allRejected = false;
  }
  ok('every hostile case number is rejected at ingest', allRejected);
  ok('a well-formed case number is still accepted',
     (await ingest(env, { case_no: 'API-20260812-4118', client_name: 'x' })).status === 200);

  // The route parameter is pinned to the same alphabet.
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  ok('a hostile case number in the URL does not reach a query',
     (await call(env, '/submissions/' + encodeURIComponent("x'); drop--"), { cookie: admin })).status === 404);

  // Rate limiting is real, not just claimed in a comment.
  const env2 = freshEnv();
  let limited = false;
  for (let i = 0; i < 8; i++) {
    const r = await ingest(env2, { case_no: `API-RATE-${i}`, client_name: 'x' });
    if (r.status === 429) limited = true;
  }
  ok('ingest is rate limited once the cap is passed', limited);

  // Oversize is refused on the declared length, before the body is read.
  const big = await call(env, '/ingest', {
    method: 'POST',
    headers: { 'X-Ingest-Key': env.INGEST_KEY, 'Content-Length': String(9 * 1024 * 1024) },
    body: JSON.stringify({ case_no: 'API-DECLARED' }),
  });
  ok('an oversized Content-Length is refused up front', big.status === 413);
}

/* ------------------------------------------------------- invitation email */

section('Invitation email');
{
  // Stand in for the provider so nothing leaves the test, and so a rejection
  // or an outage can be simulated exactly.
  const realFetch = globalThis.fetch;
  let sentTo = null, lastBody = null, mode = 'ok';
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      lastBody = JSON.parse(init.body);
      sentTo = lastBody.to;
      if (mode === 'reject') return new Response('{"message":"domain not verified"}', { status: 403 });
      if (mode === 'throw') throw new Error('network down');
      return new Response('{"id":"re_123"}', { status: 200 });
    }
    return realFetch(url, init);
  };

  const withMail = () => {
    const e = freshEnv();
    e.RESEND_API_KEY = 'test-resend-key';
    e.INVITE_FROM = 'Always Precise <portal@example.test>';
    return e;
  };
  const adminOf = async (env) => {
    await bootstrapAdmin(env);
    return (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  };

  {
    sentTo = null; mode = 'ok';
    const env = withMail(); const admin = await adminOf(env);
    const res = await call(env, '/invites', { method: 'POST', cookie: admin,
      body: { username: 'dana', display_name: 'Dana Field', email: 'dana@example.test', role: 'investigator' } });
    const body = await jsonOf(res);
    ok('an invitation with an address is emailed', body.emailed === true);
    ok('it goes to the address given', sentTo === 'dana@example.test');
    ok('the configured From address is used', lastBody.from === 'Always Precise <portal@example.test>');
    ok('the email carries the invitation link', lastBody.text.includes(body.url));
    ok('the HTML part carries it too', lastBody.html.includes(body.url));
    ok('the email names who invited them', lastBody.text.includes('Trever'));
    ok('the API key is never in the message body',
       !JSON.stringify(lastBody).includes('test-resend-key'));
    ok('the link still comes back to the admin as well', typeof body.url === 'string' && body.url.includes('invite='));
  }

  {
    sentTo = null; mode = 'ok';
    const env = withMail(); const admin = await adminOf(env);
    const res = await call(env, '/invites', { method: 'POST', cookie: admin,
      body: { username: 'noaddr', role: 'investigator' } });
    ok('an invitation with no address is still created', res.status === 201);
    ok('nothing is sent when no address was given', sentTo === null);
    ok('and it says so', (await jsonOf(res)).emailed === false);
  }

  {
    sentTo = null; mode = 'ok';
    const env = freshEnv();            // no RESEND_API_KEY at all
    const admin = await adminOf(env);
    const res = await call(env, '/invites', { method: 'POST', cookie: admin,
      body: { username: 'pat', email: 'pat@example.test', role: 'investigator' } });
    const body = await jsonOf(res);
    ok('with sending unconfigured the invitation still works', res.status === 201);
    ok('nothing is sent', sentTo === null);
    ok('unconfigured is reported, not treated as an error', body.email_status === 'not_configured');
    ok('the admin still gets a usable link', body.url.includes('invite='));
  }

  {
    mode = 'reject';
    const env = withMail(); const admin = await adminOf(env);
    const res = await call(env, '/invites', { method: 'POST', cookie: admin,
      body: { username: 'rej', email: 'rej@example.test', role: 'investigator' } });
    const body = await jsonOf(res);
    ok('a provider rejection does not fail the invitation', res.status === 201);
    ok('the rejection is reported', body.emailed === false && body.email_status === 'rejected');
    ok('the link is returned so it can be sent by hand', body.url.includes('invite='));
    const check = await call(env, `/invite/${new URL(body.url, 'https://x.test').searchParams.get('invite')}`);
    ok('and the invitation is genuinely usable', (await jsonOf(check)).valid === true);
  }

  {
    mode = 'throw';
    const env = withMail(); const admin = await adminOf(env);
    const res = await call(env, '/invites', { method: 'POST', cookie: admin,
      body: { username: 'down', email: 'down@example.test', role: 'investigator' } });
    const body = await jsonOf(res);
    ok('a provider outage does not fail the invitation', res.status === 201);
    ok('the outage is reported', body.email_status === 'unreachable');
    ok('the link is still returned', body.url.includes('invite='));
  }

  {
    mode = 'ok';
    const env = withMail();
    ok('health reports that sending is configured',
       (await jsonOf(await call(env, '/health'))).email === true);
    ok('health reports when it is not',
       (await jsonOf(await call(freshEnv(), '/health'))).email === false);
  }

  globalThis.fetch = realFetch;
}

/* ------------------------------------------------- origin guard and headers */

section('Rate sheets and the emailed quote');
{
  // Same provider stand-in as the invitation tests: nothing leaves the run.
  const realFetch = globalThis.fetch;
  let lastBody = null, providerCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      providerCalls++; lastBody = JSON.parse(init.body);
      return new Response('{"id":"re_1"}', { status: 200 });
    }
    return realFetch(url, init);
  };

  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  env.MAIL_PER_MINUTE = '3';
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  const d = await jsonOf(await call(env, '/sheets', { cookie: admin }));
  ok('exactly two sheets exist', d.sheets.length === 2);

  /* TWO SEPARATE PRODUCTS (RATESHEETS.md): retainer+hourly vs
     package/authorization. Separate ids, separate types, separate copy. */
  const priv = d.sheets.find(s => s.id === 'private_retainer');
  const insSheet = d.sheets.find(s => s.id === 'insurance_assignment');
  ok('the private sheet is the retainer model', priv && priv.type === 'retainer'
     && priv.name === '$1,500 Retainer');
  ok('the carrier sheet is the package model', insSheet && insSheet.type === 'package'
     && insSheet.name === 'Insurance Assignment Rates');
  ok('the selector labels are unmistakable',
     priv.selector_label === 'Private Client — $1,500 Retainer'
     && insSheet.selector_label === 'Insurance Assignment Rates');

  const privJson = JSON.stringify(priv), ins = JSON.stringify(insSheet);
  ok('the retainer is a deposit against the work, in so many words',
     priv.summary.includes('applied directly to authorized investigative services'));
  ok('the private sheet carries the retainer and the hourly rate',
     privJson.includes('$1,500') && privJson.includes('$100/hr'));
  ok('and says what consumes retainer time — report prep included',
     privJson.includes('report preparation') && privJson.includes('applied against your authorized retainer'));
  ok('testimony is separately arranged, never bundled into the rate',
     priv.closing.includes('separately arranged'));
  ok('the carrier sheet carries the whole ladder',
     ins.includes('$1,200') && ins.includes('$2,300') && ins.includes('$3,300'));
  ok('the carrier sheet states the overage rate', ins.includes('$150/hr'));
  ok('the three-day block wears the recommendation badge',
     insSheet.lines.find(l => l.value === '$3,300').badge === 'Recommended initial authorization');
  ok('and no other line does',
     insSheet.lines.filter(l => l.badge).length === 1);

  /* Never cross the streams: no package price on the private sheet, no
     retainer on the carrier sheet. */
  ok('the retainer figure is not on the carrier sheet', !ins.includes('$1,500'));
  ok('no package price is on the private sheet',
     !privJson.includes('$1,200') && !privJson.includes('$2,300') && !privJson.includes('$3,300'));

  /* "Additional fees — None" is gone from BOTH, replaced by the included
     language. The old presentation listed eight things only to say "None". */
  for (const [label, sh] of [['private', priv], ['carrier', insSheet]]) {
    ok(`no "Additional fees — None" presentation on the ${label} sheet`,
       !sh.lines.some(l => /additional fees/i.test(l.label) || l.value === 'None'));
    ok(`the ${label} sheet says routine costs are included instead`,
       sh.lines.some(l => l.value === 'No routine add-on fees'));
    ok(`the ${label} sheet quotes outside-area travel in advance`,
       sh.lines.some(l => l.value === 'Quoted in advance'));
    ok(`the ${label} sheet has its confirmation line`, !!sh.closing_title
       && sh.closing_title.includes('No surprise billing'));
  }

  /* Internal strategy never reaches a client-facing sheet. */
  ok('no internal pricing language on either sheet',
     !JSON.stringify(d.sheets).match(/rack|volume band|below standard|below the standard|floor|margin|discount|competitor|investigator pay|profit/i),
     JSON.stringify(d.sheets).match(/rack|volume band|below standard|below the standard|floor|margin|discount|competitor|investigator pay|profit/i)?.[0]);

  ok('whether sending is configured is reported', d.email_configured === true);

  /* A dollar sign on an hours figure reads as a price and is wrong twice over:
     it misstates the minimum day and it puts a number where a carrier expects
     a duration. It shipped once as "$8-hour minimum day". */
  ok('the minimum day is stated in hours, not dollars',
     insSheet.summary.includes('8-hour day is the minimum') && !insSheet.summary.includes('$8'),
     insSheet.summary);
  ok('the initial authorization is stated in hours',
     insSheet.summary.includes('24 hours is the typical'), insSheet.summary);
  ok('no hours figure anywhere on either sheet carries a dollar sign',
     !JSON.stringify(d.sheets).match(/\$\d+(\.\d+)?\s*-?\s*hour/i),
     JSON.stringify(d.sheets).slice(0, 300));

  ok('an unknown sheet id is a 404',
     (await call(env, '/sheets/nope/email', { method: 'POST', cookie: admin, body: { to: 'a@b.co' } })).status === 404);
  ok('the retired ids are gone with it',
     (await call(env, '/sheets/personal/email', { method: 'POST', cookie: admin, body: { to: 'a@b.co' } })).status === 404);
  ok('a malformed address is refused before a send is spent',
     (await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin, body: { to: 'not-an-address' } })).status === 400);
  ok('no provider call was made yet', providerCalls === 0);

  // The header-injection attempt: CR/LF smuggled through the case number,
  // which is the one field that reaches the subject line.
  const res = await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
    body: { to: 'client@example.test', case_no: 'API-1\r\nBcc: thief@evil.test', note: 'line one\r\nline two' } });
  ok('a legitimate send succeeds', res.status === 200);
  ok('it goes to the address given', lastBody.to === 'client@example.test');
  ok('no CR or LF ever reaches the subject', !/[\r\n]/.test(lastBody.subject), JSON.stringify(lastBody.subject));
  ok('the case number itself survives sanitizing', lastBody.subject.includes('API-1'));
  ok('the note is flattened to one line in the HTML part', lastBody.html.includes('line one line two'));
  ok('the sheet email never carries the API key',
     !JSON.stringify(lastBody).includes('test-resend-key'));

  /* THE SEND PRESERVES THE TYPE. The private send carries retainer copy and
     no package price; the carrier send carries the ladder and no retainer. */
  ok('the private send is the retainer document',
     lastBody.html.includes('Retainer to begin') && lastBody.html.includes('$1,500')
     && lastBody.html.includes('Your case. Your authorization.')
     && !lastBody.html.includes('$3,300') && !lastBody.html.includes('$1,200'));

  const s3 = await call(env, '/sheets/insurance_assignment/email', { method: 'POST', cookie: admin, body: { to: 'adjuster@example.test' } });
  ok('the carrier send succeeds', s3.status === 200);
  ok('the carrier send is the package document',
     lastBody.html.includes('$1,200') && lastBody.html.includes('$2,300') && lastBody.html.includes('$3,300')
     && lastBody.html.includes('Recommended initial authorization')
     && lastBody.html.includes('Clear pricing. No surprise billing.')
     && !lastBody.html.includes('$1,500'));

  // The outbound cap: a compromised admin session must not be able to turn
  // the firm's verified domain into a spam source.
  const s4 = await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin, body: { to: 'client@example.test' } });
  const s5 = await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin, body: { to: 'client@example.test' } });
  ok('sends inside the cap go through', s4.status === 200);
  ok('the send beyond the cap is a 429', s5.status === 429);
  ok('the refused send never reached the provider', providerCalls === 3);

  /* UIBUILD P18 — the wizard's Options step: the sheet's OWN intake link,
     included on request. Which intake is paired server-side by sheet id, so
     the wrong door cannot be sent no matter what the page asks for. */
  {
    const env2 = freshEnv();
    env2.RESEND_API_KEY = 'test-resend-key';
    await bootstrapAdmin(env2);
    const adm2 = (await login(env2, 'trever', 'FirstAdminPass1')).cookie;

    ok('the carrier send can carry its intake door',
       (await call(env2, '/sheets/insurance_assignment/email', { method: 'POST', cookie: adm2,
         body: { to: 'adjuster@example.test', include_intake: true } })).status === 200);
    ok('and it is the carrier door, in both parts',
       lastBody.html.includes('/intake/?assignment=insurance')
       && lastBody.text.includes('/intake/?assignment=insurance'));
    ok('never the bare consumer intake beside it',
       (lastBody.html.match(/\/intake\//g) || []).length ===
       (lastBody.html.match(/\/intake\/\?assignment=insurance/g) || []).length);

    await call(env2, '/sheets/private_retainer/email', { method: 'POST', cookie: adm2,
      body: { to: 'client@example.test', include_intake: true } });
    ok('the private send pairs the private intake — its own door, not the picker',
       lastBody.html.includes('/intake/?assignment=private')
       && !lastBody.html.includes('assignment=insurance'));

    await call(env2, '/sheets/private_retainer/email', { method: 'POST', cookie: adm2,
      body: { to: 'client@example.test' } });
    ok('left unticked, no intake link rides along', !lastBody.html.includes('/intake/'));
  }

  globalThis.fetch = realFetch;
}

/* THE AGREED RETAINER IS WHAT THE CLIENT IS SENT.

   A case whose stored retainer is $3,000 was emailed a sheet saying $1,500 —
   the standard figure, printed at the one person who agreed a different one.
   The number has to come from the CASE in the subject line, the sheet body, the
   payment block and the preview alike, or they contradict each other in front
   of the client. Its own section because it needs its own send budget: the cap
   is three a minute and the sheets section spends all of them. */
section('A pre-case send is not blocked by a reference that matches nothing');
{
  /* The owner reproduced this in production: the send screen labels the case
     number "optional", but typing one that matched no case returned a bare
     "not found" and Preview never ran. The page wrote the agreed retainer on
     the way to Preview, and that write is case-scoped.

     The figure is carried now instead of stored. What must NOT regress is
     #123: a case that agreed a figure owns it, and an offered amount can never
     overwrite or override what the office recorded. */
  const realFetch = globalThis.fetch;
  let lastBody = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      lastBody = JSON.parse(init.body);
      return new Response('{"id":"re_1"}', { status: 200 });
    }
    return realFetch(url, init);
  };

  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  // 1. No reference at all.
  lastBody = null;
  const blank = await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
    body: { to: 'newcaller@example.test' } });
  ok('a send with no case reference at all succeeds', blank.status === 200, String(blank.status));
  ok('and carries the standard figure', lastBody && lastBody.html.includes('$1,500'));

  // 2. An arbitrary reference — the owner's exact reproduction.
  lastBody = null;
  const made = await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
    body: { to: 'marinerecon@example.test', case_no: 'Test123', retainer_amount: 2000 } });
  ok('an arbitrary reference like Test123 no longer 404s', made.status === 200, String(made.status));
  ok('the agreed $2,000 reaches the email, in both parts',
     lastBody && lastBody.html.includes('$2,000') && lastBody.text.includes('$2,000'));
  ok('and the standard figure is NOT what the client is quoted',
     lastBody && !lastBody.html.includes('$1,500') && !lastBody.text.includes('$1,500'));
  ok('the reference still rides the subject line', lastBody.subject.includes('Test123'), lastBody.subject);

  // 3. The preview must resolve to the same number as the send.
  const prev = await jsonOf(await call(env, '/sheets?case=Test123&retainer=2000', { cookie: admin }));
  ok('and the PREVIEW resolves to that same figure, so the screen cannot lie',
     prev.retainer === 2000 && prev.sheets.find(s => s.id === 'private_retainer').name.includes('$2,000'));

  // 4. #123 must not regress: a stored figure outranks anything offered.
  await ingest(env, { case_no: 'API-OWNS', service: 'Surveillance',
                      client_name: 'Pat Private', subject_name: 'Subject A' });
  await call(env, '/cases/API-OWNS/retainer', { method: 'POST', cookie: admin,
    body: { retainer_amount: 3000 } });
  lastBody = null;
  const owned = await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
    body: { to: 'client@example.test', case_no: 'API-OWNS', retainer_amount: 250 } });
  ok('a case that agreed a figure still sends THAT figure', owned.status === 200);
  ok('and an offered amount cannot undercut it',
     lastBody.html.includes('$3,000') && !lastBody.html.includes('$250'));
  const still = await jsonOf(await call(env, '/cases/API-OWNS/retainer', { cookie: admin }));
  ok('nor quietly rewrite what the case holds',
     Number(still.retainer_amount ?? still.agreed ?? 3000) === 3000, JSON.stringify(still));

  // 5. A junk offer falls back rather than printing $0 or NaN at a client.
  lastBody = null;
  await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
    body: { to: 'x@example.test', case_no: 'Test999', retainer_amount: 'abc' } });
  ok('an unparseable offered figure falls back to the standard one',
     lastBody.html.includes('$1,500') && !lastBody.html.includes('$NaN')
     && !lastBody.html.includes('$0'));

  globalThis.fetch = realFetch;
}

section('A private sheet carries the retainer that case agreed');
{
  const realFetch = globalThis.fetch;
  let lastBody = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      lastBody = JSON.parse(init.body);
      return new Response('{"id":"re_1"}', { status: 200 });
    }
    return realFetch(url, init);
  };

  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(env, { case_no: 'API-RET3K', service: 'Surveillance',
                      client_name: 'Pat Private', client_email: 'pat@example.test',
                      subject_name: 'Subject A' });

  const before = await jsonOf(await call(env, '/sheets?case=API-RET3K', { cookie: admin }));
  ok('a case that has agreed nothing yet previews the standard retainer',
     before.sheets.find(s => s.id === 'private_retainer').name.includes('$1,500'));

  await call(env, '/cases/API-RET3K/retainer', { method: 'POST', cookie: admin,
    body: { retainer_amount: 3000 } });

  const sent = await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
    body: { to: 'client@example.test', case_no: 'API-RET3K' } });
  ok('a sheet for a $3,000 case sends', sent.status === 200, String(sent.status));
  ok('and says $3,000, not the standard figure',
     lastBody.html.includes('$3,000') && !lastBody.html.includes('$1,500'));
  ok('in the subject line too', lastBody.subject.includes('$3,000'), lastBody.subject);
  ok('and in the plain-text part, which is what some clients read',
     lastBody.text.includes('$3,000') && !lastBody.text.includes('$1,500'));
  ok('while the hourly rate and the 4-hour minimum are untouched',
     lastBody.text.includes('$100/hr') && lastBody.text.includes('4-hour minimum'));

  /* THE PREVIEW IS THE SAME DOCUMENT. An admin who reads $1,500 on screen and
     sends $3,000 has been told one thing and done another. */
  const prev = await jsonOf(await call(env, '/sheets?case=API-RET3K', { cookie: admin }));
  const priv = prev.sheets.find(s => s.id === 'private_retainer');
  ok('the previewed sheet carries the case’s own retainer',
     priv.name.includes('$3,000') && priv.summary.includes('$3,000'), priv.name);
  ok('and its headline line agrees', priv.lines[0].value === '$3,000', priv.lines[0].value);

  ok('a sheet asked for with no case is still the standard retainer',
     (await jsonOf(await call(env, '/sheets', { cookie: admin })))
       .sheets.find(s => s.id === 'private_retainer').name.includes('$1,500'));
  ok('and a case number that is not one is ignored rather than queried',
     (await jsonOf(await call(env, '/sheets?case=' + encodeURIComponent("' OR 1=1--"), { cookie: admin })))
       .sheets.find(s => s.id === 'private_retainer').name.includes('$1,500'));

  const carrier = prev.sheets.find(s => s.id === 'insurance_assignment');
  ok('the carrier sheet is untouched by any of it',
     carrier.name === 'Insurance Assignment Rates' && !JSON.stringify(carrier).includes('3,000'));

  globalThis.fetch = realFetch;
}

/* MASTER §5 — a lead's lifecycle is not a case's. Nine statuses of its own,
   and the two send actions that stamp themselves. */
section('Lead statuses, and sends that stamp themselves');
{
  const realFetch = globalThis.fetch;
  let lastBody = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      lastBody = JSON.parse(init.body);
      return new Response('{"id":"re_1"}', { status: 200 });
    }
    return realFetch(url, init);
  };

  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  await call(env, `/invite/${new URL(link, 'https://x.test').searchParams.get('invite')}/accept`,
    { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  await ingest(env, { case_no: 'API-LD1', kind: 'claims', carrier: 'Lead Mutual',
                      client_name: 'Casey Adjuster', client_email: 'casey@leadmutual.test',
                      subject_name: 'Subject A' });
  await ingest(env, { case_no: 'API-LD2', service: 'Surveillance',
                      client_name: 'Pat Caller', client_email: 'pat@example.test',
                      subject_name: 'Subject B' });

  ok('the sales desk is the office\'s alone',
     (await call(env, '/leads/API-LD1/status', { method: 'POST', cookie: inv,
       body: { status: 'contacted' } })).status === 403
     && (await call(env, '/leads/API-LD1/send-intake', { method: 'POST', cookie: inv,
       body: { to: 'x@y.test' } })).status === 403);
  ok('a made-up lead status is refused',
     (await call(env, '/leads/API-LD1/status', { method: 'POST', cookie: admin,
       body: { status: 'sold' } })).status === 400);
  ok('and so is a case stage — the vocabularies never mix',
     (await call(env, '/leads/API-LD1/status', { method: 'POST', cookie: admin,
       body: { status: 'report_review' } })).status === 400);
  ok('a lead that does not exist is a 404',
     (await call(env, '/leads/API-NOPE/status', { method: 'POST', cookie: admin,
       body: { status: 'contacted' } })).status === 404);

  await call(env, '/leads/API-LD1/status', { method: 'POST', cookie: admin,
    body: { status: 'contacted' } });
  let list = (await jsonOf(await call(env, '/submissions', { cookie: admin }))).submissions;
  ok('the list carries the lead status beside the case stage',
     list.find(c => c.case_no === 'API-LD1').lead_status === 'contacted');
  ok('a lead nobody touched carries none, not a fake default',
     list.find(c => c.case_no === 'API-LD2').lead_status === null);
  // Their list is empty here (nothing assigned), so prove the redaction on a
  // row they CAN see: assign the lead, then look for the key.
  const danaId = (await jsonOf(await call(env, '/users', { cookie: admin })))
    .users.find(u => u.username === 'dana').id;
  await call(env, '/submissions/API-LD1/assign', { method: 'POST', cookie: admin,
    body: { user_id: danaId } });
  const invRows = (await jsonOf(await call(env, '/submissions', { cookie: inv }))).submissions;
  ok('an investigator\'s list never carries the sales desk',
     invRows.length === 1 && !('lead_status' in invRows[0]) && !('client_email' in invRows[0]));

  /* PAYMENTS.md §10 — the retainer state and whether payment instructions have
     gone, carried on the case-list ROW because the Leads & Intakes card is what
     draws them. Same shape as send_count/last_sent_at, and the same boundary:
     whether a client has paid is the client's commercial position, so an
     investigator is shown none of it. */
  ok('the list carries retainer state for the office',
     'retainer_received' in list.find(c => c.case_no === 'API-LD1'));
  ok('a case with no retainer row reads as nothing owed-and-received, not a fake 0',
     list.find(c => c.case_no === 'API-LD2').retainer_received === null);
  ok('and it carries whether payment instructions have been sent',
     'pay_sent_at' in list.find(c => c.case_no === 'API-LD1')
     && 'pay_methods' in list.find(c => c.case_no === 'API-LD1'));
  ok('nothing sent yet reads as null, so the card can tell "never" from "empty"',
     list.find(c => c.case_no === 'API-LD1').pay_sent_at === null);
  ok('an investigator is shown none of the money on the row',
     !('retainer_received' in invRows[0]) && !('pay_sent_at' in invRows[0])
     && !('pay_methods' in invRows[0]), JSON.stringify(Object.keys(invRows[0])));

  /* And once instructions really go, the row says so — read back from what the
     send wrote, not from what the request asked for. */
  await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
    body: { to: 'ld2@example.test', name: 'Lead Two', case_no: 'API-LD2',
            methods: ['cash_app', 'venmo'] } });
  const afterPay = (await jsonOf(await call(env, '/submissions', { cookie: admin })))
    .submissions.find(c => c.case_no === 'API-LD2');
  ok('a real payment send lands on the row', !!afterPay.pay_sent_at, JSON.stringify(afterPay));
  ok('naming the methods that actually went', (afterPay.pay_methods || '').includes('cash_app')
     && (afterPay.pay_methods || '').includes('venmo'), String(afterPay.pay_methods));

  /* The system stamps what IT did. A sheet emailed against the lead's case
     number moves it — and the door pairing stays server-side. */
  await call(env, '/sheets/insurance_assignment/email', { method: 'POST', cookie: admin,
    body: { to: 'casey@leadmutual.test', case_no: 'API-LD1' } });
  list = (await jsonOf(await call(env, '/submissions', { cookie: admin }))).submissions;
  ok('a sheet sent against the lead stamps Rate Sheet Sent',
     list.find(c => c.case_no === 'API-LD1').lead_status === 'rate_sheet_sent');

  await call(env, '/sheets/insurance_assignment/email', { method: 'POST', cookie: admin,
    body: { to: 'casey@leadmutual.test', case_no: 'API-LD1', include_intake: true } });
  list = (await jsonOf(await call(env, '/submissions', { cookie: admin }))).submissions;
  ok('with the intake ticked the stamp is Intake Sent — the further of the two',
     list.find(c => c.case_no === 'API-LD1').lead_status === 'intake_sent');

  const si = await jsonOf(await call(env, '/leads/API-LD2/send-intake', { method: 'POST',
    cookie: admin, body: { to: 'pat@example.test' } }));
  ok('Send Intake sends the private door to a private lead',
     si.ok === true && si.intake === 'Private Client Intake'
     && lastBody.html.includes('/intake/?assignment=private')
     && !lastBody.html.includes('assignment=insurance'));
  ok('and stamps Intake Sent', si.lead_status === 'intake_sent');

  await call(env, '/leads/API-LD1/send-intake', { method: 'POST', cookie: admin,
    body: { to: 'casey@leadmutual.test' } });
  ok('a carrier lead can only ever be sent the carrier door',
     lastBody.html.includes('/intake/?assignment=insurance'));
  ok('a bad address never spends a send',
     (await call(env, '/leads/API-LD2/send-intake', { method: 'POST', cookie: admin,
       body: { to: 'not-an-address' } })).status === 400);

  /* Send history (audit, 2026-08-14). Nothing recorded who was emailed what
     or when, so a second send to the same adjuster was invisible. */
  const wsSends = (await jsonOf(await call(env, '/cases/API-LD1/workspace', { cookie: admin }))).sends;
  ok('every send is on the case record', wsSends.length === 3);
  ok('newest first, naming who sent it and to whom',
     wsSends[0].sent_by === 'Trever' && wsSends[0].recipient === 'casey@leadmutual.test');
  ok('a rate sheet records WHICH sheet went',
     wsSends.some(x => x.kind === 'rate_sheet' && x.sheet_id === 'insurance_assignment'));
  ok('and which door rode with it, so the pairing is auditable afterwards',
     wsSends.some(x => x.kind === 'rate_sheet' && x.door === null)
     && wsSends.some(x => x.kind === 'rate_sheet' && /assignment=insurance/.test(x.door || '')));
  ok('a standalone intake send is its own kind',
     wsSends.some(x => x.kind === 'intake' && /assignment=insurance/.test(x.door || '')));
  ok('the leads list carries the count without a fetch per card',
     (await jsonOf(await call(env, '/submissions', { cookie: admin }))).submissions
       .find(c => c.case_no === 'API-LD1').send_count === 3);

  /* A FAILED send is the one the office most needs to see. */
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) return new Response('nope', { status: 500 });
    return realFetch2(url, init);
  };
  ok('a refused send is reported, not swallowed',
     (await call(env, '/leads/API-LD1/send-intake', { method: 'POST', cookie: admin,
       body: { to: 'casey@leadmutual.test' } })).status === 502);
  globalThis.fetch = realFetch2;
  const afterFail = (await jsonOf(await call(env, '/cases/API-LD1/workspace', { cookie: admin }))).sends;
  ok('and it is KEPT, marked failed', afterFail.length === 4 && afterFail[0].ok === 0);
  ok('the failure does not count as a successful send',
     (await jsonOf(await call(env, '/submissions', { cookie: admin }))).submissions
       .find(c => c.case_no === 'API-LD1').send_count === 3);
  ok('a failed send does not move the lead either',
     (await jsonOf(await call(env, '/submissions', { cookie: admin }))).submissions
       .find(c => c.case_no === 'API-LD1').lead_status === 'intake_sent');

  /* This was a key-name check, and a key-name check is weak twice over: it
     passes the moment a key is renamed or nested, AND it passes on a 404,
     because `!('sends' in {error:'not found'})` is true. It would have gone
     green while testing nothing.

     The recipient's own address is the thing that must not leave the Worker,
     so assert on the VALUE, over the whole response body, on every route an
     investigator can reach — and prove first that the workspace they got was
     a real one. */
  const seen = [];
  for (const path of ['/submissions', '/submissions/API-LD1', '/cases/API-LD1/workspace',
                      '/summary', '/my/active']) {
    const r = await call(env, path, { cookie: inv });
    seen.push([path, r.status, await r.text()]);
  }
  const at = p2 => seen.find(([x]) => x === p2);
  ok('the investigator really can open that case — so the checks below are not vacuous',
     at('/cases/API-LD1/workspace')[1] === 200 && at('/submissions/API-LD1')[1] === 200);
  ok('no route hands an investigator an address the office emailed',
     seen.every(([, , b]) => !b.includes('casey@leadmutual.test')
                          && !b.includes('pat@example.test')));
  ok('nor the count, the timestamp, or which sheet went',
     seen.every(([, , b]) => !/send_count|last_sent_at|sheet_id/.test(b)));
  ok('and the workspace has no sends key under any name',
     !/"sends?"|"send_history"/.test(at('/cases/API-LD1/workspace')[2]));

  /* Once the office has DECIDED, the system never quietly moves the lead. */
  await call(env, '/leads/API-LD1/status', { method: 'POST', cookie: admin,
    body: { status: 'declined' } });
  await call(env, '/sheets/insurance_assignment/email', { method: 'POST', cookie: admin,
    body: { to: 'casey@leadmutual.test', case_no: 'API-LD1' } });
  list = (await jsonOf(await call(env, '/submissions', { cookie: admin }))).submissions;
  ok('a courtesy re-send does not reopen a declined lead',
     list.find(c => c.case_no === 'API-LD1').lead_status === 'declined');
  await call(env, '/leads/API-LD1/status', { method: 'POST', cookie: admin,
    body: { status: 'converted' } });
  ok('the office\'s own hand still moves it anywhere',
     (await jsonOf(await call(env, '/submissions', { cookie: admin }))).submissions
       .find(c => c.case_no === 'API-LD1').lead_status === 'converted');

  globalThis.fetch = realFetch;
}

/* UIBUILD P17 — the office types in what a phone call brought. Same table as
   every other submission; no parallel lead store to drift. */
section('Manual intake from the office');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  await call(env, `/invite/${new URL(link, 'https://x.test').searchParams.get('invite')}/accept`,
    { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  ok('an investigator cannot create intakes',
     (await call(env, '/intakes', { method: 'POST', cookie: inv,
       body: { kind: 'consumer', client_name: 'X' } })).status === 403);
  ok('no kind, no intake',
     (await call(env, '/intakes', { method: 'POST', cookie: admin,
       body: { client_name: 'X' } })).status === 400);
  ok('a claims lead needs a carrier or a contact',
     (await call(env, '/intakes', { method: 'POST', cookie: admin,
       body: { kind: 'claims' } })).status === 400);
  ok('a private lead needs the client name',
     (await call(env, '/intakes', { method: 'POST', cookie: admin,
       body: { kind: 'consumer', subject_name: 'S' } })).status === 400);

  const made = await jsonOf(await call(env, '/intakes', { method: 'POST', cookie: admin,
    body: { kind: 'claims', carrier: 'Phoned-In Mutual', adjuster: 'A. Caller',
            client_name: 'A. Caller', claim_number: 'PM-77', subject_name: 'Claimant Q',
            objective: 'Activity check' } }));
  ok('a phoned-in assignment becomes a case', /^API-\d{8}-\d{4}$/.test(made.case_no), made.case_no);

  const sub = await jsonOf(await call(env, `/submissions/${made.case_no}`, { cookie: admin }));
  ok('it lands as a claims submission', sub.submission.kind === 'claims'
     && sub.submission.carrier === 'Phoned-In Mutual');
  ok('the payload records who typed it in',
     sub.submission.payload.manual_intake === true && sub.submission.payload.entered_by === 'Trever');

  // A thin lead is allowed on purpose: the office can hold what it knows.
  const lead = await jsonOf(await call(env, '/intakes', { method: 'POST', cookie: admin,
    body: { kind: 'consumer', client_name: 'Walk-in — name only' } }));
  ok('a name alone is enough to hold a lead', /^API-/.test(lead.case_no));
  const ws = await call(env, `/cases/${lead.case_no}/workspace`, { cookie: admin });
  ok('and the lead opens as a full workspace', ws.status === 200);
}

/* Active Surveillance Mode (SURVEILLANCE.md). No surveillance table exists and
   none may be added: these routes only answer "am I out?" and "who is out?"
   over the day records that already exist. */
/* Removing a line, the owner's request of 2026-08-14. The old rule — no delete
   route, because a timeline that can be quietly erased is worth less in a
   hearing — survives in substance: this REMOVES from the report, and stamps
   who did it, but the entry itself is never destroyed. */
section('An entry can be removed, but never quietly erased');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  await call(env, `/invite/${new URL(link, 'https://x.test').searchParams.get('invite')}/accept`,
    { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const danaId = (await jsonOf(await call(env, '/users', { cookie: admin })))
    .users.find(u => u.username === 'dana').id;

  await ingest(env, { case_no: 'API-DEL1', client_name: 'C', subject_name: 'S' });
  await call(env, '/submissions/API-DEL1/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });
  await call(env, '/cases/API-DEL1/day/start', { method: 'POST', cookie: inv,
    body: { day_date: '2026-08-14', start_time: '07:00' } });
  for (const [t, d] of [['07:05', 'Arrived in vicinity of subject residence.'],
                        ['07:10', 'asdf test line'],
                        ['07:20', 'Subject departed residence.']]) {
    await call(env, '/cases/API-DEL1/activity', { method: 'POST', cookie: inv,
      body: { at_date: '2026-08-14', at_time: t, description: d } });
  }
  let ws = await jsonOf(await call(env, '/cases/API-DEL1/workspace', { cookie: inv }));
  const junk = ws.activity.find(a => a.description === 'asdf test line');

  ok('a stray line can be removed',
     (await call(env, `/cases/API-DEL1/activity/${junk.id}/delete`, { method: 'POST', cookie: inv, body: {} })).status === 200);

  ws = await jsonOf(await call(env, '/cases/API-DEL1/workspace', { cookie: inv }));
  const gone = ws.activity.find(a => a.id === junk.id);
  ok('the entry is NOT destroyed — it comes back stamped', gone && gone.removed_at);
  ok('and says who removed it', gone.removed_by === 'Dana');
  ok('its words are still there to be read', gone.description === 'asdf test line');

  const gen = await jsonOf(await call(env, '/cases/API-DEL1/reports/generate', { method: 'POST', cookie: inv,
    body: { day_id: ws.days[0].id } }));
  const body = (await jsonOf(await call(env, '/cases/API-DEL1/workspace', { cookie: inv }))).reports[0].body;
  ok('the report leaves the removed line out', !body.includes('asdf test line'), body.slice(0, 300));
  ok('and still carries the real ones',
     body.includes('Arrived in vicinity') && body.includes('departed residence'));
  ok('the report counted only what remains', gen.entries === 2);

  ok('a mis-tap can be undone',
     (await call(env, `/cases/API-DEL1/activity/${junk.id}/restore`, { method: 'POST', cookie: inv })).status === 200);
  ok('and the entry is ordinary again',
     !(await jsonOf(await call(env, '/cases/API-DEL1/workspace', { cookie: inv })))
       .activity.find(a => a.id === junk.id).removed_at);

  // Somebody else's line is not yours to remove.
  await ingest(env, { case_no: 'API-DEL2', client_name: 'C2', subject_name: 'S2' });
  await call(env, '/cases/API-DEL2/activity', { method: 'POST', cookie: admin,
    body: { at_date: '2026-08-14', at_time: '08:00', description: "The office's own note." } });
  const other = (await jsonOf(await call(env, '/cases/API-DEL2/workspace', { cookie: admin }))).activity[0];
  await call(env, '/submissions/API-DEL2/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });
  ok("an investigator cannot remove another person's entry",
     (await call(env, `/cases/API-DEL2/activity/${other.id}/delete`, { method: 'POST', cookie: inv, body: {} })).status === 403);
  ok('but the office can', (await call(env, `/cases/API-DEL2/activity/${other.id}/delete`,
     { method: 'POST', cookie: admin, body: {} })).status === 200);
}

section('Active Surveillance: the same day, seen two ways');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  await call(env, `/invite/${new URL(link, 'https://x.test').searchParams.get('invite')}/accept`,
    { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const danaId = (await jsonOf(await call(env, '/users', { cookie: admin })))
    .users.find(u => u.username === 'dana').id;

  await ingest(env, { case_no: 'API-SV1', carrier: 'Field Mutual', claim_number: 'FM-1',
                      client_name: 'A. Adjuster', subject_name: 'Watched Person' });
  await ingest(env, { case_no: 'API-SV2', client_name: 'Someone Else', subject_name: 'Not Yours' });
  await call(env, '/submissions/API-SV1/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });

  // Nothing running yet: the launcher offers what could be started, scoped.
  const idle = await jsonOf(await call(env, '/my/active', { cookie: inv }));
  ok('with no day running the launcher says so', idle.active === null);
  ok('and offers only their own assignments',
     idle.assignments.length === 1 && idle.assignments[0].case_no === 'API-SV1');
  ok('it carries the server clock the timer trusts', typeof idle.server_now === 'string');

  ok('nobody is out yet',
     (await jsonOf(await call(env, '/active', { cookie: admin }))).out_now.length === 0);
  ok('and who-is-out is the office\'s view only',
     (await call(env, '/active', { cookie: inv })).status === 403);

  await call(env, '/cases/API-SV1/day/start', { method: 'POST', cookie: inv,
    body: { day_date: '2026-08-14', start_time: '06:30', start_mileage: 52000 } });

  /* The timer's source: the SERVER's instant, not anything the phone said. */
  const ws = await jsonOf(await call(env, '/cases/API-SV1/workspace', { cookie: inv }));
  ok('the open day carries a server-stamped start', typeof ws.open_day.started_at === 'string'
     && !Number.isNaN(Date.parse(ws.open_day.started_at)));
  ok('and the workspace carries the server clock beside it',
     typeof ws.server_now === 'string' && !Number.isNaN(Date.parse(ws.server_now)));
  ok('the recorded start time is still the investigator\'s own',
     ws.open_day.start_time === '06:30');

  const mine = await jsonOf(await call(env, '/my/active', { cookie: inv }));
  ok('the launcher now resumes the running day', mine.active && mine.active.case_no === 'API-SV1');
  ok('and names the subject for the field', mine.active.subject_name === 'Watched Person');

  await call(env, '/cases/API-SV1/activity', { method: 'POST', cookie: inv,
    body: { at_date: '2026-08-14', at_time: '06:45', description: 'Arrived in vicinity of subject residence.' } });

  const out = await jsonOf(await call(env, '/active', { cookie: admin }));
  ok('the office sees exactly one investigator out', out.out_now.length === 1);
  const o = out.out_now[0];
  ok('named, on their case', o.investigator === 'Dana' && o.case_no === 'API-SV1');
  ok('with the start the day was recorded at', o.start_time === '06:30');
  ok('and the last thing they logged',
     o.last_activity && o.last_activity.description.includes('Arrived in vicinity'));
  ok('and how much they have logged', o.activity_count === 1);
  ok('but no location of any kind',
     !('lat' in o) && !('lng' in o) && !JSON.stringify(o).toLowerCase().includes('gps'));

  /* THE FINAL RULE: the field wrote to the ordinary tables. */
  const asAdmin = await jsonOf(await call(env, '/cases/API-SV1/workspace', { cookie: admin }));
  ok('the field entry is in the ordinary activity log',
     asAdmin.activity.length === 1 && asAdmin.activity[0].description.includes('Arrived in vicinity'));
  ok('and the day is an ordinary case day', asAdmin.days.length === 1
     && asAdmin.days[0].start_mileage === 52000);

  /* Pausing the day (owner, 2026-08-14). Every quantity is a SERVER
     timestamp, so nothing the phone believes can move the clock. */
  ok('a day that is running is not paused',
     (await jsonOf(await call(env, '/cases/API-SV1/workspace', { cookie: inv })))
       .open_day.paused_at === null);
  const paused = await jsonOf(await call(env, '/cases/API-SV1/day/pause',
    { method: 'POST', cookie: inv, body: { reason: 'Lunch' } }));
  ok('pausing stamps the instant it started, server-side',
     typeof paused.paused_at === 'string' && !Number.isNaN(Date.parse(paused.paused_at)));
  ok('and nothing is closed yet, so nothing is subtracted', paused.paused_ms === 0);
  ok('the workspace shows the day as paused',
     (await jsonOf(await call(env, '/cases/API-SV1/workspace', { cookie: inv })))
       .open_day.paused_at === paused.paused_at);
  ok('the launcher agrees, so resuming on another device sees the same clock',
     (await jsonOf(await call(env, '/my/active', { cookie: inv }))).active.paused_at === paused.paused_at);
  ok('the office sees a paused investigator as paused, not stalled',
     (await jsonOf(await call(env, '/active', { cookie: admin }))).out_now[0].paused_at !== null);

  ok('pausing twice is refused — one open break at a time',
     (await call(env, '/cases/API-SV1/day/pause', { method: 'POST', cookie: inv, body: {} })).status === 409);
  ok('an investigator cannot pause a day on a case that is not theirs',
     (await call(env, '/cases/API-SV2/day/pause', { method: 'POST', cookie: inv, body: {} })).status === 404);

  const resumed = await jsonOf(await call(env, '/cases/API-SV1/day/resume',
    { method: 'POST', cookie: inv, body: {} }));
  ok('resuming closes the break and stops freezing the clock', resumed.paused_at === null);
  ok('and the closed span is now what gets subtracted', resumed.paused_ms >= 0);
  ok('resuming when nothing is paused is refused',
     (await call(env, '/cases/API-SV1/day/resume', { method: 'POST', cookie: inv, body: {} })).status === 409);

  /* A break comes off the billable total, because `hours` is what
     authorization and invoices are drawn against. */
  const dayId = (await jsonOf(await call(env, '/cases/API-SV1/workspace', { cookie: inv }))).open_day.id;
  await env.DB.prepare(
    `INSERT INTO case_day_pauses (day_id, started_at, ended_at) VALUES (?, ?, ?)`)
    .bind(dayId, '2026-08-14T08:00:00.000Z', '2026-08-14T09:00:00.000Z').run();

  const ended = await jsonOf(await call(env, '/cases/API-SV1/day/end', { method: 'POST', cookie: inv,
    body: { end_time: '11:30', end_mileage: 52040 } }));
  ok('the clock ran five hours', ended.span_hours === 5);
  ok('an hour of it was a break', ended.paused_hours === 1);
  ok('so the billable day is four hours, not five', ended.hours === 4);
  ok('and that is what the case day stores',
     (await jsonOf(await call(env, '/cases/API-SV1/workspace', { cookie: admin }))).days[0].hours === 4);
  ok('ending the day empties the office\'s Out now',
     (await jsonOf(await call(env, '/active', { cookie: admin }))).out_now.length === 0);
  ok('and the launcher goes back to offering assignments',
     (await jsonOf(await call(env, '/my/active', { cookie: inv }))).active === null);
}

/* ------------------- a break must never eat the day it was taken inside of
 *
 * HIGH #1 from the 2026-08-14 audits, verified here before it was fixed.
 *
 * `span` is minutes between the TYPED start and end times — the investigator's
 * own local clock. A pause is a pair of SERVER instants. Those are two
 * different clocks, and the old code closed an open pause at `nowIso()`, which
 * silently mixed them:
 *
 *   start 08:00, pause at noon, then at 20:00 file the day honestly as ending
 *   at 12:00  ->  span 240 min, pause "ran" 8h, worked = max(0, 240 - 480) = 0
 *
 * A real four-hour day recorded as ZERO, floored by the `Math.max` so nothing
 * anywhere said a number had been thrown away. `hours` is what authorization
 * and invoices draw against, so this is billable time destroyed in place.
 *
 * The fix anchors the pause to the DAY, not to the wall clock: an open pause is
 * closed at the instant the day ended — `case_days.created_at + span`, the same
 * server timestamp the field timer already trusts — clamped so it can never
 * close before it opened nor after now. A break that began at or after the
 * day's claimed end therefore contributes nothing, which is the honest reading:
 * they stopped working when the break started. */
section('A break cannot eat the day it was taken inside of');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const token = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const danaId = users.users.find(u => u.username === 'dana').id;

  const HOUR = 3600000;
  const iso = ms => new Date(ms).toISOString();

  // One case per scenario, so an open pause in one cannot reach another.
  const run = async (caseNo, pauseHoursIn, endTime) => {
    await ingest(env, { case_no: caseNo, subject_name: 'Pat Coleman' });
    await call(env, `/submissions/${caseNo}/assign`, { method: 'POST', cookie: admin, body: { user_id: danaId } });
    await call(env, `/cases/${caseNo}/day/start`, { method: 'POST', cookie: inv,
      body: { day_date: '2026-08-14', start_time: '08:00' } });
    const dayId = (await jsonOf(await call(env, `/cases/${caseNo}/workspace`, { cookie: inv }))).open_day.id;
    // The day was really recorded 8 hours ago; the break began `pauseHoursIn`
    // hours into it. Both are server instants, exactly as the routes write them.
    const t0 = Date.now() - 8 * HOUR;
    await env.DB.prepare('UPDATE case_days SET created_at = ? WHERE id = ?').bind(iso(t0), dayId).run();
    await call(env, `/cases/${caseNo}/day/pause`, { method: 'POST', cookie: inv, body: { reason: 'Break' } });
    await env.DB.prepare('UPDATE case_day_pauses SET started_at = ? WHERE day_id = ? AND ended_at IS NULL')
      .bind(iso(t0 + pauseHoursIn * HOUR), dayId).run();
    return jsonOf(await call(env, `/cases/${caseNo}/day/end`, { method: 'POST', cookie: inv,
      body: { end_time: endTime } }));
  };

  // The reviewer's own scenario: broke off at noon, filed it at eight.
  const atEnd = await run('API-PZ1', 4, '12:00');
  ok('the clock still ran the four hours that were typed', atEnd.span_hours === 4);
  ok('a break that began as the day ended takes nothing off it', atEnd.paused_hours === 0);
  ok('so a real four-hour day is four hours, not zero', atEnd.hours === 4);
  ok('and zero is what the case day would have stored',
     (await jsonOf(await call(env, '/cases/API-PZ1/workspace', { cookie: admin }))).days[0].hours === 4);

  // A break genuinely inside the day still comes off it — the fix must not
  // become a licence to stop subtracting breaks.
  const midday = await run('API-PZ2', 2, '12:00');
  ok('a break two hours in runs to the end of the day', midday.paused_hours === 2);
  ok('and the billable day is what is left', midday.hours === 2);

  // A break opened after the day's claimed end cannot make the day negative.
  const after = await run('API-PZ3', 6, '12:00');
  ok('a break opened after the day ended takes nothing', after.paused_hours === 0);
  ok('and the day is still the full span', after.hours === 4);

  // Whatever was subtracted is what the day-end screen is told, so the
  // message can never name a break that did not come off.
  for (const [label, r] of [['none', atEnd], ['a real break', midday], ['none again', after]]) {
    ok(`the subtraction is reported honestly (${label})`,
       Math.round((r.span_hours - r.paused_hours) * 100) / 100 === r.hours);
  }
}

/* ------------------------- a reassignment must never strand a running day
 *
 * HIGH #2 from the 2026-08-14 audits, verified here before it was fixed.
 *
 * `pause`, `resume` and `end` were scoped to BOTH `caseFor()` and
 * `investigator_id = user.id`. Reassign a case with a day running and every
 * door closed at once: the original investigator failed `caseFor` (404), the
 * new investigator and the admin failed the `investigator_id` match (409). The
 * day stayed `end_time IS NULL` forever — permanently in Out Now, `hours` never
 * written, and no way to fix it inside the product at all.
 *
 * The fix keeps the rule that made the scoping right in the first place — you
 * can only stop your OWN clock — and adds the two doors that were missing:
 *   - your own running day stays yours whether or not the case still is, which
 *     is the owner's KEEP decision applied to the one route that matters most;
 *   - an admin can close a day nobody else can reach, because a recovery path
 *     that does not exist is how a day ends up hand-edited in D1.
 * A different investigator still cannot touch someone else's clock. */
section('A reassignment cannot strand a running day');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  for (const [u, n] of [['dana', 'Dana Field'], ['reed', 'Reed Cole']]) {
    const link = (await jsonOf(await invite(env, admin, { username: u, display_name: n, role: 'investigator' }))).url;
    const token = new URL(link, 'https://x.test').searchParams.get('invite');
    await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  }
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const reed = (await login(env, 'reed', 'FieldWork2026x')).cookie;
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const danaId = users.users.find(u => u.username === 'dana').id;
  const reedId = users.users.find(u => u.username === 'reed').id;

  // A case with Dana's day running and a break open, then handed to Reed.
  const strand = async (caseNo) => {
    await ingest(env, { case_no: caseNo, subject_name: 'Pat Coleman' });
    await call(env, `/submissions/${caseNo}/assign`, { method: 'POST', cookie: admin, body: { user_id: danaId } });
    await call(env, `/cases/${caseNo}/day/start`, { method: 'POST', cookie: inv,
      body: { day_date: '2026-08-14', start_time: '08:00' } });
    await call(env, `/cases/${caseNo}/day/pause`, { method: 'POST', cookie: inv, body: { reason: 'Break' } });
    await call(env, `/submissions/${caseNo}/assign`, { method: 'POST', cookie: admin, body: { user_id: reedId } });
  };

  await strand('API-ST1');
  ok('the office can see the day is still out there',
     (await jsonOf(await call(env, '/active', { cookie: admin }))).out_now.length === 1);

  // The investigator who worked it can still close it — their clock, their day,
  // and they are the one who knows when they stopped.
  const byOwner = await call(env, '/cases/API-ST1/day/end', { method: 'POST', cookie: inv,
    body: { end_time: '12:00' } });
  ok('the investigator who worked the day can still end it', byOwner.status === 200);
  ok('and it is recorded as a real day, not zero', (await jsonOf(byOwner)).hours === 4);
  ok('which empties Out now',
     (await jsonOf(await call(env, '/active', { cookie: admin }))).out_now.length === 0);

  /* And an admin can close one nobody else can reach — but NOT with the
     ordinary End button any more (owner, 2026-08-16). That control reaches only
     the caller's own session; closing someone else's is its own route with its
     own confirmation, so a desk admin cannot end a field admin's day by press. */
  await strand('API-ST2');
  const byPlainEnd = await call(env, '/cases/API-ST2/day/end', { method: 'POST', cookie: admin,
    body: { end_time: '12:00' } });
  ok('the ordinary End does NOT reach a day that is not the admin\'s own',
     byPlainEnd.status === 409, String(byPlainEnd.status));
  const refusal = await jsonOf(byPlainEnd);
  ok('and the refusal names whose day it is and the separate action',
     /dana/i.test(refusal.error || '') && /end their session/i.test(refusal.error || ''),
     refusal.error);
  ok('flagged so the page can offer that action rather than parse the sentence',
     refusal.other_session === true);
  ok('the day is untouched by the refusal',
     (await jsonOf(await call(env, '/active', { cookie: admin }))).out_now.length === 1);

  const byAdmin = await call(env, '/cases/API-ST2/day/end-other', { method: 'POST', cookie: admin,
    body: { end_time: '12:00' } });
  ok('an admin can close a day that would otherwise be stranded', byAdmin.status === 200,
     String(byAdmin.status));
  const ws = await jsonOf(await call(env, '/cases/API-ST2/workspace', { cookie: admin }));
  ok('the hours stay credited to whoever actually worked them',
     ws.days[0].investigator_id === danaId && ws.days[0].hours === 4);

  // But a reassignment is not a licence over someone else's clock.
  await strand('API-ST3');
  ok("the new investigator cannot end another investigator's day",
     (await call(env, '/cases/API-ST3/day/end', { method: 'POST', cookie: reed,
       body: { end_time: '12:00' } })).status === 409);
  ok("nor pause or resume it",
     (await call(env, '/cases/API-ST3/day/pause', { method: 'POST', cookie: reed, body: {} })).status === 409
     && (await call(env, '/cases/API-ST3/day/resume', { method: 'POST', cookie: reed, body: {} })).status === 409);
  ok('and it is still running, because refusing is not the same as closing',
     (await jsonOf(await call(env, '/active', { cookie: admin }))).out_now.length === 1);
  // A case Reed was never on at all: the ordinary boundary is untouched, and it
  // answers 404 rather than 409, so nothing here leaks whether a day is running
  // on a case the caller cannot see.
  await ingest(env, { case_no: 'API-ST4', subject_name: 'Pat Coleman' });
  await call(env, '/submissions/API-ST4/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });
  await call(env, '/cases/API-ST4/day/start', { method: 'POST', cookie: inv,
    body: { day_date: '2026-08-14', start_time: '08:00' } });
  ok('an investigator with no connection to the case still gets nothing',
     (await call(env, '/cases/API-ST4/day/end', { method: 'POST', cookie: reed,
       body: { end_time: '12:00' } })).status === 404);

  // The break the day was left on still comes off it, via the HIGH #1 rule.
  const owner2 = await jsonOf(await call(env, '/cases/API-ST3/day/end', { method: 'POST', cookie: inv,
    body: { end_time: '12:00' } }));
  ok('and the owner can still close it afterwards', owner2.hours === 4);
}

section('The two internal calculations never share a number');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const tok = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tok}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const danaId = users.users.find(u => u.username === 'dana').id;

  await ingest(env, { case_no: 'API-RB1', service: 'Surveillance', client_name: 'P. Client', subject_name: 'S' });
  await ingest(env, { case_no: 'API-RB2', carrier: 'Acme Mutual', claim_number: 'AM-1',
                      client_name: 'A. Adjuster', subject_name: 'C' });

  let ws = await jsonOf(await call(env, '/cases/API-RB1/workspace', { cookie: admin }));
  ok('a private case bills at the private hourly by default',
     ws.authorization.billed_at_rate === 100 && ws.authorization.case_rate_set === false);
  ok('and carries the retainer balance from day one',
     ws.authorization.retainer.amount === 1500 && ws.authorization.retainer.applied === 0
     && ws.authorization.retainer.remaining === 1500);
  const cws = await jsonOf(await call(env, '/cases/API-RB2/workspace', { cookie: admin }));
  ok('a claims case never has a retainer', cws.authorization.retainer === undefined);
  ok('and still bills at the carrier standard by default', cws.authorization.billed_at_rate === 150);

  // Work consumes the retainer at the case rate: the handoff's own worked
  // example — six hours at $100 leaves $900 of the $1,500.
  await call(env, '/cases/API-RB1/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-12', start_time: '07:00' } });
  await call(env, '/cases/API-RB1/day/end', { method: 'POST', cookie: admin, body: { end_time: '13:00' } });
  ws = await jsonOf(await call(env, '/cases/API-RB1/workspace', { cookie: admin }));
  const r = ws.authorization.retainer;
  ok('$1,500 minus six hours at $100 leaves $900', r.applied === 600 && r.remaining === 900);
  ok('with about nine hours left on it', r.approx_hours_remaining === 9);
  ok('not received until the office says so', r.received === false);

  ok('an investigator cannot touch the retainer record',
     (await call(env, '/cases/API-RB1/retainer', { method: 'POST', cookie: inv,
       body: { received: true } })).status === 403);
  ok('a claims case refuses a retainer outright',
     (await call(env, '/cases/API-RB2/retainer', { method: 'POST', cookie: admin,
       body: { received: true } })).status === 400);
  const set = await jsonOf(await call(env, '/cases/API-RB1/retainer', { method: 'POST', cookie: admin,
    body: { retainer_amount: 2000, received: true } }));
  ok('the office records the amount and receipt',
     set.authorization.retainer.amount === 2000 && set.authorization.retainer.received === true
     && set.authorization.retainer.remaining === 1400);

  /* PAYMENTS.md §5/§11 — WHAT arrived, not merely that something did. A bare
     received flag cannot be reconciled against a bank statement six weeks
     later, which is the whole reason for recording the money rather than
     ticking a box. */
  const paid = await jsonOf(await call(env, '/cases/API-RB1/retainer', { method: 'POST', cookie: admin,
    body: { retainer_amount: 2000, received: true, amount_received: 2000, method: 'venmo',
            paid_on: '2026-08-14', reference: 'Venmo note: case RB1' } }));
  // Money entered here lands in the LEDGER, not a per-case receipt row — one
  // place money arrives, whichever screen recorded it.
  const rcpt = (paid.authorization.retainer.payments || [])[0];
  ok('the payment records the amount, method, date and reference',
     rcpt && rcpt.amount === 2000 && rcpt.method === 'venmo'
     && rcpt.paid_on === '2026-08-14' && rcpt.reference === 'Venmo note: case RB1');
  ok('and names the method in words the office reads', rcpt.method_label === 'Venmo');
  ok('and stamps who recorded it', !!rcpt.recorded_by && !!rcpt.recorded_at);
  ok('the retainer reads as received rather than pending',
     paid.authorization.retainer.status === 'received');
  ok('and received totals what actually arrived',
     paid.authorization.retainer.received_total === 2000
     && paid.authorization.retainer.outstanding === 0);

  ok('an invented payment method is refused',
     (await call(env, '/cases/API-RB1/retainer', { method: 'POST', cookie: admin,
       body: { received: true, method: 'bitcoin' } })).status === 400);

  /* Owner correction 2026-08-15: the firm does not take these, so they are not
     offered. Offering a method it cannot accept pushes the failure onto the
     client mid-retainer, and "other" records that money arrived by a means
     nobody wrote down — the one thing a payment record exists to prevent. */
  for (const gone of ['card', 'other']) {
    ok(`${gone} is not an accepted retainer method`,
       (await call(env, '/cases/API-RB1/retainer', { method: 'POST', cookie: admin,
         body: { received: true, method: gone } })).status === 400);
  }
  for (const kept of ['cash_app', 'venmo', 'check', 'cash', 'ach_bill']) {
    ok(`${kept} is accepted`,
       (await call(env, '/cases/API-RB1/retainer', { method: 'POST', cookie: admin,
         body: { retainer_amount: 2000, received: true, method: kept } })).status === 200);
  }
  ok('and a payment date that is not a date is refused',
     (await call(env, '/cases/API-RB1/retainer', { method: 'POST', cookie: admin,
       body: { received: true, method: 'cash', paid_on: 'last tuesday' } })).status === 400);
  ok('but the details stay OPTIONAL — knowing it landed is enough to say so',
     (await call(env, '/cases/API-RB1/retainer', { method: 'POST', cookie: admin,
       body: { retainer_amount: 2000, received: true } })).status === 200);

  /* UN-MARKING NO LONGER ERASES PAYMENTS. It used to delete the receipt row,
     which was defensible when a case held exactly one; against a ledger it
     would destroy a payment history because someone unticked a checkbox. The
     flag and the money are separate facts, and the way to reverse a payment is
     to void that payment, on the record. */
  const undone = await jsonOf(await call(env, '/cases/API-RB1/retainer', { method: 'POST', cookie: admin,
    body: { retainer_amount: 2000, received: false } }));
  ok('un-marking the flag does not erase what was recorded as paid',
     undone.authorization.retainer.payments.length >= 1);
  ok('and the case still reports the money it actually has',
     undone.authorization.retainer.received_total === 2000);
  // Voiding every payment is what genuinely returns a case to pending.
  for (const pmt of undone.authorization.retainer.payments) {
    await call(env, `/cases/API-RB1/retainer/payment/${pmt.id}/void`,
      { method: 'POST', cookie: admin, body: { reason: 'test reset' } });
  }
  const cleared = (await jsonOf(await call(env, '/cases/API-RB1/workspace', { cookie: admin })))
    .authorization.retainer;
  ok('voiding the payments is what returns it to pending',
     cleared.received_total === 0 && cleared.status === 'pending');

  /* A CUSTOM RETAINER SURVIVES EVERY OTHER WRITE TO THIS ROUTE.

     An absent retainer_amount used to mean "reset to $1,500", and Record
     Payment sends the receipt without the amount — so a case agreed at $2,500
     silently dropped to the default the moment the office recorded the money,
     with `remaining` recomputed against a figure the client never agreed to. */
  await call(env, '/cases/API-RB1/retainer', { method: 'POST', cookie: admin,
    body: { retainer_amount: 2500, received: false } });
  const kept = await jsonOf(await call(env, '/cases/API-RB1/retainer', { method: 'POST', cookie: admin,
    body: { received: true, method: 'check', amount_received: 2500 } }));
  ok('recording a payment does not reset a custom retainer',
     kept.authorization.retainer.amount === 2500, String(kept.authorization.retainer.amount));
  const keptBack = await jsonOf(await call(env, '/cases/API-RB1/retainer', { method: 'POST', cookie: admin,
    body: { received: false } }));
  ok('and neither does undoing it', keptBack.authorization.retainer.amount === 2500,
     String(keptBack.authorization.retainer.amount));
  ok('the balance stays computed against the agreed figure',
     keptBack.authorization.retainer.remaining === 2500 - keptBack.authorization.retainer.applied);
  // A case that has never had a retainer row: the default still applies there,
  // which is the one place it is genuinely correct.
  await ingest(env, { case_no: 'API-RB3', service: 'Surveillance', client_name: 'Q. Client', subject_name: 'T' });
  ok('while a case with no retainer row still starts at the standard $1,500',
     (await jsonOf(await call(env, '/cases/API-RB3/retainer', { method: 'POST', cookie: admin,
       body: { received: false } }))).authorization.retainer.amount === 1500);
  ok('and an explicit amount still changes it',
     (await jsonOf(await call(env, '/cases/API-RB1/retainer', { method: 'POST', cookie: admin,
       body: { retainer_amount: 1800, received: false } }))).authorization.retainer.amount === 1800);

  /* Preservation is resolved INSIDE the statement, and that is a STRUCTURAL
     property this harness cannot test behaviourally: its SQLite runs each
     request to completion, so two calls fired with Promise.all never actually
     interleave. A concurrency test here passes whether the code reads first or
     not — it looks like coverage and is worth nothing.

     So the shape is asserted instead. A read-then-write would let two admins on
     one private case — one adjusting the retainer, one recording the payment —
     silently restore a figure the other had already superseded, which is an
     ordinary Monday rather than an exotic race. */
  {
    const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
    const route = src.slice(src.indexOf("/^\\/cases\\/([A-Za-z0-9-]{3,64})\\/retainer$/"));
    const body = route.slice(0, route.indexOf('/closure$/'));
    ok('the retainer amount is preserved by the UPDATE, not by a prior read',
       body.includes('COALESCE(?2, case_retainer.retainer_amount)'));
    ok('and nothing reads retainer_amount before writing it',
       !/SELECT[^;]*retainer_amount[^;]*FROM case_retainer/i.test(body),
       (body.match(/SELECT[^;]*retainer_amount[^;]*FROM case_retainer/i) || [''])[0]);
    ok('a brand-new row still falls back to the standard retainer',
       body.includes('COALESCE(?2, ?6)'));
  }

  /* PARTIAL RETAINER PAYMENTS (owner confirmation, 2026-08-15). The worked
     example from the owner: agreed $3,000, two payments of $1,000, so RECEIVED
     is $2,000 and OUTSTANDING is $1,000. A second payment must never overwrite
     the first — that is the whole reason payments are a log. */
  await call(env, '/cases/API-RB3/retainer', { method: 'POST', cookie: admin,
    body: { retainer_amount: 3000, received: false } });
  await call(env, '/cases/API-RB3/retainer/payment', { method: 'POST', cookie: admin,
    body: { amount: 1000, method: 'venmo', paid_on: '2026-08-10', reference: 'first' } });
  const half = await jsonOf(await call(env, '/cases/API-RB3/retainer/payment', { method: 'POST', cookie: admin,
    body: { amount: 1000, method: 'check', paid_on: '2026-08-14', reference: 'second' } }));
  const rb3 = half.authorization.retainer;
  ok('two instalments both count — the second does not overwrite the first',
     rb3.payments.length === 2 && rb3.received_total === 2000, JSON.stringify(rb3.received_total));
  ok('the agreed retainer is untouched by paying against it', rb3.agreed === 3000);
  ok('outstanding is agreed minus received', rb3.outstanding === 1000);
  ok('and the case reads as part paid, not paid and not pending',
     rb3.status === 'part_paid', rb3.status);
  ok('each payment keeps its own method, date and reference',
     rb3.payments[0].method === 'venmo' && rb3.payments[0].paid_on === '2026-08-10'
     && rb3.payments[0].reference === 'first'
     && rb3.payments[1].method_label === 'Check' && rb3.payments[1].reference === 'second');
  ok('and each is stamped with who recorded it',
     rb3.payments.every(x => x.recorded_by && x.recorded_at));

  /* REMAINING keeps its own meaning. The owner was explicit that the unpaid
     balance is OUTSTANDING, because `remaining` already means the retainer not
     yet consumed by work. Both appear here and they are different numbers. */
  ok('remaining still means the money work has not consumed, not the unpaid balance',
     rb3.remaining === 3000 - rb3.applied && rb3.remaining !== rb3.outstanding,
     `${rb3.remaining} vs ${rb3.outstanding}`);

  ok('a payment with no amount is refused — a total cannot skip a row',
     (await call(env, '/cases/API-RB3/retainer/payment', { method: 'POST', cookie: admin,
       body: { method: 'cash' } })).status === 400);
  ok('and so is a negative one',
     (await call(env, '/cases/API-RB3/retainer/payment', { method: 'POST', cookie: admin,
       body: { amount: -50, method: 'cash' } })).status === 400);
  ok('an unaccepted method is refused on a payment too',
     (await call(env, '/cases/API-RB3/retainer/payment', { method: 'POST', cookie: admin,
       body: { amount: 100, method: 'card' } })).status === 400);
  ok('an investigator cannot record a payment',
     (await call(env, '/cases/API-RB3/retainer/payment', { method: 'POST', cookie: inv,
       body: { amount: 100 } })).status === 403);
  ok('and a claim assignment has no retainer to pay',
     (await call(env, '/cases/API-RB2/retainer/payment', { method: 'POST', cookie: admin,
       body: { amount: 100 } })).status === 400);

  /* Correcting a payment VOIDS it. History is not rewritten: the row stays, so
     the record still shows what was believed and who corrected it. */
  const voided = await jsonOf(await call(env,
    `/cases/API-RB3/retainer/payment/${rb3.payments[0].id}/void`,
    { method: 'POST', cookie: admin, body: { reason: 'recorded twice' } }));
  const afterVoid = voided.authorization.retainer;
  ok('voiding a payment stops it counting', afterVoid.received_total === 1000);
  ok('and outstanding follows it', afterVoid.outstanding === 2000);
  ok('but the payment is still in the record, marked',
     afterVoid.payments.length === 2
     && afterVoid.payments.find(x => x.voided) !== undefined);
  ok('stamped with who voided it and why',
     afterVoid.payments.find(x => x.voided).voided_by
     && afterVoid.payments.find(x => x.voided).void_reason === 'recorded twice');
  ok('and the agreed retainer is STILL untouched', afterVoid.agreed === 3000);

  /* A LEGACY RECEIPT IS STILL MONEY. Rows written before the ledger existed
     were briefly counted only while the log was empty, so a case holding a
     $1,500 receipt that then took a $500 instalment reported $500 received and
     lost the $1,500 silently. Money already recorded does not stop being money
     because a newer row arrived beside it. Planted directly, because nothing
     creates one of these any more — which is what makes counting it safe. */
  await ingest(env, { case_no: 'API-RB4', service: 'Surveillance', client_name: 'R. Client', subject_name: 'U' });
  await call(env, '/cases/API-RB4/retainer', { method: 'POST', cookie: admin,
    body: { retainer_amount: 3000, received: false } });
  await env.DB.prepare(
    `INSERT INTO retainer_receipt (case_no, amount, method, paid_on, reference, recorded_by, recorded_at)
     VALUES ('API-RB4', 1500, 'check', '2026-08-01', 'legacy row', ?, ?)`)
    .bind(1, '2026-08-01T00:00:00Z').run();
  const legacyOnly = (await jsonOf(await call(env, '/cases/API-RB4/workspace', { cookie: admin })))
    .authorization.retainer;
  ok('a legacy receipt counts on its own', legacyOnly.received_total === 1500);
  await call(env, '/cases/API-RB4/retainer/payment', { method: 'POST', cookie: admin,
    body: { amount: 500, method: 'cash', paid_on: '2026-08-12' } });
  const legacyPlus = (await jsonOf(await call(env, '/cases/API-RB4/workspace', { cookie: admin })))
    .authorization.retainer;
  ok('and KEEPS counting once a newer instalment arrives beside it',
     legacyPlus.received_total === 2000, String(legacyPlus.received_total));
  ok('with outstanding following the true total', legacyPlus.outstanding === 1000);

  /* A RETRY MUST NOT CHARGE TWICE. A dropped response, a double tap or an
     offline replay delivers the same recorded payment again, and an additive
     ledger takes every arrival at face value unless something stops it. */
  const rbTok = 'attempt-rb4-0001';
  await call(env, '/cases/API-RB4/retainer/payment', { method: 'POST', cookie: admin,
    body: { amount: 250, method: 'venmo', client_token: rbTok } });
  const replay = await call(env, '/cases/API-RB4/retainer/payment', { method: 'POST', cookie: admin,
    body: { amount: 250, method: 'venmo', client_token: rbTok } });
  ok('a replayed payment is accepted rather than erroring', replay.status === 200);
  ok('but it is only counted once',
     (await jsonOf(replay)).authorization.retainer.received_total === 2250,
     String((await jsonOf(await call(env, '/cases/API-RB4/workspace', { cookie: admin })))
       .authorization.retainer.received_total));
  ok('and only one row exists for that attempt',
     (await jsonOf(await call(env, '/cases/API-RB4/workspace', { cookie: admin })))
       .authorization.retainer.payments.filter(x => x.amount === 250).length === 1);

  /* THE DOUBLE CLICK, which is what this guard is really for. Both presses
     carry the same token; the second must write nothing and still answer 200,
     because from the caller side the payment IS recorded. Erroring would make
     a dropped response look like a failure and invite the retry that
     duplicates. The payment and its token are written in ONE transaction, so
     there is no instant where the claim exists without the money behind it. */
  const beforeDouble = (await jsonOf(await call(env, '/cases/API-RB4/workspace', { cookie: admin })))
    .authorization.retainer.received_total;
  const both = await Promise.all([
    call(env, '/cases/API-RB4/retainer/payment', { method: 'POST', cookie: admin,
      body: { amount: 90, method: 'cash', client_token: 'double-click-1' } }),
    call(env, '/cases/API-RB4/retainer/payment', { method: 'POST', cookie: admin,
      body: { amount: 90, method: 'cash', client_token: 'double-click-1' } }),
  ]);
  ok('both presses are accepted', both.every(r => r.status === 200));
  ok('but the money is counted once',
     (await jsonOf(await call(env, '/cases/API-RB4/workspace', { cookie: admin })))
       .authorization.retainer.received_total === beforeDouble + 90);

  // Relative, so earlier blocks adding payments cannot make this pass or fail
  // for reasons unrelated to what it is testing.
  const beforeSeparate = (await jsonOf(await call(env, '/cases/API-RB4/workspace', { cookie: admin })))
    .authorization.retainer.received_total;
  ok('while a genuinely separate payment of the same size still counts',
     (await jsonOf(await call(env, '/cases/API-RB4/retainer/payment', { method: 'POST', cookie: admin,
       body: { amount: 250, method: 'venmo', client_token: 'attempt-rb4-0002' } })))
       .authorization.retainer.received_total === beforeSeparate + 250);

  /* A WRITE THAT FAILED MUST NOT BE REPORTED AS SUCCESS.

     The batch holds two inserts, and the catch used to read any error mentioning
     a constraint as "already recorded". So a payment that failed its OWN
     constraint rolled the whole batch back, wrote nothing, and was answered 200:
     the admin is told the money is on file and the ledger is empty. Money that
     disappears quietly is worse than the duplicate the token exists to stop.

     Forced with a temporary unique index, which is the cheapest way to make the
     payment insert — and only the payment insert — fail for a reason that is
     not the token. */
  await env.DB.prepare(
    `CREATE UNIQUE INDEX tmp_one_ref ON retainer_payment(reference)
      WHERE reference = 'REF-CLASH'`).run();
  await env.DB.prepare(
    `INSERT INTO retainer_payment (case_no, amount, method, reference, recorded_at)
     VALUES ('API-RB4', 75, 'cash', 'REF-CLASH', ?)`).bind('2026-08-15T00:00:00Z').run();
  const beforeFail = (await jsonOf(await call(env, '/cases/API-RB4/workspace', { cookie: admin })))
    .authorization.retainer.received_total;
  const failed = await call(env, '/cases/API-RB4/retainer/payment', { method: 'POST', cookie: admin,
    body: { amount: 400, method: 'cash', reference: 'REF-CLASH', client_token: 'attempt-rb4-0003' } });
  ok('a payment that could not be written is NOT answered with success',
     failed.status !== 200, String(failed.status));
  const afterFail = (await jsonOf(await call(env, '/cases/API-RB4/workspace', { cookie: admin })))
    .authorization.retainer;
  ok('and the ledger did not gain it', afterFail.received_total === beforeFail,
     String(afterFail.received_total) + ' vs ' + String(beforeFail));
  ok('and no row was left behind for it',
     !afterFail.payments.some(x => x.amount === 400));

  /* THE OTHER HALF OF THE ROLLBACK: the token must not stay claimed. If a
     rolled-back attempt left its claim on disk, the client's honest retry
     would be told "already recorded" forever and the money would never land —
     the failure would be permanent instead of retryable. */
  await env.DB.prepare('DROP INDEX tmp_one_ref').run();
  const retried = await call(env, '/cases/API-RB4/retainer/payment', { method: 'POST', cookie: admin,
    body: { amount: 400, method: 'cash', reference: 'REF-CLASH', client_token: 'attempt-rb4-0003' } });
  ok('and once the cause is gone the same attempt still records', retried.status === 200);
  const retriedTotal = (await jsonOf(retried)).authorization.retainer.received_total;
  ok('with the money finally on the ledger',
     retriedTotal === beforeFail + 400, String(retriedTotal));

  /* A STRANDED LEGACY CLAIM PROVES NOTHING.

     The earlier two-step version wrote the token first and the payment second,
     so an attempt that died between them left a claim with no money behind it —
     and those rows are in the live database now. A proof that only asks "does
     this token exist" reads one of them as "already recorded" and answers 200
     for ever on a payment that was never written. Planted exactly as that code
     would have left it: payment_id NULL. */
  await env.DB.prepare(
    `INSERT INTO retainer_payment_token (token, case_no, payment_id, claimed_at)
     VALUES ('legacy-stranded-1', 'API-RB4', NULL, ?)`).bind('2026-08-15T00:00:00Z').run();
  const beforeStranded = (await jsonOf(await call(env, '/cases/API-RB4/workspace', { cookie: admin })))
    .authorization.retainer.received_total;
  const stranded = await call(env, '/cases/API-RB4/retainer/payment', { method: 'POST', cookie: admin,
    body: { amount: 310, method: 'cash', client_token: 'legacy-stranded-1' } });
  ok('a claim with no payment behind it is NOT answered as already recorded',
     stranded.status !== 200, String(stranded.status));
  const strandedBody = await jsonOf(stranded);
  /* NOR adopted and written, which is the other wrong answer. The old code
     never filled payment_id even when it succeeded, so a NULL one means the
     money MAY have landed. Writing it would duplicate; calling it recorded
     would lose it. The database does not hold what is needed to choose. */
  ok('it is refused specifically, so the page can act on which failure it was',
     strandedBody.code === 'payment_indeterminate', String(strandedBody.code));
  ok('and the refusal names the check the admin has to make',
     /payments listed on this case/i.test(String(strandedBody.error)), String(strandedBody.error));
  ok('and it did not quietly count either',
     (await jsonOf(await call(env, '/cases/API-RB4/workspace', { cookie: admin })))
       .authorization.retainer.received_total === beforeStranded);

  /* AND IT IS RECOVERABLE. A refusal with no way past it is a payment that can
     never be recorded — the admin reads the list, decides the money is not
     there, and a NEW attempt records it exactly once. */
  const fresh = await call(env, '/cases/API-RB4/retainer/payment', { method: 'POST', cookie: admin,
    body: { amount: 310, method: 'cash', client_token: 'legacy-stranded-1-retry' } });
  ok('a new attempt gets past it', fresh.status === 200);
  ok('and records the money exactly once',
     (await jsonOf(await call(env, '/cases/API-RB4/workspace', { cookie: admin })))
       .authorization.retainer.received_total === beforeStranded + 310);
  ok('while the stranded claim is left alone, not rewritten',
     (await env.DB.prepare(
       `SELECT payment_id FROM retainer_payment_token WHERE token = 'legacy-stranded-1'`).first())
       .payment_id === null);

  /* AND A CLAIM BELONGING TO ANOTHER CASE ANSWERS FOR THAT CASE ONLY. The token
     is a GLOBAL primary key, so without a case check one case's recorded
     payment would stand as proof for a different case's unwritten one. */
  await call(env, '/cases/API-RB1/retainer/payment', { method: 'POST', cookie: admin,
    body: { amount: 120, method: 'cash', client_token: 'shared-token-1' } });
  const beforeCross = (await jsonOf(await call(env, '/cases/API-RB4/workspace', { cookie: admin })))
    .authorization.retainer.received_total;
  const crossed = await call(env, '/cases/API-RB4/retainer/payment', { method: 'POST', cookie: admin,
    body: { amount: 500, method: 'cash', client_token: 'shared-token-1' } });
  ok('another case’s claim is not proof for this one', crossed.status !== 200,
     String(crossed.status));
  ok('and no money crossed between the two cases',
     (await jsonOf(await call(env, '/cases/API-RB4/workspace', { cookie: admin })))
       .authorization.retainer.received_total === beforeCross);
  ok('while the case that really was paid still reads its own payment',
     (await jsonOf(await call(env, '/cases/API-RB1/workspace', { cookie: admin })))
       .authorization.retainer.payments.some(x => x.amount === 120));

  /* THE RULE THE FEATURE TURNS ON: sending instructions is not being paid.

     Asserted as "changes NOTHING" rather than "reads as pending". A case may
     legitimately hold money already, so an absolute check would pass or fail
     for reasons having nothing to do with the send — the question is whether
     asking for money moves the ledger, and the answer must be no whatever the
     ledger currently says. */
  const beforeSend = (await jsonOf(await call(env, '/cases/API-RB1/workspace', { cookie: admin })))
    .authorization.retainer;
  await env.DB.prepare(
    `INSERT INTO payment_send (case_no, recipient, methods, with_sheet, ok, sent_at)
     VALUES ('API-RB1', 'client@example.com', 'venmo', 1, 1, ?)`).bind('2026-08-15T00:00:00Z').run();
  const afterSend = (await jsonOf(await call(env, '/cases/API-RB1/workspace', { cookie: admin })))
    .authorization.retainer;
  ok('a sent payment instruction moves no money at all',
     afterSend.received_total === beforeSend.received_total
     && afterSend.outstanding === beforeSend.outstanding
     && afterSend.status === beforeSend.status
     && afterSend.payments.length === beforeSend.payments.length,
     `${beforeSend.received_total} -> ${afterSend.received_total}`);
  ok('and does not touch the agreed retainer either',
     afterSend.agreed === beforeSend.agreed);

  await call(env, '/submissions/API-RB1/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });
  const iws = await jsonOf(await call(env, '/cases/API-RB1/workspace', { cookie: inv }));
  ok('none of it ever reaches an investigator',
     !JSON.stringify(iws.authorization).match(/retainer|1500|2000|billed_at_rate/i));
  // The overview's progress fields (UIBUILD P7) sit behind the same wall: a
  // build is a client deliverable and an invoice is money.
  ok('an investigator workspace has no build status',
     !('build_status' in iws) && !('invoice_status' in iws));

  // The claims side of the wall: authorized hours that match a block name
  // the package, and only then.
  await call(env, '/cases/API-RB2/meta', { method: 'POST', cookie: admin, body: { authorized_hours: 24 } });
  let aws = await jsonOf(await call(env, '/cases/API-RB2/workspace', { cookie: admin }));
  ok('24 authorized hours names the $3,300 package',
     aws.authorization.package_price === 3300 && aws.authorization.package_label === 'Three days');
  await call(env, '/cases/API-RB2/meta', { method: 'POST', cookie: admin, body: { authorized_hours: 10 } });
  aws = await jsonOf(await call(env, '/cases/API-RB2/workspace', { cookie: admin }));
  ok('off-ladder hours name no package', aws.authorization.package_price === undefined);
}

section("Invoices: the office's money desk, and BILL only collects");
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const tok = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tok}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  await ingest(env, { case_no: 'API-IV1', carrier: 'Example Mutual', claim_number: 'WC-2026-11452',
                      adjuster: 'Dana Reyes', billing_email: 'ap@examplemutual.test',
                      client_name: 'Dana Reyes', subject_name: 'Pat Coleman', date_of_loss: '03/14/2026' });
  await ingest(env, { case_no: 'API-IV2', service: 'Surveillance',
                      client_name: 'Jane Client', subject_name: 'John Subject' });
  await call(env, '/cases/API-IV1/meta', { method: 'POST', cookie: admin, body: { authorized_hours: 24 } });

  /* The security line first: an investigator has no invoice surface at all. */
  ok('an investigator cannot create an invoice',
     (await call(env, '/cases/API-IV1/invoices', { method: 'POST', cookie: inv, body: {} })).status === 403);
  ok('or list them',
     (await call(env, '/invoices', { cookie: inv })).status === 403);
  ok('or touch billing settings',
     (await call(env, '/billing-settings', { cookie: inv })).status === 403);

  /* CREATE FROM AUTHORIZATION: 24 authorized hours bill as the flat block —
     one line, no per-hour arithmetic on it. */
  const made = await jsonOf(await call(env, '/cases/API-IV1/invoices', { method: 'POST', cookie: admin,
    body: { from_authorization: true } }));
  const iv1 = made.invoice;
  ok('the number is server-side and sequential', /^API-INV-\d{4}-0001$/.test(iv1.invoice_no), iv1.invoice_no);
  ok('the case pre-fills the bill-to block',
     iv1.bill_to.includes('Example Mutual') && iv1.bill_to.includes('Attn: Dana Reyes'));
  ok('the billing email came from the case', iv1.billing_email === 'ap@examplemutual.test');
  ok('the claim references rode along', iv1.refs.claim_number === 'WC-2026-11452'
     && iv1.refs.claimant === 'Pat Coleman');
  ok('the package bills flat — one line, no rate shown',
     iv1.lines.length === 1 && iv1.lines[0].description === '24-Hour Surveillance Authorization'
     && iv1.lines[0].rate === null && iv1.lines[0].amount === 3300);
  ok('totals are computed, not stored', iv1.subtotal === 3300 && iv1.total === 3300
     && iv1.balance_due === 3300 && iv1.status === 'draft');
  ok('insurance terms default from settings', iv1.payment_terms === 'Net 30');

  ok('a second invoice on the case warns before it exists',
     (await call(env, '/cases/API-IV1/invoices', { method: 'POST', cookie: admin, body: {} })).status === 409);

  const priv = (await jsonOf(await call(env, '/cases/API-IV2/invoices', { method: 'POST', cookie: admin,
    body: { from_authorization: true } }))).invoice;
  ok('a private case opens with the retainer, never a surcharge',
     priv.invoice_type === 'private' && priv.lines[0].description === 'Investigation Retainer'
     && priv.lines[0].amount === 1500
     && priv.client_notes.includes('applied toward authorized investigative services'));
  ok('private terms are their own', priv.payment_terms === 'Due on receipt');
  ok('numbers stay sequential across types', /-0002$/.test(priv.invoice_no));

  /* MASTER §28's private list: Retainer, Amount Applied, Additional
     Authorization, Balance. All derived, so a second invoice on the same case
     draws the retainer down rather than leaving a stale figure behind. */
  /* These two numbers used to be 1500/0 — which encoded the bug rather than
     the rule. Billing the retainer is asking for the DEPOSIT; no work has
     been done, so nothing is applied and the whole retainer remains. The old
     assertion made the client's own document say "Applied $1,500 · Remaining
     $0" on the very invoice requesting it. */
  ok('a private invoice carries the retainer block',
     priv.retainer && priv.retainer.amount === 1500 && priv.retainer.applied === 0
     && priv.retainer.balance === 1500);
  ok('it says whether the money is actually in', priv.retainer.received === false);
  ok('no additional authorization until one is set', priv.retainer.additional_authorized === null);
  ok('an insurance invoice has no retainer block — it is not that product',
     iv1.retainer === null);

  await call(env, '/cases/API-IV2/meta', { method: 'POST', cookie: admin,
    body: { authorized_budget: 2500 } });
  const privAgain = (await jsonOf(await call(env, `/invoices/${priv.id}`, { cookie: admin }))).invoice;
  ok('an authorized budget above the retainer reads as the additional authorization',
     privAgain.retainer.additional_authorized === 1000);

  /* §28's Special Instructions — the carrier's own billing instruction. */
  const withSpecial = (await jsonOf(await call(env, `/invoices/${iv1.id}`, { method: 'POST', cookie: admin,
    body: { refs: { ...iv1.refs, special_instructions: 'Submit through the vendor portal; PO on every page.' } } }))).invoice;
  ok('special instructions are stored with the invoice references',
     withSpecial.refs.special_instructions.includes('vendor portal'));
  ok('and the claim references it rode in with are untouched',
     withSpecial.refs.claim_number === 'WC-2026-11452');

  /* The gatekeeping: drafts take no payments, Ready validates, paid is
     arithmetic and never a button. */
  ok('a draft takes no payments',
     (await call(env, `/invoices/${iv1.id}/payments`, { method: 'POST', cookie: admin,
       body: { amount: 100, paid_date: '2026-08-13' } })).status === 400);
  ok('paid can never be clicked into being',
     (await call(env, `/invoices/${iv1.id}/status`, { method: 'POST', cookie: admin,
       body: { status: 'paid' } })).status === 400);
  ok('BILL cannot be reached from a draft',
     (await call(env, `/invoices/${iv1.id}/status`, { method: 'POST', cookie: admin,
       body: { status: 'sent_to_bill' } })).status === 400);

  const readied = await jsonOf(await call(env, `/invoices/${iv1.id}/status`, { method: 'POST', cookie: admin,
    body: { status: 'ready' } }));
  ok('a complete draft goes Ready', readied.invoice.status === 'ready');
  ok('and the carrier gaps warn without blocking',
     readied.warnings.some(w => w.includes('PO number'))
     && readied.warnings.some(w => w.includes('vendor number'))
     && !readied.warnings.some(w => w.includes('claim number')));

  /* Additional authorized hours are their own clearly-priced line. */
  const relined = (await jsonOf(await call(env, `/invoices/${iv1.id}/lines`, { method: 'POST', cookie: admin,
    body: { lines: [
      { description: '24-Hour Surveillance Authorization', amount: 3300 },
      { description: 'Additional Authorized Surveillance', qty: 4, rate: 150 },
    ] } }))).invoice;
  ok('a rate line computes its own amount', relined.lines[1].amount === 600);
  ok('and the totals follow', relined.total === 3900 && relined.balance_due === 3900);

  const sent = (await jsonOf(await call(env, `/invoices/${iv1.id}/status`, { method: 'POST', cookie: admin,
    body: { status: 'sent_to_bill' } }))).invoice;
  ok('Ready can go to BILL, stamped when', sent.status === 'sent_to_bill' && sent.sent_to_bill_at != null
     && sent.billing_provider === 'bill');
  ok('sent to BILL is NOT paid', sent.display_status !== 'paid' && sent.balance_due === 3900);

  await call(env, `/invoices/${iv1.id}/bill`, { method: 'POST', cookie: admin,
    body: { external_invoice_id: 'BILL-7741', external_status: 'processing' } });
  const withRef = (await jsonOf(await call(env, `/invoices/${iv1.id}`, { cookie: admin }))).invoice;
  ok('the BILL reference is preserved', withRef.external_invoice_id === 'BILL-7741');

  /* Partial payments: arithmetic decides the status. */
  const p1 = (await jsonOf(await call(env, `/invoices/${iv1.id}/payments`, { method: 'POST', cookie: admin,
    body: { amount: 1000, paid_date: '2026-08-20', method: 'ach', provider: 'bill',
            external_payment_id: 'PAY-1' } }))).invoice;
  ok('a first payment leaves it partially paid', p1.status === 'partially_paid' && p1.balance_due === 2900);
  const p2 = (await jsonOf(await call(env, `/invoices/${iv1.id}/payments`, { method: 'POST', cookie: admin,
    body: { amount: 2900, paid_date: '2026-08-27', method: 'check' } }))).invoice;
  ok('the balance reaching zero is what makes it PAID', p2.status === 'paid' && p2.balance_due === 0);

  /* Void keeps the record and locks the doors. */
  await call(env, `/invoices/${priv.id}/status`, { method: 'POST', cookie: admin, body: { status: 'void' } });
  ok('a void invoice cannot be edited',
     (await call(env, `/invoices/${priv.id}`, { method: 'POST', cookie: admin,
       body: { bill_to: 'someone else' } })).status === 400);
  ok('or paid',
     (await call(env, `/invoices/${priv.id}/payments`, { method: 'POST', cookie: admin,
       body: { amount: 5, paid_date: '2026-08-13' } })).status === 400);
  /* A voided invoice must stop consuming the retainer, or the balance the
     office reads is money the client never actually owed. */
  ok('and it stops drawing down the retainer — the only invoice voided releases all of it',
     (await (async () => {
       const r = (await jsonOf(await call(env, `/invoices/${priv.id}`, { cookie: admin })))
         .invoice.retainer;
       return r.applied === 0 && r.balance === 1500;
     })()));
  ok('or revived',
     (await call(env, `/invoices/${priv.id}/status`, { method: 'POST', cookie: admin,
       body: { status: 'ready' } })).status === 400);

  /* Overdue is computed against today, and the dashboard sums the book. */
  const late = (await jsonOf(await call(env, '/cases/API-IV2/invoices', { method: 'POST', cookie: admin,
    body: {} }))).invoice;   // the void one does not count as a duplicate
  await call(env, `/invoices/${late.id}/lines`, { method: 'POST', cookie: admin,
    body: { lines: [{ description: 'Investigation Retainer', amount: 1500 }] } });
  await call(env, `/invoices/${late.id}`, { method: 'POST', cookie: admin,
    body: { due_date: '2020-01-01' } });
  await call(env, `/invoices/${late.id}/status`, { method: 'POST', cookie: admin, body: { status: 'ready' } });
  const book = await jsonOf(await call(env, '/invoices', { cookie: admin }));
  const lateRow = book.invoices.find(x => x.id === late.id);
  ok('a past-due balance reads overdue without being stored', lateRow.display_status === 'overdue');
  ok('the dashboard sums the outstanding balance', book.summary.outstanding === 1500
     && book.summary.overdue === 1);
  ok('and the month of payments', book.summary.paid_this_month === 3900);
  ok('the status filter answers by what the office sees',
     (await jsonOf(await call(env, '/invoices?status=overdue', { cookie: admin }))).invoices
       .every(x => x.display_status === 'overdue'));

  /* The audit trail names every consequential act. */
  const trail = (await jsonOf(await call(env, `/invoices/${iv1.id}`, { cookie: admin }))).events
    .map(e => e.action);
  for (const a of ['created', 'status_ready', 'lines_replaced', 'status_sent_to_bill',
                   'bill_ref_added', 'payment_recorded']) {
    ok(`the trail records ${a}`, trail.includes(a), trail.join(','));
  }

  /* Settings are configuration, not code. */
  await call(env, '/billing-settings', { method: 'POST', cookie: admin,
    body: { payment_instructions: 'Remit via the BILL payment request.' } });
  ok('billing settings round-trip',
     (await jsonOf(await call(env, '/billing-settings', { cookie: admin }))).settings
       .payment_instructions === 'Remit via the BILL payment request.');
}

/* ---------------- money that has been received is not a draft any more
 *
 * HIGH #3 from the 2026-08-14 audits, verified here before it was fixed.
 *
 * `setInvoiceStatus` guarded `sent_to_bill` and `sent_to_client`, and `ready`
 * validated the CONTENT rather than the current status. `draft` was guarded by
 * nothing at all. So an invoice with real money recorded against it could be
 * put back to draft, and two things followed:
 *
 *   - the edit lock is `!['draft','ready'].includes(status)`, so its lines and
 *     adjustments became rewritable underneath payments already taken;
 *   - `outstanding` and the dashboard sum `status !== 'draft'` on the STORED
 *     status, so a partly-paid invoice dropped out of the receivable while
 *     `balance_due` went on honestly saying money was owed.
 *
 * Money the office is owed stops being visible, which is the one thing an
 * invoice list exists to prevent. The fix refuses `draft` and `ready` once any
 * payment is recorded: the way back is Void, which is already the deliberate,
 * recorded, retainer-releasing door. */
section('An invoice with money against it cannot be put back to draft');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  await ingest(env, { case_no: 'API-BD1', subject_name: 'Pat Coleman', carrier: 'Quiet Mutual',
                      claim_number: 'QM-5', client_name: 'Quiet Mutual Claims' });
  const iv = (await jsonOf(await call(env, '/cases/API-BD1/invoices', { method: 'POST', cookie: admin,
    body: {} }))).invoice;
  await call(env, `/invoices/${iv.id}/lines`, { method: 'POST', cookie: admin,
    body: { lines: [{ description: '24-Hour Surveillance Authorization', amount: 3300 }] } });

  // Back-to-draft is legitimate while nothing has been received.
  await call(env, `/invoices/${iv.id}/status`, { method: 'POST', cookie: admin, body: { status: 'ready' } });
  ok('a reviewed invoice with no payments can still go back to draft',
     (await call(env, `/invoices/${iv.id}/status`, { method: 'POST', cookie: admin,
       body: { status: 'draft' } })).status === 200);

  await call(env, `/invoices/${iv.id}/status`, { method: 'POST', cookie: admin, body: { status: 'ready' } });
  const part = (await jsonOf(await call(env, `/invoices/${iv.id}/payments`, { method: 'POST', cookie: admin,
    body: { amount: 1000, paid_date: '2026-08-20', method: 'check' } }))).invoice;
  ok('a part payment leaves real money owed', part.status === 'partially_paid' && part.balance_due === 2300);

  const before = await jsonOf(await call(env, '/invoices', { cookie: admin }));
  ok('and the office can see it in Outstanding', before.summary.outstanding === 2300);

  // The defect, in one call.
  const revert = await call(env, `/invoices/${iv.id}/status`, { method: 'POST', cookie: admin,
    body: { status: 'draft' } });
  ok('a part-paid invoice is refused the way back to draft', revert.status === 400);
  ok('and the refusal says why', /payment/i.test((await jsonOf(revert)).error || ''));
  ok('nor can it be walked back to ready to unlock the same edits',
     (await call(env, `/invoices/${iv.id}/status`, { method: 'POST', cookie: admin,
       body: { status: 'ready' } })).status === 400);

  const after = await jsonOf(await call(env, '/invoices', { cookie: admin }));
  ok('so the receivable is still on the books', after.summary.outstanding === 2300);
  ok('and it is still not counted as a draft', after.summary.drafts === 0);

  const still = (await jsonOf(await call(env, `/invoices/${iv.id}`, { cookie: admin }))).invoice;
  ok('the invoice keeps the status the payment gave it', still.status === 'partially_paid');
  ok('and its lines stay locked against rewriting',
     (await call(env, `/invoices/${iv.id}/lines`, { method: 'POST', cookie: admin,
       body: { lines: [{ description: 'Rewritten', amount: 1 }] } })).status === 400);

  // A fully paid one is refused for the same reason.
  await call(env, `/invoices/${iv.id}/payments`, { method: 'POST', cookie: admin,
    body: { amount: 2300, paid_date: '2026-08-27', method: 'check' } });
  ok('a fully paid invoice is refused too',
     (await call(env, `/invoices/${iv.id}/status`, { method: 'POST', cookie: admin,
       body: { status: 'draft' } })).status === 400);

  // Void is still the way back, and it is deliberate, recorded and releasing.
  ok('void remains the door out of a paid invoice',
     (await call(env, `/invoices/${iv.id}/status`, { method: 'POST', cookie: admin,
       body: { status: 'void' } })).status === 200);
}

section('Evidence: stored privately, metered, and capped inside the free plan');
{
  const fakeR2 = () => {
    const store = new Map();
    return {
      async put(key, body, opts) { store.set(key, { body, opts }); },
      async get(key) { const o = store.get(key); return o ? { body: o.body } : null; },
      async delete(key) { store.delete(key); },
      _store: store,
    };
  };
  const env = freshEnv();
  env.EVIDENCE = fakeR2();
  env.STORAGE_FREE_TIER = '10000';   // tiny numbers so the refusals run for real
  env.STORAGE_HARD_CAP = '5000';
  env.STORAGE_MAX_FILE = '2000';
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  for (const uname of ['dana', 'reed']) {
    const l = (await jsonOf(await invite(env, admin, { username: uname, display_name: uname, role: 'investigator' }))).url;
    const t = new URL(l, 'https://x.test').searchParams.get('invite');
    await call(env, `/invite/${t}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  }
  const dana = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const reed = (await login(env, 'reed', 'FieldWork2026x')).cookie;
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const danaId = users.users.find(u => u.username === 'dana').id;

  await ingest(env, { case_no: 'API-EV1', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  await call(env, '/submissions/API-EV1/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });

  const mk = (name, bytes, type) => new File([new Uint8Array(bytes).fill(65)], name, { type });
  const up = (cookie, file, extra = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return worker.fetch(new Request(API + '/cases/API-EV1/evidence', {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie }, body: fd }), env);
  };

  ok('an unassigned investigator cannot upload', (await up(reed, mk('x.jpg', 100, 'image/jpeg'))).status === 404);
  ok('a file over the per-file limit is refused before it is stored',
     (await up(admin, mk('big.jpg', 2500, 'image/jpeg'))).status === 413);

  const first = await jsonOf(await up(dana, mk('clip1.jpg', 1800, 'image/jpeg'),
    { classification: 'client_deliverable', note: 'Subject at the gym.' }));
  ok('the assigned investigator uploads field product', typeof first.id === 'number');
  /* IT WENT TO DROPBOX, into this case's Photos folder — asserted against the
     store rather than inferred from a 201. */
  ok('the photograph landed in the case Photos folder',
     DBX.inFolder('Photos').some((f) => f.startsWith('/API-EV1/Photos/clip1-')), DBX.paths().join(' '));
  ok('and all three case folders were made',
     ['Photos', 'Reports', 'Video'].every((f) => DBX.folders.has('/API-EV1/' + f)),
     [...DBX.folders].join(' '));
  /* AND THE CLOUDFLARE METER DID NOT MOVE. These bytes are not on the R2 free
     tier, so counting them would drive the storage card toward a limit this
     file can never reach. */
  ok('the R2 meter does not move for a file that never touched Cloudflare',
     first.usage.bytes_used === 0 && first.usage.percent_of_free === 0,
     JSON.stringify(first.usage));

  let ws = await jsonOf(await call(env, '/cases/API-EV1/workspace', { cookie: dana }));
  /* Owner's decision, 2026-08-14: an upload is ready for the report the moment
     it exists — the firm shoots its own footage and writes its own reports, so
     nothing waits behind a review it would only give itself. */
  ok('a field upload is client-deliverable straight away',
     ws.evidence[0].classification === 'client_deliverable' && ws.evidence[0].note === 'Subject at the gym.');

  await up(admin, mk('clip2.jpg', 1800, 'image/jpeg'), { classification: 'internal_only' });
  ok('an admin classifies at upload',
     (await jsonOf(await call(env, '/cases/API-EV1/workspace', { cookie: admin })))
       .evidence.find(e => e.filename === 'clip2.jpg').classification === 'internal_only');

  /* THE FREE-PLAN FAILSAFE NO LONGER GOVERNS AN UPLOAD, and that is correct
     rather than a hole. Its whole job is to keep the R2 free tier from ever
     billing; these bytes go to Dropbox, so applying it would refuse a photo
     because of what LEGACY files weigh — a failsafe firing about storage it is
     not protecting. The cap here is 5,000 bytes and 3,600 are already "used"
     by the two uploads above under the old accounting. */
  const third = await up(admin, mk('clip3.jpg', 1800, 'image/jpeg'));
  ok('the R2 cap cannot refuse a file that is not going to R2', third.status === 201);
  ok('and nothing was written to the bucket', env.EVIDENCE._store.size === 0);

  // Serving: the bytes come back through the Worker's own session checks.
  const got = await call(env, `/cases/API-EV1/evidence/${first.id}/file`, { cookie: dana });
  ok('the assigned investigator streams their footage back', got.status === 200
     && got.headers.get('content-type') === 'image/jpeg'
     && (await got.arrayBuffer()).byteLength === 1800);
  ok('an unassigned investigator gets nothing',
     (await call(env, `/cases/API-EV1/evidence/${first.id}/file`, { cookie: reed })).status === 404);

  ok('an investigator cannot reclassify',
     (await call(env, `/cases/API-EV1/evidence/${first.id}`, { method: 'POST', cookie: dana,
       body: { classification: 'client_deliverable' } })).status === 403);
  ok('the office can',
     (await call(env, `/cases/API-EV1/evidence/${first.id}`, { method: 'POST', cookie: admin,
       body: { classification: 'client_deliverable' } })).status === 200);

  ok('an investigator cannot delete evidence',
     (await call(env, `/cases/API-EV1/evidence/${first.id}/delete`, { method: 'POST', cookie: dana })).status === 403);
  const del = await jsonOf(await call(env, `/cases/API-EV1/evidence/${first.id}/delete`,
    { method: 'POST', cookie: admin }));
  ok('an admin delete leaves the R2 meter where it was', del.usage.bytes_used === 0);
  ok('and the file is truly gone from Dropbox',
     !DBX.paths().some((f) => f.startsWith('/API-EV1/Photos/clip1-')), DBX.paths().join(' '));
  ok('but the record of it stays, stamped',
     (await env.DB.prepare('SELECT deleted_at, deleted_by FROM case_evidence WHERE id = ?')
       .bind(first.id).first()).deleted_at != null);
  ok('a deleted object no longer serves',
     (await call(env, `/cases/API-EV1/evidence/${first.id}/file`, { cookie: admin })).status === 404);
  ws = await jsonOf(await call(env, '/cases/API-EV1/workspace', { cookie: dana }));
  ok('the field sees only what exists', ws.evidence.length === 2, String(ws.evidence.length));
  ok('the office also sees the removal record',
     (await jsonOf(await call(env, '/cases/API-EV1/workspace', { cookie: admin }))).evidence.length === 3);

  /* Same name again, after the first was deleted. Dropbox has no conflict to
     autorename around at this point, so this is exactly the case the random
     token in the stored name exists for: without it the path would repeat and
     r2_key's UNIQUE constraint would reject the row. */
  ok('a file of the same name uploads again after a deletion',
     (await up(admin, mk('clip1.jpg', 1800, 'image/jpeg'))).status === 201);

  /* Links ride only within the case: a photo joins this case's subject, a
     clip joins this case's moment, and another case's ids are refused. */
  const subj = await jsonOf(await call(env, '/cases/API-EV1/subjects', { method: 'POST', cookie: admin,
    body: { name: 'Sam Watched' } }));
  await call(env, '/cases/API-EV1/activity', { method: 'POST', cookie: dana,
    body: { at_date: '2026-08-13', at_time: '07:14', kind: 'activity',
            description: 'Subject vehicle observed parked at residence.' } });
  const entry = (await jsonOf(await call(env, '/cases/API-EV1/workspace', { cookie: admin }))).activity[0];
  const linked = await jsonOf(await up(admin, mk('subj.jpg', 400, 'image/jpeg'), { subject_id: String(subj.id) }));
  ok('a photo attaches to the subject', typeof linked.id === 'number');
  const clip = await jsonOf(await up(admin, mk('moment.jpg', 400, 'image/jpeg'), { entry_id: String(entry.id) }));
  ok('a clip attaches to the moment', typeof clip.id === 'number');
  const evList = (await jsonOf(await call(env, '/cases/API-EV1/workspace', { cookie: dana }))).evidence;
  ok('the links come back with the workspace',
     evList.find(e => e.filename === 'subj.jpg').subject_id === subj.id
     && evList.find(e => e.filename === 'moment.jpg').entry_id === entry.id);
  ok("another case's subject is refused, not silently dropped",
     (await up(admin, mk('x.jpg', 100, 'image/jpeg'), { subject_id: '999999' })).status === 400);

  /* A FILE FROM BEFORE THIS CHANGE. Planted directly, because there is no
     longer any route that writes to R2 — which is the point. Nothing was
     migrated and nothing was deleted (owner), so it still serves and it is
     still what the meter is about. */
  await env.DB.prepare(
    `INSERT INTO case_evidence (case_no, r2_key, filename, content_type, size_bytes,
       classification, uploaded_by, uploaded_at)
     VALUES ('API-EV1', 'cases/API-EV1/legacy.jpg', 'legacy.jpg', 'image/jpeg', 2200,
       'client_deliverable', 1, ?)`).bind(new Date().toISOString()).run();
  await env.EVIDENCE.put('cases/API-EV1/legacy.jpg', new Uint8Array(2200).fill(66));
  const legacyId = (await env.DB.prepare(
    "SELECT id FROM case_evidence WHERE r2_key = 'cases/API-EV1/legacy.jpg'").first()).id;
  const gotOld = await call(env, `/cases/API-EV1/evidence/${legacyId}/file`, { cookie: admin });
  ok('a file uploaded before the move still serves, straight from the bucket',
     gotOld.status === 200 && (await gotOld.arrayBuffer()).byteLength === 2200);

  const st = await jsonOf(await call(env, '/storage', { cookie: admin }));
  /* THE METER COUNTS THE LEGACY FILE AND NOTHING ELSE, with six Dropbox files
     on the same case. That is the whole property in one number. */
  ok('the storage meter is admin-only',
     (await call(env, '/storage', { cookie: dana })).status === 403
     && st.storage.bytes_used === 2200, JSON.stringify(st.storage));
  ok('the public health check carries only the bare percentage',
     (await jsonOf(await call(env, '/health'))).storage_pct === 22);

  /* Linking after upload (UIBUILD P9's fold): the uploader ties their file to
     the moment it documents; nobody re-files someone else's work. */
  const late = await jsonOf(await up(dana, mk('late.jpg', 200, 'image/jpeg')));
  ok('a file can be linked to a moment after upload',
     (await call(env, `/cases/API-EV1/evidence/${late.id}/link`, { method: 'POST', cookie: dana,
       body: { entry_id: entry.id } })).status === 200);
  ok('and the link lands in the workspace',
     (await jsonOf(await call(env, '/cases/API-EV1/workspace', { cookie: dana })))
       .evidence.find(e => e.id === late.id).entry_id === entry.id);
  ok("an investigator cannot re-file someone else's upload",
     (await call(env, `/cases/API-EV1/evidence/${clip.id}/link`, { method: 'POST', cookie: dana,
       body: { entry_id: entry.id } })).status === 403);
  ok('a moment from another case is refused',
     (await call(env, `/cases/API-EV1/evidence/${late.id}/link`, { method: 'POST', cookie: dana,
       body: { entry_id: 999999 } })).status === 400);
  ok('null unlinks',
     (await call(env, `/cases/API-EV1/evidence/${late.id}/link`, { method: 'POST', cookie: dana,
       body: { entry_id: null } })).status === 200
     && (await jsonOf(await call(env, '/cases/API-EV1/workspace', { cookie: dana })))
       .evidence.find(e => e.id === late.id).entry_id === null);

  /* NO DROPBOX, NO UPLOAD — and it says which of the two reasons it is. There
     is deliberately no R2 fallback: a photo quietly written somewhere else is
     half a case in the wrong place, found weeks later by whoever goes looking
     for it. */
  const bare = freshEnv();
  delete bare.DROPBOX_REFRESH_TOKEN;
  await bootstrapAdmin(bare);
  const a2 = (await login(bare, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(bare, { case_no: 'API-EV2', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  const upBare = async () => {
    const fd2 = new FormData(); fd2.append('file', mk('x.jpg', 10, 'image/jpeg'));
    return worker.fetch(new Request(API + '/cases/API-EV2/evidence', {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: a2 }, body: fd2 }), bare);
  };
  let refused = await upBare();
  ok('with no Dropbox connected the upload is refused, by name',
     refused.status === 503 && (await jsonOf(refused)).code === 'dropbox_not_connected');
  delete bare.DROPBOX_APP_KEY; delete bare.DROPBOX_APP_SECRET;
  refused = await upBare();
  ok('and an unconfigured app is a different, equally named condition',
     refused.status === 503 && (await jsonOf(refused)).code === 'provider_not_configured');
  bare.DROPBOX_APP_KEY = 'test-app-key'; bare.DROPBOX_APP_SECRET = 'test-app-secret';
  bare.DROPBOX_REFRESH_TOKEN = 'RT-test';
  DBX.down = true;
  refused = await upBare();
  DBX.down = false;
  ok('and Dropbox being unreachable never falls back to R2',
     refused.status === 503 && (await jsonOf(refused)).code === 'dropbox_unreachable');
  ok('nothing was stored anywhere by any of those three',
     (await bare.DB.prepare('SELECT COUNT(*) AS n FROM case_evidence').first()).n === 0);
}

section('Case Build: the package behind hard gates');
{
  const fakeR2 = () => {
    const store = new Map();
    return {
      async put(key, body, opts) { store.set(key, { body, opts }); },
      async get(key) { const o = store.get(key); return o ? { body: o.body } : null; },
      async delete(key) { store.delete(key); },
      _store: store,
    };
  };
  const env = freshEnv();
  env.EVIDENCE = fakeR2();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const tok = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tok}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  await ingest(env, { case_no: 'API-CB1', service: 'Surveillance', client_name: 'C', subject_name: 'S' });

  ok('an investigator has no build surface at all',
     (await call(env, '/cases/API-CB1/build', { cookie: inv })).status === 403
     && (await call(env, '/external-storage', { cookie: inv })).status === 403);

  /* The raw material: a worked day, a report, classified evidence. The day is
     DANA'S on purpose (owner, 2026-08-19): an admin's own report no longer
     waits on approval, so the approval gate this section pins is the one that
     still exists — an investigator's report waiting on the office. */
  await call(env, '/submissions/API-CB1/assign', { method: 'POST', cookie: admin,
    body: { user_id: (await jsonOf(await call(env, '/users', { cookie: admin })))
      .users.find(u => u.username === 'dana').id } });
  await call(env, '/cases/API-CB1/day/start', { method: 'POST', cookie: inv,
    body: { day_date: '2026-08-13', start_time: '07:00' } });
  await call(env, '/cases/API-CB1/activity', { method: 'POST', cookie: inv,
    body: { at_date: '2026-08-13', at_time: '08:21', kind: 'activity',
            description: 'Subject arrived at ABC Fitness.' } });
  await call(env, '/cases/API-CB1/day/end', { method: 'POST', cookie: inv, body: { end_time: '15:00' } });
  const dayId = (await jsonOf(await call(env, '/cases/API-CB1/workspace', { cookie: inv }))).days[0].id;
  const rep = await jsonOf(await call(env, '/cases/API-CB1/reports/generate', { method: 'POST', cookie: inv,
    body: { day_id: dayId } }));
  await call(env, `/cases/API-CB1/reports/${rep.id}/status`, { method: 'POST', cookie: inv, body: { status: 'submitted' } });

  const up = (file, extra = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return worker.fetch(new Request(API + '/cases/API-CB1/evidence', {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: admin }, body: fd }), env);
  };
  const mk = (name, bytes, type) => new File([new Uint8Array(bytes).fill(65)], name, { type });
  const photo1 = (await jsonOf(await up(mk('photo1.jpg', 300, 'image/jpeg'), { classification: 'client_deliverable' }))).id;
  // Held back ON PURPOSE. Since 2026-08-14 an upload defaults to
  // client-deliverable — the firm shoots its own footage and writes its own
  // reports — so holding something back is now the deliberate act, and this
  // is what the gate exists to catch.
  const photo2 = (await jsonOf(await up(mk('photo2.jpg', 300, 'image/jpeg'),
    { classification: 'needs_redaction' }))).id;
  // Legacy stored video — the only way a video evidence row exists now.
  const clip = await plantLegacyVideo(env, 'API-CB1', 'clip.mp4');
  const doc = (await jsonOf(await up(mk('summary.pdf', 200, 'application/pdf'), { classification: 'client_deliverable' }))).id;

  // The investigator's report is not approved yet: the build opens, and the
  // gate says exactly that.
  let st = await jsonOf(await call(env, '/cases/API-CB1/build', { method: 'POST', cookie: admin }));
  ok('a draft build opens', st.build.status === 'draft' && st.build.version === 1);
  ok('only one draft at a time',
     (await call(env, '/cases/API-CB1/build', { method: 'POST', cookie: admin })).status === 409);
  ok('the gate names the missing approval',
     st.gates.some(g => g.includes('approve') || g.includes('approved')));

  ok('a file held back on purpose is refused, with its reason',
     (await jsonOf(await call(env, `/build/${st.build.id}/items`, { method: 'POST', cookie: admin,
       body: { evidence_id: photo2 } }))).error.includes('needs redaction'));
  await call(env, `/build/${st.build.id}/items`, { method: 'POST', cookie: admin, body: { evidence_id: photo1 } });
  await call(env, `/build/${st.build.id}/items`, { method: 'POST', cookie: admin, body: { evidence_id: clip } });
  await call(env, `/build/${st.build.id}/items`, { method: 'POST', cookie: admin, body: { evidence_id: doc } });
  st = await jsonOf(await call(env, '/cases/API-CB1/build', { cookie: admin }));
  ok('roles follow the content type',
     st.items.find(i => i.evidence_id === photo1).role === 'photo'
     && st.items.find(i => i.evidence_id === clip).role === 'video'
     && st.items.find(i => i.evidence_id === doc).role === 'attachment');
  ok('the same file cannot join twice',
     (await call(env, `/build/${st.build.id}/items`, { method: 'POST', cookie: admin,
       body: { evidence_id: photo1 } })).status === 409);

  ok('a video in a photos-only package is a named gate',
     st.gates.some(g => g.includes('package type does not include video')));
  await call(env, `/build/${st.build.id}/package`, { method: 'POST', cookie: admin,
    body: { package_type: 'report_photos_video' } });

  /* Reclassification after selection cannot sneak through: the gate names
     the file at finalize time, alongside the unapproved report. */
  await call(env, `/cases/API-CB1/evidence/${photo1}`, { method: 'POST', cookie: admin,
    body: { classification: 'internal_only' } });
  const blocked = await jsonOf(await call(env, `/build/${st.build.id}/finalize`, { method: 'POST', cookie: admin }));
  ok('a file reclassified after selection blocks finalize by name',
     blocked.gates.some(g => g.includes('photo1.jpg')));
  ok('and the unapproved report blocks beside it',
     blocked.gates.some(g => g.includes('approve')));
  await call(env, `/cases/API-CB1/evidence/${photo1}`, { method: 'POST', cookie: admin,
    body: { classification: 'client_deliverable' } });

  // Approve the report; finalize binds it automatically and the package closes.
  await call(env, `/cases/API-CB1/reports/${rep.id}/status`, { method: 'POST', cookie: admin, body: { status: 'approved' } });
  st = await jsonOf(await call(env, `/build/${st.build.id}/finalize`, { method: 'POST', cookie: admin }));
  ok('with every gate clear the package finalizes', st.build.status === 'finalized'
     && st.build.report_id != null && st.build.finalized_at != null);
  ok('a finalized package takes no more items',
     (await call(env, `/build/${st.build.id}/items`, { method: 'POST', cookie: admin,
       body: { evidence_id: photo2 } })).status === 400);
  ok('delivery is recorded on the finalized package',
     (await jsonOf(await call(env, `/build/${st.build.id}/delivered`, { method: 'POST', cookie: admin })))
       .build.delivered_at != null);

  st = await jsonOf(await call(env, `/build/${st.build.id}/reopen`, { method: 'POST', cookie: admin }));
  ok('reopening rebuilds the same version', st.build.status === 'draft' && st.build.version === 1);
  await call(env, `/build/${st.build.id}/finalize`, { method: 'POST', cookie: admin });
  const v2 = await jsonOf(await call(env, '/cases/API-CB1/build', { method: 'POST', cookie: admin }));
  ok('a new build after a finalized one is the next version', v2.build.version === 2);

  const trail = (await jsonOf(await call(env, '/cases/API-CB1/build', { cookie: admin }))).events
    .map(e => e.action);
  ok('the audit trail names the acts',
     ['created'].every(a => trail.includes(a)));

  /* The provider panel with Dropbox deliberately absent. Taken away at the END
     of this section rather than never granted, because the uploads above now
     require it — a case cannot get a photograph without one. */
  delete env.DROPBOX_APP_KEY; delete env.DROPBOX_APP_SECRET; delete env.DROPBOX_REFRESH_TOKEN;
  ok('dropbox reports not configured, in words',
     (await jsonOf(await call(env, '/external-storage', { cookie: admin }))).providers.dropbox.configured === false);
  ok('provider actions say what is missing instead of failing quietly',
     (await jsonOf(await call(env, `/build/${v2.build.id}/upload-videos`, { method: 'POST', cookie: admin })))
       .code === 'provider_not_configured');
}

/* MASTER §13 — "Do not assume one case = one day." A surveillance case runs
   three days and approves three daily reports; the package used to ship the
   third one alone, because case_builds.report_id holds exactly one. */
section('Case Build: a package carries the whole investigation');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  /* The investigation is DANA'S here for the reason the hard-gates section
     says: approved-vs-not only still exists for an investigator's reports,
     and this section is entirely about that line. */
  const mdLink = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const mdTok = new URL(mdLink, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${mdTok}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  await ingest(env, { case_no: 'API-MD1', kind: 'claims', service: 'Insurance claim assignment',
                      carrier: 'Acme Mutual', claim_number: 'CLM-77', client_name: 'An Adjuster',
                      subject_name: 'Dale Rivers', claim_type: 'Workers compensation',
                      date_of_loss: '2026-03-04',
                      objective: 'Establish activity level against the stated restrictions.' });

  await call(env, '/submissions/API-MD1/assign', { method: 'POST', cookie: admin,
    body: { user_id: (await jsonOf(await call(env, '/users', { cookie: admin })))
      .users.find(u => u.username === 'dana').id } });

  // Three worked days, each with its own report from the field.
  const repIds = [];
  for (const [d, s, e] of [['2026-08-10', '07:00', '15:00'],
                           ['2026-08-11', '06:30', '14:30'],
                           ['2026-08-12', '08:00', '16:00']]) {
    await call(env, '/cases/API-MD1/day/start', { method: 'POST', cookie: inv,
      body: { day_date: d, start_time: s } });
    await call(env, '/cases/API-MD1/activity', { method: 'POST', cookie: inv,
      body: { at_date: d, at_time: '09:00', kind: 'activity', description: `Observation on ${d}.` } });
    await call(env, '/cases/API-MD1/day/end', { method: 'POST', cookie: inv, body: { end_time: e } });
  }
  /* The workspace hands days back newest-first, which is right for a screen
     and wrong for building Day 1 / Day 2 / Day 3 — so sort here and let
     repIds[n] mean the nth day of the investigation. */
  const days = (await jsonOf(await call(env, '/cases/API-MD1/workspace', { cookie: admin }))).days
    .slice().sort((a, b) => a.day_date < b.day_date ? -1 : 1);
  ok('three days are on the case', days.length === 3);
  for (const day of days) {
    const r = await jsonOf(await call(env, '/cases/API-MD1/reports/generate', { method: 'POST',
      cookie: inv, body: { day_id: day.id } }));
    repIds.push(r.id);
    await call(env, `/cases/API-MD1/reports/${r.id}/status`, { method: 'POST', cookie: inv,
      body: { status: 'submitted' } });
  }
  // Approve only the first two — the third stays out for now.
  for (const id of repIds.slice(0, 2)) {
    await call(env, `/cases/API-MD1/reports/${id}/status`, { method: 'POST', cookie: admin,
      body: { status: 'approved' } });
  }

  let st = await jsonOf(await call(env, '/cases/API-MD1/build', { method: 'POST', cookie: admin }));
  ok('opening a build attaches every approved day, not just the latest', st.reports.length === 2);
  ok('the days come back oldest first, the order a reader expects',
     st.reports[0].report_date === '2026-08-10' && st.reports[1].report_date === '2026-08-11');
  ok('each day carries the hours and the investigator its section needs',
     st.reports.every(r => r.hours != null && r.investigator));
  ok('the unapproved third day is not in the package',
     !st.reports.some(r => r.report_date === '2026-08-12'));
  ok('and is not offered either, because it is not approved yet',
     (st.available_reports || []).length === 0);
  ok('the creation event says how many days it opened on',
     st.events.some(e => e.action === 'created' && /2 reports, 2026-08-10 to 2026-08-11/.test(e.detail || '')));

  ok('an unapproved day cannot be forced into the package',
     (await jsonOf(await call(env, `/build/${st.build.id}/reports`, { method: 'POST', cookie: admin,
       body: { report_id: repIds[2] } }))).error.includes('approve it first'));

  // Approve the third day AFTER the build was opened — the ordinary case.
  await call(env, `/cases/API-MD1/reports/${repIds[2]}/status`, { method: 'POST', cookie: admin,
    body: { status: 'approved' } });
  st = await jsonOf(await call(env, '/cases/API-MD1/build', { cookie: admin }));
  ok('a day approved after the build opened is offered, not silently dropped',
     st.available_reports.length === 1 && st.available_reports[0].report_date === '2026-08-12');

  st = await jsonOf(await call(env, `/build/${st.build.id}/reports`, { method: 'POST', cookie: admin,
    body: { report_id: repIds[2] } }));
  ok('adding it puts the package back to three days, still in date order',
     st.reports.length === 3 && st.reports[2].report_date === '2026-08-12'
     && st.available_reports.length === 0);
  ok('the same day cannot be added twice',
     (await call(env, `/build/${st.build.id}/reports`, { method: 'POST', cookie: admin,
       body: { report_id: repIds[2] } })).status === 409);

  ok('the document has the case information a real report carries',
     st.case_info.claim_number === 'CLM-77' && st.case_info.carrier === 'Acme Mutual'
     && st.case_info.subject_name === 'Dale Rivers' && st.case_info.date_of_loss === '2026-03-04');
  ok('and the assignment objective, which is the point of the whole file',
     st.case_info.objective.includes('activity level against the stated restrictions'));

  // The combined summary: written by an admin, never invented.
  st = await jsonOf(await call(env, `/build/${st.build.id}/summary`, { method: 'POST', cookie: admin,
    body: { body: 'Across three days the claimant was observed driving and lifting.' } }));
  ok('the combined summary is stored on the package', st.summary.includes('driving and lifting'));
  ok('writing it is on the audit trail', st.events.some(e => e.action === 'summary'));
  ok('and it can be cleared again',
     (await jsonOf(await call(env, `/build/${st.build.id}/summary`, { method: 'POST', cookie: admin,
       body: { body: '' } }))).summary === '');

  // Removing a day, and what happens to the primary report_id underneath.
  const primary = st.build.report_id;
  st = await jsonOf(await call(env, `/build/${st.build.id}/reports/${primary}/remove`,
    { method: 'POST', cookie: admin }));
  ok('a day can be dropped from the package', st.reports.length === 2
     && !st.reports.some(r => r.id === primary));
  ok('and the primary report moves to one still in the package',
     st.build.report_id !== primary && st.reports.some(r => r.id === st.build.report_id));
  ok('removing a day that is not in the package is a 404',
     (await call(env, `/build/${st.build.id}/reports/${primary}/remove`,
       { method: 'POST', cookie: admin })).status === 404);
  st = await jsonOf(await call(env, `/build/${st.build.id}/reports`, { method: 'POST', cookie: admin,
    body: { report_id: primary } }));
  ok('and it goes back in', st.reports.length === 3);

  // The gate now reasons over the whole set, by date.
  await call(env, `/cases/API-MD1/reports/${repIds[1]}/status`, { method: 'POST', cookie: admin,
    body: { status: 'needs_revision' } });
  st = await jsonOf(await call(env, '/cases/API-MD1/build', { cookie: admin }));
  ok('one day sent back for revision gates the whole package, by date',
     st.gates.some(g => g.includes('2026-08-11') && g.includes('needs_revision')));
  ok('and finalize refuses on that same named day',
     (await jsonOf(await call(env, `/build/${st.build.id}/finalize`, { method: 'POST', cookie: admin })))
       .gates.some(g => g.includes('2026-08-11')));
  await call(env, `/cases/API-MD1/reports/${repIds[1]}/status`, { method: 'POST', cookie: admin,
    body: { status: 'approved' } });
  st = await jsonOf(await call(env, `/build/${st.build.id}/finalize`, { method: 'POST', cookie: admin }));
  ok('with every day approved the three-day package finalizes',
     st.build.status === 'finalized' && st.reports.length === 3);

  ok('an investigator still has no build surface',
     (await call(env, '/cases/API-MD1/build', { cookie: (await (async () => {
       const link = (await jsonOf(await invite(env, admin,
         { username: 'kim', display_name: 'Kim', role: 'investigator' }))).url;
       const t = new URL(link, 'https://x.test').searchParams.get('invite');
       await call(env, `/invite/${t}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
       return (await login(env, 'kim', 'FieldWork2026x')).cookie;
     })()) })).status === 403);
}

/* MASTER §13 lists four package types and the fourth is Custom. It is a
   marker table rather than a fifth enum value — see build_custom in
   schema.sql — so what it stores and what it reports back differ on purpose. */
section('Case Build: the Custom package');
{
  const env = freshEnv();
  env.EVIDENCE = (() => {
    const store = new Map();
    return { async put(k, b, o) { store.set(k, { b, o }); },
             async get(k) { const o = store.get(k); return o ? { body: o.b } : null; },
             async delete(k) { store.delete(k); } };
  })();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(env, { case_no: 'API-CP1', service: 'Surveillance', client_name: 'C', subject_name: 'S' });

  await call(env, '/cases/API-CP1/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-13', start_time: '07:00' } });
  await call(env, '/cases/API-CP1/activity', { method: 'POST', cookie: admin,
    body: { at_date: '2026-08-13', at_time: '08:00', kind: 'activity', description: 'Observed.' } });
  await call(env, '/cases/API-CP1/day/end', { method: 'POST', cookie: admin, body: { end_time: '15:00' } });
  const dayId = (await jsonOf(await call(env, '/cases/API-CP1/workspace', { cookie: admin }))).days[0].id;
  const rep = await jsonOf(await call(env, '/cases/API-CP1/reports/generate', { method: 'POST',
    cookie: admin, body: { day_id: dayId } }));
  await call(env, `/cases/API-CP1/reports/${rep.id}/status`, { method: 'POST', cookie: admin, body: { status: 'submitted' } });
  await call(env, `/cases/API-CP1/reports/${rep.id}/status`, { method: 'POST', cookie: admin, body: { status: 'approved' } });

  const up = (name, type, cls) => {
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array(300).fill(65)], name, { type }));
    fd.append('classification', cls);
    return worker.fetch(new Request(API + '/cases/API-CP1/evidence', {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: admin }, body: fd }), env);
  };
  const clip = await plantLegacyVideo(env, 'API-CP1', 'clip.mp4', 'client_deliverable', 300);
  const held = (await jsonOf(await up('held.jpg', 'image/jpeg', 'internal_only'))).id;

  let st = await jsonOf(await call(env, '/cases/API-CP1/build', { method: 'POST', cookie: admin }));
  ok('a new build starts on a real type, not custom',
     st.package_type === 'report_photos' && st.custom === false);
  ok('a made-up package type is refused',
     (await call(env, `/build/${st.build.id}/package`, { method: 'POST', cookie: admin,
       body: { package_type: 'deluxe' } })).status === 400);

  await call(env, `/build/${st.build.id}/items`, { method: 'POST', cookie: admin, body: { evidence_id: clip } });
  st = await jsonOf(await call(env, '/cases/API-CP1/build', { cookie: admin }));
  ok('a video in a photos-only package is still a gate',
     st.gates.some(g => g.includes('package type does not include video')));

  st = await jsonOf(await call(env, `/build/${st.build.id}/package`, { method: 'POST', cookie: admin,
    body: { package_type: 'custom' } }));
  ok('custom is accepted and reported back as custom', st.package_type === 'custom' && st.custom === true);
  ok('the video gate does not apply to it — the admin chose the contents',
     !st.gates.some(g => g.includes('package type does not include video')));
  ok('what it stores underneath is a value the live database already allows',
     ['report_only', 'report_photos', 'report_photos_video', 'full'].includes(st.build.package_type));
  ok('picking custom is on the audit trail',
     st.events.some(e => e.action === 'package_type' && e.detail === 'custom'));

  ok('custom controls contents, NOT whether held-back material can ship',
     (await jsonOf(await call(env, `/build/${st.build.id}/items`, { method: 'POST', cookie: admin,
       body: { evidence_id: held } }))).error.includes('internal only'));

  st = await jsonOf(await call(env, `/build/${st.build.id}/finalize`, { method: 'POST', cookie: admin }));
  ok('a custom package finalizes', st.build.status === 'finalized');
  st = await jsonOf(await call(env, `/build/${st.build.id}/reopen`, { method: 'POST', cookie: admin }));
  ok('and is still custom after a reopen', st.package_type === 'custom');

  st = await jsonOf(await call(env, `/build/${st.build.id}/package`, { method: 'POST', cookie: admin,
    body: { package_type: 'full' } }));
  ok('switching away from custom clears the marker',
     st.package_type === 'full' && st.custom === false);
}

/* MASTER §31 — "Do not bury completed cases in a difficult archive." The desk
   is one payload: every finished case and where its artifacts live. */
section('Completed cases: finished work is findable');
{
  const env = freshEnv();
  env.EVIDENCE = (() => {
    const store = new Map();
    return { async put(k, b, o) { store.set(k, { b, o }); },
             async get(k) { const o = store.get(k); return o ? { body: o.b } : null; },
             async delete(k) { store.delete(k); } };
  })();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  await call(env, `/invite/${new URL(link, 'https://x.test').searchParams.get('invite')}/accept`,
    { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  ok('the desk is the office\'s alone',
     (await call(env, '/completed', { cookie: inv })).status === 403);
  ok('an empty portal has an empty desk',
     (await jsonOf(await call(env, '/completed', { cookie: admin }))).completed.length === 0);

  await ingest(env, { case_no: 'API-DN1', kind: 'claims', carrier: 'Done Mutual',
                      claim_number: 'DM-9', client_name: 'An Adjuster', subject_name: 'Finished Person' });
  await ingest(env, { case_no: 'API-DN2', service: 'Surveillance',
                      client_name: 'Paid Client', subject_name: 'Watched Person' });
  await ingest(env, { case_no: 'API-DN3', service: 'Surveillance',
                      client_name: 'Walked Away', subject_name: 'Never Started' });

  ok('open cases are not on the desk',
     (await jsonOf(await call(env, '/completed', { cookie: admin }))).completed.length === 0);

  // Route one: the office says the work is complete.
  await call(env, '/submissions/API-DN1/status', { method: 'POST', cookie: admin,
    body: { status: 'complete' } });
  let desk = (await jsonOf(await call(env, '/completed', { cookie: admin }))).completed;
  ok('a case marked Complete lands on the desk',
     desk.length === 1 && desk[0].case_no === 'API-DN1' && desk[0].stage === 'complete');
  ok('with nothing invented for artifacts it does not have',
     desk[0].approved_reports === 0 && desk[0].invoice === null && desk[0].share_url === null);

  // Route two: a finalized client package IS completion of the work, even
  // before the office administratively closes the case.
  await call(env, '/cases/API-DN2/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-13', start_time: '07:00' } });
  await call(env, '/cases/API-DN2/activity', { method: 'POST', cookie: admin,
    body: { at_date: '2026-08-13', at_time: '08:00', kind: 'activity', description: 'Observed.' } });
  await call(env, '/cases/API-DN2/day/end', { method: 'POST', cookie: admin, body: { end_time: '15:00' } });
  const dayId = (await jsonOf(await call(env, '/cases/API-DN2/workspace', { cookie: admin }))).days[0].id;
  const rep = await jsonOf(await call(env, '/cases/API-DN2/reports/generate', { method: 'POST',
    cookie: admin, body: { day_id: dayId } }));
  await call(env, `/cases/API-DN2/reports/${rep.id}/status`, { method: 'POST', cookie: admin, body: { status: 'submitted' } });
  await call(env, `/cases/API-DN2/reports/${rep.id}/status`, { method: 'POST', cookie: admin, body: { status: 'approved' } });
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(300).fill(65)], 'p.jpg', { type: 'image/jpeg' }));
  const up = await jsonOf(await worker.fetch(new Request(API + '/cases/API-DN2/evidence', {
    method: 'POST', headers: { Origin: ORIGIN, Cookie: admin }, body: fd }), env));
  const st = await jsonOf(await call(env, '/cases/API-DN2/build', { method: 'POST', cookie: admin }));
  await call(env, `/build/${st.build.id}/items`, { method: 'POST', cookie: admin, body: { evidence_id: up.id } });
  await call(env, `/build/${st.build.id}/finalize`, { method: 'POST', cookie: admin });
  await call(env, '/cases/API-DN2/invoices', { method: 'POST', cookie: admin, body: {} });

  desk = (await jsonOf(await call(env, '/completed', { cookie: admin }))).completed;
  ok('a finalized package lands the case on the desk without any stage change',
     desk.length === 2 && desk.some(c => c.case_no === 'API-DN2'));
  const dn2 = desk.find(c => c.case_no === 'API-DN2');
  ok('the desk knows where every artifact is', dn2.build_id != null
     && dn2.approved_reports === 1 && dn2.evidence_count === 1
     && dn2.invoice && /^API-INV-/.test(dn2.invoice.invoice_no));
  ok('the newest finished work leads the desk', desk[0].case_no === 'API-DN2');
  ok('and no video link is claimed while none exists', dn2.share_url === null);

  // A delivery link, once one exists, is offered for copying.
  await env.DB.prepare(
    `INSERT INTO external_files (evidence_id, storage_provider, external_share_url,
       upload_status, created_at) VALUES (?, 'dropbox', 'https://dbx.example/s/abc', 'uploaded', ?)`)
    .bind(up.id, '2026-08-14T00:00:00Z').run();
  desk = (await jsonOf(await call(env, '/completed', { cookie: admin }))).completed;
  ok('a live delivery link surfaces on the desk',
     desk.find(c => c.case_no === 'API-DN2').share_url === 'https://dbx.example/s/abc');

  /* HIGH #4 (2026-08-14). "Copy video link" is a delivery path, so it carries
     the same rule as the package document: hold the material back and the link
     goes with it. This query filtered on the link alone, so a video
     reclassified to do-not-use — or soft-deleted, which the evidence count
     beside it already honoured — kept its Copy button on the completed desk
     long after the document had stopped printing it. Reclassifying is how an
     admin withdraws something; it must reach every door, not just the one. */
  const shareOf = async () => (await jsonOf(await call(env, '/completed', { cookie: admin })))
    .completed.find(c => c.case_no === 'API-DN2').share_url;

  /* Membership, the condition that makes this desk agree with the package
     panel. A file that is cleared to ship but was never selected into the
     finalized package is not part of what the client received, so its link is
     not the desk's to hand out. The newer id is deliberate: ORDER BY x.id DESC
     means an unpackaged file would otherwise WIN and mask the packaged one. */
  const loose = await jsonOf(await worker.fetch(new Request(API + '/cases/API-DN2/evidence', {
    method: 'POST', headers: { Origin: ORIGIN, Cookie: admin },
    body: (() => { const f = new FormData();
      f.append('file', new File([new Uint8Array(120).fill(66)], 'loose.jpg', { type: 'image/jpeg' }));
      return f; })() }), env));
  await env.DB.prepare(
    `INSERT INTO external_files (evidence_id, storage_provider, external_share_url,
       upload_status, created_at) VALUES (?, 'dropbox', 'https://dbx.example/s/loose', 'uploaded', ?)`)
    .bind(loose.id, '2026-08-14T01:00:00Z').run();
  ok('a link on evidence outside the finalized package is never offered',
     (await shareOf()) === 'https://dbx.example/s/abc');
  ok('and it is still refused once it is client-deliverable — being cleared is not being chosen',
     (await call(env, `/cases/API-DN2/evidence/${loose.id}`, { method: 'POST', cookie: admin,
       body: { classification: 'client_deliverable' } })).status === 200
     && (await shareOf()) === 'https://dbx.example/s/abc');

  ok('holding the video back withdraws its delivery link too',
     (await call(env, `/cases/API-DN2/evidence/${up.id}`, { method: 'POST', cookie: admin,
       body: { classification: 'do_not_use' } })).status === 200
     && (await shareOf()) === null);
  ok('and the other held classifications withdraw it just the same',
     (await call(env, `/cases/API-DN2/evidence/${up.id}`, { method: 'POST', cookie: admin,
       body: { classification: 'needs_redaction' } })).status === 200
     && (await shareOf()) === null
     && (await call(env, `/cases/API-DN2/evidence/${up.id}`, { method: 'POST', cookie: admin,
       body: { classification: 'internal_only' } })).status === 200
     && (await shareOf()) === null);
  ok('clearing it again brings the link back — this is a filter, not a one-way door',
     (await call(env, `/cases/API-DN2/evidence/${up.id}`, { method: 'POST', cookie: admin,
       body: { classification: 'client_deliverable' } })).status === 200
     && (await shareOf()) === 'https://dbx.example/s/abc');
  ok('and deleting the evidence withdraws the link as well',
     (await call(env, `/cases/API-DN2/evidence/${up.id}/delete`,
       { method: 'POST', cookie: admin })).status === 200
     && (await shareOf()) === null);

  // Cancelled is not completed: there is nothing to find.
  await call(env, '/submissions/API-DN3/status', { method: 'POST', cookie: admin,
    body: { status: 'cancelled' } });
  desk = (await jsonOf(await call(env, '/completed', { cookie: admin }))).completed;
  ok('a cancelled case never reads as completed',
     !desk.some(c => c.case_no === 'API-DN3') && desk.length === 2);
}

section('The dashboard summary');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  await ingest(env, { case_no: 'API-S1', client_name: 'A Client', subject_name: 'Subject One' });
  await ingest(env, { case_no: 'API-S2', carrier: 'Acme Mutual', claim_number: 'C-100',
                      client_name: 'B Adjuster', subject_name: 'Subject Two' });

  const sum = (await jsonOf(await call(env, '/summary', { cookie: admin }))).summary;
  ok('the admin summary counts every case', sum.total === 2);
  ok('it splits carrier from private work', sum.claims === 1 && sum.consumer === 1);
  ok('it counts the unassigned queue', sum.unassigned === 2);
  ok('new cases are counted by status', sum.new === 2);

  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const token = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  let mine = (await jsonOf(await call(env, '/summary', { cookie: inv }))).summary;
  ok('an investigator with nothing assigned totals zero', mine.total === 0);
  ok('the firm-wide unassigned queue is not shown to them', !('unassigned' in mine));

  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const dana = users.users.find(u => u.username === 'dana');
  await call(env, '/submissions/API-S1/assign', { method: 'POST', cookie: admin, body: { user_id: dana.id } });

  mine = (await jsonOf(await call(env, '/summary', { cookie: inv }))).summary;
  ok('their summary is their caseload, not the firm book', mine.total === 1 && mine.assigned === 1);
}

/* ------------------------------------------------------- case workspace */

section('Case types');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  const d = await jsonOf(await call(env, '/case-types', { cookie: admin }));
  const labels = d.case_types.map(t => t.label);
  ok('the insurance categories are seeded', labels.includes("Workers' Compensation Surveillance"));
  ok('SIU is a category', labels.includes('SIU / Fraud'));
  ok('the private categories are seeded', labels.includes('Child Custody') && labels.includes('Adultery / Infidelity'));
  ok('locate and skip trace is offered', labels.includes('Locate / Skip Trace'));
  ok('there is an Other / Custom catch-all', labels.includes('Other / Custom'));
  ok('every type declares which side it belongs to',
     d.case_types.every(t => t.side === 'insurance' || t.side === 'private'));

  ok('an admin can add a case type',
     (await call(env, '/case-types', { method: 'POST', cookie: admin,
       body: { label: 'Fire / Arson Investigation', side: 'insurance' } })).status === 201);
  ok('a duplicate is refused',
     (await call(env, '/case-types', { method: 'POST', cookie: admin,
       body: { label: 'Fire / Arson Investigation', side: 'insurance' } })).status === 409);
  ok('an unnamed type is refused',
     (await call(env, '/case-types', { method: 'POST', cookie: admin, body: { side: 'insurance' } })).status === 400);
}

section('The investigation day and the activity log');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(env, { case_no: 'API-W1', carrier: 'Acme Mutual', claim_number: 'C-1',
                      subject_name: 'Pat Coleman', objective: 'Activity level' });

  const t = await jsonOf(await call(env, '/case-types', { cookie: admin }));
  const wc = t.case_types.find(x => x.label === "Workers' Compensation Surveillance");
  ok('authorization can be set on a case',
     (await call(env, '/cases/API-W1/meta', { method: 'POST', cookie: admin,
       body: { case_type_id: wc.id, authorized_hours: 24, authorized_budget: 3600 } })).status === 200);
  ok('non-numeric hours are refused',
     (await call(env, '/cases/API-W1/meta', { method: 'POST', cookie: admin,
       body: { authorized_hours: 'lots' } })).status === 400);

  let ws = await jsonOf(await call(env, '/cases/API-W1/workspace', { cookie: admin }));
  ok('the workspace reports the case type', ws.authorization.case_type === "Workers' Compensation Surveillance");
  ok('it reports the authorized hours', ws.authorization.authorized_hours === 24);
  ok('nothing is used yet', ws.authorization.hours_used === 0);
  ok('no day is running', ws.open_day === null);
  ok('the thresholds are configuration, not constants',
     JSON.stringify(ws.authorization.warn_at) === JSON.stringify([75, 90, 100]));
  // The overview's progress fields (UIBUILD P7): present for the office even
  // while empty, so the page never guesses.
  ok('an admin workspace carries the build state',
     'build_status' in ws && ws.build_status === null);
  ok('and the invoice state', 'invoice_status' in ws && ws.invoice_status === null);

  ok('a day starts',
     (await call(env, '/cases/API-W1/day/start', { method: 'POST', cookie: admin,
       body: { day_date: '2026-08-12', start_time: '07:00', start_mileage: 41000 } })).status === 201);
  ok('a second day cannot start while one is running',
     (await call(env, '/cases/API-W1/day/start', { method: 'POST', cookie: admin,
       body: { day_date: '2026-08-12', start_time: '08:00' } })).status === 409);
  ok('a malformed time is refused',
     (await call(env, '/cases/API-W1/day/start', { method: 'POST', cookie: admin,
       body: { day_date: '2026-08-12', start_time: '25:00' } })).status === 400);

  ws = await jsonOf(await call(env, '/cases/API-W1/workspace', { cookie: admin }));
  ok('the running day comes back with the workspace', ws.open_day && ws.open_day.start_time === '07:00');

  for (const [time, desc] of [
    ['07:03', 'Arrived in vicinity of subject residence.'],
    ['07:14', 'Subject vehicle observed parked at residence.'],
    ['08:17', 'Subject arrived at ABC Fitness.'],
  ]) {
    await call(env, '/cases/API-W1/activity', { method: 'POST', cookie: admin,
      body: { at_date: '2026-08-12', at_time: time, description: desc } });
  }
  ok('an entry with no description is refused',
     (await call(env, '/cases/API-W1/activity', { method: 'POST', cookie: admin,
       body: { at_date: '2026-08-12', at_time: '09:00', description: '  ' } })).status === 400);

  ws = await jsonOf(await call(env, '/cases/API-W1/workspace', { cookie: admin }));
  ok('the log holds every entry', ws.activity.length === 3);
  ok('it reads newest first', ws.activity[0].at_time === '08:17');
  ok('entries attach to the running day', ws.activity.every(e => e.day_id === ws.open_day.id));
  ok('each entry names who logged it', ws.activity[0].investigator === 'Trever');

  const edit = await call(env, `/cases/API-W1/activity/${ws.activity[0].id}`, { method: 'POST', cookie: admin,
    body: { description: 'Subject arrived at ABC Fitness and entered.', location: 'ABC Fitness' } });
  ok('an entry can be corrected', edit.status === 200);
  ws = await jsonOf(await call(env, '/cases/API-W1/workspace', { cookie: admin }));
  ok('the correction is stamped rather than silent', ws.activity[0].edited_at !== null);
  ok('the correction took', ws.activity[0].description.includes('and entered'));

  const end = await jsonOf(await call(env, '/cases/API-W1/day/end', { method: 'POST', cookie: admin,
    body: { end_time: '15:30', end_mileage: 41086, summary: 'Subject active throughout.' } }));
  ok('the day totals its hours', end.hours === 8.5);
  ok('the day totals its mileage', end.miles === 86);
  ok('ending with no day running is refused',
     (await call(env, '/cases/API-W1/day/end', { method: 'POST', cookie: admin, body: { end_time: '16:00' } })).status === 409);

  // Mileage that goes backwards is a typo, and a typo in mileage is money.
  await ingest(env, { case_no: 'API-W3', client_name: 'C', subject_name: 'S' });
  await call(env, '/cases/API-W3/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-12', start_time: '07:00', start_mileage: 41000 } });
  ok('ending mileage below the start is refused',
     (await call(env, '/cases/API-W3/day/end', { method: 'POST', cookie: admin,
       body: { end_time: '15:00', end_mileage: 40900 } })).status === 400);
  ok('the day is still running after a rejected end',
     (await jsonOf(await call(env, '/cases/API-W3/workspace', { cookie: admin }))).open_day !== null);

  ws = await jsonOf(await call(env, '/cases/API-W1/workspace', { cookie: admin }));
  const a = ws.authorization;
  ok('used hours come from completed days', a.hours_used === 8.5);
  ok('remaining is what is left', a.hours_remaining === 15.5);
  ok('the percentage is worked out', a.percent_used === 35.4);
  ok('no warning at 35%', a.warn_level === null);
  ok('the admin sees what it is worth', a.billable_so_far === 8.5 * 150);
  ok('and what is left of the budget', a.budget_remaining === 3600 - (8.5 * 150));
  ok('mileage carries to the case total', a.miles_total === 86);

  // Past the first threshold.
  await call(env, '/cases/API-W1/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-13', start_time: '06:00' } });
  await call(env, '/cases/API-W1/day/end', { method: 'POST', cookie: admin, body: { end_time: '16:00' } });
  ws = await jsonOf(await call(env, '/cases/API-W1/workspace', { cookie: admin }));
  ok('hours accumulate across days', ws.authorization.hours_used === 18.5);
  ok('the 75% threshold trips', ws.authorization.warn_level === 75);

  // A day that runs past midnight is a span, not a negative number.
  await ingest(env, { case_no: 'API-W2', client_name: 'A Client', subject_name: 'Night Subject' });
  await call(env, '/cases/API-W2/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-14', start_time: '22:00' } });
  const night = await jsonOf(await call(env, '/cases/API-W2/day/end', { method: 'POST', cookie: admin,
    body: { end_time: '02:30' } }));
  ok('a day running past midnight totals forwards, not backwards', night.hours === 4.5);
}

/* A real row to build against, with no real client in it. The prefix is the
   whole safety mechanism, so it is tested harder than the feature. */
section('Test cases');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const token = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  /* A half-applied schema is exactly when this button gets pressed, so it must
     not write a case it cannot finish. The first version inserted the
     submission and then failed on case_meta, leaving an orphan behind on every
     click — three of them appeared on the live portal that way. */
  {
    const { DatabaseSync } = await import('node:sqlite');
    const bare = new DatabaseSync(':memory:');
    bare.exec(SCHEMA);
    bare.exec('DROP TABLE case_meta');
    const partialEnv = { ...freshEnv(), DB: d1(bare) };
    await bootstrapAdmin(partialEnv);
    const padmin = (await login(partialEnv, 'trever', 'FirstAdminPass1')).cookie;

    const res = await call(partialEnv, '/demo-case', { method: 'POST', cookie: padmin });
    ok('a test case is refused when the schema is incomplete', res.status === 503, String(res.status));
    ok('and it names the workflow that fixes it',
       (await jsonOf(res)).error.includes('Set up the case portal'));
    const rows = bare.prepare("SELECT COUNT(*) AS n FROM submissions WHERE case_no LIKE 'TEST-%'").get();
    ok('NOTHING was written — no orphan case left behind', rows.n === 0, `found ${rows.n}`);

    // And cleanup still works on that same broken schema, because being unable
    // to tidy up until an unrelated workflow runs would be the wrong way round.
    bare.prepare(`INSERT INTO submissions (case_no, kind, status, payload, created_at)
                  VALUES ('TEST-orphan-1', 'claims', 'new', '{}', ?)`).run(new Date().toISOString());
    const cleared = await call(partialEnv, '/demo-case/clear', { method: 'POST', cookie: padmin });
    ok('clearing works even with tables missing', cleared.status === 200, String(cleared.status));
    ok('and it removed the stray row', (await jsonOf(cleared)).removed === 1);
    ok('the orphan is gone',
       bare.prepare("SELECT COUNT(*) AS n FROM submissions WHERE case_no LIKE 'TEST-%'").get().n === 0);
  }

  ok('an investigator cannot create one',
     (await call(env, '/demo-case', { method: 'POST', cookie: inv })).status === 403);
  ok('nor clear them',
     (await call(env, '/demo-case/clear', { method: 'POST', cookie: inv })).status === 403);

  const made = await call(env, '/demo-case', { method: 'POST', cookie: admin });
  ok('an admin can create one', made.status === 201);
  const caseNo = (await jsonOf(made)).case_no;
  ok('it is unmistakably a test case', /^TEST-\d{8}-[0-9a-f]{4}$/.test(caseNo), caseNo);

  const ws = await jsonOf(await call(env, `/cases/${caseNo}/workspace`, { cookie: admin }));
  ok('it arrives with an authorization to work against', ws.authorization.authorized_hours === 24);
  ok('and a budget', ws.authorization.authorized_budget === 3300);
  ok('and a case type', ws.authorization.case_type === "Workers' Compensation Surveillance");

  const detail = await jsonOf(await call(env, `/submissions/${caseNo}`, { cookie: admin }));
  const blob = JSON.stringify(detail);
  ok('the carrier is marked TEST', blob.includes('Demo Mutual Insurance (TEST)'));
  ok('the subject is marked TEST', blob.includes('TEST subject'));
  ok('the objective says so in words too', blob.includes('This is a test case'));
  ok('every contact address is unroutable', !/@(?!demo\.invalid)[a-z]+\.(com|net|org)/i.test(blob), blob.slice(0, 200));

  // Two in a row must not collide.
  const second = await jsonOf(await call(env, '/demo-case', { method: 'POST', cookie: admin }));
  ok('a second one gets its own number', second.case_no !== caseNo);

  // Work it like a real case, then confirm clearing takes the whole trail.
  await call(env, `/cases/${caseNo}/day/start`, { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-12', start_time: '07:00' } });
  await call(env, `/cases/${caseNo}/activity`, { method: 'POST', cookie: admin,
    body: { at_date: '2026-08-12', at_time: '07:05', description: 'Subject departed residence.' } });
  await call(env, `/cases/${caseNo}/day/end`, { method: 'POST', cookie: admin, body: { end_time: '11:00' } });
  const w = await jsonOf(await call(env, `/cases/${caseNo}/workspace`, { cookie: admin }));
  await call(env, `/cases/${caseNo}/reports/generate`, { method: 'POST', cookie: admin,
    body: { day_id: w.days[0].id } });

  /* THE GUARD. A real case sits beside the test ones; clearing must not
     scratch it, nor any of its workspace rows. */
  await ingest(env, { case_no: 'API-REAL-1', carrier: 'A Real Carrier', claim_number: 'REAL-9',
                      subject_name: 'A Real Subject', client_name: 'A Real Client' });
  await call(env, '/cases/API-REAL-1/meta', { method: 'POST', cookie: admin,
    body: { authorized_hours: 8, authorized_budget: 1200 } });
  await call(env, '/cases/API-REAL-1/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-12', start_time: '08:00' } });
  await call(env, '/cases/API-REAL-1/activity', { method: 'POST', cookie: admin,
    body: { at_date: '2026-08-12', at_time: '08:30', description: 'Real observation.' } });

  ok('clearing succeeds', (await call(env, '/demo-case/clear', { method: 'POST', cookie: admin })).status === 200);

  const after = await jsonOf(await call(env, '/submissions', { cookie: admin }));
  ok('every test case is gone', !after.submissions.some(s => s.case_no.startsWith('TEST-')));
  ok('THE REAL CASE SURVIVES', after.submissions.some(s => s.case_no === 'API-REAL-1'),
     JSON.stringify(after.submissions.map(s => s.case_no)));

  const realWs = await jsonOf(await call(env, '/cases/API-REAL-1/workspace', { cookie: admin }));
  ok('its authorization survives', realWs.authorization.authorized_hours === 8);
  ok('its activity log survives', realWs.activity.length === 1);
  ok('its investigation day survives', realWs.days.length === 1);
  ok('the cleared test workspace is gone',
     (await call(env, `/cases/${caseNo}/workspace`, { cookie: admin })).status === 404);
}

/* The sweep used to name five tables while a demo case could put rows in
   twenty-six, so clearing deleted the submission and left invoices, evidence,
   packages and send history behind — orphans that every view hides precisely
   because every view joins through submissions.

   The first test is the one that matters long term: it derives the list of
   case-scoped tables FROM THE SCHEMA, so adding a case-scoped table without
   adding it to the sweep fails here rather than silently leaking rows the next
   time someone presses the button. */
section('Removing test cases: the sweep is complete by construction');
{
  const src = fs.readFileSync(path.join(HERE, 'worker.js'), 'utf8');

  const sweepBlock = (src.match(/const DEMO_SWEEP = \[([\s\S]*?)\n\];/) || [, ''])[1];
  ok('the sweep list is declared', sweepBlock.length > 0);
  const swept = new Set([...sweepBlock.matchAll(/\['([a-z_]+)'\s*,/g)].map(m => m[1]));
  ok('the sweep names many tables, not a handful', swept.size >= 25, String(swept.size));

  // Every table the schema gives a case_no column to.
  const scoped = [];
  for (const m of SCHEMA.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    if (/^\s*case_no\s/m.test(m[2])) scoped.push(m[1]);
  }
  ok('the schema really does have case-scoped tables', scoped.length >= 25, String(scoped.length));

  const uncovered = scoped.filter(t => !swept.has(t));
  ok('EVERY case-scoped table is swept', uncovered.length === 0,
     `not swept: ${uncovered.join(', ')}`);

  // A swept table the health check does not know about would be deleted from
  // without ever being checked for existence — the half-applied-schema crash.
  const expectedBlock = (src.match(/const EXPECTED_TABLES = \[([\s\S]*?)\n\];/) || [, ''])[1];
  const expected = new Set([...expectedBlock.matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
  const unchecked = [...swept].filter(t => !expected.has(t));
  ok('every swept table is one the schema check knows about', unchecked.length === 0,
     `unknown to /health: ${unchecked.join(', ')}`);

  /* ORDER IS LOAD-BEARING and not self-evident: three tables carry
     day_id REFERENCES case_days(id), so case_days must be swept after all
     three or D1 rejects the whole batch on a foreign key. */
  const order = [...sweepBlock.matchAll(/\['([a-z_]+)'\s*,/g)].map(m => m[1]);
  for (const t of ['activity_log', 'case_reports', 'case_expenses']) {
    ok(`${t} is swept before case_days`,
       order.indexOf(t) !== -1 && order.indexOf(t) < order.indexOf('case_days'),
       `${t}=${order.indexOf(t)} case_days=${order.indexOf('case_days')}`);
  }
  ok('submissions is swept last of all', order[order.length - 1] === 'submissions', order[order.length - 1]);
}

/* And the behaviour, proven rather than reasoned about: put a row for a test
   case in EVERY case-scoped table, press clear, and assert every one of them
   is empty afterwards while an identically-shaped real case is untouched. */
section('Removing test cases: nothing is left behind, in any table');
{
  const { DatabaseSync } = await import('node:sqlite');
  const bare = new DatabaseSync(':memory:');
  bare.exec(SCHEMA);
  const env = { ...freshEnv(), DB: d1(bare) };
  const nowish = () => new Date().toISOString();

  const store = new Map();
  env.EVIDENCE = {
    async put(k, b) { store.set(k, b); },
    async get(k) { return store.has(k) ? { body: store.get(k) } : null; },
    async delete(k) { store.delete(k); },
    _store: store,
  };

  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  const DDL = new Map();
  for (const m of SCHEMA.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    DDL.set(m[1], m[2]);
  }
  const scoped = [...DDL].filter(([, ddl]) => /^\s*case_no\s/m.test(ddl)).map(([t]) => t);

  /* Fills only the columns SQLite would otherwise reject: NOT NULL, no
     default, not the autoincrement key. A CHECK list supplies its own first
     legal value and a NOT NULL foreign key is pointed at a row that exists,
     so a valid row lands without this test restating the schema anywhere.
     Fillers are unique per column, because several of these tables carry a
     UNIQUE constraint and the two planted cases must not collide. */
  let seq = 0;
  const plantRow = (table, given = {}) => {
    const ddl = DDL.get(table) || '';
    const cols = bare.prepare(`PRAGMA table_info(${table})`).all();
    const names = Object.keys(given), vals = Object.values(given);
    for (const c of cols) {
      if (names.includes(c.name)) continue;
      if (c.pk && /INTEGER/i.test(c.type)) continue;
      if (!c.notnull || c.dflt_value !== null) continue;
      const check = ddl.match(new RegExp(`${c.name}[^,]*?CHECK\\s*\\(\\s*${c.name}\\s+IN\\s*\\(\\s*'([^']+)'`, 'i'));
      const fk = ddl.match(new RegExp(`^\\s*${c.name}\\s[^,]*?REFERENCES\\s+(\\w+)\\s*\\((\\w+)\\)`, 'im'));
      let ref = null;
      if (fk) {
        const row = bare.prepare(`SELECT ${fk[2]} AS v FROM ${fk[1]} LIMIT 1`).get();
        if (row) ref = row.v;
      }
      names.push(c.name);
      vals.push(check ? check[1]
        : ref !== null ? ref
        : /INT|REAL|NUM/i.test(c.type) ? ++seq
        : `${table}-${c.name}-${++seq}`);
    }
    bare.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`)
      .run(...vals);
  };
  for (const t of scoped) {
    plantRow(t, { case_no: 'TEST-SWEEP-0001' });
    plantRow(t, { case_no: 'API-REAL-KEEP' });
  }
  ok('a row for a test case was planted in every case-scoped table', scoped.length >= 25, String(scoped.length));

  // Evidence needs a real key so the bucket half can be checked.
  bare.prepare(`UPDATE case_evidence SET r2_key = 'cases/TEST-SWEEP-0001/demo.jpg', size_bytes = 4096
                 WHERE case_no = 'TEST-SWEEP-0001'`).run();
  bare.prepare(`UPDATE case_evidence SET r2_key = 'cases/API-REAL-KEEP/real.jpg', size_bytes = 2048
                 WHERE case_no = 'API-REAL-KEEP'`).run();
  await env.EVIDENCE.put('cases/TEST-SWEEP-0001/demo.jpg', 'demo bytes');
  await env.EVIDENCE.put('cases/API-REAL-KEEP/real.jpg', 'real bytes');

  // Children, addressed by their parent's id rather than by a case number.
  const dayId = bare.prepare("SELECT id FROM case_days WHERE case_no = 'TEST-SWEEP-0001'").get().id;
  const actId = bare.prepare("SELECT id FROM activity_log WHERE case_no = 'TEST-SWEEP-0001'").get().id;
  const bldId = bare.prepare("SELECT id FROM case_builds WHERE case_no = 'TEST-SWEEP-0001'").get().id;
  const invId = bare.prepare("SELECT id FROM invoices WHERE case_no = 'TEST-SWEEP-0001'").get().id;
  const repId = bare.prepare("SELECT id FROM case_reports WHERE case_no = 'TEST-SWEEP-0001'").get().id;
  const evId  = bare.prepare("SELECT id FROM case_evidence WHERE case_no = 'TEST-SWEEP-0001'").get().id;
  const subId = bare.prepare("SELECT id FROM case_subjects WHERE case_no = 'TEST-SWEEP-0001'").get().id;

  const CHILDREN = [
    ['activity_media', { entry_id: actId }],
    ['activity_removed', { entry_id: actId }],
    ['case_day_pauses', { day_id: dayId }],
    ['build_items', { build_id: bldId, evidence_id: evId }],
    ['build_events', { build_id: bldId }],
    ['build_reports', { build_id: bldId, report_id: repId }],
    ['build_summary', { build_id: bldId }],
    ['build_custom', { build_id: bldId }],
    ['invoice_lines', { invoice_id: invId }],
    ['invoice_payments', { invoice_id: invId }],
    ['invoice_events', { invoice_id: invId }],
    ['invoice_retainer', { invoice_id: invId }],
    ['report_versions', { report_id: repId }],
    ['external_files', { evidence_id: evId }],
    ['subject_vehicles', { subject_id: subId }],
  ];
  for (const [t, keys] of CHILDREN) plantRow(t, keys);

  const childCount = () => CHILDREN.reduce(
    (n, [t]) => n + bare.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0);
  ok('and a child row under each of those parents', childCount() === CHILDREN.length,
     String(childCount()));

  const cleared = await call(env, '/demo-case/clear', { method: 'POST', cookie: admin });
  ok('clearing succeeds', cleared.status === 200, String(cleared.status));
  const body = await jsonOf(cleared);
  ok('it reports the one case it removed', body.removed === 1, JSON.stringify(body.removed));
  ok('and reports the full row count it swept', body.rows > 30, String(body.rows));

  const leftovers = [];
  for (const t of scoped) {
    const n = bare.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE case_no LIKE 'TEST-%'`).get().n;
    if (n) leftovers.push(`${t}=${n}`);
  }
  ok('NO test-case row survives in ANY case-scoped table', leftovers.length === 0, leftovers.join(', '));

  ok('and no orphaned child row survives either', childCount() === 0, String(childCount()));

  const kept = [];
  for (const t of scoped) {
    const n = bare.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE case_no = 'API-REAL-KEEP'`).get().n;
    if (n !== 1) kept.push(`${t}=${n}`);
  }
  ok('THE REAL CASE KEEPS ITS ROW IN EVERY TABLE', kept.length === 0, kept.join(', '));

  // The bucket, not just the row that pointed at it.
  ok('the demo object is gone from the bucket', !store.has('cases/TEST-SWEEP-0001/demo.jpg'));
  ok('the real case object is untouched', store.has('cases/API-REAL-KEEP/real.jpg'));
  ok('and the removal is reported', body.objects_removed === 1, String(body.objects_removed));

  /* The storage meter is SUM(size_bytes) over case_evidence with no join to a
     case, so a surviving evidence row would keep consuming the free-tier
     allowance with nothing on screen to explain it. */
  const metered = bare.prepare(
    'SELECT COALESCE(SUM(size_bytes), 0) AS b FROM case_evidence WHERE deleted_at IS NULL').get().b;
  ok('the storage meter no longer counts the demo bytes', metered === 2048, String(metered));
}

section('Expenses: three separate decisions, made by the office');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const token = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  await ingest(env, { case_no: 'API-X1', subject_name: 'S', client_name: 'C' });
  await ingest(env, { case_no: 'API-X2', subject_name: 'S2', client_name: 'C2' });
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const dana = users.users.find(u => u.username === 'dana');
  await call(env, '/submissions/API-X1/assign', { method: 'POST', cookie: admin, body: { user_id: dana.id } });

  ok('an expense with no category is refused',
     (await call(env, '/cases/API-X1/expenses', { method: 'POST', cookie: inv,
       body: { expense_date: '2026-08-12', amount: 10, description: 'x' } })).status === 400);
  ok('an expense with neither amount nor miles is refused',
     (await call(env, '/cases/API-X1/expenses', { method: 'POST', cookie: inv,
       body: { expense_date: '2026-08-12', category: 'tolls', description: 'x' } })).status === 400);
  ok('an investigator records an expense on their case',
     (await call(env, '/cases/API-X1/expenses', { method: 'POST', cookie: inv,
       body: { expense_date: '2026-08-12', category: 'parking', amount: 14.5,
               description: 'Courthouse garage' } })).status === 201);
  ok('a mileage claim carries miles without a dollar figure',
     (await call(env, '/cases/API-X1/expenses', { method: 'POST', cookie: inv,
       body: { expense_date: '2026-08-12', category: 'mileage', miles: 62,
               description: 'Round trip to residence' } })).status === 201);
  ok('an investigator cannot record one on a case not theirs',
     (await call(env, '/cases/API-X2/expenses', { method: 'POST', cookie: inv,
       body: { expense_date: '2026-08-12', category: 'tolls', amount: 5, description: 'x' } })).status === 404);

  let ws = await jsonOf(await call(env, '/cases/API-X1/workspace', { cookie: inv }));
  ok('the workspace lists the expenses', ws.expenses.length === 2);
  const exp = ws.expenses.find(e => e.category === 'parking');
  ok('nothing is classified until the office decides',
     exp.reimbursable === null && exp.billable === null && exp.internal === null);

  ok('an investigator cannot review an expense',
     (await call(env, `/cases/API-X1/expenses/${exp.id}/review`, { method: 'POST', cookie: inv,
       body: { reimbursable: true } })).status === 403);
  ok('the office sets the three decisions separately',
     (await call(env, `/cases/API-X1/expenses/${exp.id}/review`, { method: 'POST', cookie: admin,
       body: { reimbursable: true, billable: true, internal: false } })).status === 200);
  ws = await jsonOf(await call(env, '/cases/API-X1/workspace', { cookie: admin }));
  const reviewed = ws.expenses.find(e => e.id === exp.id);
  ok('the decisions stick', reviewed.reimbursable === 1 && reviewed.billable === 1 && reviewed.internal === 0);
  ok('the review is stamped', reviewed.reviewed_at !== null);

  ok('editing a reviewed expense reopens the review',
     (await call(env, `/cases/API-X1/expenses/${exp.id}`, { method: 'POST', cookie: inv,
       body: { amount: 18.5, description: 'Courthouse garage — corrected receipt' } })).status === 200);
  ws = await jsonOf(await call(env, '/cases/API-X1/workspace', { cookie: admin }));
  const reopened = ws.expenses.find(e => e.id === exp.id);
  ok('the classifications reset with the numbers',
     reopened.reviewed_at === null && reopened.reimbursable === null);

  const sum = (await jsonOf(await call(env, '/summary', { cookie: admin }))).summary;
  ok('unreviewed expenses reach the dashboard', sum.expenses_pending.includes('API-X1'));
  const isum = (await jsonOf(await call(env, '/summary', { cookie: inv }))).summary;
  ok('the review queue is the office\'s, not the investigator\'s',
     isum.expenses_pending === undefined);
}

section('Notes: visibility is enforced in the query');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const token = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  await ingest(env, { case_no: 'API-N1', subject_name: 'S', client_name: 'C' });
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const dana = users.users.find(u => u.username === 'dana');
  await call(env, '/submissions/API-N1/assign', { method: 'POST', cookie: admin, body: { user_id: dana.id } });

  await call(env, '/cases/API-N1/notes', { method: 'POST', cookie: admin,
    body: { note_type: 'billing', visibility: 'admin',
            body: 'Carrier agreed the preferred-volume rate on this file.' } });
  await call(env, '/cases/API-N1/notes', { method: 'POST', cookie: admin,
    body: { note_type: 'subject', visibility: 'team',
            body: 'Subject switched to a grey rental sedan.' } });
  await call(env, '/cases/API-N1/notes', { method: 'POST', cookie: admin,
    body: { note_type: 'client_comm', visibility: 'client_eligible',
            body: 'Told the adjuster day two is scheduled.' } });

  const adminWs = await jsonOf(await call(env, '/cases/API-N1/workspace', { cookie: admin }));
  ok('the admin sees all three notes', adminWs.notes.length === 3);

  const invWs = await jsonOf(await call(env, '/cases/API-N1/workspace', { cookie: inv }));
  ok('the investigator gets two', invWs.notes.length === 2);
  ok('THE ADMIN-ONLY NOTE NEVER LEAVES THE WORKER',
     !JSON.stringify(invWs).includes('preferred-volume'));
  ok('team and client-eligible notes do arrive',
     JSON.stringify(invWs).includes('grey rental sedan') &&
     JSON.stringify(invWs).includes('day two is scheduled'));

  ok('an investigator cannot author a billing note',
     (await call(env, '/cases/API-N1/notes', { method: 'POST', cookie: inv,
       body: { note_type: 'billing', body: 'x' } })).status === 400);
  ok('an investigator note is forced to team visibility',
     (await call(env, '/cases/API-N1/notes', { method: 'POST', cookie: inv,
       body: { note_type: 'investigator', visibility: 'admin', body: 'Saw nothing after 3pm.' } })).status === 201);
  const after = await jsonOf(await call(env, '/cases/API-N1/workspace', { cookie: inv }));
  const theirs = after.notes.find(n => n.body === 'Saw nothing after 3pm.');
  ok('whatever visibility they asked for, it stored as team', theirs.visibility === 'team');
  ok('an empty note is refused',
     (await call(env, '/cases/API-N1/notes', { method: 'POST', cookie: inv,
       body: { note_type: 'investigator', body: '  ' } })).status === 400);
}

section('Offers: the shape of the job before acceptance, the case only after');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  for (const uname of ['dana', 'reed']) {
    const l = (await jsonOf(await invite(env, admin, { username: uname, display_name: uname, role: 'investigator' }))).url;
    const t = new URL(l, 'https://x.test').searchParams.get('invite');
    await call(env, `/invite/${t}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  }
  const dana = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const reed = (await login(env, 'reed', 'FieldWork2026x')).cookie;
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const danaId = users.users.find(u => u.username === 'dana').id;
  const reedId = users.users.find(u => u.username === 'reed').id;

  await ingest(env, { case_no: 'API-OF1', carrier: 'Secret Mutual', claim_number: 'SM-1',
                      subject_name: 'Hidden Subject', client_name: 'H. Adjuster' });
  await call(env, '/users/' + danaId + '/rates', { method: 'POST', cookie: admin, body: { hourly: 55 } });

  ok('an investigator cannot make offers',
     (await call(env, '/cases/API-OF1/offer', { method: 'POST', cookie: dana,
       body: { investigator_id: reedId } })).status === 403);
  ok('an admin offers the case',
     (await call(env, '/cases/API-OF1/offer', { method: 'POST', cookie: admin,
       body: { investigator_id: danaId, investigation_date: '2026-08-20', expected_hours: 8,
               general_location: 'Lynchburg area', mileage_terms: 'standing rate',
               instructions: 'Meet at the Wal-Mart lot off 460. Subject is Hidden Subject.' } })).status === 201);
  ok('no competing offers — a second while one is pending is refused',
     (await call(env, '/cases/API-OF1/offer', { method: 'POST', cookie: admin,
       body: { investigator_id: reedId, expected_hours: 8 } })).status === 409);

  /* THE BOUNDARY. Pending = the job's shape and their pay. Nothing else. */
  const pend = await jsonOf(await call(env, '/my/offers', { cookie: dana }));
  const o = pend.offers[0];
  ok('the offer shows date, hours, location', o.investigation_date === '2026-08-20'
     && o.expected_hours === 8 && o.general_location === 'Lynchburg area');
  ok('pay defaults to their standing rate', o.compensation_hourly === 55);
  const thin = JSON.stringify(pend);
  ok('NO case number before acceptance', !thin.includes('API-OF1'), thin);
  ok('NO subject before acceptance', !thin.includes('Hidden Subject'));
  ok('NO client before acceptance', !thin.includes('Secret Mutual'));
  ok('NO instructions before acceptance', !thin.includes('Wal-Mart'));
  ok('and no case access before acceptance',
     (await call(env, '/cases/API-OF1/workspace', { cookie: dana })).status === 404);

  ok("one investigator cannot answer another's offer",
     (await call(env, `/my/offers/${o.id}/accept`, { method: 'POST', cookie: reed })).status === 404);

  const acc = await jsonOf(await call(env, `/my/offers/${o.id}/accept`, { method: 'POST', cookie: dana }));
  ok('accepting assigns the case', acc.status === 'accepted' && acc.case_no === 'API-OF1');
  ok('the workspace opens after acceptance',
     (await call(env, '/cases/API-OF1/workspace', { cookie: dana })).status === 200);
  const mine = await jsonOf(await call(env, '/my/offers', { cookie: dana }));
  ok('instructions arrive with acceptance',
     JSON.stringify(mine).includes('Wal-Mart'));
  const ws = await jsonOf(await call(env, '/cases/API-OF1/workspace', { cookie: dana }));
  ok('the workspace carries their assignment terms',
     ws.my_offer && ws.my_offer.compensation_hourly === 55 && ws.my_offer.instructions.includes('Wal-Mart'));
  ok('the client stays redacted even after acceptance',
     !JSON.stringify(ws).includes('Secret Mutual'));

  ok('an assigned case cannot be offered at all',
     (await call(env, '/cases/API-OF1/offer', { method: 'POST', cookie: admin,
       body: { investigator_id: reedId } })).status === 409);
  ok('a decided offer cannot be accepted again',
     (await call(env, `/my/offers/${o.id}/accept`, { method: 'POST', cookie: dana })).status === 404);

  // Decline with a reason the office can read.
  await ingest(env, { case_no: 'API-OF2', subject_name: 'S2', client_name: 'C2' });
  const of2 = await jsonOf(await call(env, '/cases/API-OF2/offer', { method: 'POST', cookie: admin,
    body: { investigator_id: reedId, expected_hours: 4 } }));
  const rpend = await jsonOf(await call(env, '/my/offers', { cookie: reed }));
  const rid = rpend.offers.find(x => x.status === 'offered').id;
  await call(env, `/my/offers/${rid}/decline`, { method: 'POST', cookie: reed,
    body: { reason: 'Out of town that week.' } });
  const aws = await jsonOf(await call(env, '/cases/API-OF2/workspace', { cookie: admin }));
  ok('the office sees who declined and why',
     aws.offers[0].status === 'declined' && aws.offers[0].decline_reason === 'Out of town that week.');
  // A decline resolves the case, so it can be offered again — then withdrawn.
  const o3 = await jsonOf(await call(env, '/cases/API-OF2/offer', { method: 'POST', cookie: admin,
    body: { investigator_id: danaId } }));
  ok('a resolved case can be offered again', typeof o3.id === 'number');
  ok('an admin can withdraw a pending offer',
     (await call(env, `/offers/${o3.id}/withdraw`, { method: 'POST', cookie: admin })).status === 200);
}

section('Calendar: the month, scoped like everything else');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  for (const uname of ['dana', 'reed']) {
    const l = (await jsonOf(await invite(env, admin, { username: uname, display_name: uname, role: 'investigator' }))).url;
    const t = new URL(l, 'https://x.test').searchParams.get('invite');
    await call(env, `/invite/${t}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  }
  const dana = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const reed = (await login(env, 'reed', 'FieldWork2026x')).cookie;
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const danaId = users.users.find(u => u.username === 'dana').id;
  const reedId = users.users.find(u => u.username === 'reed').id;

  await ingest(env, { case_no: 'API-CAL1', subject_name: 'S1', client_name: 'Client One' });
  await ingest(env, { case_no: 'API-CAL2', subject_name: 'S2', client_name: 'Client Two' });
  await ingest(env, { case_no: 'API-CAL3', carrier: 'Quiet Casualty', subject_name: 'S3', client_name: 'C3' });
  await call(env, '/submissions/API-CAL1/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });
  await call(env, '/submissions/API-CAL2/assign', { method: 'POST', cookie: admin, body: { user_id: reedId } });

  await call(env, '/cases/API-CAL1/day/start', { method: 'POST', cookie: dana,
    body: { day_date: '2026-08-12', start_time: '07:00' } });
  await call(env, '/cases/API-CAL1/day/end', { method: 'POST', cookie: dana, body: { end_time: '15:00' } });
  await call(env, '/cases/API-CAL2/day/start', { method: 'POST', cookie: reed,
    body: { day_date: '2026-08-19', start_time: '06:00' } });
  await call(env, '/cases/API-CAL3/offer', { method: 'POST', cookie: admin,
    body: { investigator_id: reedId, investigation_date: '2026-08-21', expected_hours: 8,
            general_location: 'Bedford area' } });

  ok('the calendar needs a session', (await call(env, '/calendar?month=2026-08')).status === 401);

  const a = await jsonOf(await call(env, '/calendar?month=2026-08', { cookie: admin }));
  ok('admin sees every day worked that month', a.days.length === 2
     && a.days.some(d => d.case_no === 'API-CAL1' && d.investigator === 'dana' && d.hours === 8)
     && a.days.some(d => d.case_no === 'API-CAL2' && d.investigator === 'reed'));
  ok('a still-running day is on it', a.days.find(d => d.case_no === 'API-CAL2').end_time === null);
  ok('admin sees the pending offer with its case and person',
     a.offers.length === 1 && a.offers[0].case_no === 'API-CAL3' && a.offers[0].investigator === 'reed'
     && a.offers[0].investigation_date === '2026-08-21');

  const dv = await jsonOf(await call(env, '/calendar?month=2026-08', { cookie: dana }));
  ok('an investigator sees only their own days',
     dv.days.length === 1 && dv.days[0].case_no === 'API-CAL1');
  ok("and never another investigator's offer", dv.offers.length === 0);

  const rv = await jsonOf(await call(env, '/calendar?month=2026-08', { cookie: reed }));
  ok('their own pending offer is on their calendar',
     rv.offers.length === 1 && rv.offers[0].investigation_date === '2026-08-21'
     && rv.offers[0].general_location === 'Bedford area');
  const thinCal = JSON.stringify(rv.offers);
  ok('and stays thin — no case number before acceptance', !thinCal.includes('API-CAL3'), thinCal);
  ok('nor the client behind it', !thinCal.includes('Quiet Casualty'));

  const other = await jsonOf(await call(env, '/calendar?month=2026-09', { cookie: admin }));
  ok('a different month is empty', other.days.length === 0 && other.offers.length === 0);
  const fallback = await jsonOf(await call(env, '/calendar?month=nonsense', { cookie: admin }));
  ok('a malformed month falls back to the current one', /^\d{4}-\d{2}$/.test(fallback.month));
}

section('Private case details: the type decides the fields');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const tok = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tok}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const danaId = users.users.find(u => u.username === 'dana').id;

  await ingest(env, { case_no: 'API-PD1', service: 'Surveillance',
                      client_name: 'Quiet Client', subject_name: 'S. Person' });
  await ingest(env, { case_no: 'API-PD2', carrier: 'Some Mutual', claim_number: 'SM-9',
                      client_name: 'An Adjuster', subject_name: 'Claimant' });

  const types = (await jsonOf(await call(env, '/case-types', { cookie: admin }))).case_types;
  const infId = types.find(t => t.label === 'Adultery / Infidelity').id;
  const cusId = types.find(t => t.label === 'Child Custody').id;

  // Untyped: the general set applies.
  let ws = await jsonOf(await call(env, '/cases/API-PD1/workspace', { cookie: admin }));
  ok('an untyped private case gets the general set', ws.detail_set === 'general'
     && ws.detail_fields.some(([k]) => k === 'objectives'));

  await call(env, '/cases/API-PD1/meta', { method: 'POST', cookie: admin, body: { case_type_id: infId } });
  ws = await jsonOf(await call(env, '/cases/API-PD1/workspace', { cookie: admin }));
  ok('typing it infidelity switches the set', ws.detail_set === 'infidelity'
     && ws.detail_fields.some(([k]) => k === 'suspected_companion'));

  ok('an investigator cannot write details',
     (await call(env, '/cases/API-PD1/details', { method: 'POST', cookie: inv,
       body: { objectives: 'x' } })).status === 403);
  ok('a claims case refuses details outright',
     (await call(env, '/cases/API-PD2/details', { method: 'POST', cookie: admin,
       body: { objectives: 'x' } })).status === 400);
  const cws = await jsonOf(await call(env, '/cases/API-PD2/workspace', { cookie: admin }));
  ok('and its workspace carries no detail set at all',
     cws.details === null && cws.detail_fields === null);

  // The allow-list: active-set keys stored, everything else dropped.
  const saved = await jsonOf(await call(env, '/cases/API-PD1/details', { method: 'POST', cookie: admin,
    body: { suspected_companion: 'Coworker, first name Alex.',
            known_routine: 'Gym at 6am, office by 8.',
            objectives: 'Document comings and goings during the stated work schedule.',
            custody_schedule: 'not an infidelity field',
            made_up_key: 'never stored' } }));
  ok('active-set keys are stored', saved.details.suspected_companion === 'Coworker, first name Alex.'
     && saved.details.objectives.startsWith('Document'));
  ok("keys from another type's set are dropped", saved.details.custody_schedule === undefined);
  ok('unknown keys are dropped', saved.details.made_up_key === undefined);

  ok('who saved it is stamped',
     (await env.DB.prepare('SELECT updated_by FROM case_details WHERE case_no = ?')
       .bind('API-PD1').first()).updated_by != null);

  // The assigned investigator reads the fieldwork facts.
  await call(env, '/submissions/API-PD1/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });
  const iws = await jsonOf(await call(env, '/cases/API-PD1/workspace', { cookie: inv }));
  ok('the assigned investigator sees the details',
     iws.details.suspected_companion === 'Coworker, first name Alex.'
     && iws.detail_set === 'infidelity');
  ok('and still never the client', !JSON.stringify(iws).includes('Quiet Client'));

  // Retyping the case changes the set; the next save is filtered to it.
  await call(env, '/cases/API-PD1/meta', { method: 'POST', cookie: admin, body: { case_type_id: cusId } });
  ws = await jsonOf(await call(env, '/cases/API-PD1/workspace', { cookie: admin }));
  ok('a custody case asks custody questions', ws.detail_set === 'custody'
     && ws.detail_fields.some(([k]) => k === 'exchange_details'));
  const re = await jsonOf(await call(env, '/cases/API-PD1/details', { method: 'POST', cookie: admin,
    body: { custody_schedule: 'Alternating weeks, exchange Sunday 6pm.',
            objectives: 'Document persons present and observed activity during the scheduled custody period.',
            suspected_companion: 'now off-set' } }));
  ok('custody keys store once the type says so', re.details.custody_schedule.startsWith('Alternating'));
  ok('and the infidelity-only key is filtered out', re.details.suspected_companion === undefined);

  ok('a missing case is a 404',
     (await call(env, '/cases/API-NOPE/details', { method: 'POST', cookie: admin,
       body: { objectives: 'x' } })).status === 404);
}

section('Subjects and vehicles: structured records, scoped to the case');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  for (const uname of ['dana', 'reed']) {
    const l = (await jsonOf(await invite(env, admin, { username: uname, display_name: uname, role: 'investigator' }))).url;
    const t = new URL(l, 'https://x.test').searchParams.get('invite');
    await call(env, `/invite/${t}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  }
  const dana = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const reed = (await login(env, 'reed', 'FieldWork2026x')).cookie;
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const danaId = users.users.find(u => u.username === 'dana').id;

  await ingest(env, { case_no: 'API-SV1', service: 'Surveillance',
                      client_name: 'Private Client', subject_name: 'Sam Watched' });
  await ingest(env, { case_no: 'API-SV2', service: 'Surveillance',
                      client_name: 'Other Client', subject_name: 'Other Subject' });
  await call(env, '/submissions/API-SV1/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });

  ok('a subject needs a name',
     (await call(env, '/cases/API-SV1/subjects', { method: 'POST', cookie: admin,
       body: { hair: 'brown' } })).status === 400);
  const made = await jsonOf(await call(env, '/cases/API-SV1/subjects', { method: 'POST', cookie: admin,
    body: { name: 'Sam Watched', alias: 'Sammy', hair: 'brown', height: `5'10"`,
            employer: 'ABC Roofing', addresses: '12 Elm St, Lynchburg' } }));
  ok('an admin adds a subject', typeof made.id === 'number');

  ok('the assigned investigator can add one too',
     (await call(env, '/cases/API-SV1/subjects', { method: 'POST', cookie: dana,
       body: { name: 'Associate seen twice' } })).status === 201);
  ok('an unassigned investigator cannot',
     (await call(env, '/cases/API-SV1/subjects', { method: 'POST', cookie: reed,
       body: { name: 'X' } })).status === 404);

  // Edits replace the record and stamp who; the case in the URL must own it.
  ok('an edit through the wrong case is a 404',
     (await call(env, `/cases/API-SV2/subjects/${made.id}`, { method: 'POST', cookie: admin,
       body: { name: 'Sam Watched', hair: 'dyed black' } })).status === 404);
  await call(env, `/cases/API-SV1/subjects/${made.id}`, { method: 'POST', cookie: dana,
    body: { name: 'Sam Watched', alias: 'Sammy', hair: 'dyed black', height: `5'10"`,
            employer: 'ABC Roofing', addresses: '12 Elm St, Lynchburg' } });
  const srow = await env.DB.prepare('SELECT hair, updated_by, created_by FROM case_subjects WHERE id = ?')
    .bind(made.id).first();
  ok('the edit lands with an audit stamp', srow.hair === 'dyed black'
     && srow.updated_by !== srow.created_by);

  ok('a vehicle needs some description',
     (await call(env, `/cases/API-SV1/subjects/${made.id}/vehicles`, { method: 'POST', cookie: dana,
       body: { color: 'white' } })).status === 400);
  const veh = await jsonOf(await call(env, `/cases/API-SV1/subjects/${made.id}/vehicles`, {
    method: 'POST', cookie: dana,
    body: { year: '2019', make: 'GMC', model: 'Sierra', color: 'white', plate: 'ABC-1234', plate_state: 'VA' } }));
  ok('a vehicle attaches to the subject', typeof veh.id === 'number');
  ok('a second vehicle joins it',
     (await call(env, `/cases/API-SV1/subjects/${made.id}/vehicles`, { method: 'POST', cookie: admin,
       body: { make: 'Honda', model: 'Civic', color: 'grey' } })).status === 201);
  ok("a vehicle cannot be reached through another case",
     (await call(env, `/cases/API-SV2/subjects/${made.id}/vehicles/${veh.id}`, { method: 'POST', cookie: admin,
       body: { make: 'GMC' } })).status === 404);
  await call(env, `/cases/API-SV1/subjects/${made.id}/vehicles/${veh.id}`, { method: 'POST', cookie: admin,
    body: { year: '2019', make: 'GMC', model: 'Sierra', color: 'white', plate: 'XYZ-9876', plate_state: 'VA' } });

  const ws = await jsonOf(await call(env, '/cases/API-SV1/workspace', { cookie: dana }));
  const sam = ws.subjects.find(x => x.id === made.id);
  ok('the workspace carries subjects with their vehicles nested',
     ws.subjects.length === 2 && sam.vehicles.length === 2
     && sam.vehicles.some(v => v.plate === 'XYZ-9876'));
  ok('long fields are capped, not refused',
     (await call(env, `/cases/API-SV1/subjects`, { method: 'POST', cookie: admin,
       body: { name: 'N'.repeat(500) } })).status === 201
     && (await env.DB.prepare('SELECT MAX(LENGTH(name)) AS l FROM case_subjects').first()).l <= 200);
}

section('Communication log: the office writes, visibility decides who reads');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  for (const uname of ['dana', 'reed']) {
    const l = (await jsonOf(await invite(env, admin, { username: uname, display_name: uname, role: 'investigator' }))).url;
    const t = new URL(l, 'https://x.test').searchParams.get('invite');
    await call(env, `/invite/${t}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  }
  const dana = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const reed = (await login(env, 'reed', 'FieldWork2026x')).cookie;
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const danaId = users.users.find(u => u.username === 'dana').id;

  await ingest(env, { case_no: 'API-CM1', carrier: 'Quiet Mutual', claim_number: 'QM-3',
                      client_name: 'D. Reyes', subject_name: 'S' });
  await call(env, '/submissions/API-CM1/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });

  ok('a communication needs a real method',
     (await call(env, '/cases/API-CM1/comms', { method: 'POST', cookie: admin,
       body: { comm_type: 'carrier_pigeon', at_date: '2026-08-13', summary: 'x' } })).status === 400);
  ok('and a summary',
     (await call(env, '/cases/API-CM1/comms', { method: 'POST', cookie: admin,
       body: { comm_type: 'phone', at_date: '2026-08-13', summary: '  ' } })).status === 400);
  ok('and a date',
     (await call(env, '/cases/API-CM1/comms', { method: 'POST', cookie: admin,
       body: { comm_type: 'phone', at_date: 'yesterday', summary: 'x' } })).status === 400);

  ok('an admin logs a call with the adjuster, office-only',
     (await call(env, '/cases/API-CM1/comms', { method: 'POST', cookie: admin,
       body: { comm_type: 'phone', at_date: '2026-08-13', at_time: '09:15',
               person: 'D. Reyes, adjuster', visibility: 'admin',
               summary: 'Adjuster approved a second surveillance day.',
               follow_up_date: '2026-08-15' } })).status === 201);
  ok('and a team-visible instruction',
     (await call(env, '/cases/API-CM1/comms', { method: 'POST', cookie: admin,
       body: { comm_type: 'investigator', at_date: '2026-08-13',
               visibility: 'team', summary: 'Told the field a second day is approved.' } })).status === 201);
  ok('an unstated visibility defaults to admins only',
     (await jsonOf(await call(env, '/cases/API-CM1/workspace', { cookie: admin }))).comms
       .length === 2);

  ok('the assigned investigator cannot write to the log',
     (await call(env, '/cases/API-CM1/comms', { method: 'POST', cookie: dana,
       body: { comm_type: 'phone', at_date: '2026-08-13', summary: 'x' } })).status === 403);
  ok('an unassigned investigator does not even find the case',
     (await call(env, '/cases/API-CM1/comms', { method: 'POST', cookie: reed,
       body: { comm_type: 'phone', at_date: '2026-08-13', summary: 'x' } })).status === 404);

  const aws = await jsonOf(await call(env, '/cases/API-CM1/workspace', { cookie: admin }));
  ok('the office sees everything, follow-up included',
     aws.comms.length === 2 && aws.comms.some(c => c.follow_up_date === '2026-08-15'));

  const iws = await jsonOf(await call(env, '/cases/API-CM1/workspace', { cookie: dana }));
  ok('the investigator sees only what visibility grants',
     iws.comms.length === 1 && iws.comms[0].visibility === 'team');
  ok('the adjuster call never reaches them',
     !JSON.stringify(iws.comms).includes('D. Reyes'));
}

section('Follow-up tasks: assignment is the only way one reaches the field');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  for (const uname of ['dana', 'reed']) {
    const l = (await jsonOf(await invite(env, admin, { username: uname, display_name: uname, role: 'investigator' }))).url;
    const t = new URL(l, 'https://x.test').searchParams.get('invite');
    await call(env, `/invite/${t}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  }
  const dana = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const reed = (await login(env, 'reed', 'FieldWork2026x')).cookie;
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const danaId = users.users.find(u => u.username === 'dana').id;

  await ingest(env, { case_no: 'API-TK1', service: 'Surveillance',
                      client_name: 'C', subject_name: 'S' });
  await call(env, '/submissions/API-TK1/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });

  ok('a task needs words',
     (await call(env, '/cases/API-TK1/tasks', { method: 'POST', cookie: admin,
       body: { task: '  ' } })).status === 400);
  ok('a due date has to be one',
     (await call(env, '/cases/API-TK1/tasks', { method: 'POST', cookie: admin,
       body: { task: 'x', due_date: 'soon' } })).status === 400);
  ok('the assigned investigator cannot create tasks',
     (await call(env, '/cases/API-TK1/tasks', { method: 'POST', cookie: dana,
       body: { task: 'x' } })).status === 403);

  await call(env, '/cases/API-TK1/tasks', { method: 'POST', cookie: admin,
    body: { task: 'Send the invoice.', due_date: '2026-08-01', priority: 'high' } });
  const mine = await jsonOf(await call(env, '/cases/API-TK1/tasks', { method: 'POST', cookie: admin,
    body: { task: 'Confirm the surveillance date with the office.', assigned_to: danaId,
            due_date: '2026-08-01', priority: 'urgent' } }));
  await call(env, '/cases/API-TK1/tasks', { method: 'POST', cookie: admin,
    body: { task: 'Upload the final video.', assigned_to: danaId, due_date: '2026-12-01' } });

  const aws = await jsonOf(await call(env, '/cases/API-TK1/workspace', { cookie: admin }));
  ok('the office sees every task', aws.tasks.length === 3);
  const dws = await jsonOf(await call(env, '/cases/API-TK1/workspace', { cookie: dana }));
  ok('an investigator sees only tasks assigned to them',
     dws.tasks.length === 2 && dws.tasks.every(t => t.assigned_to === danaId));
  ok('and never the billing task', !JSON.stringify(dws.tasks).includes('invoice'));

  // Overdue: on the dashboard for whoever owns the lateness.
  let asum = (await jsonOf(await call(env, '/summary', { cookie: admin }))).summary;
  ok('overdue tasks reach the admin dashboard', asum.tasks_overdue.includes('API-TK1'));
  let dsum = (await jsonOf(await call(env, '/summary', { cookie: dana }))).summary;
  ok("and the investigator's own overdue reaches theirs", dsum.tasks_overdue.includes('API-TK1'));

  const officeTask = aws.tasks.find(t => t.task === 'Send the invoice.');
  ok("an investigator cannot touch a task that is not theirs",
     (await call(env, `/cases/API-TK1/tasks/${officeTask.id}/status`, { method: 'POST', cookie: dana,
       body: { status: 'done' } })).status === 404);
  ok('or cancel even their own',
     (await call(env, `/cases/API-TK1/tasks/${mine.id}/status`, { method: 'POST', cookie: dana,
       body: { status: 'cancelled' } })).status === 403);
  ok('marking their own task done is theirs to do',
     (await call(env, `/cases/API-TK1/tasks/${mine.id}/status`, { method: 'POST', cookie: dana,
       body: { status: 'done' } })).status === 200);

  dsum = (await jsonOf(await call(env, '/summary', { cookie: dana }))).summary;
  ok('done clears their overdue card', dsum.tasks_overdue.length === 0);
  asum = (await jsonOf(await call(env, '/summary', { cookie: admin }))).summary;
  ok("the office's own late task still shows", asum.tasks_overdue.includes('API-TK1'));

  ok('an unassigned investigator finds nothing at all',
     (await call(env, `/cases/API-TK1/tasks/${mine.id}/status`, { method: 'POST', cookie: reed,
       body: { status: 'done' } })).status === 404);
  ok('the office can reopen',
     (await call(env, `/cases/API-TK1/tasks/${mine.id}/status`, { method: 'POST', cookie: admin,
       body: { status: 'open' } })).status === 200);
  const after = await jsonOf(await call(env, '/cases/API-TK1/workspace', { cookie: admin }));
  ok('reopening clears the resolution stamp',
     after.tasks.find(t => t.id === mine.id).done_at === null);
}

section('Closure: nine stages, and the checklist is the only door to closed');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const tok = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tok}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const danaId = users.users.find(u => u.username === 'dana').id;

  await ingest(env, { case_no: 'API-CL1', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  await call(env, '/submissions/API-CL1/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });

  ok('the new stages are accepted',
     (await call(env, '/submissions/API-CL1/status', { method: 'POST', cookie: admin,
       body: { status: 'report_review' } })).status === 200);
  let list = await jsonOf(await call(env, '/submissions', { cookie: admin }));
  const row = list.submissions.find(r => r.case_no === 'API-CL1');
  ok('the list carries the fine stage', row.stage === 'report_review');
  ok('while the coarse status stays in the old vocabulary', row.status === 'in_progress');

  await call(env, '/submissions/API-CL1/status', { method: 'POST', cookie: admin,
    body: { status: 'awaiting_client' } });
  let sum = (await jsonOf(await call(env, '/summary', { cookie: admin }))).summary;
  ok('awaiting-client cases become a dashboard card', sum.awaiting_client.includes('API-CL1'));
  await call(env, '/submissions/API-CL1/status', { method: 'POST', cookie: admin,
    body: { status: 'complete' } });
  sum = (await jsonOf(await call(env, '/summary', { cookie: admin }))).summary;
  ok('complete cases wait under Ready to close', sum.ready_to_close.includes('API-CL1'));

  ok('the status shortcut to closed is refused',
     (await call(env, '/submissions/API-CL1/status', { method: 'POST', cookie: admin,
       body: { status: 'closed' } })).status === 400);
  const shortClose = await call(env, '/cases/API-CL1/close', { method: 'POST', cookie: admin });
  ok('closing with an unfinished checklist names what is missing',
     shortClose.status === 400 && (await jsonOf(shortClose)).error.includes('Billing reviewed'));

  ok('an investigator cannot tick the checklist',
     (await call(env, '/cases/API-CL1/closure', { method: 'POST', cookie: inv,
       body: { checklist: { billing: true } } })).status === 403);
  ok('nor close',
     (await call(env, '/cases/API-CL1/close', { method: 'POST', cookie: inv })).status === 403);

  const every = { field_work: true, activity_logs: true, evidence: true, report: true,
                  admin_review: true, deliverables: true, expenses: true, billing: true };
  await call(env, '/cases/API-CL1/closure', { method: 'POST', cookie: admin, body: { checklist: every } });
  ok('with all eight confirmed the case closes',
     (await call(env, '/cases/API-CL1/close', { method: 'POST', cookie: admin })).status === 200);

  const ws = await jsonOf(await call(env, '/cases/API-CL1/workspace', { cookie: admin }));
  ok('the workspace shows closed with who and when',
     ws.stage === 'closed' && ws.status === 'closed'
     && ws.closure.closed_by === 'Trever' && ws.closure.closed_at != null);
  const iws = await jsonOf(await call(env, '/cases/API-CL1/workspace', { cookie: inv }));
  ok('the investigator sees the stage but never the closure machinery',
     iws.stage === 'closed' && iws.closure === null);

  // Reopen from the status: the stamp clears, the ticks stay as history.
  await call(env, '/submissions/API-CL1/status', { method: 'POST', cookie: admin,
    body: { status: 'in_progress' } });
  const back = await jsonOf(await call(env, '/cases/API-CL1/workspace', { cookie: admin }));
  ok('reopening clears the closed stamp', back.stage === 'in_progress' && back.closure.closed_at === null);
  ok('but keeps the checklist as history', back.closure.checklist.billing === true);

  ok('the old vocabulary still lands: new means open',
     (await call(env, '/submissions/API-CL1/status', { method: 'POST', cookie: admin,
       body: { status: 'new' } })).status === 200
     && (await jsonOf(await call(env, '/cases/API-CL1/workspace', { cookie: admin }))).stage === 'open');
  ok('and nonsense is still refused',
     (await call(env, '/submissions/API-CL1/status', { method: 'POST', cookie: admin,
       body: { status: 'resolved' } })).status === 400);
}

section('Password reset: a one-time link, nobody learns the password');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const tok = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tok}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const oldSession = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const dana = users.users.find(u => u.username === 'dana');

  ok('an investigator cannot issue a reset link',
     (await call(env, `/users/${dana.id}/reset-link`, { method: 'POST', cookie: oldSession })).status === 403);
  const issued = await call(env, `/users/${dana.id}/reset-link`, { method: 'POST', cookie: admin });
  ok('an admin can', issued.status === 201);
  const url = (await jsonOf(issued)).url;
  const rt = new URL(url, 'https://x.test').searchParams.get('reset');
  ok('the link carries a 64-hex token', /^[0-9a-f]{64}$/.test(rt), url);

  const info = await jsonOf(await call(env, `/reset/${rt}`));
  ok('the link says who it is for, without a session', info.username === 'dana');

  ok('a weak new password is refused',
     (await call(env, `/reset/${rt}/accept`, { method: 'POST', body: { password: 'short' } })).status === 400);
  const done = await call(env, `/reset/${rt}/accept`, { method: 'POST', body: { password: 'BrandNewPass26x' } });
  ok('the holder sets their own password and is signed in', done.status === 200);

  ok('every old session is dead',
     (await call(env, '/auth/me', { cookie: oldSession })).status === 401);
  ok('the old password no longer works',
     (await call(env, '/auth/login', { method: 'POST', body: { username: 'dana', password: 'FieldWork2026x' } })).status === 401);
  ok('the new one does',
     (await call(env, '/auth/login', { method: 'POST', body: { username: 'dana', password: 'BrandNewPass26x' } })).status === 200);
  ok('the link is single-use',
     (await call(env, `/reset/${rt}/accept`, { method: 'POST', body: { password: 'AnotherPass26x' } })).status === 404);
  ok('a made-up token is refused', (await call(env, `/reset/${'0'.repeat(64)}`)).status === 404);

  const again = await jsonOf(await call(env, `/users/${dana.id}/reset-link`, { method: 'POST', cookie: admin }));
  const rt2 = new URL(again.url, 'https://x.test').searchParams.get('reset');
  await call(env, `/users/${dana.id}/reset-link`, { method: 'POST', cookie: admin });
  ok('a fresh link retires the previous unused one',
     (await call(env, `/reset/${rt2}`)).status === 404);
}

section('Deleting an account: history always wins');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  for (const uname of ['worked', 'fresh']) {
    const l = (await jsonOf(await invite(env, admin, { username: uname, display_name: uname, role: 'investigator' }))).url;
    const t = new URL(l, 'https://x.test').searchParams.get('invite');
    await call(env, `/invite/${t}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  }
  const workedCookie = (await login(env, 'worked', 'FieldWork2026x')).cookie;
  const freshCookie = (await login(env, 'fresh', 'FieldWork2026x')).cookie;
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const workedId = users.users.find(u => u.username === 'worked').id;
  const freshId = users.users.find(u => u.username === 'fresh').id;
  const adminId = users.users.find(u => u.username === 'trever').id;

  // 'worked' has case history: one recorded day.
  await ingest(env, { case_no: 'API-DEL1', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  await call(env, '/submissions/API-DEL1/assign', { method: 'POST', cookie: admin, body: { user_id: workedId } });
  await call(env, '/cases/API-DEL1/day/start', { method: 'POST', cookie: workedCookie,
    body: { day_date: '2026-08-13', start_time: '07:00' } });

  ok('an investigator cannot delete accounts',
     (await call(env, `/users/${freshId}/delete`, { method: 'POST', cookie: workedCookie })).status === 403);
  ok('an admin cannot delete themselves',
     (await call(env, `/users/${adminId}/delete`, { method: 'POST', cookie: admin })).status === 400);
  ok('the last active admin is undeletable by construction',
     (await jsonOf(await call(env, `/users/${adminId}/delete`, { method: 'POST', cookie: admin }))).error.includes('your own'));

  const refused = await call(env, `/users/${workedId}/delete`, { method: 'POST', cookie: admin });
  ok('an account with recorded case work is refused', refused.status === 409
     && (await jsonOf(refused)).code === 'has_work');
  ok('their history is intact',
     (await env.DB.prepare('SELECT COUNT(*) AS n FROM case_days WHERE investigator_id = ?')
       .bind(workedId).first()).n === 1);

  ok('a never-used account deletes cleanly',
     (await call(env, `/users/${freshId}/delete`, { method: 'POST', cookie: admin })).status === 200);
  ok('the row is gone',
     (await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').bind(freshId).first()).n === 0);
  ok('and every session with it',
     (await call(env, '/auth/me', { cookie: freshCookie })).status === 401);
}

section('Client rate and investigator pay never share a field');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const token = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const dana = users.users.find(u => u.username === 'dana');

  ok('an admin sets what an investigator is paid',
     (await call(env, `/users/${dana.id}/rates`, { method: 'POST', cookie: admin,
       body: { hourly: 55, mileage: 0.5 } })).status === 200);
  ok('an investigator cannot set anyone\'s pay',
     (await call(env, `/users/${dana.id}/rates`, { method: 'POST', cookie: inv,
       body: { hourly: 500 } })).status === 403);
  const comp = await jsonOf(await call(env, '/my/comp', { cookie: inv }));
  ok('they see their own compensation', comp.hourly === 55 && comp.mileage === 0.5);
  const staff = await jsonOf(await call(env, '/users', { cookie: admin }));
  ok('the staff list carries it for the office',
     staff.users.find(u => u.id === dana.id).comp_hourly === 55);

  // Case rate: admin-only arithmetic; the investigator's view never gains money.
  await ingest(env, { case_no: 'API-CR1', carrier: 'Quiet Mutual', claim_number: 'QM-7',
                      client_name: 'A. Adjuster', subject_name: 'S' });
  await call(env, '/submissions/API-CR1/assign', { method: 'POST', cookie: admin, body: { user_id: dana.id } });
  await call(env, '/cases/API-CR1/meta', { method: 'POST', cookie: admin,
    body: { authorized_hours: 8, authorized_budget: 1400 } });
  await call(env, '/cases/API-CR1/settings', { method: 'POST', cookie: admin,
    body: { client_hourly: 175, client_mileage: 0.7 } });
  await call(env, '/cases/API-CR1/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-13', start_time: '07:00' } });
  await call(env, '/cases/API-CR1/day/end', { method: 'POST', cookie: admin, body: { end_time: '11:00' } });

  const aws = await jsonOf(await call(env, '/cases/API-CR1/workspace', { cookie: admin }));
  ok('billing arithmetic uses the case rate', aws.authorization.billed_at_rate === 175
     && aws.authorization.billable_so_far === 700);
  ok('and says the rate is case-specific', aws.authorization.case_rate_set === true);
  const iws = await jsonOf(await call(env, '/cases/API-CR1/workspace', { cookie: inv }));
  ok('none of it reaches the investigator',
     !JSON.stringify(iws.authorization).match(/175|700|billed_at_rate|client_mileage/));

  /* Priority 10's toggle: identity, never money or contacts. */
  let det = await jsonOf(await call(env, '/submissions/API-CR1', { cookie: inv }));
  ok('by default the investigator does not know the carrier',
     !JSON.stringify(det).includes('Quiet Mutual'));
  await call(env, '/cases/API-CR1/settings', { method: 'POST', cookie: admin,
    body: { client_hourly: 175, client_mileage: 0.7, show_client_identity: true } });
  det = await jsonOf(await call(env, '/submissions/API-CR1', { cookie: inv }));
  ok('with the toggle on they learn who the client is',
     det.submission.carrier === 'Quiet Mutual' && det.submission.claim_number === 'QM-7'
       && det.submission.payload.client_name === 'A. Adjuster');
  ok('but still not how to reach or bill them',
     !JSON.stringify(det).match(/adjuster_email|billing_email|client_phone|client_email/));
  ok('and still no rate', !JSON.stringify(det).includes('175'));
  await call(env, '/cases/API-CR1/settings', { method: 'POST', cookie: admin,
    body: { client_hourly: 175, client_mileage: 0.7, show_client_identity: false } });
  det = await jsonOf(await call(env, '/submissions/API-CR1', { cookie: inv }));
  ok('turning it back off closes the door again', !JSON.stringify(det).includes('Quiet Mutual'));
}

section("My reports and my expenses are mine alone");
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const token = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  await ingest(env, { case_no: 'API-M1', subject_name: 'S', client_name: 'C' });
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const dana = users.users.find(u => u.username === 'dana');
  await call(env, '/submissions/API-M1/assign', { method: 'POST', cookie: admin, body: { user_id: dana.id } });

  // Dana works a day and leaves it unreported; the admin does the same on the
  // same case — the desks must not bleed into each other.
  for (const [ck, st, en] of [[inv, '07:00', '11:00'], [admin, '12:00', '14:00']]) {
    await call(env, '/cases/API-M1/day/start', { method: 'POST', cookie: ck,
      body: { day_date: '2026-08-12', start_time: st } });
    await call(env, '/cases/API-M1/day/end', { method: 'POST', cookie: ck, body: { end_time: en } });
  }
  await call(env, '/cases/API-M1/expenses', { method: 'POST', cookie: inv,
    body: { expense_date: '2026-08-12', category: 'parking', amount: 9, description: 'Dana parking' } });
  await call(env, '/cases/API-M1/expenses', { method: 'POST', cookie: admin,
    body: { expense_date: '2026-08-12', category: 'tolls', amount: 4, description: 'Admin toll' } });

  const mine = await jsonOf(await call(env, '/my/reports', { cookie: inv }));
  ok('their unreported day shows on their desk', mine.days_without_reports.length === 1);
  ok("the admin's day does not", mine.days_without_reports[0].hours === 4);
  const myx = await jsonOf(await call(env, '/my/expenses', { cookie: inv }));
  ok('their expenses list is theirs alone',
     myx.expenses.length === 1 && myx.expenses[0].description === 'Dana parking');
  const adminx = await jsonOf(await call(env, '/my/expenses', { cookie: admin }));
  ok("the admin's own desk is scoped the same way",
     adminx.expenses.length === 1 && adminx.expenses[0].description === 'Admin toll');
}

/* ------------------------------------------- what a reassigned investigator keeps
 *
 * OWNER DECISION, 2026-08-14: **Keep.** An investigator who is taken off a case
 * still sees THEIR OWN filed work on it — the day they worked, the report they
 * submitted, the expense they are owed — because removing it deletes their
 * evidence of what they did and what they are due. `/my/*` and `/calendar`
 * therefore scope by `investigator_id` (who created the record), NOT by the
 * case's current `assigned_to`.
 *
 * This is the current behaviour, so the test is not here to change anything —
 * it is here because a decision whose implementation is "no code" is exactly
 * the kind a later tidy-up silently reverses. Someone reading `myReports()` and
 * seeing it ignore `assigned_to` could reasonably think it a scoping bug and
 * "fix" it. That would be a data loss the owner explicitly refused.
 *
 * It asserts BOTH halves, because Keep is only safe while the second holds:
 *   1. the record survives reassignment, and
 *   2. the client behind it still does not — no carrier, claim number, client
 *      name, email or phone, on any of those routes, ever.
 * The case itself is gone: the workspace 404s. What remains is her own work. */
section('A reassigned investigator keeps their own work, never the client');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  for (const [u, n] of [['dana', 'Dana Field'], ['reed', 'Reed Cole']]) {
    const link = (await jsonOf(await invite(env, admin, { username: u, display_name: n, role: 'investigator' }))).url;
    const token = new URL(link, 'https://x.test').searchParams.get('invite');
    await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  }
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const danaId = users.users.find(u => u.username === 'dana').id;
  const reedId = users.users.find(u => u.username === 'reed').id;

  // Every client-identifying field the boundary names, on one case.
  await ingest(env, {
    case_no: 'API-RE1', subject_name: 'Pat Coleman', carrier: 'Quiet Mutual',
    claim_number: 'QM-99812', policy_number: 'POL-4471', client_name: 'Quiet Mutual Claims',
    client_email: 'adjuster@quietmutual.test', client_phone: '540-555-0142',
    adjuster_name: 'R. Hale', adjuster_email: 'r.hale@quietmutual.test',
    billing_email: 'ap@quietmutual.test', defense_counsel: 'Hale & Roe',
  });
  await call(env, '/submissions/API-RE1/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });

  // Dana works a day, files an expense, and leaves a second day running.
  await call(env, '/cases/API-RE1/day/start', { method: 'POST', cookie: inv,
    body: { day_date: '2026-08-12', start_time: '07:00' } });
  await call(env, '/cases/API-RE1/day/end', { method: 'POST', cookie: inv, body: { end_time: '11:00' } });
  await call(env, '/cases/API-RE1/expenses', { method: 'POST', cookie: inv,
    body: { expense_date: '2026-08-12', category: 'parking', amount: 9, description: 'Dana parking' } });
  await call(env, '/cases/API-RE1/day/start', { method: 'POST', cookie: inv,
    body: { day_date: '2026-08-13', start_time: '06:30' } });

  // The admin takes the case off her and gives it to Reed.
  const re = await call(env, '/submissions/API-RE1/assign', { method: 'POST', cookie: admin, body: { user_id: reedId } });
  ok('the case can be reassigned to another investigator', re.status === 200);
  ok('the case itself is gone from the reassigned investigator',
     (await call(env, '/submissions/API-RE1', { cookie: inv })).status === 404);
  ok('and off their case list',
     (await jsonOf(await call(env, '/submissions', { cookie: inv }))).total === 0);

  // Half one — their own filed work survives it (the owner's "Keep").
  const mine = await jsonOf(await call(env, '/my/reports', { cookie: inv }));
  ok('the day they worked is still on their desk after reassignment',
     mine.days_without_reports.some(d => d.case_no === 'API-RE1' && d.hours === 4));
  const myx = await jsonOf(await call(env, '/my/expenses', { cookie: inv }));
  ok('the expense they are owed survives it too',
     myx.expenses.some(e => e.case_no === 'API-RE1' && e.description === 'Dana parking'));
  const act = await jsonOf(await call(env, '/my/active', { cookie: inv }));
  ok('a day still running stays theirs to resume',
     act.active && act.active.case_no === 'API-RE1');
  const cal = await jsonOf(await call(env, '/calendar?month=2026-08', { cookie: inv }));
  ok('and their calendar history keeps the days they worked',
     JSON.stringify(cal).includes('API-RE1'));

  // Half two — and none of it carries the client. This is the firm line, and it
  // is what makes half one safe rather than a slow leak of the client list.
  const CLIENT = ['Quiet Mutual', 'QM-99812', 'POL-4471', 'adjuster@quietmutual.test',
                  '540-555-0142', 'R. Hale', 'r.hale@quietmutual.test',
                  'ap@quietmutual.test', 'Hale & Roe'];
  // Positive control first. Without it every assertion below would also pass on
  // an empty payload, a renamed field or an ingest that quietly dropped them —
  // proving nothing. The admin must actually be able to see what the
  // investigator must not.
  const adminBlob = JSON.stringify(await jsonOf(await call(env, '/submissions/API-RE1', { cookie: admin })));
  ok('control: the admin really is sent every one of those values',
     CLIENT.every(v => adminBlob.includes(v)),
     `missing from the admin view: ${CLIENT.filter(v => !adminBlob.includes(v)).join(', ')}`);
  for (const [label, payload] of [['reports', mine], ['expenses', myx],
                                  ['the running day', act], ['the calendar', cal]]) {
    const blob = JSON.stringify(payload);
    ok(`${label} — no carrier, claim, policy, adjuster, billing or counsel`,
       CLIENT.every(v => !blob.includes(v)),
       CLIENT.filter(v => blob.includes(v)).join(', '));
  }
  ok('the running day carries the subject, which is fieldwork, not the client',
     act.active.subject_name === 'Pat Coleman');

  // Reed gets the case; he does not get the client either.
  const reed = (await login(env, 'reed', 'FieldWork2026x')).cookie;
  const reedRes = await call(env, '/submissions/API-RE1', { cookie: reed });
  const reedBlob = JSON.stringify(await jsonOf(reedRes));
  ok('the new investigator can open the case', reedRes.status === 200);
  ok('but is sent no more of the client than the last one was',
     CLIENT.every(v => !reedBlob.includes(v)),
     CLIENT.filter(v => reedBlob.includes(v)).join(', '));
}

/* PAYMENTS.md, owner 2026-08-14 — the private-client payment configuration.
   The whole feature is a boundary: Cash App and Venmo belong to the PRIVATE
   client path and nowhere else, the configuration is the office's alone, and
   the two lines easiest to lose to a helpful default are that a payment URL is
   never invented from a handle and that no credential is ever stored. */
/* OWNER, 2026-08-15: both methods must be clickable client-facing actions, the
   whole card is the tap target, and the Venmo @ is display text that must NOT
   enter the URL path. Driven against the firm's REAL configured destinations,
   in a section of its own so nothing has reconfigured them first. */
section('Both payment methods are clickable, with the firm\'s own destinations');
{
  const realFetch = globalThis.fetch;
  let lastBody = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      lastBody = JSON.parse(init.body);
      return new Response('{"id":"re_1"}', { status: 200 });
    }
    return realFetch(url, init);
  };
  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  env.MAIL_PER_MINUTE = '50';
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const has = (hay, needle) => String(hay).toLowerCase().includes(String(needle).toLowerCase());

  const out = await jsonOf(await call(env, '/sheets/private_retainer/email',
    { method: 'POST', cookie: admin, body: { to: 'client@example.com', include_payment: true } }));
  const h = lastBody.html, t = lastBody.text;

  ok('both methods are offered out of the box, with no configuration step',
     out.included.payment_methods.map(m => m.id).sort().join() === 'cash_app,venmo');
  ok('Cash App links to the firm\'s configured URL',
     h.includes('href="https://cash.app/$TreverB"'));
  ok('Venmo links to the firm\'s configured URL',
     h.includes('href="https://venmo.com/u/Trever-Brown-9"'));

  /* The sharpest one. The handle is written @Trever-Brown-9 and the path is
     /u/Trever-Brown-9 — build the second from the first and you get
     venmo.com/u/@Trever-Brown-9, which is not the firm's page. A client who
     taps that lands nowhere, or on somebody else, holding a retainer. */
  const venmoHref = (h.match(/href="(https:\/\/venmo\.com[^"]*)"/) || [])[1] || '';
  ok('and the @ never reaches the Venmo URL path',
     venmoHref === 'https://venmo.com/u/Trever-Brown-9'
     && !venmoHref.includes('@') && !venmoHref.toLowerCase().includes('%40'), venmoHref);
  ok('while the @ IS shown to the client as the handle',
     h.includes('@Trever-Brown-9') && t.includes('@Trever-Brown-9'));
  ok('and the Cash App handle is shown too', has(`${h}\n${t}`, '$TreverB'));

  /* "Make the entire payment button/card clickable, not just a tiny text
     link" — the anchor is the outer element, so the handle sits INSIDE it. */
  const cards = h.match(/<a href="https:\/\/(?:cash\.app|venmo\.com)[^"]*"[\s\S]*?<\/a>/g) || [];
  ok('each method is one whole clickable card, not a link beside text',
     cards.length === 2 && cards.every(c => c.includes('display:block')), String(cards.length));
  ok('and the handle is inside the tap target, not outside it',
     cards.some(c => c.includes('$TreverB')) && cards.some(c => c.includes('@Trever-Brown-9')));
  ok('each card says what tapping it does',
     cards.every(c => /PAY WITH (CASH APP|VENMO)/.test(c)));
  ok('the text part carries both links for a client who blocks HTML',
     t.includes('https://cash.app/$TreverB') && t.includes('https://venmo.com/u/Trever-Brown-9'));

  /* Independently selectable, against the real values. */
  lastBody = null;
  const only = await jsonOf(await call(env, '/sheets/private_retainer/email',
    { method: 'POST', cookie: admin,
      body: { to: 'client@example.com', include_payment: true, methods: ['venmo'] } }));
  ok('either method can be sent on its own',
     only.included.payment_methods.map(m => m.id).join() === 'venmo'
     && !lastBody.html.includes('cash.app') && lastBody.html.includes('venmo.com'));

  /* THE BOUNDARY, against the real values: a carrier must never see either. */
  lastBody = null;
  await call(env, '/sheets/insurance_assignment/email',
    { method: 'POST', cookie: admin, body: { to: 'adjuster@carrier.example', include_intake: true } });
  const carrier = `${lastBody.html}\n${lastBody.text}`;
  ok('a carrier email carries neither real handle nor either link',
     !carrier.includes('$TreverB') && !carrier.includes('Trever-Brown-9')
     && !carrier.includes('cash.app') && !carrier.includes('venmo.com'));
  ok('and still says nothing about payment options at all',
     !has(carrier, 'PAY WITH') && !has(carrier, 'payment options'));

  globalThis.fetch = realFetch;
}

/* THE UPGRADE PATH. Enabling a method with only a handle used to be allowed,
   and rows saved under that rule still exist. Once every option had to be
   tappable, the filter started dropping them — so a send could succeed while
   the client quietly received one payment option instead of two, and nobody
   would go looking. Planted straight into the table, because the API now
   refuses to create such a row and this is about the ones already there. */
section('A method left switched on without a link is never dropped in silence');
{
  const realFetch = globalThis.fetch;
  let lastBody = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      lastBody = JSON.parse(init.body);
      return new Response('{"id":"re_1"}', { status: 200 });
    }
    return realFetch(url, init);
  };
  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  env.MAIL_PER_MINUTE = '50';
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const has = (hay, needle) => String(hay).toLowerCase().includes(String(needle).toLowerCase());

  // A legacy row: enabled, a handle, and no link — legal when it was written.
  await env.DB.prepare(
    `INSERT INTO payment_methods (method, enabled, display_name, handle, url, instructions, updated_at)
     VALUES ('venmo', 1, 'Venmo', '@LegacyHandle', '', '', ?)`).bind('2026-08-14T00:00:00Z').run();

  lastBody = null;
  const refused = await call(env, '/sheets/private_retainer/email',
    { method: 'POST', cookie: admin, body: { to: 'client@example.com', include_payment: true } });
  ok('the send is refused rather than quietly dropping the method', refused.status === 400);
  ok('and nothing was emailed', lastBody === null);
  const err = (await jsonOf(refused));
  ok('the refusal names the method that cannot be offered', has(err.error, 'Venmo'));
  ok('and says where to fix it', has(err.error, 'Add a link in Settings'));
  ok('and identifies it to the page', (err.needs_link || []).join() === 'venmo');

  /* The wrong fix would be to fall back to the built-in URL. This row carries
     a DIFFERENT handle, so inheriting the firm's link would point the client
     at the firm's page while the screen showed @LegacyHandle — money to the
     wrong destination, silently. Assert it never happens. */
  ok('the firm\'s own link is NEVER substituted for a broken row',
     !has(String(err.error), 'venmo.com/u/Trever-Brown-9'));

  // Not selected means not a problem: the broken row is simply not requested.
  lastBody = null;
  const okSend = await jsonOf(await call(env, '/sheets/private_retainer/email',
    { method: 'POST', cookie: admin,
      body: { to: 'client@example.com', include_payment: true, methods: ['cash_app'] } }));
  ok('a send that does not ask for the broken method still works',
     okSend.included.payment_methods.map(m => m.id).join() === 'cash_app');
  ok('and it carries the Cash App link', lastBody.html.includes('https://cash.app/$TreverB'));
  ok('and nothing of the broken method rides along', !has(lastBody.html, '@LegacyHandle'));

  // Fixing it in Settings clears the refusal.
  ok('giving it a link makes it sendable again',
     (await call(env, '/payment-methods/venmo', { method: 'POST', cookie: admin,
       body: { enabled: true, display_name: 'Venmo', handle: '@LegacyHandle',
               url: 'https://venmo.com/u/LegacyHandle' } })).status === 200);
  lastBody = null;
  const fixed = await jsonOf(await call(env, '/sheets/private_retainer/email',
    { method: 'POST', cookie: admin, body: { to: 'client@example.com', include_payment: true } }));
  ok('both methods are offered once the link exists',
     fixed.included.payment_methods.map(m => m.id).sort().join() === 'cash_app,venmo');
  ok('and the client is sent the link the ADMIN entered, not the built-in one',
     lastBody.html.includes('https://venmo.com/u/LegacyHandle')
     && !lastBody.html.includes('venmo.com/u/Trever-Brown-9'));

  // Switching it off is the other valid answer, and needs no link.
  ok('turning it off is accepted without a link',
     (await call(env, '/payment-methods/venmo', { method: 'POST', cookie: admin,
       body: { enabled: false, handle: '@LegacyHandle' } })).status === 200);
  const off = await jsonOf(await call(env, '/sheets/private_retainer/email',
    { method: 'POST', cookie: admin, body: { to: 'client@example.com', include_payment: true } }));
  ok('and then the send succeeds with the remaining method',
     off.included.payment_methods.map(m => m.id).join() === 'cash_app');

  globalThis.fetch = realFetch;
}

section('Private-client payment methods are the office\'s own configuration');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin,
    { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  await call(env, `/invite/${new URL(link, 'https://x.test').searchParams.get('invite')}/accept`,
    { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  const has = (hay, needle) => String(hay).toLowerCase().includes(String(needle).toLowerCase());

  // 7.7 / 15: the configuration is admin-only on BOTH verbs. A 403 on write
  // alone would leave where the firm's money arrives browsable by the field.
  ok('an investigator cannot read the payment configuration',
     (await call(env, '/payment-methods', { cookie: inv })).status === 403);
  ok('nor write it',
     (await call(env, '/payment-methods/venmo', { method: 'POST', cookie: inv,
       body: { enabled: true, handle: '@someone-else' } })).status === 403);

  const start = (await jsonOf(await call(env, '/payment-methods', { cookie: admin }))).methods;
  /* Owner 2026-08-15: both destinations are configured and ON out of the box,
     so the working state is the default rather than an empty form. */
  ok('both methods arrive configured and on', start.length === 2
     && start.every(m => m.enabled === true && m.handle && m.url));
  ok('and each one is marked as coming from the built-in configuration',
     start.every(m => m.from_default === true));
  ok('and they are the two the owner named',
     start.map(m => m.id).sort().join() === 'cash_app,venmo');

  // A method with nowhere to send money would render an empty PAYMENT OPTIONS
  // block — worse than omitting it, because it reads as a forgotten detail.
  ok('a method cannot be enabled with nowhere to send money',
     (await call(env, '/payment-methods/venmo', { method: 'POST', cookie: admin,
       body: { enabled: true } })).status === 400);

  /* TWO RULES THAT ONLY LOOK OPPOSED, and both are load-bearing.

     Owner 2026-08-15: every payment method a client sees must be a clickable
     action. So a method cannot be enabled with only a handle — it would render
     as text the client has to retype, which is the thing that instruction
     replaced. The earlier order allowed it; the later one governs.

     And still: the URL is ADMIN-ENTERED, never built from the handle. The
     resolution is that both destinations have a real URL, not that the code
     guesses one. A fabricated cash.app/$handle that resolves to a real
     stranger sends a client's retainer to the wrong person. */
  ok('a handle with no link cannot be enabled — every option must be tappable',
     (await call(env, '/payment-methods/venmo', { method: 'POST', cookie: admin,
       body: { enabled: true, handle: '@AlwaysPrecise', display_name: 'Venmo' } })).status === 400);
  ok('and the refusal says a link is never guessed from a handle',
     has((await jsonOf(await call(env, '/payment-methods/venmo', { method: 'POST', cookie: admin,
       body: { enabled: true, handle: '@AlwaysPrecise' } }))).error, 'never guessed from a handle'));

  ok('a handle WITH a link is accepted',
     (await call(env, '/payment-methods/venmo', { method: 'POST', cookie: admin,
       body: { enabled: true, handle: '@AlwaysPrecise', display_name: 'Venmo',
               url: 'https://venmo.com/u/AlwaysPrecise' } })).status === 200);
  const afterHandle = (await jsonOf(await call(env, '/payment-methods', { cookie: admin })))
    .methods.find(m => m.id === 'venmo');
  ok('the url is exactly what was entered, with nothing derived',
     afterHandle.url === 'https://venmo.com/u/AlwaysPrecise');
  ok('the handle is stored as given, @ and all', afterHandle.handle === '@AlwaysPrecise');
  ok('and the @ is NOT propagated into the stored url', !afterHandle.url.includes('@'));

  // A method may still be turned OFF while keeping its details for later.
  ok('a method can be disabled without a link being required',
     (await call(env, '/payment-methods/venmo', { method: 'POST', cookie: admin,
       body: { enabled: false, handle: '@AlwaysPrecise' } })).status === 200);

  // A link that cannot be a payment link is refused rather than silently
  // blanked, or an admin believes clients are being sent one when they are not.
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'cash.app/$x', 'ftp://x.test/a']) {
    ok(`a ${bad.split(':')[0]} link is refused outright`,
       (await call(env, '/payment-methods/cash_app', { method: 'POST', cookie: admin,
         body: { enabled: true, handle: '$Always', url: bad } })).status === 400);
  }
  ok('a real https link is kept',
     (await call(env, '/payment-methods/cash_app', { method: 'POST', cookie: admin,
       body: { enabled: true, handle: '$Always', url: 'https://cash.app/$AlwaysPrecise' } })).status === 200);

  // Nothing resembling a credential has a column to live in.
  const cols = (await env.DB.prepare("SELECT name FROM pragma_table_info('payment_methods')").all())
    .results.map(c => c.name);
  ok('the table has no column for a password, token or secret',
     !cols.some(c => /pass|token|secret|credential|login|key/i.test(c)), cols.join());

  // An unknown method is not quietly created.
  ok('an unknown payment method is refused',
     (await call(env, '/payment-methods/zelle', { method: 'POST', cookie: admin,
       body: { enabled: true, handle: 'x' } })).status === 404);
}

/* The boundary the order is actually about: which EMAIL may carry a payment
   handle. Asserted on the bytes the provider was handed, in BOTH MIME parts —
   the same standard the intake-door pairing is held to, because an HTML-only
   assertion passes while the text part leaks. */
section('Payment instructions ride with the private client and no one else');
{
  const realFetch = globalThis.fetch;
  let lastBody = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      lastBody = JSON.parse(init.body);
      return new Response('{"id":"re_1"}', { status: 200 });
    }
    return realFetch(url, init);
  };
  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  env.MAIL_PER_MINUTE = '50';
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  await call(env, '/payment-methods/cash_app', { method: 'POST', cookie: admin,
    body: { enabled: true, display_name: 'Cash App', handle: '$AlwaysPrecise',
            url: 'https://cash.app/$AlwaysPrecise' } });
  await call(env, '/payment-methods/venmo', { method: 'POST', cookie: admin,
    body: { enabled: true, display_name: 'Venmo', handle: '@AlwaysPrecise',
            url: 'https://venmo.com/u/AlwaysPrecise' } });

  const both = s => `${s.html}\n${s.text}`;   // every assertion covers both parts
  const has = (hay, needle) => String(hay).toLowerCase().includes(String(needle).toLowerCase());

  // 1. Private sheet CAN carry them.
  lastBody = null;
  const sent = await jsonOf(await call(env, '/sheets/private_retainer/email',
    { method: 'POST', cookie: admin, body: { to: 'client@example.com', include_payment: true } }));
  ok('the private sheet carries the payment block', has(both(lastBody), 'PAYMENT OPTIONS'));
  ok('with both handles, in both parts',
     lastBody.html.includes('$AlwaysPrecise') && lastBody.text.includes('$AlwaysPrecise')
     && lastBody.html.includes('@AlwaysPrecise') && lastBody.text.includes('@AlwaysPrecise'));
  ok('the retainer amount is named', has(both(lastBody), '$1,500'));

  // 7. Clickable only where a URL was ENTERED — never invented from a handle.
  ok('the configured link becomes a button', lastBody.html.includes('https://cash.app/$AlwaysPrecise'));
  /* The @ is display text. It is shown to the client and it never enters a
     URL path — venmo.com/u/@AlwaysPrecise is not anyone's page. */
  ok('the @ is shown but never lands in a link',
     lastBody.html.includes('@AlwaysPrecise')
     && !/href="[^"]*@AlwaysPrecise/.test(lastBody.html)
     && !lastBody.html.includes('venmo.com/u/@'));

  // 12/13. The confirmation lists what actually went.
  ok('the confirmation names the sheet, and both methods',
     sent.included && sent.included.rate_sheet === '$1,500 Retainer'
     && sent.included.payment_methods.map(m => m.id).sort().join() === 'cash_app,venmo');
  ok('and it does not claim an intake went when none did', sent.included.intake === null);

  // 2/7. The carrier sheet may NEVER carry them — refused, not quietly dropped.
  lastBody = null;
  const refused = await call(env, '/sheets/insurance_assignment/email',
    { method: 'POST', cookie: admin, body: { to: 'adjuster@carrier.example', include_payment: true } });
  ok('asking for payment options on the carrier sheet is refused', refused.status === 400);
  ok('and nothing was emailed at all', lastBody === null);

  // The carrier sheet sent normally still carries no trace of either handle.
  lastBody = null;
  await call(env, '/sheets/insurance_assignment/email',
    { method: 'POST', cookie: admin, body: { to: 'adjuster@carrier.example', include_intake: true } });
  /* The handles specifically, not the bare firm name — the carrier email
     legitimately carries alwayspreciseinvestigations.net in its intake link,
     and asserting on that substring would fail for the wrong reason. */
  const carrier = both(lastBody).toLowerCase();
  ok('a carrier email names no payment method at all',
     !carrier.includes('cash app') && !carrier.includes('venmo')
     && !carrier.includes('$alwaysprecise') && !carrier.includes('@alwaysprecise')
     && !carrier.includes('payment options') && !carrier.includes('cash.app'));

  // 5/6/10. Each method is independently switchable, and OFF means absent.
  await call(env, '/payment-methods/cash_app', { method: 'POST', cookie: admin,
    body: { enabled: false, handle: '$AlwaysPrecise', url: 'https://cash.app/$AlwaysPrecise' } });
  lastBody = null;
  await call(env, '/sheets/private_retainer/email',
    { method: 'POST', cookie: admin, body: { to: 'client@example.com', include_payment: true } });
  ok('a disabled method does not render', !has(both(lastBody), '$AlwaysPrecise'));
  ok('while the one still enabled does', has(both(lastBody), '@AlwaysPrecise'));

  // The per-send selection can narrow, but never widen past the configuration.
  await call(env, '/payment-methods/cash_app', { method: 'POST', cookie: admin,
    body: { enabled: false, handle: '$AlwaysPrecise' } });
  lastBody = null;
  const narrowed = await jsonOf(await call(env, '/sheets/private_retainer/email',
    { method: 'POST', cookie: admin,
      body: { to: 'client@example.com', include_payment: true, methods: ['cash_app', 'venmo'] } }));
  ok('asking for a disabled method does not switch it on',
     !has(both(lastBody), '$AlwaysPrecise')
     && narrowed.included.payment_methods.map(m => m.id).join() === 'venmo');

  /* Unticking BOTH methods must send NEITHER. This read as "no preference" and
     fell through to every enabled method — the precise opposite of the request,
     and it defeated the independent per-method control the order asks for. No
     selection and an empty selection are different answers. */
  await call(env, '/payment-methods/cash_app', { method: 'POST', cookie: admin,
    body: { enabled: true, display_name: 'Cash App', handle: '$AlwaysPrecise',
            url: 'https://cash.app/$AlwaysPrecise' } });
  lastBody = null;
  const none = await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
    body: { to: 'client@example.com', include_payment: true, methods: [] } });
  ok('unticking every payment method sends none of them', none.status === 400);
  ok('and nothing was emailed', lastBody === null);
  ok('the refusal is answerable here, not in Settings',
     has((await jsonOf(none)).error, 'Choose at least one payment method'));

  // A selection of only unknown ids is the same answer: none.
  lastBody = null;
  ok('a selection of nothing real is refused too',
     (await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
       body: { to: 'client@example.com', include_payment: true, methods: ['zelle'] } })).status === 400
     && lastBody === null);

  // And omitting the field entirely still means "whatever is enabled".
  lastBody = null;
  const dflt = await jsonOf(await call(env, '/sheets/private_retainer/email',
    { method: 'POST', cookie: admin, body: { to: 'client@example.com', include_payment: true } }));
  ok('saying nothing about methods still sends the enabled ones',
     dflt.included.payment_methods.map(m => m.id).sort().join() === 'cash_app,venmo');

  // 11. Escaping — the handle is admin-entered and lands in HTML.
  await call(env, '/payment-methods/venmo', { method: 'POST', cookie: admin,
    body: { enabled: true, display_name: 'Venmo', handle: '@a<script>alert(1)</script>',
            url: 'https://venmo.com/u/AlwaysPrecise' } });
  lastBody = null;
  await call(env, '/sheets/private_retainer/email',
    { method: 'POST', cookie: admin, body: { to: 'client@example.com', include_payment: true } });
  ok('a handle carrying markup is escaped, not rendered',
     !lastBody.html.includes('<script>') && lastBody.html.includes('&lt;script&gt;'));

  // With nothing enabled at all, the send says so rather than mailing an empty
  // PAYMENT OPTIONS heading.
  await call(env, '/payment-methods/venmo', { method: 'POST', cookie: admin,
    body: { enabled: false, handle: '@AlwaysPrecise' } });
  await call(env, '/payment-methods/cash_app', { method: 'POST', cookie: admin,
    body: { enabled: false, handle: '$AlwaysPrecise' } });
  ok('including payment with nothing configured is refused',
     (await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
       body: { to: 'client@example.com', include_payment: true } })).status === 400);
  ok('and that refusal points at Settings, where it can actually be answered',
     has((await jsonOf(await call(env, '/sheets/private_retainer/email', { method: 'POST',
       cookie: admin, body: { to: 'client@example.com', include_payment: true } }))).error,
       'Set one up in Settings'));

  globalThis.fetch = realFetch;
}

/* SEND PAYMENT OPTIONS ON ITS OWN (PAYMENTS.md second handoff §1/§4/§15).
   "This allows payment instructions to be sent later without resending the rate
   sheet." The boundary is the same one the sheet already enforces, checked from
   both ends: a private client can be sent them, a carrier never can. */
section('Payment instructions can go on their own, and never to a carrier');
{
  const realFetch = globalThis.fetch;
  let lastBody = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      lastBody = JSON.parse(init.body);
      return new Response('{"id":"re_1"}', { status: 200 });
    }
    return realFetch(url, init);
  };
  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  env.MAIL_PER_MINUTE = '50';
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const both = s => `${s.html}\n${s.text}`;
  const has = (hay, needle) => String(hay).toLowerCase().includes(String(needle).toLowerCase());

  await call(env, '/payment-methods/cash_app', { method: 'POST', cookie: admin,
    body: { enabled: true, display_name: 'Cash App', handle: '$AlwaysPrecise',
            url: 'https://cash.app/$AlwaysPrecise' } });
  await call(env, '/payment-methods/venmo', { method: 'POST', cookie: admin,
    body: { enabled: true, display_name: 'Venmo', handle: '@AlwaysPrecise',
            url: 'https://venmo.com/u/AlwaysPrecise' } });

  await ingest(env, { case_no: 'API-PO1', service: 'Surveillance',
                      client_name: 'P. Client', subject_name: 'S' });
  await ingest(env, { case_no: 'API-POC', carrier: 'Acme Mutual', claim_number: 'AM-3',
                      client_name: 'A. Adjuster', subject_name: 'C' });

  // §15.1 — a private lead CAN be sent payment options, with no sheet attached.
  lastBody = null;
  const sent = await jsonOf(await call(env, '/payment-options/email', { method: 'POST',
    cookie: admin, body: { to: 'client@example.com', name: 'Jane', case_no: 'API-PO1' } }));
  ok('a private client can be sent payment options on their own', sent.ok === true);
  ok('the email carries the payment block', has(both(lastBody), 'PAYMENT OPTIONS'));
  ok('with both configured destinations, in both parts',
     lastBody.html.includes('https://cash.app/$AlwaysPrecise')
     && lastBody.text.includes('https://cash.app/$AlwaysPrecise')
     && lastBody.html.includes('venmo.com/u/AlwaysPrecise'));
  ok('and greets them by the name that was entered', has(both(lastBody), 'Jane'));
  /* The point of the feature: no rate sheet rides along. A client who already
     has the sheet receiving a second copy would reasonably read it as the terms
     having changed. */
  /* Asserted on strings only the SHEET has. "retainer to begin" is not one of
     them — the shared payment block says "required to begin investigative
     services", so a naive absence check there fails on the feature's own
     correct wording rather than on a rate sheet sneaking in. */
  ok('but NOT the rate sheet — that is the whole point of sending these alone',
     !has(both(lastBody), 'Investigative rate')
     && !has(both(lastBody), 'Straightforward billing')
     && !has(both(lastBody), 'Applied to the work')
     && !has(both(lastBody), '/hr'),
     both(lastBody).slice(0, 200));
  ok('nor an intake link', !has(both(lastBody), '/intake/'));
  ok('the subject names the case it belongs to', lastBody.subject.includes('API-PO1'));

  // §15.9 — and it says, in the answer itself, that nothing was marked paid.
  ok('the answer states plainly that no retainer was marked paid',
     sent.retainer_marked_paid === false);
  const ret = (await jsonOf(await call(env, '/cases/API-PO1/workspace', { cookie: admin })))
    .authorization.retainer;
  ok('and the case really is still pending, with no money against it',
     ret.status === 'pending' && ret.received_total === 0 && ret.received === false,
     JSON.stringify([ret.status, ret.received_total]));

  /* THE SEND IS RECORDED, AND DISTINGUISHABLE from one that rode with a sheet.
     `with_sheet` existed before this route did, precisely for this. */
  const log = await env.DB.prepare(
    'SELECT recipient, methods, with_sheet, ok FROM payment_send WHERE case_no = ?')
    .bind('API-PO1').all();
  ok('the send is written to payment_send', (log.results || []).length === 1);
  ok('marked as having gone WITHOUT a sheet',
     Number(log.results[0].with_sheet) === 0, String(log.results[0].with_sheet));
  ok('naming the recipient and both methods',
     log.results[0].recipient === 'client@example.com'
     && log.results[0].methods.split(',').sort().join() === 'cash_app,venmo');

  /* THE LEAD IS NOT STAMPED. The nine §5 statuses describe the rate sheet and
     the intake; there is no payment status among them, so moving the lead would
     put an event in the history that did not happen. */
  const lead = await env.DB.prepare('SELECT status FROM lead_status WHERE case_no = ?')
    .bind('API-PO1').first();
  ok('and the lead is NOT moved to Rate Sheet Sent by it', !lead || lead.status === 'lead',
     JSON.stringify(lead));

  // §15.2 — a carrier never can. Refused by name, not quietly emptied.
  lastBody = null;
  const refused = await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
    body: { to: 'adjuster@carrier.example', case_no: 'API-POC' } });
  ok('a claim assignment is refused outright', refused.status === 400);
  ok('and nothing whatsoever was emailed', lastBody === null);
  ok('the refusal says why, in words the office can act on',
     has((await jsonOf(await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
       body: { to: 'adjuster@carrier.example', case_no: 'API-POC' } }))).error,
       'never sent to a carrier'));

  /* PRE-CASE SENDS (owner, 2026-08-15 — a blocking workflow defect).

     "Name + valid email are enough to send. Case #, Claim #, and internal
     reference are OPTIONAL when available."

     A refusal briefly stood here for references that matched nothing, added
     against a real hole found by the Codex review. It also blocked the way the
     office actually onboards a private client — quote, sheet, payment
     instructions, and only then a case — so the owner removed it. These
     assertions are the reversal, written so the block cannot come back by
     accident, and they sit beside the boundary checks that still hold. */
  lastBody = null;
  const typo = await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
    body: { to: 'newclient@example.com', name: 'Jane', case_no: 'PAPER-REF-4471' } });
  ok('a reference nobody can resolve does NOT block the send', typo.status === 200,
     String(typo.status));
  ok('and the email really went', lastBody !== null);
  lastBody = null;
  ok('no reference at all sends too — name and email are enough',
     (await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
       body: { to: 'newprospect@example.com', name: 'Sam' } })).status === 200);
  ok('and that one really went as well', lastBody !== null);

  /* THE RECIPIENT IS NOT CLASSIFIED BY THEIR EMAIL ADDRESS (owner refactor,
     2026-08-15). `recipientIsCarrier()` used to compare the recipient against
     stored carrier contacts. It produced four defects in four review rounds —
     substring matches refusing unrelated private clients, addresses quoted in
     free-text notes blocklisting people, and fail-open on stored whitespace,
     first ordinary spaces and then non-breaking ones — and the owner removed
     the whole approach rather than take a fifth patch.

     These assert the NEW property, which is the strong one: the address makes
     no difference at all. Every one of these previously changed the outcome. */
  for (const [nick, addr] of [
    ['different casing', 'ADJUSTER@Carrier.Example'],
    ['leading/trailing spaces', '  spaced@carrier.example  '],
    ['a non-breaking space', 'nbsp@carrier.example '],
    ['a zero-width space', 'zwsp@carrier.example​'],
    ['an address that is a substring of a carrier\'s', 'jane@example.com'],
    ['an address a carrier\'s is a substring of', 'mary.jane.smith@example.com'],
  ]) {
    lastBody = null;
    const r = await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
      body: { to: addr.trim(), name: 'Anyone' } });
    ok(`a private send is unaffected by ${nick}`, r.status === 200, `${nick}: ${r.status}`);
    ok(`and it really went (${nick})`, lastBody !== null);
  }

  /* SAME-NAME CONTACTS. Two people called the same thing, one a private client
     and one an adjuster, are not confusable — nothing here looks at names
     either. */
  await ingest(env, { case_no: 'API-SN-C', carrier: 'Same Name Mutual', claim_number: 'SN-1',
                      client_name: 'Chris Morgan', client_email: 'chris.morgan@carrier.example',
                      subject_name: 'X' });
  await ingest(env, { case_no: 'API-SN-P', service: 'Surveillance',
                      client_name: 'Chris Morgan', client_email: 'chris.morgan@gmail.example',
                      subject_name: 'Y' });
  lastBody = null;
  ok('a private client sharing a name with an adjuster is sent payment options',
     (await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
       body: { to: 'chris.morgan@gmail.example', case_no: 'API-SN-P' } })).status === 200);
  ok('and it really went', lastBody !== null);
  /* And the typed field still decides where a typed field exists: the CLAIMS
     case is refused, by `submissions.kind`, not by anything about the address. */
  lastBody = null;
  ok('while the claim assignment of the same name is refused by its KIND',
     (await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
       body: { to: 'chris.morgan@carrier.example', case_no: 'API-SN-C' } })).status === 400);
  ok('and nothing went to them', lastBody === null);
  /* THE PROOF THAT IT IS THE KIND AND NOT THE ADDRESS: the SAME carrier address
     sends fine when no claims reference is given, because this route is a
     private context and there is nothing to classify. That is the owner's rule
     stated as a test — the flow decides, not the recipient. */
  lastBody = null;
  ok('the same carrier address sends when the flow is the only thing speaking',
     (await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
       body: { to: 'chris.morgan@carrier.example' } })).status === 200);
  ok('which is the refactor working as designed', lastBody !== null);

  /* THE CONTEXT IS SERVER-DERIVED AND OBSERVABLE. */
  const pctx = await jsonOf(await call(env, '/payment-options/email', { method: 'POST',
    cookie: admin, body: { to: 'anyone@example.com' } }));
  ok('a payment send reports its context, and it is private',
     pctx.send_context === 'private', JSON.stringify(pctx.send_context));

  /* WHAT PRE-CASE DID NOT RELAX. A reference that DOES resolve to a claim
     assignment is still refused — the separation the owner asked to preserve
     rests on the product being sent and on this check, not on whether a lookup
     found something. */
  lastBody = null;
  ok('a resolving claim assignment is still refused',
     (await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
       body: { to: 'adjuster@carrier.example', case_no: 'API-POC' } })).status === 400);
  ok('and nothing reached that adjuster', lastBody === null);

  /* THE SHEET SEND, same rule. A private sheet WITH payment options goes to a
     pre-case prospect, and is still refused against a real claim assignment. */
  lastBody = null;
  ok('the private sheet carries payment to a pre-case prospect',
     (await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
       body: { to: 'prospect@example.com', case_no: 'NOT-A-CASE-YET',
               include_payment: true } })).status === 200);
  ok('and really did send, with the reference in the subject',
     lastBody !== null && lastBody.subject.includes('NOT-A-CASE-YET'));
  ok('with the payment block on it', has(both(lastBody), 'PAYMENT OPTIONS'));
  lastBody = null;
  ok('but a real claim assignment is still refused the consumer sheet',
     (await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
       body: { to: 'adjuster@carrier.example', case_no: 'API-POC',
               include_payment: true } })).status === 400);
  ok('and nothing went to the carrier', lastBody === null);
  /* And the carrier sheet can never carry payment at all, case or no case —
     the rule that does not depend on any lookup. */
  ok('the carrier sheet still cannot carry payment even with no case',
     (await call(env, '/sheets/insurance_assignment/email', { method: 'POST', cookie: admin,
       body: { to: 'adjuster@carrier.example', include_payment: true } })).status === 400);

  // §15.5/15.6/15.10 — each method independently, and OFF means absent.
  lastBody = null;
  await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
    body: { to: 'client@example.com', case_no: 'API-PO1', methods: ['venmo'] } });
  ok('one method alone sends only that one',
     has(both(lastBody), '@AlwaysPrecise') && !has(both(lastBody), '$AlwaysPrecise'));
  ok('choosing none is refused rather than sent as an empty heading',
     (await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
       body: { to: 'client@example.com', methods: [] } })).status === 400);

  /* §15.11 — a handle carrying markup is escaped, never rendered. Admin-entered
     text reaches an HTML email part. */
  await call(env, '/payment-methods/venmo', { method: 'POST', cookie: admin,
    body: { enabled: true, display_name: 'Venmo', handle: '<script>alert(1)</script>',
            url: 'https://venmo.com/u/AlwaysPrecise' } });
  lastBody = null;
  await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
    body: { to: 'client@example.com', methods: ['venmo'] } });
  ok('a handle carrying markup is escaped, not rendered',
     !lastBody.html.includes('<script>') && lastBody.html.includes('&lt;script&gt;'));

  /* A method switched on with no link is named and refused — the same failure
     the sheet send already refuses, because a silently missing payment option
     is one nobody goes looking for.

     Planted directly, because the configuration route REFUSES to save an
     enabled method with no link — which is correct, and is why rows like this
     can only be legacy ones written before that rule existed. */
  await env.DB.prepare(
    `UPDATE payment_methods SET url = '' WHERE method = 'venmo'`).run();
  const broken = await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
    body: { to: 'client@example.com', methods: ['venmo'] } });
  ok('a method with no link is refused here too', broken.status === 400);
  ok('and the refusal points at Settings, where it can be fixed',
     has((await jsonOf(broken)).error, 'Add a link in Settings'));

  // §15.7 — the retainer this client agreed, not the standard one.
  await call(env, '/payment-methods/venmo', { method: 'POST', cookie: admin,
    body: { enabled: true, display_name: 'Venmo', handle: '@AlwaysPrecise',
            url: 'https://venmo.com/u/AlwaysPrecise' } });
  await call(env, '/cases/API-PO1/retainer', { method: 'POST', cookie: admin,
    body: { retainer_amount: 3000 } });
  lastBody = null;
  await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
    body: { to: 'client@example.com', case_no: 'API-PO1' } });
  ok('the standalone email quotes the retainer THIS case agreed',
     has(both(lastBody), '$3,000') && !has(both(lastBody), '$1,500'),
     both(lastBody).slice(0, 200));

  // Admin-only, like every other money route.
  const link = (await jsonOf(await invite(env, admin,
    { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const tok = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tok}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  ok('an investigator cannot send payment instructions',
     (await call(env, '/payment-options/email', { method: 'POST', cookie: inv,
       body: { to: 'client@example.com' } })).status === 403);
  ok('and a bad address is refused before an email is spent',
     (await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
       body: { to: 'not-an-address' } })).status === 400);

  globalThis.fetch = realFetch;
}

/* PRE-CASE SENDS — the owner's requirement 7, in full (2026-08-15).

   "These must work with NO case number: Private Intake, Private Rate Sheet,
   Private Payment Options, Insurance Intake / Assignment form, Insurance Rate
   Sheet." Each of the five is driven twice, once with no case number and once
   with an existing valid one, because the defect was that the second worked and
   the first did not.

   Requirement 3 rides along and is asserted rather than assumed: nothing may be
   auto-created to have something to send against. */
section('Every send works before a case exists, and still works after one does');
{
  const realFetch = globalThis.fetch;
  let lastBody = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      lastBody = JSON.parse(init.body);
      return new Response('{"id":"re_1"}', { status: 200 });
    }
    return realFetch(url, init);
  };
  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  env.MAIL_PER_MINUTE = '80';
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const both = s => `${s.html}\n${s.text}`;
  const has = (hay, needle) => String(hay).toLowerCase().includes(String(needle).toLowerCase());

  await ingest(env, { case_no: 'API-PC-P', service: 'Surveillance',
                      client_name: 'P. Client', subject_name: 'S' });
  await ingest(env, { case_no: 'API-PC-C', carrier: 'Acme Mutual', claim_number: 'AM-7',
                      client_name: 'A. Adjuster', subject_name: 'C' });

  const countSubs = async () => (await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM submissions').first()).n;
  const before = await countSubs();

  /* The five sends, each as {label, no-case body, with-case body}. Driven
     through the same routes the page uses. */
  const cases = [
    ['Private Intake', () => call(env, '/intake-link/email', { method: 'POST', cookie: admin,
        body: { to: 'jane@example.com', name: 'Jane', kind: 'private' } }),
      () => call(env, '/leads/API-PC-P/send-intake', { method: 'POST', cookie: admin,
        body: { to: 'jane@example.com' } })],
    ['Insurance Intake', () => call(env, '/intake-link/email', { method: 'POST', cookie: admin,
        body: { to: 'adjuster@carrier.example', name: 'Dana', kind: 'insurance' } }),
      () => call(env, '/leads/API-PC-C/send-intake', { method: 'POST', cookie: admin,
        body: { to: 'adjuster@carrier.example' } })],
    ['Private Rate Sheet', () => call(env, '/sheets/private_retainer/email', { method: 'POST',
        cookie: admin, body: { to: 'jane@example.com' } }),
      () => call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
        body: { to: 'jane@example.com', case_no: 'API-PC-P' } })],
    ['Insurance Rate Sheet', () => call(env, '/sheets/insurance_assignment/email', { method: 'POST',
        cookie: admin, body: { to: 'adjuster@carrier.example' } }),
      () => call(env, '/sheets/insurance_assignment/email', { method: 'POST', cookie: admin,
        body: { to: 'adjuster@carrier.example', case_no: 'API-PC-C' } })],
    ['Private Payment Options', () => call(env, '/payment-options/email', { method: 'POST',
        cookie: admin, body: { to: 'jane@example.com', name: 'Jane' } }),
      () => call(env, '/payment-options/email', { method: 'POST', cookie: admin,
        body: { to: 'jane@example.com', case_no: 'API-PC-P' } })],
  ];

  for (const [label, noCase, withCase] of cases) {
    lastBody = null;
    const a = await noCase();
    ok(`${label} sends with NO case number`, a.status === 200, String(a.status));
    ok(`${label} really went without one`, lastBody !== null);
    lastBody = null;
    const b = await withCase();
    ok(`${label} still sends with an existing case number`, b.status === 200, String(b.status));
    ok(`${label} really went with one`, lastBody !== null);
  }

  // Requirement 3 — nothing was conjured to make any of that possible.
  ok('and NOTHING was auto-created to have something to send against',
     (await countSubs()) === before, `${before} -> ${await countSubs()}`);

  /* THE SEND CONTEXT IS THE BOUNDARY (owner refactor, 2026-08-15). Each send
     reports the context the SERVER derived from what was being sent, and an
     INSURANCE context can never carry a payment method — whoever the recipient
     is, whatever reference was typed, case or no case. */
  const ctxOf = async (path, body) =>
    (await jsonOf(await call(env, path, { method: 'POST', cookie: admin, body }))).send_context;
  ok('the private sheet reports a private context',
     await ctxOf('/sheets/private_retainer/email', { to: 'a@b.co' }) === 'private');
  ok('the insurance sheet reports an insurance context',
     await ctxOf('/sheets/insurance_assignment/email', { to: 'a@b.co' }) === 'insurance');
  ok('the private intake link reports a private context',
     await ctxOf('/intake-link/email', { to: 'a@b.co', kind: 'private' }) === 'private');
  ok('the insurance intake link reports an insurance context',
     await ctxOf('/intake-link/email', { to: 'a@b.co', kind: 'insurance' }) === 'insurance');
  ok('and the payment route is private by construction',
     await ctxOf('/payment-options/email', { to: 'a@b.co' }) === 'private');

  /* EVERY CLIENT-FACING SEND REPORTS A CONTEXT (Codex stop-time review,
     2026-08-15 — "the context refactor leaves an existing send route outside
     its claimed invariant").

     `sendLeadIntake` was that route. It paired the intake with a bare ternary
     — `kind === 'claims' ? insurance : private` — so anything it did not
     recognise defaulted into PRIVATE, the side that carries payment methods.
     `submissions.kind` is CHECK-constrained so nothing could reach it today,
     but a guard whose safety lives in a constraint somewhere else is one
     widening away from being wrong.

     Asserted for all four routes at once, so a fifth added later has to declare
     itself rather than quietly sitting outside the invariant. */
  const leadCtx = await jsonOf(await call(env, '/leads/API-PC-P/send-intake',
    { method: 'POST', cookie: admin, body: { to: 'jane@example.com' } }));
  ok('the lead intake send reports a context, and it is the lead\'s own',
     leadCtx.send_context === 'private', JSON.stringify(leadCtx.send_context));
  const leadCtxC = await jsonOf(await call(env, '/leads/API-PC-C/send-intake',
    { method: 'POST', cookie: admin, body: { to: 'adjuster@carrier.example' } }));
  ok('and a claims lead reports the insurance context',
     leadCtxC.send_context === 'insurance', JSON.stringify(leadCtxC.send_context));
  /* FAILING CLOSED on an unrecognised kind is a STRUCTURAL property, because
     the state cannot be reached behaviourally: `submissions.kind` is
     CHECK-constrained and the database refuses to hold anything else. Trying to
     plant one returns `CHECK constraint failed: kind IN ('consumer','claims')`.

     That is exactly why the old ternary was dangerous rather than harmless —
     its safety lived in a constraint in another file, and it would have started
     defaulting to PRIVATE the day that constraint was widened. So the shape is
     asserted instead: no intake pairing may be written as a ternary on `kind`,
     which is the form that must pick a side for anything it does not know. The
     same reasoning already produced the read-then-write guard on the retainer
     route and the one-clock-read guard in the page. */
  {
    const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
    const pairing = /SHEET_INTAKE\[[^\]]*\?[^\]]*:[^\]]*\]/;
    ok('no intake is paired by a ternary that must guess a side',
       !pairing.test(src), (src.match(pairing) || [''])[0]);
    ok('the context-to-intake mapping is a declared table',
       src.includes('const CONTEXT_SHEET = {') && src.includes('intakeForContext'));
    // Two call sites — the lead-card send and the pre-case send. The definition
    // is `intakeForContext = ctx =>`, so it does not match this pattern.
    ok('and both intake senders derive it from the context',
       (src.match(/intakeForContext\(/g) || []).length === 2,
       String((src.match(/intakeForContext\(/g) || []).length));
    /* Codex design review, 2026-08-15: every caller gated on the context before
       reaching `paymentOptionsFor`, so nothing could get through — but the
       safety lived in call-site convention rather than in the function handing
       out the payment methods. A fifth caller would have inherited nothing and
       would have looked correct. The gate is in the function too now, and it
       fails closed on the `null` an omitted argument supplies. */
    ok('paymentOptionsFor refuses on its own, not only at its call sites',
       /async function paymentOptionsFor[\s\S]{0,1400}?CONTEXT_TAKES_PAYMENT\(context\)/.test(src));
    ok('and every call passes a context in',
       (src.match(/paymentOptionsFor\(env, wantedMethods, brokenMethods\)/g) || []).length === 0);
  }

  /* Payment never leaks into an insurance context, tried five ways: to a
     private client's address, to a carrier's, with no case, with a private
     case, and with a claims case. The recipient is varied deliberately, because
     under the old design the recipient was what decided this. */
  for (const [nick, body] of [
    ['no case', { to: 'jane@example.com', include_payment: true }],
    ['a private recipient', { to: 'jane@example.com', include_payment: true, case_no: 'API-PC-P' }],
    ['a carrier recipient', { to: 'adjuster@carrier.example', include_payment: true }],
    ['a claims case', { to: 'adjuster@carrier.example', include_payment: true, case_no: 'API-PC-C' }],
    ['every method named', { to: 'jane@example.com', include_payment: true,
                             methods: ['cash_app', 'venmo'] }],
  ]) {
    lastBody = null;
    const r = await call(env, '/sheets/insurance_assignment/email',
      { method: 'POST', cookie: admin, body });
    ok(`the insurance sheet refuses payment options — ${nick}`, r.status === 400,
       `${nick}: ${r.status}`);
    ok(`and nothing was emailed at all — ${nick}`, lastBody === null);
  }
  /* The insurance sheet sent normally carries no trace of either method, which
     is the positive control: the refusals above could pass on a route that had
     stopped sending entirely. */
  lastBody = null;
  await call(env, '/sheets/insurance_assignment/email', { method: 'POST', cookie: admin,
    body: { to: 'adjuster@carrier.example', case_no: 'API-PC-C', include_intake: true } });
  const carrierMail = both(lastBody).toLowerCase();
  ok('an insurance send still goes, and names no payment method',
     lastBody !== null && !carrierMail.includes('cash app') && !carrierMail.includes('venmo')
     && !carrierMail.includes('payment options'));

  /* Requirement 8 — the two workflows stay separated with no case in sight,
     which is where a lookup-based rule would have had nothing to go on. */
  lastBody = null;
  await call(env, '/intake-link/email', { method: 'POST', cookie: admin,
    body: { to: 'jane@example.com', name: 'Jane', kind: 'private' } });
  ok('a pre-case private intake sends the PRIVATE door',
     has(both(lastBody), 'assignment=private') && !has(both(lastBody), 'assignment=insurance'));
  lastBody = null;
  await call(env, '/intake-link/email', { method: 'POST', cookie: admin,
    body: { to: 'adjuster@carrier.example', name: 'Dana', kind: 'insurance' } });
  ok('a pre-case insurance intake sends the CARRIER door',
     has(both(lastBody), 'assignment=insurance') && !has(both(lastBody), 'assignment=private'));
  ok('and names no consumer payment method anywhere on it',
     !has(both(lastBody), 'cash app') && !has(both(lastBody), 'venmo'));
  ok('a pre-case intake with no kind is refused rather than guessed',
     (await call(env, '/intake-link/email', { method: 'POST', cookie: admin,
       body: { to: 'someone@example.com', name: 'Sam' } })).status === 400);
  ok('and a bad address is refused before an email is spent',
     (await call(env, '/intake-link/email', { method: 'POST', cookie: admin,
       body: { to: 'nope', kind: 'private' } })).status === 400);
  ok('an investigator cannot send an intake link either',
     (await (async () => {
       const link = (await jsonOf(await invite(env, admin,
         { username: 'dana2', display_name: 'Dana', role: 'investigator' }))).url;
       const tk = new URL(link, 'https://x.test').searchParams.get('invite');
       await call(env, `/invite/${tk}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
       const c = (await login(env, 'dana2', 'FieldWork2026x')).cookie;
       return call(env, '/intake-link/email', { method: 'POST', cookie: c,
         body: { to: 'a@b.co', kind: 'private' } });
     })()).status === 403);

  /* Requirement 6 — the history works without a case number. This is the half
     that was silently missing: pre-case rows were being written correctly and
     every view of them hung off a case, so they could never be seen. */
  const hist = await jsonOf(await call(env, '/sends', { cookie: admin }));
  ok('the send history returns rows', (hist.sends || []).length > 0);
  const caseless = hist.sends.filter(s => s.case_no === null);
  ok('including sends that have no case number at all', caseless.length > 0,
     String(caseless.length));
  ok('each carries who it went to, what it was, and when',
     caseless.every(s => s.recipient && s.kind && s.at));
  ok('and whether it actually sent', caseless.every(s => typeof s.ok === 'boolean'));
  ok('case-linked sends are still in there beside them',
     hist.sends.some(s => s.case_no === 'API-PC-P'));
  ok('a standalone payment send is distinguishable from a sheet',
     hist.sends.some(s => s.kind === 'payment_options'));
  /* A payment that rode WITH a sheet is not listed twice — the client received
     ONE email, and a history reporting two would have the office believing it
     sent something it did not. Counted before and after the same send. */
  const payRows = h => h.sends.filter(s => s.kind === 'payment_options'
    && s.recipient === 'jane@example.com').length;
  const payBefore = payRows(hist);
  await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
    body: { to: 'jane@example.com', include_payment: true } });
  const hist2 = await jsonOf(await call(env, '/sends', { cookie: admin }));
  ok('a payment that rode with a sheet adds no second payment row',
     payRows(hist2) === payBefore, `${payBefore} -> ${payRows(hist2)}`);
  ok('but the sheet it rode with IS on the history',
     hist2.sends.some(s => s.kind === 'rate_sheet' && s.recipient === 'jane@example.com'));
  ok('an investigator cannot read the send history',
     (await (async () => {
       const c = (await login(env, 'dana2', 'FieldWork2026x')).cookie;
       return call(env, '/sends', { cookie: c });
     })()).status === 403);

  /* A FREE-TEXT REFERENCE IS NOT A CASE NUMBER.

     `case_no` on the sheet send is optional and unvalidated — it is whatever
     the office wrote down, and it reaches the SUBJECT LINE. It was also being
     written straight into `send_log.case_no`, which means something else
     entirely: the schema says "null when a sheet is sent with no case", and
     every case-scoped read matches on it. So the reference sat in the log
     waiting for a real case of the same name to appear and adopt it.

     These assert the split. Nothing about what is SENT changes. */
  const logFor = async recipient => env.DB.prepare(
    'SELECT case_no, ok FROM send_log WHERE recipient = ? ORDER BY id DESC').bind(recipient).first();

  lastBody = null;
  const refSend = await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
    body: { to: 'notepad@example.com', case_no: 'PAPER-REF-9', include_intake: true } });
  ok('a sheet still sends against a reference that matches no case', refSend.status === 200,
     String(refSend.status));
  ok('and the reference still reaches the subject line, unchanged',
     lastBody && lastBody.subject.includes('PAPER-REF-9'), lastBody && lastBody.subject);
  ok('but the log keeps it OUT of the case column',
     (await logFor('notepad@example.com')).case_no === null,
     String((await logFor('notepad@example.com')).case_no));

  /* The other half: an explicitly linked, existing case is still recorded, or
     this would have fixed the bug by throwing the real history away. */
  await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
    body: { to: 'linked@example.com', case_no: 'API-PC-P' } });
  ok('a sheet sent against a case that DOES exist still records it',
     (await logFor('linked@example.com')).case_no === 'API-PC-P',
     String((await logFor('linked@example.com')).case_no));

  /* THE REGRESSION ITSELF. Quote a reference before any case exists, then let
     an unrelated client's intake create a case of that very name. The case
     list counts sends by matching `send_log.case_no`, so the earlier send used
     to appear as this client's — a send they never received. */
  await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
    body: { to: 'early.caller@example.com', name: 'Early Caller', case_no: 'RECYCLED-9' } });
  await ingest(env, { case_no: 'RECYCLED-9', service: 'Surveillance',
                      client_name: 'Someone Else', subject_name: 'S' });
  const recycled = ((await jsonOf(await call(env, '/submissions?limit=200', { cookie: admin })))
    .submissions || []).find(r => r.case_no === 'RECYCLED-9');
  ok('a later case reusing that reference exists', Boolean(recycled));
  ok('and is credited with NO send it never received',
     recycled && Number(recycled.send_count) === 0, recycled && String(recycled.send_count));
  ok('and carries no last-sent date from it either',
     recycled && !recycled.last_sent_at, recycled && String(recycled.last_sent_at));

  /* A REFUSED send is logged too, and by the same rule — the failure path had
     its own copy of the write, which is exactly how one of a pair gets fixed. */
  const okFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).includes('api.resend.com')
    ? new Response('{"message":"refused"}', { status: 422 })
    : realFetch(url, init);
  const failed = await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
    body: { to: 'bounced@example.com', case_no: 'PAPER-REF-FAIL' } });
  globalThis.fetch = okFetch;
  ok('a send the provider refused is reported as a failure', failed.status === 502,
     String(failed.status));
  const failRow = await logFor('bounced@example.com');
  ok('it is still recorded as an attempt', failRow && Number(failRow.ok) === 0);
  ok('and it keeps the reference out of the case column as well',
     failRow && failRow.case_no === null, failRow && String(failRow.case_no));

  /* And the office can still SEE both, which is the point of keeping the row:
     a caseless send is present in the history, it is simply not a case's. */
  const refHist = await jsonOf(await call(env, '/sends?limit=200', { cookie: admin }));
  ok('the reference send is in the history, marked as having no case',
     (refHist.sends || []).some(s => s.recipient === 'notepad@example.com' && s.case_no === null));
  ok('and the failed one is there too',
     (refHist.sends || []).some(s => s.recipient === 'bounced@example.com' && s.ok === false));

  /* THE SAME SPLIT FOR `payment_send`. Its column carries the same contract —
     "null when sent with no case or lead" — and the table has an index on
     (case_no, id DESC), which exists for a case-scoped read. Nothing reads it
     that way today, so unlike `send_log` this was misattributing nothing yet.
     It is the same shape that would, the moment such a read is added.

     Four writes, not one: the standalone route and the copy that rides with a
     rate sheet, each with a success and a failure path. */
  const payFor = async recipient => env.DB.prepare(
    'SELECT case_no, with_sheet, ok FROM payment_send WHERE recipient = ? ORDER BY id DESC')
    .bind(recipient).first();

  lastBody = null;
  const payRef = await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
    body: { to: 'pay.notepad@example.com', name: 'Notepad', case_no: 'PAPER-REF-P1' } });
  ok('payment instructions still send against a reference that matches no case',
     payRef.status === 200, String(payRef.status));
  ok('and the reference still reaches that subject line, unchanged',
     lastBody && lastBody.subject.includes('PAPER-REF-P1'), lastBody && lastBody.subject);
  ok('but payment_send keeps it OUT of the case column',
     (await payFor('pay.notepad@example.com')).case_no === null,
     String((await payFor('pay.notepad@example.com')).case_no));

  await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
    body: { to: 'pay.linked@example.com', case_no: 'API-PC-P' } });
  ok('payment instructions against a case that DOES exist still record it',
     (await payFor('pay.linked@example.com')).case_no === 'API-PC-P',
     String((await payFor('pay.linked@example.com')).case_no));

  /* The copy that rides WITH a rate sheet is a separate write with its own
     `with_sheet` flag — the pair that has to move together, and the kind where
     one gets fixed and the other is forgotten. */
  await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
    body: { to: 'rode.ref@example.com', case_no: 'PAPER-REF-P2', include_payment: true } });
  const rode = await payFor('rode.ref@example.com');
  ok('a payment riding with a sheet is still recorded as such',
     rode && Number(rode.with_sheet) === 1, rode && String(rode.with_sheet));
  ok('and it keeps the reference out of the case column too',
     rode && rode.case_no === null, rode && String(rode.case_no));

  await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
    body: { to: 'rode.linked@example.com', case_no: 'API-PC-P', include_payment: true } });
  ok('one riding with a sheet on a real case still records that case',
     (await payFor('rode.linked@example.com')).case_no === 'API-PC-P',
     String((await payFor('rode.linked@example.com')).case_no));

  const okPayFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).includes('api.resend.com')
    ? new Response('{"message":"refused"}', { status: 422 })
    : realFetch(url, init);
  const payFail = await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
    body: { to: 'pay.bounced@example.com', case_no: 'PAPER-REF-P3' } });
  globalThis.fetch = okPayFetch;
  ok('a refused payment send is reported as a failure', payFail.status === 502,
     String(payFail.status));
  const payFailRow = await payFor('pay.bounced@example.com');
  ok('it is still recorded as an attempt', payFailRow && Number(payFailRow.ok) === 0);
  ok('and it too keeps the reference out of the case column',
     payFailRow && payFailRow.case_no === null, payFailRow && String(payFailRow.case_no));

  /* And still visible to the office — simply not as a case's. */
  const payHist = await jsonOf(await call(env, '/sends?limit=200', { cookie: admin }));
  ok('the caseless payment send is in the history, marked as having no case',
     (payHist.sends || []).some(s => s.kind === 'payment_options'
       && s.recipient === 'pay.notepad@example.com' && s.case_no === null));

  globalThis.fetch = realFetch;
}

/* THE CUSTOM PRIVATE RETAINER (PAYMENTS.md, owner 2026-08-15, parts 1 and 2).
   The owner named seven tests; each is labelled below with the words they used.
   Two more guard the selector itself, because a control that WRITES the agreed
   figure can break things a control that merely reads it could not. */
section('The retainer a private case agreed is the retainer it keeps');
{
  const realFetch = globalThis.fetch;
  let lastBody = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      lastBody = JSON.parse(init.body);
      return new Response('{"id":"re_1"}', { status: 200 });
    }
    return realFetch(url, init);
  };
  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  env.MAIL_PER_MINUTE = '50';
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const both = s => `${s.html}\n${s.text}`;

  await ingest(env, { case_no: 'API-SEL1', service: 'Surveillance',
                      client_name: 'P. Client', subject_name: 'S' });
  await ingest(env, { case_no: 'API-SELC', carrier: 'Acme Mutual', claim_number: 'AM-9',
                      client_name: 'A. Adjuster', subject_name: 'C' });

  const agreedOf = async caseNo => (await jsonOf(await call(env,
    `/cases/${caseNo}/workspace`, { cookie: admin }))).authorization.retainer;
  const setRetainer = (caseNo, body) => call(env, `/cases/${caseNo}/retainer`,
    { method: 'POST', cookie: admin, body });

  /* OWNER TEST 1 — "each preset works". Driven through the same route the
     selector posts to, one preset at a time, reading the stored figure back
     rather than trusting the 200. */
  for (const preset of [1500, 2000, 3000]) {
    await setRetainer('API-SEL1', { retainer_amount: preset });
    const r = (await agreedOf('API-SEL1')).agreed;
    ok(`the $${preset.toLocaleString()} preset is stored and read back`, r === preset, String(r));
  }

  /* OWNER TEST 2 — "custom amount works", using the owner's own worked example
     of $2,500, which is deliberately NOT one of the presets. */
  await setRetainer('API-SEL1', { retainer_amount: 2500 });
  ok('a custom $2,500 is stored exactly, not rounded to a preset',
     (await agreedOf('API-SEL1')).agreed === 2500);

  /* The selector opens on what the case already agreed, so the figure has to
     come back as a NUMBER. Parsing it out of the sheet name would preselect the
     wrong preset the day someone rewords the name. */
  const sheetsFor = await jsonOf(await call(env, '/sheets?case=API-SEL1', { cookie: admin }));
  ok('the sheets payload carries the resolved retainer as a number',
     sheetsFor.retainer === 2500, JSON.stringify(sheetsFor.retainer));
  ok('and a case with nothing agreed resolves to the standard figure',
     (await jsonOf(await call(env, '/sheets?case=API-SELC', { cookie: admin }))).retainer === 1500);

  /* OWNER TEST 3 — "rate sheet displays the selected amount". The document the
     CLIENT receives, not the preview: both MIME parts of the real email. */
  await setRetainer('API-SEL1', { retainer_amount: 3000 });
  lastBody = null;
  const sent = await jsonOf(await call(env, '/sheets/private_retainer/email',
    { method: 'POST', cookie: admin,
      body: { to: 'client@example.com', case_no: 'API-SEL1' } }));
  ok('the emailed sheet states the agreed $3,000, in both parts',
     both(lastBody).includes('$3,000'), 'no $3,000 in the sent body');
  ok('and never the standard $1,500 the case did not agree',
     !both(lastBody).includes('$1,500'));
  ok('the subject line carries it too',
     lastBody.subject.includes('$3,000') && !lastBody.subject.includes('$1,500'),
     lastBody.subject);
  ok('and the confirmation names the sheet that actually went',
     sent.included.rate_sheet === '$3,000 Retainer', sent.included.rate_sheet);

  /* OWNER TEST 4 — "returned intake preserves the selected amount". The intake
     row is untouched by any of this, and the agreed figure survives a re-read
     and a second send rather than living only in the request that set it. */
  const sub = await jsonOf(await call(env, '/submissions', { cookie: admin }));
  const row = (sub.submissions || []).find(s => s.case_no === 'API-SEL1');
  ok('the original intake is still the intake it was', !!row && row.case_no === 'API-SEL1');
  ok('and the agreed retainer survives being read again',
     (await agreedOf('API-SEL1')).agreed === 3000);
  lastBody = null;
  await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
    body: { to: 'client@example.com', case_no: 'API-SEL1' } });
  ok('a second send carries the same agreed figure, not the default',
     both(lastBody).includes('$3,000') && !both(lastBody).includes('$1,500'));

  /* OWNER TEST 5 — "partial payments calculate correctly", against a CHOSEN
     retainer rather than the standard one. $3,000 agreed, $1,000 and $500 in. */
  await call(env, '/cases/API-SEL1/retainer/payment', { method: 'POST', cookie: admin,
    body: { amount: 1000, method: 'venmo', paid_on: '2026-08-10' } });
  const part = (await jsonOf(await call(env, '/cases/API-SEL1/retainer/payment',
    { method: 'POST', cookie: admin,
      body: { amount: 500, method: 'check', paid_on: '2026-08-12' } }))).authorization.retainer;
  ok('received totals both instalments against the agreed $3,000',
     part.agreed === 3000 && part.received_total === 1500, JSON.stringify(part.received_total));
  ok('and outstanding is the agreed figure minus what arrived',
     part.outstanding === 1500, String(part.outstanding));
  ok('part paid, not paid', part.status === 'part_paid', part.status);

  /* OWNER TEST 6 — "Record Payment never resets the agreed retainer". */
  ok('recording money leaves the agreed $3,000 exactly where it was',
     (await agreedOf('API-SEL1')).agreed === 3000);
  await setRetainer('API-SEL1', { received: true });
  ok('and ticking the received flag with no amount does not reset it either',
     (await agreedOf('API-SEL1')).agreed === 3000);

  await setRetainer('API-SEL1', { retainer_amount: 4000 });
  const after = await agreedOf('API-SEL1');
  ok('the new agreed figure is stored', after.agreed === 4000);
  ok('and every payment is still counted underneath it',
     after.received_total === 1500, String(after.received_total));

  /* THE MIRROR OF TEST 6, and the reason the Worker changed with this feature.
     `received` used to default to 0 whenever a caller did not send it, so the
     SELECTOR — which sends an amount and knows nothing about the money — would
     have un-received a retainer that had genuinely been paid. Raising what was
     agreed is not a statement that the money went away.

     Driven on a case with NO payments on purpose. On API-SEL1 the flag cannot
     be observed at all: `received` there is true because $1,500 has genuinely
     arrived, and once a case has payment history the money decides. A guard
     asserted over there would pass no matter what the flag did — the same
     vacuous shape this project has been caught by twice before. */
  await ingest(env, { case_no: 'API-SEL2', service: 'Surveillance',
                      client_name: 'Q. Client', subject_name: 'T' });
  await setRetainer('API-SEL2', { retainer_amount: 1500, received: true });
  const flagged = await agreedOf('API-SEL2');
  ok('a case with no payments reads as received purely on the flag',
     flagged.received === true && flagged.received_total === 0,
     JSON.stringify([flagged.received, flagged.received_total]));
  await setRetainer('API-SEL2', { retainer_amount: 3000 });
  const raised = await agreedOf('API-SEL2');
  ok('raising the agreed retainer does not un-receive it',
     raised.received === true, JSON.stringify(raised.received));
  ok('and the raise itself landed', raised.agreed === 3000);
  /* Unticking is still a real answer and still works — this is preservation of
     silence, not a freeze. Without this the guard above could be satisfied by a
     route that had simply stopped listening to the flag. */
  await setRetainer('API-SEL2', { received: false });
  ok('but explicitly unticking it still un-marks it',
     (await agreedOf('API-SEL2')).received === false);
  ok('and unticking left the agreed figure alone',
     (await agreedOf('API-SEL2')).agreed === 3000);

  /* A ZERO RETAINER IS REFUSED. `rateSheets()` falls back to the standard for
     anything not above zero, so a stored 0 would leave the case saying $0 while
     the client's sheet said $1,500 — the record and the document disagreeing in
     silence, which is the defect #123 fixed from the other end. */
  ok('a zero retainer is refused rather than stored',
     (await setRetainer('API-SEL1', { retainer_amount: 0 })).status === 400);
  ok('and so is a negative one',
     (await setRetainer('API-SEL1', { retainer_amount: -100 })).status === 400);
  ok('a retainer that is not a number is still refused',
     (await setRetainer('API-SEL1', { retainer_amount: 'lots' })).status === 400);
  ok('and none of those refusals changed the stored figure',
     (await agreedOf('API-SEL1')).agreed === 4000);

  /* OWNER TEST 7 — "Insurance never sees this selector." Enforced in the Worker,
     not by the page declining to draw it: a claim assignment is authorized in
     hour blocks and has no retainer at all. */
  ok('a claims case refuses a retainer amount outright',
     (await setRetainer('API-SELC', { retainer_amount: 3000 })).status === 400);
  ok('and still has no retainer record to show',
     (await jsonOf(await call(env, '/cases/API-SELC/workspace', { cookie: admin })))
       .authorization.retainer === undefined);
  const insSheet = (await jsonOf(await call(env, '/sheets?case=API-SEL1', { cookie: admin })))
    .sheets.find(s => s.id === 'insurance_assignment');
  ok('the insurance sheet names no retainer even beside a private case that has one',
     !JSON.stringify(insSheet).includes('Retainer')
     && !JSON.stringify(insSheet).includes('4,000'),
     JSON.stringify(insSheet).slice(0, 120));
  /* The carrier sheet cannot even be sent against that private case — the
     sheet/lead pairing guard refuses it — so the carrier boundary is checked
     where a carrier actually is, on the claims lead. Both halves matter: the
     refusal, and what the adjuster who legitimately gets a sheet is told. */
  ok('the carrier sheet cannot be sent against a private case at all',
     (await call(env, '/sheets/insurance_assignment/email', { method: 'POST', cookie: admin,
       body: { to: 'adjuster@example.com', case_no: 'API-SEL1' } })).status === 400);
  lastBody = null;
  await call(env, '/sheets/insurance_assignment/email', { method: 'POST', cookie: admin,
    body: { to: 'adjuster@example.com', case_no: 'API-SELC' } });
  ok('and the adjuster who does get a sheet is quoted no retainer of any kind',
     !both(lastBody).includes('$4,000') && !both(lastBody).toLowerCase().includes('retainer'),
     'retainer wording reached a carrier');

  /* The selector is admin-only, like every other money control. */
  const link = (await jsonOf(await invite(env, admin,
    { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const tok = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tok}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  ok('an investigator cannot set the agreed retainer',
     (await call(env, '/cases/API-SEL1/retainer', { method: 'POST', cookie: inv,
       body: { retainer_amount: 1 } })).status === 403);
  ok('and cannot read the sheets that would name it',
     (await call(env, '/sheets?case=API-SEL1', { cookie: inv })).status === 403);

  globalThis.fetch = realFetch;
}

/* ---- ITEM 4 (owner, 2026-08-19): "For an Admin who is assembling and
   delivering the case themselves, remove redundant approval barriers." The
   review flow exists for a HANDOFF; an admin's own report has none, so the
   whole chain — draft, build, finalize, PDF — runs with no approve call.
   And the boundary that still matters is pinned from both sides: an
   investigator's report waits for the office exactly as before. */
section('An admin\'s own report needs no approval ritual');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const tok = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tok}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const danaId = (await jsonOf(await call(env, '/users', { cookie: admin })))
    .users.find(u => u.username === 'dana').id;

  await ingest(env, { case_no: 'API-ADM1', service: 'Surveillance', client_name: 'C', subject_name: 'S' });

  // The admin works their own day and drafts their own report. No status calls.
  await call(env, '/cases/API-ADM1/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-14', start_time: '07:00' } });
  await call(env, '/cases/API-ADM1/activity', { method: 'POST', cookie: admin,
    body: { at_date: '2026-08-14', at_time: '09:12', kind: 'activity', description: 'Subject mowed the lawn.' } });
  await call(env, '/cases/API-ADM1/day/end', { method: 'POST', cookie: admin, body: { end_time: '15:00' } });
  const dayId = (await jsonOf(await call(env, '/cases/API-ADM1/workspace', { cookie: admin }))).days[0].id;
  const rep = await jsonOf(await call(env, '/cases/API-ADM1/reports/generate', { method: 'POST', cookie: admin,
    body: { day_id: dayId } }));

  // A case with NO reports says generate, not approve.
  await ingest(env, { case_no: 'API-ADM0', service: 'Surveillance', client_name: 'C0', subject_name: 'S0' });
  const bare = await jsonOf(await call(env, '/cases/API-ADM0/build', { method: 'POST', cookie: admin }));
  ok('with no reports at all the gate says to generate one, not approve one',
     bare.gates.some(g => g.includes('generate a daily report first')), JSON.stringify(bare.gates));

  let st = await jsonOf(await call(env, '/cases/API-ADM1/build', { method: 'POST', cookie: admin }));
  ok('opening a build seeds the admin\'s own draft without an approval step',
     st.reports.length === 1 && st.reports[0].status === 'draft', JSON.stringify(st.reports));
  ok('and no gate demands an approval for it',
     !st.gates.some(g => /approv/i.test(g)), JSON.stringify(st.gates));

  st = await jsonOf(await call(env, `/build/${st.build.id}/finalize`, { method: 'POST', cookie: admin }));
  ok('the package finalizes with no approve call anywhere in the chain',
     st.build && st.build.status === 'finalized', JSON.stringify(st.gates || st));

  /* THE FINALIZE IS THE SIGN-OFF, and it is recorded as one — the status
     column stays the single answer to "was this signed off". */
  const stamped = await env.DB.prepare('SELECT status, status_by FROM case_reports WHERE id = ?')
    .bind(rep.id).first();
  ok('finalize stamped the admin\'s draft approved', stamped.status === 'approved');
  ok('recorded against the finalizing admin, not nobody', stamped.status_by === 1);
  ok('and the build event names the sign-off',
     st.events.some(e => e.action === 'reports_approved' && /2026-08-14/.test(e.detail || '')),
     JSON.stringify(st.events.map(e => e.action)));

  /* ---- The other side of the line, on the same case shape ---- */
  await ingest(env, { case_no: 'API-INV1', service: 'Surveillance', client_name: 'C2', subject_name: 'S2' });
  await call(env, '/submissions/API-INV1/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });
  await call(env, '/cases/API-INV1/day/start', { method: 'POST', cookie: inv,
    body: { day_date: '2026-08-14', start_time: '08:00' } });
  await call(env, '/cases/API-INV1/activity', { method: 'POST', cookie: inv,
    body: { at_date: '2026-08-14', at_time: '10:00', kind: 'activity', description: 'Departure noted.' } });
  await call(env, '/cases/API-INV1/day/end', { method: 'POST', cookie: inv, body: { end_time: '12:00' } });
  const iday = (await jsonOf(await call(env, '/cases/API-INV1/workspace', { cookie: inv }))).days[0].id;
  const irep = await jsonOf(await call(env, '/cases/API-INV1/reports/generate', { method: 'POST', cookie: inv,
    body: { day_id: iday } }));

  let ist = await jsonOf(await call(env, '/cases/API-INV1/build', { method: 'POST', cookie: admin }));
  ok('an investigator\'s draft does NOT seed into a build',
     ist.reports.length === 0, JSON.stringify(ist.reports));
  ok('cannot be attached around the review',
     (await jsonOf(await call(env, `/build/${ist.build.id}/reports`, { method: 'POST', cookie: admin,
       body: { report_id: irep.id } }))).error.includes('approve it first'));
  const iblocked = await jsonOf(await call(env, `/build/${ist.build.id}/finalize`, { method: 'POST', cookie: admin }));
  ok('and finalize still refuses, naming the missing approval',
     iblocked.gates && iblocked.gates.some(g => /approved/.test(g)), JSON.stringify(iblocked.gates));
  ok('finalize did not quietly stamp the investigator\'s report',
     (await env.DB.prepare('SELECT status FROM case_reports WHERE id = ?').bind(irep.id).first())
       .status === 'draft');
  ok('the investigator still cannot approve their own report',
     (await call(env, `/cases/API-INV1/reports/${irep.id}/status`, { method: 'POST', cookie: inv,
       body: { status: 'approved' } })).status === 403);

  // The review done properly still works end to end.
  await call(env, `/cases/API-INV1/reports/${irep.id}/status`, { method: 'POST', cookie: inv,
    body: { status: 'submitted' } });
  await call(env, `/cases/API-INV1/reports/${irep.id}/status`, { method: 'POST', cookie: admin,
    body: { status: 'approved' } });
  ist = await jsonOf(await call(env, `/build/${ist.build.id}/finalize`, { method: 'POST', cookie: admin }));
  ok('reviewed and approved, the investigator\'s report finalizes as before',
     ist.build && ist.build.status === 'finalized');

  /* ---- Mixed: one case, one report from each side of the line ---- */
  await ingest(env, { case_no: 'API-MIX1', service: 'Surveillance', client_name: 'C3', subject_name: 'S3' });
  await call(env, '/submissions/API-MIX1/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });
  await call(env, '/cases/API-MIX1/day/start', { method: 'POST', cookie: inv,
    body: { day_date: '2026-08-15', start_time: '07:00' } });
  await call(env, '/cases/API-MIX1/day/end', { method: 'POST', cookie: inv, body: { end_time: '11:00' } });
  await call(env, '/cases/API-MIX1/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-16', start_time: '07:00' } });
  await call(env, '/cases/API-MIX1/day/end', { method: 'POST', cookie: admin, body: { end_time: '11:00' } });
  const mdays = (await jsonOf(await call(env, '/cases/API-MIX1/workspace', { cookie: admin }))).days;
  const dDay = mdays.find(d => d.day_date === '2026-08-15');
  const aDay = mdays.find(d => d.day_date === '2026-08-16');
  const dRep = await jsonOf(await call(env, '/cases/API-MIX1/reports/generate', { method: 'POST', cookie: admin,
    body: { day_id: dDay.id } }));
  await call(env, '/cases/API-MIX1/reports/generate', { method: 'POST', cookie: admin,
    body: { day_id: aDay.id } });

  const mst = await jsonOf(await call(env, '/cases/API-MIX1/build', { method: 'POST', cookie: admin }));
  ok('on a mixed case only the admin\'s own day seeds',
     mst.reports.length === 1 && mst.reports[0].report_date === '2026-08-16',
     JSON.stringify(mst.reports));
  ok('the investigator\'s draft gates nothing while it is not attached — but is not offered either',
     !(mst.available_reports || []).some(r => r.id === dRep.id));
  const mfin = await jsonOf(await call(env, `/build/${mst.build.id}/finalize`, { method: 'POST', cookie: admin }));
  ok('the mixed case finalizes on the admin\'s day alone', mfin.build.status === 'finalized');
  ok('and the investigator\'s untouched draft is still a draft',
     (await env.DB.prepare('SELECT status FROM case_reports WHERE id = ?').bind(dRep.id).first())
       .status === 'draft');
}

/* ---- UNIT 5: the dashboard's Recent Activity and the Dropbox flag ----
   The feed is EXISTING tables read cheaply and merged — no new storage, no
   media bytes, hidden cases excluded, admin only. */
section('Recent activity: existing data, cheaply, admin only');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const tok = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tok}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  ok('an investigator is refused the cross-case feed',
     (await call(env, '/recent-activity', { cookie: inv })).status === 403);
  ok('signed out it is 401',
     (await call(env, '/recent-activity', { cookie: '' })).status === 401);

  let feed = (await jsonOf(await call(env, '/recent-activity', { cookie: admin }))).activity;
  ok('an empty portal answers an empty feed, not an error', Array.isArray(feed) && feed.length === 0);

  await ingest(env, { case_no: 'API-RA1', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  await call(env, '/cases/API-RA1/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-18', start_time: '07:00' } });
  await call(env, '/cases/API-RA1/day/end', { method: 'POST', cookie: admin, body: { end_time: '11:00' } });

  feed = (await jsonOf(await call(env, '/recent-activity', { cookie: admin }))).activity;
  ok('the intake appears', feed.some(r => r.kind === 'intake' && r.case_no === 'API-RA1'));
  ok('the day appears, as ended', feed.some(r => r.kind === 'day' && /ended/.test(r.detail)));
  ok('newest first', feed.length >= 2
     && feed.every((r, i) => i === 0 || feed[i - 1].at >= r.at), JSON.stringify(feed.slice(0, 3)));
  ok('rows carry when, what and which case, and nothing else heavy',
     feed.every(r => r.at && r.kind && r.case_no && typeof r.detail === 'string'
       && !('body' in r) && !('payload' in r)));

  /* Hidden means hidden: an archived case's history leaves the feed with it. */
  await call(env, '/cases/API-RA1/archive', { method: 'POST', cookie: admin, body: {} });
  feed = (await jsonOf(await call(env, '/recent-activity', { cookie: admin }))).activity;
  ok('an archived case leaves the feed', !feed.some(r => r.case_no === 'API-RA1'),
     JSON.stringify(feed.slice(0, 3)));

  /* The Dropbox flag on /summary: admin sees it, investigator does not.
     freshEnv is CONNECTED by default (the owner's default state), so the
     disconnected reading is manufactured by removing the token. */
  delete env.DROPBOX_REFRESH_TOKEN;
  let sum = (await jsonOf(await call(env, '/summary', { cookie: admin }))).summary;
  ok('the admin summary says whether the file store is alive',
     sum.dropbox_configured === true && sum.dropbox_ok === false,
     JSON.stringify({ok: sum.dropbox_ok, cfg: sum.dropbox_configured}));
  env.DROPBOX_REFRESH_TOKEN = 'rt';
  sum = (await jsonOf(await call(env, '/summary', { cookie: admin }))).summary;
  ok('and connected reads as connected', sum.dropbox_ok === true);
  const isum = (await jsonOf(await call(env, '/summary', { cookie: inv }))).summary;
  ok('an investigator\'s summary carries no firm-wide storage flag',
     isum.dropbox_ok === undefined && isum.dropbox_configured === undefined);
}

/* ---- UNIT 6: LEGAL / LAW FIRM intake (LEGAL-INTAKE.md) ----
   The two rules everything else hangs off: a legal case IS kind='consumer'
   (D1 — pricing is structural, not synchronised), and Cash App / Venmo reach
   a law firm through NO code path (D2 — a third send context, not a filter). */
section('Legal intake: private pricing structurally, private payments never');
{
  /* Stand in for the mail provider, the invitation section's pattern — sends
     must leave nothing and be assertable. */
  const realFetch = globalThis.fetch;
  let mailTo = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      mailTo.push(JSON.parse(init.body).to);
      return new Response('{"id":"re_ok"}', { status: 200 });
    }
    return realFetch(url, init);
  };
  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const tok = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tok}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  // ---- the public legal ingest ----
  const r = await ingest(env, { case_no: 'API-LGL1', assignment: 'legal',
    service: 'Legal investigation assignment',
    firm_name: 'Harmon & Boyle PLC', firm_phone: '540-555-0101',
    attorney_name: 'R. Harmon', attorney_email: 'rharmon@example.com',
    paralegal_name: 'T. Boyd', paralegal_email: 'tboyd@example.com',
    billing_name: 'Accounts', billing_reference: 'HB-2211',
    matter_number: 'M-88', court_case_number: 'CL26-991',
    court_jurisdiction: 'Roanoke County Circuit Court',
    assignment_type: 'Witness locate / interview',
    client_name: 'Client LLC', subject_name: 'Opposing Party',
    deadline: '2026-09-10', hearing_date: '2026-09-22',
    payment_arrangement: 'check_pickup',
    objective: 'Locate and interview the listed witness.' });
  ok('a legal assignment ingests', r.status === 200 || r.status === 201, String(r.status));

  const sub = await env.DB.prepare('SELECT kind, payload FROM submissions WHERE case_no = ?')
    .bind('API-LGL1').first();
  ok('stored kind=consumer — the pricing path IS the private one (D1)',
     sub.kind === 'consumer');
  ok('marked legal on its own row', JSON.parse(sub.payload).assignment === 'legal');
  const row = await env.DB.prepare('SELECT * FROM legal_intake WHERE case_no = ?')
    .bind('API-LGL1').first();
  ok('the structured firm row is written', row && row.firm_name === 'Harmon & Boyle PLC');
  ok('with the matter, the court and the arrangement',
     row.matter_number === 'M-88' && row.court_jurisdiction === 'Roanoke County Circuit Court'
     && row.payment_arrangement === 'check_pickup');
  ok('a legal payload that also names a carrier still files as LEGAL, never a claim',
     (await (async () => { await ingest(env, { case_no: 'API-LGL2', assignment: 'legal',
        carrier: 'Should Not Matter', firm_name: 'Second Firm', attorney_name: 'A',
        client_name: 'C2', objective: 'x' });
        return (await env.DB.prepare("SELECT kind FROM submissions WHERE case_no = 'API-LGL2'").first()).kind;
     })()) === 'consumer');

  // ---- the private pricing source, structurally ----
  await call(env, '/cases/API-LGL1/retainer', { method: 'POST', cookie: admin,
    body: { retainer_amount: 2000 } });
  ok('the private retainer routes accept a legal case unchanged',
     Number((await env.DB.prepare("SELECT retainer_amount FROM case_retainer WHERE case_no = 'API-LGL1'")
       .first()).retainer_amount) === 2000);
  const ws = await jsonOf(await call(env, '/cases/API-LGL1/workspace', { cookie: admin }));
  ok('the workspace carries the legal panel for an admin',
     ws.legal && ws.legal.firm_name === 'Harmon & Boyle PLC' && ws.legal.source === 'table',
     JSON.stringify(ws.legal || null).slice(0, 200));

  /* ---- the investigator boundary: the firm is who is PAYING ---- */
  await call(env, '/submissions/API-LGL1/assign', { method: 'POST', cookie: admin,
    body: { user_id: (await jsonOf(await call(env, '/users', { cookie: admin })))
      .users.find(u => u.username === 'dana').id } });
  const iws = await jsonOf(await call(env, '/cases/API-LGL1/workspace', { cookie: inv }));
  ok('an investigator gets no legal panel at all', iws.legal === undefined || iws.legal === null);
  const itext = JSON.stringify(iws);
  const isub = JSON.stringify(await jsonOf(await call(env, '/submissions/API-LGL1', { cookie: inv })));
  ok('and no firm, attorney, paralegal, billing or matter identity reaches them anywhere',
     [itext, isub].every(t => !t.includes('Harmon') && !t.includes('rharmon') && !t.includes('T. Boyd')
       && !t.includes('HB-2211') && !t.includes('M-88')), isub.slice(0, 240));
  ok('while the subject still reaches the field', isub.includes('Opposing Party'), isub.slice(0, 240));

  // ---- sends: the sheet is the private product; the payment block never rides ----
  const sheets = (await jsonOf(await call(env, '/sheets', { cookie: admin }))).sheets;
  const priv = sheets.find(x => x.id === 'private_retainer');
  ok('the sheet catalogue is unchanged — no third pricing product',
     sheets.length === 2 && priv && sheets.some(x => x.id === 'insurance_assignment'));

  const sent = await jsonOf(await call(env, `/sheets/private_retainer/email`, { method: 'POST', cookie: admin,
    body: { to: 'tboyd@example.com', name: 'T. Boyd', case_no: 'API-LGL1' } }));
  ok('the private sheet sends to a legal case — same figures, one source',
     sent.ok === true, JSON.stringify(sent).slice(0, 200));
  ok('in the LEGAL send context, stated and observable',
     sent.send_context === 'legal', JSON.stringify(sent.send_context));

  const withPay = await call(env, `/sheets/private_retainer/email`, { method: 'POST', cookie: admin,
    body: { to: 'tboyd@example.com', name: 'T. Boyd', case_no: 'API-LGL1', include_payment: true } });
  ok('the payment block is refused on a legal case by name',
     withPay.status === 400 && (await jsonOf(withPay)).code === 'legal_no_payment_block');

  const payOpts = await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
    body: { to: 'tboyd@example.com', name: 'T. Boyd', case_no: 'API-LGL1' } });
  ok('standalone payment options are refused for a legal case, in words',
     payOpts.status === 400 && /legal assignment/.test((await jsonOf(payOpts)).error));
  ok('and nothing about any of that recorded a payment',
     (await env.DB.prepare("SELECT COUNT(*) AS n FROM retainer_payment WHERE case_no = 'API-LGL1'").first()).n === 0);

  // ---- the intake doors ----
  const leadIntake = await jsonOf(await call(env, '/leads/API-LGL1/send-intake', { method: 'POST', cookie: admin,
    body: { to: 'tboyd@example.com' } }));
  ok('a legal lead is sent the LEGAL door, never the private form',
     leadIntake.ok === true && leadIntake.send_context === 'legal'
     && /assignment=legal/.test((await env.DB.prepare(
          "SELECT door FROM send_log WHERE kind = 'intake' ORDER BY id DESC LIMIT 1").first()).door),
     JSON.stringify(leadIntake).slice(0, 240));
  const pre = await jsonOf(await call(env, '/intake-link/email', { method: 'POST', cookie: admin,
    body: { to: 'new@example.com', name: 'New Firm', kind: 'legal' } }));
  ok('the pre-case send offers legal as an explicit product',
     pre.ok === true && /assignment=legal/.test((await env.DB.prepare(
       "SELECT door FROM send_log WHERE kind = 'intake' AND case_no IS NULL ORDER BY id DESC LIMIT 1")
       .first()).door), JSON.stringify(pre).slice(0, 240));

  // ---- Quick Legal Assignment ----
  const q = await jsonOf(await call(env, '/intakes', { method: 'POST', cookie: admin,
    body: { kind: 'legal', firm_name: 'Calloway Law', attorney_name: 'M. Calloway',
            attorney_email: 'mc@example.com', client_name: 'Estate of Byrd',
            subject_name: 'J. Q. Adverse', assignment_type: 'Surveillance',
            deadline: '2026-09-01', payment_arrangement: 'check_pickup',
            notes: 'Attorney called — pick up papers and retainer at the office.' } }));
  ok('Quick Legal creates the intake', q.ok === true && q.legal === true, JSON.stringify(q));
  const qSub = await env.DB.prepare('SELECT kind, payload, client_name FROM submissions WHERE case_no = ?')
    .bind(q.case_no).first();
  ok('as consumer + legal marker, like the public door',
     qSub.kind === 'consumer' && JSON.parse(qSub.payload).assignment === 'legal');
  ok('the attorney is the reachable contact when no client contact was typed',
     qSub.client_name === 'Estate of Byrd'
     && JSON.parse(qSub.payload).client_email === 'mc@example.com');
  const qRow = await env.DB.prepare('SELECT * FROM legal_intake WHERE case_no = ?').bind(q.case_no).first();
  ok('with its structured row and the pickup arrangement — awaiting pickup, NOT paid',
     qRow && qRow.payment_arrangement === 'check_pickup');
  ok('and no payment recorded by any of it',
     (await env.DB.prepare('SELECT COUNT(*) AS n FROM retainer_payment WHERE case_no = ?').bind(q.case_no).first()).n === 0);
  ok('a bad arrangement is refused, in words',
     ((await call(env, '/intakes', { method: 'POST', cookie: admin,
       body: { kind: 'legal', firm_name: 'X', payment_arrangement: 'cash_app' } })).status) === 400);
  ok('an investigator cannot create one',
     (await call(env, '/intakes', { method: 'POST', cookie: inv,
       body: { kind: 'legal', firm_name: 'X' } })).status === 403);

  // ---- the editor: absent means unchanged, blank clears ----
  const e1 = await jsonOf(await call(env, '/cases/API-LGL1/legal', { method: 'POST', cookie: admin,
    body: { trial_date: '2026-11-02' } }));
  ok('posting one field changes one field',
     e1.legal.trial_date === '2026-11-02' && e1.legal.firm_name === 'Harmon & Boyle PLC'
     && e1.legal.payment_arrangement === 'check_pickup', JSON.stringify(e1.legal).slice(0, 200));
  const e2 = await jsonOf(await call(env, '/cases/API-LGL1/legal', { method: 'POST', cookie: admin,
    body: { paralegal_name: '' } }));
  ok('a blank clears; everything unmentioned holds',
     e2.legal.paralegal_name === null && e2.legal.trial_date === '2026-11-02');
  ok('an investigator cannot write the legal panel',
     (await call(env, '/cases/API-LGL1/legal', { method: 'POST', cookie: inv,
       body: { firm_name: 'X' } })).status === 403);
  ok('a private case is refused the legal panel by name',
     await (async () => { await ingest(env, { case_no: 'API-PRV9', client_name: 'P', objective: 'x' });
       return (await call(env, '/cases/API-PRV9/legal', { method: 'POST', cookie: admin,
         body: { firm_name: 'X' } })).status === 400; })());

  /* ---- Private and Insurance unchanged, asserted side by side ---- */
  await ingest(env, { case_no: 'API-CLM9', carrier: 'Acme Mutual', claim_number: 'C-1',
    client_name: 'Adjuster', objective: 'x' });
  ok('a claims ingest still files as claims',
     (await env.DB.prepare("SELECT kind FROM submissions WHERE case_no = 'API-CLM9'").first()).kind === 'claims');
  const privSend = await jsonOf(await call(env, `/sheets/private_retainer/email`, { method: 'POST', cookie: admin,
    body: { to: 'p@example.com', name: 'P', case_no: 'API-PRV9', include_payment: false } }));
  ok('a private case still takes the private sheet in the PRIVATE context',
     privSend.ok === true && privSend.send_context === 'private', JSON.stringify(privSend).slice(0, 200));
  ok('every send in this section really left through the stand-in', mailTo.length >= 4, String(mailTo.length));
  globalThis.fetch = realFetch;
}

section('The daily report builder');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana Field', role: 'investigator' }))).url;
  const token = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  await ingest(env, { case_no: 'API-R1', subject_name: 'Pat Coleman', client_name: 'Acme' });
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const dana = users.users.find(u => u.username === 'dana');
  await call(env, '/submissions/API-R1/assign', { method: 'POST', cookie: admin, body: { user_id: dana.id } });

  await call(env, '/cases/API-R1/day/start', { method: 'POST', cookie: inv,
    body: { day_date: '2026-08-12', start_time: '07:00' } });
  for (const [t, d, loc] of [
    ['07:03', 'Arrived in vicinity of subject residence.', ''],
    ['07:14', 'Subject vehicle observed parked at residence.', ''],
    ['08:17', 'Subject arrived at ABC Fitness', '1400 Main St'],
  ]) {
    await call(env, '/cases/API-R1/activity', { method: 'POST', cookie: inv,
      body: { at_date: '2026-08-12', at_time: t, description: d, location: loc } });
  }
  // The captured-at-this-moment flags travel into the chronology.
  await call(env, '/cases/API-R1/activity', { method: 'POST', cookie: inv,
    body: { at_date: '2026-08-12', at_time: '09:12', description: 'Subject mowing the front lawn.',
            subject_documented: true, video_acquired: true } });

  await call(env, '/cases/API-R1/day/end', { method: 'POST', cookie: inv,
    body: { end_time: '15:30', summary: 'Subject active throughout.' } });

  const gen = await call(env, '/cases/API-R1/reports/generate', { method: 'POST', cookie: inv,
    body: { day_id: (await jsonOf(await call(env, '/cases/API-R1/workspace', { cookie: inv }))).days[0].id } });
  ok('a draft generates from the day', gen.status === 201);
  const repId = (await jsonOf(gen)).id;

  let ws = await jsonOf(await call(env, '/cases/API-R1/workspace', { cookie: inv }));
  const body = ws.reports[0].body;
  ok('the draft starts as a draft', ws.reports[0].status === 'draft');
  ok('it is headed as a chronology', body.includes('SURVEILLANCE CHRONOLOGY'));
  ok('it states the surveillance window in 12-hour time',
     body.includes('from 7:00 AM to 3:30 PM'), body.slice(0, 200));
  ok('field shorthand becomes a sentence',
     body.includes('At approximately 8:17 AM, the subject arrived at ABC Fitness'), body);
  ok('a location is carried into the line', body.includes('(1400 Main St)'));
  ok('a line that is not about the subject keeps the wording verbatim',
     body.includes('At approximately 7:03 AM — Arrived in vicinity of subject residence.'), body);
  /* The rewrite must only fire on an actual verb. "Subject vehicle observed"
     means the subject's vehicle, and "the subject vehicle observed parked"
     would be nonsense the investigator then has to notice and undo. */
  ok('a noun phrase after "Subject" is left verbatim, not rewritten',
     body.includes('At approximately 7:14 AM — Subject vehicle observed parked at residence'), body);
  ok('and it never produces "the subject vehicle"', !body.includes('the subject vehicle'), body);
  ok('entries come out in time order', body.indexOf('7:03 AM') < body.indexOf('8:17 AM'));
  ok('the day summary is carried in', body.includes('Subject active throughout.'));
  ok('a flagged moment states what was captured, per line',
     body.includes('Subject mowing the front lawn. (Subject documented. Video acquired.)'), body);
  ok('a second report for the same day is refused',
     (await call(env, '/cases/API-R1/reports/generate', { method: 'POST', cookie: inv,
       body: { day_id: ws.days[0].id } })).status === 409);

  ok('the investigator can edit their draft',
     (await call(env, `/cases/API-R1/reports/${repId}`, { method: 'POST', cookie: inv,
       body: { body: body + '\nAdded on review by the investigator.' } })).status === 200);
  ok('an empty report is refused',
     (await call(env, `/cases/API-R1/reports/${repId}`, { method: 'POST', cookie: inv,
       body: { body: '   ' } })).status === 400);

  /* THE RULE: writing a report is not reviewing it. */
  ok('an investigator cannot approve their own report',
     (await call(env, `/cases/API-R1/reports/${repId}/status`, { method: 'POST', cookie: inv,
       body: { status: 'approved' } })).status === 403);
  ok('nor mark it delivered',
     (await call(env, `/cases/API-R1/reports/${repId}/status`, { method: 'POST', cookie: inv,
       body: { status: 'delivered' } })).status === 403);
  ok('but they can submit it for review',
     (await call(env, `/cases/API-R1/reports/${repId}/status`, { method: 'POST', cookie: inv,
       body: { status: 'submitted' } })).status === 200);
  ok('once submitted they cannot keep editing around the review',
     (await call(env, `/cases/API-R1/reports/${repId}`, { method: 'POST', cookie: inv,
       body: { body: 'quietly changed' } })).status === 409);

  ok('the office can send it back with a note',
     (await call(env, `/cases/API-R1/reports/${repId}/status`, { method: 'POST', cookie: admin,
       body: { status: 'needs_revision', note: 'Add the vehicle description at 07:14.' } })).status === 200);
  ws = await jsonOf(await call(env, '/cases/API-R1/workspace', { cookie: inv }));
  ok('the investigator sees why it came back',
     ws.reports[0].review_note === 'Add the vehicle description at 07:14.');
  ok('and can edit it again', ws.reports[0].status === 'needs_revision');
  ok('editing works once it is back with them',
     (await call(env, `/cases/API-R1/reports/${repId}`, { method: 'POST', cookie: inv,
       body: { body: body + '\nWhite GMC Sierra.' } })).status === 200);

  await call(env, `/cases/API-R1/reports/${repId}/status`, { method: 'POST', cookie: inv, body: { status: 'submitted' } });
  ok('the office can approve', (await call(env, `/cases/API-R1/reports/${repId}/status`,
     { method: 'POST', cookie: admin, body: { status: 'approved' } })).status === 200);
  ok('and mark it delivered', (await call(env, `/cases/API-R1/reports/${repId}/status`,
     { method: 'POST', cookie: admin, body: { status: 'delivered' } })).status === 200);
  ok('an invalid status is refused', (await call(env, `/cases/API-R1/reports/${repId}/status`,
     { method: 'POST', cookie: admin, body: { status: 'published' } })).status === 400);

  /* UIBUILD P11: each submission preserved the exact text of its moment. */
  const vers = await jsonOf(await call(env, `/cases/API-R1/reports/${repId}/versions`, { cookie: inv }));
  ok('each submission left a version behind', vers.versions.length === 2, JSON.stringify(vers).slice(0, 200));
  ok('the newest version carries the resubmitted text',
     vers.versions[0].body.includes('White GMC Sierra.'));
  ok('the first submission is preserved exactly, without the later edit',
     !vers.versions[1].body.includes('White GMC Sierra.')
     && vers.versions[1].body.includes('Added on review by the investigator.'));
  await call(env, `/cases/API-R1/reports/${repId}`, { method: 'POST', cookie: admin,
    body: { body: 'Working copy rewritten by the office.' } });
  const vers2 = await jsonOf(await call(env, `/cases/API-R1/reports/${repId}/versions`, { cookie: admin }));
  ok('editing the working copy never touches a submitted version',
     vers2.versions.length === 2 && vers2.versions[0].body.includes('White GMC Sierra.'));

  // An admin doing their own fieldwork runs the whole path alone.
  await ingest(env, { case_no: 'API-R2', subject_name: 'Solo Subject', client_name: 'Acme' });
  await call(env, '/cases/API-R2/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-13', start_time: '09:00' } });
  await call(env, '/cases/API-R2/activity', { method: 'POST', cookie: admin,
    body: { at_date: '2026-08-13', at_time: '09:05', description: 'Subject departed residence.' } });
  await call(env, '/cases/API-R2/day/end', { method: 'POST', cookie: admin, body: { end_time: '12:00' } });
  const w2 = await jsonOf(await call(env, '/cases/API-R2/workspace', { cookie: admin }));
  const g2 = await jsonOf(await call(env, '/cases/API-R2/reports/generate', { method: 'POST', cookie: admin,
    body: { day_id: w2.days[0].id } }));
  ok('an admin can draft their own report', typeof g2.id === 'number');
  ok('and carry it all the way to approved themselves',
     (await call(env, `/cases/API-R2/reports/${g2.id}/status`, { method: 'POST', cookie: admin,
       body: { status: 'approved' } })).status === 200);

  // A day with nothing logged still drafts — it says so rather than pretending.
  await ingest(env, { case_no: 'API-R3', subject_name: 'Quiet Subject', client_name: 'Acme' });
  await call(env, '/cases/API-R3/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-14', start_time: '06:00' } });
  await call(env, '/cases/API-R3/day/end', { method: 'POST', cookie: admin, body: { end_time: '10:00' } });
  const w3 = await jsonOf(await call(env, '/cases/API-R3/workspace', { cookie: admin }));
  const g3 = await jsonOf(await call(env, '/cases/API-R3/reports/generate', { method: 'POST', cookie: admin,
    body: { day_id: w3.days[0].id } }));
  ok('an empty day reports zero entries honestly', g3.entries === 0);
  const w3b = await jsonOf(await call(env, '/cases/API-R3/workspace', { cookie: admin }));
  ok('and says so in the draft rather than inventing activity',
     w3b.reports[0].body.includes('No activity entries were logged'));
}

/* The rule that matters most once outside investigators exist: a case number
   in a URL is not a key to somebody else's work. */
section('An investigator cannot reach an unassigned case by URL');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const token = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  await ingest(env, { case_no: 'API-MINE', subject_name: 'Assigned Subject', client_name: 'Client A' });
  await ingest(env, { case_no: 'API-THEIRS', subject_name: 'Other Subject', client_name: 'Client B',
                      carrier: 'Rival Mutual', claim_number: 'SECRET-9' });
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const dana = users.users.find(u => u.username === 'dana');
  await call(env, '/submissions/API-MINE/assign', { method: 'POST', cookie: admin, body: { user_id: dana.id } });
  await call(env, '/cases/API-THEIRS/meta', { method: 'POST', cookie: admin,
    body: { authorized_hours: 24, authorized_budget: 3600 } });

  ok('their own case opens', (await call(env, '/cases/API-MINE/workspace', { cookie: inv })).status === 200);
  for (const [what, path, method] of [
    ['open the workspace', '/cases/API-THEIRS/workspace', 'GET'],
    ['start a day on it', '/cases/API-THEIRS/day/start', 'POST'],
    ['end a day on it', '/cases/API-THEIRS/day/end', 'POST'],
    ['log activity against it', '/cases/API-THEIRS/activity', 'POST'],
  ]) {
    const res = await call(env, path, { method, cookie: inv,
      body: method === 'POST' ? { day_date: '2026-08-12', start_time: '07:00', end_time: '15:00',
                                  at_date: '2026-08-12', at_time: '07:00', description: 'x' } : undefined });
    ok(`an investigator cannot ${what}`, res.status === 404, `got ${res.status}`);
  }
  ok('and cannot set authorization even on their own case',
     (await call(env, '/cases/API-MINE/meta', { method: 'POST', cookie: inv,
       body: { authorized_hours: 999 } })).status === 403);

  // The money stays out of the investigator's workspace.
  await call(env, '/cases/API-MINE/meta', { method: 'POST', cookie: admin,
    body: { authorized_hours: 16, authorized_budget: 2400 } });
  const mine = await jsonOf(await call(env, '/cases/API-MINE/workspace', { cookie: inv }));
  ok('an investigator is told the hours they are working to', mine.authorization.authorized_hours === 16);
  ok('an investigator is not told the budget', mine.authorization.authorized_budget === undefined);
  ok('nor what the case bills at', mine.authorization.billable_so_far === undefined);
  ok('nor the rate', mine.authorization.billed_at_rate === undefined);
  ok('and gets no case-type list to edit with', mine.case_types.length === 0);

  // One investigator must not be able to rewrite another's timeline.
  await call(env, '/cases/API-MINE/activity', { method: 'POST', cookie: admin,
    body: { at_date: '2026-08-12', at_time: '09:00', description: "Admin's own entry." } });
  const ws = await jsonOf(await call(env, '/cases/API-MINE/workspace', { cookie: inv }));
  const adminEntry = ws.activity.find(e => e.description.includes("Admin's own"));
  ok("an investigator cannot edit another person's entry",
     (await call(env, `/cases/API-MINE/activity/${adminEntry.id}`, { method: 'POST', cookie: inv,
       body: { description: 'rewritten' } })).status === 403);
}

/* MASTER §38 — the whole carrier chain, one case, no dead ends: sheet →
   intake → review → confirm → assign → field → report → build → invoice →
   BILL → paid → completed. Every hop is a route that already has its own
   section; THIS section proves they connect. */
section('End to end: a carrier assignment, sheet to completed');
{
  const realFetch = globalThis.fetch;
  let lastBody = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      lastBody = JSON.parse(init.body);
      return new Response('{"id":"re_1"}', { status: 200 });
    }
    return realFetch(url, init);
  };
  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  env.EVIDENCE = (() => {
    const store = new Map();
    return { async put(k, b, o) { store.set(k, { b, o }); },
             async get(k) { const o = store.get(k); return o ? { body: o.b } : null; },
             async delete(k) { store.delete(k); } };
  })();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  await call(env, `/invite/${new URL(link, 'https://x.test').searchParams.get('invite')}/accept`,
    { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const danaId = (await jsonOf(await call(env, '/users', { cookie: admin })))
    .users.find(u => u.username === 'dana').id;

  // 1. The adjuster's call becomes a lead; the sheet goes out with its door.
  const led = await jsonOf(await call(env, '/intakes', { method: 'POST', cookie: admin,
    body: { kind: 'claims', carrier: 'EndToEnd Mutual', client_name: 'Alex Adjuster',
            client_email: 'alex@e2emutual.test' } }));
  await call(env, `/sheets/insurance_assignment/email`, { method: 'POST', cookie: admin,
    body: { to: 'alex@e2emutual.test', case_no: led.case_no, include_intake: true } });
  ok('E2E-38: the sheet email carries the carrier door',
     lastBody.html.includes('/intake/?assignment=insurance'));
  ok('E2E-38: and the lead is stamped Intake Sent',
     (await jsonOf(await call(env, '/submissions', { cookie: admin }))).submissions
       .find(c => c.case_no === led.case_no).lead_status === 'intake_sent');

  // 2. The adjuster submits, partially — unknowns marked, never invented.
  await ingest(env, { case_no: 'API-E38', kind: 'claims', service: 'Insurance claim assignment',
    carrier: 'EndToEnd Mutual', client_name: 'Alex Adjuster', client_email: 'alex@e2emutual.test',
    subject_name: 'Jordan Claimant', claim_type: "Workers' compensation",
    objective: 'Activity level versus stated restrictions.',
    claim_number: '', claim_number_status: 'unknown',
    subject_address: '', subject_address_status: 'unknown' });
  await call(env, `/leads/${led.case_no}/status`, { method: 'POST', cookie: admin,
    body: { status: 'converted' } });
  const listed = (await jsonOf(await call(env, '/submissions', { cookie: admin }))).submissions;
  ok('E2E-38: the intake is on the office\'s list to review',
     listed.some(c => c.case_no === 'API-E38' && c.status === 'new'));

  // 3. The office confirms 24 hours — which is the $3,300 block, admin-only.
  await call(env, '/cases/API-E38/meta', { method: 'POST', cookie: admin,
    body: { authorized_hours: 24 } });
  const authAdmin = (await jsonOf(await call(env, '/cases/API-E38/workspace', { cookie: admin }))).authorization;
  ok('E2E-38: 24 confirmed hours read as the $3,300 block for the office',
     authAdmin.authorized_hours === 24 && authAdmin.package_price === 3300);

  // 4. Assigned; the investigator sees the work and none of the money.
  await call(env, '/submissions/API-E38/assign', { method: 'POST', cookie: admin,
    body: { user_id: danaId } });
  const wsInv = await jsonOf(await call(env, '/cases/API-E38/workspace', { cookie: inv }));
  const subInv = (await jsonOf(await call(env, '/submissions/API-E38', { cookie: inv }))).submission;
  ok('E2E-38: the field gets the cap and the unknowns, never the carrier',
     wsInv.authorization.authorized_hours === 24
     && !('package_price' in wsInv.authorization)
     && subInv.payload.subject_address_status === 'unknown'
     && !('claim_number' in subInv.payload) && !('claim_number_status' in subInv.payload)
     && !JSON.stringify(subInv.payload).includes('EndToEnd Mutual'));

  // 5. The field day: start, quick entry, a spoken note reviewed into an
  // entry (the transcript path lands here as an ordinary activity), photo,
  // video, end. Same routes the mode uses.
  await call(env, '/cases/API-E38/day/start', { method: 'POST', cookie: inv,
    body: { day_date: '2026-08-14', start_time: '06:30', start_mileage: 41000 } });
  await call(env, '/cases/API-E38/activity', { method: 'POST', cookie: inv,
    body: { at_date: '2026-08-14', at_time: '06:45', kind: 'activity',
            description: 'Arrived in vicinity of subject residence.' } });
  await call(env, '/cases/API-E38/activity', { method: 'POST', cookie: inv,
    body: { at_date: '2026-08-14', at_time: '08:10', kind: 'activity',
            description: 'Subject observed loading equipment into pickup — dictated in the field and reviewed before saving.' } });
  const upl = async (name, type) => {
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array(400).fill(65)], name, { type }));
    return jsonOf(await worker.fetch(new Request(API + '/cases/API-E38/evidence', {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: inv }, body: fd }), env));
  };
  const ph = await upl('subject-0810.jpg', 'image/jpeg');
  const vd = await upl('subject-0812.jpg', 'image/jpeg');
  const evList = (await jsonOf(await call(env, '/cases/API-E38/workspace', { cookie: inv }))).evidence;
  ok('E2E-38: field uploads are client-deliverable straight away',
     evList.find(e => e.id === ph.id).classification === 'client_deliverable'
     && evList.find(e => e.id === vd.id).classification === 'client_deliverable');
  const ended = await jsonOf(await call(env, '/cases/API-E38/day/end', { method: 'POST', cookie: inv,
    body: { end_time: '14:30', end_mileage: 41062 } }));
  ok('E2E-38: the day banked its hours and miles', ended.hours === 8 && ended.miles === 62);

  // 6. Report: drafted from the day, submitted, approved.
  const dayId = (await jsonOf(await call(env, '/cases/API-E38/workspace', { cookie: inv }))).days[0].id;
  const rep = await jsonOf(await call(env, '/cases/API-E38/reports/generate', { method: 'POST',
    cookie: inv, body: { day_id: dayId } }));
  const drafted = (await jsonOf(await call(env, '/cases/API-E38/workspace', { cookie: inv })))
    .reports.find(r => r.id === rep.id);
  ok('E2E-38: the draft is built from the timeline', drafted.body.includes('loading equipment'));
  await call(env, `/cases/API-E38/reports/${rep.id}/status`, { method: 'POST', cookie: inv,
    body: { status: 'submitted' } });
  await call(env, `/cases/API-E38/reports/${rep.id}/status`, { method: 'POST', cookie: admin,
    body: { status: 'approved' } });

  // 7. Case Build: report + selected photos + the video, finalized. Dropbox is
  // connected, because since 2026-08-18 a new photo cannot be uploaded without
  // it — the panel reporting that truthfully is the assertion.
  let st = await jsonOf(await call(env, '/cases/API-E38/build', { method: 'POST', cookie: admin }));
  await call(env, `/build/${st.build.id}/items`, { method: 'POST', cookie: admin,
    body: { evidence_id: ph.id } });
  await call(env, `/build/${st.build.id}/items`, { method: 'POST', cookie: admin,
    body: { evidence_id: vd.id } });
  await call(env, `/build/${st.build.id}/package`, { method: 'POST', cookie: admin,
    body: { package_type: 'report_photos_video' } });
  ok('E2E-38: the storage panel reports Dropbox exactly as it is',
     (await jsonOf(await call(env, '/external-storage', { cookie: admin })))
       .providers.dropbox.configured === true);
  st = await jsonOf(await call(env, `/build/${st.build.id}/finalize`, { method: 'POST', cookie: admin }));
  ok('E2E-38: the package finalizes with the report and both exhibits',
     st.build.status === 'finalized' && st.items.length === 2 && st.reports.length === 1);

  // 8. Money: the block invoices flat, goes to BILL, and arithmetic pays it.
  const made = await jsonOf(await call(env, '/cases/API-E38/invoices', { method: 'POST', cookie: admin,
    body: { from_authorization: true } }));
  ok('E2E-38: the invoice bills the confirmed block, flat',
     made.invoice.lines[0].amount === 3300 && made.invoice.lines[0].rate === null);
  await call(env, `/invoices/${made.invoice.id}/status`, { method: 'POST', cookie: admin,
    body: { status: 'ready' } });
  await call(env, `/invoices/${made.invoice.id}/status`, { method: 'POST', cookie: admin,
    body: { status: 'sent_to_bill' } });
  await call(env, `/invoices/${made.invoice.id}/bill`, { method: 'POST', cookie: admin,
    body: { external_invoice_id: 'BILL-E38' } });
  const sent = await jsonOf(await call(env, `/invoices/${made.invoice.id}`, { cookie: admin }));
  ok('E2E-38: sent to BILL is stamped and is NOT paid',
     sent.invoice.status === 'sent_to_bill' && sent.invoice.balance_due === 3300);
  const paid = await jsonOf(await call(env, `/invoices/${made.invoice.id}/payments`, { method: 'POST',
    cookie: admin, body: { amount: 3300, paid_date: '2026-09-02', method: 'ach', provider: 'bill',
                           external_payment_id: 'PAY-E38' } }));
  ok('E2E-38: the balance reaching zero is what makes it paid',
     paid.invoice.status === 'paid' && paid.invoice.balance_due === 0);

  // 9. Completed: the desk finds it with every artifact in reach.
  await call(env, '/submissions/API-E38/status', { method: 'POST', cookie: admin,
    body: { status: 'complete' } });
  const desk = (await jsonOf(await call(env, '/completed', { cookie: admin }))).completed;
  const done = desk.find(c => c.case_no === 'API-E38');
  ok('E2E-38: the completed desk holds the whole file',
     done && done.build_id != null && done.approved_reports === 1
     && done.evidence_count === 2 && done.invoice && done.invoice.status === 'paid');
  globalThis.fetch = realFetch;
}

/* MASTER §39 — the private chain, kept strictly apart from the carrier's:
   retainer instead of blocks, and the retainer block on the invoice. */
section('End to end: a private client, sheet to completed');
{
  const realFetch = globalThis.fetch;
  let lastBody = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      lastBody = JSON.parse(init.body);
      return new Response('{"id":"re_1"}', { status: 200 });
    }
    return realFetch(url, init);
  };
  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  env.EVIDENCE = (() => {
    const store = new Map();
    return { async put(k, b, o) { store.set(k, { b, o }); },
             async get(k) { const o = store.get(k); return o ? { body: o.b } : null; },
             async delete(k) { store.delete(k); } };
  })();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  // 1. The private sheet goes out with the PRIVATE door — never the picker.
  const led = await jsonOf(await call(env, '/intakes', { method: 'POST', cookie: admin,
    body: { kind: 'consumer', client_name: 'Morgan Hale', client_email: 'morgan@example.test',
            service: 'Surveillance' } }));
  await call(env, `/sheets/private_retainer/email`, { method: 'POST', cookie: admin,
    body: { to: 'morgan@example.test', case_no: led.case_no, include_intake: true } });
  ok('E2E-39: the private sheet carries the private door',
     lastBody.html.includes('/intake/?assignment=private')
     && !lastBody.html.includes('assignment=insurance'));

  // 2. A partial intake — the address can follow later.
  await ingest(env, { case_no: 'API-E39', service: 'Surveillance',
    client_name: 'Morgan Hale', client_email: 'morgan@example.test',
    subject_name: 'Alex Hale', objective: 'Weekday evening whereabouts.',
    subject_address: '', subject_address_status: 'unknown' });
  await call(env, `/leads/${led.case_no}/status`, { method: 'POST', cookie: admin,
    body: { status: 'converted' } });

  // 3. The retainer workflow: recorded, then received. Refused on a claim.
  ok('E2E-39: a retainer cannot be put on a claim assignment',
     (await call(env, '/cases/API-E39/retainer', { method: 'POST', cookie: admin,
       body: { received: true } })).status === 200);
  const auth = (await jsonOf(await call(env, '/cases/API-E39/workspace', { cookie: admin }))).authorization;
  ok('E2E-39: the retainer reads received at $1,500',
     auth.retainer && auth.retainer.amount === 1500 && auth.retainer.received === true);

  // 4. The work: a day, an entry, a photo, the report approved.
  await call(env, '/cases/API-E39/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-14', start_time: '18:00' } });
  await call(env, '/cases/API-E39/activity', { method: 'POST', cookie: admin,
    body: { at_date: '2026-08-14', at_time: '19:20', kind: 'activity',
            description: 'Subject departed residence alone.' } });
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(300).fill(65)], 'evening.jpg', { type: 'image/jpeg' }));
  const ph = await jsonOf(await worker.fetch(new Request(API + '/cases/API-E39/evidence', {
    method: 'POST', headers: { Origin: ORIGIN, Cookie: admin }, body: fd }), env));
  await call(env, '/cases/API-E39/day/end', { method: 'POST', cookie: admin, body: { end_time: '22:00' } });
  const dayId = (await jsonOf(await call(env, '/cases/API-E39/workspace', { cookie: admin }))).days[0].id;
  const rep = await jsonOf(await call(env, '/cases/API-E39/reports/generate', { method: 'POST',
    cookie: admin, body: { day_id: dayId } }));
  await call(env, `/cases/API-E39/reports/${rep.id}/status`, { method: 'POST', cookie: admin, body: { status: 'submitted' } });
  await call(env, `/cases/API-E39/reports/${rep.id}/status`, { method: 'POST', cookie: admin, body: { status: 'approved' } });

  // 5. Build and finalize.
  let st = await jsonOf(await call(env, '/cases/API-E39/build', { method: 'POST', cookie: admin }));
  await call(env, `/build/${st.build.id}/items`, { method: 'POST', cookie: admin, body: { evidence_id: ph.id } });
  st = await jsonOf(await call(env, `/build/${st.build.id}/finalize`, { method: 'POST', cookie: admin }));
  ok('E2E-39: the private package finalizes', st.build.status === 'finalized');

  // 6. The money stays the retainer model — never the carrier's.
  const made = await jsonOf(await call(env, '/cases/API-E39/invoices', { method: 'POST', cookie: admin,
    body: { from_authorization: true } }));
  ok('E2E-39: the invoice opens on the retainer, typed private',
     made.invoice.invoice_type === 'private' && made.invoice.lines[0].amount === 1500);
  ok('E2E-39: the retainer block rides the invoice — amount, applied, balance',
     made.invoice.retainer && made.invoice.retainer.amount === 1500
     && made.invoice.retainer.applied === 0 && made.invoice.retainer.balance === 1500);
  // Drafts take no payments — the same gate every invoice obeys — so the
  // retainer invoice goes Ready and out to the client before it is paid.
  await call(env, `/invoices/${made.invoice.id}/status`, { method: 'POST', cookie: admin,
    body: { status: 'ready' } });
  await call(env, `/invoices/${made.invoice.id}/status`, { method: 'POST', cookie: admin,
    body: { status: 'sent_to_client' } });
  const paid = await jsonOf(await call(env, `/invoices/${made.invoice.id}/payments`, { method: 'POST',
    cookie: admin, body: { amount: 1500, paid_date: '2026-08-20', method: 'other',
                           notes: 'Retainer received before work began' } }));
  ok('E2E-39: paid by arithmetic, like every invoice here', paid.invoice.status === 'paid');

  // 7. Completed, findable, and the two products never blur.
  await call(env, '/submissions/API-E39/status', { method: 'POST', cookie: admin,
    body: { status: 'complete' } });
  const done = (await jsonOf(await call(env, '/completed', { cookie: admin }))).completed
    .find(c => c.case_no === 'API-E39');
  ok('E2E-39: the completed desk holds the private file too',
     done && done.build_id != null && done.invoice && done.invoice.status === 'paid');
  /* The retainer's whole purpose: WORK draws it down, the deposit does not. */
  const work = (await jsonOf(await call(env, '/cases/API-E39/invoices', { method: 'POST',
    cookie: admin, body: { confirm_duplicate: true } }))).invoice;
  await call(env, `/invoices/${work.id}/lines`, { method: 'POST', cookie: admin,
    body: { lines: [{ description: 'Surveillance, 6 hours', qty: 6, rate: 100, amount: 600 }] } });
  const after = (await jsonOf(await call(env, `/invoices/${work.id}`, { cookie: admin }))).invoice;
  ok('E2E-39: work billed after the retainer draws it down, and only work does',
     after.retainer.applied === 600 && after.retainer.balance === 900);
  ok('E2E-39: so the client is never told they are past a retainer they still hold',
     after.retainer.balance > 0);
  globalThis.fetch = realFetch;
}

/* Boundary regressions found by the 2026-08-14 independent audit. Both were
   real leaks across the investigator line, and BOTH suites passed while they
   existed — which is the only reason they are worth their own section. */
section('Two leaks the suite used to pass over');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin, { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  await call(env, `/invite/${new URL(link, 'https://x.test').searchParams.get('invite')}/accept`,
    { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const danaId = (await jsonOf(await call(env, '/users', { cookie: admin })))
    .users.find(u => u.username === 'dana').id;

  await ingest(env, { case_no: 'API-LK1', carrier: 'Leak Mutual', client_name: 'A', subject_name: 'S' });
  await call(env, '/submissions/API-LK1/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });

  /* An office note typed with the defaults went to the field. "Admin note" is
     the FIRST option in the picker, and visibility defaulted to team. */
  await call(env, '/cases/API-LK1/notes', { method: 'POST', cookie: admin,
    body: { note_type: 'admin', body: 'Carrier agreed $135/hr preferred-volume on this file.' } });
  await call(env, '/cases/API-LK1/notes', { method: 'POST', cookie: admin,
    body: { note_type: 'strategy', body: 'Do not disclose the budget to the field.' } });
  await call(env, '/cases/API-LK1/notes', { method: 'POST', cookie: admin,
    body: { note_type: 'investigator', body: 'Park on the north side.' } });

  const invNotes = (await jsonOf(await call(env, '/cases/API-LK1/workspace', { cookie: inv }))).notes;
  ok('an admin note with no stated visibility stays in the office',
     !JSON.stringify(invNotes).includes('preferred-volume'));
  ok('and so does a strategy note',
     !JSON.stringify(invNotes).includes('Do not disclose'));
  ok('while a note written FOR the field still reaches it',
     JSON.stringify(invNotes).includes('Park on the north side'));
  ok('the office still sees all three',
     (await jsonOf(await call(env, '/cases/API-LK1/workspace', { cookie: admin }))).notes.length === 3);

  /* A pending offer is deliberately thin. Declining one — or an admin merely
     withdrawing it, which needs no action from the investigator at all —
     used to hand over the case number and the instructions it withheld. */
  await ingest(env, { case_no: 'API-LK2', client_name: 'B', subject_name: 'Hidden Subject' });
  const secret = 'Meet at the lot off 460. Subject is Hidden Subject.';
  // The id comes back off the investigator's own list rather than the create
  // response — fewer assumptions about a shape this test does not own.
  const mk = async () => {
    await call(env, '/cases/API-LK2/offer', { method: 'POST', cookie: admin,
      body: { investigator_id: danaId, instructions: secret,
              compensation_hourly: 30, expected_hours: 8 } });
    const list = (await jsonOf(await call(env, '/my/offers', { cookie: inv }))).offers;
    return list.find(o => o.status === 'offered') || list[0];
  };
  const mine = async () => JSON.stringify((await jsonOf(await call(env, '/my/offers', { cookie: inv }))).offers);

  const o1 = await mk();
  ok('a pending offer withholds the case and the instructions',
     !(await mine()).includes('API-LK2') && !(await mine()).includes('Hidden Subject'));

  await call(env, `/my/offers/${o1.id}/decline`, { method: 'POST', cookie: inv, body: {} });
  ok('declining does not disclose what the offer withheld',
     !(await mine()).includes('API-LK2') && !(await mine()).includes('Hidden Subject'));

  const o2 = await mk();
  await call(env, `/offers/${o2.id}/withdraw`, { method: 'POST', cookie: admin, body: {} });
  ok('and neither does an admin withdrawing one — the field did nothing at all',
     !(await mine()).includes('API-LK2') && !(await mine()).includes('Hidden Subject'));

  const o3 = await mk();
  await call(env, `/my/offers/${o3.id}/accept`, { method: 'POST', cookie: inv, body: {} });
  ok('acceptance — and only acceptance — is what creates access',
     (await mine()).includes('API-LK2') && (await mine()).includes('Hidden Subject'));
}

section('Origin guard and headers');
{
  const env = freshEnv();
  let res = await call(env, '/health');
  ok('the site origin is accepted', res.status === 200);
  res = await call(env, '/health', { origin: 'https://evil.example' });
  ok('a foreign origin is refused outright', res.status === 403);
  ok('responses are never cached', res.headers.get('Cache-Control') === 'no-store');
  ok('nosniff is set', res.headers.get('X-Content-Type-Options') === 'nosniff');
  ok('no referrer is leaked', res.headers.get('Referrer-Policy') === 'no-referrer');

  // curl and the deploy health check send no Origin at all.
  res = await worker.fetch(new Request(API + '/health'), env);
  ok('a request with no Origin is allowed through', res.status === 200);

  // The Worker answers under its mounted prefix as well as bare.
  res = await worker.fetch(new Request(API + '/portal-api/health'), env);
  ok('the /portal-api prefix is stripped', res.status === 200 && (await jsonOf(res)).ok === true);
}

/* TWO ADMIN ACCOUNTS SEE THE SAME DATA (owner, WORKFLOW-SIMPLIFICATION §4).

   The owner raised this, which usually means something looked wrong on screen.
   Reading the code says it should already hold — every scoped query is
   `admin ? '' : <narrowed to assigned_to>`, and `caseFor` lets an admin past
   unconditionally — but nothing proved it: every other test in this file signs
   in as one admin. A property believed and never asserted is the kind that
   quietly stops being true.

   So: one admin builds a case's whole record, a SECOND admin reads it, and the
   two answers are compared byte for byte.

   WHAT IS DELIBERATELY NOT COMPARED, and must not be "fixed" into parity:

     `server_now`  — the Worker's clock, different on every request by design.
     `my_offer`    — an offer made to THIS user. It is identity-scoped on
                     purpose; asserting it equal would assert a wrong property.
     `open_day`    — YOUR OWN running clock. The query binds `user.id`, and
                     "you can only stop your own clock" is a shipped invariant
                     of Active Surveillance. Exercised below on a case with a
                     day actually running, rather than dodged by ending every
                     day in the fixture.

   The same goes for `/my/reports`, `/my/expenses`, `/my/active` and `/calendar`,
   which scope by WHO CREATED the record (the KEEP decision, 2026-08-14). They
   are not part of this parity and are not asserted here. "Do not scope admin
   data by assigned_to" is not "make every view global". */
section('Two admin accounts see the same data');
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      return new Response('{"id":"re_1"}', { status: 200 });
    }
    return realFetch(url, init);
  };
  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  env.MAIL_PER_MINUTE = '50';
  await bootstrapAdmin(env);
  const adminA = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  /* The second admin arrives the only way an account can: by invitation. */
  const invRes = await jsonOf(await invite(env, adminA,
    { username: 'second_admin', display_name: 'Second Admin', role: 'admin' }));
  const tok = new URL(invRes.url, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tok}/accept`, { method: 'POST', body: { password: 'SecondAdmin2026x' } });
  const adminB = (await login(env, 'second_admin', 'SecondAdmin2026x')).cookie;
  ok('a second admin account exists and can sign in', Boolean(adminB));
  ok('and it really is an admin',
     (await jsonOf(await call(env, '/auth/me', { cookie: adminB }))).user.role === 'admin');

  /* ---- ADMIN A BUILDS THE RECORD ------------------------------------- */

  await ingest(env, { case_no: 'API-PAR-P', service: 'Surveillance',
                      client_name: 'Parity Client', client_email: 'parity@example.com',
                      client_phone: '555-0100', subject_name: 'Subject One',
                      subject_address: '1 Test Road', objective: 'Document activity.' });
  await ingest(env, { case_no: 'API-PAR-C', carrier: 'Parity Mutual', claim_number: 'PM-42',
                      client_name: 'Parity Adjuster', client_email: 'adj@carrier.example',
                      subject_name: 'Claimant Two' });

  // A worked day, so there is something to report on.
  await call(env, '/cases/API-PAR-P/day/start', { method: 'POST', cookie: adminA,
    body: { day_date: '2026-08-14', start_time: '07:00', start_mileage: 10000 } });
  for (const [t, d] of [['07:15', 'Arrived at the residence.'],
                        ['09:40', 'Subject departed in the grey sedan.']]) {
    await call(env, '/cases/API-PAR-P/activity', { method: 'POST', cookie: adminA,
      body: { at_date: '2026-08-14', at_time: t, description: d } });
  }
  await call(env, '/cases/API-PAR-P/day/end', { method: 'POST', cookie: adminA,
    body: { end_time: '12:00', end_mileage: 10055 } });
  const parDay = (await jsonOf(await call(env, '/cases/API-PAR-P/workspace', { cookie: adminA }))).days[0];
  await call(env, '/cases/API-PAR-P/reports/generate', { method: 'POST', cookie: adminA,
    body: { day_id: parDay.id } });

  // A manual retainer payment, and one voided so the audit path is covered too.
  await call(env, '/cases/API-PAR-P/retainer', { method: 'POST', cookie: adminA,
    body: { retainer_amount: 2000 } });
  await call(env, '/cases/API-PAR-P/retainer/payment', { method: 'POST', cookie: adminA,
    body: { amount: 800, method: 'check', paid_on: '2026-08-12', reference: 'cheque 4471' } });
  const toVoid = await jsonOf(await call(env, '/cases/API-PAR-P/retainer/payment',
    { method: 'POST', cookie: adminA,
      body: { amount: 50, method: 'cash', paid_on: '2026-08-13', reference: 'miskey' } }));
  const voidId = (toVoid.authorization.retainer.payments || []).slice(-1)[0].id;
  await call(env, `/cases/API-PAR-P/retainer/payment/${voidId}/void`, { method: 'POST',
    cookie: adminA, body: { reason: 'recorded twice' } });

  // An invoice carried far enough to hold a payment of its own.
  const madeInv = await jsonOf(await call(env, '/cases/API-PAR-P/invoices', { method: 'POST',
    cookie: adminA, body: {} }));
  const invId = madeInv.invoice.id;
  await call(env, `/invoices/${invId}/lines`, { method: 'POST', cookie: adminA,
    body: { lines: [{ description: 'Surveillance', qty: 8, rate: 100 }] } });
  await call(env, `/invoices/${invId}/status`, { method: 'POST', cookie: adminA,
    body: { status: 'ready' } });
  await call(env, `/invoices/${invId}/payments`, { method: 'POST', cookie: adminA,
    body: { amount: 300, paid_date: '2026-08-15', method: 'check', reference: 'part' } });

  // Send history: one against a case, one pre-case with no case at all.
  await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: adminA,
    body: { to: 'parity@example.com', case_no: 'API-PAR-P', include_intake: true } });
  await call(env, '/intake-link/email', { method: 'POST', cookie: adminA,
    body: { to: 'brand.new@example.com', name: 'Brand New', kind: 'private' } });

  /* ---- AND THE SECOND ADMIN READS IT --------------------------------- */

  /* Strip only what is per-request or per-identity BY DESIGN. Anything else
     differing is the leak this test exists to catch. */
  const VOLATILE = new Set(['server_now', 'my_offer', 'open_day']);
  const strip = v => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) if (!VOLATILE.has(k)) out[k] = strip(v[k]);
      return out;
    }
    return v;
  };
  const bothSee = async path => {
    const a = strip(await jsonOf(await call(env, path, { cookie: adminA })));
    const b = strip(await jsonOf(await call(env, path, { cookie: adminB })));
    return [JSON.stringify(a), JSON.stringify(b)];
  };
  /* Compared as JSON, and the failure message names the FIRST differing field
     rather than dumping two documents — a diff nobody can read is a diff nobody
     acts on. */
  const same = async (label, path) => {
    const [a, b] = await bothSee(path);
    if (a === b) { ok(label, true); return; }
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    ok(label, false, `${path} diverges at char ${i}: `
      + `A…${a.slice(Math.max(0, i - 60), i + 60)} | B…${b.slice(Math.max(0, i - 60), i + 60)}`);
  };

  /* The six surfaces, checked as a set so the whole thing can be re-run once
     the SECOND admin has authored records of their own. */
  const surfaces = extra => [
    ['the case list',                '/submissions?limit=200'],
    ['the private intake',           '/submissions/API-PAR-P'],
    ['the claims intake',            '/submissions/API-PAR-C'],
    ['the private case workspace',   '/cases/API-PAR-P/workspace'],
    ['the claims case workspace',    '/cases/API-PAR-C/workspace'],
    ['that case\'s invoice list',    '/cases/API-PAR-P/invoices'],
    ['the invoice list overall',     '/invoices'],
    ['the invoice, lines and payments', `/invoices/${invId}`],
    ['the send history',             '/sends?limit=200'],
    ...(extra || []),
  ];
  const runParity = async (phase, extra) => {
    for (const [label, path] of surfaces(extra)) await same(`${phase}: both admins see ${label}`, path);
  };

  /* ---- DIRECTION ONE: what admin A authored, admin B must see ---------- */

  await runParity('A authored');

  const listA = await jsonOf(await call(env, '/submissions?limit=200', { cookie: adminA }));
  const listB = await jsonOf(await call(env, '/submissions?limit=200', { cookie: adminB }));
  ok('the case list is not empty, so the comparison means something',
     (listA.submissions || []).length >= 2, String((listA.submissions || []).length));
  ok('neither admin is missing a case the other has',
     (listA.submissions || []).map(r => r.case_no).sort().join() ===
     (listB.submissions || []).map(r => r.case_no).sort().join());

  /* Client identity lives on the SUBMISSION record, not the workspace — that is
     where `redactRow` withholds it from an investigator, so it is the surface
     where an admin-parity leak would actually show. Asserted so the comparison
     above is known to be comparing something that matters. */
  const subA = await jsonOf(await call(env, '/submissions/API-PAR-P', { cookie: adminA }));
  const subB = await jsonOf(await call(env, '/submissions/API-PAR-P', { cookie: adminB }));
  ok('the intake detail really carries client identity, so a leak would show',
     JSON.stringify(subA).includes('Parity Client'));
  ok('and the second admin is shown that identity too, not a redacted copy',
     JSON.stringify(subB).includes('Parity Client'));

  const wsA = await jsonOf(await call(env, '/cases/API-PAR-P/workspace', { cookie: adminA }));
  ok('the workspace really carries the retainer payments being compared',
     (wsA.authorization.retainer.payments || []).length === 2,
     String((wsA.authorization.retainer.payments || []).length));
  ok('and a report', (wsA.reports || []).length === 1, String((wsA.reports || []).length));
  ok('and the activity entries', (wsA.activity || []).length === 2,
     String((wsA.activity || []).length));
  const ivA = (await jsonOf(await call(env, `/invoices/${invId}`, { cookie: adminA }))).invoice;
  ok('the invoice really carries the payment being compared',
     (ivA.payments || []).length === 1 && ivA.balance_due === 500,
     JSON.stringify([(ivA.payments || []).length, ivA.balance_due]));
  const sendsA = (await jsonOf(await call(env, '/sends?limit=200', { cookie: adminA }))).sends || [];
  ok('the history really carries both a case send and a pre-case one',
     sendsA.some(s => s.case_no === 'API-PAR-P') && sendsA.some(s => s.case_no === null));

  /* ---- DIRECTION TWO: what admin B authored, admin A must see ----------

     Without this the test proves only that the SECOND admin can see the
     FIRST's work. That is not the invariant. Admin A here is the bootstrap
     account — user id 1, created by `/setup` rather than by invitation — so
     "B sees A's records" passing says nothing about whether a record authored
     by an invited admin is visible to the first one. The asymmetry is in the
     accounts themselves, not just in the direction of the assertion.

     So admin B now authors a full record of their own, through the same routes,
     and every surface is compared again. */

  const madeByB = await jsonOf(await call(env, '/intakes', { method: 'POST', cookie: adminB,
    body: { kind: 'consumer', client_name: 'B-Authored Client', client_email: 'b.client@example.com',
            subject_name: 'B Subject', objective: 'Recorded by the second admin.' } }));
  const caseB = madeByB.case_no;
  ok('the second admin can create a case at all', /^API-\d{8}-\d{4}$/.test(caseB || ''), String(caseB));

  await call(env, `/cases/${caseB}/day/start`, { method: 'POST', cookie: adminB,
    body: { day_date: '2026-08-15', start_time: '08:00', start_mileage: 20000 } });
  await call(env, `/cases/${caseB}/activity`, { method: 'POST', cookie: adminB,
    body: { at_date: '2026-08-15', at_time: '08:20', description: 'Logged by the second admin.' } });
  await call(env, `/cases/${caseB}/day/end`, { method: 'POST', cookie: adminB,
    body: { end_time: '11:00', end_mileage: 20030 } });
  const dayB = (await jsonOf(await call(env, `/cases/${caseB}/workspace`, { cookie: adminB }))).days[0];
  await call(env, `/cases/${caseB}/reports/generate`, { method: 'POST', cookie: adminB,
    body: { day_id: dayB.id } });
  await call(env, `/cases/${caseB}/retainer`, { method: 'POST', cookie: adminB,
    body: { retainer_amount: 1500 } });
  await call(env, `/cases/${caseB}/retainer/payment`, { method: 'POST', cookie: adminB,
    body: { amount: 400, method: 'cash', paid_on: '2026-08-15', reference: 'by second admin' } });
  const invB = (await jsonOf(await call(env, `/cases/${caseB}/invoices`, { method: 'POST',
    cookie: adminB, body: {} }))).invoice;
  await call(env, `/invoices/${invB.id}/lines`, { method: 'POST', cookie: adminB,
    body: { lines: [{ description: 'Surveillance', qty: 4, rate: 100 }] } });
  await call(env, `/invoices/${invB.id}/status`, { method: 'POST', cookie: adminB,
    body: { status: 'ready' } });
  await call(env, `/invoices/${invB.id}/payments`, { method: 'POST', cookie: adminB,
    body: { amount: 100, paid_date: '2026-08-15', method: 'cash', reference: 'part, by B' } });
  await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: adminB,
    body: { to: 'b.client@example.com', case_no: caseB, include_intake: true } });

  /* Every surface again — now including the case only the SECOND admin has
     ever touched, and its invoice. */
  await runParity('B authored', [
    ['the case the second admin created',  `/submissions/${caseB}`],
    ['its workspace',                      `/cases/${caseB}/workspace`],
    ['its invoice list',                   `/cases/${caseB}/invoices`],
    ['its invoice, lines and payments',    `/invoices/${invB.id}`],
  ]);

  /* And said as a property rather than only as a diff: each admin's view
     contains the OTHER's work. A comparison can pass because both sides are
     equally wrong; these cannot. */
  const listA2 = await jsonOf(await call(env, '/submissions?limit=200', { cookie: adminA }));
  const listB2 = await jsonOf(await call(env, '/submissions?limit=200', { cookie: adminB }));
  const nos = l => (l.submissions || []).map(r => r.case_no);
  ok('the first admin sees the case the second one created',
     nos(listA2).includes(caseB), nos(listA2).join());
  ok('and the second admin still sees the cases the first one created',
     nos(listB2).includes('API-PAR-P') && nos(listB2).includes('API-PAR-C'), nos(listB2).join());

  const wsBbyA = await jsonOf(await call(env, `/cases/${caseB}/workspace`, { cookie: adminA }));
  ok('the first admin sees the second admin\'s activity entry',
     (wsBbyA.activity || []).some(a => /second admin/i.test(a.description || '')));
  ok('and their report', (wsBbyA.reports || []).length === 1,
     String((wsBbyA.reports || []).length));
  ok('and their retainer payment',
     (wsBbyA.authorization.retainer.payments || []).length === 1,
     String((wsBbyA.authorization.retainer.payments || []).length));
  const ivBbyA = (await jsonOf(await call(env, `/invoices/${invB.id}`, { cookie: adminA }))).invoice;
  ok('and their invoice payment',
     (ivBbyA.payments || []).length === 1 && ivBbyA.balance_due === 300,
     JSON.stringify([(ivBbyA.payments || []).length, ivBbyA.balance_due]));
  const sendsByA = (await jsonOf(await call(env, '/sends?limit=200', { cookie: adminA }))).sends || [];
  const sendsByB = (await jsonOf(await call(env, '/sends?limit=200', { cookie: adminB }))).sends || [];
  ok('each admin\'s send history carries BOTH admins\' sends',
     sendsByA.some(s => s.case_no === caseB) && sendsByA.some(s => s.case_no === 'API-PAR-P')
     && sendsByB.some(s => s.case_no === caseB) && sendsByB.some(s => s.case_no === 'API-PAR-P'));

  /* A RUNNING DAY is the one thing here that is per-admin by design, so it is
     exercised rather than dodged. Every other day in this fixture is ended;
     this case deliberately leaves one open, and the asymmetry is asserted to be
     confined to `open_day` alone — the clock is admin A's, everything else
     about the case is both admins'. Without this the exclusion above would be
     an assumption nobody had tested. */
  await ingest(env, { case_no: 'API-PAR-R', service: 'Surveillance',
                      client_name: 'Running Day', subject_name: 'Still Out' });
  await call(env, '/cases/API-PAR-R/day/start', { method: 'POST', cookie: adminA,
    body: { day_date: '2026-08-16', start_time: '06:00', start_mileage: 30000 } });
  await call(env, '/cases/API-PAR-R/activity', { method: 'POST', cookie: adminA,
    body: { at_date: '2026-08-16', at_time: '06:30', description: 'Still in the field.' } });
  await same('a case with a day STILL RUNNING matches too', '/cases/API-PAR-R/workspace');
  const runA = await jsonOf(await call(env, '/cases/API-PAR-R/workspace', { cookie: adminA }));
  const runB = await jsonOf(await call(env, '/cases/API-PAR-R/workspace', { cookie: adminB }));
  ok('the running clock belongs to the admin who started it, and only them',
     Boolean(runA.open_day) && !runB.open_day,
     JSON.stringify([Boolean(runA.open_day), Boolean(runB.open_day)]));
  ok('but the day itself is on the record for both',
     JSON.stringify(runA.days) === JSON.stringify(runB.days) && (runA.days || []).length === 1);
  ok('and so is the activity logged during it',
     JSON.stringify(runA.activity) === JSON.stringify(runB.activity)
     && (runA.activity || []).length === 1);

  /* The other direction, so this cannot pass by both admins seeing NOTHING:
     an investigator on the same portal still sees only what is theirs. */
  const invLink = (await jsonOf(await invite(env, adminA,
    { username: 'parity_inv', display_name: 'Field', role: 'investigator' }))).url;
  const invTok = new URL(invLink, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${invTok}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const fieldCookie = (await login(env, 'parity_inv', 'FieldWork2026x')).cookie;
  const fieldList = await jsonOf(await call(env, '/submissions?limit=200', { cookie: fieldCookie }));
  ok('an investigator assigned nothing still sees no cases',
     (fieldList.submissions || []).length === 0, String((fieldList.submissions || []).length));
  ok('and cannot read a case workspace either',
     (await call(env, '/cases/API-PAR-P/workspace', { cookie: fieldCookie })).status === 404);

  globalThis.fetch = realFetch;
}

/* ARCHIVE AND RESTORE (owner, WORKFLOW-SIMPLIFICATION §2 — "Archive preserves
   everything and is restorable").

   A companion table, not a status: `submissions.status` carries a CHECK and
   `case_status.stage` is validated against STAGES, and widening either is the
   non-idempotent rebuild schema.sql cannot do. So the assertions below are as
   much about what archiving does NOT touch as about what it does. */
section('A case can be archived and restored, and nothing else moves');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  await ingest(env, { case_no: 'API-ARC-1', service: 'Surveillance',
                      client_name: 'Archie Client', subject_name: 'S' });
  await ingest(env, { case_no: 'API-ARC-2', service: 'Surveillance',
                      client_name: 'Stays Put', subject_name: 'S' });

  // A stage that is NOT the default, so "restores to the stage it had" means
  // something rather than coinciding with the initial value.
  await call(env, '/submissions/API-ARC-1/status', { method: 'POST', cookie: admin,
    body: { status: 'awaiting_client' } });

  const listOf = async (view = '') => (await jsonOf(await call(env,
    `/submissions?limit=200${view}`, { cookie: admin })));
  const before = await listOf();
  ok('both cases start in the active list',
     (before.submissions || []).map(r => r.case_no).sort().join() === 'API-ARC-1,API-ARC-2');
  ok('and the total counts them', before.total === 2, String(before.total));

  const arch = await call(env, '/cases/API-ARC-1/archive', { method: 'POST', cookie: admin, body: {} });
  ok('an admin can archive a case', arch.status === 200, String(arch.status));

  const after = await listOf();
  ok('the archived case leaves the active list',
     (after.submissions || []).map(r => r.case_no).join() === 'API-ARC-2',
     (after.submissions || []).map(r => r.case_no).join());
  ok('and the total follows the rows rather than contradicting them',
     after.total === 1, String(after.total));

  const only = await listOf('&view=archived');
  ok('the archived lens shows exactly the archived one',
     (only.submissions || []).map(r => r.case_no).join() === 'API-ARC-1',
     (only.submissions || []).map(r => r.case_no).join());
  ok('stamped with when it was archived',
     Boolean((only.submissions || [])[0] || {}).valueOf() && (only.submissions[0].archived_at || '') !== '');

  /* NOTHING ELSE MOVED. The stage, the status and the case record are what they
     were — that is what "preserves everything" has to mean, and it is the whole
     reason this is a companion table rather than a new status value. */
  const ws = await jsonOf(await call(env, '/cases/API-ARC-1/workspace', { cookie: admin }));
  ok('the stage is untouched by archiving', ws.stage === 'awaiting_client', String(ws.stage));
  ok('and the workspace still opens in full', ws.case_no === 'API-ARC-1');
  ok('and says it is archived, with who and when',
     ws.archived && ws.archived.archived_at && ws.archived.archived_by === 'Trever',
     JSON.stringify(ws.archived));
  const sub = await jsonOf(await call(env, '/submissions/API-ARC-1', { cookie: admin }));
  ok('the case record itself is still readable and intact',
     (sub.submission || {}).client_name === 'Archie Client');

  // Archiving twice is a no-op rather than an error — a double tap on a flaky
  // connection must not be a failure the office has to interpret.
  ok('archiving an already-archived case is a no-op',
     (await call(env, '/cases/API-ARC-1/archive', { method: 'POST', cookie: admin, body: {} })).status === 200);
  ok('and it is still archived exactly once',
     ((await listOf('&view=archived')).submissions || []).length === 1);

  const back = await call(env, '/cases/API-ARC-1/restore', { method: 'POST', cookie: admin, body: {} });
  ok('an admin can restore it', back.status === 200, String(back.status));
  const restored = await listOf();
  ok('and it returns to the active list',
     (restored.submissions || []).map(r => r.case_no).sort().join() === 'API-ARC-1,API-ARC-2');
  ok('at the stage it already had, because that was never touched',
     (await jsonOf(await call(env, '/cases/API-ARC-1/workspace', { cookie: admin }))).stage
       === 'awaiting_client');
  ok('the archived lens is empty again',
     ((await listOf('&view=archived')).submissions || []).length === 0);
  ok('restoring one that is not archived is a no-op, not an error',
     (await call(env, '/cases/API-ARC-2/restore', { method: 'POST', cookie: admin, body: {} })).status === 200);
  ok('archiving a case that does not exist is a 404',
     (await call(env, '/cases/API-NOPE-9/archive', { method: 'POST', cookie: admin, body: {} })).status === 404);

  /* Admin-only, like every other lifecycle control. */
  const link = (await jsonOf(await invite(env, admin,
    { username: 'arc_inv', display_name: 'Field', role: 'investigator' }))).url;
  const tk = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tk}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const field = (await login(env, 'arc_inv', 'FieldWork2026x')).cookie;
  ok('an investigator cannot archive',
     (await call(env, '/cases/API-ARC-2/archive', { method: 'POST', cookie: field, body: {} })).status === 403);
  ok('nor restore',
     (await call(env, '/cases/API-ARC-2/restore', { method: 'POST', cookie: field, body: {} })).status === 403);

  /* An investigator's own list obeys the archive too — the case leaves their
     view, and the scoping that hides other people's cases still applies. */
  await call(env, '/submissions/API-ARC-2/assign', { method: 'POST', cookie: admin,
    body: { user_id: (await jsonOf(await call(env, '/auth/me', { cookie: field }))).user.id } });
  ok('the investigator sees their assigned case',
     ((await jsonOf(await call(env, '/submissions', { cookie: field }))).submissions || [])
       .some(r => r.case_no === 'API-ARC-2'));
  await call(env, '/cases/API-ARC-2/archive', { method: 'POST', cookie: admin, body: {} });
  ok('and stops seeing it once the office archives it',
     ((await jsonOf(await call(env, '/submissions', { cookie: field }))).submissions || [])
       .every(r => r.case_no !== 'API-ARC-2'));
}

/* DELETE CASE IS A TOMBSTONE (owner: "an Admin-only soft-delete/tombstone that
   removes it from normal views but preserves records", and "a true irreversible
   data purge is NOT needed now").

   The assertions that matter most are the ones proving NOTHING WAS DESTROYED —
   a delete that deleted rows would not be a tombstone. It differs from archive
   in REACH, not in destructiveness: it leaves every ordinary view including
   Archived, and comes back only under its own lens. */
section('Deleting a case is a tombstone, and nothing is destroyed');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  await ingest(env, { case_no: 'API-DEL-A', service: 'Surveillance',
                      client_name: 'Deleted Client', client_email: 'del@example.com',
                      subject_name: 'Subject A', objective: 'Establish whereabouts' });
  await ingest(env, { case_no: 'API-DEL-B', service: 'Surveillance',
                      client_name: 'Stays Put', subject_name: 'Subject B' });

  // Real work on the case, so "preserves records" is testable rather than
  // vacuous: a day, an activity entry, a report and an invoice.
  await call(env, '/cases/API-DEL-A/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-14', start_time: '07:00' } });
  await call(env, '/cases/API-DEL-A/activity', { method: 'POST', cookie: admin,
    body: { at_date: '2026-08-14', at_time: '07:20', description: 'Observed the subject leave.' } });
  await call(env, '/cases/API-DEL-A/day/end', { method: 'POST', cookie: admin,
    body: { end_time: '11:00' } });
  const dayA = (await jsonOf(await call(env, '/cases/API-DEL-A/workspace', { cookie: admin }))).days[0];
  await call(env, '/cases/API-DEL-A/reports/generate', { method: 'POST', cookie: admin,
    body: { day_id: dayA.id } });
  const invA = (await jsonOf(await call(env, '/cases/API-DEL-A/invoices', { method: 'POST',
    cookie: admin, body: {} }))).invoice;

  const rowCount = t => Number(env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first().n);
  const beforeRows = {
    submissions: rowCount('submissions'), activity: rowCount('activity_log'),
    days: rowCount('case_days'), reports: rowCount('case_reports'),
    invoices: rowCount('invoices'),
  };

  const listOf = async (view = '') => await jsonOf(await call(env,
    `/submissions?limit=200${view}`, { cookie: admin }));

  const del = await call(env, '/cases/API-DEL-A/delete', { method: 'POST', cookie: admin,
    body: { reason: 'opened against the wrong client' } });
  ok('an admin can delete a case', del.status === 200, String(del.status));

  /* NOT ONE ROW WENT ANYWHERE. This is the whole point of the feature. */
  ok('the submission row still exists', rowCount('submissions') === beforeRows.submissions);
  ok('the activity log is untouched', rowCount('activity_log') === beforeRows.activity);
  ok('the day is untouched', rowCount('case_days') === beforeRows.days);
  ok('the report is untouched', rowCount('case_reports') === beforeRows.reports);
  ok('the invoice is untouched', rowCount('invoices') === beforeRows.invoices);
  ok('and the invoice is still readable by id',
     (await jsonOf(await call(env, `/invoices/${invA.id}`, { cookie: admin }))).invoice.id === invA.id);

  ok('the deleted case leaves the active list',
     (await listOf()).submissions.map(r => r.case_no).join() === 'API-DEL-B');
  ok('and it is NOT under Archived either — delete reaches further than archive',
     ((await listOf('&view=archived')).submissions || []).every(r => r.case_no !== 'API-DEL-A'));
  const only = await listOf('&view=deleted');
  ok('it is found under the Deleted lens',
     (only.submissions || []).map(r => r.case_no).join() === 'API-DEL-A');
  ok('carrying when it was deleted', (only.submissions[0].deleted_at || '') !== '');

  const ws = await jsonOf(await call(env, '/cases/API-DEL-A/workspace', { cookie: admin }));
  ok('the case still opens in full, or it could never be restored', ws.case_no === 'API-DEL-A');
  ok('with its activity still on it', (ws.activity || []).length === 1);
  ok('and its report', (ws.reports || []).length === 1);
  ok('and it says it is deleted, with who, when and why',
     ws.deleted && ws.deleted.deleted_by === 'Trever'
     && ws.deleted.reason === 'opened against the wrong client', JSON.stringify(ws.deleted));

  ok('deleting twice is a no-op rather than an error',
     (await call(env, '/cases/API-DEL-A/delete', { method: 'POST', cookie: admin, body: {} })).status === 200);
  ok('and the first reason is not overwritten by the second attempt',
     (await jsonOf(await call(env, '/cases/API-DEL-A/workspace', { cookie: admin })))
       .deleted.reason === 'opened against the wrong client');

  const back = await call(env, '/cases/API-DEL-A/undelete', { method: 'POST', cookie: admin, body: {} });
  ok('an admin can put it back', back.status === 200, String(back.status));
  ok('and it returns to the active list',
     (await listOf()).submissions.map(r => r.case_no).sort().join() === 'API-DEL-A,API-DEL-B');
  ok('the Deleted lens is empty again',
     ((await listOf('&view=deleted')).submissions || []).length === 0);

  /* ARCHIVED AND DELETED TOGETHER. A deleted case leaves the Archived lens; put
     back, it is archived again — because deleting never touched the archive. */
  await call(env, '/cases/API-DEL-A/archive', { method: 'POST', cookie: admin, body: {} });
  await call(env, '/cases/API-DEL-A/delete', { method: 'POST', cookie: admin, body: {} });
  ok('an archived case that is deleted leaves Archived',
     ((await listOf('&view=archived')).submissions || []).every(r => r.case_no !== 'API-DEL-A'));
  ok('and shows under Deleted instead',
     (await listOf('&view=deleted')).submissions.map(r => r.case_no).join() === 'API-DEL-A');
  await call(env, '/cases/API-DEL-A/undelete', { method: 'POST', cookie: admin, body: {} });
  ok('undeleting restores it to Archived, because the archive was never touched',
     (await listOf('&view=archived')).submissions.map(r => r.case_no).join() === 'API-DEL-A');
  await call(env, '/cases/API-DEL-A/restore', { method: 'POST', cookie: admin, body: {} });

  /* The Completed desk is an ordinary view too. */
  await call(env, '/submissions/API-DEL-A/status', { method: 'POST', cookie: admin,
    body: { status: 'complete' } });
  ok('a completed case is on the completed desk',
     ((await jsonOf(await call(env, '/completed', { cookie: admin }))).completed || [])
       .some(r => r.case_no === 'API-DEL-A'));
  await call(env, '/cases/API-DEL-A/delete', { method: 'POST', cookie: admin, body: {} });
  ok('deleting takes it off the completed desk as well',
     ((await jsonOf(await call(env, '/completed', { cookie: admin }))).completed || [])
       .every(r => r.case_no !== 'API-DEL-A'));
  await call(env, '/cases/API-DEL-A/undelete', { method: 'POST', cookie: admin, body: {} });
  await call(env, '/cases/API-DEL-A/archive', { method: 'POST', cookie: admin, body: {} });
  ok('and archiving takes it off that desk too',
     ((await jsonOf(await call(env, '/completed', { cookie: admin }))).completed || [])
       .every(r => r.case_no !== 'API-DEL-A'));
  await call(env, '/cases/API-DEL-A/restore', { method: 'POST', cookie: admin, body: {} });

  ok('deleting a case that does not exist is a 404',
     (await call(env, '/cases/API-NOPE-7/delete', { method: 'POST', cookie: admin, body: {} })).status === 404);

  /* Admin-only, and an investigator cannot reach the lens either. */
  const link = (await jsonOf(await invite(env, admin,
    { username: 'del_inv', display_name: 'Field', role: 'investigator' }))).url;
  const tk = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tk}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const field = (await login(env, 'del_inv', 'FieldWork2026x')).cookie;
  ok('an investigator cannot delete',
     (await call(env, '/cases/API-DEL-B/delete', { method: 'POST', cookie: field, body: {} })).status === 403);
  ok('nor undelete',
     (await call(env, '/cases/API-DEL-B/undelete', { method: 'POST', cookie: field, body: {} })).status === 403);
  await call(env, '/submissions/API-DEL-B/assign', { method: 'POST', cookie: admin,
    body: { user_id: (await jsonOf(await call(env, '/auth/me', { cookie: field }))).user.id } });
  await call(env, '/cases/API-DEL-B/delete', { method: 'POST', cookie: admin, body: {} });
  ok('a deleted case leaves the investigator\'s list too',
     ((await jsonOf(await call(env, '/submissions', { cookie: field }))).submissions || [])
       .every(r => r.case_no !== 'API-DEL-B'));
  /* And asking for the deleted lens as an investigator does NOT hand it over —
     it falls back to their ordinary list rather than becoming a way in. */
  ok('and asking for the Deleted lens gives an investigator nothing extra',
     ((await jsonOf(await call(env, '/submissions?view=deleted', { cookie: field }))).submissions || [])
       .every(r => r.case_no !== 'API-DEL-B'));
}

/* A DELETED CASE DOES NOT PARTICIPATE IN WORK (Codex stop-time review,
   2026-08-16 — "deleted cases remain operational and visible in ordinary
   workflow paths").

   Hiding it from the lists was only half of "removes it from normal views".
   Reproduced against the first version: a deleted case could still start a day,
   log activity, raise an invoice and EMAIL THE CLIENT A RATE SHEET — which
   really sent — and it reappeared in Active surveillance, the dashboard alerts
   and the calendar as soon as a day was running on it.

   Reads stay open on purpose: an admin has to be able to look at a deleted case
   to decide whether to put it back, and the workspace is where that button is. */
section('A deleted case cannot be worked on, and stops appearing in working views');
{
  const realFetch = globalThis.fetch;
  let lastBody = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      lastBody = JSON.parse(init.body);
      return new Response('{"id":"re_1"}', { status: 200 });
    }
    return realFetch(url, init);
  };
  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  env.MAIL_PER_MINUTE = '50';
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await call(env, '/payment-methods/venmo', { method: 'POST', cookie: admin,
    body: { enabled: true, display_name: 'Venmo', handle: '@AlwaysPrecise',
            url: 'https://venmo.com/u/AlwaysPrecise' } });
  const link = (await jsonOf(await invite(env, admin,
    { username: 'gone_inv', display_name: 'Field', role: 'investigator' }))).url;
  const tk = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tk}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const field = (await login(env, 'gone_inv', 'FieldWork2026x')).cookie;
  const fieldId = (await jsonOf(await call(env, '/auth/me', { cookie: field }))).user.id;

  await ingest(env, { case_no: 'API-GONE-1', service: 'Surveillance',
                      client_name: 'Gone Client', client_email: 'gone@example.com',
                      subject_name: 'S' });

  /* A RUNNING CLOCK CANNOT BE FILED AWAY (Codex stop-time review, 2026-08-16 —
     "hidden rows can suppress live work").

     Archiving or deleting a case whose day is still open would strand it: the
     case leaves the working views, so nobody sees the clock running, and the
     write gate then refuses the very request that would end it. The
     investigator is left with a clock they cannot stop and an office that
     cannot see them. Both are refused while a day is open, which is also what
     makes hiding the case safe afterwards — nothing live can be behind it. */
  await call(env, '/cases/API-GONE-1/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-16', start_time: '07:00' } });
  ok('a case with a running day IS on Out now',
     JSON.stringify(await jsonOf(await call(env, '/active', { cookie: admin })))
       .includes('API-GONE-1'));
  const delRunning = await call(env, '/cases/API-GONE-1/delete', { method: 'POST',
    cookie: admin, body: {} });
  ok('deleting a case with a day still running is refused', delRunning.status === 409,
     String(delRunning.status));
  ok('and the refusal names the day rather than only saying no',
     /still running/i.test((await jsonOf(delRunning)).error || ''),
     (await jsonOf(delRunning)).error);
  const arcRunning = await call(env, '/cases/API-GONE-1/archive', { method: 'POST',
    cookie: admin, body: {} });
  ok('archiving one is refused for the same reason', arcRunning.status === 409,
     String(arcRunning.status));
  ok('so live work can never be hidden behind either state',
     JSON.stringify(await jsonOf(await call(env, '/active', { cookie: admin })))
       .includes('API-GONE-1'));

  await call(env, '/cases/API-GONE-1/day/end', { method: 'POST', cookie: admin,
    body: { end_time: '12:00' } });
  await call(env, '/cases/API-GONE-1/activity', { method: 'POST', cookie: admin,
    body: { at_date: '2026-08-16', at_time: '07:30', description: 'Observed the subject.' } });
  const invBefore = (await jsonOf(await call(env, '/cases/API-GONE-1/invoices',
    { method: 'POST', cookie: admin, body: {} }))).invoice;
  // An offer made BEFORE the delete, so accepting it afterwards is a real
  // attempt rather than a route that could not be reached anyway.
  await call(env, '/cases/API-GONE-1/offer', { method: 'POST', cookie: admin,
    body: { investigator_id: fieldId, investigation_date: '2026-08-20', expected_hours: 8 } });
  const offer = ((await jsonOf(await call(env, '/my/offers', { cookie: field }))).offers || [])[0];

  ok('with the day ended, the case can be deleted',
     (await call(env, '/cases/API-GONE-1/delete', { method: 'POST', cookie: admin,
       body: { reason: 'opened in error' } })).status === 200);

  const gone = r => r.status === 409;
  ok('a day cannot be started on a deleted case',
     gone(await call(env, '/cases/API-GONE-1/day/start', { method: 'POST', cookie: admin,
       body: { day_date: '2026-08-17', start_time: '08:00' } })));
  ok('activity cannot be logged',
     gone(await call(env, '/cases/API-GONE-1/activity', { method: 'POST', cookie: admin,
       body: { at_date: '2026-08-16', at_time: '07:10', description: 'still logging' } })));
  ok('an invoice cannot be raised',
     gone(await call(env, '/cases/API-GONE-1/invoices', { method: 'POST', cookie: admin, body: {} })));
  ok('an existing invoice cannot be edited by id either — the case number is not in that path',
     gone(await call(env, `/invoices/${invBefore.id}/status`, { method: 'POST', cookie: admin,
       body: { status: 'ready' } })));
  ok('it cannot be assigned',
     gone(await call(env, '/submissions/API-GONE-1/assign', { method: 'POST', cookie: admin,
       body: { user_id: null } })));
  ok('its status cannot be changed',
     gone(await call(env, '/submissions/API-GONE-1/status', { method: 'POST', cookie: admin,
       body: { status: 'complete' } })));
  ok('and it cannot be archived while deleted',
     gone(await call(env, '/cases/API-GONE-1/archive', { method: 'POST', cookie: admin, body: {} })));

  /* OFFERS ARE ADDRESSED BY THEIR OWN ID, and this was the way in the first
     version of the gate missed: accepting assigns the investigator and moves
     the case's stage, on a case the office had deleted. */
  if (offer) {
    ok('an investigator cannot accept an offer on a deleted case',
       gone(await call(env, `/my/offers/${offer.id}/accept`, { method: 'POST', cookie: field, body: {} })));
    ok('nor decline it into a record against that case',
       gone(await call(env, `/my/offers/${offer.id}/decline`, { method: 'POST', cookie: field, body: {} })));
  } else {
    ok('an investigator cannot accept an offer on a deleted case (no offer made)', false,
       'the fixture failed to create an offer');
    ok('nor decline it into a record against that case (no offer made)', false, '');
  }

  /* THE WORST OF WHAT THE FIRST VERSION ALLOWED: a client email from a case the
     office had deleted. The case is named in the BODY here, so the router's
     gate cannot see it and the send route checks for itself. */
  lastBody = null;
  const sheet = await call(env, '/sheets/private_retainer/email', { method: 'POST', cookie: admin,
    body: { to: 'gone@example.com', case_no: 'API-GONE-1', include_intake: true } });
  ok('a rate sheet cannot be emailed against a deleted case', gone(sheet), String(sheet.status));
  ok('and nothing whatsoever was sent', lastBody === null);
  lastBody = null;
  ok('nor can payment instructions',
     gone(await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
       body: { to: 'gone@example.com', case_no: 'API-GONE-1', methods: ['venmo'] } })));
  ok('and nothing was sent for those either', lastBody === null);

  /* The refusal names the way out rather than only saying no. */
  const why = await jsonOf(await call(env, '/cases/API-GONE-1/activity', { method: 'POST',
    cookie: admin, body: { at_date: '2026-08-16', at_time: '09:00', description: 'x' } }));
  ok('the refusal says the case is deleted and how to undo it',
     /deleted/i.test(why.error || '') && /put the case back/i.test(why.error || ''), why.error);
  ok('and is flagged so the page can act on it rather than parse the sentence',
     why.case_deleted === true);

  /* THE SUFFIX TRAP: `/activity/:id/delete` also ends in "delete". Letting it
     through the gate would leave a deleted case's timeline editable. */
  const entry = ((await jsonOf(await call(env, '/cases/API-GONE-1/workspace',
    { cookie: admin }))).activity || [])[0];
  ok('removing an activity entry on a deleted case is refused too',
     Boolean(entry) && gone(await call(env, `/cases/API-GONE-1/activity/${entry.id}/delete`,
       { method: 'POST', cookie: admin, body: {} })));

  /* IT LEAVES THE WORKING VIEWS. */
  ok('it is not in the dashboard alerts',
     !JSON.stringify(await jsonOf(await call(env, '/summary', { cookie: admin })))
       .includes('API-GONE-1'));
  ok('nor on the calendar',
     !JSON.stringify(await jsonOf(await call(env, '/calendar?month=2026-08', { cookie: admin })))
       .includes('API-GONE-1'));

  /* BUT IT CAN STILL BE READ, or it could never be reviewed and put back. */
  ok('the workspace still opens',
     (await call(env, '/cases/API-GONE-1/workspace', { cookie: admin })).status === 200);
  ok('the case record still reads',
     (await call(env, '/submissions/API-GONE-1', { cookie: admin })).status === 200);
  ok('and the invoice can still be read, just not changed',
     (await call(env, `/invoices/${invBefore.id}`, { cookie: admin })).status === 200);

  /* AND THE WAY OUT WORKS. */
  ok('deleting it again is still a no-op, not a refusal',
     (await call(env, '/cases/API-GONE-1/delete', { method: 'POST', cookie: admin, body: {} })).status === 200);
  ok('and putting it back is allowed through the gate',
     (await call(env, '/cases/API-GONE-1/undelete', { method: 'POST', cookie: admin, body: {} })).status === 200);
  ok('after which work resumes',
     (await call(env, '/cases/API-GONE-1/activity', { method: 'POST', cookie: admin,
       body: { at_date: '2026-08-16', at_time: '09:30', description: 'back at it' } })).status === 201);

  /* ARCHIVED GATES WRITES TOO, and that is what closes the suppression hole:
     a case out of the working views cannot also be accumulating work. */
  ok('a case with no day running can be archived',
     (await call(env, '/cases/API-GONE-1/archive', { method: 'POST', cookie: admin, body: {} })).status === 200);
  const arcRefusal = await call(env, '/cases/API-GONE-1/activity', { method: 'POST', cookie: admin,
    body: { at_date: '2026-08-16', at_time: '10:00', description: 'archived, so refused' } });
  ok('and then nothing can be recorded against it', arcRefusal.status === 409,
     String(arcRefusal.status));
  // Read ONCE: a Response body can only be consumed once, and the second read
  // comes back empty — which reads as a failed assertion rather than a bug here.
  const arcBody = await jsonOf(arcRefusal);
  ok('with a refusal naming restore as the way back',
     /restore the case/i.test(arcBody.error || ''), arcBody.error);
  ok('and flagged as archived rather than deleted', arcBody.case_archived === true);
  /* THE BODY-ADDRESSED ROUTES ARE THE HALF THAT WENT MISSING. The two send
     routes name their case in the body, where the router's gate cannot see it,
     so they check for themselves — and the first version taught them only the
     deleted rule. An archived case went on emailing clients and writing
     send_log rows long after every path-addressed write was refused. */
  lastBody = null;
  const arcSheet = await call(env, '/sheets/private_retainer/email', { method: 'POST',
    cookie: admin, body: { to: 'gone@example.com', case_no: 'API-GONE-1', include_intake: true } });
  ok('a rate sheet cannot be emailed against an ARCHIVED case either',
     arcSheet.status === 409, String(arcSheet.status));
  ok('and nothing was sent', lastBody === null);
  lastBody = null;
  const arcPay = await call(env, '/payment-options/email', { method: 'POST', cookie: admin,
    body: { to: 'gone@example.com', case_no: 'API-GONE-1', methods: ['venmo'] } });
  ok('nor payment instructions', arcPay.status === 409, String(arcPay.status));
  ok('and nothing was sent for those either', lastBody === null);
  ok('so no send was recorded against an archived case',
     Number(env.DB.prepare(
       "SELECT COUNT(*) AS n FROM send_log WHERE case_no = 'API-GONE-1'").first().n) === 0);

  ok('an archived case leaves the dashboard alerts too',
     !JSON.stringify(await jsonOf(await call(env, '/summary', { cookie: admin })))
       .includes('API-GONE-1'));
  ok('restoring it lets work resume',
     (await call(env, '/cases/API-GONE-1/restore', { method: 'POST', cookie: admin, body: {} })).status === 200
     && (await call(env, '/cases/API-GONE-1/activity', { method: 'POST', cookie: admin,
       body: { at_date: '2026-08-16', at_time: '10:30', description: 'restored' } })).status === 201);
  ok('and an archived case can still be deleted — delete reaches further',
     (await call(env, '/cases/API-GONE-1/archive', { method: 'POST', cookie: admin, body: {} })).status === 200
     && (await call(env, '/cases/API-GONE-1/delete', { method: 'POST', cookie: admin, body: {} })).status === 200);

  globalThis.fetch = realFetch;
}

/* PACKAGES IS A WORKING VIEW TOO (owner, 2026-08-17).

   `/packages` was the last case-scoped read with no archived/deleted boundary
   at all: `caseSummary`, `outNow` and the calendar filter through
   `hiddenCases()`, and `/completed` excludes both sets in its own SQL. So an
   archived case kept its place on the dashboard's Case packages band with its
   retainer and balance on it — and could reach Today / next actions through the
   `retainer` and `build` sets the page derives from this payload.

   Every assertion carries a live case beside the hidden one, because a filter
   that removed everything would satisfy the negative half on its own. */
section('An archived or deleted case leaves the packages view, and comes back');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  for (const no of ['API-PKG-LIVE', 'API-PKG-ARC', 'API-PKG-DEL']) {
    await ingest(env, { case_no: no, service: 'Surveillance',
                        client_name: 'Pkg Client', subject_name: 'Pkg Subject' });
    await call(env, `/cases/${no}/build`, { method: 'POST', cookie: admin });
  }
  const pkgNos = async () => (await jsonOf(await call(env, '/packages', { cookie: admin })))
    .packages.map(p => p.case_no);

  const before = await pkgNos();
  ok('CONTROL: all three cases with packages are on the view to begin with',
     ['API-PKG-LIVE', 'API-PKG-ARC', 'API-PKG-DEL'].every(n => before.includes(n)),
     JSON.stringify(before));

  ok('the case really was archived',
     (await call(env, '/cases/API-PKG-ARC/archive', { method: 'POST', cookie: admin, body: {} }))
       .status === 200);
  ok('the case really was deleted',
     (await call(env, '/cases/API-PKG-DEL/delete', { method: 'POST', cookie: admin, body: {} }))
       .status === 200);

  const after = await pkgNos();
  ok('an archived case leaves the packages view', !after.includes('API-PKG-ARC'),
     JSON.stringify(after));
  ok('and so does a deleted one', !after.includes('API-PKG-DEL'), JSON.stringify(after));
  ok('CONTROL: the live case beside them is untouched', after.includes('API-PKG-LIVE'),
     JSON.stringify(after));

  /* The dashboard derives Today / next actions from this payload, so the same
     read is what keeps an archived case out of the office's queue. */
  ok('so nothing about them can reach a package-derived next action',
     !JSON.stringify(await jsonOf(await call(env, '/packages', { cookie: admin })))
       .includes('API-PKG-ARC'));

  ok('restoring the archived case puts it back',
     (await call(env, '/cases/API-PKG-ARC/restore', { method: 'POST', cookie: admin, body: {} }))
       .status === 200 && (await pkgNos()).includes('API-PKG-ARC'));
  ok('and undeleting the deleted one puts it back too',
     (await call(env, '/cases/API-PKG-DEL/undelete', { method: 'POST', cookie: admin, body: {} }))
       .status === 200 && (await pkgNos()).includes('API-PKG-DEL'));

  const restored = await pkgNos();
  ok('all three are on the view again, exactly as they started',
     ['API-PKG-LIVE', 'API-PKG-ARC', 'API-PKG-DEL'].every(n => restored.includes(n)),
     JSON.stringify(restored));

  /* The archive semantics themselves are unchanged — this unit filtered a read
     and touched nothing about what archiving means. */
  ok('and the restored case is workable again, so nothing about archiving moved',
     (await call(env, '/cases/API-PKG-ARC/activity', { method: 'POST', cookie: admin,
       body: { at_date: '2026-08-17', at_time: '10:30', description: 'back' } })).status === 201);
}

/* THE DEPLOY ORDER IS A REAL FAILURE MODE HERE. The Worker ships on push;
   `case_archive` arrives on a MANUAL portal-setup dispatch. Between the two the
   table does not exist on the live database, and a join against a missing table
   would take out the case list — the most-used view in the portal, and the same
   shape as the `client_token` column that never reached production. */
section('The case list survives a database that has not been set up yet');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(env, { case_no: 'API-NOARC-1', service: 'Surveillance',
                      client_name: 'Before Setup', subject_name: 'S' });
  // Exactly the state a live database is in between the two deploys.
  env.DB.prepare('DROP TABLE IF EXISTS case_archive').run();
  env.DB.prepare('DROP TABLE IF EXISTS case_deleted').run();

  const res = await call(env, '/submissions?limit=200', { cookie: admin });
  ok('the case list still answers', res.status === 200, String(res.status));
  const body = await jsonOf(res);
  ok('and still lists the case', (body.submissions || []).map(r => r.case_no).join() === 'API-NOARC-1');
  ok('reporting no archive stamp rather than failing',
     (body.submissions || [])[0].archived_at === null);
  ok('the workspace opens too',
     (await call(env, '/cases/API-NOARC-1/workspace', { cookie: admin })).status === 200);
  ok('and reports the case as not archived',
     (await jsonOf(await call(env, '/cases/API-NOARC-1/workspace', { cookie: admin }))).archived === null);
  /* Archiving is REFUSED with a sentence naming the fix, rather than throwing.
     "It did not work" and "run the setup workflow" are different messages. */
  const refused = await call(env, '/cases/API-NOARC-1/archive', { method: 'POST', cookie: admin, body: {} });
  ok('archiving is refused with the reason and the remedy',
     refused.status === 503 && /portal-setup/.test((await jsonOf(refused)).error || ''),
     String(refused.status));
  const refusedDel = await call(env, '/cases/API-NOARC-1/delete', { method: 'POST', cookie: admin, body: {} });
  ok('deleting is refused the same way, with the remedy',
     refusedDel.status === 503 && /portal-setup/.test((await jsonOf(refusedDel)).error || ''),
     String(refusedDel.status));
  ok('and the completed desk still answers rather than going down with them',
     (await call(env, '/completed', { cookie: admin })).status === 200);
  // Health is how the office finds out the dispatch has not been run.
  const health = await jsonOf(await call(env, '/health'));
  ok('health names case_archive',  (health.missing_tables || []).includes('case_archive'));
  ok('and names case_deleted too', (health.missing_tables || []).includes('case_deleted'));
}

/* WHO THE OFFICE WANTS TOLD, AND ABOUT WHAT. Settings and data layer only:
   there is no SMS provider configured anywhere in this Worker, so text delivery
   is blocked on one and says so. */
section('Notification recipients: many numbers, each with its own switches');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  const list = async () => await jsonOf(await call(env, '/notify-recipients', { cookie: admin }));
  const start = await list();
  ok('the office starts with no recipients, not a default one',
     (start.recipients || []).length === 0);
  ok('and the five alert choices are offered by name',
     (start.events || []).map(e => e.id).sort().join() ===
     'intakes,packages,payments,reports,tasks',
     (start.events || []).map(e => e.id).join());

  /* DELIVERY IS STATED, so nobody is left believing a text went out. */
  ok('SMS delivery reports itself blocked on a provider',
     start.delivery.sms === 'blocked_on_provider');
  ok('and says so in words the office can act on',
     /no sms provider is configured/i.test(start.delivery.sms_note || ''), start.delivery.sms_note);
  ok('email reports its own state from the environment, not a guess',
     start.delivery.email === 'blocked_on_provider');   // this env has no RESEND_API_KEY
  const withMail = freshEnv();
  withMail.RESEND_API_KEY = 'test-resend-key';
  await bootstrapAdmin(withMail);
  const mailAdmin = (await login(withMail, 'trever', 'FirstAdminPass1')).cookie;
  ok('and reads as configured where a mail key exists',
     (await jsonOf(await call(withMail, '/notify-recipients', { cookie: mailAdmin })))
       .delivery.email === 'configured');

  /* MULTIPLE PHONE NUMBERS, each its own row, each with its own choices. */
  const made = await call(env, '/notify-recipients', { method: 'POST', cookie: admin,
    body: { label: 'Owner mobile', phone: '555 0100 111', alerts: { payments: true, packages: true } } });
  ok('a recipient can be created', made.status === 201, String(made.status));
  const owner = (await jsonOf(made)).recipient;
  ok('with only the alerts that were chosen',
     owner.alerts.payments === true && owner.alerts.packages === true
     && owner.alerts.intakes === false && owner.alerts.reports === false
     && owner.alerts.tasks === false, JSON.stringify(owner.alerts));
  ok('and enabled by default, because a recipient nobody switched on is a puzzle',
     owner.enabled === true);

  const second = (await jsonOf(await call(env, '/notify-recipients', { method: 'POST',
    cookie: admin, body: { label: 'Second phone', phone: '555 0100 222',
                           alerts: { intakes: true } } }))).recipient;
  const third = (await jsonOf(await call(env, '/notify-recipients', { method: 'POST',
    cookie: admin, body: { label: 'Office inbox', email: 'office@example.com',
                           alerts: { intakes: true, reports: true, tasks: true } } }))).recipient;
  const three = await list();
  ok('several numbers are held at once', (three.recipients || []).length === 3);
  ok('each keeping its OWN choices rather than sharing one setting',
     three.recipients.find(r => r.id === second.id).alerts.intakes === true
     && three.recipients.find(r => r.id === second.id).alerts.payments === false
     && three.recipients.find(r => r.id === owner.id).alerts.payments === true);
  ok('and a recipient can be an email instead of a number',
     three.recipients.find(r => r.id === third.id).email === 'office@example.com');

  /* THE ENABLE TOGGLE IS PER RECIPIENT. */
  await call(env, `/notify-recipients/${second.id}`, { method: 'POST', cookie: admin,
    body: { enabled: false } });
  const afterToggle = await list();
  ok('switching one recipient off leaves the others alone',
     afterToggle.recipients.find(r => r.id === second.id).enabled === false
     && afterToggle.recipients.find(r => r.id === owner.id).enabled === true);
  ok('and switching off does not clear the number or the choices',
     afterToggle.recipients.find(r => r.id === second.id).phone === '555 0100 222'
     && afterToggle.recipients.find(r => r.id === second.id).alerts.intakes === true);

  /* AN ABSENT FIELD MEANS UNCHANGED — the rule the retainer routes learned the
     hard way. Posting one toggle must not blank the address beside it. */
  await call(env, `/notify-recipients/${third.id}`, { method: 'POST', cookie: admin,
    body: { alerts: { tasks: false } } });
  const kept = (await list()).recipients.find(r => r.id === third.id);
  ok('changing one alert leaves the address untouched', kept.email === 'office@example.com');
  ok('and leaves the other alerts as they were',
     kept.alerts.intakes === true && kept.alerts.reports === true && kept.alerts.tasks === false,
     JSON.stringify(kept.alerts));
  ok('and the label survives too', kept.label === 'Office inbox');

  /* REFUSALS, each naming what to do. */
  ok('a recipient with neither an address nor a number is refused',
     (await call(env, '/notify-recipients', { method: 'POST', cookie: admin,
       body: { label: 'Nobody' } })).status === 400);
  ok('an unnamed recipient is refused, so the list can say who is who',
     (await call(env, '/notify-recipients', { method: 'POST', cookie: admin,
       body: { phone: '555 0100 333' } })).status === 400);
  ok('a malformed address is refused before it is stored',
     (await call(env, '/notify-recipients', { method: 'POST', cookie: admin,
       body: { label: 'Typo', email: 'not-an-address' } })).status === 400);
  ok('and a number that is not a number is refused',
     (await call(env, '/notify-recipients', { method: 'POST', cookie: admin,
       body: { label: 'Short', phone: '12' } })).status === 400);

  /* Removing a recipient really removes it: this is CONFIGURATION, not a record
     of something that happened, so the tombstone rule does not apply. */
  ok('a recipient can be removed',
     (await call(env, `/notify-recipients/${second.id}/delete`, { method: 'POST',
       cookie: admin, body: {} })).status === 200);
  ok('and is gone from the list', (await list()).recipients.every(r => r.id !== second.id));
  ok('removing one that does not exist is a 404',
     (await call(env, '/notify-recipients/99999/delete', { method: 'POST',
       cookie: admin, body: {} })).status === 404);

  /* Admin-only, like every other office setting. */
  const link = (await jsonOf(await invite(env, admin,
    { username: 'notify_inv', display_name: 'Field', role: 'investigator' }))).url;
  const tk = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tk}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const field = (await login(env, 'notify_inv', 'FieldWork2026x')).cookie;
  ok('an investigator cannot read the recipients',
     (await call(env, '/notify-recipients', { cookie: field })).status === 403);
  ok('nor add one', (await call(env, '/notify-recipients', { method: 'POST', cookie: field,
       body: { label: 'Me', phone: '555 0100 444' } })).status === 403);
  ok('nor change one', (await call(env, `/notify-recipients/${owner.id}`, { method: 'POST',
       cookie: field, body: { enabled: false } })).status === 403);
  ok('nor remove one', (await call(env, `/notify-recipients/${owner.id}/delete`,
       { method: 'POST', cookie: field, body: {} })).status === 403);
}

/* ALERT TEXT LEAVES THE BUILDING, so what it may carry is the whole question.

   Email goes through Resend; any SMS will go through a carrier and a provider.
   These assert the text says WHAT HAPPENED and WHERE TO LOOK and nothing that
   identifies a person or a matter. */
const ALERT_PREVIEW_CASE_TEXT = 'API-EXAMPLE-0001';
section('Alert text: the case number reaches email and never a text message');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  /* A case loaded with every kind of thing an alert must never repeat. */
  await ingest(env, {
    case_no: 'API-PRIV-1', carrier: 'Confidential Mutual', claim_number: 'CM-90210',
    policy_number: 'POL-55512', client_name: 'Dana Adjuster',
    client_email: 'dana@carrier.example', client_phone: '5550100999',
    subject_name: 'Pat Claimant', subject_address: '14 Elm Row, Roanoke',
    subject_vehicle: 'Blue Ford Ranger', subject_relationship: 'Lumbar strain',
    objective: 'Activity level versus stated restrictions',
    adjuster: 'Dana Adjuster', date_of_loss: '03/14/2026',
  });

  const forbidden = [
    ['the carrier', 'Confidential Mutual'], ['the claim number', 'CM-90210'],
    ['the policy number', 'POL-55512'], ['the client name', 'Dana Adjuster'],
    ['the client email', 'dana@carrier.example'], ['the client phone', '5550100999'],
    ['the claimant', 'Pat Claimant'], ['the address', 'Elm Row'],
    ['the vehicle', 'Ford Ranger'], ['the injury', 'Lumbar strain'],
    ['the objective', 'stated restrictions'], ['the date of loss', '03/14/2026'],
  ];

  const sample = await jsonOf(await call(env, '/notify-recipients', { cookie: admin }));
  /* EVERY event's REAL text, composed by the Worker — not one sample with the
     label swapped, which would prove only that the template is safe and let a
     new event word itself however it liked. Both channels. */
  const everyText = (sample.events || []).map(e => e.preview);
  const everySms = (sample.events || []).map(e => e.preview_sms);
  ok('every alert choice comes with the words it would actually send',
     everyText.length === 5 && everyText.every(t => typeof t === 'string' && t.length > 0),
     JSON.stringify(everyText));
  ok('an alert names what happened',
     everyText.some(t => /intake received/i.test(t)), everyText.join(' | '));
  ok('and where to look',
     everyText.every(t => /sign in to the portal/i.test(t)), everyText.join(' | '));
  ok('and carries the case number, which is the firm\'s own reference',
     everyText.every(t => t.includes('API-EXAMPLE-0001')), everyText.join(' | '));
  ok('the preview case number is obviously not a real case',
     everyText.every(t => /EXAMPLE/.test(t)));

  for (const [what, value] of forbidden) {
    ok(`alert text never carries ${what}`,
       everyText.concat(everySms)
         .every(t => !String(t).toLowerCase().includes(String(value).toLowerCase())),
       everyText.concat(everySms).join(' | ').slice(0, 200));
  }
  ok('and never a money amount',
     everyText.concat(everySms).every(t => !/[$£€]\s*\d/.test(String(t))));

  /* SMS CARRIES NO CASE NUMBER AT ALL (owner, 2026-08-16). Email keeps it — it
     goes to the firm's own inbox through one provider the firm chose. A text
     crosses a carrier network and sits on a lock screen, so it says only what
     happened and to open the portal. */
  ok('every SMS alert says what happened',
     everySms.length === 5 && everySms.every(t => typeof t === 'string' && t.length > 0),
     JSON.stringify(everySms));
  ok('and tells the admin to open the portal',
     everySms.every(t => /open the portal/i.test(t)), everySms.join(' | '));
  ok('and carries NO case number',
     everySms.every(t => !t.includes(ALERT_PREVIEW_CASE_TEXT) && !/\bcase\b/i.test(t)),
     everySms.join(' | '));
  ok('nor anything that looks like a reference at all',
     everySms.every(t => !/[A-Z]{2,}-[A-Z0-9-]{2,}/.test(t) && !/\d{3,}/.test(t)),
     everySms.join(' | '));
  ok('while the email alert still carries the case number, which is where it belongs',
     everyText.every(t => t.includes(ALERT_PREVIEW_CASE_TEXT)), everyText.join(' | '));

  /* THE STRONGEST FORM OF THE RULE: the SMS wording cannot vary with the case,
     because the sms branch never reads it. Filtering a value out can be got
     wrong; having no path for it to arrive cannot. Asserted by asking the
     Worker for previews on two different databases whose example case numbers
     differ only in that the second has a real, loaded case behind it. */
  const other = freshEnv();
  await bootstrapAdmin(other);
  const otherAdmin = (await login(other, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(other, { case_no: 'API-OTHER-9', service: 'Surveillance',
                        client_name: 'Someone Else', subject_name: 'X' });
  const otherSms = ((await jsonOf(await call(other, '/notify-recipients',
    { cookie: otherAdmin }))).events || []).map(e => e.preview_sms);
  ok('the SMS wording is identical whatever case data exists',
     JSON.stringify(otherSms) === JSON.stringify(everySms),
     `${otherSms.join('|')} vs ${everySms.join('|')}`);
  ok('and never mentions a case that does exist',
     otherSms.every(t => !t.includes('API-OTHER-9')), otherSms.join(' | '));

  /* A case number is pinned to the same shape ingest pins it to, so a hostile
     value cannot ride into an alert that may reach a carrier's SMS gateway. */
  ok('a case number of the wrong shape is dropped rather than interpolated',
     !JSON.stringify(sample.sample).includes('<script>'));
}

/* EMAIL ALERTS ACTUALLY GO OUT, to whoever asked for that event and nobody
   else. One recipient per event, so a misrouted alert lands somewhere visible
   instead of being absorbed by a catch-all.

   SMS is still not wired and is not asserted here — there is no provider. */
section('Email alerts reach the recipients who asked for each event');
{
  const realFetch = globalThis.fetch;
  let mails = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      mails.push(JSON.parse(init.body));
      return new Response('{"id":"re_1"}', { status: 200 });
    }
    return realFetch(url, init);
  };
  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  env.MAIL_PER_MINUTE = '200';
  env.INGEST_PER_MINUTE = '200';
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  const addr = {};
  for (const ev of ['intakes', 'payments', 'reports', 'packages', 'tasks']) {
    addr[ev] = `${ev}@example.com`;
    await call(env, '/notify-recipients', { method: 'POST', cookie: admin,
      body: { label: ev, email: addr[ev], alerts: { [ev]: true } } });
  }
  // A phone-only recipient subscribed to everything: SMS has no provider, and
  // emailing someone who asked for texts would be inventing a channel.
  await call(env, '/notify-recipients', { method: 'POST', cookie: admin,
    body: { label: 'Phone only', phone: '555 0100 777',
            alerts: { intakes: true, payments: true, reports: true,
                      packages: true, tasks: true } } });
  await call(env, '/notify-recipients', { method: 'POST', cookie: admin,
    body: { label: 'Switched off', email: 'off@example.com', enabled: false,
            alerts: { intakes: true, payments: true, reports: true,
                      packages: true, tasks: true } } });

  const went = () => mails.map(m => String(m.to));
  const bodies = () => mails.map(m => `${m.subject}\n${m.text}\n${m.html}`).join('\n---\n');
  const only = ev => went().length === 1 && went()[0].includes(addr[ev]);

  /* 1. INTAKES — the public form. */
  mails = [];
  await ingest(env, { case_no: 'API-ALERT-1', service: 'Surveillance',
                      client_name: 'Alert Client', client_email: 'client@example.com',
                      client_phone: '5550100888', subject_name: 'Pat Claimant',
                      subject_address: '14 Elm Row', subject_relationship: 'Lumbar strain',
                      carrier: 'Confidential Mutual', claim_number: 'CM-90210' });
  ok('an intake alerts the recipient who asked for intakes', only('intakes'), went().join(' | '));
  ok('a phone-only recipient is not emailed instead',
     went().every(t => !t.includes('off@example.com')) && !bodies().includes('555 0100 777'));

  /* THE PRIVACY RULE HOLDS ON A REAL SEND, not only in the preview. */
  for (const v of ['Alert Client', 'client@example.com', '5550100888', 'Pat Claimant',
                   'Elm Row', 'Lumbar strain', 'Confidential Mutual', 'CM-90210']) {
    ok(`the intake alert never carries ${v}`,
       !bodies().toLowerCase().includes(v.toLowerCase()), bodies().slice(0, 200));
  }
  ok('it says what happened and carries the case number',
     /new intake received/i.test(bodies()) && bodies().includes('API-ALERT-1'),
     bodies().slice(0, 200));

  /* 2. PAYMENTS — a retainer is the PRIVATE model, and the route refuses a
     claim assignment by name, so this needs its own case. API-ALERT-1 above
     carries a carrier and a claim number precisely to test the privacy rule. */
  mails = [];
  await ingest(env, { case_no: 'API-ALERT-P', service: 'Surveillance',
                      client_name: 'Private Client', subject_name: 'S' });
  mails = [];
  await call(env, '/cases/API-ALERT-P/retainer/payment', { method: 'POST', cookie: admin,
    body: { amount: 1500, method: 'check', paid_on: '2026-08-16', reference: 'cheque 9' } });
  ok('a recorded payment alerts the payments recipient', only('payments'), went().join(' | '));
  ok('and never says how much — the amount is commercial',
     !/1,?500/.test(bodies()) && !/[$£€]\s*\d/.test(bodies()), bodies().slice(0, 200));
  ok('nor the cheque reference', !bodies().includes('cheque 9'));

  /* 3. REPORTS — the hand-off for review, not every status move. */
  await call(env, '/cases/API-ALERT-1/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-16', start_time: '07:00' } });
  await call(env, '/cases/API-ALERT-1/activity', { method: 'POST', cookie: admin,
    body: { at_date: '2026-08-16', at_time: '07:20', description: 'Observed the subject.' } });
  await call(env, '/cases/API-ALERT-1/day/end', { method: 'POST', cookie: admin,
    body: { end_time: '11:00' } });
  const day = (await jsonOf(await call(env, '/cases/API-ALERT-1/workspace',
    { cookie: admin }))).days[0];
  mails = [];
  const rep = await jsonOf(await call(env, '/cases/API-ALERT-1/reports/generate',
    { method: 'POST', cookie: admin, body: { day_id: day.id } }));
  ok('generating a report alerts nobody — it is not the hand-off',
     went().length === 0, went().join(' | '));
  mails = [];
  await call(env, `/cases/API-ALERT-1/reports/${rep.id}/status`, { method: 'POST',
    cookie: admin, body: { status: 'submitted' } });
  ok('submitting it for review alerts the reports recipient', only('reports'), went().join(' | '));
  ok('and the alert carries no line of the report itself',
     !bodies().includes('Observed the subject'), bodies().slice(0, 200));
  mails = [];
  await call(env, `/cases/API-ALERT-1/reports/${rep.id}/status`, { method: 'POST',
    cookie: admin, body: { status: 'approved' } });
  ok('approving it does not alert again', went().length === 0, went().join(' | '));

  /* 4. PACKAGES — finalized, not opened. */
  mails = [];
  await call(env, '/cases/API-ALERT-1/build', { method: 'POST', cookie: admin,
    body: { package_type: 'report_only' } });
  ok('opening a build alerts nobody', went().length === 0, went().join(' | '));
  const build = (await jsonOf(await call(env, '/cases/API-ALERT-1/build',
    { cookie: admin }))).build;
  mails = [];
  const fin = await call(env, `/build/${build.id}/finalize`, { method: 'POST',
    cookie: admin, body: {} });
  ok('the package finalizes', fin.status === 200,
     `${fin.status}: ${JSON.stringify(await jsonOf(fin)).slice(0, 200)}`);
  ok('and finalizing alerts the packages recipient', only('packages'), went().join(' | '));

  /* 5. TASKS — important ones only. */
  mails = [];
  await call(env, '/cases/API-ALERT-1/tasks', { method: 'POST', cookie: admin,
    body: { task: 'Ordinary follow-up', priority: 'normal' } });
  ok('a normal task alerts nobody — that is how an alert stays worth reading',
     went().length === 0, went().join(' | '));
  mails = [];
  await call(env, '/cases/API-ALERT-1/tasks', { method: 'POST', cookie: admin,
    body: { task: 'Call the adjuster before Friday', priority: 'high' } });
  ok('a high-priority task alerts the tasks recipient', only('tasks'), went().join(' | '));
  ok('and never repeats what the task says',
     !bodies().includes('Call the adjuster'), bodies().slice(0, 200));
  mails = [];
  await call(env, '/cases/API-ALERT-1/tasks', { method: 'POST', cookie: admin,
    body: { task: 'Urgent thing', priority: 'urgent' } });
  ok('an urgent one does too', only('tasks'), went().join(' | '));

  /* THE SWITCHES ARE OBEYED, which is the whole point of storing them. */
  const rec = (await jsonOf(await call(env, '/notify-recipients', { cookie: admin })))
    .recipients.find(r => r.label === 'intakes');
  await call(env, `/notify-recipients/${rec.id}`, { method: 'POST', cookie: admin,
    body: { enabled: false } });
  mails = [];
  await ingest(env, { case_no: 'API-ALERT-2', service: 'Surveillance',
                      client_name: 'Second', subject_name: 'S' });
  ok('switching a recipient off stops their alerts', went().length === 0, went().join(' | '));

  await call(env, `/notify-recipients/${rec.id}`, { method: 'POST', cookie: admin,
    body: { enabled: true, alerts: { intakes: false, payments: true } } });
  mails = [];
  await ingest(env, { case_no: 'API-ALERT-3', service: 'Surveillance',
                      client_name: 'Third', subject_name: 'S' });
  ok('unticking one event stops that event without stopping the recipient',
     went().length === 0, went().join(' | '));
  mails = [];
  await call(env, '/cases/API-ALERT-3/retainer/payment', { method: 'POST', cookie: admin,
    body: { amount: 100, method: 'cash' } });
  ok('while the event they DID tick still reaches them',
     went().some(t => t.includes(addr.intakes)), went().join(' | '));

  globalThis.fetch = realFetch;
}

/* AN ALERT IS A COURTESY AND MUST NEVER FAIL THE THING IT REPORTS — the same
   rule logSend follows, for the same reason. */
section('A failing mail provider cannot break an intake or a payment');
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) throw new Error('provider down');
    return realFetch(url, init);
  };
  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await call(env, '/notify-recipients', { method: 'POST', cookie: admin,
    body: { label: 'Everyone', email: 'all@example.com',
            alerts: { intakes: true, payments: true } } });

  ok('the intake is still accepted while the provider is down',
     (await ingest(env, { case_no: 'API-ALERT-DOWN', service: 'Surveillance',
                          client_name: 'Still Recorded', subject_name: 'S' })).status === 200);
  ok('and the case really is on file',
     (await call(env, '/submissions/API-ALERT-DOWN', { cookie: admin })).status === 200);
  ok('a payment is still recorded too',
     (await call(env, '/cases/API-ALERT-DOWN/retainer/payment', { method: 'POST',
       cookie: admin, body: { amount: 250, method: 'cash' } })).status === 200);
  ok('and the money really is on the ledger',
     ((await jsonOf(await call(env, '/cases/API-ALERT-DOWN/workspace', { cookie: admin })))
       .authorization.retainer.payments || []).length === 1);

  globalThis.fetch = realFetch;
}

/* NOTHING TO TELL, OR NOTHING TO TELL IT WITH: silent, and still working. */
section('Alerts are silent when there is nobody to tell or no provider');
{
  const realFetch = globalThis.fetch;
  let tried = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) { tried++; return new Response('{}', { status: 200 }); }
    return realFetch(url, init);
  };
  const noKey = freshEnv();                       // no RESEND_API_KEY at all
  await bootstrapAdmin(noKey);
  ok('an intake with no mail provider still records',
     (await ingest(noKey, { case_no: 'API-QUIET-1', service: 'Surveillance',
                            client_name: 'Quiet', subject_name: 'S' })).status === 200);
  ok('and nothing was attempted', tried === 0, String(tried));

  const noOne = freshEnv();
  noOne.RESEND_API_KEY = 'test-resend-key';
  await bootstrapAdmin(noOne);
  tried = 0;
  ok('an intake with a provider but no recipients still records',
     (await ingest(noOne, { case_no: 'API-QUIET-2', service: 'Surveillance',
                            client_name: 'Quiet', subject_name: 'S' })).status === 200);
  ok('and still sends nothing', tried === 0, String(tried));
  globalThis.fetch = realFetch;
}

/* A TEST CASE NEVER REACHES ANYBODY'S PHONE OR INBOX (INTAKE-OPS.md §1).

   The spec puts it in terms: "a test intake producing a real email or SMS is
   the failure this feature is most likely to have, so it is what the tests must
   prove cannot happen." Before this guard it DID happen — a TEST- case number
   posted to public /ingest returned 200 and sent.

   Everything here runs with a real provider key and a real subscribed
   recipient, so a silent result means the guard, never a missing key. */
section('A TEST- case can never alert, however it is worked');
{
  const realFetch = globalThis.fetch;
  let mails = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      mails.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
    }
    return realFetch(url, init);
  };

  const env = freshEnv();
  env.RESEND_API_KEY = 'test-resend-key';
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await call(env, '/notify-recipients', { method: 'POST', cookie: admin,
    body: { label: 'Everything', email: 'desk@example.com',
            alerts: { intakes: true, payments: true, reports: true,
                      packages: true, tasks: true } } });

  /* The control FIRST, so a silent run cannot be mistaken for a working one.
     If this does not send, nothing below proves anything. */
  mails = [];
  await ingest(env, { case_no: 'API-REAL-1', service: 'Surveillance',
                      client_name: 'Real Client', subject_name: 'S' });
  ok('CONTROL: a real intake does reach the office', mails.length === 1,
     JSON.stringify(mails.map(m => m.subject)));

  mails = [];
  ok('a TEST- intake is still accepted and recorded',
     (await ingest(env, { case_no: 'TEST-20260817-1', service: 'Surveillance',
                          client_name: 'Demo Client', subject_name: 'S' })).status === 200);
  ok('and it alerted nobody', mails.length === 0,
     JSON.stringify(mails.map(m => m.subject)));

  /* The prefix is matched case-insensitively so its reach matches SQLite's
     LIKE in DEMO_LIKE: nothing /demo-case/clear would sweep away can have
     emailed the office first. */
  mails = [];
  await ingest(env, { case_no: 'test-20260817-2', service: 'Surveillance',
                      client_name: 'Demo Client', subject_name: 'S' });
  ok('a lower-case test- prefix is silent too, matching what the sweep deletes',
     mails.length === 0, JSON.stringify(mails.map(m => m.subject)));

  /* THE REAL EXPOSURE WAS NEVER INGEST — it was a test case being WORKED.
     createDemoCase happens not to call notifyAdmins; every one of these does. */
  mails = [];
  const tkTest = await call(env, '/cases/TEST-20260817-1/tasks', { method: 'POST',
    cookie: admin, body: { task: 'Urgent thing', priority: 'urgent' } });
  ok('the urgent task really was created — a refused write proves nothing',
     tkTest.status === 200 || tkTest.status === 201, String(tkTest.status));
  ok('and it alerted nobody', mails.length === 0,
     JSON.stringify(mails.map(m => m.subject)));

  mails = [];
  const payTest = await call(env, '/cases/TEST-20260817-1/retainer/payment', {
    method: 'POST', cookie: admin, body: { amount: 500, method: 'cash' } });
  ok('the payment really was recorded', payTest.status === 200, String(payTest.status));
  ok('and it alerted nobody either', mails.length === 0,
     JSON.stringify(mails.map(m => m.subject)));

  /* And the work still really happened — the guard silences the courtesy, it
     does not refuse the write. */
  ok('the test case is on file all the same',
     (await call(env, '/submissions/TEST-20260817-1', { cookie: admin })).status === 200);
  ok('and its payment is really on the ledger',
     ((await jsonOf(await call(env, '/cases/TEST-20260817-1/workspace', { cookie: admin })))
       .authorization.retainer.payments || []).length === 1);

  /* CONTROL AGAIN, at the end: the office is still reachable, so every silence
     above was the prefix and not a harness that had stopped working. */
  mails = [];
  await call(env, '/cases/API-REAL-1/tasks', { method: 'POST', cookie: admin,
    body: { task: 'Urgent thing', priority: 'urgent' } });
  ok('CONTROL: the same action on a real case does alert', mails.length === 1,
     JSON.stringify(mails.map(m => m.subject)));

  globalThis.fetch = realFetch;
}

/* TWO ADMINS OUT ON ONE CASE AT ONCE (owner, WORKFLOW-SIMPLIFICATION §5).

   The data layer already allowed this: `startDay` checks for an existing open
   day scoped to `investigator_id = user.id`, not to the case, and the only
   unique index in the area is one open PAUSE per DAY — already per session. So
   nothing about concurrency needed building. What needed fixing is the rule the
   owner named: "never let one Admin silently stop or overwrite the other
   Admin's work." */
section('Two admins can be out on one case, and neither can stop the other by accident');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const a = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, a,
    { username: 'second_admin', display_name: 'Second Admin', role: 'admin' }))).url;
  const tk = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tk}/accept`, { method: 'POST', body: { password: 'SecondAdmin2026x' } });
  const b = (await login(env, 'second_admin', 'SecondAdmin2026x')).cookie;

  await ingest(env, { case_no: 'API-2ADM', service: 'Surveillance',
                      client_name: 'Shared Case', subject_name: 'S' });

  /* BOTH RUNNING AT ONCE, on the same case. */
  ok('the first admin can start a day',
     (await call(env, '/cases/API-2ADM/day/start', { method: 'POST', cookie: a,
       body: { day_date: '2026-08-16', start_time: '07:00' } })).status === 201);
  ok('and the second can start their own on the SAME case',
     (await call(env, '/cases/API-2ADM/day/start', { method: 'POST', cookie: b,
       body: { day_date: '2026-08-16', start_time: '07:30' } })).status === 201);
  const out = await jsonOf(await call(env, '/active', { cookie: a }));
  ok('Out now shows both sessions, not one',
     out.out_now.filter(d => d.case_no === 'API-2ADM').length === 2,
     String(out.out_now.length));
  ok('each is attributed to the admin who started it',
     new Set(out.out_now.map(d => d.investigator)).size === 2,
     out.out_now.map(d => d.investigator).join(','));

  /* AND EACH CONTROL REACHES ONLY ITS OWN SESSION. */
  const dayOf = async ck => (await jsonOf(await call(env, '/my/active', { cookie: ck }))).active;
  const aDay = await dayOf(a), bDay = await dayOf(b);
  ok('each admin\'s own view shows their own day', aDay && bDay && aDay.id !== bDay.id,
     JSON.stringify([aDay && aDay.id, bDay && bDay.id]));

  await call(env, '/cases/API-2ADM/day/pause', { method: 'POST', cookie: a, body: {} });
  const bAfterAPaused = await dayOf(b);
  ok('one admin pausing does not pause the other',
     !bAfterAPaused.paused_at, JSON.stringify(bAfterAPaused.paused_at));
  await call(env, '/cases/API-2ADM/day/resume', { method: 'POST', cookie: a, body: {} });

  ok('the second admin ending their day leaves the first running',
     (await call(env, '/cases/API-2ADM/day/end', { method: 'POST', cookie: b,
       body: { end_time: '11:00' } })).status === 200
     && Boolean(await dayOf(a)));
  ok('and Out now is down to the one still going',
     (await jsonOf(await call(env, '/active', { cookie: a })))
       .out_now.filter(d => d.case_no === 'API-2ADM').length === 1);

  /* THE DESK ADMIN CANNOT END THE FIELD ADMIN BY PRESS. B has no day of their
     own now, so the ordinary End is exactly the accident this fixes. */
  const press = await call(env, '/cases/API-2ADM/day/end', { method: 'POST', cookie: b,
    body: { end_time: '12:00' } });
  ok('an admin with no session of their own cannot End someone else\'s',
     press.status === 409, String(press.status));
  const why = await jsonOf(press);
  ok('and is told whose it is', /trever/i.test(why.error || ''), why.error);
  ok('and that a separate action exists', /end their session/i.test(why.error || ''), why.error);
  ok('flagged for the page', why.other_session === true);
  ok('the other admin is still out', Boolean(await dayOf(a)));
  ok('pausing someone else\'s is refused the same way',
     (await call(env, '/cases/API-2ADM/day/pause', { method: 'POST', cookie: b, body: {} })).status === 409);
  ok('and so is resuming it',
     (await call(env, '/cases/API-2ADM/day/resume', { method: 'POST', cookie: b, body: {} })).status === 409);
  ok('after all that refusing, the day is still running — refusing is not closing',
     (await jsonOf(await call(env, '/active', { cookie: a })))
       .out_now.filter(d => d.case_no === 'API-2ADM').length === 1);

  /* THE SEPARATE, EXPLICIT ACTION STILL WORKS. No reason is asked for. */
  const takeover = await call(env, '/cases/API-2ADM/day/end-other', { method: 'POST', cookie: b,
    body: { end_time: '12:00' } });
  /* No reason is asked for (owner): the body carries only the end time, and the
     confirmation on the page is the deliberate act. */
  ok('the separate action ends the other admin\'s session, with no reason asked for',
     takeover.status === 200, String(takeover.status));
  ok('Out now is empty afterwards',
     (await jsonOf(await call(env, '/active', { cookie: a })))
       .out_now.filter(d => d.case_no === 'API-2ADM').length === 0);
  const ws = await jsonOf(await call(env, '/cases/API-2ADM/workspace', { cookie: a }));
  ok('the hours stay credited to the admin who actually worked them',
     ws.days.every(d => d.hours != null) && ws.days.length === 2,
     JSON.stringify(ws.days.map(d => [d.investigator_id, d.hours])));

  /* THE CONFIRMATION MUST NAME THE SESSION IT ENDS (Codex stop-time review,
     2026-08-16).

     The page draws one button per running session, each labelled with a
     different person. The request used to name nobody and the Worker took the
     NEWEST open day — so with two admins out, the button saying "Bea" ended
     Cal's. Reproduced exactly that way. */
  await ingest(env, { case_no: 'API-3ADM', service: 'Surveillance',
                      client_name: 'Three Up', subject_name: 'S' });
  const cLink = (await jsonOf(await invite(env, a,
    { username: 'third_admin', display_name: 'Cal Newer', role: 'admin' }))).url;
  const cTk = new URL(cLink, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${cTk}/accept`, { method: 'POST', body: { password: 'ThirdAdmin2026x' } });
  const c = (await login(env, 'third_admin', 'ThirdAdmin2026x')).cookie;

  await call(env, '/cases/API-3ADM/day/start', { method: 'POST', cookie: b,
    body: { day_date: '2026-08-17', start_time: '07:00' } });   // the OLDER session
  await call(env, '/cases/API-3ADM/day/start', { method: 'POST', cookie: c,
    body: { day_date: '2026-08-17', start_time: '08:00' } });   // the NEWER one
  const openTwo = ((await jsonOf(await call(env, '/cases/API-3ADM/workspace', { cookie: a })))
    .days || []).filter(d => !d.end_time);
  ok('two other admins are out on the same case', openTwo.length === 2, String(openTwo.length));
  const older = openTwo.find(d => /Second Admin/.test(d.investigator || ''));
  const newer = openTwo.find(d => /Cal Newer/.test(d.investigator || ''));
  ok('and the older one is not the one the Worker would reach by default',
     Boolean(older && newer) && older.id < newer.id);

  /* AND THE CALLER'S OWN SESSION MUST NOT PREEMPT THE NAMED ONE (Codex
     stop-time review, 2026-08-16).

     `openDayForAction` answers "your own running day" first, and that ran for
     every caller. On this route it is exactly wrong: two admins out on one case
     is what the feature is FOR, so the admin pressing "End Bea's session" HAS a
     day of their own — and the shortcut handed back that day and ended it.
     Reproduced: Trever pressed the button labelled "Bea Older", carrying Bea's
     day_id, and Trever's own clock stopped while Bea and Cal stayed out. */
  await ingest(env, { case_no: 'API-3OWN', service: 'Surveillance',
                      client_name: 'Caller Too', subject_name: 'S' });
  await call(env, '/cases/API-3OWN/day/start', { method: 'POST', cookie: b,
    body: { day_date: '2026-08-17', start_time: '07:00' } });
  await call(env, '/cases/API-3OWN/day/start', { method: 'POST', cookie: c,
    body: { day_date: '2026-08-17', start_time: '08:00' } });
  await call(env, '/cases/API-3OWN/day/start', { method: 'POST', cookie: a,
    body: { day_date: '2026-08-17', start_time: '09:00' } });   // the CALLER's own
  const three = ((await jsonOf(await call(env, '/cases/API-3OWN/workspace', { cookie: a })))
    .days || []).filter(d => !d.end_time);
  ok('the caller has a session of their own alongside the others', three.length === 3,
     String(three.length));
  const theirs = three.find(d => /Second Admin/.test(d.investigator || ''));
  ok('ending a NAMED session does not end the caller\'s own instead',
     (await call(env, '/cases/API-3OWN/day/end-other', { method: 'POST', cookie: a,
       body: { end_time: '12:00', day_id: theirs.id } })).status === 200);
  const afterOwn = ((await jsonOf(await call(env, '/cases/API-3OWN/workspace', { cookie: a })))
    .days || []).filter(d => !d.end_time);
  ok('the named session is the one that ended',
     afterOwn.every(d => d.id !== theirs.id), afterOwn.map(d => d.investigator).join(','));
  ok('and the caller is still out, with their own clock running',
     afterOwn.some(d => /Trever/.test(d.investigator || '')),
     afterOwn.map(d => d.investigator).join(','));
  ok('as is the admin nobody named', afterOwn.some(d => /Cal Newer/.test(d.investigator || '')),
     afterOwn.map(d => d.investigator).join(','));

  /* NAMING NOBODY IS NOW REFUSED rather than guessed. */
  const guess = await call(env, '/cases/API-3ADM/day/end-other', { method: 'POST', cookie: a,
    body: { end_time: '12:00' } });
  ok('ending "whichever" is refused while more than one session is running',
     guess.status === 409, String(guess.status));
  const gBody = await jsonOf(guess);
  ok('and the refusal says why rather than just failing',
     /which one/i.test(gBody.error || ''), gBody.error);
  ok('flagged as ambiguous for the page', gBody.ambiguous === true);
  ok('and nothing was ended by the refusal',
     ((await jsonOf(await call(env, '/cases/API-3ADM/workspace', { cookie: a }))).days || [])
       .filter(d => !d.end_time).length === 2);

  /* NAMING THE OLDER SESSION ENDS THE OLDER SESSION — the whole defect. */
  ok('naming a session ends that one',
     (await call(env, '/cases/API-3ADM/day/end-other', { method: 'POST', cookie: a,
       body: { end_time: '12:00', day_id: older.id } })).status === 200);
  const left = ((await jsonOf(await call(env, '/cases/API-3ADM/workspace', { cookie: a })))
    .days || []).filter(d => !d.end_time);
  ok('and the OTHER admin is still out — not the newest by accident',
     left.length === 1 && /Cal Newer/.test(left[0].investigator || ''),
     left.map(d => d.investigator).join(','));

  ok('a session id from another case is refused',
     (await call(env, '/cases/API-2ADM/day/end-other', { method: 'POST', cookie: a,
       body: { end_time: '12:00', day_id: left[0].id } })).status === 409);
  ok('and one already ended is refused rather than silently re-ended',
     (await call(env, '/cases/API-3ADM/day/end-other', { method: 'POST', cookie: a,
       body: { end_time: '12:00', day_id: older.id } })).status === 409);
  ok('the ordinary End still cannot address someone else\'s day by id',
     (await call(env, '/cases/API-3ADM/day/end', { method: 'POST', cookie: a,
       body: { end_time: '12:00', day_id: left[0].id } })).status === 409);
  ok('and that day is still running after the attempt',
     ((await jsonOf(await call(env, '/cases/API-3ADM/workspace', { cookie: a }))).days || [])
       .filter(d => !d.end_time).length === 1);

  /* An investigator can never reach the separate action. */
  const iLink = (await jsonOf(await invite(env, a,
    { username: 'twoadm_inv', display_name: 'Field', role: 'investigator' }))).url;
  const iTk = new URL(iLink, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${iTk}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const inv = (await login(env, 'twoadm_inv', 'FieldWork2026x')).cookie;
  ok('an investigator cannot end anyone else\'s session',
     (await call(env, '/cases/API-2ADM/day/end-other', { method: 'POST', cookie: inv,
       body: { end_time: '12:00' } })).status === 403);
}

/* EDIT CASE (owner, 2026-08-16). Until now nothing could change a case's own
   identity: every UPDATE submissions SET touched only assigned_to and status,
   so a name typed wrong at intake stayed wrong for the life of the case. */
section('A case can be corrected, and its number never changes');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(env, { case_no: 'API-EDIT-1', service: 'Surveillance',
                      client_name: 'Mistyped Nmae', client_email: 'wrong@example.com',
                      client_phone: '5550100111', subject_name: 'Subject Wrong',
                      subject_address: '1 Old Road', objective: 'Establish whereabouts' });

  const ws = async () => await jsonOf(await call(env, '/cases/API-EDIT-1/workspace', { cookie: admin }));
  const sub = async () => (await jsonOf(await call(env, '/submissions/API-EDIT-1',
    { cookie: admin }))).submission;

  /* THE SINGLE NUMBER THAT WAS ALREADY THERE READS AS THE LIST, with nothing
     backfilled — a case nobody has edited answers as it always did. */
  const before = await ws();
  ok('the existing single phone reads through as the list',
     before.phones.client.length === 1 && before.phones.client[0].number === '5550100111',
     JSON.stringify(before.phones.client));
  ok('and is marked as the legacy value rather than a saved row',
     before.phones.client[0].legacy === true && before.phones.client[0].id === null);

  const fix = await call(env, '/cases/API-EDIT-1/edit', { method: 'POST', cookie: admin,
    body: { client_name: 'Jane Correct', client_email: 'jane@example.com',
            subject_name: 'Subject Right', subject_address: '2 New Street' } });
  ok('an admin can correct the case', fix.status === 200, String(fix.status));
  const s1 = await sub();
  ok('the client name is corrected', s1.client_name === 'Jane Correct');
  ok('and the email', s1.client_email === 'jane@example.com');
  ok('and the subject', s1.subject_name === 'Subject Right');
  ok('the payload is corrected too, so the screen and the list cannot disagree',
     (s1.payload || {}).client_name === 'Jane Correct'
     && (s1.payload || {}).subject_address === '2 New Street',
     JSON.stringify([(s1.payload || {}).client_name, (s1.payload || {}).subject_address]));

  /* AN ABSENT FIELD MEANS UNCHANGED. */
  await call(env, '/cases/API-EDIT-1/edit', { method: 'POST', cookie: admin,
    body: { client_email: 'jane2@example.com' } });
  const s2 = await sub();
  ok('changing one field leaves the others alone',
     s2.client_name === 'Jane Correct' && s2.subject_name === 'Subject Right'
     && s2.client_email === 'jane2@example.com',
     JSON.stringify([s2.client_name, s2.subject_name, s2.client_email]));
  ok('and does not blank the phone that was never posted',
     s2.client_phone === '5550100111', String(s2.client_phone));

  /* THE CASE NUMBER IS READ-ONLY — posting one changes nothing. */
  await call(env, '/cases/API-EDIT-1/edit', { method: 'POST', cookie: admin,
    body: { case_no: 'API-RENAMED', client_name: 'Jane Correct' } });
  ok('a case number in the body is ignored, not obeyed',
     (await call(env, '/submissions/API-EDIT-1', { cookie: admin })).status === 200
     && (await call(env, '/submissions/API-RENAMED', { cookie: admin })).status === 404);

  /* MULTIPLE PHONES, WITH LABELS, FOR THE CLIENT. */
  const many = await call(env, '/cases/API-EDIT-1/edit', { method: 'POST', cookie: admin,
    body: { client_phones: [ { number: '555 0100 222', label: 'mobile' },
                             { number: '555 0100 333', label: 'work' },
                             { number: '555 0100 444' } ] } });
  ok('several client numbers can be held at once', many.status === 200, String(many.status));
  const p1 = (await ws()).phones.client;
  ok('all three are kept, in the order they were entered',
     p1.length === 3 && p1[0].number === '555 0100 222' && p1[2].number === '555 0100 444',
     JSON.stringify(p1.map(x => x.number)));
  ok('with their labels', p1[0].label === 'mobile' && p1[1].label === 'work');
  ok('and a number with no label is allowed', p1[2].label === '');
  ok('they are saved rows now, not the legacy read-through',
     p1.every(x => x.legacy !== true && x.id != null));

  /* THE LEGACY COLUMN IS MIRRORED, so everything that already reads it keeps
     working without knowing this table exists. */
  ok('the first number is mirrored back into the case row',
     (await sub()).client_phone === '555 0100 222', String((await sub()).client_phone));

  ok('a number that is not a number is refused',
     (await call(env, '/cases/API-EDIT-1/edit', { method: 'POST', cookie: admin,
       body: { client_phones: [{ number: '12' }] } })).status === 400);
  ok('and an invented label is refused',
     (await call(env, '/cases/API-EDIT-1/edit', { method: 'POST', cookie: admin,
       body: { client_phones: [{ number: '555 0100 555', label: 'pager' }] } })).status === 400);
  ok('the refusal left the saved list untouched',
     (await ws()).phones.client.length === 3);
  ok('a bad email is refused too',
     (await call(env, '/cases/API-EDIT-1/edit', { method: 'POST', cookie: admin,
       body: { client_email: 'not-an-address' } })).status === 400);

  /* SUBJECT NUMBERS HANG OFF THE SUBJECT, because a case can watch more than
     one person and their numbers must not pool. */
  const madeSub = await jsonOf(await call(env, '/cases/API-EDIT-1/subjects', { method: 'POST',
    cookie: admin, body: { name: 'Watched One', phone: '5550100777' } }));
  const subId = madeSub.id || (madeSub.subject && madeSub.subject.id);
  ok('a subject can be added', Boolean(subId), JSON.stringify(madeSub).slice(0, 120));
  const wsSub = await ws();
  ok('their existing single number reads through as well',
     (wsSub.phones.subject[String(subId)] || [])[0].number === '5550100777',
     JSON.stringify(wsSub.phones.subject));
  await call(env, '/cases/API-EDIT-1/edit', { method: 'POST', cookie: admin,
    body: { subject_phones: { [String(subId)]: [ { number: '555 0100 888', label: 'home' },
                                                 { number: '555 0100 999', label: 'other' } ] } } });
  const wsSub2 = await ws();
  ok('a subject can hold several numbers of their own',
     (wsSub2.phones.subject[String(subId)] || []).length === 2,
     JSON.stringify(wsSub2.phones.subject));
  ok('and the client list is untouched by a subject edit',
     wsSub2.phones.client.length === 3);
  ok('the subject row keeps a mirrored primary number too',
     Number(env.DB.prepare('SELECT COUNT(*) AS n FROM case_subjects WHERE phone = ?')
       .bind('555 0100 888').first().n) === 1);
  ok('a subject id from another case is refused',
     (await call(env, '/cases/API-EDIT-1/edit', { method: 'POST', cookie: admin,
       body: { subject_phones: { '99999': [{ number: '555 0100 000' }] } } })).status === 400);

  /* Admin-only, like every other office correction. */
  const link = (await jsonOf(await invite(env, admin,
    { username: 'edit_inv', display_name: 'Field', role: 'investigator' }))).url;
  const tk = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${tk}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const field = (await login(env, 'edit_inv', 'FieldWork2026x')).cookie;
  ok('an investigator cannot edit a case',
     (await call(env, '/cases/API-EDIT-1/edit', { method: 'POST', cookie: field,
       body: { client_name: 'Hacked' } })).status === 403);

  /* THE CLIENT'S NUMBERS ARE THE CLIENT'S IDENTITY. `redactRow` has always kept
     `client_phone` from an investigator, and a list of them is the same fact in
     plural — an investigator who leaves must not leave with the client list.
     The SUBJECT's numbers are fieldwork and do reach them: the subject is who
     is watched, never who is paying. */
  const fieldId = (await jsonOf(await call(env, '/auth/me', { cookie: field }))).user.id;
  await call(env, '/submissions/API-EDIT-1/assign', { method: 'POST', cookie: admin,
    body: { user_id: fieldId } });
  const fieldWs = await jsonOf(await call(env, '/cases/API-EDIT-1/workspace', { cookie: field }));
  ok('an investigator receives no client numbers at all',
     (fieldWs.phones.client || []).length === 0, JSON.stringify(fieldWs.phones.client));
  ok('and none of them appears anywhere in their payload',
     !JSON.stringify(fieldWs).includes('555 0100 222')
     && !JSON.stringify(fieldWs).includes('555 0100 333'),
     JSON.stringify(fieldWs).slice(0, 200));
  ok('but the subject numbers they need for the fieldwork do reach them',
     (fieldWs.phones.subject[String(subId)] || []).length === 2,
     JSON.stringify(fieldWs.phones.subject));
  ok('editing a case that does not exist is a 404',
     (await call(env, '/cases/API-NOPE-4/edit', { method: 'POST', cookie: admin,
       body: { client_name: 'X' } })).status === 404);
}

/* EDITING A CASE MUST NOT ERASE ITS AUTHORIZATION (Codex stop-time review,
   2026-08-16).

   `/cases/:no/meta` was replace-all: `num(undefined)` is null, so a caller that
   posted only a case type wrote NULL over `authorized_hours` and
   `authorized_budget` and was told it succeeded. The Authorization form always
   posts all three, so nothing noticed — until Edit Case began sending just the
   type, at which point correcting a client's NAME would silently erase the
   hours a carrier had authorised. */
section('Editing a case leaves the authorization alone');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(env, { case_no: 'API-AUTH-KEEP', carrier: 'Keeper Mutual',
                      claim_number: 'KM-1', client_name: 'Adj', subject_name: 'S' });

  const auth = async () => (await jsonOf(await call(env, '/cases/API-AUTH-KEEP/workspace',
    { cookie: admin }))).authorization;
  await call(env, '/cases/API-AUTH-KEEP/meta', { method: 'POST', cookie: admin,
    body: { authorized_hours: 24, authorized_budget: 3300 } });
  const set = await auth();
  ok('the carrier authorization is on the case',
     set.authorized_hours === 24 && set.authorized_budget === 3300,
     JSON.stringify([set.authorized_hours, set.authorized_budget]));

  /* THE DEFECT, EXACTLY: a save that names only the case type. */
  const type = (await jsonOf(await call(env, '/case-types', { cookie: admin }))).case_types[0];
  ok('posting only a case type is accepted',
     (await call(env, '/cases/API-AUTH-KEEP/meta', { method: 'POST', cookie: admin,
       body: { case_type_id: type ? type.id : '' } })).status === 200);
  const after = await auth();
  ok('and the authorized hours survive it',
     after.authorized_hours === 24, String(after.authorized_hours));
  ok('as does the authorized budget',
     after.authorized_budget === 3300, String(after.authorized_budget));

  /* And the same through the door the office actually uses. */
  ok('editing the case identity is accepted',
     (await call(env, '/cases/API-AUTH-KEEP/edit', { method: 'POST', cookie: admin,
       body: { client_name: 'Renamed Adjuster' } })).status === 200);
  const afterEdit = await auth();
  ok('correcting a name does not erase the authorization',
     afterEdit.authorized_hours === 24 && afterEdit.authorized_budget === 3300,
     JSON.stringify([afterEdit.authorized_hours, afterEdit.authorized_budget]));

  /* BLANK STILL CLEARS, or the Authorization form could never remove a figure.
     An explicit empty string is the office saying there is none; an ABSENT key
     is the office not mentioning it. The two used to be the same thing. */
  await call(env, '/cases/API-AUTH-KEEP/meta', { method: 'POST', cookie: admin,
    body: { authorized_hours: '', authorized_budget: '' } });
  const cleared = await auth();
  ok('an explicit blank still clears the hours', cleared.authorized_hours == null,
     String(cleared.authorized_hours));
  ok('and the budget', cleared.authorized_budget == null, String(cleared.authorized_budget));

  /* The case type is the same rule, both ways. */
  await call(env, '/cases/API-AUTH-KEEP/meta', { method: 'POST', cookie: admin,
    body: { case_type_id: type ? type.id : '' } });
  await call(env, '/cases/API-AUTH-KEEP/meta', { method: 'POST', cookie: admin,
    body: { authorized_hours: 8 } });
  const keptType = await auth();
  ok('a save that never mentions the case type keeps it',
     Boolean(keptType.case_type) === Boolean(type), String(keptType.case_type));
  ok('while the figure that WAS named is written', keptType.authorized_hours === 8,
     String(keptType.authorized_hours));

  /* AND A PARTIAL UPDATE MUST NOT CLOBBER A CONCURRENT ONE (Codex stop-time
     review, 2026-08-16).

     The first fix for this read the row, then wrote every column back. Two
     admins posting different subsets interleave as A reads, B reads, A writes,
     B writes — and B's write puts back the value A had just changed, on a field
     B never mentioned. Nobody is told.

     Simulated honestly rather than by wishing: another admin's write is dropped
     in DURING the request, right after any read of case_meta. A statement that
     resolves the untouched fields from the ROW keeps that change; one that
     resolves them from an earlier read overwrites it. */
  await call(env, '/cases/API-AUTH-KEEP/meta', { method: 'POST', cookie: admin,
    body: { authorized_hours: 24, authorized_budget: 3300 } });

  const realPrepare = env.DB.prepare.bind(env.DB);
  let injected = false;
  env.DB.prepare = sql => {
    const stmt = realPrepare(sql);
    if (/SELECT[\s\S]*case_meta/i.test(sql)) {
      const realFirst = stmt.first, realAll = stmt.all;
      const inject = () => {
        if (injected) return;
        injected = true;
        // The other admin's edit, landing mid-request.
        realPrepare('UPDATE case_meta SET authorized_budget = 9999 WHERE case_no = ?')
          .bind('API-AUTH-KEEP').run();
      };
      const wrap = fn => function (...a) { const r = fn.apply(this, a); inject(); return r; };
      stmt.first = wrap(realFirst);
      stmt.all = wrap(realAll);
      const realBind = stmt.bind;
      stmt.bind = function (...p) {
        const b = realBind.apply(this, p);
        b.first = wrap(realFirst); b.all = wrap(realAll);
        return b;
      };
    }
    return stmt;
  };
  // This admin changes only the HOURS and never mentions the budget.
  await call(env, '/cases/API-AUTH-KEEP/meta', { method: 'POST', cookie: admin,
    body: { authorized_hours: 16 } });
  env.DB.prepare = realPrepare;

  const raced = await auth();
  ok('the concurrent edit landed during the request', injected === true);
  ok('a field this request never mentioned keeps the OTHER admin\'s value',
     raced.authorized_budget === 9999, String(raced.authorized_budget));
  ok('and the field it did mention is written',
     raced.authorized_hours === 16, String(raced.authorized_hours));
}

/* THE PHONE TABLE ARRIVES ON A MANUAL DISPATCH, so the case screen must keep
   working — and the numbers already on the case must still be readable. */
section('Phone lists degrade to the existing single number before setup');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(env, { case_no: 'API-NOPH-1', service: 'Surveillance',
                      client_name: 'Before Setup', client_phone: '5550100123',
                      subject_name: 'S' });
  env.DB.prepare('DROP TABLE IF EXISTS case_phone').run();

  const res = await call(env, '/cases/API-NOPH-1/workspace', { cookie: admin });
  ok('the case screen still opens', res.status === 200, String(res.status));
  const body = await jsonOf(res);
  ok('and the number that was always there is still shown',
     body.phones.client.length === 1 && body.phones.client[0].number === '5550100123',
     JSON.stringify(body.phones));
  ok('the rest of the edit still works before the dispatch',
     (await call(env, '/cases/API-NOPH-1/edit', { method: 'POST', cookie: admin,
       body: { client_name: 'Renamed Anyway' } })).status === 200);
  ok('health names the missing table, which is how the office finds out',
     ((await jsonOf(await call(env, '/health'))).missing_tables || []).includes('case_phone'));
}

/* NO NUMBER AND NO PROVIDER CREDENTIAL IS EVER WRITTEN INTO THE SOURCE. The
   owner asked for this in the same breath as the feature, and a grep is the
   only check that keeps holding as the file grows. */
section('No recipient number or provider secret is hardcoded');
{
  const src = fs.readFileSync(path.join(HERE, 'worker.js'), 'utf8');
  /* Deliberately narrow: long digit runs that look like a dialable number,
     ignoring the millisecond and byte constants that legitimately appear. */
  const suspicious = (src.match(/\+\d[\d\s().-]{8,}\d/g) || [])
    .filter(s => s.replace(/[^\d]/g, '').length >= 9);
  ok('no telephone number is written into the Worker', suspicious.length === 0,
     suspicious.join(' | '));
  ok('no SMS provider credential is written into the Worker',
     !/(twilio|vonage|nexmo|messagebird|plivo)/i.test(src));
  ok('every secret the alert path reads comes from the environment',
     /env\.RESEND_API_KEY/.test(src) && !/sk_live|AC[0-9a-f]{32}/i.test(src));

  const schema = fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8');
  ok('and the schema seeds no default recipient',
     !/INSERT\s+INTO\s+notify_recipient/i.test(schema));
}

/* ---------------------------------------------- video timestamp, device-first

   Owner, 2026-08-17: video is DEVICE-FIRST. A clip stays on the device that
   shot it, the timestamped copy is rendered in that device's browser and saved
   back to it, and the portal keeps the RECORD and nothing else. Legacy video
   already in R2 was deliberately left untouched. */
section('Video is device-first');
{
  const env = freshEnv();
  // A bucket, so the photo that IS still stored genuinely goes somewhere.
  const store = new Map();
  env.EVIDENCE = {
    async put(key, body) { store.set(key, { body }); },
    async get(key) { const o = store.get(key); return o ? { body: o.body } : null; },
    async delete(key) { store.delete(key); },
    _store: store,
  };
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  for (const [uname, display] of [['dana', 'Dana'], ['reed', 'Reed']]) {
    const l = (await jsonOf(await invite(env, admin,
      { username: uname, display_name: display, role: 'investigator' }))).url;
    const t = new URL(l, 'https://x.test').searchParams.get('invite');
    await call(env, `/invite/${t}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  }
  const dana = (await login(env, 'dana', 'FieldWork2026x')).cookie;
  const reed = (await login(env, 'reed', 'FieldWork2026x')).cookie;
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const danaId = users.users.find(u => u.username === 'dana').id;

  await ingest(env, { case_no: 'API-VS1', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  await call(env, '/submissions/API-VS1/assign', { method: 'POST', cookie: admin,
    body: { user_id: danaId } });

  const upload = (cookie, name, type, bytes = 400) => {
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array(bytes).fill(65)], name, { type }));
    return worker.fetch(new Request(API + '/cases/API-VS1/evidence', {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie }, body: fd }), env);
  };

  /* NO NEW VIDEO BYTE BECOMES CLOUDFLARE STORAGE. Refused in the Worker, not by
     a page hiding a button — a property enforced by a page is enforced by
     nothing. */
  const vres = await upload(dana, 'clip.mp4', 'video/mp4');
  const vbody = await jsonOf(vres);
  ok('a video upload is refused', vres.status === 400);
  ok('and says why, by a code the page can act on', vbody.code === 'video_device_first');
  ok('and points at the timestamp screen rather than a dead end',
     /Video timestamp/i.test(vbody.error) && /device/i.test(vbody.error));
  ok('every video container is refused, not just mp4',
     (await upload(dana, 'c.mov', 'video/quicktime')).status === 400
     && (await upload(dana, 'c.webm', 'video/webm')).status === 400
     && (await upload(dana, 'c.mkv', 'video/x-matroska')).status === 400);
  ok('nothing was written for any of them',
     (await env.DB.prepare('SELECT COUNT(*) AS n FROM case_evidence WHERE case_no = ?')
       .bind('API-VS1').first()).n === 0);

  /* THE REFUSAL IS BY TYPE AND ONLY BY TYPE. A big video is refused as a video,
     not sent away with advice about splitting it up that no longer applies. */
  const big = await upload(dana, 'huge.mp4', 'video/mp4', 3000);
  ok('an over-size video is refused as a video, before the size rule',
     big.status === 400 && (await jsonOf(big)).code === 'video_device_first');

  ok('a photograph is unaffected', (await upload(dana, 'still.jpg', 'image/jpeg')).status === 201);
  ok('and so is a document', (await upload(dana, 'notes.pdf', 'application/pdf')).status === 201);

  /* LEGACY VIDEO IN R2 IS UNTOUCHED. This PR refuses new writes and deletes
     nothing — a row that was already there still reads, still serves and still
     counts against the storage meter. */
  const legacy = await plantLegacyVideo(env, 'API-VS1', 'old-clip.mp4', 'client_deliverable', 900);
  const ws0 = await jsonOf(await call(env, '/cases/API-VS1/workspace', { cookie: dana }));
  ok('a video stored before the change is still on the case',
     ws0.evidence.some(e => e.id === legacy && e.content_type === 'video/mp4'));
  ok('and still counts against the storage meter',
     (await jsonOf(await call(env, '/storage', { cookie: admin }))).storage.bytes_used >= 900);

  // ---- the record of a generated copy ----
  const post = (cookie, body, caseNo = 'API-VS1') =>
    call(env, `/cases/${caseNo}/video-stamp`, { method: 'POST', cookie, body });

  const start = '2026-08-17T21:14:32.000Z';   // 05:14:32 PM EDT
  const made = await post(dana, { original_name: 'DSC_0001.MOV', original_size: 51200000,
    original_hash: 'a'.repeat(64), start_utc: start, tz: 'America/New_York',
    derivative_name: 'DSC_0001-timestamped.webm' });
  const madeBody = await jsonOf(made);
  ok('the investigator records the copy they made', made.status === 201 && madeBody.id > 0);
  const rec = madeBody.stamps[0];
  ok('the chosen instant is stored as an instant, not as typed text',
     rec.start_utc === start);
  ok('and the zone it was entered in is stored beside it', rec.tz === 'America/New_York');
  ok('with who made it and when', rec.generated_by_name === 'Dana' && !!rec.generated_at);
  ok('the copy is not recorded as saved until it has been',
     rec.saved_at === null && rec.superseded_at === null);
  ok('and the fingerprint of the original rode along', rec.original_hash === 'a'.repeat(64));

  ok('a start time that cannot be read is refused',
     (await post(dana, { original_name: 'x.mov', start_utc: 'sometime tuesday' })).status === 400);
  ok('a made-up time zone is refused',
     (await post(dana, { original_name: 'x.mov', start_utc: start, tz: 'Mars/Olympus' })).status === 400);
  ok('a record with no original named is refused',
     (await post(dana, { start_utc: start })).status === 400);
  ok('a junk fingerprint is dropped rather than stored as one',
     (await jsonOf(await post(dana, { original_name: 'nohash.mov', start_utc: start,
       original_hash: 'not a hash' }))).stamps[0].original_hash === null);

  /* THE ACCESS BOUNDARY IS THE EVIDENCE BOUNDARY. An investigator may timestamp
     only video on a case they already reach, and the record is never a way in. */
  ok('an unassigned investigator cannot record against the case',
     (await post(reed, { original_name: 'x.mov', start_utc: start })).status === 404);
  ok('nor read its records',
     (await call(env, '/cases/API-VS1/video-stamps', { cookie: reed })).status === 404);
  ok('the assigned investigator can read them',
     (await jsonOf(await call(env, '/cases/API-VS1/video-stamps', { cookie: dana }))).stamps.length >= 1);

  // ---- correcting the time: a new row, the old one superseded ----
  const corrected = '2026-08-17T22:14:32.000Z';
  const again = await jsonOf(await post(dana, { original_name: 'DSC_0001.MOV',
    start_utc: corrected, tz: 'America/New_York', derivative_name: 'DSC_0001-timestamped.webm' }));
  const mine = again.stamps.filter(r => r.original_name === 'DSC_0001.MOV');
  ok('a correction inserts a record rather than editing one', mine.length === 2);
  ok('the newest is the active one', mine[0].superseded_at === null && mine[0].start_utc === corrected);
  ok('and the one it replaced is kept, stamped', !!mine[1].superseded_at && mine[1].start_utc === start);
  ok('a different original is left alone by it',
     again.stamps.filter(r => r.original_name === 'nohash.mov')
       .every(r => r.superseded_at === null));

  // ---- saved is the operator's word, written once ----
  const active = mine[0].id;
  const saved1 = await jsonOf(await call(env, `/cases/API-VS1/video-stamp/${active}/saved`,
    { method: 'POST', cookie: dana }));
  const at = saved1.stamps.find(r => r.id === active).saved_at;
  ok('marking it saved records when the file reached a device', !!at);
  const saved2 = await jsonOf(await call(env, `/cases/API-VS1/video-stamp/${active}/saved`,
    { method: 'POST', cookie: dana }));
  ok('a second tap does not move the moment it was saved',
     saved2.stamps.find(r => r.id === active).saved_at === at);
  ok('a record on another case cannot be marked saved from this one',
     (await call(env, `/cases/API-VS1/video-stamp/999999/saved`,
       { method: 'POST', cookie: dana })).status === 404);

  // ---- the workspace carries them, so the Evidence tab needs no second call ----
  const ws = await jsonOf(await call(env, '/cases/API-VS1/workspace', { cookie: dana }));
  ok('the workspace carries the records', Array.isArray(ws.video_stamps) && ws.video_stamps.length === 3);
  ok('and still no video byte is in the portal for them',
     ws.evidence.filter(e => String(e.content_type || '').startsWith('video/')).length === 1);

  /* THE TABLE HOLDS METADATA AND AUDIT ONLY. There is no blob column and there
     must never be one — checked against the schema itself, not against a
     comment about it. */
  const schema = fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8');
  const tbl = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS video_stamp'));
  const decl = tbl.slice(0, tbl.indexOf(');'));
  ok('the video_stamp table has no blob column', !/\bBLOB\b/i.test(decl), decl.slice(0, 200));
  ok('and nothing in the Worker writes video bytes to it',
     !/INSERT INTO video_stamp[\s\S]{0,400}?(blob|bytes|data)\b/i.test(
       fs.readFileSync(path.join(HERE, 'worker.js'), 'utf8')));
}

/* A deleted or archived case does not participate in work, and that has to hold
   for a route added after the gate was written — which is the whole point of
   its being ONE chokepoint rather than a check in each route. */
section('Video timestamp obeys the deleted and archived gate');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(env, { case_no: 'API-VS-DEL', service: 'Surveillance', client_name: 'C' });
  await ingest(env, { case_no: 'API-VS-ARC', service: 'Surveillance', client_name: 'C' });
  const body = { original_name: 'x.mov', start_utc: '2026-08-17T21:14:32.000Z' };

  await call(env, '/cases/API-VS-DEL/delete', { method: 'POST', cookie: admin });
  const d = await call(env, '/cases/API-VS-DEL/video-stamp', { method: 'POST', cookie: admin, body });
  ok('a deleted case records nothing', d.status === 409 && (await jsonOf(d)).case_deleted === true);

  await call(env, '/cases/API-VS-ARC/archive', { method: 'POST', cookie: admin });
  const a = await call(env, '/cases/API-VS-ARC/video-stamp', { method: 'POST', cookie: admin, body });
  ok('an archived case records nothing either', a.status === 409 && (await jsonOf(a)).case_archived === true);
  ok('but a deleted case can still be READ, which is how it gets put back',
     (await call(env, '/cases/API-VS-DEL/video-stamps', { cookie: admin })).status === 200);
}

/* The schema arrives by a MANUAL portal-setup dispatch while the Worker deploys
   on push, so between the two this table does not exist on the live database.
   The read degrades; the write names the workflow; the case list survives. */
section('Video timestamp on a database that has not been set up');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(env, { case_no: 'API-VS-NS', service: 'Surveillance', client_name: 'C' });
  await env.DB.prepare('DROP TABLE video_stamp').run();

  ok('health names the missing table',
     (await jsonOf(await call(env, '/health'))).missing_tables.includes('video_stamp'));
  const list = await jsonOf(await call(env, '/cases/API-VS-NS/video-stamps', { cookie: admin }));
  ok('the list degrades rather than failing', Array.isArray(list.stamps) && list.not_set_up === true);
  const w = await call(env, '/cases/API-VS-NS/video-stamp', { method: 'POST', cookie: admin,
    body: { original_name: 'x.mov', start_utc: '2026-08-17T21:14:32.000Z' } });
  ok('the write says which workflow to run', w.status === 503 && /portal-setup/.test((await jsonOf(w)).error));
  const ws = await call(env, '/cases/API-VS-NS/workspace', { cookie: admin });
  ok('and the workspace still loads', ws.status === 200
     && Array.isArray((await jsonOf(ws)).video_stamps));
  ok('as does the case list', (await call(env, '/submissions', { cookie: admin })).status === 200);
}


/* ---------------------------------------------------- Dropbox OAuth

   Owner, 2026-08-18: connect and callback for the company App Folder, secrets
   only, no file migration yet.

   Every outbound call is intercepted, so nothing in this suite reaches Dropbox
   and no real credential exists anywhere in it. */
/* --------------------------------- Dropbox as storage for NEW case files

   Owner, 2026-08-18: "Use connected Dropbox App Folder as storage for NEW case
   photos and generated reports/PDFs", with case folders Photos, Reports and
   Video; do not migrate or delete old R2 files; keep D1 for structured case
   data; and if Dropbox is unavailable, refuse the upload rather than falling
   back to R2 or double-writing. */
/* ------------------------------- how an activity was captured (VOICE §3)

   Owner, 2026-08-18: "Track voice-created activity entries with an idempotent
   companion metadata table instead of altering the existing activity_log
   table."

   §3 calls this the most important requirement: a voice command must create a
   REAL activity record through the existing API, carrying `source = voice`.
   §11 and §12 are the other half of it — a voice entry is not privileged, and
   must edit and remove exactly like any other. */
section('Voice §3: a voice entry is a real entry, marked but not privileged');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const l = (await jsonOf(await invite(env, admin,
    { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const t = new URL(l, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${t}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const danaId = users.users.find((u) => u.username === 'dana').id;
  const dana = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  await ingest(env, { case_no: 'API-VOX1', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  await call(env, '/submissions/API-VOX1/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });

  const add = (body, cookie) => call(env, '/cases/API-VOX1/activity',
    { method: 'POST', cookie: cookie || dana,
      body: { at_date: '2026-08-18', at_time: '09:15', kind: 'activity', ...body } });

  const spoken = await jsonOf(await add({
    description: 'No change observed at the residence.',
    source: 'voice', command_id: 'NO_CHANGE_RESIDENCE',
    heard: 'Mobile, no change at residence.' }));
  ok('a voice command creates a real activity entry', typeof spoken.id === 'number');

  const typed = await jsonOf(await add({ description: 'Typed by hand at the desk.' }));
  ok('and so does an ordinary one', typeof typed.id === 'number');

  /* THE SAME TABLE, THE SAME API. §3: "This uses the SAME existing Activity API
     and data model as manual activity." */
  ok('both are rows in the one activity table',
     (await env.DB.prepare('SELECT COUNT(*) AS n FROM activity_log WHERE case_no = ?')
       .bind('API-VOX1').first()).n === 2);

  const src = await env.DB.prepare(
    'SELECT source, command_id, heard FROM activity_source WHERE entry_id = ?').bind(spoken.id).first();
  ok('the voice one is marked as captured by voice', src && src.source === 'voice');
  ok('with the canonical command that produced it', src.command_id === 'NO_CHANGE_RESIDENCE');
  /* §5 — the transcript is diagnostic metadata and must never REPLACE the
     standardized text. Both are kept, and the entry itself reads as the
     standard sentence. */
  ok('the raw transcript is kept beside it, not instead of it',
     src.heard === 'Mobile, no change at residence.'
     && (await env.DB.prepare('SELECT description FROM activity_log WHERE id = ?')
          .bind(spoken.id).first()).description === 'No change observed at the residence.');
  ok('a typed entry has no source row at all',
     (await env.DB.prepare('SELECT COUNT(*) AS n FROM activity_source WHERE entry_id = ?')
       .bind(typed.id).first()).n === 0);

  /* A CLOSED LIST, matching the CHECK on the column. An unknown value is
     dropped rather than stored, so this cannot become a free-text field. */
  const odd = await jsonOf(await add({ description: 'Odd source.', source: 'telepathy' }));
  ok('an unknown source is dropped, and the entry is still made',
     typeof odd.id === 'number'
     && (await env.DB.prepare('SELECT COUNT(*) AS n FROM activity_source WHERE entry_id = ?')
          .bind(odd.id).first()).n === 0);

  /* THE WORKSPACE CARRIES IT, for both roles — an investigator can see that
     their own entry came from voice. */
  let ws = await jsonOf(await call(env, '/cases/API-VOX1/workspace', { cookie: dana }));
  let row = ws.activity.find((a) => a.id === spoken.id);
  ok('the workspace says how the entry was captured',
     row.source === 'voice' && row.command_id === 'NO_CHANGE_RESIDENCE');
  ok('and says nothing about a typed one',
     !ws.activity.find((a) => a.id === typed.id).source);
  /* THE TRANSCRIPT DOES NOT RIDE ALONG. It is stored for the office to consult
     when an entry and what was said disagree; nothing surfaces it yet, and a
     payload is not the place to start. */
  ok('the raw transcript is not in the workspace payload',
     !JSON.stringify(ws).includes('Mobile, no change at residence.'));

  /* §11 — NOT PRIVILEGED. The same edit and the same removal, by the same
     rules, as an entry typed by hand. */
  ok('a voice entry edits exactly like any other',
     (await call(env, `/cases/API-VOX1/activity/${spoken.id}`, { method: 'POST', cookie: dana,
       body: { description: 'No change observed at the residence. Corrected.' } })).status === 200);
  ok('and its source survives the edit, because that is how it was captured',
     (await env.DB.prepare('SELECT source FROM activity_source WHERE entry_id = ?')
       .bind(spoken.id).first()).source === 'voice');
  ok('a voice entry removes exactly like any other',
     (await call(env, `/cases/API-VOX1/activity/${spoken.id}/delete`,
       { method: 'POST', cookie: dana })).status === 200);
  ws = await jsonOf(await call(env, '/cases/API-VOX1/workspace', { cookie: dana }));
  ok('and comes back stamped removed, the same as any other',
     !!ws.activity.find((a) => a.id === spoken.id).removed_at);

  /* THE TABLE ARRIVES BY A MANUAL DISPATCH, so the Worker must work without it
     — and the thing that must never be lost is the investigator's entry. */
  const bare = freshEnv();
  await bootstrapAdmin(bare);
  const a2 = (await login(bare, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(bare, { case_no: 'API-VOX2', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  await bare.DB.prepare('DROP TABLE activity_source').run();
  const made = await jsonOf(await call(bare, '/cases/API-VOX2/activity', { method: 'POST', cookie: a2,
    body: { at_date: '2026-08-18', at_time: '10:00', kind: 'activity',
            description: 'Said before the schema caught up.', source: 'voice' } }));
  ok('without the table the entry is still made, and keeps its words',
     typeof made.id === 'number');
  ok('health names the missing table rather than hiding it',
     (await jsonOf(await call(bare, '/health'))).missing_tables.includes('activity_source'));
  const ws2 = await jsonOf(await call(bare, '/cases/API-VOX2/workspace', { cookie: a2 }));
  ok('and the workspace still loads, with no source on the entry',
     ws2.activity.length === 1 && !ws2.activity[0].source);
}

/* ------------------------- correcting an entry without losing the rest

   Found while building SURVEILLANCE-VOICE §10, which corrects the most recent
   activity from the field screen without navigating away. `editActivity` was
   REPLACE-ALL, and nothing had noticed because the timeline's Edit form was
   the only caller and it always posts all four fields. A screen that corrects
   only the wording would have written NULL over the location and the vehicle
   the investigator recorded — and been told it succeeded.

   Same rule, same words, as `/cases/:no/meta`: an ABSENT field means
   unchanged, a BLANK STRING still clears. */
section('Correcting the wording of an entry leaves the rest of it alone');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(env, { case_no: 'API-ED1', service: 'Surveillance', client_name: 'C', subject_name: 'S' });

  const made = await jsonOf(await call(env, '/cases/API-ED1/activity', { method: 'POST', cookie: admin,
    body: { at_date: '2026-08-18', at_time: '10:42', kind: 'activity',
            description: 'No chnage observed at the residence.',
            location: '14 Mill Lane', vehicle: 'Grey van, VA ABC-1234',
            internal_note: 'Parked two doors down.' } }));
  const read = async () => env.DB.prepare(
    'SELECT description, location, vehicle, internal_note FROM activity_log WHERE id = ?')
    .bind(made.id).first();

  let row = await read();
  ok('the entry is stored with everything the field recorded',
     row.location === '14 Mill Lane' && row.vehicle === 'Grey van, VA ABC-1234'
     && row.internal_note === 'Parked two doors down.');

  /* THE DEFECT. Only the wording is corrected — which is exactly what §10's
     screen sends — and everything else must survive it. */
  ok('a wording-only correction is accepted',
     (await call(env, `/cases/API-ED1/activity/${made.id}`, { method: 'POST', cookie: admin,
       body: { description: 'No change observed at the residence.' } })).status === 200);
  row = await read();
  ok('the wording is corrected', row.description === 'No change observed at the residence.');
  ok('and the location, vehicle and note are all still there',
     row.location === '14 Mill Lane' && row.vehicle === 'Grey van, VA ABC-1234'
     && row.internal_note === 'Parked two doors down.',
     JSON.stringify(row));

  /* A BLANK STRING STILL CLEARS — the operator saying there is no location,
     which is how the full form removes one. Only an ABSENT key is left alone. */
  await call(env, `/cases/API-ED1/activity/${made.id}`, { method: 'POST', cookie: admin,
    body: { description: 'No change observed at the residence.', location: '' } });
  row = await read();
  ok('a blank location clears it, because that is the operator saying so',
     row.location === null);
  ok('and the fields the request did not mention are still untouched',
     row.vehicle === 'Grey van, VA ABC-1234' && row.internal_note === 'Parked two doors down.');

  /* The full form still replaces everything it sends, as it always did. */
  await call(env, `/cases/API-ED1/activity/${made.id}`, { method: 'POST', cookie: admin,
    body: { description: 'Corrected again.', location: 'Corner of Mill and High',
            vehicle: '', internal_note: '' } });
  row = await read();
  ok('the full form still sets and clears exactly what it sends',
     row.location === 'Corner of Mill and High' && row.vehicle === null
     && row.internal_note === null);

  /* An entry still cannot lose its description — the one field that has to be
     there is still required, however little else is sent. */
  ok('a correction cannot empty the entry',
     (await call(env, `/cases/API-ED1/activity/${made.id}`, { method: 'POST', cookie: admin,
       body: { description: '   ' } })).status === 400);
  ok('and nothing about the entry moved when it was refused',
     (await read()).description === 'Corrected again.');
}

/* ------------------------- §8's other half: a retry is not a second entry

   §8: "Retries caused by connection/offline synchronisation must also not
   create duplicates." The browser cannot do this half — a POST that landed and
   whose response was lost is indistinguishable from one that never arrived. So
   the client names each utterance and keeps that name across retries, and this
   side answers with the entry that already exists. */
section('Voice §8: the same utterance twice is one entry, however it arrives');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(env, { case_no: 'API-EVT1', service: 'Surveillance', client_name: 'C', subject_name: 'S' });

  const send = (body) => call(env, '/cases/API-EVT1/activity', { method: 'POST', cookie: admin,
    body: { at_date: '2026-08-18', at_time: '11:00', kind: 'activity', ...body } });
  const count = async () =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE case_no = 'API-EVT1'")
      .first()).n;

  const first = await jsonOf(await send({
    description: 'No change observed at the residence.', source: 'voice',
    command_id: 'NO_CHANGE_RESIDENCE', event_id: 'evt-aaaaaaaa1111' }));
  ok('the first arrival creates the entry', typeof first.id === 'number' && !first.duplicate);
  ok('and it is one row', (await count()) === 1);

  /* THE RETRY. Same utterance, same name, and the client cannot know whether
     the first one landed. */
  const again = await jsonOf(await send({
    description: 'No change observed at the residence.', source: 'voice',
    command_id: 'NO_CHANGE_RESIDENCE', event_id: 'evt-aaaaaaaa1111' }));
  ok('the retry writes nothing', (await count()) === 1);
  ok('and answers with the entry that already exists',
     again.id === first.id && again.duplicate === true, JSON.stringify(again));

  /* A DIFFERENT UTTERANCE IS A DIFFERENT ENTRY, even with identical words —
     the investigator may genuinely have said it twice. */
  const twice = await jsonOf(await send({
    description: 'No change observed at the residence.', source: 'voice',
    command_id: 'NO_CHANGE_RESIDENCE', event_id: 'evt-bbbbbbbb2222' }));
  ok('the same words under a new name are a new entry',
     twice.id !== first.id && (await count()) === 2);

  /* AN ENTRY WITHOUT A NAME still works — every manual entry is one, and the
     quick buttons do not mint event ids. */
  const plain = await jsonOf(await send({ description: 'Typed by hand.' }));
  ok('an entry with no event id is unaffected',
     typeof plain.id === 'number' && (await count()) === 3);

  const rows = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM activity_voice_event').first();
  ok('only the named utterances are recorded as events', rows.n === 2, String(rows.n));

  /* THE TABLE ARRIVES BY A MANUAL DISPATCH, so the Worker must work without it,
     and what must never be lost is the entry. */
  const bare = freshEnv();
  await bootstrapAdmin(bare);
  const a2 = (await login(bare, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(bare, { case_no: 'API-EVT2', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  await bare.DB.prepare('DROP TABLE activity_voice_event').run();
  const madeA = await jsonOf(await call(bare, '/cases/API-EVT2/activity', { method: 'POST', cookie: a2,
    body: { at_date: '2026-08-18', at_time: '11:05', kind: 'activity',
            description: 'Said before the schema caught up.', source: 'voice',
            event_id: 'evt-cccccccc3333' } }));
  ok('without the table the entry is still made', typeof madeA.id === 'number');
  ok('health names the missing table',
     (await jsonOf(await call(bare, '/health'))).missing_tables.includes('activity_voice_event'));
  /* And WITHOUT it a retry does duplicate — which is the state before this
     table existed, and is why the dispatch matters. Asserted so the cost of
     not running it is written down rather than assumed. */
  const madeB = await jsonOf(await call(bare, '/cases/API-EVT2/activity', { method: 'POST', cookie: a2,
    body: { at_date: '2026-08-18', at_time: '11:05', kind: 'activity',
            description: 'Said before the schema caught up.', source: 'voice',
            event_id: 'evt-cccccccc3333' } }));
  ok('and until the dispatch runs, a retry is a second entry — the cost, written down',
     madeB.id !== madeA.id);
}

section('Dropbox storage — where a new case file goes');
{
  const fakeR2 = () => {
    const store = new Map();
    return {
      async put(key, body) { store.set(key, { body }); },
      async get(key) { const o = store.get(key); return o ? { body: o.body } : null; },
      async delete(key) { store.delete(key); },
      _store: store,
    };
  };
  DBX.reset();
  const env = freshEnv();
  env.EVIDENCE = fakeR2();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(env, { case_no: 'API-DBX1', service: 'Surveillance', client_name: 'C', subject_name: 'S' });

  const mk = (name, bytes, type) => new File([new Uint8Array(bytes).fill(67)], name, { type });
  const up = (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return worker.fetch(new Request(API + '/cases/API-DBX1/evidence', {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: admin }, body: fd }), env);
  };

  /* THE THREE FOLDERS, on every case, in the same shape. Video is made even
     though nothing here writes to it — the operator saves timestamped copies
     into it by hand, and a folder that appears only once something is in it is
     a folder nobody trusts. */
  const photo = await jsonOf(await up(mk('IMG_1.jpg', 300, 'image/jpeg')));
  ok('all three case folders exist after the first upload',
     ['Photos', 'Reports', 'Video'].every((f) => DBX.folders.has('/API-DBX1/' + f)),
     [...DBX.folders].join(' '));
  ok('a photograph goes to Photos', DBX.inFolder('Photos').length === 1, DBX.paths().join(' '));

  /* GENERATED REPORTS AND PDFs GO TO Reports — routed by what the file IS, so
     a report does not land in the photo folder because of how it was sent. */
  const doc = await jsonOf(await up(mk('Final Report.pdf', 500, 'application/pdf')));
  ok('a PDF goes to Reports', DBX.inFolder('Reports').length === 1
     && DBX.inFolder('Reports')[0].startsWith('/API-DBX1/Reports/Final Report-'), DBX.paths().join(' '));
  ok('and it is a different file, not a moved one', DBX.files.size === 2);
  ok('nothing at all went to R2', env.EVIDENCE._store.size === 0);
  ok('nothing went to the Video folder', DBX.inFolder('Video').length === 0);

  /* D1 KEEPS THE STRUCTURED RECORD AND DROPBOX KEEPS THE BYTES. The row says
     where the file is; it does not hold the file. */
  const row = await env.DB.prepare('SELECT r2_key, filename, size_bytes FROM case_evidence WHERE id = ?')
    .bind(photo.id).first();
  ok('the record names Dropbox as the place, not R2', row.r2_key.startsWith('dropbox:/API-DBX1/Photos/'), row.r2_key);
  ok('and the real filename is kept for the person, not the storage name',
     row.filename === 'IMG_1.jpg' && row.size_bytes === 300);

  /* SERVED BACK THROUGH THE WORKER, never as a Dropbox link — so the case's
     own permission checks stay in front of the bytes. */
  const got = await call(env, `/cases/API-DBX1/evidence/${photo.id}/file`, { cookie: admin });
  ok('the file streams back through the portal', got.status === 200
     && got.headers.get('content-type') === 'image/jpeg');
  ok('under its real name', /IMG_1\.jpg/.test(got.headers.get('content-disposition') || ''),
     got.headers.get('content-disposition'));
  ok('and no Dropbox URL is handed out anywhere in the response',
     !JSON.stringify([...got.headers]).includes('dropbox.com'));

  /* VIDEO IS STILL REFUSED BY THE ORDINARY UPLOAD. The device-first decision
     of 2026-08-17 is untouched by this change. */
  const vid = await up(mk('clip.mp4', 100, 'video/mp4'));
  ok('the ordinary upload still refuses video', vid.status === 400
     && (await jsonOf(vid)).code === 'video_device_first');
  ok('and refusing it stored nothing in either place',
     DBX.files.size === 2 && env.EVIDENCE._store.size === 0);

  /* DROPBOX UNAVAILABLE: refused, named, and nothing written. Checked for the
     provider being down AND for it refusing the write, because they fail at
     different points and only one of them was ever going to be exercised by
     accident. */
  DBX.down = true;
  let bad = await up(mk('IMG_2.jpg', 300, 'image/jpeg'));
  DBX.down = false;
  ok('an unreachable Dropbox refuses the upload', bad.status === 503
     && (await jsonOf(bad)).code === 'dropbox_unreachable');
  DBX.uploadFails = true;
  bad = await up(mk('IMG_3.jpg', 300, 'image/jpeg'));
  DBX.uploadFails = false;
  ok('and so does one that answers but will not take the file', bad.status === 503
     && (await jsonOf(bad)).code === 'dropbox_unreachable');
  ok('neither wrote a row the portal could not produce a file for',
     (await env.DB.prepare('SELECT COUNT(*) AS n FROM case_evidence').first()).n === 2);
  ok('and neither fell back to R2', env.EVIDENCE._store.size === 0);

  /* A DELETE THAT DID NOT REACH DROPBOX SAYS SO. The tombstone still goes
     down — an admin has to be able to remove something — but they are told the
     file may still be sitting in the folder, which is the one thing they would
     otherwise assume was handled. */
  DBX.deleteFails = true;
  const half = await jsonOf(await call(env, `/cases/API-DBX1/evidence/${doc.id}/delete`,
    { method: 'POST', cookie: admin }));
  DBX.deleteFails = false;
  ok('a delete Dropbox refused is reported, not swallowed', half.dropbox_file_remains === true);
  ok('and the record is still stamped removed',
     (await env.DB.prepare('SELECT deleted_at FROM case_evidence WHERE id = ?')
       .bind(doc.id).first()).deleted_at != null);
  const clean = await jsonOf(await call(env, `/cases/API-DBX1/evidence/${photo.id}/delete`,
    { method: 'POST', cookie: admin }));
  ok('a delete that did reach Dropbox says nothing extra', clean.dropbox_file_remains === undefined);
  ok('and the file is gone from the folder', DBX.inFolder('Photos').length === 0);
}

/* ------------------------------- the final report as a real file, filed

   Owner, 2026-08-18: "Final Reports need a real PDF file, not Print only. Add
   Download PDF and Save PDF to Dropbox Reports. Keep Print optional. No R2 PDF
   copy."

   The PDF is BUILT in the operator's browser from the document already on
   their screen — that half is exercised by the portal suite. This is the half
   that files it. */
section('Final report PDF — filed to Dropbox Reports, never to R2');
{
  const fakeR2 = () => {
    const store = new Map();
    return {
      async put(key, body) { store.set(key, { body }); },
      async get(key) { const o = store.get(key); return o ? { body: o.body } : null; },
      async delete(key) { store.delete(key); },
      _store: store,
    };
  };
  DBX.reset();
  const env = freshEnv();
  env.EVIDENCE = fakeR2();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const l = (await jsonOf(await invite(env, admin,
    { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const t = new URL(l, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${t}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const dana = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  await ingest(env, { case_no: 'API-PDF1', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  const build = (await jsonOf(await call(env, '/cases/API-PDF1/build',
    { method: 'POST', cookie: admin }))).build;

  const pdfBytes = (n) => {
    const a = new Uint8Array(n);
    // A real PDF starts %PDF-; the route does not sniff, but the fixture should
    // not be pretending to be something no reader would open.
    for (const [i, c] of [...'%PDF-1.4'].entries()) a[i] = c.charCodeAt(0);
    return a;
  };
  const send = (cookie, bytes, type, id) => {
    const fd = new FormData();
    fd.append('file', new File([bytes], 'report.pdf', { type }));
    return worker.fetch(new Request(API + `/build/${id === undefined ? build.id : id}/report-pdf`, {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie }, body: fd }), env);
  };

  ok('an investigator cannot file the report',
     (await send(dana, pdfBytes(400), 'application/pdf')).status === 403);
  ok('and something that is not a PDF is refused by name',
     (await jsonOf(await send(admin, pdfBytes(400), 'image/jpeg'))).code === 'not_a_pdf');
  ok('nothing was filed by either', DBX.files.size === 0);

  const saved = await jsonOf(await send(admin, pdfBytes(900), 'application/pdf'));
  ok('an admin files the report', saved.ok === true && saved.bytes === 900);
  ok('into the case Reports folder, under the case and version',
     saved.path.startsWith('/API-PDF1/Reports/API-PDF1 report v1-'), saved.path);
  ok('and the file is really there', DBX.files.size === 1);

  /* NO R2 COPY — the owner said so twice, and it is the whole reason this is a
     separate route rather than the evidence upload. */
  ok('no copy of the PDF went to R2', env.EVIDENCE._store.size === 0);
  /* NOT EVIDENCE EITHER. A report of the case is not material in it: filing it
     as evidence would list it in the gallery and put it under the
     client-deliverable gate that governs exhibits. */
  ok('and it is not filed as case evidence',
     (await env.DB.prepare('SELECT COUNT(*) AS n FROM case_evidence').first()).n === 0);
  /* THE BUILD'S OWN AUDIT TRAIL is where it is recorded — an existing table
     whose action column is free text, so nothing had to be widened or added. */
  const ev = await env.DB.prepare(
    "SELECT action, detail, user_id FROM build_events WHERE action = 'report_pdf_saved'").first();
  ok('the build audit trail records that it was filed, and where',
     ev && ev.detail === saved.path && ev.user_id === 1);

  /* A SECOND SAVE DOES NOT OVERWRITE THE FIRST. A corrected report filed over
     the top of the one already sent to the client would leave no trace that
     they differ. */
  const again = await jsonOf(await send(admin, pdfBytes(950), 'application/pdf'));
  ok('filing it again keeps both files', DBX.files.size === 2 && again.path !== saved.path);
  ok('and both are in the audit trail',
     (await env.DB.prepare(
       "SELECT COUNT(*) AS n FROM build_events WHERE action = 'report_pdf_saved'").first()).n === 2);

  /* DROPBOX UNAVAILABLE: refused with the reason, nothing written, and no
     fallback anywhere. The operator still has the file — it was made on their
     machine — so this costs a retry, not the document. */
  DBX.down = true;
  let bad = await send(admin, pdfBytes(400), 'application/pdf');
  DBX.down = false;
  ok('an unreachable Dropbox refuses the filing', bad.status === 503
     && (await jsonOf(bad)).code === 'dropbox_unreachable');
  delete env.DROPBOX_REFRESH_TOKEN;
  bad = await send(admin, pdfBytes(400), 'application/pdf');
  ok('and with nothing connected it says that instead', bad.status === 503
     && (await jsonOf(bad)).code === 'dropbox_not_connected');
  env.DROPBOX_REFRESH_TOKEN = 'RT-test';
  ok('neither wrote anything anywhere',
     DBX.files.size === 2 && env.EVIDENCE._store.size === 0
     && (await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM build_events WHERE action = 'report_pdf_saved'").first()).n === 2);

  ok('a build that does not exist is a 404, not a stray file',
     (await send(admin, pdfBytes(400), 'application/pdf', 999999)).status === 404);
}

section('Dropbox storage — a demo case is swept from both stores');
{
  const fakeR2 = () => {
    const store = new Map();
    return {
      async put(key, body) { store.set(key, { body }); },
      async get(key) { const o = store.get(key); return o ? { body: o.body } : null; },
      async delete(key) { store.delete(key); },
      _store: store,
    };
  };
  DBX.reset();
  const env = freshEnv();
  env.EVIDENCE = fakeR2();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  const demo = await jsonOf(await call(env, '/demo-case', { method: 'POST', cookie: admin }));
  const demoNo = demo.case_no || demo.case || (demo.submission && demo.submission.case_no);
  ok('a test case is created with a TEST- number', /^TEST-/.test(String(demoNo)), JSON.stringify(demo).slice(0, 200));

  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(120).fill(68)], 'demo.jpg', { type: 'image/jpeg' }));
  await worker.fetch(new Request(API + `/cases/${demoNo}/evidence`, {
    method: 'POST', headers: { Origin: ORIGIN, Cookie: admin }, body: fd }), env);
  ok('its photograph is in Dropbox', DBX.inFolder('Photos').length === 1, DBX.paths().join(' '));

  /* A REAL CASE ALONGSIDE IT, to prove the sweep is bounded by the prefix and
     not by "everything that happens to be in Dropbox". */
  await ingest(env, { case_no: 'API-REAL1', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  const fd2 = new FormData();
  fd2.append('file', new File([new Uint8Array(90).fill(69)], 'real.jpg', { type: 'image/jpeg' }));
  await worker.fetch(new Request(API + '/cases/API-REAL1/evidence', {
    method: 'POST', headers: { Origin: ORIGIN, Cookie: admin }, body: fd2 }), env);
  /* And a legacy R2 object on the demo case, so both halves of the sweep run. */
  await env.DB.prepare(
    `INSERT INTO case_evidence (case_no, r2_key, filename, content_type, size_bytes,
       classification, uploaded_by, uploaded_at)
     VALUES (?, ?, 'old.jpg', 'image/jpeg', 70, 'client_deliverable', 1, ?)`)
    .bind(demoNo, 'cases/' + demoNo + '/old.jpg', new Date().toISOString()).run();
  await env.EVIDENCE.put('cases/' + demoNo + '/old.jpg', new Uint8Array(70));

  await call(env, '/demo-case/clear', { method: 'POST', cookie: admin });
  ok('clearing the test case removes its Dropbox file too',
     DBX.paths().every((f) => !f.startsWith('/TEST-')), DBX.paths().join(' '));
  ok('and its legacy R2 object', env.EVIDENCE._store.size === 0);
  ok('while the real case keeps both its row and its file',
     DBX.inFolder('Photos').length === 1
     && (await env.DB.prepare("SELECT COUNT(*) AS n FROM case_evidence WHERE case_no = 'API-REAL1'")
          .first()).n === 1);
}

/* ------------------- the timestamped copy, optionally saved to Dropbox

   Owner, Part 2, 2026-08-18: an OPTIONAL Save to Dropbox for a successfully
   generated timestamped video. Device-first architecture kept, original
   untouched, copy still generated locally, no automatic upload, no R2 video
   copy, ordinary evidence upload still refuses video, upload sessions for large
   files. */
section('Timestamped video — the optional save to Dropbox');
{
  const fakeR2 = () => {
    const store = new Map();
    return {
      async put(key, body) { store.set(key, { body }); },
      async get(key) { const o = store.get(key); return o ? { body: o.body } : null; },
      async delete(key) { store.delete(key); },
      _store: store,
    };
  };
  DBX.reset();
  const env = freshEnv();
  env.EVIDENCE = fakeR2();
  env.DBX_CHUNK_BYTES = '1000';    // real multi-chunk sessions, small fixtures
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const l = (await jsonOf(await invite(env, admin,
    { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const t = new URL(l, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${t}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const users = await jsonOf(await call(env, '/users', { cookie: admin }));
  const danaId = users.users.find((u) => u.username === 'dana').id;
  const dana = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  await ingest(env, { case_no: 'API-VD1', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  await call(env, '/submissions/API-VD1/assign', { method: 'POST', cookie: admin, body: { user_id: danaId } });

  const stamp = await jsonOf(await call(env, '/cases/API-VD1/video-stamp', { method: 'POST', cookie: dana,
    body: { original_name: 'IMG_0440.mov', original_size: 5_000_000,
            start_utc: '2026-08-18T14:00:00.000Z', derivative_name: 'IMG_0440-timestamped.mp4' } }));
  const sid = stamp.id || (stamp.stamp && stamp.stamp.id);
  ok('a generated copy has a record to hang the save on', typeof sid === 'number', JSON.stringify(stamp).slice(0, 160));
  ok('and nothing has been sent to Dropbox by making it', DBX.files.size === 0);

  const step = (path, opts, cookie) => worker.fetch(new Request(
    API + `/cases/API-VD1/video-stamp/${sid}/dropbox/` + path, {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie || dana, ...(opts && opts.headers) },
      body: opts && opts.body }), env);
  const bytesOf = (n, fill) => { const a = new Uint8Array(n); a.fill(fill); return a; };

  /* A SUCCESSFUL SAVE, moved as a session in real chunks. */
  const started = await jsonOf(await step('start', {}));
  ok('a save starts an upload session', typeof started.session_id === 'string');
  ok('and the chunk size is agreed up front, not assumed', started.chunk_bytes === 1000);

  const payload = bytesOf(3500, 7);            // four chunks at 1000 bytes
  let offset = 0, chunks = 0;
  while (offset < payload.length && chunks < 20) {
    const part = payload.slice(offset, offset + started.chunk_bytes);
    const r = await jsonOf(await worker.fetch(new Request(
      API + `/cases/API-VD1/video-stamp/${sid}/dropbox/append?session=${started.session_id}&offset=${offset}`,
      { method: 'POST', headers: { Origin: ORIGIN, Cookie: dana }, body: part }), env));
    offset = r.offset; chunks++;
  }
  ok('a large file goes up in parts, not in one request', chunks === 4, String(chunks));
  const done = await jsonOf(await step('finish',
    { headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: started.session_id, offset }) }));
  ok('and finishing files it in the case Video folder',
     done.ok === true && done.path.startsWith('/API-VD1/Video/IMG_0440-timestamped-'), done.path);
  ok('with every byte of the copy, reassembled in order',
     DBX.files.get(done.path).length === 3500);
  /* THE RECORD SAYS WHERE IT WENT, in the column that was reserved for it when
     this table was written — no new column and no schema dispatch. */
  ok('the video record names the Dropbox path',
     (await env.DB.prepare('SELECT dropbox_path FROM video_stamp WHERE id = ?').bind(sid).first())
       .dropbox_path === done.path);
  /* NO R2 VIDEO COPY, at any size. */
  ok('and no copy of the video went to R2', env.EVIDENCE._store.size === 0);

  /* RETRY. Dropbox is the authority on where the session is, so a chunk sent
     at the wrong offset is refused rather than silently written in the wrong
     place, and re-sending the right one carries on. */
  const s2 = await jsonOf(await step('start', {}));
  await worker.fetch(new Request(
    API + `/cases/API-VD1/video-stamp/${sid}/dropbox/append?session=${s2.session_id}&offset=0`,
    { method: 'POST', headers: { Origin: ORIGIN, Cookie: dana }, body: bytesOf(1000, 3) }), env);
  const wrong = await worker.fetch(new Request(
    API + `/cases/API-VD1/video-stamp/${sid}/dropbox/append?session=${s2.session_id}&offset=5000`,
    { method: 'POST', headers: { Origin: ORIGIN, Cookie: dana }, body: bytesOf(200, 3) }), env);
  ok('a part sent at the wrong offset is refused', wrong.status === 503);
  const retried = await jsonOf(await worker.fetch(new Request(
    API + `/cases/API-VD1/video-stamp/${sid}/dropbox/append?session=${s2.session_id}&offset=1000`,
    { method: 'POST', headers: { Origin: ORIGIN, Cookie: dana }, body: bytesOf(500, 3) }), env));
  ok('and the upload carries on from where it really was', retried.offset === 1500);

  /* CANCEL. There is nothing to tear down: a session nobody finishes leaves
     nothing at the destination. */
  const before = DBX.files.size;
  ok('an abandoned upload leaves no file behind', DBX.files.size === before && before === 1);
  ok('and nothing was recorded for it',
     (await env.DB.prepare(
       "SELECT COUNT(*) AS n FROM video_stamp WHERE dropbox_path IS NOT NULL").first()).n === 1);

  /* A CHUNK LARGER THAN AGREED is refused — the caller does not get to decide
     how much this Worker holds at once. */
  const s3 = await jsonOf(await step('start', {}));
  ok('an oversized part is refused', (await worker.fetch(new Request(
    API + `/cases/API-VD1/video-stamp/${sid}/dropbox/append?session=${s3.session_id}&offset=0`,
    { method: 'POST', headers: { Origin: ORIGIN, Cookie: dana }, body: bytesOf(4000, 1) }), env)).status === 413);

  /* DROPBOX UNAVAILABLE, and a connection that has been revoked — different
     conditions, each named, neither losing the operator's file. */
  DBX.down = true;
  let bad = await step('start', {});
  DBX.down = false;
  ok('an unreachable Dropbox refuses the save', bad.status === 503
     && (await jsonOf(bad)).code === 'dropbox_unreachable');
  DBX.uploadFails = true;
  bad = await step('start', {});
  DBX.uploadFails = false;
  ok('and one that answers but will not open a session', bad.status === 503
     && (await jsonOf(bad)).code === 'dropbox_unreachable');
  delete env.DROPBOX_REFRESH_TOKEN;
  bad = await step('start', {});
  ok('a revoked or absent connection says exactly that', bad.status === 503
     && (await jsonOf(bad)).code === 'dropbox_not_connected');
  env.DROPBOX_REFRESH_TOKEN = 'RT-test';
  ok('none of those wrote anything anywhere',
     DBX.files.size === 1 && env.EVIDENCE._store.size === 0);

  /* THE ORIGINAL IS UNTOUCHED. The portal never had it — the record carries its
     name, its size and, when the browser could compute one, its hash, and the
     save changes none of them. */
  const rec = await env.DB.prepare(
    'SELECT original_name, original_size, dropbox_path FROM video_stamp WHERE id = ?').bind(sid).first();
  ok('the original is named, sized and unchanged by the save',
     rec.original_name === 'IMG_0440.mov' && rec.original_size === 5000000);
  ok('and no route in this build uploads the original anywhere',
     !DBX.paths().some((f) => f.includes('IMG_0440.mov')), DBX.paths().join(' '));

  /* THE ORDINARY EVIDENCE UPLOAD STILL REFUSES VIDEO. This is a second door,
     not a way around the device-first decision. */
  const fd = new FormData();
  fd.append('file', new File([bytesOf(300, 9)], 'clip.mp4', { type: 'video/mp4' }));
  const still = await worker.fetch(new Request(API + '/cases/API-VD1/evidence', {
    method: 'POST', headers: { Origin: ORIGIN, Cookie: dana }, body: fd }), env);
  ok('the ordinary evidence upload still refuses video by name',
     still.status === 400 && (await jsonOf(still)).code === 'video_device_first');

  /* SCOPED THE WAY EVERY CASE ROUTE IS. */
  await ingest(env, { case_no: 'API-VD2', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  ok('an investigator cannot save into a case that is not theirs',
     (await worker.fetch(new Request(API + `/cases/API-VD2/video-stamp/${sid}/dropbox/start`,
       { method: 'POST', headers: { Origin: ORIGIN, Cookie: dana } }), env)).status === 404);
  ok('and a record from another case is not reachable by id',
     (await worker.fetch(new Request(API + `/cases/API-VD2/video-stamp/${sid}/dropbox/start`,
       { method: 'POST', headers: { Origin: ORIGIN, Cookie: admin } }), env)).status === 404);
}

/* ------------------------------ Timestamp Photo — the original and the copy

   The owner's brief is four words ("Build Timestamp Photo"); what was derived
   from their own video brief and what was not is written down in
   PHOTO-TIMESTAMP.md. These are the properties that file claims. */
section('Timestamped photograph — the pair, and the original untouched');
{
  DBX.reset();
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(env, { case_no: 'API-PST1', service: 'Surveillance', client_name: 'C', subject_name: 'S' });

  const mk = (name, bytes, type) => new File([new Uint8Array(bytes).fill(67)], name, { type });
  const up = (caseNo, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return worker.fetch(new Request(API + `/cases/${caseNo}/evidence`, {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: admin }, body: fd }), env);
  };
  const stamp = (caseNo, fields, cookie = admin) => {
    const fd = new FormData();
    fd.append('file', mk('burned.jpg', 400, 'image/jpeg'));
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    return worker.fetch(new Request(API + `/cases/${caseNo}/photo-stamp`, {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie }, body: fd }), env);
  };
  const evidence = async (caseNo = 'API-PST1') =>
    (await jsonOf(await call(env, `/cases/${caseNo}/workspace`, { cookie: admin }))).evidence;

  const original = await jsonOf(await up('API-PST1', mk('IMG_4407.jpg', 300, 'image/jpeg')));
  const originalPath = DBX.paths()[0];
  const originalBytes = DBX.files.get(originalPath);

  const made = await jsonOf(await stamp('API-PST1', {
    original_id: original.id, taken_utc: '2026-08-17T21:14:32.000Z',
    tz: 'America/New_York', source: 'exif' }));
  ok('the copy is created', typeof made.id === 'number' && made.id !== original.id, JSON.stringify(made.id));

  /* THE ORIGINAL IS NEVER MODIFIED — the whole brief, in one assertion, and
     checked at the bytes rather than at the row. */
  ok('the original file is byte-for-byte what it was',
     DBX.files.get(originalPath) === originalBytes);
  ok('and it is still there under its own name', DBX.files.has(originalPath));
  ok('the copy is a SECOND file, not a rewrite', DBX.files.size === 2);
  ok('and it went to the case Photos folder',
     DBX.inFolder('Photos').length === 2, DBX.paths().join(' '));
  ok('named so nobody has to guess which is which',
     DBX.paths().some((f) => f.includes('IMG_4407-timestamped')), DBX.paths().join(' '));

  const ev = await evidence();
  ok('the case now holds two photographs', ev.length === 2, String(ev.length));
  const originalRow = ev.find((e) => e.id === original.id);
  ok('the original row is intact and not marked removed',
     originalRow && !originalRow.deleted_at && originalRow.filename === 'IMG_4407.jpg');

  /* THE PAIR IS NAMED, which is what "distinguish ORIGINAL EVIDENCE from
     TIMESTAMPED COPY" needs to rest on — not a filename convention. */
  const ws = await jsonOf(await call(env, '/cases/API-PST1/workspace', { cookie: admin }));
  ok('the workspace carries the pairing', Array.isArray(ws.photo_stamps) && ws.photo_stamps.length === 1,
     JSON.stringify(ws.photo_stamps));
  const pair = ws.photo_stamps[0];
  ok('it names the original and the copy',
     pair.original_id === original.id && pair.stamped_id === made.id, JSON.stringify(pair));
  ok('it keeps the instant that was burned in', pair.taken_utc === '2026-08-17T21:14:32.000Z', pair.taken_utc);
  ok('and the zone it was read in, so EST/EDT can be re-derived',
     pair.tz === 'America/New_York', pair.tz);
  ok('and WHERE THE TIME CAME FROM, which is the provenance', pair.source === 'exif', pair.source);
  ok('and who made it', pair.generated_by_name === 'Trever', pair.generated_by_name);
  ok('this one is the active copy', pair.superseded_at === null, String(pair.superseded_at));

  /* A CORRECTION SUPERSEDES. Nothing is overwritten and nothing is deleted. */
  const fixed = await jsonOf(await stamp('API-PST1', {
    original_id: original.id, taken_utc: '2026-08-17T22:14:32.000Z',
    tz: 'America/New_York', source: 'operator' }));
  const after = (await jsonOf(await call(env, '/cases/API-PST1/workspace', { cookie: admin }))).photo_stamps;
  ok('a correction adds a record rather than editing one', after.length === 2, String(after.length));
  const live = after.filter((x) => x.superseded_at === null);
  ok('exactly one is active', live.length === 1 && live[0].stamped_id === fixed.id, JSON.stringify(live));
  ok('and the earlier one is marked superseded, not removed',
     after.some((x) => x.stamped_id === made.id && x.superseded_at), JSON.stringify(after));
  const ev2 = await evidence();
  ok('the superseded copy KEEPS its evidence row — nothing here purges',
     ev2.some((e) => e.id === made.id && !e.deleted_at), String(ev2.length));
  ok('and its file is still in Dropbox', DBX.files.size === 3, String(DBX.files.size));

  /* A COPY OF A COPY IS REFUSED BY NAME. */
  const twice = await stamp('API-PST1', {
    original_id: fixed.id, taken_utc: '2026-08-17T22:14:32.000Z',
    tz: 'America/New_York', source: 'operator' });
  ok('a timestamped copy cannot itself be timestamped', twice.status === 400, String(twice.status));
  ok('and the refusal says which mistake it was',
     (await jsonOf(twice)).code === 'already_a_copy');
}

/* THE REFUSAL THAT MATTERS MOST: stamping must not be a way around the package
   gate. Material held back as internal only stays held back. */
section('Timestamping cannot promote held-back material');
{
  DBX.reset();
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(env, { case_no: 'API-PST2', service: 'Surveillance', client_name: 'C', subject_name: 'S' });

  const mk = (name, bytes, type) => new File([new Uint8Array(bytes).fill(67)], name, { type });
  const upWith = (cls, name = 'held.jpg', type = 'image/jpeg') => {
    const fd = new FormData();
    fd.append('file', mk(name, 300, type));
    fd.append('classification', cls);
    return worker.fetch(new Request(API + '/cases/API-PST2/evidence', {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: admin }, body: fd }), env);
  };
  const stamp = (id, extra = {}) => {
    const fd = new FormData();
    fd.append('file', mk('burned.jpg', 400, 'image/jpeg'));
    fd.append('original_id', String(id));
    fd.append('taken_utc', '2026-08-17T21:14:32.000Z');
    fd.append('tz', 'America/New_York');
    fd.append('source', 'operator');
    for (const [k, v] of Object.entries(extra)) fd.set(k, String(v));
    return worker.fetch(new Request(API + '/cases/API-PST2/photo-stamp', {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: admin }, body: fd }), env);
  };
  const classOf = async (id) =>
    ((await jsonOf(await call(env, '/cases/API-PST2/workspace', { cookie: admin }))).evidence
      .find((e) => e.id === id) || {}).classification;

  for (const cls of ['internal_only', 'needs_redaction', 'do_not_use', 'needs_review']) {
    const held = await jsonOf(await upWith(cls, `${cls}.jpg`));
    const copy = await jsonOf(await stamp(held.id));
    ok(`a ${cls} original produces a ${cls} copy`, (await classOf(copy.id)) === cls,
       await classOf(copy.id));
  }
  const open = await jsonOf(await upWith('client_deliverable', 'open.jpg'));
  const openCopy = await jsonOf(await stamp(open.id));
  ok('and a deliverable original still produces a deliverable copy',
     (await classOf(openCopy.id)) === 'client_deliverable');

  /* The caller cannot ask for something else, because it is never read. */
  const heldAgain = await jsonOf(await upWith('internal_only', 'again.jpg'));
  const sneaky = await jsonOf(await stamp(heldAgain.id, { classification: 'client_deliverable' }));
  ok('and asking for a wider classification changes nothing',
     (await classOf(sneaky.id)) === 'internal_only', await classOf(sneaky.id));

  /* WHAT MAY BE STAMPED. A document is not a photograph, and video never
     reaches this store at all. */
  const pdf = await jsonOf(await upWith('client_deliverable', 'Report.pdf', 'application/pdf'));
  const notPhoto = await stamp(pdf.id);
  ok('a document cannot be timestamped this way', notPhoto.status === 400
     && (await jsonOf(notPhoto)).code === 'not_a_photo', String(notPhoto.status));

  /* ANOTHER CASE'S PHOTOGRAPH IS REFUSED, not silently ignored. */
  await ingest(env, { case_no: 'API-PST3', service: 'Surveillance', client_name: 'D', subject_name: 'T' });
  const other = await jsonOf(await (() => {
    const fd = new FormData();
    fd.append('file', mk('theirs.jpg', 300, 'image/jpeg'));
    return worker.fetch(new Request(API + '/cases/API-PST3/evidence', {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: admin }, body: fd }), env);
  })());
  const wrongCase = await stamp(other.id);
  ok("another case's photograph is refused", wrongCase.status === 400, String(wrongCase.status));

  /* PROVENANCE IS REQUIRED. An evidence timestamp with no recorded origin is
     one nobody can defend, so there is no default. */
  const anyPhoto = await jsonOf(await upWith('client_deliverable', 'prov.jpg'));
  for (const [k, v] of [['source', ''], ['source', 'guessed'], ['taken_utc', 'sometime'],
                        ['tz', 'Mars/Olympus']]) {
    const bad = await stamp(anyPhoto.id, { [k]: v });
    ok(`${k}="${v}" is refused`, bad.status === 400, String(bad.status));
  }
}

/* THE PACKAGE RULE, owner 2026-08-18: "do not automatically include both
   original and timestamped copy in the client package. Add 'Include timestamped
   copy in client package' default ON. Original keeps its existing
   classification unless Admin explicitly selects it." */
section('Timestamped photograph — which half of the pair goes to the client');
{
  DBX.reset();
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(env, { case_no: 'API-PSTP', service: 'Surveillance', client_name: 'C', subject_name: 'S' });

  const mk = (n) => new File([new Uint8Array(300).fill(67)], n, { type: 'image/jpeg' });
  const upWith = (cls, name) => {
    const fd = new FormData();
    fd.append('file', mk(name));
    fd.append('classification', cls);
    return worker.fetch(new Request(API + '/cases/API-PSTP/evidence', {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: admin }, body: fd }), env);
  };
  const stamp = (id, include) => {
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array(400).fill(67)], 'burned.jpg', { type: 'image/jpeg' }));
    fd.append('original_id', String(id));
    fd.append('taken_utc', '2026-08-17T21:14:32.000Z');
    fd.append('tz', 'America/New_York');
    fd.append('source', 'operator');
    if (include !== undefined) fd.append('include_copy', String(include));
    return worker.fetch(new Request(API + '/cases/API-PSTP/photo-stamp', {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: admin }, body: fd }), env);
  };
  const classOf = async (id) => (await env.DB.prepare(
    'SELECT classification AS c FROM case_evidence WHERE id = ?').bind(id).first()).c;

  /* DEFAULT ON — the copy is the one that ships, so an ordinary deliverable
     photograph produces a deliverable copy and nothing has to be said. */
  const a = await jsonOf(await upWith('client_deliverable', 'a.jpg'));
  const aCopy = await jsonOf(await stamp(a.id));
  ok('the switch defaults to ON when nothing is said', aCopy.include_copy === true,
     JSON.stringify(aCopy.include_copy));
  ok('so the copy is client-deliverable', (await classOf(aCopy.id)) === 'client_deliverable');
  ok('and it says so in the answer, rather than leaving it to be believed',
     aCopy.classification === 'client_deliverable', aCopy.classification);
  ok('the ORIGINAL is not reclassified by any of it',
     (await classOf(a.id)) === 'client_deliverable');

  /* OFF — the copy is held back. `internal_only` is how this portal already
     says "in the case, not for the client"; there is no second flag. */
  const b = await jsonOf(await upWith('client_deliverable', 'b.jpg'));
  const bCopy = await jsonOf(await stamp(b.id, false));
  ok('turning it off is honoured', bCopy.include_copy === false, JSON.stringify(bCopy.include_copy));
  ok('the copy is held back as internal only', (await classOf(bCopy.id)) === 'internal_only');
  ok('and the original is STILL exactly as the admin left it',
     (await classOf(b.id)) === 'client_deliverable');
  /* Which is the whole point: the package gate is the classification, so a
     held-back copy is not eligible and nothing else had to learn a new rule. */
  const build = await jsonOf(await call(env, '/cases/API-PSTP/build', { method: 'POST', cookie: admin }));
  const refused = await call(env, `/build/${build.build.id}/items`,
    { method: 'POST', cookie: admin, body: { evidence_id: bCopy.id } });
  ok('a held-back copy cannot enter a package', refused.status === 400, String(refused.status));

  /* "unless Admin explicitly selects it" — the original is never refused. */
  const chosen = await call(env, `/build/${build.build.id}/items`,
    { method: 'POST', cookie: admin, body: { evidence_id: b.id } });
  ok('and an admin may still explicitly put the ORIGINAL in the package',
     chosen.status === 201, String(chosen.status));

  /* ON CANNOT WIDEN. The inheritance ceiling is the package gate. */
  const c = await jsonOf(await upWith('internal_only', 'c.jpg'));
  const cCopy = await jsonOf(await stamp(c.id, true));
  ok('asking to include a copy of held-back material does not promote it',
     (await classOf(cCopy.id)) === 'internal_only', await classOf(cCopy.id));

  /* OFF DOES NOT REWRITE A STRONGER CLASSIFICATION into a milder one. */
  const d = await jsonOf(await upWith('do_not_use', 'd.jpg'));
  const dCopy = await jsonOf(await stamp(d.id, false));
  ok('turning it off on do-not-use material keeps do-not-use, not internal only',
     (await classOf(dCopy.id)) === 'do_not_use', await classOf(dCopy.id));

  /* There is NO second source of truth for this: no column, anywhere. */
  const cols = await env.DB.prepare('PRAGMA table_info(photo_stamp)').all();
  ok('no include_in_package column exists to disagree with the classification',
     !(cols.results || []).some((c2) => /include/i.test(c2.name)),
     (cols.results || []).map((c2) => c2.name).join(','));
}

section('Timestamped photograph — the boundaries it inherits');
{
  DBX.reset();
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin,
    { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const token = new URL(link, 'https://x.test').searchParams.get('invite');
  const accepted = await call(env, `/invite/${token}/accept`,
    { method: 'POST', body: { password: 'FieldWork2026x' } });
  const invCookie = cookieFrom(accepted);
  const invId = (await jsonOf(await call(env, '/users', { cookie: admin })))
    .users.find((u) => u.username === 'dana').id;
  await ingest(env, { case_no: 'API-PST4', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  await ingest(env, { case_no: 'API-PST5', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  await call(env, '/submissions/API-PST4/assign', { method: 'POST', cookie: admin,
    body: { user_id: invId } });

  const mk = (n) => new File([new Uint8Array(300).fill(67)], n, { type: 'image/jpeg' });
  const upAs = (caseNo, cookie) => {
    const fd = new FormData();
    fd.append('file', mk('field.jpg'));
    return worker.fetch(new Request(API + `/cases/${caseNo}/evidence`, {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie }, body: fd }), env);
  };
  const stampAs = (caseNo, id, cookie) => {
    const fd = new FormData();
    fd.append('file', mk('burned.jpg'));
    fd.append('original_id', String(id));
    fd.append('taken_utc', '2026-08-17T21:14:32.000Z');
    fd.append('tz', 'America/New_York');
    fd.append('source', 'operator');
    return worker.fetch(new Request(API + `/cases/${caseNo}/photo-stamp`, {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie }, body: fd }), env);
  };

  /* NOT ADMIN-ONLY. The investigator who took the picture is the one standing
     in the field with it; `caseFor` is the boundary, as it is for the upload. */
  const mine = await jsonOf(await upAs('API-PST4', invCookie));
  const ok1 = await stampAs('API-PST4', mine.id, invCookie);
  ok('an investigator can timestamp a photograph on their own case', ok1.status === 201, String(ok1.status));

  const theirs = await jsonOf(await upAs('API-PST5', admin));
  const denied = await stampAs('API-PST5', theirs.id, invCookie);
  ok('and reaches nothing on a case that is not theirs', denied.status === 404, String(denied.status));

  /* THE DELETED AND ARCHIVED GATE. The case number is in the path, so the
     chokepoint in route() answers before this handler is ever entered. */
  await call(env, '/cases/API-PST5/delete', { method: 'POST', cookie: admin });
  const gone = await stampAs('API-PST5', theirs.id, admin);
  ok('a deleted case is refused', gone.status === 409, String(gone.status));
  ok('and by name', (await jsonOf(gone)).case_deleted === true);

  await call(env, '/cases/API-PST5/undelete', { method: 'POST', cookie: admin });
  await call(env, '/cases/API-PST5/archive', { method: 'POST', cookie: admin });
  const filed = await stampAs('API-PST5', theirs.id, admin);
  ok('an archived case is refused too', filed.status === 409
     && (await jsonOf(filed)).case_archived === true, String(filed.status));
}

section('Timestamped photograph — before the schema catches up, and when Dropbox is down');
{
  /* THE TABLE ARRIVES BY A MANUAL DISPATCH while the Worker deploys on push,
     so between the two it does not exist. The read degrades; the write names
     the workflow. */
  DBX.reset();
  const bare = freshEnv();
  await bootstrapAdmin(bare);
  const admin = (await login(bare, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(bare, { case_no: 'API-PST6', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  const fd0 = new FormData();
  fd0.append('file', new File([new Uint8Array(300).fill(67)], 'a.jpg', { type: 'image/jpeg' }));
  const orig = await jsonOf(await worker.fetch(new Request(API + '/cases/API-PST6/evidence', {
    method: 'POST', headers: { Origin: ORIGIN, Cookie: admin }, body: fd0 }), bare));

  await bare.DB.prepare('DROP TABLE photo_stamp').run();
  const ws = await call(bare, '/cases/API-PST6/workspace', { cookie: admin });
  ok('the workspace still loads without the table', ws.status === 200, String(ws.status));
  ok('and reports no pairings rather than failing',
     JSON.stringify((await jsonOf(ws)).photo_stamps) === '[]');
  ok('health names the missing table',
     (await jsonOf(await call(bare, '/health'))).missing_tables.includes('photo_stamp'));

  const mkStamp = (env, cookie) => {
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array(400).fill(67)], 'b.jpg', { type: 'image/jpeg' }));
    fd.append('original_id', String(orig.id));
    fd.append('taken_utc', '2026-08-17T21:14:32.000Z');
    fd.append('tz', 'America/New_York');
    fd.append('source', 'operator');
    return worker.fetch(new Request(API + '/cases/API-PST6/photo-stamp', {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie }, body: fd }), env);
  };
  const blocked = await mkStamp(bare, admin);
  ok('the write returns 503 naming the workflow', blocked.status === 503, String(blocked.status));
  const why = await jsonOf(blocked);
  ok('and says which one', /portal-setup/.test(why.error) && why.code === 'not_set_up', why.error);
  ok('and nothing was written to Dropbox on the way', DBX.files.size === 1, String(DBX.files.size));

  /* DROPBOX DOWN: refused, and NO ROW. A record of a copy that does not exist
     is worse than no copy at all. */
  DBX.reset();
  const env = freshEnv();
  await bootstrapAdmin(env);
  const a2 = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(env, { case_no: 'API-PST7', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  const fd1 = new FormData();
  fd1.append('file', new File([new Uint8Array(300).fill(67)], 'a.jpg', { type: 'image/jpeg' }));
  const o2 = await jsonOf(await worker.fetch(new Request(API + '/cases/API-PST7/evidence', {
    method: 'POST', headers: { Origin: ORIGIN, Cookie: a2 }, body: fd1 }), env));

  DBX.uploadFails = true;
  const refused = await worker.fetch(new Request(API + '/cases/API-PST7/photo-stamp', {
    method: 'POST', headers: { Origin: ORIGIN, Cookie: a2 },
    body: (() => { const fd = new FormData();
      fd.append('file', new File([new Uint8Array(400).fill(67)], 'b.jpg', { type: 'image/jpeg' }));
      fd.append('original_id', String(o2.id));
      fd.append('taken_utc', '2026-08-17T21:14:32.000Z');
      fd.append('tz', 'America/New_York');
      fd.append('source', 'operator');
      return fd; })() }), env);
  ok('a refused upload is a refused stamp', refused.status === 503, String(refused.status));
  const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM photo_stamp').first();
  ok('and NO pairing row was written', rows.n === 0, String(rows.n));
  const evs = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM case_evidence WHERE case_no = 'API-PST7'").first();
  ok('and no evidence row either — the copy does not exist', evs.n === 1, String(evs.n));
  DBX.uploadFails = false;
}

section('Dropbox OAuth — connect');
{
  const env = freshEnv();
  /* This section's subject is how a connection is MADE, so it starts without
     one — unlike every other environment in the suite. */
  delete env.DROPBOX_APP_KEY; delete env.DROPBOX_APP_SECRET; delete env.DROPBOX_REFRESH_TOKEN;
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const l = (await jsonOf(await invite(env, admin,
    { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const t = new URL(l, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${t}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const dana = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  /* THE APP'S OWN CREDENTIALS ARE A PREREQUISITE, and their absence is a
     different answer from "nobody has connected yet". */
  let res = await call(env, '/dropbox/connect', { cookie: admin });
  ok('without the app secrets, connect refuses and says what is missing',
     res.status === 503 && /DROPBOX_APP_KEY/.test((await jsonOf(res)).error));
  ok('and names it as a provider problem, not a user error',
     (await jsonOf(await call(env, '/dropbox/connect', { cookie: admin }))).code
       === 'provider_not_configured');

  env.DROPBOX_APP_KEY = 'test-app-key';
  env.DROPBOX_APP_SECRET = 'test-app-secret';

  /* ADMIN ONLY. An investigator has no business holding the firm's Dropbox
     connection open or closed — nor reading which account it is. */
  ok('an investigator cannot start a connection',
     (await call(env, '/dropbox/connect', { cookie: dana })).status === 403);
  ok('nor read its status', (await call(env, '/dropbox/status', { cookie: dana })).status === 403);
  ok('nor disconnect it',
     (await call(env, '/dropbox/disconnect', { method: 'POST', cookie: dana })).status === 403);

  res = await call(env, '/dropbox/connect', { cookie: admin });
  ok('an admin is redirected to Dropbox', res.status === 302);
  const to = new URL(res.headers.get('Location'));
  ok('at Dropbox’s own authorize endpoint',
     to.origin === 'https://www.dropbox.com' && to.pathname === '/oauth2/authorize', to.href);
  ok('with the app key, which came from the secret', to.searchParams.get('client_id') === 'test-app-key');
  /* WITHOUT `offline` Dropbox returns a four-hour access token and the
     connection dies overnight. This is the parameter that makes it durable. */
  ok('asking for offline access, so a refresh token comes back',
     to.searchParams.get('token_access_type') === 'offline');
  ok('and for the App Folder scopes',
     /files\.content\.write/.test(to.searchParams.get('scope') || ''), to.searchParams.get('scope'));

  /* THE REDIRECT URI IS DERIVED, never typed — Dropbox matches it exactly, so a
     constant that drifts from the route fails only in production. */
  ok('the redirect URI is the Worker’s own live callback',
     to.searchParams.get('redirect_uri')
       === 'https://alwayspreciseinvestigations.net/portal-api/dropbox/callback',
     to.searchParams.get('redirect_uri'));

  const cookie = res.headers.get('Set-Cookie') || '';
  ok('a CSRF state is minted and carried in a cookie', /dbx_oauth=[A-Za-z0-9_-]{16,}/.test(cookie), cookie);
  /* The cookie must survive Dropbox's cross-site return, which is a top-level
     GET — Lax permits exactly that and nothing weaker is needed. */
  ok('the state cookie is HttpOnly, Secure and SameSite=Lax',
     /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Lax/.test(cookie), cookie);
  ok('scoped to the Dropbox routes and short-lived',
     /Path=\/portal-api\/dropbox/.test(cookie) && /Max-Age=600/.test(cookie), cookie);
  ok('and two connects mint different states',
     (await call(env, '/dropbox/connect', { cookie: admin })).headers.get('Set-Cookie') !== cookie);

  /* THE COOKIE CARRIES WHO STARTED THIS, SIGNED. The callback cannot read the
     session — Dropbox's return is cross-site and the session cookie is
     SameSite=Strict — so this cookie is the credential it authenticates on. */
  const carried = cookie.split(';')[0].split('=')[1];
  const bits = carried.split('.');
  ok('the state cookie carries state, admin id, expiry and a signature',
     bits.length === 4, carried);
  ok('naming the admin who pressed Connect', bits[1] === '1', carried);
  ok('expiring inside the ten minutes it advertises',
     Number(bits[2]) * 1000 > Date.now() && Number(bits[2]) * 1000 <= Date.now() + 600_000);
  ok('and signed, so a forged cookie cannot name an admin it did not come from',
     /^[0-9a-f]{64}$/.test(bits[3]), bits[3]);
  /* Dropbox is handed the RANDOM half only. A URL that lands in Dropbox's logs
     and the browser's history should not name our staff. */
  ok('the admin id is not in the state sent to Dropbox',
     to.searchParams.get('state') === bits[0] && !to.searchParams.get('state').includes('.'),
     to.searchParams.get('state'));
}

section('Dropbox OAuth — callback');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  env.DROPBOX_APP_KEY = 'test-app-key';
  env.DROPBOX_APP_SECRET = 'test-app-secret';
  // The row is what this section is about, so the env shortcut is out of the way.
  delete env.DROPBOX_REFRESH_TOKEN;

  // Every outbound call is intercepted; nothing reaches Dropbox.
  const realFetch = globalThis.fetch;
  let calls = [];
  const stub = (opts = {}) => {
    globalThis.fetch = async (url, init) => {
      const u = String(url && url.url ? url.url : url);
      calls.push({ u, init });
      if (u.includes('/oauth2/token')) {
        if (opts.tokenFails) return new Response('nope', { status: 400 });
        return new Response(JSON.stringify({
          access_token: 'sl.ACCESS', refresh_token: 'RT-abc', scope: 'files.content.write',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('get_current_account')) {
        if (opts.accountFails) return new Response('no', { status: 401 });
        return new Response(JSON.stringify({ account_id: 'dbid:123', email: 'office@example.com',
          name: { display_name: 'Always Precise' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('token/revoke')) return new Response('', { status: opts.revokeFails ? 500 : 200 });
      return new Response('{}', { status: 200 });
    };
  };
  /* The cookie value is `state.uid.expiry.signature`, and `state` alone is what
     Dropbox echoes back — so both halves are returned and each test sends the
     right one to the right place. */
  const startFlow = async (e = env, who = admin) => {
    const r = await call(e, '/dropbox/connect', { cookie: who });
    const carried = (r.headers.get('Set-Cookie') || '').split(';')[0].split('=')[1];
    return { carried, state: carried.split('.')[0] };
  };
  /* NO SESSION COOKIE. That is the whole point of this route: a browser sends
     none on Dropbox's cross-site return, so every test here drives it exactly
     as a real return trip does. */
  const callback = (qs, carried, e = env) => call(e, '/dropbox/callback' + qs,
    { cookie: carried ? `dbx_oauth=${carried}` : '' });

  try {
    stub();
    const flow = await startFlow();

    /* THE STATE IS WHAT PROVES THE RESPONSE BELONGS TO A REQUEST THIS PORTAL
       MADE. Every way of getting it wrong is refused, and none of them stores
       anything. */
    let r = await callback(`?code=C&state=${flow.state}`);      // no state cookie
    ok('a callback with no state cookie is refused',
       r.status === 302 && /dropbox=state/.test(r.headers.get('Location')), r.headers.get('Location'));
    r = await callback('?code=C', flow.carried);
    ok('a callback with no state parameter is refused',
       /dropbox=state/.test(r.headers.get('Location')));
    r = await callback(`?code=C&state=${'z'.repeat(64)}`, flow.carried);
    ok('a mismatched state is refused',
       /dropbox=state/.test(r.headers.get('Location')));
    ok('and none of those stored anything',
       (await env.DB.prepare('SELECT COUNT(*) AS n FROM dropbox_auth').first()).n === 0);

    /* The operator pressing Cancel on Dropbox's own screen is not a failure. */
    r = await callback('?error=access_denied&state=x', flow.carried);
    ok('cancelling at Dropbox comes back as cancelled, not an error',
       /dropbox=cancelled/.test(r.headers.get('Location')), r.headers.get('Location'));

    // ---- the happy path ----
    calls = [];
    r = await callback(`?code=CODE-1&state=${flow.state}`, flow.carried);
    ok('a valid callback lands back in the portal, connected',
       r.status === 302 && /dropbox=connected/.test(r.headers.get('Location')), r.headers.get('Location'));
    /* THE STATE IS SINGLE-USE: the cookie is cleared on the way out, whatever
       happened, so a replayed URL cannot re-run the exchange. */
    ok('and the state cookie is cleared on the way out',
       /dbx_oauth=x;/.test(r.headers.get('Set-Cookie') || '')
       && /Max-Age=0/.test(r.headers.get('Set-Cookie') || ''), r.headers.get('Set-Cookie'));

    const tokenCall = calls.find(c => c.u.includes('/oauth2/token'));
    ok('the code was exchanged with Dropbox', !!tokenCall);
    ok('authenticated with the app secret, not the code',
       /^Basic /.test(tokenCall.init.headers.Authorization));
    ok('and the redirect URI was sent again, as Dropbox requires',
       String(tokenCall.init.body).includes(
         encodeURIComponent('https://alwayspreciseinvestigations.net/portal-api/dropbox/callback')),
       String(tokenCall.init.body));
    /* THE CONNECTION IS PROVEN BEFORE IT IS CLAIMED — the account read is what
       turns "we have a token" into "it works". */
    ok('the account was read back before anything claimed to be connected',
       calls.some(c => c.u.includes('get_current_account')));

    const row = await env.DB.prepare('SELECT * FROM dropbox_auth WHERE id = 1').first();
    ok('the refresh token is stored, so the connection outlives the hour',
       row && row.refresh_token === 'RT-abc');
    ok('with the account it belongs to, so it can be audited',
       row.account_email === 'office@example.com' && row.account_name === 'Always Precise');
    ok('and who connected it', row.connected_by === 1 && !!row.connected_at);
    /* ONE ROW. This is the firm's connection, not a per-user login. */
    ok('it is a single row, enforced by the schema',
       (await env.DB.prepare('SELECT COUNT(*) AS n FROM dropbox_auth').first()).n === 1);

    // ---- status: says everything except the token ----
    const st = (await jsonOf(await call(env, '/dropbox/status', { cookie: admin }))).dropbox;
    ok('status reports the connection', st.connected === true && st.app_configured === true);
    ok('naming the account and when', st.account_email === 'office@example.com' && !!st.connected_at);
    ok('and the exact live redirect URI, so it can be copied into Dropbox',
       st.redirect_uri === 'https://alwayspreciseinvestigations.net/portal-api/dropbox/callback',
       st.redirect_uri);
    /* THE TOKEN NEVER LEAVES. Not in status, not anywhere. */
    ok('the refresh token is in no response',
       !JSON.stringify(st).includes('RT-abc'), JSON.stringify(st));

    // ---- a token that will not answer is not stored ----
    const env2 = freshEnv();
    await bootstrapAdmin(env2);
    const a2 = (await login(env2, 'trever', 'FirstAdminPass1')).cookie;
    env2.DROPBOX_APP_KEY = 'k'; env2.DROPBOX_APP_SECRET = 's';
    const f2 = await startFlow(env2, a2);
    stub({ accountFails: true });
    const bad = await callback(`?code=C&state=${f2.state}`, f2.carried, env2);
    ok('a token Dropbox will not answer for is reported unverified',
       /dropbox=unverified/.test(bad.headers.get('Location')), bad.headers.get('Location'));
    ok('and is not stored at all',
       (await env2.DB.prepare('SELECT COUNT(*) AS n FROM dropbox_auth').first()).n === 0);

    // ---- a failed exchange stores nothing either ----
    const f3 = await startFlow(env2, a2);
    stub({ tokenFails: true });
    const bad2 = await callback(`?code=C&state=${f3.state}`, f3.carried, env2);
    ok('a refused exchange says so', /dropbox=exchange/.test(bad2.headers.get('Location')));
    ok('and stores nothing',
       (await env2.DB.prepare('SELECT COUNT(*) AS n FROM dropbox_auth').first()).n === 0);

    // ---- disconnect revokes, then forgets ----
    stub();
    const off = await jsonOf(await call(env, '/dropbox/disconnect', { method: 'POST', cookie: admin }));
    ok('disconnect revokes the token at Dropbox first', off.revoked === true
       && calls.some(c => c.u.includes('token/revoke')));
    ok('then forgets it here',
       (await env.DB.prepare('SELECT COUNT(*) AS n FROM dropbox_auth').first()).n === 0);
    ok('and reports itself disconnected', off.dropbox.connected === false);

    /* IF THE REVOKE CANNOT BE REACHED the row still goes — but the answer says
       so rather than implying the token is dead. */
    const r4 = await call(env, '/dropbox/connect', { cookie: admin });
    const s4 = (r4.headers.get('Set-Cookie') || '').match(/dbx_oauth=([A-Za-z0-9_-]+)/)[1];
    await call(env, `/dropbox/callback?code=C&state=${s4}`, { cookie: admin + `; dbx_oauth=${s4}` });
    stub({ revokeFails: true });
    const off2 = await jsonOf(await call(env, '/dropbox/disconnect', { method: 'POST', cookie: admin }));
    ok('an unreachable revoke is reported honestly', off2.revoked === false
       && /remove this app from the Dropbox account page/.test(off2.detail), off2.detail);
    ok('and the row is gone regardless',
       (await env.DB.prepare('SELECT COUNT(*) AS n FROM dropbox_auth').first()).n === 0);
  } finally { globalThis.fetch = realFetch; }
}

/* ------------------------------------------ the reported live defect, fixed

   Owner, 2026-08-18: "Live Dropbox callback reaches the site but returns
   'Not signed in' while admin is signed into Case Portal in the same browser."

   `sessionCookie` is SameSite=Strict, and a browser does not attach a Strict
   cookie to a request that ANOTHER site navigated to. Dropbox sending the
   operator back is exactly that, so `currentUser` saw nothing and the callback
   refused an admin who was signed in in that very tab.

   The fix is NOT Lax on the session cookie — that is the portal's CSRF defence
   and every route would pay for one OAuth return. The callback carries its own
   signed credential instead. These are the properties that has to hold. */
section('Dropbox OAuth — the callback authenticates itself');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  env.DROPBOX_APP_KEY = 'test-app-key';
  env.DROPBOX_APP_SECRET = 'test-app-secret';
  delete env.DROPBOX_REFRESH_TOKEN;

  // A real investigator, so the forged-cookie test names an id that exists.
  const l = (await jsonOf(await invite(env, admin,
    { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const t = new URL(l, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${t}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url && url.url ? url.url : url);
    if (u.includes('/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'sl.A', refresh_token: 'RT-live' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('get_current_account')) {
      return new Response(JSON.stringify({ account_id: 'dbid:9', email: 'office@example.com',
        name: { display_name: 'Always Precise' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200 });
  };

  const start = async () => {
    const r = await call(env, '/dropbox/connect', { cookie: admin });
    const carried = (r.headers.get('Set-Cookie') || '').split(';')[0].split('=')[1];
    return { carried, state: carried.split('.')[0] };
  };
  const land = (f, alsoSend) => call(env, `/dropbox/callback?code=C&state=${f.state}`,
    { cookie: `dbx_oauth=${f.carried}` + (alsoSend ? '; ' + alsoSend : '') });
  const where = (r) => new URL(r.headers.get('Location'), 'https://x.test').search;
  const rows = async () =>
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM dropbox_auth').first()).n;

  try {
    /* THE DEFECT ITSELF. No session cookie, because a real browser sends none
       on this request — and it must still connect. */
    let f = await start();
    let r = await land(f);
    ok('the callback completes with NO session cookie at all',
       /dropbox=connected/.test(where(r)), where(r));
    ok('and the connection is attributed to the admin who started it',
       (await env.DB.prepare('SELECT connected_by FROM dropbox_auth WHERE id = 1').first())
         .connected_by === 1);

    /* THE SESSION COOKIE MAKES NO DIFFERENCE EITHER WAY — not required, and
       not consulted when it happens to arrive. */
    await env.DB.prepare('DELETE FROM dropbox_auth').run();
    f = await start();
    r = await land(f, admin);
    ok('sending the session cookie as well changes nothing',
       /dropbox=connected/.test(where(r)), where(r));

    /* A FORGED COOKIE CANNOT NAME AN ADMIN. Dana is an investigator and cannot
       mint a state at all, so the only way in is to write one — which is what
       the signature refuses. */
    await env.DB.prepare('DELETE FROM dropbox_auth').run();
    f = await start();
    const b = f.carried.split('.');
    r = await land({ state: f.state, carried: [b[0], '2', b[2], b[3]].join('.') });
    ok('a cookie whose admin id was swapped is refused', /dropbox=state/.test(where(r)), where(r));
    r = await land({ state: f.state, carried: [b[0], b[1], b[2], 'f'.repeat(64)].join('.') });
    ok('and one whose signature was replaced', /dropbox=state/.test(where(r)));
    r = await land({ state: f.state, carried: b[0] });
    ok('and a bare unsigned state, which is what the cookie used to be',
       /dropbox=state/.test(where(r)));
    r = await land({ state: f.state, carried: [b[0], b[1], '1', b[3]].join('.') });
    ok('and one whose expiry was moved into the past', /dropbox=state/.test(where(r)));
    ok('none of those connected anything', (await rows()) === 0);

    /* THE ADMIN IS RE-READ ON THE WAY THROUGH. A genuine, correctly signed
       state stops working the moment the account behind it should not be
       connecting the firm's Dropbox. */
    f = await start();
    await env.DB.prepare("UPDATE users SET role = 'investigator' WHERE id = 1").run();
    r = await land(f);
    ok('an admin demoted after pressing Connect cannot finish it',
       /dropbox=unauthorised/.test(where(r)), where(r));
    await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = 1").run();

    f = await start();
    await env.DB.prepare('UPDATE users SET active = 0 WHERE id = 1').run();
    r = await land(f);
    ok('nor can one deactivated in the meantime', /dropbox=unauthorised/.test(where(r)));
    await env.DB.prepare('UPDATE users SET active = 1 WHERE id = 1').run();
    ok('and neither of those connected anything', (await rows()) === 0);

    /* THE SESSION COOKIE IS UNTOUCHED BY THIS FIX, and that is the point. It is
       the portal's CSRF defence and the reason the callback needed a credential
       of its own; relaxing it later would make this whole route pointless. */
    const again = await login(env, 'trever', 'FirstAdminPass1');
    ok('the portal session cookie is still SameSite=Strict',
       /SameSite=Strict/.test(again.res.headers.get('Set-Cookie') || ''),
       again.res.headers.get('Set-Cookie'));
    ok('and it is still the only thing every other route authenticates on',
       (await call(env, '/dropbox/status', { cookie: '' })).status === 401);
  } finally {
    globalThis.fetch = realFetch;
  }
}

section('Dropbox — secrets only, and no file migration yet');
{
  const src = fs.readFileSync(path.join(HERE, 'worker.js'), 'utf8');
  const schema = fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8');
  /* SECRETS ONLY. Every credential is read from the environment; none is
     written down here, in the schema, or anywhere the deploy can reach. */
  ok('the app key and secret are only ever read from the environment',
     /env\.DROPBOX_APP_KEY/.test(src) && /env\.DROPBOX_APP_SECRET/.test(src));
  ok('and no literal Dropbox credential is in the Worker',
     !/(sl\.[A-Za-z0-9_-]{20,}|dbx_[A-Za-z0-9]{20,}|['"][a-z0-9]{15}['"]\s*;?\s*\/\/\s*app key)/i.test(src));
  ok('nor in the schema', !/DROPBOX|sl\.[A-Za-z0-9_-]{20,}/.test(schema));
  ok('and the token column is never selected into a response body',
     !/refresh_token[^\n]*json\(/.test(src));

  /* NO MIGRATION — the owner has been explicit and repeated: do not migrate or
     delete old R2 files. The Worker DOES call Dropbox content endpoints now
     (new photos and reports go there), so the old "it never touches them"
     guard has done its job and would today be asserting the opposite of the
     design. What has to stay true is narrower and more important. */
  ok('there is no Dropbox file route in this build',
     !/\/dropbox\/(files|list|move|migrate)/.test(src));
  ok('nothing reads an R2 object in order to write it to Dropbox',
     !/EVIDENCE\.get\([\s\S]{0,800}dropboxUpload\(/.test(src));
  ok('and R2 objects are deleted only where they always were — one file, or a TEST- sweep',
     (src.match(/EVIDENCE\.delete\(/g) || []).length === 2,
     String((src.match(/EVIDENCE\.delete\(/g) || []).length));

  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  /* THE SCHEMA GUARD, like every table added after the live database existed.
     The env shortcut is removed so the table is genuinely what is consulted. */
  delete env.DROPBOX_REFRESH_TOKEN;
  await env.DB.prepare('DROP TABLE dropbox_auth').run();
  ok('health names the missing table',
     (await jsonOf(await call(env, '/health'))).missing_tables.includes('dropbox_auth'));
  const st = (await jsonOf(await call(env, '/dropbox/status', { cookie: admin }))).dropbox;
  ok('status degrades rather than failing', st.connected === false && st.not_set_up === true);
  env.DROPBOX_APP_KEY = 'k'; env.DROPBOX_APP_SECRET = 's';
  const c = await call(env, '/dropbox/connect', { cookie: admin });
  ok('and connect names the workflow to run',
     c.status === 503 && /portal-setup/.test((await jsonOf(c)).error));

  /* A REFRESH TOKEN SUPPLIED AS A WORKER SECRET still counts — that path
     predates this flow and an owner who already pasted one is not disconnected. */
  const env2 = freshEnv();
  await bootstrapAdmin(env2);
  const a2 = (await login(env2, 'trever', 'FirstAdminPass1')).cookie;
  env2.DROPBOX_APP_KEY = 'k'; env2.DROPBOX_APP_SECRET = 's';
  env2.DROPBOX_REFRESH_TOKEN = 'from-a-secret';
  const st2 = (await jsonOf(await call(env2, '/dropbox/status', { cookie: a2 }))).dropbox;
  ok('a refresh token held as a Worker secret reads as connected',
     st2.connected === true && st2.source === 'worker secret');
  ok('and that secret is not echoed back either',
     !JSON.stringify(st2).includes('from-a-secret'));

  /* ---------------------------------------------------------------------
     THE VISIBLE HALF: status, account, and a way through to the folder.

     Everything the Settings card draws comes from `/dropbox/status`, so these
     assert the DATA rather than the markup — the page test asserts what an
     admin sees. What matters here is that the Worker never guesses a path and
     never mints a shared link. */

  const env3 = freshEnv();
  await bootstrapAdmin(env3);
  const a3 = (await login(env3, 'trever', 'FirstAdminPass1')).cookie;
  env3.DROPBOX_APP_KEY = 'k'; env3.DROPBOX_APP_SECRET = 's';
  env3.DROPBOX_REFRESH_TOKEN = 'from-a-secret';
  const dbxOf = async (cookie = a3, e = env3) =>
    (await jsonOf(await call(e, '/dropbox/status', { cookie }))).dropbox;

  let d3 = await dbxOf();
  ok('the three case folders come from the Worker, not the page',
     JSON.stringify(d3.folders) === JSON.stringify(['Photos', 'Reports', 'Video']),
     JSON.stringify(d3.folders));
  ok('with no folder name recorded there is NO per-case link',
     d3.folder_name === null && d3.case_url_template === null);
  ok('and Open Dropbox falls back to the Apps folder rather than a guessed path',
     d3.web_url === 'https://www.dropbox.com/home/Apps', d3.web_url);

  /* THE NAME IS RECORDED IN app_config — an existing table, so nothing here
     waits on a portal-setup dispatch. */
  const setFolder = (name, cookie = a3, e = env3) =>
    call(e, '/dropbox/folder', { method: 'POST', cookie, body: { folder_name: name } });

  const saved = await jsonOf(await setFolder('Always Precise Investigations'));
  ok('an admin records the App Folder name and gets the fresh state back',
     saved.ok === true && saved.dropbox.folder_name === 'Always Precise Investigations');
  ok('it is stored as configuration, not as a new table',
     (await env3.DB.prepare("SELECT value FROM app_config WHERE key = 'dropbox_folder'").first())
       .value === 'Always Precise Investigations');

  d3 = await dbxOf();
  ok('Open Dropbox now points at the firm folder, with the name URL-encoded',
     d3.web_url === 'https://www.dropbox.com/home/Apps/Always%20Precise%20Investigations',
     d3.web_url);
  ok('and a per-case template appears',
     d3.case_url_template
       === 'https://www.dropbox.com/home/Apps/Always%20Precise%20Investigations/{case}/{folder}',
     d3.case_url_template);

  /* A DROPBOX WEB LINK IS NOT A SHARED LINK. This is the whole safety of the
     feature: the URL opens the FIRM'S OWN Dropbox and hands out nothing. */
  ok('no link is a Dropbox shared link — nothing hands the files to a URL holder',
     !d3.web_url.includes('/s/') && !d3.web_url.includes('/scl/')
       && !d3.case_url_template.includes('/s/'));
  const wsrc = fs.readFileSync(path.join(HERE, 'worker.js'), 'utf8');
  /* Asserted on the API URL a call would have to use, not on the words — the
     comment above `dropboxWebUrls` names the endpoint precisely so nobody adds
     it, and a test that failed on the warning would be deleted rather than
     obeyed. */
  ok('and the Worker calls no Dropbox sharing endpoint at all',
     !/api\.dropboxapi\.com\/2\/sharing/.test(wsrc));
  ok('nor a direct download endpoint for a folder link',
     !/dropbox\.com\/home[^`'"]*\?dl=/.test(wsrc));

  /* THE TOKEN STILL NEVER LEAVES, now that the state carries more. */
  ok('the enriched status still echoes no token',
     !JSON.stringify(d3).includes('from-a-secret'), JSON.stringify(d3).slice(0, 200));

  // ---- a mistyped name is named, not silently edited ----
  for(const bad of ['Apps/Always Precise', 'C:\\Dropbox', 'a?b', 'a*b', 'a<b', 'a>b', 'a"b', 'a|b']){
    const r = await call(env3, '/dropbox/folder',
      { method: 'POST', cookie: a3, body: { folder_name: bad } });
    ok(`a folder name containing ${JSON.stringify(bad.replace(/[A-Za-z ]/g, ''))} is refused`,
       r.status === 400 && (await jsonOf(r)).code === 'bad_folder_name');
  }
  ok('and the refusal left the good name in place',
     (await dbxOf()).folder_name === 'Always Precise Investigations');

  // ---- clearing is an answer, not a failure ----
  const cleared = await jsonOf(await setFolder(''));
  ok('an empty value clears the name', cleared.dropbox.folder_name === null);
  ok('and the per-case links go with it, rather than pointing somewhere wrong',
     cleared.dropbox.case_url_template === null
       && cleared.dropbox.web_url === 'https://www.dropbox.com/home/Apps');
  await setFolder('Always Precise Investigations');

  /* ADMIN ONLY, like every other Dropbox route. `/status` names the account and
     the folder is the firm's; an investigator gets neither. */
  const iv = await jsonOf(await invite(env3, a3,
    { username: 'dana3', display_name: 'Dana', role: 'investigator' }));
  const tk = new URL(iv.url, 'https://x.test').searchParams.get('invite');
  await call(env3, `/invite/${tk}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const dana3 = (await login(env3, 'dana3', 'FieldWork2026x')).cookie;
  ok('an investigator cannot read the Dropbox status',
     (await call(env3, '/dropbox/status', { cookie: dana3 })).status === 403);
  ok('nor record the folder name',
     (await setFolder('Somewhere Else', dana3)).status === 403);
  ok('and their attempt changed nothing',
     (await dbxOf()).folder_name === 'Always Precise Investigations');
  ok('signed out, the folder route is 401 rather than 403',
     (await call(env3, '/dropbox/folder',
       { method: 'POST', cookie: '', body: { folder_name: 'x' } })).status === 401);

  /* THE STATUS SCREEN DEGRADES RATHER THAN GOING DOWN, and this read is new —
     `dropboxState` now queries app_config before its own early returns. A
     database that cannot answer it must still report the connection. */
  const envNoCfg = freshEnv();
  await bootstrapAdmin(envNoCfg);
  const aNo = (await login(envNoCfg, 'trever', 'FirstAdminPass1')).cookie;
  envNoCfg.DROPBOX_APP_KEY = 'k'; envNoCfg.DROPBOX_APP_SECRET = 's';
  envNoCfg.DROPBOX_REFRESH_TOKEN = 'from-a-secret';
  await envNoCfg.DB.prepare('DROP TABLE app_config').run();
  const degraded = await call(envNoCfg, '/dropbox/status', { cookie: aNo });
  ok('with app_config gone the status still answers', degraded.status === 200);
  const dNo = (await jsonOf(degraded)).dropbox;
  ok('still reporting the connection', dNo.connected === true);
  ok('and falling back to the Apps folder rather than a wrong link',
     dNo.folder_name === null && dNo.case_url_template === null
       && dNo.web_url === 'https://www.dropbox.com/home/Apps');

  /* THE FOLDER NAME IS FOR A LINK AND NOTHING ELSE. Uploads address the App
     Folder root, which needs no name — so a wrong name costs a link, never a
     misplaced file. Proven by the upload path being unable to see the value. */
  ok('no upload path reads the folder name',
     !/dropboxUpload[\s\S]{0,600}DBX_FOLDER_KEY/.test(wsrc));
}

/* ============================================================ UNIT 7 =====
   REPEAT CLIENT / FIRM PROFILES.

   The property under test throughout is the one the whole unit rests on: a
   profile is a reusable DEFAULT and a case is a SNAPSHOT, so editing a firm
   can change nothing about a case that already exists. It is asserted the
   only way worth asserting it — a real case is created from a real profile,
   the profile is then really edited, and every stored copy of the case is
   read back byte for byte. */

let lglSeq = 0;
const legalPayload = (over = {}) => ({
  case_no: `API-LGP-${++lglSeq}`,
  assignment: 'legal', service: 'Legal investigation assignment',
  contact_name: 'Tessa Boyd', client_name: 'Estate of L. Byrd',
  firm_name: 'Harmon & Reed LLP', firm_email: 'office@harmonreed.example',
  firm_phone: '(540) 555-0199', firm_address: '12 Court Square, Roanoke VA',
  attorney_name: 'Ruth Harmon', attorney_email: 'rharmon@harmonreed.example',
  attorney_phone: '540-555-0142',
  matter_number: 'M-2211', subject_name: 'Adverse Party',
  objective: 'Document daily activity', ...over,
});

section('Profiles: a firm is saved once and reused, and a case never moves again');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  // --- create the firm, with the people on it -----------------------------
  let res = await call(env, '/profiles', { method: 'POST', cookie: admin, body: {
    kind: 'law_firm', name: 'Harmon & Reed LLP', email: 'office@harmonreed.example',
    address: '12 Court Square, Roanoke VA', payment_arrangement: 'check_pickup',
    phones: [{ number: '(540) 555-0199', label: 'work' }],
    contacts: [
      { first_name: 'Ruth', last_name: 'Harmon', role: 'Attorney',
        email: 'rharmon@harmonreed.example', preferred: true,
        phones: [{ number: '540-555-0142', label: 'work' }, { number: '540 555 7788', label: 'mobile' }] },
      { first_name: 'Owen', last_name: 'Pike', role: 'Attorney', email: 'opike@harmonreed.example' },
      { first_name: 'Cora', last_name: 'Nye', role: 'Paralegal', email: 'cnye@harmonreed.example',
        phones: [{ number: '540-555-0143', label: 'work' }] },
      { first_name: 'Del', last_name: 'Watts', role: 'Billing Contact', email: 'ap@harmonreed.example' },
    ],
  } });
  ok('an admin creates a law firm profile', res.status === 201, String(res.status));
  const firm = (await jsonOf(res)).profile;
  const FIRM_ID = firm.id;
  ok('it is typed as a law firm', firm.kind === 'law_firm', firm.kind);
  ok('two attorneys, a paralegal and a billing contact all sit on it',
     firm.contacts.filter(c => c.role === 'Attorney').length === 2
     && firm.contacts.some(c => c.role === 'Paralegal')
     && firm.contacts.some(c => c.role === 'Billing Contact'),
     JSON.stringify(firm.contacts.map(c => c.role)));
  ok('names are stored apart, never concatenated',
     firm.contacts[0].first_name === 'Ruth' && firm.contacts[0].last_name === 'Harmon');
  ok('one contact carries two labelled numbers',
     (firm.contacts.find(c => c.last_name === 'Harmon').phones || []).length === 2,
     JSON.stringify(firm.contacts.find(c => c.last_name === 'Harmon').phones));
  ok('and the firm has its own office line',
     firm.phones.length === 1 && firm.phones[0].number === '(540) 555-0199');
  ok('exactly one contact is the preferred one',
     firm.contacts.filter(c => c.preferred).length === 1);

  /* NO FIGURE OF ANY KIND LIVES ON A PROFILE. The authoritative pricing source
     stays authoritative because there is nothing here to disagree with it. */
  ok('a profile holds no retainer, rate or matter number',
     !('retainer' in firm) && !('retainer_amount' in firm) && !('rate' in firm)
     && !('matter_number' in firm),
     Object.keys(firm).join(','));
  ok('the arrangement it does hold is one of the owner\'s four',
     firm.payment_arrangement === 'check_pickup');

  // --- start an assignment from it ---------------------------------------
  res = await call(env, '/intakes', { method: 'POST', cookie: admin, body: {
    kind: 'legal', profile_id: FIRM_ID,
    profile_contact_id: firm.contacts.find(c => c.last_name === 'Harmon').id,
    // what the browser prefilled, and what the office typed on top of it
    firm_name: 'Harmon & Reed LLP', firm_email: 'office@harmonreed.example',
    firm_phone: '(540) 555-0199', firm_address: '12 Court Square, Roanoke VA',
    attorney_name: 'Ruth Harmon', attorney_email: 'rharmon@harmonreed.example',
    payment_arrangement: 'check_pickup',
    client_name: 'Estate of L. Byrd', subject_name: 'Adverse Party',
    matter_number: 'M-9001', assignment_type: 'Surveillance',
  } });
  ok('an assignment is created from the profile', res.status === 201, String(res.status));
  const CASE_A = (await jsonOf(res)).case_no;

  const wsA = await jsonOf(await call(env, `/cases/${CASE_A}/workspace`, { cookie: admin }));
  ok('the case is a legal case as before', !!wsA.legal, JSON.stringify(wsA.legal && wsA.legal.firm_name));
  ok('the firm details were prefilled onto it',
     wsA.legal.firm_name === 'Harmon & Reed LLP' && wsA.legal.firm_phone === '(540) 555-0199'
     && wsA.legal.attorney_name === 'Ruth Harmon', JSON.stringify(wsA.legal.firm_phone));
  ok('the case records which profile it came from',
     wsA.profile && wsA.profile.link && Number(wsA.profile.link.profile_id) === FIRM_ID,
     JSON.stringify(wsA.profile && wsA.profile.link));
  ok('and which person on it', wsA.profile.contact && wsA.profile.contact.last_name === 'Harmon');
  /* THE CASE-SPECIFIC FACTS ARE THE CASE'S OWN. A matter number is per matter
     and must never be a firm-wide value. */
  ok('the matter number is the new one, not anything remembered',
     wsA.legal.matter_number === 'M-9001', wsA.legal.matter_number);

  // --- now edit the firm, hard -------------------------------------------
  res = await call(env, `/profiles/${FIRM_ID}`, { method: 'POST', cookie: admin, body: {
    name: 'Harmon Reed & Vance LLP', email: 'new@harmonreed.example',
    address: '400 Franklin Road, Roanoke VA',
    phones: [{ number: '(540) 555-2200', label: 'work' }],
  } });
  ok('the firm is renamed, re-addressed and given a new number', res.status === 200, String(res.status));
  const edited = (await jsonOf(res)).profile;
  ok('the profile itself changed', edited.name === 'Harmon Reed & Vance LLP'
     && edited.phones[0].number === '(540) 555-2200');

  const wsA2 = await jsonOf(await call(env, `/cases/${CASE_A}/workspace`, { cookie: admin }));
  ok('THE EXISTING CASE DID NOT MOVE — firm name',
     wsA2.legal.firm_name === 'Harmon & Reed LLP', wsA2.legal.firm_name);
  ok('THE EXISTING CASE DID NOT MOVE — office phone',
     wsA2.legal.firm_phone === '(540) 555-0199', wsA2.legal.firm_phone);
  ok('THE EXISTING CASE DID NOT MOVE — office address',
     wsA2.legal.firm_address === '12 Court Square, Roanoke VA', wsA2.legal.firm_address);
  /* Both stored copies, because the list reads the columns and the screen
     reads the payload — a drift between them is how one screen would show the
     new name and another the old. */
  const rowA = await env.DB.prepare(
    'SELECT client_name, payload FROM submissions WHERE case_no = ?').bind(CASE_A).first();
  ok('and neither stored copy of the case moved',
     JSON.parse(rowA.payload).firm_name === 'Harmon & Reed LLP'
     && !JSON.parse(rowA.payload).firm_name.includes('Vance'), rowA.client_name);
  ok('the link still points at the same profile, which is now simply renamed',
     wsA2.profile.link && Number(wsA2.profile.link.profile_id) === FIRM_ID
     && wsA2.profile.profile.name === 'Harmon Reed & Vance LLP');

  // --- deactivate ---------------------------------------------------------
  res = await call(env, `/profiles/${FIRM_ID}`, { method: 'POST', cookie: admin, body: { active: false } });
  ok('the firm can be deactivated', res.status === 200 && (await jsonOf(res)).profile.active === 0);
  let list = await jsonOf(await call(env, '/profiles', { cookie: admin }));
  ok('an inactive firm leaves the default directory',
     !list.profiles.some(p => p.id === FIRM_ID), JSON.stringify(list.profiles.map(p => p.name)));
  list = await jsonOf(await call(env, '/profiles?inactive=1', { cookie: admin }));
  ok('and is found under the inactive lens', list.profiles.some(p => p.id === FIRM_ID));
  const wsA3 = await jsonOf(await call(env, `/cases/${CASE_A}/workspace`, { cookie: admin }));
  ok('deactivating changed nothing at all about the case',
     wsA3.legal.firm_name === 'Harmon & Reed LLP' && wsA3.status === wsA.status);
  await call(env, `/profiles/${FIRM_ID}`, { method: 'POST', cookie: admin, body: { active: true } });

  // --- deletion cannot reach a case --------------------------------------
  res = await call(env, `/profiles/${FIRM_ID}/delete`, { method: 'POST', cookie: admin });
  ok('deleting a firm that has cases is REFUSED', res.status === 409, String(res.status));
  const refusal = await jsonOf(res);
  ok('the refusal names the count and points at Inactive',
     refusal.code === 'profile_in_use' && refusal.cases === 1 && /Inactive/.test(refusal.error),
     refusal.error);
  const stillThere = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions WHERE case_no = ?')
    .bind(CASE_A).first();
  ok('and the case is untouched by the attempt', Number(stillThere.n) === 1);

  // A profile no case has ever used really does delete.
  const spare = (await jsonOf(await call(env, '/profiles', { method: 'POST', cookie: admin,
    body: { kind: 'private_client', name: 'Typo McTypo', confirm_new: true } }))).profile;
  res = await call(env, `/profiles/${spare.id}/delete`, { method: 'POST', cookie: admin });
  ok('an unused profile deletes cleanly', res.status === 200, String(res.status));
  ok('and it is gone', (await call(env, `/profiles/${spare.id}`, { cookie: admin })).status === 404);
}

section('Profiles: the picker finds a firm by any of the things the office remembers');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  await call(env, '/profiles', { method: 'POST', cookie: admin, body: {
    kind: 'law_firm', name: 'Calloway Legal Group', email: 'front@calloway.example',
    phones: [{ number: '(540) 555-3311', label: 'work' }],
    contacts: [{ first_name: 'Beatrix', last_name: 'Sandoval', role: 'Paralegal',
      email: 'bsandoval@calloway.example', phones: [{ number: '540.555.9090', label: 'mobile' }] }],
  } });
  await call(env, '/profiles', { method: 'POST', cookie: admin, body: {
    kind: 'insurance_org', name: 'Blue Ridge Mutual', email: 'claims@brm.example',
    contacts: [{ first_name: 'Hal', last_name: 'Ivers', role: 'Adjuster', email: 'hivers@brm.example' }],
  } });

  const find = async q => (await jsonOf(await call(env,
    `/profiles?q=${encodeURIComponent(q)}`, { cookie: admin }))).profiles.map(p => p.name);
  ok('by organisation name', (await find('calloway')).includes('Calloway Legal Group'));
  ok('by a paralegal\'s name', (await find('sandoval')).includes('Calloway Legal Group'));
  ok('by an adjuster\'s name', (await find('ivers')).includes('Blue Ridge Mutual'));
  ok('by email', (await find('bsandoval@calloway.example')).includes('Calloway Legal Group'));
  /* THE FORMATTING OF A PHONE NUMBER MAKES NO DIFFERENCE — the whole reason
     `digits` is stored beside the number the office typed. */
  ok('by the office number typed with brackets', (await find('(540) 555-3311')).includes('Calloway Legal Group'));
  ok('by the same number typed bare', (await find('5405553311')).includes('Calloway Legal Group'));
  ok('by a mobile stored with dots, searched with dashes',
     (await find('540-555-9090')).includes('Calloway Legal Group'));
  ok('a search that matches nothing returns nothing rather than everything',
     (await find('zzzz-nothing')).length === 0);

  const byKind = async k => (await jsonOf(await call(env, `/profiles?kind=${k}`, { cookie: admin })))
    .profiles.map(p => p.name);
  ok('the law-firm lens shows only firms', JSON.stringify(await byKind('law_firm')) === '["Calloway Legal Group"]');
  ok('the insurance lens shows only carriers', JSON.stringify(await byKind('insurance_org')) === '["Blue Ridge Mutual"]');
  ok('and the unfiltered list shows both', (await byKind('')).length === 2);

  /* NO N+1: the directory's contacts, phones and case counts come back for the
     whole page in one read each. Asserted structurally, on the source. */
  const psrc = fs.readFileSync(path.join(HERE, 'worker.js'), 'utf8');
  const fn = (psrc.match(/async function searchProfiles\([\s\S]*?\n}\n/) || [''])[0];
  ok('searchProfiles has no per-profile query inside a loop',
     fn.length > 0 && !/for\s*\([^)]*\)\s*\{[^}]*await env\.DB\.prepare/.test(fn));
  ok('it reads contacts and phones for the whole result set at once',
     /profile_contact WHERE profile_id IN \(/.test(fn) && /profile_phone\s*\n?\s*WHERE profile_id IN \(/.test(fn));
}

section('Profiles: a possible duplicate WARNS and never merges');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const first = (await jsonOf(await call(env, '/profiles', { method: 'POST', cookie: admin, body: {
    kind: 'law_firm', name: 'Smith Law', email: 'hello@smithlaw.example',
    phones: [{ number: '(540) 555-4400', label: 'work' }],
  } }))).profile;

  let res = await call(env, '/profiles', { method: 'POST', cookie: admin,
    body: { kind: 'law_firm', name: 'Smith Law Group' } });
  ok('a similar name is stopped with POSSIBLE EXISTING PROFILE', res.status === 409, String(res.status));
  let b = await jsonOf(res);
  ok('the warning names what it matched',
     b.code === 'possible_duplicate' && b.matches[0].id === first.id
     && b.matches[0].why.includes('similar_name'), JSON.stringify(b.matches));
  ok('and NOTHING was written', (await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM profile').first()).n === 1);

  /* "Smith Law" and "Smith Law Group" MAY OR MAY NOT be the same firm, and
     the portal does not guess: Continue as New really does continue. */
  res = await call(env, '/profiles', { method: 'POST', cookie: admin,
    body: { kind: 'law_firm', name: 'Smith Law Group', confirm_new: true } });
  ok('Continue as New creates the second firm', res.status === 201, String(res.status));
  const second = (await jsonOf(res)).profile;
  ok('two separate profiles now exist',
     (await env.DB.prepare('SELECT COUNT(*) AS n FROM profile').first()).n === 2);
  const stillFirst = await jsonOf(await call(env, `/profiles/${first.id}`, { cookie: admin }));
  ok('and the FIRST one was not rewritten by the second',
     stillFirst.profile.name === 'Smith Law' && stillFirst.profile.email === 'hello@smithlaw.example',
     stillFirst.profile.name);
  ok('they are genuinely different rows', second.id !== first.id);

  // The other three normalized comparisons.
  res = await call(env, '/profiles', { method: 'POST', cookie: admin,
    body: { kind: 'private_client', name: 'Completely Different', email: 'HELLO@SmithLaw.example  ' } });
  ok('the same email in different case and spacing is caught', res.status === 409);
  ok('and it says so by name', (await jsonOf(res)).matches[0].why.includes('email'));
  res = await call(env, '/profiles', { method: 'POST', cookie: admin,
    body: { kind: 'private_client', name: 'Also Different', phone: '+1 540 555 4400' } });
  ok('the same number written differently is caught', res.status === 409);
  ok('and it says so by name', (await jsonOf(res)).matches[0].why.includes('phone'));

  /* An unrelated firm must not be caught: a warning that fires on everything
     is a warning nobody reads. */
  res = await call(env, '/profiles', { method: 'POST', cookie: admin,
    body: { kind: 'law_firm', name: 'Okonkwo & Bell', email: 'clerk@okbell.example' } });
  ok('an unrelated firm saves with no warning at all', res.status === 201, String(res.status));

  /* AND THERE IS NO MERGE TO REACH. Not a route, not a function, not a column. */
  const psrc = fs.readFileSync(path.join(HERE, 'worker.js'), 'utf8');
  ok('no merge routine exists anywhere in the Worker',
     !/function\s+\w*[Mm]ergeProfile|merged_into|profile_merge/.test(psrc));
  ok('and no statement updates a profile from a submission',
     !/UPDATE profile[\s\S]{0,200}FROM submissions/i.test(psrc));

  // Contacts: warned, never merged, and two people may share a name.
  const cRes1 = await call(env, `/profiles/${first.id}/contacts`, { method: 'POST', cookie: admin,
    body: { first_name: 'Ann', last_name: 'Smith', role: 'Attorney', email: 'asmith@smithlaw.example' } });
  ok('a first contact is added', cRes1.status === 201, String(cRes1.status));
  let cRes = await call(env, `/profiles/${first.id}/contacts`, { method: 'POST', cookie: admin,
    body: { first_name: 'Ann', last_name: 'Smith', role: 'Paralegal' } });
  ok('a same-named contact WARNS', cRes.status === 409, String(cRes.status));
  ok('and names why', (await jsonOf(cRes)).code === 'possible_duplicate_contact');
  cRes = await call(env, `/profiles/${first.id}/contacts`, { method: 'POST', cookie: admin,
    body: { first_name: 'Ann', last_name: 'Smith', role: 'Paralegal', confirm_new: true } });
  ok('but two people really may share a name', cRes.status === 201, String(cRes.status));
  const both = (await jsonOf(cRes)).profile.contacts.filter(c => c.last_name === 'Smith');
  ok('both are kept, apart, with their own roles',
     both.length === 2 && both.some(c => c.role === 'Attorney') && both.some(c => c.role === 'Paralegal'),
     JSON.stringify(both.map(c => c.role)));
  ok('and the first one\'s email was not overwritten by the second',
     both.find(c => c.role === 'Attorney').email === 'asmith@smithlaw.example');
}

section('Profiles: reuse on the insurance and private paths carries identity and nothing else');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  const carrier = (await jsonOf(await call(env, '/profiles', { method: 'POST', cookie: admin, body: {
    kind: 'insurance_org', name: 'Blue Ridge Mutual', email: 'claims@brm.example',
    address: '900 Orange Ave, Roanoke VA',
    phones: [{ number: '(540) 555-6600', label: 'work' }],
    contacts: [{ first_name: 'Hal', last_name: 'Ivers', role: 'Adjuster',
      email: 'hivers@brm.example', preferred: true,
      phones: [{ number: '540-555-6601', label: 'work' }] }],
  } }))).profile;

  // First claim on this carrier.
  const one = await jsonOf(await call(env, '/intakes', { method: 'POST', cookie: admin, body: {
    kind: 'claims', profile_id: carrier.id, carrier: 'Blue Ridge Mutual',
    adjuster: 'Hal Ivers', adjuster_email: 'hivers@brm.example',
    claim_number: 'BRM-1001', subject_name: 'C. Vaughn', objective: 'Three days',
  } }));
  // A later, entirely separate claim from the same carrier.
  const two = await jsonOf(await call(env, '/intakes', { method: 'POST', cookie: admin, body: {
    kind: 'claims', profile_id: carrier.id, carrier: 'Blue Ridge Mutual',
    adjuster: 'Hal Ivers', adjuster_email: 'hivers@brm.example',
    claim_number: 'BRM-2002', subject_name: 'D. Rowe',
  } }));
  const p1 = JSON.parse((await env.DB.prepare('SELECT payload FROM submissions WHERE case_no = ?')
    .bind(one.case_no).first()).payload);
  const p2 = JSON.parse((await env.DB.prepare('SELECT payload FROM submissions WHERE case_no = ?')
    .bind(two.case_no).first()).payload);
  ok('the carrier and adjuster carried across both assignments',
     p1.carrier === 'Blue Ridge Mutual' && p2.carrier === 'Blue Ridge Mutual'
     && p2.adjuster === 'Hal Ivers');
  /* THE NEW MATTER IS NEW. An old claim number, subject or objective must not
     ride along on the next assignment from the same carrier. */
  ok('the new claim has its OWN claim number', p2.claim_number === 'BRM-2002', p2.claim_number);
  ok('and its own subject', p2.subject_name === 'D. Rowe', p2.subject_name);
  ok('and no objective was inherited from the earlier claim', !p2.objective, String(p2.objective));
  ok('the earlier claim is unchanged', p1.claim_number === 'BRM-1001' && p1.subject_name === 'C. Vaughn');
  ok('both cases are still typed as claims',
     (await env.DB.prepare("SELECT COUNT(*) AS n FROM submissions WHERE kind = 'claims'").first()).n === 2);

  // Private client: identity only.
  const person = (await jsonOf(await call(env, '/profiles', { method: 'POST', cookie: admin, body: {
    kind: 'private_client', name: 'Marguerite Vance', email: 'mv@example.com',
    address: '77 Elm Street, Bedford VA',
    phones: [{ number: '540-555-7777', label: 'mobile' }, { number: '540-555-7778', label: 'work' }],
  } }))).profile;
  ok('a private client is the profile — no contact row is required',
     person.contacts.length === 0 && person.phones.length === 2, JSON.stringify(person.phones.length));
  const pc = await jsonOf(await call(env, '/intakes', { method: 'POST', cookie: admin, body: {
    kind: 'consumer', profile_id: person.id, client_name: 'Marguerite Vance',
    client_email: 'mv@example.com', client_phone: '540-555-7777',
    service: 'Surveillance', subject_name: 'A New Subject Entirely',
  } }));
  const pp = JSON.parse((await env.DB.prepare('SELECT payload FROM submissions WHERE case_no = ?')
    .bind(pc.case_no).first()).payload);
  ok('the repeat private client\'s identity carried', pp.client_name === 'Marguerite Vance'
     && pp.client_phone === '540-555-7777');
  ok('and nothing about a previous case did',
     pp.subject_name === 'A New Subject Entirely' && !pp.allegations && !pp.notes,
     JSON.stringify(Object.keys(pp)));
}

section('Profiles are the firm\'s own — the public and the field never see them');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const link = (await jsonOf(await invite(env, admin,
    { username: 'dana', display_name: 'Dana', role: 'investigator' }))).url;
  const token = new URL(link, 'https://x.test').searchParams.get('invite');
  await call(env, `/invite/${token}/accept`, { method: 'POST', body: { password: 'FieldWork2026x' } });
  const dana = (await login(env, 'dana', 'FieldWork2026x')).cookie;

  const firm = (await jsonOf(await call(env, '/profiles', { method: 'POST', cookie: admin, body: {
    kind: 'law_firm', name: 'Harmon & Reed LLP', email: 'office@harmonreed.example',
    contacts: [{ first_name: 'Ruth', last_name: 'Harmon', role: 'Attorney',
      email: 'rharmon@harmonreed.example', preferred: true }],
  } }))).profile;

  // --- the investigator ---------------------------------------------------
  for (const [label, p, method] of [
    ['browse the directory', '/profiles', 'GET'],
    ['open a profile', `/profiles/${firm.id}`, 'GET'],
    ['search for a saved attorney', '/profiles?q=harmon', 'GET'],
    ['run the match check', '/profiles/match?name=harmon', 'GET'],
    ['create one', '/profiles', 'POST'],
    ['edit one', `/profiles/${firm.id}`, 'POST'],
    ['add a contact', `/profiles/${firm.id}/contacts`, 'POST'],
    ['delete one', `/profiles/${firm.id}/delete`, 'POST'],
  ]) {
    const r = await call(env, p, { method, cookie: dana, body: method === 'POST' ? {} : undefined });
    ok(`an investigator cannot ${label}`, r.status === 403, `${p} -> ${r.status}`);
  }
  for (const [label, p, method] of [
    ['browse the directory', '/profiles', 'GET'],
    ['open a profile', `/profiles/${firm.id}`, 'GET'],
    ['create one', '/profiles', 'POST'],
  ]) {
    const r = await call(env, p, { method, body: method === 'POST' ? {} : undefined });
    ok(`a signed-out caller cannot ${label}`, r.status === 401, `${p} -> ${r.status}`);
  }

  // A case the investigator IS on still tells them nothing about the firm.
  const made = await jsonOf(await call(env, '/intakes', { method: 'POST', cookie: admin, body: {
    kind: 'legal', profile_id: firm.id, firm_name: 'Harmon & Reed LLP',
    attorney_name: 'Ruth Harmon', attorney_email: 'rharmon@harmonreed.example',
    subject_name: 'Watched Party', objective: 'Document activity',
  } }));
  const danaId = (await env.DB.prepare("SELECT id FROM users WHERE username = 'dana'").first()).id;
  await call(env, `/submissions/${made.case_no}/assign`, { method: 'POST', cookie: admin,
    body: { user_id: danaId } });
  const wsD = await call(env, `/cases/${made.case_no}/workspace`, { cookie: dana });
  ok('the investigator can open their own case', wsD.status === 200, String(wsD.status));
  const ws = await jsonOf(wsD);
  ok('and the workspace carries no profile key at all', ws.profile === undefined,
     JSON.stringify(ws.profile));
  /* Both halves of what actually reaches their browser: the workspace and the
     redacted case detail. A field the page declines to draw is still in the
     network tab, so the assertion is on the response, not the screen. */
  const detail = await jsonOf(await call(env, `/submissions/${made.case_no}`, { cookie: dana }));
  const whole = JSON.stringify(ws) + JSON.stringify(detail);
  ok('nothing about the firm reached them', !whole.includes('Harmon') && !whole.includes('harmonreed'),
     whole.slice(0, 300));
  ok('while the subject still does', whole.includes('Watched Party'), JSON.stringify(detail).slice(0, 300));
  ok('and the case detail carries no profile either', detail.profile === undefined,
     JSON.stringify(detail.profile));

  /* THE PUBLIC SIDE HAS NO DOOR, which is stronger than a refusal at one. */
  const psrc = fs.readFileSync(path.join(HERE, 'worker.js'), 'utf8');
  const ingestFn = (psrc.match(/async function handleIngest\([\s\S]*?\n}\n/) || [''])[0];
  ok('the public ingest reads no profile table', ingestFn.length > 0
     && !/\bprofile\b/.test(ingestFn.replace(/\/\*[\s\S]*?\*\//g, '')), 'ingest mentions a profile');
  /* And a payload that names one writes no link — the submitted form cannot
     associate itself with a firm even by guessing an id. */
  const sneaky = await ingest(env, legalPayload({ profile_id: firm.id, case_no: 'API-SNEAK-1' }));
  ok('a public submission is still accepted', sneaky.status === 200, String(sneaky.status));
  const sneakNo = (await jsonOf(sneaky)).case_no;
  const linked = await env.DB.prepare('SELECT COUNT(*) AS n FROM case_profile WHERE case_no = ?')
    .bind(sneakNo).first();
  ok('but a profile_id in a public payload links nothing', Number(linked.n) === 0, String(linked.n));
}

section('Profiles: a submission is linked or saved only when an admin says so');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const firm = (await jsonOf(await call(env, '/profiles', { method: 'POST', cookie: admin, body: {
    kind: 'law_firm', name: 'Harmon & Reed LLP', email: 'office@harmonreed.example',
    phones: [{ number: '(540) 555-0199', label: 'work' }],
    contacts: [{ first_name: 'Ruth', last_name: 'Harmon', role: 'Attorney', preferred: true }],
  } }))).profile;

  const sub = await jsonOf(await ingest(env, legalPayload()));
  const NO = sub.case_no;
  let ws = await jsonOf(await call(env, `/cases/${NO}/workspace`, { cookie: admin }));
  ok('a fresh public submission is linked to nothing', ws.profile.link === null,
     JSON.stringify(ws.profile.link));
  ok('but the admin reviewing it is shown the possible match',
     (ws.profile.suggested || []).some(m => m.id === firm.id),
     JSON.stringify(ws.profile.suggested));
  ok('the suggestion says why it surfaced',
     ws.profile.suggested[0].why.length > 0, JSON.stringify(ws.profile.suggested[0].why));
  /* A SUGGESTION IS NOT AN ACT. Reading the case must not have changed a row. */
  ok('and looking at it wrote nothing',
     (await env.DB.prepare('SELECT COUNT(*) AS n FROM case_profile').first()).n === 0);
  const before = await env.DB.prepare('SELECT name, email FROM profile WHERE id = ?').bind(firm.id).first();

  // Explicit association.
  let res = await call(env, `/cases/${NO}/profile`, { method: 'POST', cookie: admin,
    body: { profile_id: firm.id, contact_id: firm.contacts[0].id } });
  ok('the admin can associate it explicitly', res.status === 200, String(res.status));
  ws = await jsonOf(await call(env, `/cases/${NO}/workspace`, { cookie: admin }));
  ok('the link is recorded', Number(ws.profile.link.profile_id) === firm.id);
  ok('with who did it and when', ws.profile.link.linked_by && ws.profile.link.linked_at);
  const after = await env.DB.prepare('SELECT name, email FROM profile WHERE id = ?').bind(firm.id).first();
  ok('ASSOCIATING DID NOT WRITE THE SUBMITTED VALUES INTO THE SAVED PROFILE',
     after.name === before.name && after.email === before.email,
     `${before.name}/${before.email} -> ${after.name}/${after.email}`);

  // Unlink, then Save as profile on a case that matches nothing.
  await call(env, `/cases/${NO}/profile`, { method: 'POST', cookie: admin, body: { clear: true } });
  ws = await jsonOf(await call(env, `/cases/${NO}/workspace`, { cookie: admin }));
  ok('it can be unlinked again', ws.profile.link === null);

  const fresh = await jsonOf(await ingest(env, legalPayload({
    firm_name: 'Okonkwo & Bell', firm_email: 'clerk@okbell.example', firm_phone: '540-555-8080',
    attorney_name: 'Femi Okonkwo', attorney_email: 'fo@okbell.example',
    paralegal_name: 'Ines Bell', paralegal_email: 'ib@okbell.example',
  })));
  res = await call(env, `/cases/${fresh.case_no}/profile`, { method: 'POST', cookie: admin,
    body: { save_as_profile: true } });
  ok('Save as Profile creates one from what the case already holds', res.status === 201, String(res.status));
  const saved = (await jsonOf(res)).profile;
  ok('typed from the case — a legal submission makes a law firm',
     saved.profile.kind === 'law_firm', saved.profile.kind);
  const savedFull = await jsonOf(await call(env, `/profiles/${saved.profile.id}`, { cookie: admin }));
  ok('the firm name came across', savedFull.profile.name === 'Okonkwo & Bell');
  ok('and so did the people the case named, with their roles',
     savedFull.profile.contacts.some(c => c.last_name === 'Okonkwo' && c.role === 'Attorney')
     && savedFull.profile.contacts.some(c => c.last_name === 'Bell' && c.role === 'Paralegal'),
     JSON.stringify(savedFull.profile.contacts.map(c => `${c.last_name}:${c.role}`)));
  ok('the case is now linked to it',
     Number((await jsonOf(await call(env, `/cases/${fresh.case_no}/workspace`, { cookie: admin })))
       .profile.link.profile_id) === saved.profile.id);

  /* Save as profile on a case that DOES look like an existing firm refuses,
     rather than quietly adding a second Harmon & Reed. */
  const dup = await jsonOf(await ingest(env, legalPayload({ matter_number: 'M-3333' })));
  res = await call(env, `/cases/${dup.case_no}/profile`, { method: 'POST', cookie: admin,
    body: { save_as_profile: true } });
  ok('and it refuses when the firm already exists', res.status === 409, String(res.status));
  ok('naming the profile it would duplicate',
     (await jsonOf(res)).matches.some(m => m.id === firm.id));
}

section('Profiles: nothing on one can be paid, and no price is frozen into one');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const firm = (await jsonOf(await call(env, '/profiles', { method: 'POST', cookie: admin, body: {
    kind: 'law_firm', name: 'Vance & Loeb', payment_arrangement: 'check_pickup',
  } }))).profile;

  /* An arrangement is a REQUEST. Choosing one on a firm cannot put money on
     any ledger — the same rule the case panel already lives by. */
  ok('the arrangement is stored as a default', firm.payment_arrangement === 'check_pickup');
  ok('no retainer payment exists anywhere',
     (await env.DB.prepare('SELECT COUNT(*) AS n FROM retainer_payment').first()).n === 0);
  const made = await jsonOf(await call(env, '/intakes', { method: 'POST', cookie: admin, body: {
    kind: 'legal', profile_id: firm.id, firm_name: 'Vance & Loeb',
    attorney_name: 'Iris Loeb', payment_arrangement: 'check_pickup',
  } }));
  ok('nor after an assignment is started from it',
     (await env.DB.prepare('SELECT COUNT(*) AS n FROM retainer_payment').first()).n === 0);
  ok('and the case has no retainer marked received',
     !(await env.DB.prepare('SELECT received FROM case_retainer WHERE case_no = ?')
       .bind(made.case_no).first()),
     'a retainer row appeared from nowhere');

  /* THE ARRANGEMENT IS A LAW-FIRM PREFERENCE ONLY. A carrier is authorized in
     hour blocks and a private client pays a retainer; neither is billed this
     way, and offering it would be the wrong billing model on the wrong door. */
  let res = await call(env, '/profiles', { method: 'POST', cookie: admin, body: {
    kind: 'insurance_org', name: 'Somewhere Mutual', payment_arrangement: 'bill_ach' } });
  ok('an insurance profile is refused a legal payment arrangement', res.status === 400, String(res.status));
  res = await call(env, '/profiles', { method: 'POST', cookie: admin, body: {
    kind: 'law_firm', name: 'Bad Arrangement LLP', payment_arrangement: 'venmo' } });
  ok('and a made-up arrangement is refused outright', res.status === 400, String(res.status));

  /* CASH APP AND VENMO STILL REACH A LAW FIRM THROUGH NO CODE PATH — the
     profile added no new door to that, which is the thing worth proving. */
  const psrc = fs.readFileSync(path.join(HERE, 'worker.js'), 'utf8');
  const profBlock = psrc.slice(psrc.indexOf('REPEAT CLIENT / FIRM PROFILES (Unit 7'));
  ok('no profile code mentions a consumer payment method',
     !/cash_app|venmo/i.test(profBlock.slice(0, 20000)));
  ok('and no profile column stores a figure',
     !/retainer_amount|hourly|package_price|fee_due/.test(
       (fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8')
         .match(/CREATE TABLE IF NOT EXISTS profile[\s\S]*?\n\);/) || [''])[0]));
}

section('Profiles: the guards, the sweep and a database that has not been set up yet');
{
  /* THE TABLES ARRIVE BY A MANUAL portal-setup DISPATCH while the Worker
     deploys on push, so between the two they do not exist. Every read must
     degrade and every write must say which workflow to run — the shape
     legal_intake and case_archive already established. */
  const bare = new DatabaseSync(':memory:');
  bare.exec(SCHEMA);
  for (const t of ['case_profile', 'profile_phone', 'profile_contact', 'profile']) {
    bare.exec(`DROP TABLE ${t}`);
  }
  const env = { ...freshEnv(), DB: d1(bare) };
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;

  let res = await call(env, '/profiles', { cookie: admin });
  ok('the directory answers rather than failing', res.status === 200, String(res.status));
  let b = await jsonOf(res);
  ok('and says it is not set up yet, naming nothing it cannot show',
     b.not_set_up === true && b.profiles.length === 0);
  res = await call(env, '/profiles', { method: 'POST', cookie: admin,
    body: { kind: 'law_firm', name: 'Anything LLP' } });
  ok('a write returns 503 naming the workflow', res.status === 503, String(res.status));
  ok('in words the office can act on', /portal-setup/.test((await jsonOf(res)).error));

  const sub = await jsonOf(await ingest(env, legalPayload()));
  ok('an intake still lands on a database without the profile tables',
     !!sub.case_no, JSON.stringify(sub));
  const ws = await jsonOf(await call(env, `/cases/${sub.case_no}/workspace`, { cookie: admin }));
  ok('and the case workspace still loads', !!ws.case_no && ws.profile.not_set_up === true,
     JSON.stringify(ws.profile));
  const quick = await call(env, '/intakes', { method: 'POST', cookie: admin,
    body: { kind: 'legal', firm_name: 'Some Firm', profile_id: 4, save_profile: true } });
  ok('a quick assignment naming a profile still creates the case', quick.status === 201,
     String(quick.status));

  /* THE SWEEP: the link goes with a test case, the firm does not. */
  const env2 = freshEnv();
  await bootstrapAdmin(env2);
  const admin2 = (await login(env2, 'trever', 'FirstAdminPass1')).cookie;
  const keep = (await jsonOf(await call(env2, '/profiles', { method: 'POST', cookie: admin2,
    body: { kind: 'law_firm', name: 'Kept & Kept LLP',
      contacts: [{ first_name: 'A', last_name: 'Keeper', role: 'Attorney' }] } }))).profile;
  await call(env2, '/demo-case', { method: 'POST', cookie: admin2 });
  const demoNo = (await env2.DB.prepare(
    "SELECT case_no FROM submissions WHERE case_no LIKE 'TEST-%' LIMIT 1").first()).case_no;
  await call(env2, `/cases/${demoNo}/profile`, { method: 'POST', cookie: admin2,
    body: { profile_id: keep.id } });
  ok('a test case can be linked to a firm',
     (await env2.DB.prepare('SELECT COUNT(*) AS n FROM case_profile').first()).n === 1);
  await call(env2, '/demo-case/clear', { method: 'POST', cookie: admin2 });
  ok('clearing the test case removes its link',
     (await env2.DB.prepare('SELECT COUNT(*) AS n FROM case_profile').first()).n === 0);
  ok('and leaves the firm, its people and its numbers exactly where they were',
     (await env2.DB.prepare('SELECT COUNT(*) AS n FROM profile').first()).n === 1
     && (await env2.DB.prepare('SELECT COUNT(*) AS n FROM profile_contact').first()).n === 1,
     'a real client was swept away with a test case');

  /* The registration a new table needs, checked on the source rather than
     believed: /health must know it, or it reports a clean schema on a
     database that then 503s. */
  const psrc = fs.readFileSync(path.join(HERE, 'worker.js'), 'utf8');
  const expected = (psrc.match(/const EXPECTED_TABLES = \[([\s\S]*?)\n\];/) || [, ''])[1];
  for (const t of ['profile', 'profile_contact', 'profile_phone', 'case_profile']) {
    ok(`${t} is named in EXPECTED_TABLES`, new RegExp(`'${t}'`).test(expected));
  }
  const sweep = (psrc.match(/const DEMO_SWEEP = \[([\s\S]*?)\n\];/) || [, ''])[1];
  ok('case_profile is swept', /'case_profile'/.test(sweep));
  ok('but the reference tables are NOT — a firm is not case data',
     !/\['profile'/.test(sweep) && !/\['profile_contact'/.test(sweep)
     && !/\['profile_phone'/.test(sweep));

  /* Applying the schema twice must be a no-op, because portal-setup re-applies
     it on every run. */
  const twice = new DatabaseSync(':memory:');
  twice.exec(SCHEMA);
  let threw = '';
  try { twice.exec(SCHEMA); } catch (e) { threw = String(e); }
  ok('the schema applies twice without error', threw === '', threw);
}

section('Profiles: the link route is inside the case gate, and the phone shape is the approved one');
{
  const env = freshEnv();
  await bootstrapAdmin(env);
  const admin = (await login(env, 'trever', 'FirstAdminPass1')).cookie;
  const firm = (await jsonOf(await call(env, '/profiles', { method: 'POST', cookie: admin,
    body: { kind: 'law_firm', name: 'Gate Test LLP' } }))).profile;
  const made = await jsonOf(await call(env, '/intakes', { method: 'POST', cookie: admin,
    body: { kind: 'legal', firm_name: 'Gate Test LLP', attorney_name: 'A B' } }));

  await call(env, `/cases/${made.case_no}/delete`, { method: 'POST', cookie: admin,
    body: { reason: 'test' } });
  let res = await call(env, `/cases/${made.case_no}/profile`, { method: 'POST', cookie: admin,
    body: { profile_id: firm.id } });
  ok('a DELETED case cannot acquire a client relationship', res.status === 409, String(res.status));
  ok('and the refusal is the standing one', (await jsonOf(res)).case_deleted === true);
  await call(env, `/cases/${made.case_no}/undelete`, { method: 'POST', cookie: admin });
  await call(env, `/cases/${made.case_no}/archive`, { method: 'POST', cookie: admin });
  res = await call(env, `/cases/${made.case_no}/profile`, { method: 'POST', cookie: admin,
    body: { profile_id: firm.id } });
  ok('nor can an ARCHIVED one', res.status === 409, String(res.status));

  /* The reason it is under /cases/:no/ at all: the gate is matched on the
     path, so a route named otherwise would be invisible to it. */
  const psrc = fs.readFileSync(path.join(HERE, 'worker.js'), 'utf8');
  ok('the link route is addressed under the case, not the profile',
     /\/\^\\\/cases\\\/\(\[A-Za-z0-9-\]\{3,64\}\)\\\/profile\$\//.test(psrc)
     || /cases\\\/\(\[A-Za-z0-9-\]\{3,64\}\)\\\/profile\$/.test(psrc),
     'no /cases/:no/profile route found');

  // Phones: the approved four labels, and both are kept.
  const env2 = freshEnv();
  await bootstrapAdmin(env2);
  const a2 = (await login(env2, 'trever', 'FirstAdminPass1')).cookie;
  const p = (await jsonOf(await call(env2, '/profiles', { method: 'POST', cookie: a2, body: {
    kind: 'private_client', name: 'Two Numbers',
    phones: [{ number: '540-555-1000', label: 'mobile' }, { number: '540-555-2000', label: 'work' },
      { number: '540-555-3000', label: 'not-a-label' }],
  } }))).profile;
  ok('a primary and a secondary number are both kept, in order',
     p.phones.length === 3 && p.phones[0].number === '540-555-1000'
     && p.phones[1].number === '540-555-2000', JSON.stringify(p.phones));
  ok('the four approved labels are honoured',
     p.phones[0].label === 'mobile' && p.phones[1].label === 'work');
  ok('and an unrecognised label is dropped rather than stored as one',
     p.phones[2].label === '', JSON.stringify(p.phones[2]));
  const digits = await env2.DB.prepare(
    'SELECT digits FROM profile_phone WHERE profile_id = ? ORDER BY position').bind(p.id).all();
  ok('every row carries its search key', (digits.results || []).every(r => r.digits.length >= 10),
     JSON.stringify(digits.results));
}

/* ------------------------------------------------------------------ report */

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
