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
  ok('the personal sheet is labelled "$1,500 retainer"', d.sheets[0].name === '$1,500 retainer');
  ok('the personal sheet carries the retainer and the hourly rate',
     JSON.stringify(d.sheets[0]).includes('$1,500') && JSON.stringify(d.sheets[0]).includes('$100/hr'));
  const ins = JSON.stringify(d.sheets.find(s => s.id === 'insurance'));
  ok('the carrier sheet carries the whole ladder',
     ins.includes('$1,200') && ins.includes('$2,300') && ins.includes('$3,300'));
  ok('the carrier sheet states the overage rate', ins.includes('$150/hr'));
  ok('the retainer figure is not on the carrier sheet', !ins.includes('$1,500'));
  ok('whether sending is configured is reported', d.email_configured === true);

  /* A dollar sign on an hours figure reads as a price and is wrong twice over:
     it misstates the minimum day and it puts a number where a carrier expects
     a duration. It shipped once as "$8-hour minimum day". */
  const insSheet = d.sheets.find(s => s.id === 'insurance');
  ok('the minimum day is stated in hours, not dollars',
     insSheet.summary.includes('8-hour minimum day') && !insSheet.summary.includes('$8'),
     insSheet.summary);
  ok('the initial authorization is stated in hours',
     insSheet.summary.includes('24 hours is the usual'), insSheet.summary);
  ok('no hours figure anywhere on either sheet carries a dollar sign',
     !JSON.stringify(d.sheets).match(/\$\d+(\.\d+)?\s*-?\s*hour/i),
     JSON.stringify(d.sheets).slice(0, 300));

  ok('an unknown sheet id is a 404',
     (await call(env, '/sheets/nope/email', { method: 'POST', cookie: admin, body: { to: 'a@b.co' } })).status === 404);
  ok('a malformed address is refused before a send is spent',
     (await call(env, '/sheets/personal/email', { method: 'POST', cookie: admin, body: { to: 'not-an-address' } })).status === 400);
  ok('no provider call was made for either', providerCalls === 0);

  // The header-injection attempt: CR/LF smuggled through the case number,
  // which is the one field that reaches the subject line.
  const res = await call(env, '/sheets/personal/email', { method: 'POST', cookie: admin,
    body: { to: 'client@example.test', case_no: 'API-1\r\nBcc: thief@evil.test', note: 'line one\r\nline two' } });
  ok('a legitimate send succeeds', res.status === 200);
  ok('it goes to the address given', lastBody.to === 'client@example.test');
  ok('no CR or LF ever reaches the subject', !/[\r\n]/.test(lastBody.subject), JSON.stringify(lastBody.subject));
  ok('the case number itself survives sanitizing', lastBody.subject.includes('API-1'));
  ok('the note is flattened to one line in the HTML part', lastBody.html.includes('line one line two'));
  ok('the sheet email never carries the API key',
     !JSON.stringify(lastBody).includes('test-resend-key'));

  // The outbound cap: a compromised admin session must not be able to turn
  // the firm's verified domain into a spam source.
  const s2 = await call(env, '/sheets/personal/email', { method: 'POST', cookie: admin, body: { to: 'client@example.test' } });
  const s3 = await call(env, '/sheets/insurance/email', { method: 'POST', cookie: admin, body: { to: 'adjuster@example.test' } });
  const s4 = await call(env, '/sheets/personal/email', { method: 'POST', cookie: admin, body: { to: 'client@example.test' } });
  ok('sends inside the cap go through', s2.status === 200 && s3.status === 200);
  ok('the send beyond the cap is a 429', s4.status === 429);
  ok('the refused send never reached the provider', providerCalls === 3);

  globalThis.fetch = realFetch;
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
