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
      summary: `Surveillance is authorized in blocks of hours. ${money(RATES.surveillance.minHoursPerDay)}`
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

async function caseSummary(env, user) {
  const scope = user.role === 'admin' ? '' : 'WHERE assigned_to = ?';
  const binds = user.role === 'admin' ? [] : [user.id];
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
  // Unassigned work an admin should be looking at first.
  if (user.role === 'admin') {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM submissions WHERE assigned_to IS NULL AND status != 'closed'").first();
    out.unassigned = row ? Number(row.n) || 0 : 0;
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

async function route(request, env) {
  const url = new URL(request.url);
  // The Worker is mounted on /portal-api/* on the site's own domain; strip that
  // prefix so the routes below read the same either way.
  let p = url.pathname;
  if (p === API_PREFIX || p.startsWith(API_PREFIX + '/')) p = p.slice(API_PREFIX.length) || '/';
  p = p.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (p === '/health') {
    return json({ ok: true, configured: Boolean(env.DB && env.INGEST_KEY), email: Boolean(env.RESEND_API_KEY) });
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
      res = json({ error: 'Something went wrong handling that request.' }, 500);
    }
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(res.body, { status: res.status, headers });
  },
};
