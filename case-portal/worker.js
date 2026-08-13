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
  packages: [
    { hours: 8,  price: 1200, label: 'One day — 8 hours',
      note: 'The minimum surveillance day, at the standard rate.' },
    { hours: 16, price: 2300, label: 'Two days — 16 hours',
      note: '$100 below the standard rate for the commitment.' },
    { hours: 24, price: 3300, label: 'Three days — 24 hours',
      note: 'The usual initial authorization. $300 below standard, inside the preferred-volume band.' },
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

/* The two documents the office sends a client. They live here, not on the
   public site, because no quote or price is shown to anyone who has not asked
   for one: a private client gets the retainer sheet, a carrier gets the block
   ladder, and neither sees the other's numbers.

   `id` is what the email endpoint takes, so keep an id stable once it has been
   sent to anyone. Prices come from RATES and the constants below — nothing here
   restates a figure that is set elsewhere. */
const PERSONAL = { retainer: 1500, hourly: 100, minHours: 4 };

function rateSheets() {
  const money = n => '$' + Number(n).toLocaleString('en-US');
  const inc = 'Mileage, travel time, tolls, parking, database and record fees, '
            + 'video review and the written report are all included.';
  return [
    {
      id: 'personal',
      name: `${money(PERSONAL.retainer)} retainer`,
      audience: 'Private clients — surveillance, domestic and family matters',
      summary: `${money(PERSONAL.retainer)} to begin, applied to the work performed, then `
             + `${money(PERSONAL.hourly)} an hour with a ${PERSONAL.minHours}-hour minimum.`,
      lines: [
        { label: 'Retainer to begin', value: money(PERSONAL.retainer),
          note: 'Applied in full to the work performed — it is not a separate charge.' },
        { label: 'Hourly rate', value: `${money(PERSONAL.hourly)}/hr`,
          note: `${PERSONAL.minHours}-hour minimum engagement.` },
        { label: 'Additional fees', value: 'None', note: inc },
        { label: 'Beyond the retainer', value: `${money(PERSONAL.hourly)}/hr`,
          note: 'Only ever with your approval first. Nothing is spent without asking you.' },
      ],
      closing: 'Work begins once the retainer is received. You get a written report with '
             + 'time-stamped photographs and video, and the investigator who did the work '
             + 'can testify to what they personally observed.',
    },
    {
      id: 'insurance',
      name: 'Insurance assignment rates',
      audience: 'Carriers, TPAs, self-insured employers, SIU and defense counsel',
      // Hours are hours. money() belongs on prices only — it once rendered
      // this as "$8-hour minimum day".
      summary: `Surveillance is authorized in blocks of hours. ${RATES.surveillance.minHoursPerDay}`
             + `-hour minimum day; ${RATES.surveillance.typicalAuthHours} hours is the usual initial authorization.`,
      lines: [
        ...RATES.packages.map(p => ({
          label: p.label, value: money(p.price), note: p.note,
        })),
        { label: 'Additional hours', value: `${money(RATES.surveillance.standard)}/hr`,
          note: 'Never incurred without written approval from the assigning contact.' },
        { label: 'Additional fees', value: 'None', note: inc },
        { label: 'Outside the service area', value: 'Quoted first',
          note: 'Travel is quoted and agreed before the assignment is accepted, never added afterwards.' },
      ],
      closing: 'Rates are confirmed in writing before any work begins. Submitting an assignment '
             + 'does not by itself constitute acceptance. Deliverables are a written activity '
             + 'report tied to time-stamped video and photographs, with the source footage.',
    },
  ];
}

function sheetById(id) { return rateSheets().find(s => s.id === id) || null; }

async function emailSheet(request, env, id) {
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

  if (!(await withinRateLimit(env, 'mail'))) {
    return json({ error: 'Too many emails in one minute — wait a moment and send again.' }, 429);
  }

  const { text, html } = sheetEmail(sheet, note);
  const subject = caseNo
    ? `${sheet.name} — Always Precise Investigations (case ${caseNo})`
    : `${sheet.name} — Always Precise Investigations`;

  const mail = await sendMail(env, { to, subject, text, html });
  if (!mail.sent) {
    return json({
      error: mail.reason === 'not_configured'
        ? 'Email is not configured on the Worker. Add RESEND_API_KEY to send from here.'
        : 'That did not send. Check the address and try again.',
      reason: mail.reason,
    }, 502);
  }
  return json({ ok: true, sent_to: to, sheet: sheet.id });
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

  return json({ summary: out });
}

/* The email. Plain text alongside the HTML so it stays readable in a client
   that blocks markup, and so an adjuster forwarding it to their approver does
   not send them a broken page. */
function sheetEmail(sheet, note) {
  const rows = sheet.lines.map(l =>
    `  ${l.label}: ${l.value}\n     ${l.note}`).join('\n');
  const text =
`${sheet.name}
Always Precise Investigations, LLC — Va DCJS #11-9159

${sheet.summary}
${note ? `\n${note}\n` : ''}
${rows}

${sheet.closing}

Questions: (434) 907-0975
Always Precise Investigations, LLC`;

  const html =
`<div style="font-family:'Segoe UI',Arial,sans-serif;color:#1c2531;line-height:1.55;max-width:560px">
  <h2 style="margin:0 0 2px;color:#12305a">${escHtml(sheet.name)}</h2>
  <p style="margin:0 0 18px;font-size:.82rem;color:#5c6775;letter-spacing:.04em;text-transform:uppercase">
    Always Precise Investigations, LLC &middot; Va DCJS #11-9159</p>
  <p style="margin:0 0 18px">${escHtml(sheet.summary)}</p>
  ${note ? `<p style="margin:0 0 18px;padding:12px 14px;background:#f4f8fa;border-left:3px solid #2f7d90">${escHtml(note)}</p>` : ''}
  <table style="width:100%;border-collapse:collapse;margin:0 0 18px">
    ${sheet.lines.map(l => `<tr>
      <td style="padding:11px 0;border-bottom:1px solid #e4e9ed;vertical-align:top">
        <b>${escHtml(l.label)}</b>
        <div style="font-size:.86rem;color:#5c6775">${escHtml(l.note)}</div>
      </td>
      <td style="padding:11px 0;border-bottom:1px solid #e4e9ed;text-align:right;
                 white-space:nowrap;font-weight:700;vertical-align:top">${escHtml(l.value)}</td>
    </tr>`).join('')}
  </table>
  <p style="font-size:.92rem">${escHtml(sheet.closing)}</p>
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
];

/* The denormalised columns carry the same identities as the payload does — a
   claim number is the carrier's own reference, so it names them just as
   plainly. Dropped from list rows and detail rows alike. */
function redactRow(row) {
  const { carrier, claim_number, client_name, client_email, client_phone, ...rest } = row;
  return rest;
}

function redactPayload(payload) {
  const kept = {};
  for (const k of FIELD_KEEP) if (payload[k] !== undefined) kept[k] = payload[k];
  return kept;
}

async function listSubmissions(request, env, user) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, LIST_LIMIT_MAX);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

  // An investigator sees only what is assigned to them. This is enforced here,
  // in the query, rather than by the page hiding rows.
  const scope = user.role === 'admin' ? '' : 'WHERE s.assigned_to = ?';
  const binds = user.role === 'admin' ? [limit, offset] : [user.id, limit, offset];

  const { results } = await env.DB.prepare(
    `SELECT s.case_no, s.kind, s.service, s.status, s.client_name, s.subject_name,
            s.carrier, s.claim_number, s.created_at, s.assigned_to, u.display_name AS assigned_name
       FROM submissions s LEFT JOIN users u ON u.id = s.assigned_to
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
  if (user.role !== 'admin') return json({ submission: { ...redactRow(row), payload: redactPayload(payload) } });
  return json({ submission: { ...row, payload } });
}

async function assignSubmission(request, env, caseNo) {
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
  return json({ ok: true, case_no: caseNo, assigned_to: userId, status });
}

async function setStatus(request, env, caseNo) {
  const body = await readJson(request);
  const status = String(body.status || '');
  if (!['new', 'assigned', 'in_progress', 'closed'].includes(status)) {
    return json({ error: 'invalid status' }, 400);
  }
  const res = await env.DB.prepare('UPDATE submissions SET status = ? WHERE case_no = ?')
    .bind(status, caseNo).run();
  if (res.meta && res.meta.changes === 0) return json({ error: 'not found' }, 404);
  return json({ ok: true, case_no: caseNo, status });
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
    const budget = meta && meta.authorized_budget != null ? Number(meta.authorized_budget) : null;
    const billable = Math.round(hoursUsed * RATES.surveillance.standard * 100) / 100;
    out.authorized_budget = budget;
    out.billable_so_far = billable;
    out.budget_remaining = budget == null ? null : Math.round((budget - billable) * 100) / 100;
    out.billed_at_rate = RATES.surveillance.standard;
  }
  return out;
}

async function caseWorkspace(env, user, caseNo) {
  const row = await caseFor(env, user, caseNo);
  if (!row) return json({ error: 'not found' }, 404);
  const admin = user.role === 'admin';

  const { results: activity } = await env.DB.prepare(
    `SELECT a.id, a.day_id, a.at_date, a.at_time, a.kind, a.description, a.location,
            a.vehicle, a.internal_note, a.edited_at, u.display_name AS investigator,
            COALESCE(m.subject_documented, 0) AS subject_documented,
            COALESCE(m.video_acquired, 0) AS video_acquired,
            COALESCE(m.photo_acquired, 0) AS photo_acquired
       FROM activity_log a LEFT JOIN users u ON u.id = a.investigator_id
       LEFT JOIN activity_media m ON m.entry_id = a.id
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
  const openDay = await env.DB.prepare(
    `SELECT id, day_date, start_time, start_mileage FROM case_days
      WHERE case_no = ? AND investigator_id = ? AND end_time IS NULL
      ORDER BY id DESC LIMIT 1`).bind(caseNo, user.id).first();

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

  return json({
    case_no: row.case_no,
    kind: row.kind,
    status: row.status,
    authorization: await authorizationFor(env, caseNo, admin),
    case_types: admin ? await listCaseTypes(env) : [],
    activity: activity || [],
    days: days || [],
    open_day: openDay || null,
    reports: reports || [],
    expenses: expenses || [],
    notes: notes || [],
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
  const hours = Math.round((span / 60) * 100) / 100;
  const miles = endMiles != null && day.start_mileage != null
    ? Math.round((endMiles - day.start_mileage) * 10) / 10 : null;

  await env.DB.prepare(
    `UPDATE case_days SET end_time = ?, end_mileage = ?, hours = ?, miles = ?,
            summary = ?, ended_at = ? WHERE id = ?`)
    .bind(time, endMiles, hours, miles, String(body.summary || '').slice(0, 4000), nowIso(), day.id).run();

  return json({ ok: true, day_id: day.id, hours, miles,
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

/* Edits are stamped, never silent. There is deliberately no delete route: an
   investigative timeline that can be quietly erased is worth less in a
   hearing than one that shows its corrections. */
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
  let visibility = String(body.visibility || 'team');
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

  const { results } = await env.DB.prepare(
    `SELECT a.at_time, a.description, a.location,
            COALESCE(m.subject_documented, 0) AS subject_documented,
            COALESCE(m.video_acquired, 0) AS video_acquired,
            COALESCE(m.photo_acquired, 0) AS photo_acquired
       FROM activity_log a LEFT JOIN activity_media m ON m.entry_id = a.id
      WHERE a.case_no = ? AND a.day_id = ? ORDER BY a.at_time ASC, a.id ASC`).bind(caseNo, dayId).all();

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
  return json({ ok: true, id, status: next });
}

/* ----------------------------------------------------------------- users */

async function listUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, username, display_name, role, active, created_at, last_login_at
       FROM users ORDER BY role, username`).all();
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
    return json({
      ok: true,
      configured: Boolean(env.DB && env.INGEST_KEY),
      email: Boolean(env.RESEND_API_KEY),
      // Which tables are actually there. The portal checks this on load so a
      // half-applied schema announces itself, instead of waiting for whichever
      // button happens to touch a missing table first.
      missing_tables: await missingTables(env),
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
    return assignSubmission(request, env, m[1]);
  }

  m = p.match(/^\/submissions\/([A-Za-z0-9-]{3,64})\/status$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return setStatus(request, env, m[1]);
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

  m = p.match(/^\/sheets\/([a-z]{3,20})\/email$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return emailSheet(request, env, m[1]);
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

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/activity$/);
  if (m && method === 'POST') return addActivity(request, env, user, m[1]);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/activity\/(\d{1,12})$/);
  if (m && method === 'POST') return editActivity(request, env, user, m[1], parseInt(m[2], 10));

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

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/reports\/generate$/);
  if (m && method === 'POST') return generateReport(request, env, user, m[1]);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/reports\/(\d{1,12})$/);
  if (m && method === 'POST') return saveReport(request, env, user, m[1], parseInt(m[2], 10));

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/reports\/(\d{1,12})\/status$/);
  if (m && method === 'POST') return setReportStatus(request, env, user, m[1], parseInt(m[2], 10));

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
