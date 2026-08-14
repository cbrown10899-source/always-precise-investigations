/**
 * Case portal API for Always Precise Investigations.
 *
 * Deliberately a separate Worker from api-visitor-alerts. This one holds
 * claimant names, alleged injuries, claim numbers and signatures; the visitor
 * beacon holds anonymous counters. Keeping them apart means a bug in one
 * cannot reach the data of the other, and they carry different secrets.
 *
 * Design notes
 *   - Passwords are PBKDF2-SHA256 with a per-user salt. The iteration count is
 *     stored per user so it can be raised later without invalidating anyone.
 *   - Sessions are server-side. The cookie carries a random token; the database
 *     stores only its SHA-256, so a database copy yields no usable cookie.
 *   - Login failures are counted in the database, not memory, because a Worker
 *     isolate is recycled freely and an in-memory counter would reset with it.
 *   - Login answers identically for an unknown user and a wrong password, so
 *     the endpoint cannot be used to enumerate staff accounts.
 *   - There is no way to create an account except by redeeming an invitation,
 *     and only an admin can issue one. The invitee sets their own password, so
 *     no admin ever knows another person's password.
 *   - /ingest is a public write path by nature: the intake form is public, so
 *     anyone can read its key from the page source. The key stops casual noise;
 *     the size cap, the case-number format check and the per-minute rate limit
 *     are what actually protect the table.
 *
 * This Worker must be served from the SAME SITE as the page, on a route such as
 * alwayspreciseinvestigations.net/portal-api/*. A session cookie set by a
 * workers.dev hostname would be cross-site and simply never sent back — Safari
 * blocks third-party cookies outright, and SameSite=Strict does the same
 * everywhere else. Same-origin also means no CORS and no preflights.
 *
 * Bindings
 *   DB               D1 database (see schema.sql)
 * Vars
 *   SITE_ORIGIN      the site's own origin, e.g. https://alwayspreciseinvestigations.net
 *   PBKDF2_ITER      optional override for the iteration count on new passwords
 *   INVITE_FROM      From: address for invitation emails, on a verified domain
 * Secrets
 *   INGEST_KEY       shared key the intake form sends with a submission
 *   BOOTSTRAP_TOKEN  one-time token that creates the first admin account
 *   RESEND_API_KEY   optional. Set it and invitations are emailed; leave it
 *                    unset and the admin sends the link by hand, as before.
 */

const SESSION_HOURS = 12;
const SESSION_COOKIE = 'api_portal';
const DEFAULT_ITER = 100_000;   // PBKDF2-SHA256 rounds for new passwords
const MAX_FAILS = 8;            // failed logins before lockout
const LOCK_MINUTES = 15;
const MAX_PAYLOAD_BYTES = 512 * 1024;   // an intake with a signature is ~50KB
const LIST_LIMIT_MAX = 200;
const INVITE_DAYS = 7;
const INGEST_PER_MINUTE = 60;           // far above real traffic, far below a flood
const API_PREFIX = '/portal-api';
// Case numbers come from a public form, so they are treated as untrusted input
// and pinned to the shape the intake actually generates: API-YYYYMMDD-NNNN.
const CASE_NO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;

/* ------------------------------------------------------------------ helpers */

const enc = new TextEncoder();
const nowIso = () => new Date().toISOString();

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(str) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(str)));
}

/** Compare two secrets without leaking length or position through timing. */
async function secretEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

function randomHex(bytes = 32) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function pbkdf2(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return hex(bits);
}

function iterCount(env) {
  const n = parseInt(env.PBKDF2_ITER || '', 10);
  return Number.isFinite(n) && n >= 10_000 ? n : DEFAULT_ITER;
}

/* ------------------------------------------------------- origin guard */

/**
 * Defence in depth behind SameSite=Strict. A browser will not attach the
 * session cookie to a cross-site request anyway, but rejecting a mismatched
 * Origin outright means a state-changing call can never be driven from another
 * page. Tools like curl send no Origin at all and are judged on their token.
 */
function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  return Boolean(env.SITE_ORIGIN) && origin === env.SITE_ORIGIN;
}

/* ---------------------------------------------------------------- sessions */

function cookieValue(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

function sessionCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

async function createSession(env, userId) {
  const token = randomHex(32);
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, nowIso(), expires).run();
  return token;
}

/** Resolve the caller from their cookie, or null. Expired rows are swept. */
async function currentUser(request, env) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.role, u.active, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`).bind(await sha256Hex(token)).first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now() || !row.active) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
      .bind(await sha256Hex(token)).run();
    return null;
  }
  return { id: row.id, username: row.username, display_name: row.display_name, role: row.role };
}

/* ------------------------------------------------------------- login flow */

async function lockState(env, username) {
  const row = await env.DB.prepare(
    'SELECT fails, locked_until FROM login_fails WHERE username = ?').bind(username).first();
  if (!row) return { fails: 0, locked: false };
  const locked = Boolean(row.locked_until) && new Date(row.locked_until).getTime() > Date.now();
  return { fails: row.fails, locked, until: row.locked_until };
}

async function noteFailure(env, username) {
  const { fails } = await lockState(env, username);
  const next = fails + 1;
  const until = next >= MAX_FAILS
    ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString()
    : null;
  await env.DB.prepare(
    `INSERT INTO login_fails (username, fails, locked_until) VALUES (?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until`)
    .bind(username, next, until).run();
}

async function clearFailures(env, username) {
  await env.DB.prepare('DELETE FROM login_fails WHERE username = ?').bind(username).run();
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!username || !password) return json({ error: 'Username and password are required.' }, 400);

  const { locked } = await lockState(env, username);
  if (locked) {
    return json({ error: `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.` }, 429);
  }

  const user = await env.DB.prepare(
    'SELECT id, username, display_name, pass_hash, pass_salt, iterations, role, active FROM users WHERE username = ?')
    .bind(username).first();

  // Hash even when the user does not exist, so a missing account and a wrong
  // password take the same time and return the same message.
  const salt = user ? user.pass_salt : randomHex(16);
  const iterations = user ? user.iterations : iterCount(env);
  const candidate = await pbkdf2(password, salt, iterations);
  const ok = Boolean(user) && user.active === 1 && await secretEqual(candidate, user.pass_hash);

  if (!ok) {
    await noteFailure(env, username);
    return json({ error: 'That username and password do not match.' }, 401);
  }

  await clearFailures(env, username);
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(nowIso(), user.id).run();
  const token = await createSession(env, user.id);
  return json(
    { user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role } },
    200,
    { 'Set-Cookie': sessionCookie(token, SESSION_HOURS * 3600) });
}

async function handleLogout(request, env) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
      .bind(await sha256Hex(token)).run();
  }
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

/* ----------------------------------------------------------------- ingest */

function pick(o, ...keys) {
  for (const k of keys) if (o[k]) return String(o[k]).slice(0, 300);
  return null;
}

/**
 * One row per minute. Returns false once the minute is full. Losing a minute of
 * portal writes costs nothing: the intake delivers by email independently, so a
 * flood can never stop a real client from reaching the firm.
 */
/* Per-minute counters in the ingest_rate table. `kind` picks the bucket:
   ingest (the default, keyed by the bare minute — existing rows keep working)
   or 'mail', keyed with a prefix so outbound email has its own cap. The mail
   cap exists so a compromised admin session cannot turn the firm's own
   verified domain into a spam source in the minutes before anyone notices. */
async function withinRateLimit(env, kind) {
  const mail = kind === 'mail';
  const cap = mail
    ? (parseInt(env.MAIL_PER_MINUTE || '', 10) || 20)
    : (parseInt(env.INGEST_PER_MINUTE || '', 10) || INGEST_PER_MINUTE);
  const minute = nowIso().slice(0, 16);   // YYYY-MM-DDTHH:MM
  const key = mail ? 'mail:' + minute : minute;
  await env.DB.prepare(
    `INSERT INTO ingest_rate (minute, n) VALUES (?, 1)
       ON CONFLICT(minute) DO UPDATE SET n = n + 1`).bind(key).run();
  const row = await env.DB.prepare('SELECT n FROM ingest_rate WHERE minute = ?').bind(key).first();
  // Keep the table from growing without bound — both key shapes.
  const cutoff = new Date(Date.now() - 3600_000).toISOString().slice(0, 16);
  await env.DB.prepare(
    `DELETE FROM ingest_rate
      WHERE (minute NOT LIKE 'mail:%' AND minute < ?1)
         OR (minute LIKE 'mail:%' AND minute < 'mail:' || ?1)`).bind(cutoff).run();
  return !row || row.n <= cap;
}

async function handleIngest(request, env) {
  const supplied = request.headers.get('X-Ingest-Key') || '';
  if (!env.INGEST_KEY || !(await secretEqual(supplied, env.INGEST_KEY))) {
    return json({ error: 'not authorised' }, 401);
  }
  // Refuse on the declared length before reading the body into memory.
  const declared = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (Number.isFinite(declared) && declared > MAX_PAYLOAD_BYTES) {
    return json({ error: 'payload too large' }, 413);
  }
  const raw = await request.text();
  if (raw.length > MAX_PAYLOAD_BYTES) return json({ error: 'payload too large' }, 413);

  if (!(await withinRateLimit(env))) return json({ error: 'too many submissions' }, 429);

  let p;
  try { p = JSON.parse(raw); } catch { return json({ error: 'invalid json' }, 400); }
  const caseNo = String(p.case_no || '').trim();
  if (!caseNo) return json({ error: 'case_no is required' }, 400);
  // A case number reaches the admin's browser, so its shape is checked here
  // rather than trusted. Anything outside this alphabet is rejected outright.
  if (!CASE_NO_RE.test(caseNo)) return json({ error: 'case_no has an unexpected format' }, 400);

  const kind = p.claim_number || p.carrier ? 'claims' : 'consumer';
  try {
    await env.DB.prepare(
      `INSERT INTO submissions
         (case_no, kind, service, client_name, client_email, client_phone,
          subject_name, carrier, claim_number, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(caseNo, kind, pick(p, 'service'),
        pick(p, 'client_name'), pick(p, 'client_email'), pick(p, 'client_phone'),
        pick(p, 'subject_name'), pick(p, 'carrier'), pick(p, 'claim_number'),
        raw, nowIso()).run();
  } catch (e) {
    // A retry from the browser must not surface as an error to the client.
    if (String(e).includes('UNIQUE')) return json({ ok: true, duplicate: true });
    throw e;
  }
  return json({ ok: true, case_no: caseNo });
}

/* ---------------------------------------------------------------- pricing */

/* THE ONE INTERNAL RATE CONFIGURATION. The reasoning behind these numbers is in
   PRICING.md next to this file; both live in case-portal/ because that
   directory is excluded from the Pages deploy.

   These are CARRIER rates and they are internal. They are not published on the
   site, not sent to the intake form, and `/pricing` below is admin-only. A
   negotiated rate is a preferred-volume rate, never advertised.

   Do not copy a number out of here into a page or a second config. One place is
   the whole point: a rate rise must not leave a stale figure behind.

   Consumer pricing is separate and deliberately public — PACKAGES in
   intake/index.html. Do not merge the two. */
const RATES = {
  currency: 'USD',
  surveillance: {
    standard: 150,           // rack rate per investigator hour
    volumeMin: 135,          // preferred-volume band, offered on merit
    volumeMax: 150,
    floor: 125,              // do not go below without guaranteed volume
    minHoursPerDay: 8,
    typicalAuthHours: 24,    // 3 days — the usual initial authorization
  },

  /* The flat-fee carrier ladder. Hours match AUTH_PRESETS below, so whatever a
     carrier authorizes on the intake form maps straight onto a price here.
     Quoted per assignment and confirmed in writing — never published.

     Priced deliberately: the one-day block is rack rate, and the discount
     widens with the commitment without ever crossing the floor. A draft at
     1000/1800/2600 worked out to 125/112.50/108.33 an hour, which put two of
     the three below the floor and left about $1,000 a case on the table against
     the standard rate. There is a test that fails if any block here drops under
     RATES.surveillance.floor, so that cannot happen again by accident. */
  /* `client` is what the rate sheet prints. It is CLIENT-FACING COPY ONLY —
     the discount arithmetic above must never appear in it (RATESHEETS.md:
     no "below standard", no volume band, no rack-rate comparison). */
  packages: [
    { hours: 8,  price: 1200, label: 'One day',
      client: '8 hours of authorized surveillance.' },
    { hours: 16, price: 2300, label: 'Two days',
      client: '16 hours of authorized surveillance at a reduced multi-day package rate.' },
    { hours: 24, price: 3300, label: 'Three days', recommended: true,
      client: '24 hours of authorized surveillance and the preferred starting authorization '
            + 'for most multi-day surveillance assignments.' },
  ],
  services: {
    // [low, high] per hour. A single number means one rate, not a range.
    surveillance_wc:      [150, 150],
    surveillance_liab:    [150, 150],
    surveillance_disab:   [150, 150],
    siu_fraud:            [150, 175],
    recorded_statement:   [125, 150],
    field_canvass:        [125, 150],
    scene_liability:      [125, 150],
    background_social:    [100, 150],
    asset_business:       [150, 200],
    skip_trace:           [125, 150],
    testimony:            [200, 250],
  },
  multipliers: { rush: 1.25, holiday: 1.5 },
  /* NO ADDITIONAL FEES. The quoted price is the invoiced price, on both the
     carrier and the private-client side. Mileage, travel time, tolls, parking,
     database and record fees, report writing and the footage are all inside the
     block. Nothing is added afterwards.

     This is a commitment made to clients in the signed terms, not an internal
     default — do not reintroduce line-item expense billing without changing the
     terms in intake/index.html at the same time.

     The ladder was checked against it: absorbing roughly 60 miles a day at
     $0.70 leaves the three-day block at about $132/hr, still above the $125
     floor. That is why absorbing travel is affordable at these prices and was
     not at the $2,600 draft, which would have landed near $103.

     The one carve-out is the one already published on the vendor page: an
     assignment outside the defined service area has its travel quoted honestly
     before the assignment is accepted, rather than absorbed silently. Quoted up
     front and agreed is not an additional fee — a line item appearing on an
     invoice afterwards is, and that is what never happens. */
  expenses: {
    billedSeparately: false,
    includedInBlock: ['Mileage', 'Travel time', 'Tolls', 'Parking',
                      'Database fees', 'Record fees', 'Report writing',
                      'Video review', 'Footage and evidence delivery'],
    outsideServiceArea: 'Quoted before the assignment is accepted, never added afterwards.',
    mileagePerMile: 0.70,   // for internal costing only — never invoiced
  },
  // Reporting is investigator time. Never promise it free.
  billableAsInvestigatorTime: ['Field investigation', 'Surveillance',
    'Video review', 'Chronology preparation', 'Report writing',
    'Evidence organization', 'Case-file preparation', 'Evidence delivery'],
};

/* Authorization presets offered on the carrier intake. HOURS ONLY — the form is
   a public page, so it must not carry a rate. The estimate below is computed
   here, for admins, never sent to the form. */
const AUTH_PRESETS = [8, 16, 24];

/* ------------------------------------------------------------- rate sheets */

/* The two documents the office sends a client — TWO SEPARATE PRODUCTS
   (RATESHEETS.md). The carrier sheet is package/authorization-based; the
   private sheet is retainer+hourly. They share the card UI and nothing else:
   separate config, separate copy, separate logic, so editing one cannot touch
   the other. Neither ever shows internal strategy — no rack rate, no volume
   band, no discount arithmetic, no floor. Those live in RATES and PRICING.md.

   They live here, not on the public site, because no quote or price is shown
   to anyone who has not asked for one — and neither client ever sees the
   other's numbers.

   `id` is what the email endpoint takes, so keep an id stable once it has been
   sent to anyone. Prices come from RATES and PERSONAL — nothing here restates
   a figure that is set elsewhere. */
const PERSONAL = { retainer: 1500, hourly: 100, minHours: 4 };

function rateSheets() {
  const money = n => '$' + Number(n).toLocaleString('en-US');
  return [
    {
      id: 'private_retainer',
      type: 'retainer',
      name: `${money(PERSONAL.retainer)} Retainer`,
      selector_label: `Private Client — ${money(PERSONAL.retainer)} Retainer`,
      audience: 'Private surveillance, domestic and family investigations',
      summary: `A ${money(PERSONAL.retainer)} retainer is required to begin. The retainer is `
             + `applied directly to authorized investigative services billed at `
             + `${money(PERSONAL.hourly)} per hour.`,
      lines: [
        { label: 'Retainer to begin', value: money(PERSONAL.retainer), big: true,
          sub: 'Applied to the work — not an extra fee',
          note: 'Applied in full toward authorized investigative services. It is not a '
              + 'separate fee — your retainer funds the work performed on your case.' },
        { label: 'Investigative rate', value: `${money(PERSONAL.hourly)}/hr`, big: true,
          sub: `${PERSONAL.minHours}-hour minimum`,
          note: `${PERSONAL.minHours}-hour minimum engagement. Investigative time is deducted `
              + `from the retainer at the same ${money(PERSONAL.hourly)}-per-hour rate. Field `
              + 'investigation, necessary video review, case documentation and report '
              + 'preparation are handled at this rate and applied against your authorized '
              + 'retainer.' },
        { label: 'If additional time is needed', value: `${money(PERSONAL.hourly)}/hr`, big: true,
          sub: 'Only with your approval',
          note: 'We contact you before exceeding the authorized retainer. Additional '
              + 'investigative time is never incurred without your approval — you remain in '
              + 'control of any additional authorization.' },
        { label: 'Straightforward billing', value: 'No routine add-on fees',
          note: 'Standard local operating costs are included. There are no routine mileage, '
              + 'toll, parking, report or case-delivery surcharges within our normal service '
              + 'area.' },
        { label: 'Outside our normal service area', value: 'Quoted in advance',
          note: 'Significant travel outside our normal service area is discussed and approved '
              + 'before the work is scheduled.' },
      ],
      closing_title: 'Your case. Your authorization. No surprise billing.',
      closing: 'Work begins once the retainer and required authorization are received. '
             + 'Investigative activity is documented and appropriate case deliverables may '
             + 'include a written report, photographs and video. An investigator may provide '
             + 'testimony regarding their own observations when appropriate and separately '
             + 'arranged.',
    },
    {
      id: 'insurance_assignment',
      type: 'package',
      name: 'Insurance Assignment Rates',
      selector_label: 'Insurance Assignment Rates',
      audience: 'For carriers, TPAs, self-insured employers, SIU departments and defense counsel',
      summary: `Surveillance is authorized in blocks of investigative time. An `
             + `${RATES.surveillance.minHoursPerDay}-hour day is the minimum surveillance `
             + `assignment, and ${RATES.surveillance.typicalAuthHours} hours is the typical `
             + `initial authorization.`,
      lines: [
        ...RATES.packages.map(p => ({
          label: p.label, sub: `${p.hours} hours`, value: money(p.price), big: true,
          badge: p.recommended ? 'Recommended initial authorization' : '',
          note: p.client,
        })),
        { label: 'Additional authorized hours', value: `${money(RATES.surveillance.standard)}/hr`,
          big: true, sub: 'With prior authorization',
          note: 'Additional investigative time is only incurred with prior authorization from '
              + 'the assigning client.' },
        { label: 'Included in the flat rate', value: 'No routine add-on fees',
          note: 'Standard local travel, routine case expenses, investigative reporting, video '
              + 'review, photographs and delivery of case materials are included in the '
              + 'authorized package price.' },
        { label: 'Outside our normal service area', value: 'Quoted in advance',
          note: 'Assignments requiring significant travel outside our normal service area are '
              + 'quoted and approved before the assignment is accepted. No unapproved travel '
              + 'charge is added afterward.' },
      ],
      closing_title: 'Clear pricing. No surprise billing.',
      closing: 'Rates and authorization are confirmed in writing before investigative work '
             + 'begins. Submission of an assignment does not by itself constitute acceptance. '
             + 'Surveillance deliverables generally include an investigative activity report '
             + 'supported by available time-stamped photographs and video.',
    },
  ];
}

function sheetById(id) { return rateSheets().find(s => s.id === id) || null; }

/* MASTER §5 — Send Intake from a lead. The email carries the intake link and
   nothing priced. Which door is NEVER the caller's choice: the lead's own
   kind picks it server-side, the same rule SHEET_INTAKE enforces — a carrier
   lead can only ever be sent the carrier door. */
async function sendLeadIntake(request, env, user, caseNo) {
  const lead = await env.DB.prepare(
    'SELECT case_no, kind, client_name FROM submissions WHERE case_no = ?').bind(caseNo).first();
  if (!lead) return json({ error: 'not found' }, 404);

  const body = await readJson(request);
  const to = String(body.to || '').trim();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(to) || to.length > 200) {
    return json({ error: 'Enter a valid email address.' }, 400);
  }
  if (!(await withinRateLimit(env, 'mail'))) {
    return json({ error: 'Too many emails in one minute — wait a moment and send again.' }, 429);
  }

  const intake = SHEET_INTAKE[lead.kind === 'claims' ? 'insurance_assignment' : 'private_retainer'];
  const greet = lead.client_name ? `${String(lead.client_name).slice(0, 80)},` : 'Hello,';
  const text =
`${greet}

Here is the secure ${intake.label} for Always Precise Investigations. It takes a few minutes, and anything you do not have on hand can be marked "I don't have this information right now" and sent along later:

${intake.url}

Questions any time: (434) 907-0975.

Always Precise Investigations, LLC — Va DCJS #11-9159`;
  const html =
`<div style="font-family:'Segoe UI',Arial,sans-serif;color:#1c2531;line-height:1.55;max-width:560px">
  <p>${escHtml(greet)}</p>
  <p>Here is the secure ${escHtml(intake.label)} for Always Precise Investigations. It takes a few
     minutes, and anything you do not have on hand can be marked
     &ldquo;I don&rsquo;t have this information right now&rdquo; and sent along later.</p>
  <p><a href="${escHtml(intake.url)}" style="display:inline-block;background:#12305a;color:#fff;
     padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">
     Start the ${escHtml(intake.label)}</a></p>
  <p style="font-size:.9rem;color:#5c6775">Questions any time: (434) 907-0975.</p>
  <p style="font-size:.85rem;color:#5c6775">Always Precise Investigations, LLC &middot; Va DCJS #11-9159</p>
</div>`;

  const mail = await sendMail(env, {
    to, subject: `${intake.label} — Always Precise Investigations`, text, html });
  if (!mail.sent) {
    await logSend(env, user, { case_no: caseNo, kind: 'intake', door: intake.url,
      recipient: to, ok: 0, detail: mail.reason || 'send failed' });
    return json({
      error: mail.reason === 'not_configured'
        ? 'Email is not configured on the Worker. Add RESEND_API_KEY to send from here.'
        : 'That did not send. Check the address and try again.',
      reason: mail.reason,
    }, 502);
  }
  await logSend(env, user, { case_no: caseNo, kind: 'intake', door: intake.url,
    recipient: to, ok: 1 });
  await stampLead(env, user, caseNo, 'intake_sent');
  return json({ ok: true, sent_to: to, intake: intake.label,
                lead_status: (await env.DB.prepare(
                  'SELECT status FROM lead_status WHERE case_no = ?').bind(caseNo).first() || {}).status });
}

async function emailSheet(request, env, user, id) {
  const sheet = sheetById(id);
  if (!sheet) return json({ error: 'no such rate sheet' }, 404);

  const body = await readJson(request);
  const to = String(body.to || '').trim();
  // Deliberately loose — a real address check is a delivery attempt, and this
  // only needs to catch a typo before one is spent.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(to) || to.length > 200) {
    return json({ error: 'Enter a valid email address.' }, 400);
  }
  // The note reaches the email body (escaped there); the case number reaches
  // the SUBJECT line. Neither may carry control characters — a CR/LF smuggled
  // into a header field is how one email becomes several. Defense in depth:
  // the callers are admins, but a header injection should be impossible, not
  // merely unlikely.
  const note = String(body.note || '')
    .replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 500);
  const caseNo = String(body.case_no || '').replace(/[^\x20-\x7e]/g, '').slice(0, 64);

  /* A sheet sent AGAINST a lead must match that lead (audit, 2026-08-14).
     The intake door has always been paired to the sheet server-side, but
     nothing checked the sheet was the right one for the case — so the private
     sheet could be emailed against a claims lead, putting consumer pricing
     AND the consumer picker in front of an adjuster. The page picks correctly;
     the API did not care, and the API is the boundary. */
  if (caseNo) {
    const lead = await env.DB.prepare('SELECT kind FROM submissions WHERE case_no = ?')
      .bind(caseNo).first();
    if (lead) {
      const wanted = lead.kind === 'claims' ? 'insurance_assignment' : 'private_retainer';
      if (sheet.id !== wanted) {
        return json({ error: lead.kind === 'claims'
          ? `${caseNo} is a claim assignment — send it the Insurance Assignment Rates, never the consumer sheet.`
          : `${caseNo} is a private client — send it the Private Client Retainer, never the carrier sheet.`,
          expected_sheet: wanted }, 400);
      }
    }
  }

  if (!(await withinRateLimit(env, 'mail'))) {
    return json({ error: 'Too many emails in one minute — wait a moment and send again.' }, 429);
  }

  // The Options step (UIBUILD P18): include the sheet's own intake, or not.
  // Which intake is never the caller's choice — SHEET_INTAKE pairs it.
  const includeIntake = body.include_intake === true || body.include_intake === 1 || body.include_intake === '1';
  const intakeUrl = includeIntake && SHEET_INTAKE[sheet.id] ? SHEET_INTAKE[sheet.id].url : null;
  const { text, html } = sheetEmail(sheet, note, includeIntake);
  const subject = caseNo
    ? `${sheet.name} — Always Precise Investigations (case ${caseNo})`
    : `${sheet.name} — Always Precise Investigations`;

  const mail = await sendMail(env, { to, subject, text, html });
  if (!mail.sent) {
    await logSend(env, user, { case_no: caseNo, kind: 'rate_sheet', sheet_id: sheet.id,
      door: intakeUrl, recipient: to, ok: 0, detail: mail.reason || 'send failed' });
    return json({
      error: mail.reason === 'not_configured'
        ? 'Email is not configured on the Worker. Add RESEND_API_KEY to send from here.'
        : 'That did not send. Check the address and try again.',
      reason: mail.reason,
    }, 502);
  }
  await logSend(env, user, { case_no: caseNo, kind: 'rate_sheet', sheet_id: sheet.id,
    door: intakeUrl, recipient: to, ok: 1 });
  /* §5 — the system stamps what IT did. A sheet sent against a lead's case
     number moves the lead to Rate Sheet Sent (with the intake ticked, the
     intake went too, and Intake Sent is the further of the two). Manual
     decisions are never overridden — see LEAD_DECIDED. */
  if (caseNo) {
    const lead = await env.DB.prepare('SELECT case_no, kind FROM submissions WHERE case_no = ?')
      .bind(caseNo).first();
    if (lead) await stampLead(env, user, caseNo, includeIntake ? 'intake_sent' : 'rate_sheet_sent');
  }
  return json({ ok: true, sent_to: to, sheet: sheet.id });
}

/* Manual intake (UIBUILD P17): the office types in what a phone call or an
   email brought, and it becomes a submission like any other — same table,
   same workspace, no parallel lead store to drift. The only hard requirement
   is knowing WHO: everything else can arrive later (INTAKE-NA's principle —
   never force fake information to pass validation). */
async function createManualIntake(request, env, user) {
  const body = await readJson(request);
  const kind = body.kind === 'claims' ? 'claims' : body.kind === 'consumer' ? 'consumer' : null;
  if (!kind) return json({ error: 'Pick Insurance/Commercial or Private Client first.' }, 400);
  const who = String((kind === 'claims' ? (body.carrier || body.client_name) : body.client_name) || '').trim();
  if (!who) {
    return json({ error: kind === 'claims'
      ? 'Name the carrier or the assigning contact.' : 'Name the client.' }, 400);
  }

  const fields = ['service', 'client_name', 'client_email', 'client_phone', 'client_address',
    'carrier', 'claim_number', 'policy_number', 'claim_type', 'date_of_loss',
    'adjuster', 'adjuster_email', 'adjuster_phone', 'defense_counsel',
    'subject_name', 'subject_address', 'subject_description', 'subject_relationship',
    'objective', 'timeline', 'notes'];
  const payload = {};
  for (const f of fields) { const v = pick(body, f); if (v) payload[f] = v; }
  payload.manual_intake = true;
  payload.entered_by = user.display_name || user.username;

  // Same number shape the public form mints; UNIQUE retries pick a new one.
  for (let att = 0; att < 5; att++) {
    const caseNo = 'API-' + nowIso().slice(0, 10).replace(/-/g, '') + '-'
      + String(Math.floor(1000 + Math.random() * 9000));
    try {
      await env.DB.prepare(
        `INSERT INTO submissions
           (case_no, kind, service, client_name, client_email, client_phone,
            subject_name, carrier, claim_number, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(caseNo, kind, payload.service || null,
          payload.client_name || null, payload.client_email || null, payload.client_phone || null,
          payload.subject_name || null, payload.carrier || null, payload.claim_number || null,
          JSON.stringify(payload), nowIso()).run();
      return json({ ok: true, case_no: caseNo }, 201);
    } catch (e) {
      if (!String(e).includes('UNIQUE')) throw e;
    }
  }
  return json({ error: 'Could not allocate a case number — try again.' }, 500);
}

/* The dashboard's one job is answering "what needs my attention today?", so
   beyond the raw counts it returns the actual case numbers behind each alert —
   which is what lets a card be clicked to show exactly those cases rather than
   being a number to go hunting after.

   Scoped like everything else: an investigator's alerts are their own cases
   and their own days, never the firm's book of work. And it degrades — on a
   database missing the workspace tables it returns the basic counts it can
   compute instead of failing the whole strip. */
async function caseSummary(env, user) {
  const admin = user.role === 'admin';
  const scope = admin ? '' : 'WHERE assigned_to = ?';
  const binds = admin ? [] : [user.id];
  const { results } = await env.DB.prepare(
    `SELECT status, kind, COUNT(*) AS n FROM submissions ${scope} GROUP BY status, kind`)
    .bind(...binds).all();

  const out = { total: 0, new: 0, assigned: 0, in_progress: 0, closed: 0, claims: 0, consumer: 0 };
  for (const r of results || []) {
    const n = Number(r.n) || 0;
    out.total += n;
    if (r.status in out) out[r.status] += n;
    if (r.kind === 'claims') out.claims += n; else out.consumer += n;
  }
  out.open = out.total - out.closed;

  if (admin) {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM submissions WHERE assigned_to IS NULL AND status != 'closed'").first();
    out.unassigned = row ? Number(row.n) || 0 : 0;
  }

  const missing = await missingTables(env);
  const have = t => !missing.includes(t);
  const cap = a => a.slice(0, 100);

  // Out in the field right now: a day someone started and has not ended.
  if (have('case_days')) {
    const { results: openDays } = await env.DB.prepare(
      `SELECT DISTINCT d.case_no FROM case_days d
        ${admin ? '' : 'JOIN submissions s ON s.case_no = d.case_no AND s.assigned_to = ?'}
        WHERE d.end_time IS NULL ${admin ? '' : 'AND d.investigator_id = ?'}`)
      .bind(...(admin ? [] : [user.id, user.id])).all();
    out.active_now = cap((openDays || []).map(r => r.case_no));
  }

  // Reports owed: a finished day with no report yet, plus — for the reviewer —
  // reports sitting in submitted, and — for the writer — ones sent back.
  if (have('case_days') && have('case_reports')) {
    const { results: unreported } = await env.DB.prepare(
      `SELECT DISTINCT d.case_no FROM case_days d
        LEFT JOIN case_reports r ON r.day_id = d.id
        ${admin ? '' : 'JOIN submissions s ON s.case_no = d.case_no AND s.assigned_to = ?'}
        WHERE d.end_time IS NOT NULL AND r.id IS NULL ${admin ? '' : 'AND d.investigator_id = ?'}`)
      .bind(...(admin ? [] : [user.id, user.id])).all();
    const { results: pending } = await env.DB.prepare(admin
      ? "SELECT DISTINCT case_no FROM case_reports WHERE status = 'submitted'"
      : "SELECT DISTINCT case_no FROM case_reports WHERE status = 'needs_revision' AND investigator_id = ?")
      .bind(...(admin ? [] : [user.id])).all();
    out.reports_due = cap([...new Set([
      ...(unreported || []).map(r => r.case_no),
      ...(pending || []).map(r => r.case_no),
    ])]);
  }

  // Expenses waiting on the office's three decisions.
  if (admin && have('case_expenses')) {
    const { results: pend } = await env.DB.prepare(
      'SELECT DISTINCT case_no FROM case_expenses WHERE reviewed_at IS NULL').all();
    out.expenses_pending = cap((pend || []).map(r => r.case_no));
  }

  // Authorization running low: used hours at or past the first warning
  // threshold. The threshold is the configured one, not a constant here.
  if (have('case_meta') && have('case_days')) {
    const first = String(await configValue(env, 'auth_warn_thresholds', '75,90,100'))
      .split(',').map(parseFloat).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? 75;
    const { results: authRows } = await env.DB.prepare(
      `SELECT m.case_no, m.authorized_hours, COALESCE(SUM(d.hours), 0) AS used
         FROM case_meta m
         LEFT JOIN case_days d ON d.case_no = m.case_no
         ${admin ? '' : 'JOIN submissions s ON s.case_no = m.case_no AND s.assigned_to = ?'}
        WHERE m.authorized_hours > 0
        GROUP BY m.case_no, m.authorized_hours`)
      .bind(...(admin ? [] : [user.id])).all();
    out.auth_low = cap((authRows || [])
      .filter(r => (Number(r.used) / Number(r.authorized_hours)) * 100 >= first)
      .map(r => r.case_no));
    out.auth_warn_at = first;
  }

  // The storage meter (the free-plan failsafe's face on the dashboard).
  if (admin && have('case_evidence')) {
    out.storage = await evidenceUsage(env);
  }

  // The two stage-driven cards (priority 20): the ball in the client's court,
  // and complete cases waiting on the closing checklist.
  if (admin && have('case_status')) {
    const { results: st } = await env.DB.prepare(
      `SELECT case_no, stage FROM case_status WHERE stage IN ('awaiting_client','complete')`).all();
    out.awaiting_client = cap((st || []).filter(r => r.stage === 'awaiting_client').map(r => r.case_no));
    out.ready_to_close = cap((st || []).filter(r => r.stage === 'complete').map(r => r.case_no));
  }

  // Follow-up tasks past their date (priority 19). The office's overdue list;
  // for an investigator, only tasks assigned to them.
  if (have('case_tasks')) {
    const today = nowIso().slice(0, 10);
    const { results: late } = await env.DB.prepare(
      `SELECT DISTINCT t.case_no FROM case_tasks t
        ${admin ? '' : 'JOIN submissions s ON s.case_no = t.case_no AND s.assigned_to = ?'}
        WHERE t.status = 'open' AND t.due_date IS NOT NULL AND t.due_date < ?
        ${admin ? '' : 'AND t.assigned_to = ?'}`)
      .bind(...(admin ? [today] : [user.id, today, user.id])).all();
    out.tasks_overdue = cap((late || []).map(r => r.case_no));
  }

  return json({ summary: out });
}

/* The email. Plain text alongside the HTML so it stays readable in a client
   that blocks markup, and so an adjuster forwarding it to their approver does
   not send them a broken page. */
/* The paired intake per sheet (UIBUILD P18). Decided HERE, by sheet id — the
   page only says whether to include it, never which one, so a carrier can
   never be handed the consumer door or the reverse. */
const SHEET_INTAKE = {
  insurance_assignment: { label: 'Insurance Assignment Intake',
    url: 'https://alwayspreciseinvestigations.net/intake/?assignment=insurance' },
  private_retainer: { label: 'Private Client Intake',
    // The private door (audit 2026-08-14): the picker without the carrier
    // path. A private client emailed this link is never offered a claim
    // assignment with a private-client price beside it.
    url: 'https://alwayspreciseinvestigations.net/intake/?assignment=private' },
};

function sheetEmail(sheet, note, includeIntake) {
  const intake = includeIntake ? SHEET_INTAKE[sheet.id] : null;
  const rows = sheet.lines.map(l =>
    `  ${l.label}${l.sub ? ` (${l.sub})` : ''}: ${l.value}${l.badge ? `  ** ${l.badge} **` : ''}\n     ${l.note}`).join('\n');
  const text =
`${sheet.name}
Always Precise Investigations, LLC — Va DCJS #11-9159

${sheet.audience}
${sheet.summary}
${note ? `\n${note}\n` : ''}
${rows}

${sheet.closing_title}
${sheet.closing}
${intake ? `\nReady to begin? The ${intake.label} takes a few minutes:\n${intake.url}\n` : ''}
Questions: (434) 907-0975
Always Precise Investigations, LLC`;

  const html =
`<div style="font-family:'Segoe UI',Arial,sans-serif;color:#1c2531;line-height:1.55;max-width:560px">
  <h2 style="margin:0 0 2px;color:#12305a">${escHtml(sheet.name)}</h2>
  <p style="margin:0 0 4px;font-size:.82rem;color:#5c6775;letter-spacing:.04em;text-transform:uppercase">
    Always Precise Investigations, LLC &middot; Va DCJS #11-9159</p>
  <p style="margin:0 0 14px;font-size:.88rem;color:#5c6775">${escHtml(sheet.audience)}</p>
  <p style="margin:0 0 18px">${escHtml(sheet.summary)}</p>
  ${note ? `<p style="margin:0 0 18px;padding:12px 14px;background:#f4f8fa;border-left:3px solid #2f7d90">${escHtml(note)}</p>` : ''}
  <table style="width:100%;border-collapse:collapse;margin:0 0 18px">
    ${sheet.lines.map(l => `<tr>
      <td style="padding:12px 0;border-bottom:1px solid #e4e9ed;vertical-align:top">
        <b>${escHtml(l.label)}</b>${l.sub ? ` <span style="font-size:.8rem;color:#5c6775">&middot; ${escHtml(l.sub)}</span>` : ''}
        ${l.badge ? `<div style="display:inline-block;margin-left:6px;padding:2px 9px;border:1px solid #b7924c;color:#8a6d33;border-radius:10px;font-size:.68rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase">${escHtml(l.badge)}</div>` : ''}
        <div style="font-size:.86rem;color:#5c6775">${escHtml(l.note)}</div>
      </td>
      <td style="padding:12px 0 12px 14px;border-bottom:1px solid #e4e9ed;text-align:right;white-space:nowrap;vertical-align:top;${
        l.big ? 'font-size:1.35rem;font-weight:800;color:#12305a' : 'font-weight:700'}">${escHtml(l.value)}</td>
    </tr>`).join('')}
  </table>
  <p style="margin:0 0 4px;font-weight:800;color:#12305a">${escHtml(sheet.closing_title)}</p>
  <p style="margin:0 0 14px;font-size:.92rem">${escHtml(sheet.closing)}</p>
  ${intake ? `<p style="margin:0 0 14px">
    <a href="${escHtml(intake.url)}" style="display:inline-block;background:#12305a;color:#fff;
       padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:700">
      Start the ${escHtml(intake.label)}</a></p>` : ''}
  <hr style="border:0;border-top:1px solid #dfe3e8">
  <p style="font-size:.82rem;color:#5c6775">Questions? (434) 907-0975<br>
     Always Precise Investigations, LLC</p>
</div>`;
  return { text, html };
}

/* Each block with its effective hourly worked out, and flagged against the
   band and the floor. The flags are what stop a discount being agreed by
   feel — a block that reads as a reasonable round number can still be under
   the rate the firm decided it would not go below. */
function packageSheet() {
  const s = RATES.surveillance;
  return RATES.packages.map(p => {
    const effective = Math.round((p.price / p.hours) * 100) / 100;
    return {
      ...p, effective,
      savingVsStandard: (s.standard * p.hours) - p.price,
      belowVolumeBand: effective < s.volumeMin,
      belowFloor: effective < s.floor,
    };
  });
}

function quoteFor(hours, rate) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return null;
  // Number(null) and Number('') are both 0, and 0 is finite — so an absent rate
  // has to be rejected before the numeric check, or a missing ?rate= quotes the
  // whole assignment at nothing.
  const given = rate === null || rate === undefined || String(rate).trim() === ''
    ? NaN : Number(rate);
  const r = Number.isFinite(given) && given > 0 ? given : RATES.surveillance.standard;
  return {
    hours: h, rate: r, subtotal: h * r,
    rush: h * r * RATES.multipliers.rush,
    holiday: h * r * RATES.multipliers.holiday,
    belowFloor: r < RATES.surveillance.floor,
    belowVolumeBand: r < RATES.surveillance.volumeMin,
  };
}

/* ------------------------------------------------------------ submissions */

/* An investigator is given what the fieldwork needs and nothing that identifies
   who is paying for it. The carrier, the adjuster, the claim and policy numbers,
   the defense firm, the billing contact and the consumer client's own details
   are what a departing investigator would need to solicit the work directly, so
   they never leave this Worker for a non-admin caller.

   This is an allow-list, not a delete-list, and deliberately so: when the intake
   form gains a field, it stays admin-only until someone decides otherwise. A
   delete-list would leak every new field by default.

   Same principle as the row scope above — enforced here, not by the page hiding
   fields. A field the page merely omits is still in the browser's network tab. */
const FIELD_KEEP = [
  // who and where to watch
  'subject_name', 'subject_address', 'subject_description', 'subject_relationship',
  // what the assignment actually asks for
  'objective', 'authorized_hours', 'timeline', 'notes', 'attachments',
  // case shape — none of these name the client
  'claim_type', 'date_of_loss', 'prior_surveillance',
  // the limits the fieldwork has to stay inside. An investigator cannot work to
  // an authorization they cannot see. `not_to_exceed` is deliberately NOT here:
  // it is a budget, and a budget is commercial.
  'start_date', 'permitted_days', 'permitted_times', 'weekend_authorized',
  'priority', 'geographic_limits',
  // INTAKE-NA: the availability of a field the investigator can already see.
  // "Address not available yet" is field context; the statuses of office-side
  // fields (claim number, billing) are deliberately NOT here.
  'subject_address_status', 'subject_description_status', 'date_of_loss_status',
  'start_date_status', 'authorized_hours_status',
];

/* The denormalised columns carry the same identities as the payload does — a
   claim number is the carrier's own reference, so it names them just as
   plainly. Dropped from list rows and detail rows alike. */
function redactRow(row) {
  const { carrier, claim_number, client_name, client_email, client_phone, lead_status,
          send_count, last_sent_at, ...rest } = row;
  return rest;
}

function redactPayload(payload, extra) {
  const kept = {};
  for (const k of FIELD_KEEP) if (payload[k] !== undefined) kept[k] = payload[k];
  // Priority 10's admin toggle: revealing the client identity keeps exactly
  // who the case is for — never how to bill them or reach them.
  for (const k of extra || []) if (payload[k] !== undefined) kept[k] = payload[k];
  return kept;
}
const CLIENT_IDENTITY_FIELDS = ['carrier', 'claim_number', 'client_name'];

async function listSubmissions(request, env, user) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, LIST_LIMIT_MAX);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

  // An investigator sees only what is assigned to them. This is enforced here,
  // in the query, rather than by the page hiding rows.
  const scope = user.role === 'admin' ? '' : 'WHERE s.assigned_to = ?';
  const binds = user.role === 'admin' ? [limit, offset] : [user.id, limit, offset];

  const { results } = await env.DB.prepare(
    `SELECT s.case_no, s.kind, s.service, s.status, s.client_name, s.client_email, s.subject_name,
            (SELECT COUNT(*) FROM send_log sl WHERE sl.case_no = s.case_no AND sl.ok = 1) AS send_count,
            (SELECT MAX(sent_at) FROM send_log sl WHERE sl.case_no = s.case_no AND sl.ok = 1) AS last_sent_at,
            s.carrier, s.claim_number, s.created_at, s.assigned_to, u.display_name AS assigned_name,
            cs.stage, ls.status AS lead_status
       FROM submissions s LEFT JOIN users u ON u.id = s.assigned_to
       LEFT JOIN case_status cs ON cs.case_no = s.case_no
       LEFT JOIN lead_status ls ON ls.case_no = s.case_no
       ${scope}
      ORDER BY s.created_at DESC LIMIT ? OFFSET ?`).bind(...binds).all();

  const countRow = await (user.role === 'admin'
    ? env.DB.prepare('SELECT COUNT(*) AS n FROM submissions').first()
    : env.DB.prepare('SELECT COUNT(*) AS n FROM submissions WHERE assigned_to = ?').bind(user.id).first());

  const rows = results || [];
  return json({
    submissions: user.role === 'admin' ? rows : rows.map(redactRow),
    total: countRow ? countRow.n : 0, limit, offset,
  });
}

async function getSubmission(env, user, caseNo) {
  const row = await env.DB.prepare(
    `SELECT s.*, u.display_name AS assigned_name
       FROM submissions s LEFT JOIN users u ON u.id = s.assigned_to
      WHERE s.case_no = ?`).bind(caseNo).first();
  if (!row) return json({ error: 'not found' }, 404);
  if (user.role !== 'admin' && row.assigned_to !== user.id) return json({ error: 'not found' }, 404);
  let payload = {};
  try { payload = JSON.parse(row.payload); } catch { /* keep the row usable */ }
  if (user.role !== 'admin') {
    const st = await caseSettings(env, caseNo);
    const reveal = st.show_client_identity ? CLIENT_IDENTITY_FIELDS : [];
    const base = redactRow(row);
    if (st.show_client_identity) {
      base.carrier = row.carrier; base.claim_number = row.claim_number; base.client_name = row.client_name;
    }
    return json({ submission: { ...base, payload: redactPayload(payload, reveal) } });
  }
  return json({ submission: { ...row, payload } });
}

async function assignSubmission(request, env, user, caseNo) {
  const body = await readJson(request);
  const userId = body.user_id === null ? null : parseInt(body.user_id, 10);
  if (userId !== null && !Number.isFinite(userId)) return json({ error: 'user_id is required' }, 400);

  if (userId !== null) {
    const u = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND active = 1').bind(userId).first();
    if (!u) return json({ error: 'no such active user' }, 400);
  }
  const status = userId === null ? 'new' : 'assigned';
  const res = await env.DB.prepare(
    'UPDATE submissions SET assigned_to = ?, status = ? WHERE case_no = ?')
    .bind(userId, status, caseNo).run();
  if (res.meta && res.meta.changes === 0) return json({ error: 'not found' }, 404);
  await setStage(env, user, caseNo, userId === null ? 'open' : 'assigned');
  return json({ ok: true, case_no: caseNo, assigned_to: userId, status });
}

/* Extended statuses and closure (HANDOFF priority 20). submissions.status is
   CHECK-locked to four coarse values, so the nine operational stages live in
   case_status and the coarse column is derived — everything older that reads
   status keeps working, and the closed stage is reachable only through the
   closing checklist. */
const STAGES = ['open', 'assigned', 'in_progress', 'report_review', 'awaiting_client',
  'complete', 'on_hold', 'cancelled', 'closed'];

/* MASTER §5 — a lead's lifecycle, which is NOT a case's. These live in their
   own table and their own vocabulary; "rate sheet sent" means nothing on a
   case and "report review" means nothing on a lead. */
const LEAD_STATUSES = ['lead', 'rate_sheet_sent', 'intake_sent', 'intake_received',
  'contacted', 'more_info_requested', 'converted', 'declined', 'closed_lead'];
// Once the office has decided (converted / declined / closed), the system
// never quietly moves the lead again — a sheet re-sent to a declined lead is
// a courtesy, not a reopening.
const LEAD_DECIDED = ['converted', 'declined', 'closed_lead'];

/* Every send attempt, kept. Written even when the provider refused — a send
   that failed is the one the office most needs to see, and a silent failure
   is how "I sent that last week" becomes wrong. Never throws: recording the
   attempt must not be able to break the send it is recording. */
async function logSend(env, user, row) {
  try {
    await env.DB.prepare(
      `INSERT INTO send_log (case_no, kind, sheet_id, door, recipient, ok, detail, sent_by, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(row.case_no || null, row.kind, row.sheet_id || null, row.door || null,
            row.recipient, row.ok ? 1 : 0, row.detail || null,
            user ? user.id : null, nowIso()).run();
  } catch { /* the send is the point; the log is the record of it */ }
}

async function stampLead(env, user, caseNo, status, { manual = false } = {}) {
  const cur = await env.DB.prepare('SELECT status FROM lead_status WHERE case_no = ?')
    .bind(caseNo).first();
  if (!manual && cur && LEAD_DECIDED.includes(cur.status)) return false;
  await env.DB.prepare(
    `INSERT INTO lead_status (case_no, status, set_by, set_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(case_no) DO UPDATE SET status = ?2, set_by = ?3, set_at = ?4`)
    .bind(caseNo, status, user ? user.id : null, nowIso()).run();
  return true;
}
const coarseFor = stage =>
  stage === 'closed' || stage === 'cancelled' ? 'closed'
  : stage === 'open' ? 'new'
  : stage === 'assigned' ? 'assigned' : 'in_progress';

const CLOSURE_ITEMS = [
  ['field_work', 'Field work completed'],
  ['activity_logs', 'Activity logs completed'],
  ['evidence', 'Evidence uploaded and accounted for'],
  ['report', 'Report completed'],
  ['admin_review', 'Admin review completed'],
  ['deliverables', 'Client deliverables prepared'],
  ['expenses', 'Expenses reviewed'],
  ['billing', 'Billing reviewed'],
];

async function setStage(env, user, caseNo, stage) {
  await env.DB.prepare(
    `INSERT INTO case_status (case_no, stage, set_by, set_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(case_no) DO UPDATE SET stage = ?2, set_by = ?3, set_at = ?4`)
    .bind(caseNo, stage, user ? user.id : null, nowIso()).run();
  await env.DB.prepare('UPDATE submissions SET status = ? WHERE case_no = ?')
    .bind(coarseFor(stage), caseNo).run();
}

async function setStatus(request, env, user, caseNo) {
  const body = await readJson(request);
  let stage = String(body.status || '');
  if (stage === 'new') stage = 'open';   // the older vocabulary
  if (!STAGES.includes(stage)) return json({ error: 'invalid status' }, 400);
  const row = await env.DB.prepare('SELECT status FROM submissions WHERE case_no = ?').bind(caseNo).first();
  if (!row) return json({ error: 'not found' }, 404);
  if (stage === 'closed') {
    // Already closed: a no-op, so re-saving a closed case does not error.
    if (row.status === 'closed') return json({ ok: true, case_no: caseNo, status: 'closed' });
    return json({ error: 'Closing goes through the checklist — open the case and use Close the case.' }, 400);
  }
  if (row.status === 'closed') {
    // Leaving closed reopens: the stamp clears, the ticks stay as history.
    await env.DB.prepare('UPDATE case_closure SET closed_by = NULL, closed_at = NULL WHERE case_no = ?')
      .bind(caseNo).run();
  }
  await setStage(env, user, caseNo, stage);
  return json({ ok: true, case_no: caseNo, status: stage });
}

async function saveClosure(request, env, user, caseNo) {
  const sub = await env.DB.prepare('SELECT 1 AS x FROM submissions WHERE case_no = ?').bind(caseNo).first();
  if (!sub) return json({ error: 'not found' }, 404);
  const body = await readJson(request);
  const given = body.checklist && typeof body.checklist === 'object' ? body.checklist : {};
  const out = {};
  for (const [k] of CLOSURE_ITEMS) if (given[k]) out[k] = true;
  await env.DB.prepare(
    `INSERT INTO case_closure (case_no, checklist_json, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(case_no) DO UPDATE SET checklist_json = ?2, updated_by = ?3, updated_at = ?4`)
    .bind(caseNo, JSON.stringify(out), user.id, nowIso()).run();
  return json({ ok: true, checklist: out });
}

async function closeCase(env, user, caseNo) {
  const sub = await env.DB.prepare('SELECT status FROM submissions WHERE case_no = ?').bind(caseNo).first();
  if (!sub) return json({ error: 'not found' }, 404);
  if (sub.status === 'closed') return json({ ok: true, status: 'closed' });
  const c = await env.DB.prepare('SELECT checklist_json FROM case_closure WHERE case_no = ?').bind(caseNo).first();
  let ticks = {};
  try { ticks = c && c.checklist_json ? JSON.parse(c.checklist_json) : {}; } catch { ticks = {}; }
  const missing = CLOSURE_ITEMS.filter(([k]) => !ticks[k]).map(([, l]) => l);
  if (missing.length) {
    return json({ error: 'Finish the checklist first — still open: ' + missing.join('; ') + '.' }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO case_closure (case_no, checklist_json, closed_by, closed_at, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?3, ?4)
     ON CONFLICT(case_no) DO UPDATE SET closed_by = ?3, closed_at = ?4, updated_by = ?3, updated_at = ?4`)
    .bind(caseNo, JSON.stringify(ticks), user.id, nowIso()).run();
  await setStage(env, user, caseNo, 'closed');
  return json({ ok: true, status: 'closed' });
}

/* ------------------------------------------------------- case workspace */

/* THE ACCESS RULE for everything in the workspace. An investigator reaches a
   case only when it is assigned to them — checked here, against the database,
   on every call. Changing the case number in a URL must not be a way in, so no
   workspace route trusts a caller's word about which case they are allowed to
   open. Returns the submission row, or null. */
async function caseFor(env, user, caseNo) {
  const row = await env.DB.prepare(
    'SELECT case_no, kind, status, assigned_to FROM submissions WHERE case_no = ?')
    .bind(caseNo).first();
  if (!row) return null;
  if (user.role !== 'admin' && row.assigned_to !== user.id) return null;
  return row;
}

async function listCaseTypes(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, label, side, active FROM case_types WHERE active = 1 ORDER BY side, label').all();
  return results || [];
}

/* Private-case details (HANDOFF priority 16): the operational facts a case's
   type calls for, conditional on that type. These lists are the allow-list —
   a save stores only the active set's keys, so a field nobody decided to ask
   for cannot arrive by accident. [key, label] pairs; the page renders from
   what the Worker sends and decides nothing.

   Objectives are framed as OBSERVE + DOCUMENT throughout. The application
   makes no legal conclusions: investigators document facts; courts and
   attorneys interpret them. No field here invites monitoring that the client
   could not lawfully request. Subject and vehicle structured records are
   priority 17, photographs wait on evidence storage (priority 6). */
const DETAIL_SETS = {
  infidelity: [
    ['work_schedule', 'Normal work schedule'],
    ['known_routine', 'Known routine'],
    ['suspected_companion', 'Suspected companion (if known)'],
    ['suspected_locations', 'Suspected locations'],
    ['social_accounts', 'Known social accounts'],
    ['upcoming_events', 'Upcoming events / travel'],
    ['client_concerns', 'Client concerns'],
    ['objectives', 'Investigation objectives'],
  ],
  custody: [
    ['custody_schedule', 'Custody schedule'],
    ['exchange_details', 'Exchange dates and locations'],
    ['school_daycare', 'School / daycare'],
    ['known_residences', 'Known residences'],
    ['court_dates', 'Court dates'],
    ['court_restrictions', 'Court restrictions supplied by the client'],
    ['known_associates', 'Known associates'],
    ['allegations', 'Specific allegations / concerns'],
    ['objectives', 'Investigation objectives'],
  ],
  general: [
    ['known_routine', 'Known routine'],
    ['relevant_locations', 'Relevant locations'],
    ['client_concerns', 'Client concerns'],
    ['objectives', 'Investigation objectives'],
  ],
};

function detailSetFor(caseType) {
  const s = String(caseType || '');
  if (/infidelity|adultery/i.test(s)) return 'infidelity';
  if (/custody/i.test(s)) return 'custody';
  return 'general';
}

/* Structured subject and vehicle records (HANDOFF priority 17). Fieldwork
   facts: both roles read and write them on cases they can open. A save
   replaces the record as a whole — the form submits every field — and there
   is no delete, the activity-log posture: corrections are edits, stamped
   with who and when. */
const SUBJECT_FIELDS = ['name', 'alias', 'dob', 'height', 'weight', 'hair', 'descriptors',
  'addresses', 'employer', 'phone', 'social_accounts', 'notes'];
const VEHICLE_FIELDS = ['year', 'make', 'model', 'color', 'plate', 'plate_state',
  'registered_owner', 'notes'];

function cleanRecord(body, allowed) {
  const out = {};
  for (const k of allowed) {
    const v = body[k] === undefined || body[k] === null ? '' : String(body[k]).trim();
    const cap = k === 'notes' || k === 'descriptors' || k === 'addresses' ? 2000 : 200;
    out[k] = v ? v.slice(0, cap) : null;
  }
  return out;
}

async function saveSubject(request, env, user, caseNo, subjectId) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const f = cleanRecord(await readJson(request), SUBJECT_FIELDS);
  if (!f.name) return json({ error: 'A subject needs at least a name.' }, 400);
  const now = nowIso();
  if (subjectId == null) {
    const res = await env.DB.prepare(
      `INSERT INTO case_subjects (case_no, name, alias, dob, height, weight, hair, descriptors,
         addresses, employer, phone, social_accounts, notes, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(caseNo, f.name, f.alias, f.dob, f.height, f.weight, f.hair, f.descriptors,
            f.addresses, f.employer, f.phone, f.social_accounts, f.notes, user.id, now, user.id, now).run();
    return json({ ok: true, id: res.meta ? res.meta.last_row_id : null }, 201);
  }
  const owns = await env.DB.prepare(
    'SELECT id FROM case_subjects WHERE id = ? AND case_no = ?').bind(subjectId, caseNo).first();
  if (!owns) return json({ error: 'not found' }, 404);
  await env.DB.prepare(
    `UPDATE case_subjects SET name = ?, alias = ?, dob = ?, height = ?, weight = ?, hair = ?,
        descriptors = ?, addresses = ?, employer = ?, phone = ?, social_accounts = ?, notes = ?,
        updated_by = ?, updated_at = ? WHERE id = ?`)
    .bind(f.name, f.alias, f.dob, f.height, f.weight, f.hair, f.descriptors, f.addresses,
          f.employer, f.phone, f.social_accounts, f.notes, user.id, now, subjectId).run();
  return json({ ok: true, id: subjectId });
}

async function saveVehicle(request, env, user, caseNo, subjectId, vehicleId) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const owns = await env.DB.prepare(
    'SELECT id FROM case_subjects WHERE id = ? AND case_no = ?').bind(subjectId, caseNo).first();
  if (!owns) return json({ error: 'not found' }, 404);
  const f = cleanRecord(await readJson(request), VEHICLE_FIELDS);
  if (!f.make && !f.model && !f.plate) {
    return json({ error: 'Describe the vehicle — a make, a model or a plate.' }, 400);
  }
  const now = nowIso();
  if (vehicleId == null) {
    const res = await env.DB.prepare(
      `INSERT INTO subject_vehicles (subject_id, year, make, model, color, plate, plate_state,
         registered_owner, notes, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(subjectId, f.year, f.make, f.model, f.color, f.plate, f.plate_state,
            f.registered_owner, f.notes, user.id, now, user.id, now).run();
    return json({ ok: true, id: res.meta ? res.meta.last_row_id : null }, 201);
  }
  const v = await env.DB.prepare(
    'SELECT id FROM subject_vehicles WHERE id = ? AND subject_id = ?').bind(vehicleId, subjectId).first();
  if (!v) return json({ error: 'not found' }, 404);
  await env.DB.prepare(
    `UPDATE subject_vehicles SET year = ?, make = ?, model = ?, color = ?, plate = ?,
        plate_state = ?, registered_owner = ?, notes = ?, updated_by = ?, updated_at = ?
      WHERE id = ?`)
    .bind(f.year, f.make, f.model, f.color, f.plate, f.plate_state, f.registered_owner,
          f.notes, user.id, now, vehicleId).run();
  return json({ ok: true, id: vehicleId });
}

async function caseSettings(env, caseNo) {
  return await env.DB.prepare(
    `SELECT client_hourly, client_mileage, show_client_identity
       FROM case_settings WHERE case_no = ?`).bind(caseNo).first()
    || { client_hourly: null, client_mileage: null, show_client_identity: 0 };
}

async function configValue(env, key, fallback) {
  const row = await env.DB.prepare('SELECT value FROM app_config WHERE key = ?').bind(key).first();
  return row && row.value != null ? row.value : fallback;
}

/* Hours and budget against what was authorized. Hours come from completed
   investigation days; nothing is estimated from an open day, because a day
   still running has no total yet.

   Thresholds are configuration (app_config), not constants sprinkled through
   the code — 75/90/100 today, whatever the office wants tomorrow. */
async function authorizationFor(env, caseNo, forAdmin) {
  const meta = await env.DB.prepare(
    `SELECT m.authorized_hours, m.authorized_budget, m.case_type_id, t.label AS case_type, t.side
       FROM case_meta m LEFT JOIN case_types t ON t.id = m.case_type_id
      WHERE m.case_no = ?`).bind(caseNo).first();

  const used = await env.DB.prepare(
    'SELECT COALESCE(SUM(hours), 0) AS h, COALESCE(SUM(miles), 0) AS m FROM case_days WHERE case_no = ?')
    .bind(caseNo).first();
  const hoursUsed = Math.round((Number(used && used.h) || 0) * 100) / 100;

  const thresholds = String(await configValue(env, 'auth_warn_thresholds', '75,90,100'))
    .split(',').map(n => parseFloat(n)).filter(n => Number.isFinite(n)).sort((a, b) => a - b);

  const authHours = meta && meta.authorized_hours != null ? Number(meta.authorized_hours) : null;
  const pct = authHours && authHours > 0 ? Math.round((hoursUsed / authHours) * 1000) / 10 : null;
  // The highest threshold this case has reached, or null while it is clear.
  const level = pct == null ? null
    : thresholds.filter(t => pct >= t).pop() ?? null;

  const out = {
    case_type: meta ? meta.case_type : null,
    case_type_id: meta ? meta.case_type_id : null,
    side: meta ? meta.side : null,
    authorized_hours: authHours,
    hours_used: hoursUsed,
    hours_remaining: authHours == null ? null : Math.round((authHours - hoursUsed) * 100) / 100,
    percent_used: pct,
    warn_at: thresholds,
    warn_level: level,
    miles_total: Math.round((Number(used && used.m) || 0) * 10) / 10,
  };

  // Money is commercial. An investigator is told the hours they are working to
  // and nothing about what the case is worth.
  if (forAdmin) {
    const st = await caseSettings(env, caseNo);
    /* The default rate follows the case's SIDE of the business — the two
       pricing models never share a number (RATESHEETS.md). A claims case
       bills at the standard carrier rate; a private case at the retainer
       model's hourly. An explicit per-case rate still overrides either. */
    const sub = await env.DB.prepare('SELECT kind FROM submissions WHERE case_no = ?').bind(caseNo).first();
    const kind = sub ? sub.kind : null;
    const rate = st.client_hourly != null ? Number(st.client_hourly)
      : (kind === 'consumer' ? PERSONAL.hourly : RATES.surveillance.standard);
    const budget = meta && meta.authorized_budget != null ? Number(meta.authorized_budget) : null;
    const billable = Math.round(hoursUsed * rate * 100) / 100;
    out.authorized_budget = budget;
    out.billable_so_far = billable;
    out.budget_remaining = budget == null ? null : Math.round((budget - billable) * 100) / 100;
    out.billed_at_rate = rate;
    out.case_rate_set = st.client_hourly != null;
    out.client_mileage_rate = st.client_mileage;
    out.kind = kind;

    if (kind === 'claims') {
      // The authorized package, when the hours match one — so the office sees
      // "24 hours = the $3,300 block" without re-deriving it.
      const pkg = authHours != null ? RATES.packages.find(p => p.hours === authHours) : null;
      if (pkg) { out.package_price = pkg.price; out.package_label = pkg.label; }
    } else if (kind === 'consumer') {
      /* The private-retainer balance (RATESHEETS.md admin side): how much of
         the client's money the recorded work has consumed, at this case's
         rate. Internal only — an investigator never receives this branch,
         and no client-facing surface reads it yet. */
      const ret = await env.DB.prepare(
        'SELECT retainer_amount, received FROM case_retainer WHERE case_no = ?').bind(caseNo).first();
      const amount = ret && ret.retainer_amount != null ? Number(ret.retainer_amount) : PERSONAL.retainer;
      const applied = Math.round(hoursUsed * rate * 100) / 100;
      out.retainer = {
        amount,
        received: !!(ret && ret.received),
        applied,
        remaining: Math.round((amount - applied) * 100) / 100,
        approx_hours_remaining: rate > 0 ? Math.round(((amount - applied) / rate) * 10) / 10 : null,
      };
    }
    out.show_client_identity = st.show_client_identity ? 1 : 0;
  }
  return out;
}

async function caseWorkspace(env, user, caseNo) {
  const row = await caseFor(env, user, caseNo);
  if (!row) return json({ error: 'not found' }, 404);
  const admin = user.role === 'admin';

  /* Removed entries still come back, stamped — the page greys them out with a
     way to put one back, and the report skips them. Erasing the row outright
     is what this deliberately does not do. */
  const { results: activity } = await env.DB.prepare(
    `SELECT a.id, a.day_id, a.at_date, a.at_time, a.kind, a.description, a.location,
            a.vehicle, a.internal_note, a.edited_at, u.display_name AS investigator,
            COALESCE(m.subject_documented, 0) AS subject_documented,
            COALESCE(m.video_acquired, 0) AS video_acquired,
            COALESCE(m.photo_acquired, 0) AS photo_acquired,
            r.removed_at, ru.display_name AS removed_by
       FROM activity_log a LEFT JOIN users u ON u.id = a.investigator_id
       LEFT JOIN activity_media m ON m.entry_id = a.id
       LEFT JOIN activity_removed r ON r.entry_id = a.id
       LEFT JOIN users ru ON ru.id = r.removed_by
      WHERE a.case_no = ?
      ORDER BY a.at_date DESC, a.at_time DESC, a.id DESC
      LIMIT 500`).bind(caseNo).all();

  const { results: days } = await env.DB.prepare(
    `SELECT d.id, d.day_date, d.start_time, d.end_time, d.start_mileage, d.end_mileage,
            d.hours, d.miles, d.summary, u.display_name AS investigator, d.investigator_id
       FROM case_days d LEFT JOIN users u ON u.id = d.investigator_id
      WHERE d.case_no = ? ORDER BY d.day_date DESC, d.id DESC LIMIT 100`).bind(caseNo).all();

  // The day this caller currently has running, if any — what turns the button
  // into END INVESTIGATION DAY.
  /* `created_at` is the SERVER's instant for when this day was started, and it
     is what the field timer derives from (SURVEILLANCE P2): a phone that
     sleeps, reloads or has a wrong clock cannot move it. `start_time` beside
     it stays the investigator's own recorded start, which is what the day's
     hours are computed from at the end. */
  const openDayRow = await env.DB.prepare(
    `SELECT id, day_date, start_time, start_mileage, created_at AS started_at FROM case_days
      WHERE case_no = ? AND investigator_id = ? AND end_time IS NULL
      ORDER BY id DESC LIMIT 1`).bind(caseNo, user.id).first();
  // Breaks ride with the open day so the timer can subtract them and freeze.
  const openDay = openDayRow
    ? { ...openDayRow, ...(await dayPauseState(env, openDayRow.id)) } : null;

  const { results: reports } = await env.DB.prepare(
    `SELECT r.id, r.day_id, r.report_date, r.status, r.body, r.review_note,
            r.updated_at, u.display_name AS investigator, r.investigator_id
       FROM case_reports r LEFT JOIN users u ON u.id = r.investigator_id
      WHERE r.case_no = ? ORDER BY r.report_date DESC, r.id DESC LIMIT 100`).bind(caseNo).all();

  const { results: expenses } = await env.DB.prepare(
    `SELECT e.id, e.expense_date, e.category, e.amount, e.miles, e.description,
            e.reimbursable, e.billable, e.internal, e.reviewed_at, e.edited_at,
            e.investigator_id, u.display_name AS investigator
       FROM case_expenses e LEFT JOIN users u ON u.id = e.investigator_id
      WHERE e.case_no = ? ORDER BY e.expense_date DESC, e.id DESC LIMIT 200`).bind(caseNo).all();

  // Visibility is enforced HERE: an admin-only note never leaves the Worker
  // for anyone else. The page renders what arrives; it decides nothing.
  const { results: notes } = await env.DB.prepare(
    `SELECT n.id, n.note_type, n.visibility, n.body, n.created_at, n.edited_at,
            u.display_name AS author
       FROM case_notes n LEFT JOIN users u ON u.id = n.author_id
      WHERE n.case_no = ? ${admin ? '' : "AND n.visibility != 'admin'"}
      ORDER BY n.id DESC LIMIT 200`).bind(caseNo).all();

  const { results: offers } = admin ? await env.DB.prepare(
    `SELECT o.id, o.status, o.offered_at, o.responded_at, o.investigation_date, o.expected_hours,
            o.general_location, o.compensation_hourly, o.mileage_terms, o.decline_reason,
            u.display_name AS investigator
       FROM case_offers o LEFT JOIN users u ON u.id = o.investigator_id
      WHERE o.case_no = ? ORDER BY o.id DESC LIMIT 50`).bind(caseNo).all() : { results: [] };

  // Communication log (priority 18): visibility enforced in the query, like
  // the notes above it.
  const { results: comms } = await env.DB.prepare(
    `SELECT c.id, c.comm_type, c.at_date, c.at_time, c.person, c.summary,
            c.follow_up_date, c.visibility, c.created_at, u.display_name AS author
       FROM case_comms c LEFT JOIN users u ON u.id = c.author_id
      WHERE c.case_no = ? ${admin ? '' : "AND c.visibility != 'admin'"}
      ORDER BY c.at_date DESC, c.at_time DESC, c.id DESC LIMIT 200`).bind(caseNo).all();

  // Evidence (priority 6): fieldwork product, so both roles see it on cases
  // they can open. Deleted rows stay visible to the office only — the record
  // of a removal is admin bookkeeping, not field context.
  const { results: evidence } = await env.DB.prepare(
    `SELECT e.id, e.filename, e.content_type, e.size_bytes, e.classification, e.entry_id,
            e.subject_id, e.note, e.uploaded_at, e.deleted_at, u.display_name AS uploaded_by
       FROM case_evidence e LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE e.case_no = ? ${admin ? '' : 'AND e.deleted_at IS NULL'}
      ORDER BY e.id DESC LIMIT 200`).bind(caseNo).all();

  // Follow-up tasks (priority 19): the office sees them all; an investigator
  // only the ones assigned to them.
  const { results: tasks } = await env.DB.prepare(
    `SELECT t.id, t.task, t.assigned_to, t.due_date, t.priority, t.status,
            t.created_at, t.done_at, u.display_name AS assignee
       FROM case_tasks t LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.case_no = ? ${admin ? '' : 'AND t.assigned_to = ?'}
      ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END,
               t.due_date IS NULL, t.due_date, t.id LIMIT 200`)
    .bind(...(admin ? [caseNo] : [caseNo, user.id])).all();

  const myOffer = admin ? null : await env.DB.prepare(
    `SELECT investigation_date, expected_hours, general_location, instructions,
            compensation_hourly, mileage_terms
       FROM case_offers WHERE case_no = ? AND investigator_id = ? AND status = 'accepted'
      ORDER BY id DESC LIMIT 1`).bind(caseNo, user.id).first();

  const auth = await authorizationFor(env, caseNo, admin);

  // The operational stage (priority 20); older cases without a row fall back
  // to a stage derived from the coarse status.
  const stRow = await env.DB.prepare('SELECT stage FROM case_status WHERE case_no = ?').bind(caseNo).first();
  const stage = stRow ? stRow.stage : (row.status === 'new' ? 'open' : row.status);

  /* Build and invoice state for the overview's package-progress column
     (UIBUILD P7). Admin-only, like the closure block below: an invoice is
     money and a build is a client deliverable — an investigator receives
     neither, the same boundary /packages and /build already enforce. */
  let buildStatus = null, invoiceStatus = null;
  if (admin) {
    const b = await env.DB.prepare(
      'SELECT status FROM case_builds WHERE case_no = ? ORDER BY version DESC, id DESC LIMIT 1')
      .bind(caseNo).first();
    buildStatus = b ? b.status : null;
    const iv = await env.DB.prepare(
      "SELECT status FROM invoices WHERE case_no = ? AND status != 'void' ORDER BY id DESC LIMIT 1")
      .bind(caseNo).first();
    invoiceStatus = iv ? iv.status : null;
  }

  let closure = null;
  if (admin) {
    const c = await env.DB.prepare(
      `SELECT c.checklist_json, c.closed_at, u.display_name AS closed_by
         FROM case_closure c LEFT JOIN users u ON u.id = c.closed_by
        WHERE c.case_no = ?`).bind(caseNo).first();
    let checklist = {};
    try { checklist = c && c.checklist_json ? JSON.parse(c.checklist_json) : {}; } catch { checklist = {}; }
    closure = { items: CLOSURE_ITEMS, checklist,
                closed_at: c ? c.closed_at : null, closed_by: c ? c.closed_by : null };
  }

  /* Per-type details for private cases (priority 16). The case type picks the
     field set; a claims case never has one — its claim details live in the
     intake payload. Both roles read them: they are fieldwork facts. */
  let details = null, detailSet = null, detailFields = null;
  if (row.kind !== 'claims') {
    detailSet = detailSetFor(auth && auth.case_type);
    detailFields = DETAIL_SETS[detailSet];
    const det = await env.DB.prepare(
      'SELECT detail_json FROM case_details WHERE case_no = ?').bind(caseNo).first();
    try { details = det && det.detail_json ? JSON.parse(det.detail_json) : {}; }
    catch { details = {}; }
  }

  /* Structured subjects with their vehicles (priority 17) — for both roles;
     the subject is who is watched, never who is paying. */
  const { results: subjectRows } = await env.DB.prepare(
    `SELECT s.id, s.name, s.alias, s.dob, s.height, s.weight, s.hair, s.descriptors,
            s.addresses, s.employer, s.phone, s.social_accounts, s.notes, s.updated_at,
            u.display_name AS added_by
       FROM case_subjects s LEFT JOIN users u ON u.id = s.created_by
      WHERE s.case_no = ? ORDER BY s.id LIMIT 50`).bind(caseNo).all();
  const { results: vehicleRows } = await env.DB.prepare(
    `SELECT v.id, v.subject_id, v.year, v.make, v.model, v.color, v.plate, v.plate_state,
            v.registered_owner, v.notes
       FROM subject_vehicles v JOIN case_subjects s ON s.id = v.subject_id
      WHERE s.case_no = ? ORDER BY v.id LIMIT 200`).bind(caseNo).all();
  const subjects = (subjectRows || []).map(s => ({
    ...s, vehicles: (vehicleRows || []).filter(v => v.subject_id === s.id),
  }));

  return json({
    case_no: row.case_no,
    kind: row.kind,
    status: row.status,
    stage,
    closure,
    // The clock the field timer trusts. The page measures its own skew against
    // this once and never counts ticks, so sleeping the phone changes nothing.
    server_now: nowIso(),
    ...(admin ? { build_status: buildStatus, invoice_status: invoiceStatus,
                  sends: (await env.DB.prepare(
                    `SELECT l.kind, l.sheet_id, l.door, l.recipient, l.ok, l.detail, l.sent_at,
                            u.display_name AS sent_by
                       FROM send_log l LEFT JOIN users u ON u.id = l.sent_by
                      WHERE l.case_no = ? ORDER BY l.id DESC LIMIT 25`)
                    .bind(caseNo).all()).results || [] } : {}),
    authorization: auth,
    details,
    detail_set: detailSet,
    detail_fields: detailFields,
    subjects,
    case_types: admin ? await listCaseTypes(env) : [],
    activity: activity || [],
    days: days || [],
    open_day: openDay || null,
    reports: reports || [],
    expenses: expenses || [],
    notes: notes || [],
    comms: comms || [],
    evidence: evidence || [],
    tasks: tasks || [],
    offers: offers || [],
    my_offer: myOffer || null,
  });
}

async function setCaseMeta(request, env, caseNo) {
  const body = await readJson(request);
  const exists = await env.DB.prepare('SELECT 1 AS x FROM submissions WHERE case_no = ?').bind(caseNo).first();
  if (!exists) return json({ error: 'not found' }, 404);

  const num = v => {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;   // undefined = reject
  };
  const hours = num(body.authorized_hours);
  const budget = num(body.authorized_budget);
  if (hours === undefined || budget === undefined) {
    return json({ error: 'Hours and budget must be numbers, or left blank.' }, 400);
  }
  let typeId = null;
  if (body.case_type_id !== null && body.case_type_id !== undefined && String(body.case_type_id) !== '') {
    typeId = parseInt(body.case_type_id, 10);
    if (!Number.isFinite(typeId)) return json({ error: 'invalid case type' }, 400);
    const t = await env.DB.prepare('SELECT 1 AS x FROM case_types WHERE id = ? AND active = 1').bind(typeId).first();
    if (!t) return json({ error: 'no such case type' }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO case_meta (case_no, case_type_id, authorized_hours, authorized_budget, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(case_no) DO UPDATE SET
       case_type_id = ?2, authorized_hours = ?3, authorized_budget = ?4,
       updated_by = ?5, updated_at = ?6`)
    .bind(caseNo, typeId, hours, budget, null, nowIso()).run();

  return json({ ok: true, authorization: await authorizationFor(env, caseNo, true) });
}

/* ---- the investigation day ---- */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function startDay(request, env, user, caseNo) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const body = await readJson(request);
  const date = String(body.day_date || '');
  const time = String(body.start_time || '');
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) {
    return json({ error: 'A date and a start time are both needed.' }, 400);
  }
  const open = await env.DB.prepare(
    'SELECT id FROM case_days WHERE case_no = ? AND investigator_id = ? AND end_time IS NULL')
    .bind(caseNo, user.id).first();
  if (open) return json({ error: 'You already have a day running on this case.', day_id: open.id }, 409);

  const miles = body.start_mileage === '' || body.start_mileage == null ? null : Number(body.start_mileage);
  if (miles !== null && !(Number.isFinite(miles) && miles >= 0)) {
    return json({ error: 'Beginning mileage must be a number.' }, 400);
  }
  const res = await env.DB.prepare(
    `INSERT INTO case_days (case_no, investigator_id, day_date, start_time, start_mileage, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`).bind(caseNo, user.id, date, time, miles, nowIso()).run();
  return json({ ok: true, day_id: res.meta ? res.meta.last_row_id : null }, 201);
}

/* What the field timer needs to know about breaks (owner, 2026-08-14):
   how much CLOSED paused time to subtract, and — if a pause is open right
   now — the server instant it opened at, which is what the display freezes
   on. Both are server timestamps, so nothing here can be moved by a phone
   with a wrong clock. */
async function dayPauseState(env, dayId) {
  const { results } = await env.DB.prepare(
    'SELECT started_at, ended_at FROM case_day_pauses WHERE day_id = ?').bind(dayId).all();
  let closed = 0, openAt = null;
  for (const p of results || []) {
    if (p.ended_at) {
      const ms = Date.parse(p.ended_at) - Date.parse(p.started_at);
      if (Number.isFinite(ms) && ms > 0) closed += ms;
    } else {
      openAt = p.started_at;
    }
  }
  return { paused_ms: closed, paused_at: openAt };
}

/* The caller's own running day. Pause and resume are scoped the same way
   day/end is — you can only stop your own clock. */
async function openDayFor(env, user, caseNo) {
  return await env.DB.prepare(
    `SELECT id, start_time FROM case_days
      WHERE case_no = ? AND investigator_id = ? AND end_time IS NULL
      ORDER BY id DESC LIMIT 1`).bind(caseNo, user.id).first();
}

async function pauseDay(request, env, user, caseNo) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const day = await openDayFor(env, user, caseNo);
  if (!day) return json({ error: 'No investigation day is running on this case.' }, 409);
  const state = await dayPauseState(env, day.id);
  if (state.paused_at) return json({ error: 'The day is already paused.' }, 409);
  const reason = String((await readJson(request)).reason || '').slice(0, 200) || null;
  await env.DB.prepare(
    'INSERT INTO case_day_pauses (day_id, started_at, reason, by_user) VALUES (?, ?, ?, ?)')
    .bind(day.id, nowIso(), reason, user.id).run();
  return json({ ok: true, day_id: day.id, ...(await dayPauseState(env, day.id)), server_now: nowIso() });
}

async function resumeDay(env, user, caseNo) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const day = await openDayFor(env, user, caseNo);
  if (!day) return json({ error: 'No investigation day is running on this case.' }, 409);
  const state = await dayPauseState(env, day.id);
  if (!state.paused_at) return json({ error: 'The day is not paused.' }, 409);
  await env.DB.prepare(
    'UPDATE case_day_pauses SET ended_at = ? WHERE day_id = ? AND ended_at IS NULL')
    .bind(nowIso(), day.id).run();
  return json({ ok: true, day_id: day.id, ...(await dayPauseState(env, day.id)), server_now: nowIso() });
}

async function endDay(request, env, user, caseNo) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const body = await readJson(request);
  const time = String(body.end_time || '');
  if (!TIME_RE.test(time)) return json({ error: 'An end time is needed.' }, 400);

  const day = await env.DB.prepare(
    `SELECT id, day_date, start_time, start_mileage FROM case_days
      WHERE case_no = ? AND investigator_id = ? AND end_time IS NULL ORDER BY id DESC LIMIT 1`)
    .bind(caseNo, user.id).first();
  if (!day) return json({ error: 'No investigation day is running on this case.' }, 409);

  const endMiles = body.end_mileage === '' || body.end_mileage == null ? null : Number(body.end_mileage);
  if (endMiles !== null && !(Number.isFinite(endMiles) && endMiles >= 0)) {
    return json({ error: 'Ending mileage must be a number.' }, 400);
  }
  if (endMiles !== null && day.start_mileage != null && endMiles < day.start_mileage) {
    return json({ error: 'Ending mileage is lower than the beginning mileage.' }, 400);
  }

  // Minutes across the clock. A day that runs past midnight is treated as
  // ending the next day rather than as a negative span.
  const mins = t => (parseInt(t.slice(0, 2), 10) * 60) + parseInt(t.slice(3, 5), 10);
  let span = mins(time) - mins(day.start_time);
  if (span < 0) span += 24 * 60;

  /* A day ended while still paused closes the pause first, so the arithmetic
     below is over complete spans and no break is left hanging open. */
  await env.DB.prepare(
    'UPDATE case_day_pauses SET ended_at = ? WHERE day_id = ? AND ended_at IS NULL')
    .bind(nowIso(), day.id).run();

  /* Breaks come off the billable total. An investigator who stopped for an
     hour did not work that hour, and `hours` is what authorization and
     invoices are drawn against — so it is the WORKED figure. The paused total
     is returned beside it rather than hidden, and the day-end review shows
     both. A duration is timezone-independent, so subtracting spans measured
     in UTC from a local-clock span is sound. */
  const paused = (await dayPauseState(env, day.id)).paused_ms;
  const pausedMins = Math.round(paused / 60000);
  const worked = Math.max(0, span - pausedMins);
  const hours = Math.round((worked / 60) * 100) / 100;
  const pausedHours = Math.round((pausedMins / 60) * 100) / 100;
  const miles = endMiles != null && day.start_mileage != null
    ? Math.round((endMiles - day.start_mileage) * 10) / 10 : null;

  await env.DB.prepare(
    `UPDATE case_days SET end_time = ?, end_mileage = ?, hours = ?, miles = ?,
            summary = ?, ended_at = ? WHERE id = ?`)
    .bind(time, endMiles, hours, miles, String(body.summary || '').slice(0, 4000), nowIso(), day.id).run();

  return json({ ok: true, day_id: day.id, hours, miles,
                paused_hours: pausedHours,
                span_hours: Math.round((span / 60) * 100) / 100,
                authorization: await authorizationFor(env, caseNo, user.role === 'admin') });
}

/* ---- the activity log ---- */

const ACTIVITY_KINDS = ['activity', 'photo', 'video', 'location', 'vehicle', 'note', 'mileage', 'expense'];

async function addActivity(request, env, user, caseNo) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const body = await readJson(request);
  const date = String(body.at_date || '');
  const time = String(body.at_time || '');
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) {
    return json({ error: 'A date and time are both needed.' }, 400);
  }
  const kind = ACTIVITY_KINDS.includes(String(body.kind)) ? String(body.kind) : 'activity';
  const description = String(body.description || '').trim().slice(0, 4000);
  if (!description) return json({ error: 'Describe what happened.' }, 400);

  // Attach to the caller's running day when there is one, so the timeline and
  // the day's totals stay tied together without the field asking.
  const open = await env.DB.prepare(
    'SELECT id FROM case_days WHERE case_no = ? AND investigator_id = ? AND end_time IS NULL ORDER BY id DESC LIMIT 1')
    .bind(caseNo, user.id).first();

  const res = await env.DB.prepare(
    `INSERT INTO activity_log
       (case_no, day_id, investigator_id, at_date, at_time, kind, description,
        location, vehicle, internal_note, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(caseNo, open ? open.id : null, user.id, date, time, kind, description,
          String(body.location || '').slice(0, 300) || null,
          String(body.vehicle || '').slice(0, 300) || null,
          String(body.internal_note || '').slice(0, 2000) || null,
          nowIso(), user.id).run();

  const id = res.meta ? res.meta.last_row_id : null;
  // What was captured at this moment. Recorded beside the entry so the report
  // can state it per line; the media files themselves attach with priority 6.
  const f = v => (v === true || v === 1 || v === '1') ? 1 : 0;
  const sd = f(body.subject_documented), va = f(body.video_acquired), pa = f(body.photo_acquired);
  if (id && (sd || va || pa)) {
    await env.DB.prepare(
      `INSERT INTO activity_media (entry_id, subject_documented, video_acquired, photo_acquired)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(entry_id) DO UPDATE SET subject_documented = ?2, video_acquired = ?3, photo_acquired = ?4`)
      .bind(id, sd, va, pa).run();
  }

  return json({ ok: true, id }, 201);
}

/* Removing an entry (owner's request, 2026-08-14). The rule that used to
   forbid it still holds in substance: an investigative timeline that can be
   quietly erased is worth less in a hearing than one that shows its
   corrections. So this is a STAMPED removal, not an erase — the row stays,
   who removed it and when is recorded, the report and the package skip it,
   and the office can still see that it happened. Same shape as an evidence
   delete, which has worked this way from the start. */
async function removeActivity(request, env, user, caseNo, id) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const row = await env.DB.prepare(
    'SELECT id, investigator_id FROM activity_log WHERE id = ? AND case_no = ?').bind(id, caseNo).first();
  if (!row) return json({ error: 'not found' }, 404);
  if (user.role !== 'admin' && row.investigator_id !== user.id) {
    return json({ error: 'That entry belongs to another investigator.' }, 403);
  }
  const body = await readJson(request).catch(() => ({}));
  await env.DB.prepare(
    `INSERT INTO activity_removed (entry_id, removed_at, removed_by, reason)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET removed_at = ?2, removed_by = ?3, reason = ?4`)
    .bind(id, nowIso(), user.id, String((body && body.reason) || '').slice(0, 500) || null).run();
  return json({ ok: true, id });
}

/* Putting one back, for the mis-tap that removed the wrong line. */
async function restoreActivity(env, user, caseNo, id) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const row = await env.DB.prepare(
    'SELECT id, investigator_id FROM activity_log WHERE id = ? AND case_no = ?').bind(id, caseNo).first();
  if (!row) return json({ error: 'not found' }, 404);
  if (user.role !== 'admin' && row.investigator_id !== user.id) {
    return json({ error: 'That entry belongs to another investigator.' }, 403);
  }
  await env.DB.prepare('DELETE FROM activity_removed WHERE entry_id = ?').bind(id).run();
  return json({ ok: true, id });
}

/* Edits are stamped, never silent. */
async function editActivity(request, env, user, caseNo, id) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const row = await env.DB.prepare(
    'SELECT id, investigator_id FROM activity_log WHERE id = ? AND case_no = ?').bind(id, caseNo).first();
  if (!row) return json({ error: 'not found' }, 404);
  if (user.role !== 'admin' && row.investigator_id !== user.id) {
    return json({ error: 'That entry belongs to another investigator.' }, 403);
  }
  const body = await readJson(request);
  const description = String(body.description || '').trim().slice(0, 4000);
  if (!description) return json({ error: 'Describe what happened.' }, 400);

  await env.DB.prepare(
    `UPDATE activity_log SET description = ?, location = ?, vehicle = ?, internal_note = ?,
            edited_at = ?, edited_by = ? WHERE id = ?`)
    .bind(description,
          String(body.location || '').slice(0, 300) || null,
          String(body.vehicle || '').slice(0, 300) || null,
          String(body.internal_note || '').slice(0, 2000) || null,
          nowIso(), user.id, id).run();
  return json({ ok: true, id });
}

/* ------------------------------------------------------------- expenses */

const EXPENSE_CATEGORIES = ['mileage', 'tolls', 'parking', 'hotel', 'airfare',
                            'rental', 'records', 'database', 'equipment', 'meals', 'other'];

async function addExpense(request, env, user, caseNo) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const body = await readJson(request);
  const date = String(body.expense_date || '');
  if (!DATE_RE.test(date)) return json({ error: 'The expense needs a date.' }, 400);
  const category = String(body.category || '');
  if (!EXPENSE_CATEGORIES.includes(category)) return json({ error: 'Pick a category.' }, 400);
  const description = String(body.description || '').trim().slice(0, 2000);
  if (!description) return json({ error: 'Say what the expense was.' }, 400);

  const num = v => {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const amount = num(body.amount), miles = num(body.miles);
  if (amount === undefined || miles === undefined) {
    return json({ error: 'Amounts must be numbers, or left blank.' }, 400);
  }
  if (amount === null && miles === null) {
    return json({ error: 'Give an amount, or miles for a mileage claim.' }, 400);
  }

  const open = await env.DB.prepare(
    'SELECT id FROM case_days WHERE case_no = ? AND investigator_id = ? AND end_time IS NULL ORDER BY id DESC LIMIT 1')
    .bind(caseNo, user.id).first();

  const res = await env.DB.prepare(
    `INSERT INTO case_expenses
       (case_no, day_id, investigator_id, expense_date, category, amount, miles,
        description, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(caseNo, open ? open.id : null, user.id, date, category, amount, miles,
          description, nowIso(), user.id).run();
  return json({ ok: true, id: res.meta ? res.meta.last_row_id : null }, 201);
}

async function editExpense(request, env, user, caseNo, id) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const row = await env.DB.prepare(
    'SELECT id, investigator_id, reviewed_at FROM case_expenses WHERE id = ? AND case_no = ?')
    .bind(id, caseNo).first();
  if (!row) return json({ error: 'not found' }, 404);
  const admin = user.role === 'admin';
  if (!admin && row.investigator_id !== user.id) {
    return json({ error: 'That expense belongs to another investigator.' }, 403);
  }
  // Once reviewed, the classification decision was made against these numbers;
  // changing them re-opens the review rather than sliding under it.
  const body = await readJson(request);
  const description = String(body.description || '').trim().slice(0, 2000);
  if (!description) return json({ error: 'Say what the expense was.' }, 400);
  const num = v => {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const amount = num(body.amount), miles = num(body.miles);
  if (amount === undefined || miles === undefined) {
    return json({ error: 'Amounts must be numbers, or left blank.' }, 400);
  }
  await env.DB.prepare(
    `UPDATE case_expenses SET amount = ?, miles = ?, description = ?,
            reimbursable = NULL, billable = NULL, internal = NULL,
            reviewed_at = NULL, reviewed_by = NULL,
            edited_at = ?, edited_by = ? WHERE id = ?`)
    .bind(amount, miles, description, nowIso(), user.id, id).run();
  return json({ ok: true, id });
}

/* The three classifications are three separate decisions — money owed back to
   the investigator, money billable to the client, money the company eats —
   and only the office makes them. */
async function reviewExpense(request, env, user, caseNo, id) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const row = await env.DB.prepare(
    'SELECT id FROM case_expenses WHERE id = ? AND case_no = ?').bind(id, caseNo).first();
  if (!row) return json({ error: 'not found' }, 404);
  const body = await readJson(request);
  const flag = v => (v === true || v === 1 || v === '1') ? 1 : 0;
  await env.DB.prepare(
    `UPDATE case_expenses SET reimbursable = ?, billable = ?, internal = ?,
            reviewed_at = ?, reviewed_by = ? WHERE id = ?`)
    .bind(flag(body.reimbursable), flag(body.billable), flag(body.internal),
          nowIso(), user.id, id).run();
  return json({ ok: true, id });
}

/* ----------------------------------------------------------------- notes */

const NOTE_TYPES = ['investigator', 'admin', 'client_comm', 'strategy', 'subject', 'evidence', 'billing'];
// What a non-admin may author. Strategy, billing and client-communication
// notes are office records; an investigator writes field notes.
const NOTE_TYPES_INVESTIGATOR = ['investigator', 'subject', 'evidence'];

async function addNote(request, env, user, caseNo) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const body = await readJson(request);
  const admin = user.role === 'admin';
  const type = String(body.note_type || '');
  const allowed = admin ? NOTE_TYPES : NOTE_TYPES_INVESTIGATOR;
  if (!allowed.includes(type)) return json({ error: 'Pick a note type.' }, 400);

  // An investigator cannot write a note they would not be allowed to read,
  // and only the office decides what is eligible for a client-facing record.
  /* The default follows the TYPE, the way addComm already does (audit,
     2026-08-14). Four of these are office record types, the enforcement
     query filters on `visibility` and never on `note_type`, and the default
     was 'team' — so an admin note typed and saved without touching the
     visibility select went straight to the assigned investigator. It is the
     default UI path, not a contrived one: "Admin note" is the first option
     in the list. An office note now defaults to the office. */
  const OFFICE_NOTES = ['admin', 'strategy', 'billing', 'client_comm'];
  let visibility = String(body.visibility || (OFFICE_NOTES.includes(type) ? 'admin' : 'team'));
  if (!['admin', 'team', 'client_eligible'].includes(visibility)) visibility = 'team';
  if (!admin) visibility = 'team';

  const text = String(body.body || '').trim().slice(0, 8000);
  if (!text) return json({ error: 'Write the note.' }, 400);

  const res = await env.DB.prepare(
    `INSERT INTO case_notes (case_no, author_id, note_type, visibility, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(caseNo, user.id, type, visibility, text, nowIso()).run();
  return json({ ok: true, id: res.meta ? res.meta.last_row_id : null }, 201);
}

/* Communication log (HANDOFF priority 18). Office-authored: the client, the
   adjuster and the billing contact are office relationships, so an
   investigator never writes here and reads only what visibility grants —
   enforced in the query, the notes posture. Documents communication only;
   nothing is sent. */
const COMM_TYPES = ['email', 'phone', 'text', 'client_update', 'investigator', 'authorization_request', 'internal'];

async function addComm(request, env, user, caseNo) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
  const body = await readJson(request);
  const type = String(body.comm_type || '');
  if (!COMM_TYPES.includes(type)) return json({ error: 'Pick how the communication happened.' }, 400);
  const date = String(body.at_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'Date the communication.' }, 400);
  const time = String(body.at_time || '');
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return json({ error: 'Time must be HH:MM.' }, 400);
  const follow = String(body.follow_up_date || '').slice(0, 10);
  if (follow && !/^\d{4}-\d{2}-\d{2}$/.test(follow)) return json({ error: 'Follow-up must be a date.' }, 400);
  const summary = String(body.summary || '').trim().slice(0, 8000);
  if (!summary) return json({ error: 'Summarize the communication.' }, 400);
  let visibility = String(body.visibility || 'admin');
  if (!['admin', 'team', 'client_eligible'].includes(visibility)) visibility = 'admin';

  const res = await env.DB.prepare(
    `INSERT INTO case_comms (case_no, comm_type, at_date, at_time, person, summary,
       follow_up_date, visibility, author_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(caseNo, type, date, time || null,
          String(body.person || '').trim().slice(0, 200) || null, summary,
          follow || null, visibility, user.id, nowIso()).run();
  return json({ ok: true, id: res.meta ? res.meta.last_row_id : null }, 201);
}

/* Follow-up tasks (HANDOFF priority 19). Admin-created case to-dos. A task
   assigned to an investigator is the office choosing to tell them — that
   assignment is the only way a task ever reaches one, and marking their own
   task done is the only write they have. */
async function addTask(request, env, user, caseNo) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
  const body = await readJson(request);
  const task = String(body.task || '').trim().slice(0, 500);
  if (!task) return json({ error: 'Say what needs doing.' }, 400);
  const due = String(body.due_date || '').slice(0, 10);
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return json({ error: 'Due date must be a date.' }, 400);
  let priority = String(body.priority || 'normal');
  if (!['low', 'normal', 'high', 'urgent'].includes(priority)) priority = 'normal';
  let assigned = null;
  if (body.assigned_to !== null && body.assigned_to !== undefined && String(body.assigned_to) !== '') {
    assigned = parseInt(body.assigned_to, 10);
    if (!Number.isInteger(assigned)) return json({ error: 'Pick a person, or leave it with the office.' }, 400);
    const u = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND active = 1').bind(assigned).first();
    if (!u) return json({ error: 'Pick an active person.' }, 400);
  }
  const res = await env.DB.prepare(
    `INSERT INTO case_tasks (case_no, task, assigned_to, due_date, priority, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(caseNo, task, assigned, due || null, priority, user.id, nowIso()).run();
  return json({ ok: true, id: res.meta ? res.meta.last_row_id : null }, 201);
}

async function setTaskStatus(request, env, user, caseNo, taskId) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const t = await env.DB.prepare(
    'SELECT id, assigned_to, status FROM case_tasks WHERE id = ? AND case_no = ?')
    .bind(taskId, caseNo).first();
  if (!t) return json({ error: 'not found' }, 404);
  const status = String((await readJson(request)).status || '');
  if (!['open', 'done', 'cancelled'].includes(status)) return json({ error: 'open, done or cancelled.' }, 400);
  if (user.role !== 'admin') {
    // Their own task, and the only transition the field needs: finished it.
    if (t.assigned_to !== user.id) return json({ error: 'not found' }, 404);
    if (status !== 'done') return json({ error: 'You can mark your task done — the office decides the rest.' }, 403);
  }
  const closing = status !== 'open';
  await env.DB.prepare(
    `UPDATE case_tasks SET status = ?, done_by = ?, done_at = ? WHERE id = ?`)
    .bind(status, closing ? user.id : null, closing ? nowIso() : null, taskId).run();
  return json({ ok: true });
}


/* ------------------------------------------------------------- invoicing */

/* The invoice system (INVOICING.md). The portal is the operational record;
   BILL collects the money. Everything here is admin-only — an investigator
   never sees a client invoice, an amount, or a payment status. Totals are
   computed from lines and payments on read so they cannot drift, and every
   consequential action lands in invoice_events with who and when. */

const INVOICE_STATUSES = ['draft', 'ready', 'sent_to_bill', 'sent_to_client', 'partially_paid', 'paid', 'void'];
const PAYMENT_METHODS = ['ach', 'card', 'check', 'wire', 'other'];
const BILLING_PROVIDERS = ['manual', 'bill', 'stripe', 'quickbooks', 'other'];
/* MASTER §28's insurance list. `special_instructions` is a carrier's own
   billing instruction — "submit through the vendor portal", "reference the PO
   on every page" — so it rides with the references but prints as a paragraph,
   not as a reference row. */
const INVOICE_REF_KEYS = ['claim_number', 'policy_number', 'insured', 'claimant', 'date_of_loss',
  'client_reference', 'po_number', 'authorization_number', 'vendor_number', 'service_dates',
  'assignment_type', 'adjuster', 'special_instructions'];

const BILLING_DEFAULTS = {
  company_name: 'Always Precise Investigations, LLC',
  company_line: 'Va DCJS #11-9159 · (434) 907-0975',
  invoice_prefix: 'API-INV',
  terms_insurance: 'Net 30',
  terms_private: 'Due on receipt',
  payment_instructions: 'Please remit payment according to the electronic payment instructions provided with this invoice.',
  invoice_footer: 'Thank you for choosing Always Precise Investigations. Please reference the invoice number and claim number with payment.',
};

async function billingSettings(env) {
  const out = { ...BILLING_DEFAULTS };
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM app_config WHERE key LIKE 'billing_%'").all();
  for (const r of results || []) {
    const k = r.key.replace(/^billing_/, '');
    if (k in out) out[k] = r.value;
  }
  return out;
}

async function invoiceEvent(env, invoiceId, user, action, detail) {
  await env.DB.prepare(
    'INSERT INTO invoice_events (invoice_id, action, detail, user_id, at) VALUES (?, ?, ?, ?, ?)')
    .bind(invoiceId, action, detail || null, user ? user.id : null, nowIso()).run();
}

/* Server-side, sequential, unique, never the database id. API-INV-2026-0001. */
async function nextInvoiceNo(env) {
  const cfg = await billingSettings(env);
  const year = nowIso().slice(0, 4);
  const row = await env.DB.prepare(
    'SELECT invoice_no FROM invoices WHERE invoice_no LIKE ? ORDER BY invoice_no DESC LIMIT 1')
    .bind(`${cfg.invoice_prefix}-${year}-%`).first();
  const last = row ? parseInt(row.invoice_no.slice(row.invoice_no.lastIndexOf('-') + 1), 10) : 0;
  return `${cfg.invoice_prefix}-${year}-${String((Number.isFinite(last) ? last : 0) + 1).padStart(4, '0')}`;
}

function invoiceMoney(lines, adjustments, payments) {
  const subtotal = Math.round((lines || []).reduce((t, l) => t + Number(l.amount || 0), 0) * 100) / 100;
  const total = Math.round((subtotal + Number(adjustments || 0)) * 100) / 100;
  const paid = Math.round((payments || []).reduce((t, pm) => t + Number(pm.amount || 0), 0) * 100) / 100;
  return { subtotal, total, amount_paid: paid, balance_due: Math.round((total - paid) * 100) / 100 };
}

/* Overdue is a fact about today, computed on read — never stored where it
   could go stale. Void never reads as overdue. */
function invoiceDisplayStatus(inv, money) {
  if (inv.status === 'void') return 'void';
  if (money.balance_due <= 0 && money.total > 0 && money.amount_paid > 0) return 'paid';
  if (money.amount_paid > 0 && money.balance_due > 0) return 'partially_paid';
  if (inv.due_date && inv.due_date < nowIso().slice(0, 10) && money.balance_due > 0
      && inv.status !== 'draft') return 'overdue';
  return inv.status;
}

/* MASTER §28's private list — Retainer, Amount Applied, Additional
   Authorization, Balance. Derived on read like every other total here, so a
   second invoice on the same case cannot leave a stale figure behind: the
   retainer draws down across ALL of a case's live invoices, not just this one.

   A negative balance is not an error — it is the case having run past the
   retainer, which is exactly the moment the office needs to see it. */
async function retainerBlock(env, inv) {
  if (inv.invoice_type !== 'private') return null;
  const ret = await env.DB.prepare(
    'SELECT retainer_amount, received FROM case_retainer WHERE case_no = ?').bind(inv.case_no).first();
  const amount = ret && ret.retainer_amount != null ? Number(ret.retainer_amount) : PERSONAL.retainer;
  const { results: sib } = await env.DB.prepare(
    `SELECT i.id, i.adjustments FROM invoices i WHERE i.case_no = ? AND i.status != 'void'`)
    .bind(inv.case_no).all();
  /* "Applied" is WORK billed against the deposit — so the invoice that bills
     the deposit itself is excluded (audit, 2026-08-14). Counting it made the
     retainer consume itself: the client's own document read "Applied $1,500 ·
     Remaining $0" on the very invoice asking for it. */
  let applied = 0;
  for (const s of sib || []) {
    const isRetainer = await env.DB.prepare(
      'SELECT 1 AS x FROM invoice_retainer WHERE invoice_id = ?').bind(s.id).first();
    if (isRetainer) continue;
    const row = await env.DB.prepare(
      'SELECT COALESCE(SUM(amount), 0) AS t FROM invoice_lines WHERE invoice_id = ?').bind(s.id).first();
    applied += Number((row && row.t) || 0) + Number(s.adjustments || 0);
  }
  applied = Math.round(applied * 100) / 100;
  const meta = await env.DB.prepare(
    'SELECT authorized_budget FROM case_meta WHERE case_no = ?').bind(inv.case_no).first();
  const budget = meta && meta.authorized_budget != null ? Number(meta.authorized_budget) : null;
  return {
    amount,
    received: !!(ret && ret.received),
    applied,
    balance: Math.round((amount - applied) * 100) / 100,
    // Only "additional" when it is genuinely above the retainer.
    additional_authorized: budget != null && budget > amount
      ? Math.round((budget - amount) * 100) / 100 : null,
  };
}

async function invoiceWithMoney(env, inv) {
  const { results: lines } = await env.DB.prepare(
    'SELECT id, sort, description, qty, rate, amount FROM invoice_lines WHERE invoice_id = ? ORDER BY sort, id')
    .bind(inv.id).all();
  const { results: payments } = await env.DB.prepare(
    `SELECT p.id, p.amount, p.paid_date, p.method, p.reference, p.provider,
            p.external_payment_id, p.notes, p.recorded_at, u.display_name AS recorded_by
       FROM invoice_payments p LEFT JOIN users u ON u.id = p.recorded_by
      WHERE p.invoice_id = ? ORDER BY p.paid_date, p.id`).bind(inv.id).all();
  const money = invoiceMoney(lines, inv.adjustments, payments);
  let refs = {};
  try { refs = JSON.parse(inv.refs_json || '{}'); } catch { refs = {}; }
  return { ...inv, refs_json: undefined, refs, lines: lines || [], payments: payments || [],
           ...money, retainer: await retainerBlock(env, inv),
           display_status: invoiceDisplayStatus(inv, money) };
}

/* What an invoice must carry before the office can call it Ready. Insurance
   gaps that a carrier's AP desk usually wants are warnings, not blocks —
   different carriers need different references. */
function invoiceReadyProblems(inv, lines) {
  const problems = [];
  if (!inv.bill_to || !String(inv.bill_to).trim()) problems.push('who the invoice bills to');
  if (!inv.issue_date) problems.push('an issue date');
  if (!(lines && lines.length)) problems.push('at least one line item');
  if (!inv.due_date && !(inv.payment_terms && String(inv.payment_terms).trim())) {
    problems.push('a due date or payment terms');
  }
  if (!inv.billing_email && !String(inv.bill_to || '').trim()) problems.push('a billing destination');
  return problems;
}

function invoiceWarnings(inv) {
  if (inv.invoice_type !== 'insurance') return [];
  let refs = {};
  try { refs = typeof inv.refs === 'object' && inv.refs ? inv.refs : JSON.parse(inv.refs_json || '{}'); }
  catch { refs = {}; }
  const wanted = [['claim_number', 'claim number'], ['adjuster', 'adjuster'],
                  ['po_number', 'PO number'], ['authorization_number', 'authorization number'],
                  ['vendor_number', 'vendor number']];
  return wanted.filter(([k]) => !refs[k]).map(([, label]) => `no ${label} on the invoice`);
}

/* CREATE INVOICE from the case: pre-pulls what the case already knows, and
   nothing sends anywhere. A possible duplicate warns and requires the
   admin's explicit confirmation — supplemental invoices are legitimate. */
async function createInvoice(request, env, user, caseNo) {
  const sub = await env.DB.prepare('SELECT * FROM submissions WHERE case_no = ?').bind(caseNo).first();
  if (!sub) return json({ error: 'not found' }, 404);
  const body = await readJson(request);

  const dup = await env.DB.prepare(
    "SELECT invoice_no FROM invoices WHERE case_no = ? AND status != 'void' LIMIT 1").bind(caseNo).first();
  if (dup && body.confirm_duplicate !== true) {
    return json({ error: `Possible duplicate — ${dup.invoice_no} already bills this case. Confirm to create a supplemental invoice.`,
                  possible_duplicate: dup.invoice_no }, 409);
  }

  let payload = {};
  try { payload = JSON.parse(sub.payload || '{}'); } catch { payload = {}; }
  const type = sub.kind === 'claims' ? 'insurance' : 'private';
  const cfg = await billingSettings(env);

  const billTo = type === 'insurance'
    ? [sub.carrier || payload.carrier, payload.adjuster ? `Attn: ${payload.adjuster}` : 'Attn: Billing Department']
        .filter(Boolean).join('\n')
    : (sub.client_name || payload.client_name || '');
  const refs = {};
  if (type === 'insurance') {
    for (const [k, v] of [['claim_number', sub.claim_number || payload.claim_number],
                          ['policy_number', payload.policy_number],
                          ['claimant', payload.subject_name],
                          ['date_of_loss', payload.date_of_loss],
                          ['adjuster', payload.adjuster]]) {
      if (v) refs[k] = String(v).slice(0, 200);
    }
  }

  const invoiceNo = await nextInvoiceNo(env);
  const now = nowIso();
  const res = await env.DB.prepare(
    `INSERT INTO invoices (invoice_no, case_no, invoice_type, status, issue_date, payment_terms,
       bill_to, billing_email, refs_json, created_by, created_at, updated_by, updated_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(invoiceNo, caseNo, type, now.slice(0, 10),
          type === 'insurance' ? cfg.terms_insurance : cfg.terms_private,
          billTo || null,
          (type === 'insurance' ? (payload.billing_email || payload.adjuster_email) : (sub.client_email || payload.client_email)) || null,
          JSON.stringify(refs), user.id, now, user.id, now).run();
  const id = res.meta ? res.meta.last_row_id : null;

  /* CREATE FROM AUTHORIZATION: an insurance case whose authorized hours match
     a block bills as that flat package — one line, no per-hour arithmetic. A
     private case's opening request is the retainer, never a surcharge. */
  if (body.from_authorization === true) {
    if (type === 'insurance') {
      const meta = await env.DB.prepare(
        'SELECT authorized_hours FROM case_meta WHERE case_no = ?').bind(caseNo).first();
      const hours = meta ? Number(meta.authorized_hours) : null;
      const pkg = hours != null ? RATES.packages.find(pk => pk.hours === hours) : null;
      if (pkg) {
        await env.DB.prepare(
          `INSERT INTO invoice_lines (invoice_id, sort, description, qty, rate, amount)
           VALUES (?, 0, ?, 1, NULL, ?)`)
          .bind(id, `${pkg.hours}-Hour Surveillance Authorization`, pkg.price).run();
      } else if (hours) {
        await env.DB.prepare(
          `INSERT INTO invoice_lines (invoice_id, sort, description, qty, rate, amount)
           VALUES (?, 0, ?, ?, ?, ?)`)
          .bind(id, 'Authorized Surveillance', hours, RATES.surveillance.standard,
                Math.round(hours * RATES.surveillance.standard * 100) / 100).run();
      }
    } else {
      /* The case's OWN agreed retainer, not the firm default — an admin can
         set a different one, and `retainerBlock` already reads that figure,
         so billing the default made the invoice contradict the block printed
         directly beneath it (audit, 2026-08-14). */
      const ret = await env.DB.prepare(
        'SELECT retainer_amount FROM case_retainer WHERE case_no = ?').bind(caseNo).first();
      const retAmount = ret && ret.retainer_amount != null
        ? Number(ret.retainer_amount) : PERSONAL.retainer;
      await env.DB.prepare(
        `INSERT INTO invoice_lines (invoice_id, sort, description, qty, rate, amount)
         VALUES (?, 0, 'Investigation Retainer', 1, NULL, ?)`)
        .bind(id, retAmount).run();
      // Mark it, so the deposit is never counted as work against itself.
      await env.DB.prepare(
        'INSERT OR IGNORE INTO invoice_retainer (invoice_id, amount, at) VALUES (?, ?, ?)')
        .bind(id, retAmount, nowIso()).run();
      await env.DB.prepare('UPDATE invoices SET client_notes = ? WHERE id = ?')
        .bind('Retainer is applied toward authorized investigative services.', id).run();
    }
  }

  await invoiceEvent(env, id, user, 'created', `${invoiceNo} for ${caseNo}`);
  const inv = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  return json({ ok: true, invoice: await invoiceWithMoney(env, inv) }, 201);
}

async function listInvoices(request, env) {
  const q = new URL(request.url).searchParams;
  const rows = (await env.DB.prepare(
    'SELECT * FROM invoices ORDER BY id DESC LIMIT 500').all()).results || [];
  const full = [];
  for (const r of rows) full.push(await invoiceWithMoney(env, r));

  const today = nowIso().slice(0, 10);
  const soonCut = new Date(Date.parse(today) + 14 * 86400000).toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const live = full.filter(i => i.status !== 'void');
  const summary = {
    outstanding: Math.round(live.filter(i => i.status !== 'draft')
      .reduce((t, i) => t + Math.max(0, i.balance_due), 0) * 100) / 100,
    due_soon: live.filter(i => i.display_status !== 'paid' && i.status !== 'draft'
      && i.due_date && i.due_date >= today && i.due_date <= soonCut).length,
    overdue: live.filter(i => i.display_status === 'overdue').length,
    paid_this_month: Math.round(full.reduce((t, i) => t + i.payments
      .filter(pm => String(pm.paid_date || '').slice(0, 7) === month)
      .reduce((x, pm) => x + Number(pm.amount || 0), 0), 0) * 100) / 100,
    drafts: full.filter(i => i.status === 'draft').length,
  };

  let out = full;
  const status = q.get('status'), type = q.get('type'), text = (q.get('q') || '').toLowerCase();
  if (status) out = out.filter(i => i.display_status === status || i.status === status);
  if (type) out = out.filter(i => i.invoice_type === type);
  if (text) out = out.filter(i => [i.invoice_no, i.case_no, i.bill_to, i.refs.claim_number]
    .some(v => String(v || '').toLowerCase().includes(text)));
  return json({ invoices: out, summary, settings: await billingSettings(env) });
}

async function editInvoice(request, env, user, id) {
  const inv = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  if (!inv) return json({ error: 'not found' }, 404);
  if (inv.status === 'void') return json({ error: 'A void invoice keeps its record — create a new one instead.' }, 400);
  const body = await readJson(request);

  /* Past ready, the financial content is settled: only internal notes and the
     provider bookkeeping stay editable. Corrections after sending are an
     adjustment or a void, both on the record. */
  const locked = !['draft', 'ready'].includes(inv.status);
  const fields = {};
  const take = (k, cap) => {
    if (body[k] === undefined) return;
    fields[k] = body[k] === null ? null : String(body[k]).trim().slice(0, cap) || null;
  };
  take('internal_notes', 4000);
  if (!locked) {
    take('bill_to', 600); take('billing_email', 200); take('client_notes', 2000);
    take('issue_date', 10); take('due_date', 10); take('payment_terms', 100);
    for (const d of ['issue_date', 'due_date']) {
      if (fields[d] && !/^\d{4}-\d{2}-\d{2}$/.test(fields[d])) return json({ error: 'Dates are YYYY-MM-DD.' }, 400);
    }
    if (body.adjustments !== undefined) {
      const adj = Number(body.adjustments);
      if (!Number.isFinite(adj)) return json({ error: 'Adjustments must be a number.' }, 400);
      fields.adjustments = adj;
    }
    if (body.refs !== undefined && typeof body.refs === 'object' && body.refs) {
      const refs = {};
      for (const k of INVOICE_REF_KEYS) {
        const v = body.refs[k];
        if (v !== undefined && v !== null && String(v).trim()) refs[k] = String(v).trim().slice(0, 200);
      }
      fields.refs_json = JSON.stringify(refs);
    }
  }
  if (!Object.keys(fields).length) return json({ error: locked
    ? 'This invoice is past editing — only internal notes can change.' : 'Nothing to change.' }, 400);

  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  await env.DB.prepare(`UPDATE invoices SET ${sets}, updated_by = ?, updated_at = ? WHERE id = ?`)
    .bind(...Object.values(fields), user.id, nowIso(), id).run();
  await invoiceEvent(env, id, user, 'edited', Object.keys(fields).join(', '));
  const after = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  return json({ ok: true, invoice: await invoiceWithMoney(env, after) });
}

async function replaceInvoiceLines(request, env, user, id) {
  const inv = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  if (!inv) return json({ error: 'not found' }, 404);
  if (!['draft', 'ready'].includes(inv.status)) {
    return json({ error: 'Lines are settled once an invoice leaves the office — adjust or void instead.' }, 400);
  }
  const body = await readJson(request);
  const given = Array.isArray(body.lines) ? body.lines.slice(0, 50) : null;
  if (!given || !given.length) return json({ error: 'An invoice needs at least one line item.' }, 400);
  const clean = [];
  for (const [i, l] of given.entries()) {
    const description = String(l.description || '').trim().slice(0, 300);
    if (!description) return json({ error: `Line ${i + 1} needs a description.` }, 400);
    const qty = l.qty === undefined || l.qty === null || String(l.qty).trim() === '' ? 1 : Number(l.qty);
    const rate = l.rate === undefined || l.rate === null || String(l.rate).trim() === '' ? null : Number(l.rate);
    if (!Number.isFinite(qty) || (rate !== null && !Number.isFinite(rate))) {
      return json({ error: `Line ${i + 1}: quantity and rate must be numbers.` }, 400);
    }
    const amount = l.amount === undefined || l.amount === null || String(l.amount).trim() === ''
      ? (rate !== null ? Math.round(qty * rate * 100) / 100 : null) : Number(l.amount);
    if (amount === null || !Number.isFinite(amount)) {
      return json({ error: `Line ${i + 1} needs an amount (or a rate to compute one).` }, 400);
    }
    clean.push({ sort: i, description, qty, rate, amount: Math.round(amount * 100) / 100 });
  }
  await env.DB.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').bind(id).run();
  for (const l of clean) {
    await env.DB.prepare(
      'INSERT INTO invoice_lines (invoice_id, sort, description, qty, rate, amount) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, l.sort, l.description, l.qty, l.rate, l.amount).run();
  }
  await env.DB.prepare('UPDATE invoices SET updated_by = ?, updated_at = ? WHERE id = ?')
    .bind(user.id, nowIso(), id).run();
  await invoiceEvent(env, id, user, 'lines_replaced', `${clean.length} line(s)`);
  const after = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  return json({ ok: true, invoice: await invoiceWithMoney(env, after) });
}

async function setInvoiceStatus(request, env, user, id) {
  const inv = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  if (!inv) return json({ error: 'not found' }, 404);
  const body = await readJson(request);
  const status = String(body.status || '');
  if (!INVOICE_STATUSES.includes(status)) return json({ error: 'invalid status' }, 400);
  if (status === 'paid' || status === 'partially_paid') {
    return json({ error: 'Payment status comes from recorded payments, never from a button.' }, 400);
  }
  if (inv.status === 'void') return json({ error: 'A void invoice stays void.' }, 400);

  if (status === 'ready') {
    const { results: lines } = await env.DB.prepare(
      'SELECT id FROM invoice_lines WHERE invoice_id = ?').bind(id).all();
    const problems = invoiceReadyProblems(inv, lines);
    if (problems.length) return json({ error: 'Not ready yet — it still needs ' + problems.join(', ') + '.' }, 400);
  }
  if (status === 'sent_to_bill') {
    if (!['ready', 'sent_to_bill'].includes(inv.status)) {
      return json({ error: 'Review it to Ready before it goes to BILL.' }, 400);
    }
  }
  if (status === 'sent_to_client' && !['ready', 'sent_to_bill', 'sent_to_client'].includes(inv.status)) {
    return json({ error: 'Only a reviewed invoice is ever sent.' }, 400);
  }

  const sets = ['status = ?', 'updated_by = ?', 'updated_at = ?'];
  const binds = [status, user.id, nowIso()];
  if (status === 'sent_to_bill') { sets.push('sent_to_bill_at = ?', "billing_provider = 'bill'"); binds.push(nowIso()); }
  binds.push(id);
  await env.DB.prepare(`UPDATE invoices SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  await invoiceEvent(env, id, user, status === 'void' ? 'voided' : `status_${status}`, null);
  const after = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  const out = await invoiceWithMoney(env, after);
  return json({ ok: true, invoice: out, warnings: status === 'ready' ? invoiceWarnings(out) : [] });
}

async function setInvoiceBillRefs(request, env, user, id) {
  const inv = await env.DB.prepare('SELECT id, status FROM invoices WHERE id = ?').bind(id).first();
  if (!inv) return json({ error: 'not found' }, 404);
  if (inv.status === 'void') return json({ error: 'A void invoice stays void.' }, 400);
  const body = await readJson(request);
  const provider = BILLING_PROVIDERS.includes(String(body.billing_provider || '')) ? body.billing_provider : 'bill';
  const g = k => body[k] === undefined || body[k] === null ? null : String(body[k]).trim().slice(0, 120) || null;
  await env.DB.prepare(
    `UPDATE invoices SET billing_provider = ?, external_invoice_id = ?, external_customer_id = ?,
        external_status = ?, last_synced_at = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
    .bind(provider, g('external_invoice_id'), g('external_customer_id'), g('external_status'),
          nowIso(), user.id, nowIso(), id).run();
  await invoiceEvent(env, id, user, 'bill_ref_added',
    [g('external_invoice_id'), g('external_status')].filter(Boolean).join(' · ') || null);
  const after = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  return json({ ok: true, invoice: await invoiceWithMoney(env, after) });
}

async function recordInvoicePayment(request, env, user, id) {
  const inv = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  if (!inv) return json({ error: 'not found' }, 404);
  if (inv.status === 'void') return json({ error: 'A void invoice takes no payments.' }, 400);
  if (inv.status === 'draft') return json({ error: 'Review the draft before recording payments against it.' }, 400);
  const body = await readJson(request);
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'Payment amount must be a positive number.' }, 400);
  const date = String(body.paid_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'Date the payment (YYYY-MM-DD).' }, 400);
  const method = PAYMENT_METHODS.includes(String(body.method || '')) ? body.method : 'other';
  const provider = BILLING_PROVIDERS.includes(String(body.provider || '')) ? body.provider : 'manual';
  await env.DB.prepare(
    `INSERT INTO invoice_payments (invoice_id, amount, paid_date, method, reference, provider,
       external_payment_id, notes, recorded_by, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, Math.round(amount * 100) / 100, date, method,
          String(body.reference || '').trim().slice(0, 120) || null, provider,
          String(body.external_payment_id || '').trim().slice(0, 120) || null,
          String(body.notes || '').trim().slice(0, 1000) || null, user.id, nowIso()).run();

  /* Payment status is arithmetic, never a claim: the stored status moves to
     paid only when the balance actually reaches zero. */
  const out = await invoiceWithMoney(env, inv);
  const newStatus = out.balance_due <= 0 ? 'paid' : 'partially_paid';
  await env.DB.prepare('UPDATE invoices SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?')
    .bind(newStatus, user.id, nowIso(), id).run();
  await invoiceEvent(env, id, user, 'payment_recorded', `$${amount} ${method}` + (newStatus === 'paid' ? ' — PAID IN FULL' : ''));
  const after = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  return json({ ok: true, invoice: await invoiceWithMoney(env, after) });
}


/* ------------------------------------------------------------- evidence */

/* Evidence storage (HANDOFF priority 6), with the free-plan failsafe the
   owner asked for. Cloudflare has no spend cap, so the Worker IS the cap:
   uploads are refused outright before the account could ever owe a cent —
   at 9 GB of the free tier's 10 GB (headroom for metering drift), at 75 MB
   per file (inside the Workers request and memory ceilings), and at a
   monthly upload count no honest month approaches (the Class-A failsafe).
   The limits are env-overridable so the tests exercise the refusals with
   real uploads instead of trusting arithmetic. */
const STORAGE = {
  freeTierBytes: 10 * 1024 ** 3,
  hardCapBytes: 9 * 1024 ** 3,
  warnPct: 75,
  maxFileBytes: 75 * 1024 * 1024,
  maxUploadsPerMonth: 50000,
};

function storageLimits(env) {
  const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };
  return {
    freeTierBytes: n(env.STORAGE_FREE_TIER, STORAGE.freeTierBytes),
    hardCapBytes: n(env.STORAGE_HARD_CAP, STORAGE.hardCapBytes),
    maxFileBytes: n(env.STORAGE_MAX_FILE, STORAGE.maxFileBytes),
    maxUploadsPerMonth: n(env.STORAGE_MAX_UPLOADS, STORAGE.maxUploadsPerMonth),
  };
}

async function evidenceUsage(env) {
  const lim = storageLimits(env);
  const row = await env.DB.prepare(
    'SELECT COALESCE(SUM(size_bytes), 0) AS b FROM case_evidence WHERE deleted_at IS NULL').first();
  const up = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM case_evidence WHERE uploaded_at LIKE ?')
    .bind(nowIso().slice(0, 7) + '%').first();
  const bytes = Number(row && row.b) || 0;
  return {
    bytes_used: bytes,
    hard_cap_bytes: lim.hardCapBytes,
    free_tier_bytes: lim.freeTierBytes,
    percent_of_free: Math.round((bytes / lim.freeTierBytes) * 1000) / 10,
    warn_at: STORAGE.warnPct,
    uploads_this_month: Number(up && up.n) || 0,
    max_file_bytes: lim.maxFileBytes,
  };
}

const EVIDENCE_CLASSES = ['client_deliverable', 'internal_only', 'do_not_use', 'needs_review', 'needs_redaction'];

async function uploadEvidence(request, env, user, caseNo) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  if (!env.EVIDENCE) {
    return json({ error: 'Evidence storage is not attached yet — run the R2 setup workflow, then redeploy the Worker.' }, 503);
  }
  let form;
  try { form = await request.formData(); } catch { return json({ error: 'Send the file as multipart form data.' }, 400); }
  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.size) return json({ error: 'Attach a file.' }, 400);

  const lim = storageLimits(env);
  if (file.size > lim.maxFileBytes) {
    return json({ error: `That file is ${(file.size / 1048576).toFixed(1)} MB and the per-file limit is `
      + `${Math.floor(lim.maxFileBytes / 1048576)} MB. Split long video into parts before uploading.` }, 413);
  }
  const usage = await evidenceUsage(env);
  if (usage.uploads_this_month >= lim.maxUploadsPerMonth) {
    return json({ error: 'The monthly upload failsafe is reached — nothing else uploads this month.' }, 429);
  }
  if (usage.bytes_used + file.size > lim.hardCapBytes) {
    return json({ error: 'The free-plan failsafe: this upload would push evidence storage past the line that '
      + 'keeps the account inside the free tier, so it was refused — nothing can bill. An admin can clear '
      + 'delivered footage (deletes are audited) to make room.', code: 'storage_cap',
      usage }, 507);
  }

  const filename = String(file.name || 'file').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) || 'file';
  /* Owner's decision, 2026-08-14: the firm shoots its own footage and writes
     its own reports, so evidence should be usable in the report and the client
     package the moment it is uploaded rather than waiting behind a review it
     would only ever give itself. The default is therefore client-deliverable.
     The classifications all still exist — Needs redaction, Internal only, Do
     not use are how you HOLD something back — but holding back is now the
     deliberate act, not the default. If outside investigators are ever engaged,
     flip this default and the review gate returns. */
  const asked = String(form.get('classification') || '');
  const classification = EVIDENCE_CLASSES.includes(asked) ? asked : 'client_deliverable';
  const note = String(form.get('note') || '').trim().slice(0, 1000) || null;

  /* A photo can ride with a subject and a clip with the activity moment it
     documents — but only this case's. A link to another case's row is
     refused, not silently dropped, so a mis-tap is visible. */
  let entryId = parseInt(form.get('entry_id'), 10);
  let subjectId = parseInt(form.get('subject_id'), 10);
  if (Number.isInteger(entryId)) {
    const e = await env.DB.prepare('SELECT id FROM activity_log WHERE id = ? AND case_no = ?')
      .bind(entryId, caseNo).first();
    if (!e) return json({ error: 'That activity entry is not on this case.' }, 400);
  } else entryId = null;
  if (Number.isInteger(subjectId)) {
    const sj = await env.DB.prepare('SELECT id FROM case_subjects WHERE id = ? AND case_no = ?')
      .bind(subjectId, caseNo).first();
    if (!sj) return json({ error: 'That subject is not on this case.' }, 400);
  } else subjectId = null;

  // A unique key per upload: an original can never be overwritten.
  const key = `cases/${caseNo}/${crypto.randomUUID()}-${filename}`;
  await env.EVIDENCE.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });
  const now = nowIso();
  const res = await env.DB.prepare(
    `INSERT INTO case_evidence (case_no, r2_key, filename, content_type, size_bytes, classification,
       entry_id, subject_id, note, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(caseNo, key, filename, file.type || null, file.size, classification,
          entryId, subjectId, note, user.id, now).run();
  return json({ ok: true, id: res.meta ? res.meta.last_row_id : null,
                usage: await evidenceUsage(env) }, 201);
}

async function serveEvidence(env, user, caseNo, eid) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  if (!env.EVIDENCE) return json({ error: 'Evidence storage is not attached.' }, 503);
  const row = await env.DB.prepare(
    'SELECT r2_key, filename, content_type, deleted_at FROM case_evidence WHERE id = ? AND case_no = ?')
    .bind(eid, caseNo).first();
  if (!row || row.deleted_at) return json({ error: 'not found' }, 404);
  const obj = await env.EVIDENCE.get(row.r2_key);
  if (!obj) return json({ error: 'The stored object is missing from the bucket.' }, 404);
  return new Response(obj.body, { status: 200, headers: {
    'Content-Type': row.content_type || 'application/octet-stream',
    'Content-Disposition': `inline; filename="${row.filename.replace(/"/g, '')}"`,
    'Cache-Control': 'private, no-store',
  } });
}

async function editEvidence(request, env, user, caseNo, eid) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
  const row = await env.DB.prepare(
    'SELECT id, deleted_at FROM case_evidence WHERE id = ? AND case_no = ?').bind(eid, caseNo).first();
  if (!row) return json({ error: 'not found' }, 404);
  if (row.deleted_at) return json({ error: 'Deleted evidence keeps its record and takes no edits.' }, 400);
  const body = await readJson(request);
  const sets = [], binds = [];
  if (body.classification !== undefined) {
    if (!EVIDENCE_CLASSES.includes(String(body.classification))) return json({ error: 'Pick a real classification.' }, 400);
    sets.push('classification = ?', 'classified_by = ?', 'classified_at = ?');
    binds.push(body.classification, user.id, nowIso());
  }
  if (body.note !== undefined) { sets.push('note = ?'); binds.push(String(body.note || '').trim().slice(0, 1000) || null); }
  if (!sets.length) return json({ error: 'Nothing to change.' }, 400);
  binds.push(eid);
  await env.DB.prepare(`UPDATE case_evidence SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return json({ ok: true });
}

async function deleteEvidence(env, user, caseNo, eid) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
  const row = await env.DB.prepare(
    'SELECT r2_key, deleted_at FROM case_evidence WHERE id = ? AND case_no = ?').bind(eid, caseNo).first();
  if (!row) return json({ error: 'not found' }, 404);
  if (row.deleted_at) return json({ ok: true });
  if (env.EVIDENCE) await env.EVIDENCE.delete(row.r2_key);
  // The object goes; the record of it stays, with who removed it and when.
  await env.DB.prepare('UPDATE case_evidence SET deleted_by = ?, deleted_at = ? WHERE id = ?')
    .bind(user.id, nowIso(), eid).run();
  return json({ ok: true, usage: await evidenceUsage(env) });
}


/* ------------------------------------------------------------ case build */

/* The client package (CASEBUILD.md priority 0): an approved report plus
   selected client-deliverable photos, videos and attachments, previewed as
   one document and finalized behind hard gates. Admin-only in full. Dropbox
   is a PROVIDER, never the architecture — until the owner connects it, the
   provider reports not-configured and nothing here blocks. */

const EXTERNAL_PROVIDERS = {
  dropbox: {
    label: 'Dropbox',
    configured: env => Boolean(env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET && env.DROPBOX_REFRESH_TOKEN),
    note: 'Create a Dropbox app and add DROPBOX_APP_KEY, DROPBOX_APP_SECRET and '
        + 'DROPBOX_REFRESH_TOKEN as Worker secrets. Until then video delivery is arranged '
        + 'separately and nothing else waits.',
  },
};

async function buildEvent(env, buildId, user, action, detail) {
  await env.DB.prepare(
    'INSERT INTO build_events (build_id, action, detail, user_id, at) VALUES (?, ?, ?, ?, ?)')
    .bind(buildId, action, detail || null, user ? user.id : null, nowIso()).run();
}

async function latestApprovedReport(env, caseNo) {
  return await env.DB.prepare(
    `SELECT id, report_date, status FROM case_reports
      WHERE case_no = ? AND status IN ('approved', 'delivered')
      ORDER BY report_date DESC, id DESC LIMIT 1`).bind(caseNo).first();
}

/* Every approved day on the case, oldest first — the order a reader expects
   Day 1, Day 2, Day 3 to appear in. */
async function approvedReports(env, caseNo) {
  const { results } = await env.DB.prepare(
    `SELECT id, report_date, status, day_id FROM case_reports
      WHERE case_no = ? AND status IN ('approved', 'delivered')
      ORDER BY report_date ASC, id ASC`).bind(caseNo).all();
  return results || [];
}

/* MASTER §13 — a package carries the whole investigation. When a build is
   opened, every approved day is attached; the admin can drop one, and adding
   a later day is one click. Ordered by the day's own date, never by the order
   the office happened to approve them in. */
async function seedBuildReports(env, buildId, caseNo, user) {
  const reps = await approvedReports(env, caseNo);
  let n = 0;
  for (const r of reps) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO build_reports (build_id, report_id, sort, added_by, added_at)
       VALUES (?, ?, ?, ?, ?)`).bind(buildId, r.id, n++, user ? user.id : null, nowIso()).run();
  }
  return reps;
}

/* The reports actually in a package, with the day each one covers so the
   document can title its sections and total the hours. */
async function buildReports(env, buildId, caseNo) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.report_date, r.status, r.body, r.day_id, br.sort,
            u.display_name AS investigator,
            d.day_date, d.start_time, d.end_time, d.hours, d.miles, d.summary AS day_summary
       FROM build_reports br
       JOIN case_reports r ON r.id = br.report_id AND r.case_no = ?
       LEFT JOIN users u ON u.id = r.investigator_id
       LEFT JOIN case_days d ON d.id = r.day_id
      WHERE br.build_id = ?
      ORDER BY r.report_date ASC, br.sort ASC, r.id ASC`).bind(caseNo, buildId).all();
  return results || [];
}

/* Whether this build is the Custom package. Read from the marker table for
   the reason recorded above `build_custom` in schema.sql. */
async function isCustomBuild(env, buildId) {
  return Boolean(await env.DB.prepare('SELECT 1 AS x FROM build_custom WHERE build_id = ?')
    .bind(buildId).first());
}

/* Everything the build screen needs in one fetch: the current build, its
   items joined to their evidence, what is eligible to add, and the gates as
   they stand — so FINALIZE never surprises. */
async function buildState(env, caseNo) {
  const build = await env.DB.prepare(
    'SELECT * FROM case_builds WHERE case_no = ? ORDER BY version DESC, id DESC LIMIT 1')
    .bind(caseNo).first();

  const { results: evidence } = await env.DB.prepare(
    `SELECT e.id, e.filename, e.content_type, e.size_bytes, e.classification, e.entry_id,
            e.note, e.uploaded_at,
            CASE WHEN ar.entry_id IS NULL THEN a.at_time END AS entry_time,
            CASE WHEN ar.entry_id IS NULL THEN a.at_date END AS entry_date,
            /* A removed entry's text must not become an exhibit caption. The
               report already skips removed entries; the package borrowed the
               description straight off the join and did not. The photo itself
               is untouched — it was never removed — it simply stops speaking
               in the words of a line the office struck out. */
            CASE WHEN ar.entry_id IS NULL THEN a.description END AS entry_description
       FROM case_evidence e
       LEFT JOIN activity_log a ON a.id = e.entry_id
       LEFT JOIN activity_removed ar ON ar.entry_id = a.id
      WHERE e.case_no = ? AND e.deleted_at IS NULL ORDER BY e.id`).bind(caseNo).all();

  let items = [], report = null, gates = [], events = [];
  let reports = [], summary = '', custom = false;
  if (build) {
    ({ results: items } = await env.DB.prepare(
      `SELECT i.id, i.evidence_id, i.role, i.sort FROM build_items i
        WHERE i.build_id = ? ORDER BY i.role, i.sort, i.id`).bind(build.id).all());
    if (build.report_id) {
      report = await env.DB.prepare(
        'SELECT id, report_date, status, body FROM case_reports WHERE id = ? AND case_no = ?')
        .bind(build.report_id, caseNo).first();
    }
    reports = await buildReports(env, build.id, caseNo);
    custom = await isCustomBuild(env, build.id);
    const sum = await env.DB.prepare('SELECT body FROM build_summary WHERE build_id = ?')
      .bind(build.id).first();
    summary = (sum && sum.body) || '';
    gates = await buildGates(env, build, items || [], report, reports, custom);
    ({ results: events } = await env.DB.prepare(
      `SELECT e.action, e.detail, e.at, u.display_name AS who
         FROM build_events e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.build_id = ? ORDER BY e.id DESC LIMIT 30`).bind(build.id).all());
  }

  const { results: extRows } = await env.DB.prepare(
    `SELECT x.* FROM external_files x JOIN case_evidence e ON e.id = x.evidence_id
      WHERE e.case_no = ?`).bind(caseNo).all();

  // The mini-dashboard's billing block: enough to show state, nothing more.
  const { results: caseInvoices } = await env.DB.prepare(
    'SELECT id, invoice_no, status FROM invoices WHERE case_no = ? ORDER BY id DESC LIMIT 10')
    .bind(caseNo).all();

  /* The document's masthead (MASTER §13: "case information", "assignment
     objective"). Read here rather than leaned on from the workspace fetch so
     the package renders the same whether or not the case screen loaded it —
     the landing-vs-click rule, applied to a document. */
  const sub = await env.DB.prepare(
    `SELECT s.kind, s.service, s.subject_name, s.carrier, s.claim_number, s.payload,
            t.label AS case_type, cm.authorized_hours, u.display_name AS investigator
       FROM submissions s
       LEFT JOIN case_meta cm ON cm.case_no = s.case_no
       LEFT JOIN case_types t ON t.id = cm.case_type_id
       LEFT JOIN users u ON u.id = s.assigned_to
      WHERE s.case_no = ?`).bind(caseNo).first();
  let payload = {};
  try { payload = JSON.parse((sub && sub.payload) || '{}'); } catch { payload = {}; }
  const caseInfo = sub ? {
    kind: sub.kind, service: sub.service, case_type: sub.case_type,
    subject_name: sub.subject_name || payload.subject_name || '',
    carrier: sub.carrier || '', claim_number: sub.claim_number || '',
    investigator: sub.investigator || '', authorized_hours: sub.authorized_hours,
    objective: payload.objective || '', date_of_loss: payload.date_of_loss || '',
    claim_type: payload.claim_type || '', geographic_limits: payload.geographic_limits || '',
  } : null;

  /* Approved days not in the package — the admin adds a later day without
     rebuilding, and sees at a glance that one is missing. */
  const inPkg = new Set(reports.map(r => r.id));
  const available = (await approvedReports(env, caseNo)).filter(r => !inPkg.has(r.id));

  return {
    invoices: caseInvoices || [],
    build: build || null,
    report: report ? { id: report.id, report_date: report.report_date, status: report.status,
                       body: report.body } : null,
    reports,
    available_reports: available,
    summary,
    custom,
    package_type: build ? (custom ? 'custom' : build.package_type) : null,
    case_info: caseInfo,
    items: items || [],
    evidence: evidence || [],
    external_files: extRows || [],
    events: events || [],
    gates,
    approved_report: await latestApprovedReport(env, caseNo),
    providers: Object.fromEntries(Object.entries(EXTERNAL_PROVIDERS).map(([k, prov]) =>
      [k, { label: prov.label, configured: prov.configured(env), note: prov.note }])),
  };
}

/* The finalize gates, named plainly. Also used by the screen so the admin
   sees exactly what needs attention BEFORE pressing finalize. */
async function buildGates(env, build, items, report, reports, custom) {
  const gates = [];
  /* Multi-day: the package is judged on the SET of attached reports, not on
     the one `report_id` happens to point at. A build opened before this
     existed has no rows in build_reports, so fall back to the single report
     rather than inventing a gate on an old package. */
  const set = (reports && reports.length) ? reports
    : (report ? [report] : []);
  if (!set.length) {
    gates.push('No report is attached — approve a daily report first.');
  } else {
    for (const r of set) {
      if (!['approved', 'delivered'].includes(r.status)) {
        gates.push(`The report of ${r.report_date} is ${r.status} — it must be approved.`);
      }
    }
  }
  const ids = items.map(i => i.evidence_id);
  for (const it of items) {
    const e = await env.DB.prepare(
      'SELECT filename, classification, deleted_at FROM case_evidence WHERE id = ?')
      .bind(it.evidence_id).first();
    if (!e || e.deleted_at) { gates.push('A selected file has been deleted — remove it from the package.'); continue; }
    if (e.classification !== 'client_deliverable') {
      gates.push(`${e.filename} is ${e.classification.replace(/_/g, ' ')} — only client-deliverable material ships.`);
    }
  }
  if (ids.length) {
    const { results: failed } = await env.DB.prepare(
      `SELECT delivery_name FROM external_files
        WHERE evidence_id IN (${ids.map(() => '?').join(',')}) AND upload_status = 'failed'`)
      .bind(...ids).all();
    for (const f of failed || []) {
      gates.push(`External upload failed for ${f.delivery_name || 'a file'} — retry or remove it before finalizing.`);
    }
  }
  /* The Custom package is the admin saying "what I selected is what ships",
     so the type-based content gate does not apply to it. The
     client-deliverable gate above still does — Custom controls contents, not
     whether internal-only material can reach a client. */
  const videos = items.filter(i => i.role === 'video');
  if (!custom && videos.length && !['report_photos_video', 'full'].includes(build.package_type)) {
    gates.push('Videos are selected but the package type does not include video — switch the package or remove them.');
  }
  return gates;
}

async function adminBuild(env, user, buildId) {
  const b = await env.DB.prepare('SELECT * FROM case_builds WHERE id = ?').bind(buildId).first();
  return b || null;
}


/* MASTER §31 — the Completed Cases desk. "Do not bury completed cases in a
   difficult archive": one payload carrying every finished case and where its
   artifacts live, so the page offers Open case / Final report / Evidence /
   Client package / Invoice / Copy video link without a fetch per case.

   Completed means the WORK is done: the stage says complete or closed, or a
   finalized client package exists — a case can be finished before the office
   has administratively closed it, and that is exactly when someone goes
   looking for the report. Cancelled is deliberately absent: a cancelled case
   has no deliverables to find. */
async function completedCases(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.case_no, s.kind, s.client_name, s.subject_name, s.carrier, s.created_at,
            cs.stage, cs.set_at AS stage_at,
            b.id AS build_id, b.version AS build_version, b.package_type,
            b.finalized_at, b.delivered_at
       FROM submissions s
       LEFT JOIN case_status cs ON cs.case_no = s.case_no
       LEFT JOIN case_builds b ON b.id =
         (SELECT id FROM case_builds WHERE case_no = s.case_no AND status = 'finalized'
           ORDER BY version DESC, id DESC LIMIT 1)
      WHERE (cs.stage IN ('complete', 'closed') OR b.id IS NOT NULL)
        AND (cs.stage IS NULL OR cs.stage != 'cancelled')
      ORDER BY COALESCE(b.finalized_at, cs.set_at, s.created_at) DESC
      LIMIT 200`).all();

  const out = [];
  for (const c of results || []) {
    const reps = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM case_reports
        WHERE case_no = ? AND status IN ('approved', 'delivered')`).bind(c.case_no).first();
    const ev = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM case_evidence WHERE case_no = ? AND deleted_at IS NULL')
      .bind(c.case_no).first();
    const inv = await env.DB.prepare(
      `SELECT id, invoice_no, status FROM invoices
        WHERE case_no = ? AND status != 'void' ORDER BY id DESC LIMIT 1`).bind(c.case_no).first();
    const share = await env.DB.prepare(
      `SELECT x.external_share_url FROM external_files x
         JOIN case_evidence e ON e.id = x.evidence_id
        WHERE e.case_no = ? AND x.external_share_url IS NOT NULL
          AND x.share_revoked_at IS NULL AND x.upload_status = 'uploaded'
        ORDER BY x.id DESC LIMIT 1`).bind(c.case_no).first();
    out.push({
      ...c,
      approved_reports: Number(reps && reps.n) || 0,
      evidence_count: Number(ev && ev.n) || 0,
      invoice: inv || null,
      share_url: (share && share.external_share_url) || null,
    });
  }
  return json({ completed: out, server_now: nowIso() });
}

/* The dashboard's Case Package cards (UIBUILD P3): per active case, the
   state of every workflow module in one payload, so the page can draw the
   ring, the blocks and one computed NEXT STEP without a fetch per case. */
async function casePackages(env) {
  const { results: rows } = await env.DB.prepare(
    `SELECT s.case_no, s.kind, s.status, s.carrier, s.client_name, s.subject_name,
            st.stage, t.label AS case_type, u.display_name AS investigator,
            cm.authorized_hours, cm.authorized_budget
       FROM submissions s
       LEFT JOIN case_status st ON st.case_no = s.case_no
       LEFT JOIN case_meta cm ON cm.case_no = s.case_no
       LEFT JOIN case_types t ON t.id = cm.case_type_id
       LEFT JOIN users u ON u.id = s.assigned_to
      WHERE s.status != 'closed'
      ORDER BY s.created_at DESC LIMIT 24`).all();

  const packages = [];
  for (const c of rows || []) {
    const acts = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM activity_log WHERE case_no = ?').bind(c.case_no).first();
    const daysRow = await env.DB.prepare(
      `SELECT COALESCE(SUM(hours), 0) AS h, COUNT(*) AS n,
              SUM(CASE WHEN end_time IS NULL THEN 1 ELSE 0 END) AS open
         FROM case_days WHERE case_no = ?`).bind(c.case_no).first();
    const rep = await env.DB.prepare(
      `SELECT status FROM case_reports WHERE case_no = ?
        ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'delivered' THEN 0
                 WHEN 'submitted' THEN 1 ELSE 2 END, id DESC LIMIT 1`).bind(c.case_no).first();
    const ev = await env.DB.prepare(
      `SELECT SUM(CASE WHEN content_type LIKE 'image/%' THEN 1 ELSE 0 END) AS photos,
              SUM(CASE WHEN content_type LIKE 'video/%' THEN 1 ELSE 0 END) AS videos
         FROM case_evidence WHERE case_no = ? AND deleted_at IS NULL`).bind(c.case_no).first();
    const build = await env.DB.prepare(
      'SELECT status FROM case_builds WHERE case_no = ? ORDER BY version DESC, id DESC LIMIT 1')
      .bind(c.case_no).first();
    const invoice = await env.DB.prepare(
      "SELECT status FROM invoices WHERE case_no = ? AND status != 'void' ORDER BY id DESC LIMIT 1")
      .bind(c.case_no).first();
    let retainer = null;
    if (c.kind === 'consumer') {
      const auth = await authorizationFor(env, c.case_no, true);
      retainer = auth.retainer ? { amount: auth.retainer.amount, remaining: auth.retainer.remaining,
                                   received: auth.retainer.received } : null;
    }
    packages.push({
      case_no: c.case_no, kind: c.kind, stage: c.stage || null, case_type: c.case_type || null,
      client: c.kind === 'claims' ? (c.carrier || c.client_name) : c.client_name,
      subject: c.subject_name, investigator: c.investigator || null,
      authorized_hours: c.authorized_hours, authorized_budget: c.authorized_budget,
      hours_used: Math.round((Number(daysRow && daysRow.h) || 0) * 100) / 100,
      open_day: Number(daysRow && daysRow.open) > 0,
      days: Number(daysRow && daysRow.n) || 0,
      activity_count: Number(acts && acts.n) || 0,
      report_status: rep ? rep.status : null,
      photos: Number(ev && ev.photos) || 0,
      videos: Number(ev && ev.videos) || 0,
      build_status: build ? build.status : null,
      invoice_status: invoice ? invoice.status : null,
      retainer,
    });
  }

  // The Outstanding card: what is billed and unpaid across the book.
  const { results: liveInv } = await env.DB.prepare(
    "SELECT id FROM invoices WHERE status NOT IN ('void', 'draft')").all();
  let outstanding = 0;
  for (const iv of liveInv || []) {
    const full = await invoiceWithMoney(env,
      await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(iv.id).first());
    outstanding += Math.max(0, full.balance_due);
  }
  return json({ packages, outstanding: Math.round(outstanding * 100) / 100 });
}

/* Active Surveillance Mode (SURVEILLANCE.md).
 *
 * There is no surveillance table and there never will be: this is a VIEW of
 * the case, the day, the activity log and the evidence that already exist.
 * These two routes exist only because the mode needs to answer two questions
 * the existing shapes do not — "do I have a day running anywhere?" (so the
 * home-screen launch can resume it) and "who is out right now?" (P18). */

async function myActiveDay(env, user) {
  const row = await env.DB.prepare(
    `SELECT d.id, d.case_no, d.day_date, d.start_time, d.start_mileage,
            d.created_at AS started_at, s.kind, s.subject_name
       FROM case_days d JOIN submissions s ON s.case_no = d.case_no
      WHERE d.investigator_id = ? AND d.end_time IS NULL
      ORDER BY d.id DESC LIMIT 1`).bind(user.id).first();
  if (!row) {
    // Nothing running: the launcher offers the assignments they could start.
    const { results } = await env.DB.prepare(
      `SELECT s.case_no, s.kind, s.subject_name, st.stage
         FROM submissions s LEFT JOIN case_status st ON st.case_no = s.case_no
        WHERE s.status != 'closed' ${user.role === 'admin' ? '' : 'AND s.assigned_to = ?'}
        ORDER BY s.created_at DESC LIMIT 25`)
      .bind(...(user.role === 'admin' ? [] : [user.id])).all();
    return json({ active: null, server_now: nowIso(), assignments: results || [] });
  }
  const acts = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM activity_log WHERE case_no = ? AND day_id = ?')
    .bind(row.case_no, row.id).first();
  return json({
    active: { ...row, activity_count: Number(acts && acts.n) || 0,
              ...(await dayPauseState(env, row.id)) },
    server_now: nowIso(),
  });
}

/* Who is out right now — operational only. No location, no GPS: the handoff
   is explicit that this phase does not track anyone's position. */
async function outNow(env) {
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.case_no, d.day_date, d.start_time, d.created_at AS started_at,
            u.display_name AS investigator, s.subject_name, s.kind
       FROM case_days d
       LEFT JOIN users u ON u.id = d.investigator_id
       LEFT JOIN submissions s ON s.case_no = d.case_no
      WHERE d.end_time IS NULL
      ORDER BY d.created_at LIMIT 25`).all();
  const out = [];
  for (const d of results || []) {
    const last = await env.DB.prepare(
      `SELECT at_time, description, created_at FROM activity_log
        WHERE case_no = ? AND day_id = ? ORDER BY id DESC LIMIT 1`)
      .bind(d.case_no, d.id).first();
    const n = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM activity_log WHERE case_no = ? AND day_id = ?')
      .bind(d.case_no, d.id).first();
    out.push({
      ...d,
      ...(await dayPauseState(env, d.id)),
      activity_count: Number(n && n.n) || 0,
      last_activity: last ? { at_time: last.at_time, description: last.description,
                              created_at: last.created_at } : null,
    });
  }
  return json({ out_now: out, server_now: nowIso() });
}

/* ------------------------------------------------- my work, across cases */

/* An investigator's own desk: their reports and their expenses across every
   case assigned to them, plus the completed days still owing a report. Scoped
   to the caller by construction — there is no way to ask for someone else's. */
async function myReports(env, user) {
  const { results: reports } = await env.DB.prepare(
    `SELECT r.id, r.case_no, r.report_date, r.status, r.review_note
       FROM case_reports r WHERE r.investigator_id = ?
      ORDER BY r.report_date DESC, r.id DESC LIMIT 100`).bind(user.id).all();
  const { results: owed } = await env.DB.prepare(
    `SELECT d.id AS day_id, d.case_no, d.day_date, d.hours
       FROM case_days d LEFT JOIN case_reports r ON r.day_id = d.id
      WHERE d.investigator_id = ? AND d.end_time IS NOT NULL AND r.id IS NULL
      ORDER BY d.day_date DESC LIMIT 100`).bind(user.id).all();
  return json({ reports: reports || [], days_without_reports: owed || [] });
}

async function myExpenses(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT id, case_no, expense_date, category, amount, miles, description,
            reimbursable, billable, internal, reviewed_at
       FROM case_expenses WHERE investigator_id = ?
      ORDER BY expense_date DESC, id DESC LIMIT 200`).bind(user.id).all();
  return json({ expenses: results || [] });
}

/* ---------------------------------------------------------- demo cases */

/* A real case to build and test against, without a real client in it.
   Everything is invented and the case number always starts TEST-, which is
   what every other part of the system keys on: the list badges it, and the
   clear route deletes only rows whose case_no matches that prefix. A real
   case can therefore never be removed by this, which matters because the
   clear button sits next to live work.

   Deliberately NOT the same thing as the built-in example: the example is
   page-held and never touches the database, while this is a genuine row that
   can be assigned, logged against and reported on. */
function demoPayload(n) {
  return {
    carrier: 'Demo Mutual Insurance (TEST)', claim_number: `TEST-WC-${n}`,
    policy_number: `TEST-POL-${n}`, claim_type: "Workers' compensation",
    date_of_loss: '04/18/2026',
    adjuster: 'Alex Demo (test contact)', adjuster_email: 'adjuster@demo.invalid',
    adjuster_phone: '(540) 555-0100', defense_counsel: 'Demo & Demo LLP (test)',
    prior_surveillance: 'None',
    client_name: 'Alex Demo (test contact)', client_phone: '(540) 555-0100',
    client_email: 'adjuster@demo.invalid',
    subject_name: 'Jordan Sample (TEST subject)',
    subject_address: '100 Example Way, Roanoke, VA 24011',
    subject_description: 'Blue Ford Ranger, VA plate TST-0001. 5\'10", medium build.',
    subject_relationship: 'Lumbar strain. No lifting over 20 lbs, no ladders. Off work since 04/22.',
    objective: 'Establish activity level against the stated restrictions. This is a test case — '
             + 'nothing here relates to a real claimant.',
    authorized_hours: '24 hours — 3 days', not_to_exceed: '$3,300',
    start_date: '2026-09-01', permitted_days: 'Any day', permitted_times: '0600-1400',
    weekend_authorized: 'Yes — weekends authorized', priority: 'Routine',
    geographic_limits: 'Within 50 miles of Roanoke',
    timeline: 'Test case — no real deadline',
    notes: 'TEST CASE. Created from the portal to try the workspace out. Safe to delete.',
    attachments: 'none', billing_reference: 'TEST-PO-0001',
    billing_email: 'ap@demo.invalid', billing_notes: 'Test case — do not invoice.',
    signed_name: 'Alex Demo (test contact)', payment_method: 'Invoiced to carrier', fee_due: 0,
  };
}

async function createDemoCase(env, user) {
  /* Check the schema BEFORE writing anything. The first version wrote the
     submission, then failed on the case_meta insert because that table did not
     exist yet — leaving a half-made case with no authorization behind, once per
     click. A write that cannot be completed should not be started. */
  const missing = await missingTables(env);
  const needed = ['case_types', 'case_meta'].filter(t => missing.includes(t));
  if (needed.length) {
    return json({
      error: 'The database is missing tables this needs. Run the "Set up the case portal" '
           + 'workflow in GitHub Actions to apply the schema, then try again.',
      code: 'schema_out_of_date',
    }, 503);
  }

  const stamp = nowIso().slice(0, 10).replace(/-/g, '');
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(2)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const caseNo = `TEST-${stamp}-${rand}`;
  const payload = demoPayload(rand);

  await env.DB.prepare(
    `INSERT INTO submissions
       (case_no, kind, service, status, client_name, client_email, client_phone,
        subject_name, carrier, claim_number, payload, created_at)
     VALUES (?, 'claims', 'Insurance Claim Assignment (TEST)', 'new', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(caseNo, payload.client_name, payload.client_email, payload.client_phone,
          payload.subject_name, payload.carrier, payload.claim_number,
          JSON.stringify(payload), nowIso()).run();

  // Give it an authorization so the panel has something to measure against.
  // Bound, not inlined: a double-quoted literal is an IDENTIFIER in SQLite, so
  // spelling this out in the SQL failed with "no such column".
  const wc = await env.DB.prepare('SELECT id FROM case_types WHERE label = ?')
    .bind("Workers' Compensation Surveillance").first();
  await env.DB.prepare(
    `INSERT INTO case_meta (case_no, case_type_id, authorized_hours, authorized_budget, updated_by, updated_at)
     VALUES (?, ?, 24, 3300, ?, ?)`)
    .bind(caseNo, wc ? wc.id : null, user.id, nowIso()).run();

  return json({ ok: true, case_no: caseNo }, 201);
}

/* Only ever TEST- rows. The prefix is the whole safety mechanism, so it is
   written into every statement rather than computed once and trusted.

   Skips tables the database does not have. Cleaning up has to work on a
   half-applied schema — that is precisely the state that leaves stray test
   rows behind, and being unable to remove them until an unrelated workflow is
   run would be the wrong way round. */
async function clearDemoCases(env) {
  const like = 'TEST-%';
  const missing = await missingTables(env);
  let removed = 0;
  for (const [table, sql] of [
    ['activity_log', 'DELETE FROM activity_log WHERE case_no LIKE ?'],
    ['case_reports', 'DELETE FROM case_reports WHERE case_no LIKE ?'],
    ['case_days',    'DELETE FROM case_days   WHERE case_no LIKE ?'],
    ['case_meta',    'DELETE FROM case_meta   WHERE case_no LIKE ?'],
    ['submissions',  'DELETE FROM submissions WHERE case_no LIKE ?'],
  ]) {
    if (missing.includes(table)) continue;
    const r = await env.DB.prepare(sql).bind(like).run();
    if (table === 'submissions') removed = (r.meta && r.meta.changes) || 0;
  }
  return json({ ok: true, removed });
}

/* ------------------------------------------------------- daily reports */

/* Assembling a chronology from the log is the useful part; writing the
   investigator's words for them is not. This does the mechanical work — order,
   12-hour times, one line per observation — and leaves the wording alone.

   The only rewrite is "Subject <verb>" to "the subject <verb>", and only when
   the next word is actually a verb — "Subject arrived" becomes "the subject
   arrived", while "Subject vehicle observed parked at residence" is left
   alone, because there "Subject" modifies a noun and the substitution would
   produce nonsense. Everything the rule is not certain about keeps the
   investigator's sentence verbatim after a dash.

   A report becomes testimony. A system that quietly rephrases what someone
   observed is a system putting words in a witness's mouth, so this one does
   the mechanical work and stops. */
function time12(hhmm) {
  const h = parseInt(hhmm.slice(0, 2), 10), m = hhmm.slice(3, 5);
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${ampm}`;
}

/* Past-tense verbs cover most of what a surveillance line says the subject did.
   The irregulars are the ones that actually turn up in field notes. */
const PAST_IRREGULAR = /^(was|were|went|drove|left|took|came|got|made|sat|stood|ran|met|held|threw|bent|rode|began|broke|drew|fell|flew|hid|kept|knelt|lay|paid|put|read|said|sold|sent|set|shot|slept|spoke|spent|swept|swam|wore|won|wrote)$/i;

function draftLine(e) {
  const t = time12(e.at_time);
  const d = String(e.description || '').trim().replace(/\s+/g, ' ');
  const where = e.location ? ` (${e.location})` : '';

  const m = d.match(/^subject\s+(\S+)/i);
  const actsLikeVerb = m && (/^[a-z]+ed$/i.test(m[1]) || PAST_IRREGULAR.test(m[1]));
  const body = actsLikeVerb
    ? `At approximately ${t}, the subject${d.slice(7)}`
    : `At approximately ${t} — ${d}`;

  const withDot = /[.!?]$/.test(body) ? body : body + '.';
  const placed = where ? withDot.replace(/([.!?])$/, `${where}$1`) : withDot;
  // What was captured, stated per line the way a chronology does.
  const marks = [];
  if (e.subject_documented) marks.push('Subject documented');
  if (e.video_acquired) marks.push('Video acquired');
  if (e.photo_acquired) marks.push('Photograph acquired');
  return marks.length ? `${placed} (${marks.join('. ')}.)` : placed;
}

function draftBody(day, entries) {
  const head = [
    `SURVEILLANCE CHRONOLOGY — ${day.day_date}`,
    day.end_time
      ? `Surveillance conducted from ${time12(day.start_time)} to ${time12(day.end_time)}.`
      : `Surveillance commenced at ${time12(day.start_time)}.`,
    '',
  ];
  const lines = entries.length
    ? entries.map(draftLine)
    : ['(No activity entries were logged for this day.)'];
  const tail = day.summary ? ['', 'SUMMARY', day.summary] : [];
  return head.concat(lines).concat(tail).join('\n');
}

const REPORT_STATUSES = ['draft', 'submitted', 'needs_revision', 'approved', 'delivered'];

async function generateReport(request, env, user, caseNo) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const body = await readJson(request);
  const dayId = parseInt(body.day_id, 10);
  if (!Number.isFinite(dayId)) return json({ error: 'Pick the investigation day to report on.' }, 400);

  const day = await env.DB.prepare(
    'SELECT * FROM case_days WHERE id = ? AND case_no = ?').bind(dayId, caseNo).first();
  if (!day) return json({ error: 'not found' }, 404);
  if (user.role !== 'admin' && day.investigator_id !== user.id) {
    return json({ error: 'That day belongs to another investigator.' }, 403);
  }

  const existing = await env.DB.prepare('SELECT id FROM case_reports WHERE day_id = ?').bind(dayId).first();
  if (existing) return json({ error: 'A report already exists for that day.', id: existing.id }, 409);

  // A removed entry never reaches the report. The row still exists; the
  // chronology simply does not carry it.
  const { results } = await env.DB.prepare(
    `SELECT a.at_time, a.description, a.location,
            COALESCE(m.subject_documented, 0) AS subject_documented,
            COALESCE(m.video_acquired, 0) AS video_acquired,
            COALESCE(m.photo_acquired, 0) AS photo_acquired
       FROM activity_log a LEFT JOIN activity_media m ON m.entry_id = a.id
       LEFT JOIN activity_removed r ON r.entry_id = a.id
      WHERE a.case_no = ? AND a.day_id = ? AND r.entry_id IS NULL
      ORDER BY a.at_time ASC, a.id ASC`).bind(caseNo, dayId).all();

  const res = await env.DB.prepare(
    `INSERT INTO case_reports (case_no, day_id, investigator_id, report_date, status, body, created_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?)`)
    .bind(caseNo, dayId, day.investigator_id, day.day_date,
          draftBody(day, results || []), nowIso()).run();

  return json({ ok: true, id: res.meta ? res.meta.last_row_id : null, entries: (results || []).length }, 201);
}

async function saveReport(request, env, user, caseNo, id) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const rep = await env.DB.prepare(
    'SELECT id, investigator_id, status FROM case_reports WHERE id = ? AND case_no = ?').bind(id, caseNo).first();
  if (!rep) return json({ error: 'not found' }, 404);

  const admin = user.role === 'admin';
  if (!admin && rep.investigator_id !== user.id) {
    return json({ error: 'That report belongs to another investigator.' }, 403);
  }
  // Once approved, the wording is what the office signed off on. An admin can
  // still reopen it by setting the status back; an investigator cannot edit
  // around a review that has already happened.
  if (!admin && !['draft', 'needs_revision'].includes(rep.status)) {
    return json({ error: 'This report is with the office for review.' }, 409);
  }
  const text = String((await readJson(request)).body || '');
  if (!text.trim()) return json({ error: 'The report is empty.' }, 400);

  await env.DB.prepare(
    'UPDATE case_reports SET body = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .bind(text.slice(0, 100000), nowIso(), user.id, id).run();
  return json({ ok: true, id });
}

/* The review path. An investigator moves work forward — draft to submitted —
   and nothing else. Approving your own report is not a review, so the
   transitions that decide a report is finished are admin-only. */
async function setReportStatus(request, env, user, caseNo, id) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const rep = await env.DB.prepare(
    'SELECT id, investigator_id, status FROM case_reports WHERE id = ? AND case_no = ?').bind(id, caseNo).first();
  if (!rep) return json({ error: 'not found' }, 404);

  const body = await readJson(request);
  const next = String(body.status || '');
  if (!REPORT_STATUSES.includes(next)) return json({ error: 'invalid status' }, 400);

  const admin = user.role === 'admin';
  if (!admin) {
    if (rep.investigator_id !== user.id) {
      return json({ error: 'That report belongs to another investigator.' }, 403);
    }
    const allowed = ['draft', 'needs_revision'].includes(rep.status) && next === 'submitted';
    if (!allowed) {
      return json({ error: 'Only the office can review or approve a report.' }, 403);
    }
  }
  await env.DB.prepare(
    `UPDATE case_reports SET status = ?, review_note = ?, status_at = ?, status_by = ? WHERE id = ?`)
    .bind(next, String(body.note || '').slice(0, 2000) || null, nowIso(), user.id, id).run();

  // Submitting preserves the exact text (UIBUILD P11): the snapshot is what
  // was reviewed, whatever happens to the working copy afterwards.
  if (next === 'submitted') {
    const full = await env.DB.prepare('SELECT body FROM case_reports WHERE id = ?').bind(id).first();
    try {
      await env.DB.prepare(
        'INSERT INTO report_versions (report_id, body, submitted_at, submitted_by) VALUES (?, ?, ?, ?)')
        .bind(id, full ? String(full.body || '') : '', nowIso(), user.id).run();
    } catch { /* a missing table surfaces via /health, not by blocking review */ }
  }
  return json({ ok: true, id, status: next });
}

/* The submitted-version history (UIBUILD P11). Read-only, scoped by the same
   caseFor gate as everything else in the workspace. */
async function reportVersions(env, user, caseNo, id) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const rep = await env.DB.prepare(
    'SELECT id FROM case_reports WHERE id = ? AND case_no = ?').bind(id, caseNo).first();
  if (!rep) return json({ error: 'not found' }, 404);
  const { results } = await env.DB.prepare(
    `SELECT v.id, v.body, v.submitted_at, u.display_name AS submitted_by
       FROM report_versions v LEFT JOIN users u ON u.id = v.submitted_by
      WHERE v.report_id = ? ORDER BY v.id DESC LIMIT 50`).bind(id).all();
  return json({ versions: results || [] });
}

/* Link an evidence file to the activity moment it documents, after upload
   (UIBUILD P9's fold). The uploader or the office; the entry must be on the
   same case, and null unlinks. */
async function linkEvidence(request, env, user, caseNo, evidenceId) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const ev = await env.DB.prepare(
    'SELECT id, uploaded_by FROM case_evidence WHERE id = ? AND case_no = ? AND deleted_at IS NULL')
    .bind(evidenceId, caseNo).first();
  if (!ev) return json({ error: 'not found' }, 404);
  if (user.role !== 'admin' && ev.uploaded_by !== user.id) {
    return json({ error: 'That file was uploaded by someone else.' }, 403);
  }
  const body = await readJson(request);
  let entryId = null;
  if (body.entry_id !== null && body.entry_id !== undefined && String(body.entry_id) !== '') {
    entryId = parseInt(body.entry_id, 10);
    if (!Number.isFinite(entryId)) return json({ error: 'invalid entry' }, 400);
    const entry = await env.DB.prepare(
      'SELECT id FROM activity_log WHERE id = ? AND case_no = ?').bind(entryId, caseNo).first();
    if (!entry) return json({ error: 'That moment is not on this case.' }, 400);
  }
  await env.DB.prepare('UPDATE case_evidence SET entry_id = ? WHERE id = ?').bind(entryId, evidenceId).run();
  return json({ ok: true, id: evidenceId, entry_id: entryId });
}

/* ----------------------------------------------------------------- users */

async function listUsers(env) {
  // includes each person's compensation so the Staff tab can edit it in place
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.role, u.active, u.created_at, u.last_login_at,
            r.hourly AS comp_hourly, r.mileage AS comp_mileage
       FROM users u LEFT JOIN user_rates r ON r.user_id = u.id
      ORDER BY u.role, u.username`).all();
  return json({ users: results || [] });
}

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Password must be at least 12 characters.';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw)) {
    return 'Password needs an uppercase letter, a lowercase letter and a digit.';
  }
  return null;
}

async function createUser(request, env) {
  const body = await readJson(request);
  const username = String(body.username || '').trim().toLowerCase();
  const role = String(body.role || 'investigator');
  const password = String(body.password || '');

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return json({ error: 'Username must be 3–32 characters: letters, digits, dot, dash or underscore.' }, 400);
  }
  if (!['admin', 'investigator'].includes(role)) return json({ error: 'invalid role' }, 400);
  const pwErr = passwordProblem(password);
  if (pwErr) return json({ error: pwErr }, 400);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) return json({ error: 'That username already exists.' }, 409);

  const salt = randomHex(16);
  const iterations = iterCount(env);
  const hash = await pbkdf2(password, salt, iterations);
  await env.DB.prepare(
    `INSERT INTO users (username, display_name, pass_hash, pass_salt, iterations, role, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
    .bind(username, String(body.display_name || username).slice(0, 80),
      hash, salt, iterations, role, nowIso()).run();
  return json({ ok: true, username, role }, 201);
}

async function setUserActive(request, env, id, actor) {
  const body = await readJson(request);
  const active = body.active ? 1 : 0;
  if (Number(id) === actor.id && !active) {
    return json({ error: 'You cannot deactivate your own account.' }, 400);
  }
  const res = await env.DB.prepare('UPDATE users SET active = ? WHERE id = ?').bind(active, id).run();
  if (res.meta && res.meta.changes === 0) return json({ error: 'not found' }, 404);
  // Deactivating must end any session that account already holds.
  if (!active) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
  return json({ ok: true, id: Number(id), active: Boolean(active) });
}

async function resetPassword(request, env, id) {
  const body = await readJson(request);
  const pwErr = passwordProblem(String(body.password || ''));
  if (pwErr) return json({ error: pwErr }, 400);
  const salt = randomHex(16);
  const iterations = iterCount(env);
  const hash = await pbkdf2(String(body.password), salt, iterations);
  const res = await env.DB.prepare(
    'UPDATE users SET pass_hash = ?, pass_salt = ?, iterations = ? WHERE id = ?')
    .bind(hash, salt, iterations, id).run();
  if (res.meta && res.meta.changes === 0) return json({ error: 'not found' }, 404);
  // Force a fresh login everywhere with the new password.
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM login_fails WHERE username = (SELECT username FROM users WHERE id = ?)')
    .bind(id).run();
  return json({ ok: true, id: Number(id) });
}

/* ---------------------------------------------------------------- invites */

/** Escape for insertion into an HTML email body. */
function escHtml(t) {
  return String(t ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Email an invitation link.
 *
 * Best effort by design: this never throws and its failure never fails the
 * invitation. The invite row is already committed by the time this runs, and
 * the link is returned to the admin regardless — so a provider outage costs a
 * copy-and-paste, never a lost invitation.
 *
 * Unconfigured is a normal state, not an error. Without RESEND_API_KEY the
 * portal behaves exactly as it did before: the admin sends the link themselves.
 *
 * Note the link in this email is a bearer credential — whoever opens it first
 * creates the account. That is why it is single-use, expires in a week, and can
 * be revoked from the Staff tab.
 */
async function sendInviteEmail(env, { to, displayName, url, invitedBy, role }) {
  if (!env.RESEND_API_KEY) return { sent: false, reason: 'not_configured' };
  if (!to) return { sent: false, reason: 'no_address' };

  const from = env.INVITE_FROM || 'Always Precise Investigations <onboarding@resend.dev>';
  const who = displayName || 'there';
  const by = invitedBy ? ` by ${invitedBy}` : '';
  const kind = role === 'admin' ? 'an administrator' : 'an investigator';

  const text =
`${who},

You have been given access${by} to the Always Precise Investigations case portal as ${kind}.

Open this link to choose your own password:
${url}

The link works once and expires in ${INVITE_DAYS} days. Nobody else sees the password you choose — not even whoever invited you.

If you were not expecting this, ignore it and the invitation goes unused.

Always Precise Investigations, LLC
Va DCJS #11-9159`;

  const html =
`<div style="font-family:'Segoe UI',Arial,sans-serif;color:#1c2531;line-height:1.6;max-width:520px">
  <p>${escHtml(who)},</p>
  <p>You have been given access${escHtml(by)} to the Always Precise Investigations case
     portal as ${escHtml(kind)}.</p>
  <p><a href="${escHtml(url)}" style="display:inline-block;background:#2f7d90;color:#fff;
     text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">Choose your password</a></p>
  <p style="font-size:.86rem;color:#5c6775">Or paste this into your browser:<br>
     <span style="word-break:break-all">${escHtml(url)}</span></p>
  <p style="font-size:.9rem">The link works once and expires in ${INVITE_DAYS} days. Nobody else
     sees the password you choose &mdash; not even whoever invited you.</p>
  <p style="font-size:.86rem;color:#5c6775">If you were not expecting this, ignore it and the
     invitation goes unused.</p>
  <hr style="border:0;border-top:1px solid #dfe3e8">
  <p style="font-size:.8rem;color:#5c6775">Always Precise Investigations, LLC &middot; Va DCJS #11-9159</p>
</div>`;

  return sendMail(env, { to, subject: 'Your Always Precise case portal access', text, html });
}

/* One place that talks to the provider. Never throws: a send that fails is
   reported, never fatal, because losing an invitation or a quote to a provider
   outage would be worse than sending it by hand. */
async function sendMail(env, { to, subject, text, html }) {
  if (!env.RESEND_API_KEY) return { sent: false, reason: 'not_configured' };
  if (!to) return { sent: false, reason: 'no_address' };
  const from = env.INVITE_FROM || 'Always Precise Investigations <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, text, html }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { sent: true };
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* body may not be json */ }
    console.error('email rejected', res.status, detail);
    return { sent: false, reason: 'rejected', status: res.status, detail };
  } catch (e) {
    console.error('email failed', e && e.message ? e.message : e);
    return { sent: false, reason: 'unreachable' };
  }
}

/**
 * Issue an invitation. The raw token is returned exactly once, in this
 * response, and only its hash is kept — so the link cannot be recovered later
 * from the database, and a lost link is reissued rather than looked up.
 */
async function createInvite(request, env, actor) {
  const body = await readJson(request);
  const username = String(body.username || '').trim().toLowerCase();
  const role = String(body.role || 'investigator');
  const email = String(body.email || '').trim().slice(0, 200);

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return json({ error: 'Username must be 3–32 characters: letters, digits, dot, dash or underscore.' }, 400);
  }
  if (!['admin', 'investigator'].includes(role)) return json({ error: 'invalid role' }, 400);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'That email does not look right.' }, 400);

  const taken = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (taken) return json({ error: 'That username already exists.' }, 409);

  // Replace any invitation still outstanding for the same username, so a
  // reissued link cannot leave two working tokens behind.
  await env.DB.prepare(
    'UPDATE invites SET revoked_at = ? WHERE username = ? AND used_at IS NULL AND revoked_at IS NULL')
    .bind(nowIso(), username).run();

  const token = randomHex(32);
  const expires = new Date(Date.now() + INVITE_DAYS * 86400_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO invites (token_hash, username, display_name, email, role, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(await sha256Hex(token), username, String(body.display_name || username).slice(0, 80),
      email || null, role, actor.id, nowIso(), expires).run();

  const url = `${env.SITE_ORIGIN || ''}/portal/?invite=${token}`;

  // Only now, with the invitation safely stored, try to deliver it. The link
  // goes back either way so a failed send is an inconvenience, not a loss.
  const mail = await sendInviteEmail(env, {
    to: email, displayName: String(body.display_name || username).slice(0, 80),
    url, invitedBy: actor.display_name || actor.username, role,
  });

  return json({
    ok: true, username, role, expires_at: expires, url,
    emailed: mail.sent === true,
    email_status: mail.sent ? 'sent' : (mail.reason || 'not_sent'),
  }, 201);
}

async function listInvites(env) {
  const { results } = await env.DB.prepare(
    `SELECT i.rowid AS id, i.username, i.display_name, i.email, i.role, i.created_at,
            i.expires_at, i.used_at, i.revoked_at, u.display_name AS invited_by
       FROM invites i LEFT JOIN users u ON u.id = i.created_by
      WHERE i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?
      ORDER BY i.created_at DESC`).bind(nowIso()).all();
  return json({ invites: results || [] });
}

async function revokeInvite(env, id) {
  const res = await env.DB.prepare(
    'UPDATE invites SET revoked_at = ? WHERE rowid = ? AND used_at IS NULL AND revoked_at IS NULL')
    .bind(nowIso(), id).run();
  if (res.meta && res.meta.changes === 0) return json({ error: 'not found' }, 404);
  return json({ ok: true });
}

/** Look an invitation up by its raw token, or return null. */
async function inviteByToken(env, token) {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(
    'SELECT rowid AS id, username, display_name, role, expires_at, used_at, revoked_at FROM invites WHERE token_hash = ?')
    .bind(await sha256Hex(token)).first();
  if (!row) return null;
  if (row.used_at || row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

/** Public: lets the acceptance page show who the invitation is for. */
async function checkInvite(env, token) {
  const inv = await inviteByToken(env, token);
  if (!inv) return json({ valid: false, error: 'This invitation is not valid. It may have expired or already been used.' }, 404);
  return json({ valid: true, username: inv.username, display_name: inv.display_name, role: inv.role });
}

/** Public: the invitee sets their own password and the account is created. */
async function acceptInvite(request, env, token) {
  const inv = await inviteByToken(env, token);
  if (!inv) return json({ error: 'This invitation is not valid. It may have expired or already been used.' }, 404);

  const body = await readJson(request);
  const password = String(body.password || '');
  const pwErr = passwordProblem(password);
  if (pwErr) return json({ error: pwErr }, 400);

  const taken = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(inv.username).first();
  if (taken) return json({ error: 'That account already exists. Try signing in instead.' }, 409);

  const salt = randomHex(16);
  const iterations = iterCount(env);
  const hash = await pbkdf2(password, salt, iterations);
  await env.DB.prepare(
    `INSERT INTO users (username, display_name, pass_hash, pass_salt, iterations, role, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
    .bind(inv.username, inv.display_name || inv.username, hash, salt, iterations, inv.role, nowIso()).run();

  // Burn the invitation before signing them in, so a replayed link cannot make
  // a second account even if two requests arrive together.
  await env.DB.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ?')
    .bind(nowIso(), await sha256Hex(token)).run();

  const user = await env.DB.prepare(
    'SELECT id, username, display_name, role FROM users WHERE username = ?').bind(inv.username).first();
  const session = await createSession(env, user.id);
  return json({ ok: true, user }, 201, { 'Set-Cookie': sessionCookie(session, SESSION_HOURS * 3600) });
}

/** Creates the very first admin, and only while no account exists at all. */
async function handleBootstrap(request, env) {
  const supplied = request.headers.get('X-Bootstrap-Token') || '';
  if (!env.BOOTSTRAP_TOKEN || !(await secretEqual(supplied, env.BOOTSTRAP_TOKEN))) {
    return json({ error: 'not authorised' }, 401);
  }
  const any = await env.DB.prepare('SELECT id FROM users LIMIT 1').first();
  if (any) return json({ error: 'Already set up. Create further accounts from the portal.' }, 409);
  const body = await readJson(request);
  return createUser(new Request(request.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, role: 'admin' }),
  }), env);
}

/* ------------------------------------------------------------------ router */

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

const ADMIN_ONLY = 'This action needs an admin account.';

/* Every table the application expects. Compared against what the database
   actually has, so "the schema has not been applied yet" is a thing the portal
   can say plainly rather than a 500 the user has to interpret. */
const EXPECTED_TABLES = [
  'users', 'sessions', 'submissions', 'login_fails', 'invites', 'ingest_rate',
  'case_types', 'case_meta', 'case_days', 'activity_log', 'activity_media', 'case_reports', 'app_config',
  'case_expenses', 'case_notes', 'user_rates', 'case_settings', 'password_resets', 'case_offers',
  'case_details', 'case_subjects', 'subject_vehicles', 'case_comms', 'case_tasks',
  'case_status', 'case_closure', 'case_retainer',
  'invoices', 'invoice_lines', 'invoice_payments', 'invoice_events', 'case_evidence',
  'case_builds', 'build_items', 'external_files', 'build_events', 'report_versions',
  /* Every table added after this list was first written. Leaving one out makes
     /health report a clean schema on a database that then 503s on every
     workspace load — the check saying "fine" is worse than no check. */
  'activity_removed', 'build_reports', 'build_summary', 'build_custom',
  'case_day_pauses', 'lead_status', 'send_log', 'invoice_retainer',
];

async function missingTables(env) {
  if (!env.DB) return EXPECTED_TABLES.slice();
  try {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const have = new Set((results || []).map(r => r.name));
    return EXPECTED_TABLES.filter(t => !have.has(t));
  } catch {
    return [];   // cannot tell; do not invent a problem
  }
}

async function route(request, env) {
  const url = new URL(request.url);
  // The Worker is mounted on /portal-api/* on the site's own domain; strip that
  // prefix so the routes below read the same either way.
  let p = url.pathname;
  if (p === API_PREFIX || p.startsWith(API_PREFIX + '/')) p = p.slice(API_PREFIX.length) || '/';
  p = p.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (p === '/health') {
    const missing = await missingTables(env);
    let storagePct = null;
    if (env.DB && !missing.includes('case_evidence')) {
      try { storagePct = (await evidenceUsage(env)).percent_of_free; } catch { storagePct = null; }
    }
    return json({
      ok: true,
      configured: Boolean(env.DB && env.INGEST_KEY),
      email: Boolean(env.RESEND_API_KEY),
      // Which tables are actually there. The portal checks this on load so a
      // half-applied schema announces itself, instead of waiting for whichever
      // button happens to touch a missing table first.
      missing_tables: missing,
      // A bare percentage of the R2 free tier — nothing sensitive, and what
      // the daily site-health run reads to warn the owner at 75%.
      storage_pct: storagePct,
    });
  }
  if (p === '/auth/login' && method === 'POST') return handleLogin(request, env);
  if (p === '/auth/logout' && method === 'POST') return handleLogout(request, env);
  if (p === '/ingest' && method === 'POST') return handleIngest(request, env);
  if (p === '/setup' && method === 'POST') return handleBootstrap(request, env);

  // Redeeming an invitation is necessarily unauthenticated — the account does
  // not exist yet. The token is the credential.
  let inv = p.match(/^\/invite\/([0-9a-f]{64})$/);
  if (inv && method === 'GET') return checkInvite(env, inv[1]);
  inv = p.match(/^\/invite\/([0-9a-f]{64})\/accept$/);
  if (inv && method === 'POST') return acceptInvite(request, env, inv[1]);

  let rst = p.match(/^\/reset\/([0-9a-f]{64})$/);
  if (rst && method === 'GET') {
    const th = await sha256Hex(rst[1]);
    const row = await env.DB.prepare(
      `SELECT r.user_id, r.expires_at, r.used_at, u.username, u.display_name
         FROM password_resets r JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = ?`).bind(th).first();
    if (!row || row.used_at || row.expires_at < nowIso()) {
      return json({ error: 'This reset link is not valid any more. Ask an admin for a fresh one.' }, 404);
    }
    return json({ username: row.username, display_name: row.display_name });
  }
  rst = p.match(/^\/reset\/([0-9a-f]{64})\/accept$/);
  if (rst && method === 'POST') {
    const th = await sha256Hex(rst[1]);
    const row = await env.DB.prepare(
      `SELECT r.user_id, r.expires_at, r.used_at FROM password_resets r WHERE r.token_hash = ?`)
      .bind(th).first();
    if (!row || row.used_at || row.expires_at < nowIso()) {
      return json({ error: 'This reset link is not valid any more. Ask an admin for a fresh one.' }, 404);
    }
    const body = await readJson(request);
    const pwErr = passwordProblem(String(body.password || ''));
    if (pwErr) return json({ error: pwErr }, 400);
    const salt = randomHex(16);
    const iterations = iterCount(env);
    const hash = await pbkdf2(String(body.password), salt, iterations);
    await env.DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ?, iterations = ? WHERE id = ?')
      .bind(hash, salt, iterations, row.user_id).run();
    // Single use, every old session dead, lockout counter cleared.
    await env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').bind(nowIso(), th).run();
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id).run();
    await env.DB.prepare('DELETE FROM login_fails WHERE username = (SELECT username FROM users WHERE id = ?)')
      .bind(row.user_id).run();
    const u = await env.DB.prepare('SELECT id, username, display_name, role FROM users WHERE id = ?')
      .bind(row.user_id).first();
    const session = await createSession(env, u.id);
    return json({ ok: true, user: u }, 200, { 'Set-Cookie': sessionCookie(session, SESSION_HOURS * 3600) });
  }

  // Everything below needs a signed-in caller.
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in.' }, 401);

  if (p === '/auth/me') return json({ user });
  if (p === '/submissions' && method === 'GET') return listSubmissions(request, env, user);

  let m = p.match(/^\/submissions\/([A-Za-z0-9-]{3,64})$/);
  if (m && method === 'GET') return getSubmission(env, user, m[1]);

  m = p.match(/^\/submissions\/([A-Za-z0-9-]{3,64})\/assign$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return assignSubmission(request, env, user, m[1]);
  }

  m = p.match(/^\/submissions\/([A-Za-z0-9-]{3,64})\/status$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return setStatus(request, env, user, m[1]);
  }

  /* Internal rates. Admin-only and deliberately not reachable from the intake
     form or any public page — carrier pricing is quoted per assignment, and a
     negotiated rate is never advertised. `hours` and `rate` are optional and
     produce a quote against the configured standard. */
  if (p === '/pricing' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    const q = new URL(request.url).searchParams;
    return json({
      rates: RATES,
      auth_presets: AUTH_PRESETS,
      packages: packageSheet(),
      quote: q.has('hours') ? quoteFor(q.get('hours'), q.get('rate')) : null,
    });
  }

  /* The two sheets the office sends. Admin-only for the same reason the rates
     are: a price the firm has not chosen to quote yet is not public. */
  if (p === '/sheets' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return json({ sheets: rateSheets(), email_configured: Boolean(env.RESEND_API_KEY) });
  }

  m = p.match(/^\/sheets\/([a-z_]{3,32})\/email$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return emailSheet(request, env, user, m[1]);
  }

  /* Counts for the dashboard. Scoped like everything else — an investigator's
     totals are their own cases, not the firm's book of work. */
  if (p === '/summary' && method === 'GET') return caseSummary(env, user);

  /* The case workspace. Every route below re-checks that this caller may open
     this case, against the database, so a changed case number in the URL is
     not a way into someone else's work. */
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/workspace$/);
  if (m && method === 'GET') return caseWorkspace(env, user, m[1]);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/meta$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return setCaseMeta(request, env, m[1]);
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/day\/start$/);
  if (m && method === 'POST') return startDay(request, env, user, m[1]);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/day\/end$/);
  if (m && method === 'POST') return endDay(request, env, user, m[1]);

  // Stopping the clock for a break. Scoped to the caller's own running day,
  // exactly as day/end is — you can only pause a day you are working.
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/day\/pause$/);
  if (m && method === 'POST') return pauseDay(request, env, user, m[1]);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/day\/resume$/);
  if (m && method === 'POST') return resumeDay(env, user, m[1]);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/activity$/);
  if (m && method === 'POST') return addActivity(request, env, user, m[1]);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/activity\/(\d{1,12})$/);
  if (m && method === 'POST') return editActivity(request, env, user, m[1], parseInt(m[2], 10));

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/activity\/(\d{1,12})\/delete$/);
  if (m && method === 'POST') return removeActivity(request, env, user, m[1], parseInt(m[2], 10));

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/activity\/(\d{1,12})\/restore$/);
  if (m && method === 'POST') return restoreActivity(env, user, m[1], parseInt(m[2], 10));



  /* Case Build (CASEBUILD.md) — the client package. Admin-only in full: an
     investigator never selects, shares, or finalizes client deliverables. */
  if (p.startsWith('/build/') || /^\/cases\/[A-Za-z0-9-]{3,64}\/build$/.test(p) || p === '/external-storage') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
  }

  if (p === '/packages' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return casePackages(env);
  }

  // MASTER §31 — the office's view of finished work. Admin-only: the desk
  // carries invoices and client identity, neither of which reaches the field.
  if (p === '/completed' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return completedCases(env);
  }

  // MASTER §5 — the sales desk. Both admin-only: a lead is office work.
  m = p.match(/^\/leads\/([A-Za-z0-9-]{3,64})\/status$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    const st = String((await readJson(request)).status || '');
    if (!LEAD_STATUSES.includes(st)) return json({ error: 'Pick a real lead status.' }, 400);
    const lead = await env.DB.prepare('SELECT case_no FROM submissions WHERE case_no = ?')
      .bind(m[1]).first();
    if (!lead) return json({ error: 'not found' }, 404);
    await stampLead(env, user, m[1], st, { manual: true });
    return json({ ok: true, case_no: m[1], lead_status: st });
  }

  m = p.match(/^\/leads\/([A-Za-z0-9-]{3,64})\/send-intake$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return sendLeadIntake(request, env, user, m[1]);
  }

  if (p === '/intakes' && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return createManualIntake(request, env, user);
  }

  // Active Surveillance Mode: resume-anywhere for whoever is asking, and the
  // office's view of who is out. Both scoped by the caller's own identity.
  if (p === '/my/active' && method === 'GET') return myActiveDay(env, user);
  if (p === '/active' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return outNow(env);
  }

  if (p === '/external-storage' && method === 'GET') {
    return json({ providers: Object.fromEntries(Object.entries(EXTERNAL_PROVIDERS).map(([k, prov]) =>
      [k, { label: prov.label, configured: prov.configured(env), note: prov.note }])) });
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/build$/);
  if (m && method === 'GET') {
    const exists = await env.DB.prepare('SELECT 1 AS x FROM submissions WHERE case_no = ?').bind(m[1]).first();
    if (!exists) return json({ error: 'not found' }, 404);
    return json(await buildState(env, m[1]));
  }
  if (m && method === 'POST') {
    const exists = await env.DB.prepare('SELECT 1 AS x FROM submissions WHERE case_no = ?').bind(m[1]).first();
    if (!exists) return json({ error: 'not found' }, 404);
    const open = await env.DB.prepare(
      "SELECT id FROM case_builds WHERE case_no = ? AND status = 'draft'").bind(m[1]).first();
    if (open) return json({ error: 'A draft build is already open on this case.' }, 409);
    const rep = await latestApprovedReport(env, m[1]);
    const ver = await env.DB.prepare(
      'SELECT COALESCE(MAX(version), 0) AS v FROM case_builds WHERE case_no = ?').bind(m[1]).first();
    const now = nowIso();
    const res = await env.DB.prepare(
      `INSERT INTO case_builds (case_no, version, report_id, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(m[1], (Number(ver && ver.v) || 0) + 1, rep ? rep.id : null, user.id, now, user.id, now).run();
    /* Every approved day goes in, not just the latest — a three-day case
       used to ship its third day alone (MASTER §13). */
    const seeded = await seedBuildReports(env, res.meta.last_row_id, m[1], user);
    await buildEvent(env, res.meta.last_row_id, user, 'created',
      seeded.length > 1 ? `on ${seeded.length} approved reports, ${seeded[0].report_date} to ${seeded[seeded.length - 1].report_date}`
        : rep ? `on the approved report of ${rep.report_date}` : 'no approved report yet');
    return json(await buildState(env, m[1]), 201);
  }

  /* Attach a day approved after the build was opened, or put one back. */
  m = p.match(/^\/build\/(\d{1,12})\/reports$/);
  if (m && method === 'POST') {
    const b = await adminBuild(env, user, parseInt(m[1], 10));
    if (!b) return json({ error: 'not found' }, 404);
    if (b.status !== 'draft') return json({ error: 'Reopen the build to change it.' }, 400);
    const rid = parseInt((await readJson(request)).report_id, 10);
    const r = await env.DB.prepare(
      'SELECT id, report_date, status FROM case_reports WHERE id = ? AND case_no = ?')
      .bind(rid, b.case_no).first();
    if (!r) return json({ error: 'That report is not on this case.' }, 400);
    if (!['approved', 'delivered'].includes(r.status)) {
      return json({ error: `The report of ${r.report_date} is ${r.status} — approve it first.` }, 400);
    }
    const dupe = await env.DB.prepare(
      'SELECT id FROM build_reports WHERE build_id = ? AND report_id = ?').bind(b.id, rid).first();
    if (dupe) return json({ error: 'Already in the package.' }, 409);
    const sortRow = await env.DB.prepare(
      'SELECT COALESCE(MAX(sort), -1) AS s FROM build_reports WHERE build_id = ?').bind(b.id).first();
    await env.DB.prepare(
      'INSERT INTO build_reports (build_id, report_id, sort, added_by, added_at) VALUES (?, ?, ?, ?, ?)')
      .bind(b.id, rid, (Number(sortRow && sortRow.s) ?? -1) + 1, user.id, nowIso()).run();
    if (!b.report_id) {
      await env.DB.prepare('UPDATE case_builds SET report_id = ? WHERE id = ?').bind(rid, b.id).run();
    }
    await buildEvent(env, b.id, user, 'report_attached', `the report of ${r.report_date}`);
    return json(await buildState(env, b.case_no), 201);
  }

  m = p.match(/^\/build\/(\d{1,12})\/reports\/(\d{1,12})\/remove$/);
  if (m && method === 'POST') {
    const b = await adminBuild(env, user, parseInt(m[1], 10));
    if (!b) return json({ error: 'not found' }, 404);
    if (b.status !== 'draft') return json({ error: 'Reopen the build to change it.' }, 400);
    const rid = parseInt(m[2], 10);
    const del = await env.DB.prepare('DELETE FROM build_reports WHERE build_id = ? AND report_id = ?')
      .bind(b.id, rid).run();
    if (del.meta && del.meta.changes === 0) return json({ error: 'not found' }, 404);
    /* Keep report_id pointing at something that is still in the package —
       it is what the older single-report reads use. */
    if (b.report_id === rid) {
      const next = await env.DB.prepare(
        `SELECT r.id FROM build_reports br JOIN case_reports r ON r.id = br.report_id
          WHERE br.build_id = ? ORDER BY r.report_date DESC, r.id DESC LIMIT 1`).bind(b.id).first();
      await env.DB.prepare('UPDATE case_builds SET report_id = ? WHERE id = ?')
        .bind(next ? next.id : null, b.id).run();
    }
    await buildEvent(env, b.id, user, 'report_removed', null);
    return json(await buildState(env, b.case_no));
  }

  /* The Combined Summary an admin writes over a multi-day package. The
     factual synopsis beside it is derived at render time and never stored. */
  m = p.match(/^\/build\/(\d{1,12})\/summary$/);
  if (m && method === 'POST') {
    const b = await adminBuild(env, user, parseInt(m[1], 10));
    if (!b) return json({ error: 'not found' }, 404);
    if (b.status !== 'draft') return json({ error: 'Reopen the build to change it.' }, 400);
    const body = String((await readJson(request)).body || '').slice(0, 20000);
    await env.DB.prepare(
      `INSERT INTO build_summary (build_id, body, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(build_id) DO UPDATE SET body = excluded.body,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(b.id, body, nowIso(), user.id).run();
    await buildEvent(env, b.id, user, 'summary', body ? 'combined summary written' : 'combined summary cleared');
    return json(await buildState(env, b.case_no));
  }

  m = p.match(/^\/build\/(\d{1,12})\/package$/);
  if (m && method === 'POST') {
    const b = await adminBuild(env, user, parseInt(m[1], 10));
    if (!b) return json({ error: 'not found' }, 404);
    if (b.status !== 'draft') return json({ error: 'Reopen the build to change it.' }, 400);
    const pt = String((await readJson(request)).package_type || '');
    if (!['report_only', 'report_photos', 'report_photos_video', 'full', 'custom'].includes(pt)) {
      return json({ error: 'Pick a real package type.' }, 400);
    }
    /* 'custom' is a marker, not a stored enum value — see build_custom in
       schema.sql. It stores as 'full' underneath because Custom is the
       permissive case, so anything already reading package_type behaves
       sanely on a database that has never heard of the marker. */
    const stored = pt === 'custom' ? 'full' : pt;
    await env.DB.prepare('UPDATE case_builds SET package_type = ?, updated_by = ?, updated_at = ? WHERE id = ?')
      .bind(stored, user.id, nowIso(), b.id).run();
    if (pt === 'custom') {
      await env.DB.prepare('INSERT OR IGNORE INTO build_custom (build_id, at, by) VALUES (?, ?, ?)')
        .bind(b.id, nowIso(), user.id).run();
    } else {
      await env.DB.prepare('DELETE FROM build_custom WHERE build_id = ?').bind(b.id).run();
    }
    await buildEvent(env, b.id, user, 'package_type', pt);
    return json(await buildState(env, b.case_no));
  }

  m = p.match(/^\/build\/(\d{1,12})\/items$/);
  if (m && method === 'POST') {
    const b = await adminBuild(env, user, parseInt(m[1], 10));
    if (!b) return json({ error: 'not found' }, 404);
    if (b.status !== 'draft') return json({ error: 'Reopen the build to change it.' }, 400);
    const body = await readJson(request);
    const eid = parseInt(body.evidence_id, 10);
    const e = await env.DB.prepare(
      'SELECT id, filename, content_type, classification, deleted_at FROM case_evidence WHERE id = ? AND case_no = ?')
      .bind(eid, b.case_no).first();
    if (!e || e.deleted_at) return json({ error: 'That file is not on this case.' }, 400);
    /* The eligibility line: only client-deliverable material enters a
       package. Everything else is refused with its reason, not filtered
       silently — reclassifying is one click away. */
    if (e.classification !== 'client_deliverable') {
      return json({ error: `${e.filename} is marked ${e.classification.replace(/_/g, ' ')} — `
        + 'only client-deliverable material enters a package. Reclassify it first.' }, 400);
    }
    const dupe = await env.DB.prepare(
      'SELECT id FROM build_items WHERE build_id = ? AND evidence_id = ?').bind(b.id, eid).first();
    if (dupe) return json({ error: 'Already in the package.' }, 409);
    const ct = String(e.content_type || '');
    const role = ct.startsWith('image/') ? 'photo' : ct.startsWith('video/') ? 'video' : 'attachment';
    const sortRow = await env.DB.prepare(
      'SELECT COALESCE(MAX(sort), -1) AS s FROM build_items WHERE build_id = ? AND role = ?')
      .bind(b.id, role).first();
    await env.DB.prepare(
      'INSERT INTO build_items (build_id, evidence_id, role, sort, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(b.id, eid, role, (Number(sortRow && sortRow.s) ?? -1) + 1, user.id, nowIso()).run();
    await buildEvent(env, b.id, user, 'item_added', `${role}: ${e.filename}`);
    return json(await buildState(env, b.case_no), 201);
  }

  m = p.match(/^\/build\/(\d{1,12})\/items\/(\d{1,12})\/remove$/);
  if (m && method === 'POST') {
    const b = await adminBuild(env, user, parseInt(m[1], 10));
    if (!b) return json({ error: 'not found' }, 404);
    if (b.status !== 'draft') return json({ error: 'Reopen the build to change it.' }, 400);
    const r = await env.DB.prepare('DELETE FROM build_items WHERE id = ? AND build_id = ?')
      .bind(parseInt(m[2], 10), b.id).run();
    if (r.meta && r.meta.changes === 0) return json({ error: 'not found' }, 404);
    await buildEvent(env, b.id, user, 'item_removed', null);
    return json(await buildState(env, b.case_no));
  }

  m = p.match(/^\/build\/(\d{1,12})\/finalize$/);
  if (m && method === 'POST') {
    const b = await adminBuild(env, user, parseInt(m[1], 10));
    if (!b) return json({ error: 'not found' }, 404);
    if (b.status === 'finalized') return json({ error: 'Already finalized.' }, 400);
    /* A build opened before the reports were approved binds them now,
       quietly — every approved day, not just the newest. The gate only fires
       when there is genuinely nothing approved to bind. */
    const attached = await buildReports(env, b.id, b.case_no);
    if (!attached.length) {
      const seeded = await seedBuildReports(env, b.id, b.case_no, user);
      if (seeded.length) {
        if (!b.report_id) {
          const last = seeded[seeded.length - 1];
          await env.DB.prepare('UPDATE case_builds SET report_id = ?, updated_by = ?, updated_at = ? WHERE id = ?')
            .bind(last.id, user.id, nowIso(), b.id).run();
          b.report_id = last.id;
        }
        await buildEvent(env, b.id, user, 'report_attached',
          `${seeded.length} approved report(s) at finalize`);
      }
    }
    const { results: items } = await env.DB.prepare(
      'SELECT id, evidence_id, role FROM build_items WHERE build_id = ?').bind(b.id).all();
    const report = b.report_id ? await env.DB.prepare(
      'SELECT id, report_date, status FROM case_reports WHERE id = ? AND case_no = ?')
      .bind(b.report_id, b.case_no).first() : null;
    const gates = await buildGates(env, b, items || [], report,
      await buildReports(env, b.id, b.case_no), await isCustomBuild(env, b.id));
    if (gates.length) return json({ error: 'Not ready to finalize.', gates }, 400);
    await env.DB.prepare(
      'UPDATE case_builds SET status = ?, finalized_by = ?, finalized_at = ?, updated_by = ?, updated_at = ? WHERE id = ?')
      .bind('finalized', user.id, nowIso(), user.id, nowIso(), b.id).run();
    await buildEvent(env, b.id, user, 'finalized', `v${b.version}, ${(items || []).length} item(s)`);
    return json(await buildState(env, b.case_no));
  }

  m = p.match(/^\/build\/(\d{1,12})\/reopen$/);
  if (m && method === 'POST') {
    const b = await adminBuild(env, user, parseInt(m[1], 10));
    if (!b) return json({ error: 'not found' }, 404);
    if (b.status !== 'finalized') return json({ error: 'Only a finalized build reopens.' }, 400);
    await env.DB.prepare(
      'UPDATE case_builds SET status = ?, finalized_by = NULL, finalized_at = NULL, updated_by = ?, updated_at = ? WHERE id = ?')
      .bind('draft', user.id, nowIso(), b.id).run();
    await buildEvent(env, b.id, user, 'reopened', 'package rebuilt');
    return json(await buildState(env, b.case_no));
  }

  m = p.match(/^\/build\/(\d{1,12})\/delivered$/);
  if (m && method === 'POST') {
    const b = await adminBuild(env, user, parseInt(m[1], 10));
    if (!b) return json({ error: 'not found' }, 404);
    if (b.status !== 'finalized') return json({ error: 'Finalize the package before marking it delivered.' }, 400);
    await env.DB.prepare(
      'UPDATE case_builds SET delivered_by = ?, delivered_at = ?, updated_by = ?, updated_at = ? WHERE id = ?')
      .bind(user.id, nowIso(), user.id, nowIso(), b.id).run();
    await buildEvent(env, b.id, user, 'delivered', null);
    return json(await buildState(env, b.case_no));
  }

  /* The provider actions. Honest about their state: until the owner connects
     Dropbox, these name the missing configuration and block nothing else. */
  m = p.match(/^\/build\/(\d{1,12})\/(upload-videos|share)$/);
  if (m && method === 'POST') {
    const b = await adminBuild(env, user, parseInt(m[1], 10));
    if (!b) return json({ error: 'not found' }, 404);
    if (!EXTERNAL_PROVIDERS.dropbox.configured(env)) {
      return json({ error: 'Dropbox is not connected. ' + EXTERNAL_PROVIDERS.dropbox.note,
                    code: 'provider_not_configured' }, 503);
    }
    return json({ error: 'The live Dropbox integration lands after its API documentation review.' }, 501);
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/evidence$/);
  if (m && method === 'POST') return uploadEvidence(request, env, user, m[1]);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/evidence\/(\d{1,12})\/file$/);
  if (m && method === 'GET') return serveEvidence(env, user, m[1], parseInt(m[2], 10));

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/evidence\/(\d{1,12})$/);
  if (m && method === 'POST') return editEvidence(request, env, user, m[1], parseInt(m[2], 10));

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/evidence\/(\d{1,12})\/delete$/);
  if (m && method === 'POST') return deleteEvidence(env, user, m[1], parseInt(m[2], 10));

  if (p === '/storage' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return json({ storage: await evidenceUsage(env) });
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/subjects$/);
  if (m && method === 'POST') return saveSubject(request, env, user, m[1], null);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/subjects\/(\d{1,12})$/);
  if (m && method === 'POST') return saveSubject(request, env, user, m[1], parseInt(m[2], 10));

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/subjects\/(\d{1,12})\/vehicles$/);
  if (m && method === 'POST') return saveVehicle(request, env, user, m[1], parseInt(m[2], 10), null);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/subjects\/(\d{1,12})\/vehicles\/(\d{1,12})$/);
  if (m && method === 'POST') return saveVehicle(request, env, user, m[1], parseInt(m[2], 10), parseInt(m[3], 10));

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/expenses$/);
  if (m && method === 'POST') return addExpense(request, env, user, m[1]);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/expenses\/(\d{1,12})$/);
  if (m && method === 'POST') return editExpense(request, env, user, m[1], parseInt(m[2], 10));

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/expenses\/(\d{1,12})\/review$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return reviewExpense(request, env, user, m[1], parseInt(m[2], 10));
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/notes$/);
  if (m && method === 'POST') return addNote(request, env, user, m[1]);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/comms$/);
  if (m && method === 'POST') return addComm(request, env, user, m[1]);


  /* Invoicing (INVOICING.md) — the office's money desk. Admin-only in full:
     an investigator never sees a client invoice, an amount, or a payment. */
  if (p.startsWith('/invoices') || /^\/cases\/[A-Za-z0-9-]{3,64}\/invoices$/.test(p) || p === '/billing-settings') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
  }
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/invoices$/);
  if (m && method === 'POST') return createInvoice(request, env, user, m[1]);
  if (p === '/invoices' && method === 'GET') return listInvoices(request, env);
  m = p.match(/^\/invoices\/(\d{1,12})$/);
  if (m && method === 'GET') {
    const inv = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(parseInt(m[1], 10)).first();
    if (!inv) return json({ error: 'not found' }, 404);
    const full = await invoiceWithMoney(env, inv);
    const { results: events } = await env.DB.prepare(
      `SELECT e.action, e.detail, e.at, u.display_name AS who
         FROM invoice_events e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.invoice_id = ? ORDER BY e.id`).bind(inv.id).all();
    return json({ invoice: full, warnings: invoiceWarnings(full),
                  events: events || [], settings: await billingSettings(env) });
  }
  if (m && method === 'POST') return editInvoice(request, env, user, parseInt(m[1], 10));
  m = p.match(/^\/invoices\/(\d{1,12})\/lines$/);
  if (m && method === 'POST') return replaceInvoiceLines(request, env, user, parseInt(m[1], 10));
  m = p.match(/^\/invoices\/(\d{1,12})\/status$/);
  if (m && method === 'POST') return setInvoiceStatus(request, env, user, parseInt(m[1], 10));
  m = p.match(/^\/invoices\/(\d{1,12})\/bill$/);
  if (m && method === 'POST') return setInvoiceBillRefs(request, env, user, parseInt(m[1], 10));
  m = p.match(/^\/invoices\/(\d{1,12})\/payments$/);
  if (m && method === 'POST') return recordInvoicePayment(request, env, user, parseInt(m[1], 10));
  if (p === '/billing-settings' && method === 'GET') return json({ settings: await billingSettings(env) });
  if (p === '/billing-settings' && method === 'POST') {
    const body = await readJson(request);
    for (const k of Object.keys(BILLING_DEFAULTS)) {
      if (body[k] === undefined) continue;
      const v = String(body[k]).trim().slice(0, 1000);
      await env.DB.prepare(
        `INSERT INTO app_config (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(key) DO UPDATE SET value = ?2, updated_by = ?3, updated_at = ?4`)
        .bind('billing_' + k, v, user.id, nowIso()).run();
    }
    return json({ ok: true, settings: await billingSettings(env) });
  }

  /* The private-retainer record (RATESHEETS.md admin side). Consumer cases
     only — a claim assignment is authorized in hour blocks, and the two
     models never share a calculation. */
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/retainer$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    const sub = await env.DB.prepare('SELECT kind FROM submissions WHERE case_no = ?').bind(m[1]).first();
    if (!sub) return json({ error: 'not found' }, 404);
    if (sub.kind === 'claims') {
      return json({ error: 'Retainers are the private-client model — a claim assignment is authorized in hour blocks.' }, 400);
    }
    const body = await readJson(request);
    const raw = body.retainer_amount;
    const amount = raw === undefined || raw === null || String(raw).trim() === ''
      ? PERSONAL.retainer : Number(raw);
    if (!Number.isFinite(amount) || amount < 0) return json({ error: 'The retainer must be a number.' }, 400);
    const received = body.received === true || body.received === 1 || body.received === '1' ? 1 : 0;
    await env.DB.prepare(
      `INSERT INTO case_retainer (case_no, retainer_amount, received, received_at, updated_by, updated_at)
       VALUES (?1, ?2, ?3, CASE WHEN ?3 = 1 THEN ?4 ELSE NULL END, ?5, ?4)
       ON CONFLICT(case_no) DO UPDATE SET retainer_amount = ?2, received = ?3,
         received_at = CASE WHEN ?3 = 1 THEN COALESCE(case_retainer.received_at, ?4) ELSE NULL END,
         updated_by = ?5, updated_at = ?4`)
      .bind(m[1], amount, received, nowIso(), user.id).run();
    return json({ ok: true, authorization: await authorizationFor(env, m[1], true) });
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/closure$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return saveClosure(request, env, user, m[1]);
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/close$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return closeCase(env, user, m[1]);
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/tasks$/);
  if (m && method === 'POST') return addTask(request, env, user, m[1]);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/tasks\/(\d{1,12})\/status$/);
  if (m && method === 'POST') return setTaskStatus(request, env, user, m[1], parseInt(m[2], 10));

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/reports\/generate$/);
  if (m && method === 'POST') return generateReport(request, env, user, m[1]);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/reports\/(\d{1,12})$/);
  if (m && method === 'POST') return saveReport(request, env, user, m[1], parseInt(m[2], 10));

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/reports\/(\d{1,12})\/status$/);
  if (m && method === 'POST') return setReportStatus(request, env, user, m[1], parseInt(m[2], 10));

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/reports\/(\d{1,12})\/versions$/);
  if (m && method === 'GET') return reportVersions(env, user, m[1], parseInt(m[2], 10));

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/evidence\/(\d{1,12})\/link$/);
  if (m && method === 'POST') return linkEvidence(request, env, user, m[1], parseInt(m[2], 10));

  /* A real, clearly-labelled case to try the portal against. Admin only, and
     the clear route touches nothing that is not prefixed TEST-. */
  if (p === '/demo-case' && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return createDemoCase(env, user);
  }
  if (p === '/demo-case/clear' && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return clearDemoCases(env);
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/offer$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    const exists = await env.DB.prepare('SELECT 1 AS x FROM submissions WHERE case_no = ?').bind(m[1]).first();
    if (!exists) return json({ error: 'not found' }, 404);
    const body = await readJson(request);
    const uid = parseInt(body.investigator_id, 10);
    const u = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND active = 1').bind(uid).first();
    if (!u) return json({ error: 'Pick an active investigator.' }, 400);
    // Owner-operator model: one offer out at a time, no competing. A case that
    // is already assigned, or already has an offer pending, is not offered
    // again until that is resolved.
    const assigned = await env.DB.prepare(
      'SELECT assigned_to FROM submissions WHERE case_no = ?').bind(m[1]).first();
    if (assigned && assigned.assigned_to != null) {
      return json({ error: 'This case is already assigned. Unassign it first.' }, 409);
    }
    const pending = await env.DB.prepare(
      "SELECT id FROM case_offers WHERE case_no = ? AND status = 'offered'").bind(m[1]).first();
    if (pending) {
      return json({ error: 'An offer is already out on this case. Withdraw it to offer someone else.' }, 409);
    }
    const num = v => { if (v === null || v === undefined || String(v).trim() === '') return null;
      const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : undefined; };
    const hours = num(body.expected_hours), comp = num(body.compensation_hourly);
    if (hours === undefined || comp === undefined) return json({ error: 'Hours and pay must be numbers, or blank.' }, 400);
    // Default the pay to their standing rate so the offer is never blank by accident.
    let pay = comp;
    if (pay === null) {
      const r = await env.DB.prepare('SELECT hourly FROM user_rates WHERE user_id = ?').bind(uid).first();
      pay = r ? r.hourly : null;
    }
    const res = await env.DB.prepare(
      `INSERT INTO case_offers (case_no, investigator_id, offered_by, offered_at, investigation_date,
         expected_hours, general_location, instructions, compensation_hourly, mileage_terms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(m[1], uid, user.id, nowIso(),
            String(body.investigation_date || '').slice(0, 10) || null,
            hours, String(body.general_location || '').slice(0, 200) || null,
            String(body.instructions || '').slice(0, 4000) || null,
            pay, String(body.mileage_terms || '').slice(0, 200) || null).run();
    return json({ ok: true, id: res.meta ? res.meta.last_row_id : null }, 201);
  }

  m = p.match(/^\/offers\/(\d{1,12})\/withdraw$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    const r = await env.DB.prepare(
      `UPDATE case_offers SET status = 'withdrawn', responded_at = ? WHERE id = ? AND status = 'offered'`)
      .bind(nowIso(), parseInt(m[1], 10)).run();
    if (r.meta && r.meta.changes === 0) return json({ error: 'not found' }, 404);
    return json({ ok: true });
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/settings$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    const exists = await env.DB.prepare('SELECT 1 AS x FROM submissions WHERE case_no = ?').bind(m[1]).first();
    if (!exists) return json({ error: 'not found' }, 404);
    const body = await readJson(request);
    const num = v => { if (v === null || v === undefined || String(v).trim() === '') return null;
      const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : undefined; };
    const ch = num(body.client_hourly), cm = num(body.client_mileage);
    if (ch === undefined || cm === undefined) return json({ error: 'Rates must be numbers, or blank.' }, 400);
    const show = (body.show_client_identity === true || body.show_client_identity === 1 || body.show_client_identity === '1') ? 1 : 0;
    await env.DB.prepare(
      `INSERT INTO case_settings (case_no, client_hourly, client_mileage, show_client_identity, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(case_no) DO UPDATE SET client_hourly = ?2, client_mileage = ?3,
         show_client_identity = ?4, updated_by = ?5, updated_at = ?6`)
      .bind(m[1], ch, cm, show, user.id, nowIso()).run();
    return json({ ok: true, authorization: await authorizationFor(env, m[1], true) });
  }

  /* Private-case details (priority 16). Admin-only writes; the case's type
     picks which keys are stored, and everything else in the body is dropped —
     the allow-list again, so a field nobody decided to collect cannot land.
     The save replaces the bag as a whole (the form submits the whole set) and
     stamps who and when, per the handoff's audit rule. */
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/details$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    const sub = await env.DB.prepare('SELECT kind FROM submissions WHERE case_no = ?').bind(m[1]).first();
    if (!sub) return json({ error: 'not found' }, 404);
    if (sub.kind === 'claims') {
      return json({ error: 'Details are for private cases — a claim assignment carries its own claim details.' }, 400);
    }
    const body = await readJson(request);
    const meta = await env.DB.prepare(
      `SELECT t.label FROM case_meta cm LEFT JOIN case_types t ON t.id = cm.case_type_id
        WHERE cm.case_no = ?`).bind(m[1]).first();
    const setKey = detailSetFor(meta && meta.label);
    const out = {};
    for (const [k] of DETAIL_SETS[setKey]) {
      if (body[k] === undefined || body[k] === null) continue;
      const v = String(body[k]).trim().slice(0, 2000);
      if (v) out[k] = v;
    }
    await env.DB.prepare(
      `INSERT INTO case_details (case_no, detail_json, created_by, created_at, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?3, ?4)
       ON CONFLICT(case_no) DO UPDATE SET detail_json = ?2, updated_by = ?3, updated_at = ?4`)
      .bind(m[1], JSON.stringify(out), user.id, nowIso()).run();
    return json({ ok: true, details: out, detail_set: setKey });
  }

  m = p.match(/^\/users\/(\d{1,12})\/rates$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    const uid = parseInt(m[1], 10);
    const u = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(uid).first();
    if (!u) return json({ error: 'not found' }, 404);
    const body = await readJson(request);
    const num = v => { if (v === null || v === undefined || String(v).trim() === '') return null;
      const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : undefined; };
    const hourly = num(body.hourly), mileage = num(body.mileage);
    if (hourly === undefined || mileage === undefined) return json({ error: 'Rates must be numbers, or blank.' }, 400);
    await env.DB.prepare(
      `INSERT INTO user_rates (user_id, hourly, mileage, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(user_id) DO UPDATE SET hourly = ?2, mileage = ?3, updated_by = ?4, updated_at = ?5`)
      .bind(uid, hourly, mileage, user.id, nowIso()).run();
    return json({ ok: true });
  }

  /* Their own compensation — an investigator should know what they are paid,
     and it is the one rate they may see. */
  /* Offers on my desk. A pending offer is deliberately thin: the job's shape
     and my pay. No case number, no subject, no client — those arrive with
     acceptance, and acceptance is what creates access. */
  if (p === '/my/offers' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT o.id, o.status, o.offered_at, o.responded_at, o.investigation_date,
              o.expected_hours, o.general_location, o.mileage_terms,
              o.compensation_hourly, o.instructions, o.case_no,
              t.label AS case_type
         FROM case_offers o
         LEFT JOIN case_meta m ON m.case_no = o.case_no
         LEFT JOIN case_types t ON t.id = m.case_type_id
        WHERE o.investigator_id = ?
        ORDER BY o.id DESC LIMIT 50`).bind(user.id).all();
    /* ACCEPTANCE is what creates access — so anything that is not accepted
       stays thin (audit, 2026-08-14). It used to thin only the 'offered'
       state, which meant declining an offer, or an admin merely WITHDRAWING
       one, handed over the case number and the full instructions the pending
       offer had deliberately withheld. Withdrawal takes no action by the
       investigator at all: they could learn a case they never accepted. */
    const offers = (results || []).map(o => {
      if (o.status === 'accepted') return o;
      const { case_no, instructions, ...thin } = o;
      return thin;
    });
    return json({ offers });
  }

  m = p.match(/^\/my\/offers\/(\d{1,12})\/(accept|decline)$/);
  if (m && method === 'POST') {
    const oid = parseInt(m[1], 10), verb = m[2];
    const offer = await env.DB.prepare(
      'SELECT * FROM case_offers WHERE id = ? AND investigator_id = ?').bind(oid, user.id).first();
    if (!offer || offer.status !== 'offered') return json({ error: 'not found' }, 404);

    if (verb === 'decline') {
      const reason = String((await readJson(request)).reason || '').slice(0, 500) || null;
      await env.DB.prepare(
        `UPDATE case_offers SET status = 'declined', responded_at = ?, decline_reason = ? WHERE id = ?`)
        .bind(nowIso(), reason, oid).run();
      return json({ ok: true, status: 'declined' });
    }
    // Accept: the case must still be free — first acceptance wins.
    const row = await env.DB.prepare(
      'SELECT assigned_to FROM submissions WHERE case_no = ?').bind(offer.case_no).first();
    if (!row) return json({ error: 'not found' }, 404);
    if (row.assigned_to != null && row.assigned_to !== user.id) {
      await env.DB.prepare(
        `UPDATE case_offers SET status = 'withdrawn', responded_at = ? WHERE id = ?`).bind(nowIso(), oid).run();
      return json({ error: 'This assignment has already been taken.' }, 409);
    }
    await env.DB.prepare(
      `UPDATE submissions SET assigned_to = ?, status = 'assigned' WHERE case_no = ?`)
      .bind(user.id, offer.case_no).run();
    await setStage(env, user, offer.case_no, 'assigned');
    await env.DB.prepare(
      `UPDATE case_offers SET status = 'accepted', responded_at = ? WHERE id = ?`).bind(nowIso(), oid).run();
    // Anyone else still holding a pending offer on this case loses it quietly.
    await env.DB.prepare(
      `UPDATE case_offers SET status = 'withdrawn', responded_at = ?
        WHERE case_no = ? AND status = 'offered'`).bind(nowIso(), offer.case_no).run();
    return json({ ok: true, status: 'accepted', case_no: offer.case_no });
  }

  /* The shared operational calendar (HANDOFF priority 14). Admin sees every
     investigator's days and every pending offer; an investigator sees their
     own. Events come from investigation days (worked or running) and offer
     dates — a pending offer stays thin here exactly as it is on Today. */
  if (p === '/calendar' && method === 'GET') {
    const q = new URL(request.url).searchParams;
    const month = /^\d{4}-\d{2}$/.test(q.get('month') || '') ? q.get('month') : nowIso().slice(0, 7);
    const admin = user.role === 'admin';
    const like = month + '%';

    const { results: days } = await env.DB.prepare(
      `SELECT d.id, d.case_no, d.day_date, d.start_time, d.end_time, d.hours,
              u.display_name AS investigator, s.kind, t.label AS case_type
         FROM case_days d
         LEFT JOIN users u ON u.id = d.investigator_id
         LEFT JOIN submissions s ON s.case_no = d.case_no
         LEFT JOIN case_meta cm ON cm.case_no = d.case_no
         LEFT JOIN case_types t ON t.id = cm.case_type_id
        WHERE d.day_date LIKE ? ${admin ? '' : 'AND d.investigator_id = ?'}
        ORDER BY d.day_date, d.start_time`)
      .bind(...(admin ? [like] : [like, user.id])).all();

    const { results: offers } = await env.DB.prepare(
      `SELECT o.id, o.investigation_date, o.expected_hours, o.general_location, o.status,
              ${admin ? 'o.case_no, u.display_name AS investigator,' : ''}
              s.kind, t.label AS case_type
         FROM case_offers o
         LEFT JOIN users u ON u.id = o.investigator_id
         LEFT JOIN submissions s ON s.case_no = o.case_no
         LEFT JOIN case_meta cm ON cm.case_no = o.case_no
         LEFT JOIN case_types t ON t.id = cm.case_type_id
        WHERE o.status = 'offered' AND o.investigation_date LIKE ?
          ${admin ? '' : 'AND o.investigator_id = ?'}
        ORDER BY o.investigation_date`)
      .bind(...(admin ? [like] : [like, user.id])).all();

    return json({ month, days: days || [], offers: offers || [] });
  }

  if (p === '/my/comp' && method === 'GET') {
    const r = await env.DB.prepare('SELECT hourly, mileage FROM user_rates WHERE user_id = ?')
      .bind(user.id).first();
    return json({ hourly: r ? r.hourly : null, mileage: r ? r.mileage : null });
  }

  if (p === '/my/reports' && method === 'GET') return myReports(env, user);
  if (p === '/my/expenses' && method === 'GET') return myExpenses(env, user);

  if (p === '/case-types' && method === 'GET') return json({ case_types: await listCaseTypes(env) });
  if (p === '/case-types' && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    const body = await readJson(request);
    const label = String(body.label || '').trim().slice(0, 80);
    const side = String(body.side || '');
    if (!label) return json({ error: 'Name the case type.' }, 400);
    if (!['insurance', 'private'].includes(side)) return json({ error: 'Pick insurance or private.' }, 400);
    try {
      await env.DB.prepare('INSERT INTO case_types (label, side) VALUES (?, ?)').bind(label, side).run();
    } catch { return json({ error: 'That case type already exists.' }, 409); }
    return json({ ok: true, case_types: await listCaseTypes(env) }, 201);
  }

  if (p === '/users' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return listUsers(env);
  }
  // There is deliberately no route that creates an account directly. Accounts
  // exist only by redeeming an invitation, so nobody sets another person's
  // password — not even an admin.
  if (p === '/invites' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return listInvites(env);
  }
  if (p === '/invites' && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return createInvite(request, env, user);
  }
  m = p.match(/^\/invites\/(\d+)\/revoke$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return revokeInvite(env, m[1]);
  }

  m = p.match(/^\/users\/(\d+)\/active$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return setUserActive(request, env, m[1], user);
  }

  /* Full account deletion, behind the disable flow's yes/no. History wins:
     an account with recorded case work can never be deleted — its stamps ARE
     the case record — it stays disabled instead. A never-used or mistaken
     account deletes cleanly, sessions and all. */
  m = p.match(/^\/users\/(\d+)\/delete$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    const uid = parseInt(m[1], 10);
    if (uid === user.id) return json({ error: 'You cannot delete your own account.' }, 400);
    const u = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(uid).first();
    if (!u) return json({ error: 'not found' }, 404);
    if (u.role === 'admin') {
      const others = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM users WHERE role = ? AND active = 1 AND id != ?')
        .bind('admin', uid).first();
      if (!others || Number(others.n) < 1) {
        return json({ error: 'That is the last active admin — the portal cannot be left without one.' }, 400);
      }
    }
    const work = [
      ['submissions', 'assigned_to'], ['case_days', 'investigator_id'],
      ['activity_log', 'investigator_id'], ['case_reports', 'investigator_id'],
      ['case_expenses', 'investigator_id'], ['case_notes', 'author_id'],
      ['case_offers', 'investigator_id'], ['case_tasks', 'assigned_to'],
      ['case_evidence', 'uploaded_by'],
    ];
    for (const [table, col] of work) {
      const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).bind(uid).first();
      if (r && Number(r.n) > 0) {
        return json({ error: 'This account has recorded case work, so it stays — deleted accounts would '
          + 'leave holes in the case history. It is disabled; that is the right end state.',
          code: 'has_work' }, 409);
      }
    }
    for (const sql of [
      'DELETE FROM sessions WHERE user_id = ?',
      'DELETE FROM password_resets WHERE user_id = ?',
      'DELETE FROM user_rates WHERE user_id = ?',
      'DELETE FROM users WHERE id = ?',
    ]) await env.DB.prepare(sql).bind(uid).run();
    return json({ ok: true, deleted: true });
  }

  m = p.match(/^\/users\/(\d+)\/reset-link$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    const uid = parseInt(m[1], 10);
    const u = await env.DB.prepare('SELECT id, active FROM users WHERE id = ?').bind(uid).first();
    if (!u) return json({ error: 'not found' }, 404);
    const token = randomHex(32);
    // A fresh link quietly retires any earlier one for the same person.
    await env.DB.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').bind(uid).run();
    await env.DB.prepare(
      `INSERT INTO password_resets (token_hash, user_id, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`)
      .bind(await sha256Hex(token), uid, user.id, nowIso(),
            new Date(Date.now() + 24 * 3600_000).toISOString()).run();
    return json({ ok: true, url: `${env.SITE_ORIGIN || ''}/portal/?reset=${token}`, expires_hours: 24 }, 201);
  }

  m = p.match(/^\/users\/(\d+)\/password$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return resetPassword(request, env, m[1]);
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    let res;
    try {
      // A cross-origin caller is never legitimate here: the page is served from
      // the same site, and everything else authenticates with a token. This is
      // decided inside the try so the rejection leaves through the same
      // hardening as every other response.
      res = originAllowed(request, env)
        ? await route(request, env)
        : json({ error: 'not authorised' }, 403);
    } catch (e) {
      // Never return the raw error: it can carry SQL and column names.
      console.error('portal error', e && e.stack ? e.stack : e);
      // One exception, because "something went wrong" sent a real admin round
      // in circles: a missing table means the schema has not been applied, and
      // the fix is a workflow run rather than anything to debug. Naming the
      // condition leaks nothing — the remedy is in the README either way.
      const msg = String((e && e.message) || '');
      res = /no such table|no such column/i.test(msg)
        ? json({
            error: 'The database is missing tables this needs. Run the "Set up the case portal" '
                 + 'workflow in GitHub Actions to apply the schema, then try again.',
            code: 'schema_out_of_date',
          }, 503)
        : json({ error: 'Something went wrong handling that request.' }, 500);
    }
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(res.body, { status: res.status, headers });
  },
};
