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
  ok('a private invoice carries the retainer block',
     priv.retainer && priv.retainer.amount === 1500 && priv.retainer.applied === 1500
     && priv.retainer.balance === 0);
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
     (await up(admin, mk('big.mp4', 2500, 'video/mp4'))).status === 413);

  const first = await jsonOf(await up(dana, mk('clip1.mp4', 1800, 'video/mp4'),
    { classification: 'client_deliverable', note: 'Subject at the gym.' }));
  ok('the assigned investigator uploads field product', typeof first.id === 'number');
  ok('and the meter answers immediately', first.usage.bytes_used === 1800
     && first.usage.percent_of_free === 18);

  let ws = await jsonOf(await call(env, '/cases/API-EV1/workspace', { cookie: dana }));
  /* Owner's decision, 2026-08-14: an upload is ready for the report the moment
     it exists — the firm shoots its own footage and writes its own reports, so
     nothing waits behind a review it would only give itself. */
  ok('a field upload is client-deliverable straight away',
     ws.evidence[0].classification === 'client_deliverable' && ws.evidence[0].note === 'Subject at the gym.');

  await up(admin, mk('clip2.mp4', 1800, 'video/mp4'), { classification: 'internal_only' });
  ok('an admin classifies at upload',
     (await jsonOf(await call(env, '/cases/API-EV1/workspace', { cookie: admin })))
       .evidence.find(e => e.filename === 'clip2.mp4').classification === 'internal_only');

  /* THE FAILSAFE. 3,600 of the 5,000-byte cap is used; another 1,800 would
     cross it, so nothing uploads — and nothing can ever bill. */
  const blocked = await up(admin, mk('clip3.mp4', 1800, 'video/mp4'));
  ok('the free-plan failsafe refuses the upload that would cross the cap', blocked.status === 507);
  ok('and says so in plain words', (await jsonOf(blocked)).code === 'storage_cap');

  // Serving: the bytes come back through the Worker's own session checks.
  const got = await call(env, `/cases/API-EV1/evidence/${first.id}/file`, { cookie: dana });
  ok('the assigned investigator streams their footage back', got.status === 200
     && got.headers.get('content-type') === 'video/mp4'
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
  ok('an admin delete frees the space', del.usage.bytes_used === 1800);
  ok('the object is truly gone from the bucket', env.EVIDENCE._store.size === 1);
  ok('but the record of it stays, stamped',
     (await env.DB.prepare('SELECT deleted_at, deleted_by FROM case_evidence WHERE id = ?')
       .bind(first.id).first()).deleted_at != null);
  ok('a deleted object no longer serves',
     (await call(env, `/cases/API-EV1/evidence/${first.id}/file`, { cookie: admin })).status === 404);
  ws = await jsonOf(await call(env, '/cases/API-EV1/workspace', { cookie: dana }));
  ok('the field sees only what exists', ws.evidence.length === 1);
  ok('the office also sees the removal record',
     (await jsonOf(await call(env, '/cases/API-EV1/workspace', { cookie: admin }))).evidence.length === 2);

  ok('freed space uploads again', (await up(admin, mk('clip3.mp4', 1800, 'video/mp4'))).status === 201);

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
  const clip = await jsonOf(await up(admin, mk('moment.mp4', 400, 'video/mp4'), { entry_id: String(entry.id) }));
  ok('a clip attaches to the moment', typeof clip.id === 'number');
  const evList = (await jsonOf(await call(env, '/cases/API-EV1/workspace', { cookie: dana }))).evidence;
  ok('the links come back with the workspace',
     evList.find(e => e.filename === 'subj.jpg').subject_id === subj.id
     && evList.find(e => e.filename === 'moment.mp4').entry_id === entry.id);
  ok("another case's subject is refused, not silently dropped",
     (await up(admin, mk('x.jpg', 100, 'image/jpeg'), { subject_id: '999999' })).status === 400);

  const st = await jsonOf(await call(env, '/storage', { cookie: admin }));
  ok('the storage meter is admin-only',
     (await call(env, '/storage', { cookie: dana })).status === 403
     && st.storage.bytes_used === 4400);
  ok('the public health check carries only the bare percentage',
     (await jsonOf(await call(env, '/health'))).storage_pct === 44);

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

  // Without the binding, uploads say exactly what is missing.
  const bare = freshEnv();
  await bootstrapAdmin(bare);
  const a2 = (await login(bare, 'trever', 'FirstAdminPass1')).cookie;
  await ingest(bare, { case_no: 'API-EV2', service: 'Surveillance', client_name: 'C', subject_name: 'S' });
  const fd2 = new FormData(); fd2.append('file', mk('x.jpg', 10, 'image/jpeg'));
  ok('a missing binding is a named condition, not a mystery',
     (await worker.fetch(new Request(API + '/cases/API-EV2/evidence', {
       method: 'POST', headers: { Origin: ORIGIN, Cookie: a2 }, body: fd2 }), bare)).status === 503);
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

  // The raw material: a worked day, an approved report, classified evidence.
  await call(env, '/cases/API-CB1/day/start', { method: 'POST', cookie: admin,
    body: { day_date: '2026-08-13', start_time: '07:00' } });
  await call(env, '/cases/API-CB1/activity', { method: 'POST', cookie: admin,
    body: { at_date: '2026-08-13', at_time: '08:21', kind: 'activity',
            description: 'Subject arrived at ABC Fitness.' } });
  await call(env, '/cases/API-CB1/day/end', { method: 'POST', cookie: admin, body: { end_time: '15:00' } });
  const dayId = (await jsonOf(await call(env, '/cases/API-CB1/workspace', { cookie: admin }))).days[0].id;
  const rep = await jsonOf(await call(env, '/cases/API-CB1/reports/generate', { method: 'POST', cookie: admin,
    body: { day_id: dayId } }));
  await call(env, `/cases/API-CB1/reports/${rep.id}/status`, { method: 'POST', cookie: admin, body: { status: 'submitted' } });

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
  const clip = (await jsonOf(await up(mk('clip.mp4', 900, 'video/mp4'), { classification: 'client_deliverable' }))).id;
  const doc = (await jsonOf(await up(mk('summary.pdf', 200, 'application/pdf'), { classification: 'client_deliverable' }))).id;

  // No approved report yet: the build opens, and the gate says exactly that.
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

  await ingest(env, { case_no: 'API-MD1', kind: 'claims', service: 'Insurance claim assignment',
                      carrier: 'Acme Mutual', claim_number: 'CLM-77', client_name: 'An Adjuster',
                      subject_name: 'Dale Rivers', claim_type: 'Workers compensation',
                      date_of_loss: '2026-03-04',
                      objective: 'Establish activity level against the stated restrictions.' });

  // Three worked days, each with its own approved report.
  const repIds = [];
  for (const [d, s, e] of [['2026-08-10', '07:00', '15:00'],
                           ['2026-08-11', '06:30', '14:30'],
                           ['2026-08-12', '08:00', '16:00']]) {
    await call(env, '/cases/API-MD1/day/start', { method: 'POST', cookie: admin,
      body: { day_date: d, start_time: s } });
    await call(env, '/cases/API-MD1/activity', { method: 'POST', cookie: admin,
      body: { at_date: d, at_time: '09:00', kind: 'activity', description: `Observation on ${d}.` } });
    await call(env, '/cases/API-MD1/day/end', { method: 'POST', cookie: admin, body: { end_time: e } });
  }
  /* The workspace hands days back newest-first, which is right for a screen
     and wrong for building Day 1 / Day 2 / Day 3 — so sort here and let
     repIds[n] mean the nth day of the investigation. */
  const days = (await jsonOf(await call(env, '/cases/API-MD1/workspace', { cookie: admin }))).days
    .slice().sort((a, b) => a.day_date < b.day_date ? -1 : 1);
  ok('three days are on the case', days.length === 3);
  for (const day of days) {
    const r = await jsonOf(await call(env, '/cases/API-MD1/reports/generate', { method: 'POST',
      cookie: admin, body: { day_id: day.id } }));
    repIds.push(r.id);
    await call(env, `/cases/API-MD1/reports/${r.id}/status`, { method: 'POST', cookie: admin,
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
     st.events.some(e => e.action === 'created' && /2 approved reports/.test(e.detail || '')));

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
  const clip = (await jsonOf(await up('clip.mp4', 'video/mp4', 'client_deliverable'))).id;
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
  const vd = await upl('subject-0812.mp4', 'video/mp4');
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

  // 7. Case Build: report + selected photos + the video, finalized. Dropbox
  // stays honestly unconfigured and blocks nothing.
  let st = await jsonOf(await call(env, '/cases/API-E38/build', { method: 'POST', cookie: admin }));
  await call(env, `/build/${st.build.id}/items`, { method: 'POST', cookie: admin,
    body: { evidence_id: ph.id } });
  await call(env, `/build/${st.build.id}/items`, { method: 'POST', cookie: admin,
    body: { evidence_id: vd.id } });
  await call(env, `/build/${st.build.id}/package`, { method: 'POST', cookie: admin,
    body: { package_type: 'report_photos_video' } });
  ok('E2E-38: Dropbox reports not configured rather than pretending',
     (await jsonOf(await call(env, '/external-storage', { cookie: admin })))
       .providers.dropbox.configured === false);
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
     && made.invoice.retainer.applied === 1500 && made.invoice.retainer.balance === 0);
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
  globalThis.fetch = realFetch;
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
