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
  };
}

const ORIGIN = 'https://alwayspreciseinvestigations.net';
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
  };
}

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

/* ------------------------------------------------------------------ report */

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
