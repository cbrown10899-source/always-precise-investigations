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
/* SURVEILLANCE-VOICE.md §3. A closed list, matching the CHECK on the column:
   an unknown value is dropped rather than stored, so this can never become a
   free-text field somebody puts a sentence in. */
const ACTIVITY_SOURCES = ['voice'];

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

/** HMAC-SHA256, hex. For signing short-lived state that leaves the Worker and
    comes back through a third party. */
async function hmacHex(key, message) {
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
}

/** Compare two hex strings without leaking where they first differ. */
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
  /* A username that cannot belong to an account is refused BEFORE it reaches
     login_fails (closeout audit, 2026-09-03). That table is keyed by the name
     supplied, is written on every failure and is pruned only per-username on
     a successful sign-in — so an unauthenticated caller could write unbounded
     permanent rows by inventing a new name each time, into the one database
     every route shares. Same alphabet the account and invite writers enforce,
     and the same 401 wording, so nothing is enumerable. */
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return json({ error: 'Those details do not match an account.' }, 401);
  }

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
/* The /health storage figure, a minute at a time — keyed by the DATABASE, not
   held as one module global. An isolate serves one database in production, but
   a global would still be the wrong shape: the suite runs many databases
   through one process and caught it immediately, answering one env's figure
   for another's. A WeakMap keyed on the binding cannot make that mistake. */
const HEALTH_CACHE = new WeakMap();

async function withinRateLimit(env, kind) {
  const mail = kind === 'mail';
  const cap = mail
    ? (parseInt(env.MAIL_PER_MINUTE || '', 10) || 20)
    : (parseInt(env.INGEST_PER_MINUTE || '', 10) || INGEST_PER_MINUTE);
  const minute = nowIso().slice(0, 16);   // YYYY-MM-DDTHH:MM
  const key = mail ? 'mail:' + minute : minute;
  /* READ BEFORE WRITE (closeout audit, 2026-09-03). This upserted, read and
     swept on EVERY call — two writes and a read spent before deciding whether
     the caller was over the cap — so a flood of REJECTED requests was itself
     the unbounded cost the cap exists to bound, against the one database
     every authenticated route shares. Over the cap now costs one read and
     writes nothing. Everyone under it still increments and is judged on the
     re-read, so two requests racing at the line resolve exactly as before. */
  const seen = await env.DB.prepare('SELECT n FROM ingest_rate WHERE minute = ?').bind(key).first();
  if (seen && seen.n >= cap) return false;
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

/* Read a request body up to `max` bytes; null the moment it exceeds them. */
async function readBounded(request, max) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch { /* already gone */ } return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(total); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(all);
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
  /* A chunked request declares no length, so the header check above never
     fires for it and the whole body used to be buffered before the size test
     (closeout audit, 2026-09-03). The stream is read up to the cap and
     abandoned the byte it is exceeded, whatever the headers said. */
  const raw = await readBounded(request, MAX_PAYLOAD_BYTES);
  if (raw === null) return json({ error: 'payload too large' }, 413);

  if (!(await withinRateLimit(env))) return json({ error: 'too many submissions' }, 429);

  let p;
  try { p = JSON.parse(raw); } catch { return json({ error: 'invalid json' }, 400); }
  const caseNo = String(p.case_no || '').trim();
  if (!caseNo) return json({ error: 'case_no is required' }, 400);
  // A case number reaches the admin's browser, so its shape is checked here
  // rather than trusted. Anything outside this alphabet is rejected outright.
  if (!CASE_NO_RE.test(caseNo)) return json({ error: 'case_no has an unexpected format' }, 400);

  /* UNIT 6 — a legal assignment arrives kind='consumer' (D1: the CHECK cannot
     widen, and consumer is what makes the private pricing structural), marked
     by its own payload. The marker is explicit from the form, never inferred:
     a legal payload that also carried a carrier field must not silently file
     as a claim. */
  const legal = p.assignment === 'legal';
  const kind = !legal && (p.claim_number || p.carrier) ? 'claims' : 'consumer';
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
    if (String(e).includes('UNIQUE')) {
      /* A browser RETRY resends the identical body and must not surface as an
         error — that rule stands. But a DIFFERENT submission under a taken
         number is a COLLISION, and "recorded" would be a lie to the client
         and a notice to the firm pointing at someone else's file (closeout
         audit, 2026-09-03). The intake mints its number from 9,000 daily
         values, so a clash is reachable by chance; the page re-mints once on
         this code and tries again. */
      const prior = await env.DB.prepare('SELECT payload FROM submissions WHERE case_no = ?')
        .bind(caseNo).first();
      if (prior && prior.payload === raw) return json({ ok: true, duplicate: true });
      return json({ error: 'That case number is already in use.', code: 'case_no_taken' }, 409);
    }
    throw e;
  }
  /* The structured legal row. GUARDED: schema.sql arrives by a manual
     portal-setup dispatch, so this table can be absent on the live database.
     The intake is NOT refused for that — the whole payload is already stored
     on the submission row, so nothing is lost; the admin's first Save on the
     Legal panel structures it once the table exists. */
  if (legal && !(await missingTables(env)).includes('legal_intake')) {
    try { await writeLegalRow(env, caseNo, p, null); } catch { /* payload holds it */ }
  }
  // The case is recorded; telling the office is a courtesy that cannot fail it.
  await notifyAdmins(env, 'intakes', caseNo);
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

/* THE TWO FLAT-FEE LEGAL SERVICES (LEGAL-SERVICES.md D1, owner 2026-09-02) and
   THE ONLY PLACE THEIR FIGURES ARE SET. The catalogue, the fixed sheets, the
   workspace money block, the invoice block and the case list all read from
   here — the PERSONAL / RATES rule applied to legal flat fees. The fixed-sheet
   builder deliberately contains no digit literal; a source test pins that. */
const LEGAL_FLAT = { locate: 250, process: 250 };

/* How a private client's retainer can arrive (PAYMENTS.md §5/§11, corrected by
   the owner 2026-08-15). Validated here rather than by a CHECK constraint on
   the table: schema.sql is re-applied on every portal-setup run and a CHECK
   cannot be widened in place, so a list that changes belongs in code — which
   this one promptly did.

   CREDIT CARD AND OTHER ARE DELIBERATELY ABSENT. The firm does not accept
   them. Offering a method it cannot take invites a client to try paying by one,
   and that failure lands on the client mid-retainer while the office only finds
   out when the money never arrives. "Other" is worse than useless in a payment
   record: it states that money came in by a means nobody wrote down, which is
   the precise thing a payment record exists to prevent. The original handoff
   listed both; the correction is later and governs. */
const RETAINER_METHODS = ['cash_app', 'venmo', 'check', 'cash', 'ach_bill', 'mail_check'];
const RETAINER_METHOD_LABEL = {
  cash_app: 'Cash App', venmo: 'Venmo', check: 'Check', cash: 'Cash',
  ach_bill: 'ACH / BILL',
  /* MAIL-CHECK.md (owner, 2026-09-01): how a LEGAL retainer arrives when the
     firm mails one. This column carries no CHECK — the list above is the
     validation — so the method is a real recorded value, not a relabel. */
  mail_check: 'Mail Check',
};

/* THE AGREED RETAINER IS THE CASE'S, NOT THE STANDARD ONE.

   `PERSONAL.retainer` is where a private case starts. Once the office agrees
   $2,000 or $3,000 with a client, THAT is the figure the sheet, the subject
   line, the payment block and the on-screen preview must all carry — a case
   whose stored retainer is $3,000 was emailing a sheet that said $1,500, which
   is a wrong number in front of the person who agreed the right one.

   One read, passed down, so the four places cannot disagree. The rate and the
   4-hour minimum are unchanged: only the retainer is per-case. */
async function agreedRetainer(env, caseNo) {
  if (!caseNo) return PERSONAL.retainer;
  const row = await env.DB.prepare(
    'SELECT retainer_amount FROM case_retainer WHERE case_no = ?').bind(caseNo).first();
  return row && row.retainer_amount != null ? Number(row.retainer_amount) : PERSONAL.retainer;
}

/* THE FIGURE THIS SEND CARRIES, when there may be no case to read it from.

   Pre-case sends (#127) let the office email someone who is not on the desk
   yet, and the case number is a subject-line reference that may match nothing.
   `agreedRetainer` cannot serve that: it answers PERSONAL.retainer both when a
   case agreed the standard figure and when there is no case at all, so a
   $2,000 quote to a new caller came out as $1,500.

   A case that has AGREED a figure still owns it. An offered amount is honoured
   ONLY where nothing is stored, and then for this one send — so a caller can
   never overwrite what the office recorded, which is the rule #123 exists to
   keep. Both the preview and the email resolve through here, so the screen and
   the client cannot disagree; that was the actual defect in #123, and it is
   prevented by a shared source rather than by persisting first. */
async function retainerForSend(env, caseNo, offered) {
  const row = caseNo
    ? await env.DB.prepare('SELECT retainer_amount FROM case_retainer WHERE case_no = ?')
        .bind(caseNo).first()
    : null;
  if (row && row.retainer_amount != null) return Number(row.retainer_amount);
  const n = Number(offered);
  return Number.isFinite(n) && n > 0 && n <= 1000000 ? n : PERSONAL.retainer;
}

function rateSheets(retainer) {
  const money = n => '$' + Number(n).toLocaleString('en-US');
  /* Anything absent, zero or unparseable falls back to the standard figure —
     a sheet must never print $0 or NaN at a client. */
  const ret = Number(retainer) > 0 ? Number(retainer) : PERSONAL.retainer;
  return [
    {
      id: 'private_retainer',
      type: 'retainer',
      name: `${money(ret)} Retainer`,
      selector_label: `Private Client — ${money(ret)} Retainer`,
      audience: 'Private surveillance, domestic and family investigations',
      summary: `A ${money(ret)} retainer is required to begin. The retainer is `
             + `applied directly to authorized investigative services billed at `
             + `${money(PERSONAL.hourly)} per hour.`,
      lines: [
        { label: 'Retainer to begin', value: money(ret), big: true,
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
        /* MAIL-CHECK.md (owner, 2026-09-01) — the wording is the owner's,
           verbatim, and the ADDRESS IS NOT HERE by the owner's own rule: the
           sheet may say checks are accepted, the mailing details ride only
           with an invoice. */
        MAIL_CHECK_LINE,
      ],
      closing_title: 'Clear pricing. No surprise billing.',
      closing: 'Rates and authorization are confirmed in writing before investigative work '
             + 'begins. Submission of an assignment does not by itself constitute acceptance. '
             + 'Surveillance deliverables generally include an investigative activity report '
             + 'supported by available time-stamped photographs and video.',
    },
  ];
}

function sheetById(id, retainer) { return rateSheets(retainer).find(s => s.id === id) || null; }

/* THE THREE CARDS ON THE RATE SHEETS SCREEN ARE THREE CONTEXTS, NOT THREE
   PRICE LISTS (Unit 28; owner: "Do NOT create a third independent pricing
   source").

   `rateSheets()` above stays the ONLY place a figure is set. This is a thin
   presentation layer over it: the Legal card IS the private retainer product —
   the same lines, the same numbers, resolved by the same `agreedRetainer()` —
   wearing the label a law firm should see and carrying the LEGAL context.
   Change a price in `rateSheets()` and all three cards move together, because
   there is nothing here that could fall out of step with it.

   `key` is the CARD's identity (what the screen opens); `id` is the SHEET
   PRODUCT that is actually sent. They differ for legal on purpose, and that
   difference IS the architecture: the sheet is the product, and the context
   decides the intake door and whether payment instructions may ride along. */
/* The card a send should be WRITTEN from: the one whose product and context
   both match. Falls back to the product itself, so an unknown context still
   produces the ordinary sheet rather than nothing. */
function sheetForContext(sheetId, ctx, retainer) {
  const cards = sheetCards(retainer);
  return cards.find(c => c.id === sheetId && c.context === ctx)
      || cards.find(c => c.id === sheetId)
      || sheetById(sheetId, retainer);
}

function sheetCards(retainer) {
  const sheets = rateSheets(retainer);
  const by = id => sheets.find(s => s.id === id);
  const priv = by('private_retainer');
  const ins = by('insurance_assignment');
  const cards = [];
  if (priv) cards.push({ ...priv, key: 'private', context: SEND_CONTEXT.PRIVATE });
  if (ins) cards.push({ ...ins, key: 'insurance', context: SEND_CONTEXT.INSURANCE });
  if (priv) {
    cards.push({
      ...priv,
      key: 'legal',
      context: SEND_CONTEXT.LEGAL,
      /* NAMED FOR WHO RECEIVES IT. The figures are the private client's; the
         label, the audience and the closing are a law firm's. */
      selector_label: `Legal / Law Firm — ${priv.name}`,
      audience: 'Law firms, attorneys and paralegals',
      closing_title: 'Billed to the firm. No surprise billing.',
      /* THE APPROVED LEGAL ARRANGEMENTS AND NOTHING ELSE. Cash App and Venmo
         are private-client methods and reach a law firm through no path —
         `CONTEXT_TAKES_PAYMENT` refuses the payment block on this context, and
         this sentence is what stands in its place. The four arrangements are
         the ones already on the legal case panel; no new billing policy is
         invented here. */
      closing: 'Work begins once the retainer and required authorization are received. '
             + 'Law firms are billed by invoice — BILL.com invoice or ACH, check by mail, '
             + 'or a retainer check held for pick-up at the firm\u2019s office — and an '
             + 'existing billing arrangement is honoured where one is on file. Rates and '
             + 'authorization are confirmed in writing before investigative work begins.',
      /* MAIL-CHECK.md — the legal card carries the Mail Check line the
         insurance sheet carries, appended to the PRIVATE PRODUCT'S lines
         without touching them: the private sheet itself must not gain it. */
      lines: [...priv.lines, MAIL_CHECK_LINE],
    });
  }
  return cards;
}

/* THE CONCISE FLAT-FEE SHEET a fixed legal service sends (LEGAL-SERVICES.md
   D4/D5, owner 2026-09-02: "A law firm buying a $250 Person Locate should
   receive a concise $250 Person Locate rate sheet").

   It is one more context-resolved PRESENTATION behind the same send door the
   legal card already uses — same product id, same email renderer, same mobile
   styling — selected by the legal service, never by a new route. THE WORDS ARE
   THE BOUNDARY: nothing here may say retainer, hourly, minimum, additional
   time or deposit, because those are the retainer product's terms and the
   whole point of this sheet is that they do not apply. The tests grep for the
   vocabulary, so a reworded leak still fails.

   THE FIGURE IS PASSED IN, RESOLVED BY THE CALLER — explicit per-send fee,
   else the case's own agreed figure, else legalFlatDefault (D13/D14) — and
   no digit literal lives in this function (D1); a source test pins that. The
   document is built from that ONE figure, so an unused default cannot appear
   beside a custom price. Payment information is the Mail Check line (and
   Bill.com only when the adapter answers ready, via the same withBillcomLine
   every non-private send goes through). */
function legalFixedSheet(svc, feeAmount) {
  const money = n => '$' + Number(n).toLocaleString('en-US');
  const fee = money(feeAmount);
  return {
    id: 'private_retainer',
    type: 'flat',
    service: svc.id,
    service_label: svc.label,
    name: `${svc.label} — ${fee} Flat Fee`,
    selector_label: `Legal / Law Firm — ${svc.label}`,
    audience: 'Law firms, attorneys and paralegals',
    summary: `${svc.label} at a flat ${fee}. That is the full price for the `
           + 'assignment, confirmed in writing before work begins.',
    lines: [
      { label: 'Flat fee', value: fee, big: true,
        sub: 'The full price for this service',
        note: 'The complete price for the assignment described on this sheet — '
            + 'no separate figure follows it.' },
      { label: 'What it covers', value: svc.label,
        note: svc.covers },
      { label: 'Included in the flat fee', value: 'No routine add-on fees',
        note: 'Standard local travel, routine case expenses, documentation and '
            + 'delivery of the results are included. There are no routine '
            + 'mileage, toll, parking or report surcharges within our normal '
            + 'service area.' },
      { label: 'Outside our normal service area', value: 'Quoted in advance',
        note: 'Work requiring significant travel outside our normal service '
            + 'area is quoted and approved before the assignment is accepted.' },
      /* The same one-writer line the insurance sheet and the legal card carry —
         no address, invoice-only mailing details (MAIL-CHECK.md). */
      MAIL_CHECK_LINE,
    ],
    closing_title: 'Billed to the firm. No surprise billing.',
    closing: 'Work begins once the assignment is confirmed in writing. Law '
           + 'firms are billed by invoice — BILL.com invoice or ACH, check by '
           + 'mail, or a check held for pick-up at the firm’s office — and '
           + 'an existing billing arrangement is honoured where one is on file.',
  };
}

/* ---- Private-client payment methods (PAYMENTS.md, owner 2026-08-14) ----

   PRIVATE CLIENT ONLY. Cash App and Venmo may appear on the private retainer
   sheet and its send flow, and nowhere else: not in the insurance sheet, the
   insurance intake, a carrier email, the insurance send wizard, or any
   investigator view. The boundary is the same shape as the intake pairing
   already enforced by SHEET_INTAKE — decided HERE, server-side, from the sheet
   id, never from anything the caller says. */
/* MAIL-CHECK.md — the one line both the insurance sheet and the legal card
   carry. One writer, so the sheet, the email and the page preview cannot
   drift, and NO ADDRESS: "Do NOT place the full mailing address on the rate
   sheet" is the owner's own sentence. */
const MAIL_CHECK_LINE = { label: 'Mail Check', value: 'Accepted',
  note: 'Mailing instructions provided with invoice.' };

/* The firm's payment destinations, given by the owner 2026-08-15.
 *
 * THE DISPLAY TEXT AND THE URL ARE SEPARATE VALUES AND NEITHER IS DERIVED FROM
 * THE OTHER. Venmo shows `@Trever-Brown-9` because that is how a Venmo handle
 * is written, while its URL path is `/u/Trever-Brown-9` with no `@` — the
 * owner was explicit that the symbol is display only and must not enter the
 * path. Build one from the other and you produce venmo.com/u/@Trever-Brown-9,
 * which is not the firm's page; a client who taps it either lands nowhere or
 * on somebody else, holding a retainer. There is no derivation anywhere in
 * this file and there must never be one.
 *
 * These live in case-portal/, which is excluded from the Pages deploy, so they
 * are not published with the site. They are not secrets either — a payment
 * destination is something a client is handed on purpose — but they are the
 * firm's, and an admin can change any of them from Settings without a code
 * change. A row in payment_methods overrides what is here. */
const PAY_METHODS = [
  { id: 'cash_app', label: 'Cash App',
    display_name: 'Cash App', handle: '$TreverB',
    url: 'https://cash.app/$TreverB' },
  { id: 'venmo', label: 'Venmo',
    display_name: 'Venmo', handle: '@Trever-Brown-9',
    url: 'https://venmo.com/u/Trever-Brown-9' },   // no @ in the path, deliberately
];
/* rateSheets() has its own local `money`; this is the same formatting for the
   payment block, which is built outside that function. */
const usd = n => '$' + Number(n).toLocaleString('en-US');
const PAY_IDS = PAY_METHODS.map(m => m.id);

/* THE SEND CONTEXT — the owner's refactor, 2026-08-15.

   Every outgoing send is either PRIVATE or INSURANCE, and which one is decided
   by WHAT IS BEING SENT — never by who it is going to.

   This replaces `recipientIsCarrier()`, which tried to classify the RECIPIENT
   by comparing their email address against stored carrier contacts. That
   produced four defects in four review rounds, in both directions: it matched
   substrings so unrelated private clients were refused; it matched addresses
   quoted in free-text notes; and it failed open on stored addresses carrying
   whitespace, first ordinary spaces and then non-breaking ones. Each fix
   narrowed the string comparison and the next round found another way for a
   string comparison to be wrong. The owner's conclusion, and it is the right
   one: do not infer a recipient's type from their email at all.

   A context cannot be mistyped, pasted with a non-breaking space, or shared by
   two different people. It is a property of the flow the admin chose.

   `CONTEXT_TAKES_PAYMENT` is the whole payment boundary now: Cash App and Venmo
   may only ever be attached to a PRIVATE context. An insurance send has no code
   path that reaches them, rather than a check that has to keep being right. */
/* UNIT 6 adds LEGAL (LEGAL-INTAKE.md D2). A legal send uses the PRIVATE
   pricing product — same figures, structurally, because a legal case IS
   kind='consumer' — but CONTEXT_TAKES_PAYMENT stays `=== PRIVATE`, so Cash App
   and Venmo have no code path to a law firm, the same shape that already
   protects carriers. */
const SEND_CONTEXT = { PRIVATE: 'private', INSURANCE: 'insurance', LEGAL: 'legal' };

/* Which context each sheet is. A table rather than a comparison so the mapping
   has one home, and so a new sheet has to declare itself rather than defaulting
   into the payment-carrying side. */
const SHEET_CONTEXT = {
  private_retainer:     SEND_CONTEXT.PRIVATE,
  insurance_assignment: SEND_CONTEXT.INSURANCE,
};

/* The two intake doors, by context. `submissions.kind` is a TYPED COLUMN with a
   CHECK constraint, so reading it is not inference — it is the record saying
   what it is. That is the difference the owner drew: a typed field yes, a
   string comparison no. */
const KIND_CONTEXT = { consumer: SEND_CONTEXT.PRIVATE, claims: SEND_CONTEXT.INSURANCE };

const contextForSheet = sheetId => SHEET_CONTEXT[sheetId] || null;
const contextForKind  = kind    => KIND_CONTEXT[kind] || null;

/* WHICH CONTEXTS A SHEET MAY BE SENT IN (Unit 28).

   `SHEET_CONTEXT` above is a sheet's DEFAULT context. This is the wider
   question the pre-case work needed: a legal client takes the PRIVATE SHEET —
   same product, same figures, one pricing source (Unit 6 D1) — in the LEGAL
   context. So `private_retainer` may carry two contexts and the carrier sheet
   may carry exactly one.

   A table rather than a comparison, for the reason SHEET_CONTEXT is one: a new
   sheet has to declare what it may be, and anything undeclared fails closed.
   THIS IS A BOUNDARY: it is what stops a caller asking for the carrier sheet
   "in the legal context" and getting a document no law firm should receive. */
const SHEET_CONTEXTS_ALLOWED = {
  private_retainer:     [SEND_CONTEXT.PRIVATE, SEND_CONTEXT.LEGAL],
  insurance_assignment: [SEND_CONTEXT.INSURANCE],
};
const sheetAllowsContext = (sheetId, ctx) =>
  (SHEET_CONTEXTS_ALLOWED[sheetId] || []).includes(ctx);

/* The legal row's columns, once — the ingest writer, the admin editor and the
   quick creator all draw from this list, so a field added here is added
   everywhere at the same time. Column names only ever come from this constant,
   never from a request. */
const LEGAL_FIELDS = ['firm_name', 'firm_address', 'firm_phone', 'firm_email',
  'attorney_name', 'attorney_email', 'attorney_phone',
  'paralegal_name', 'paralegal_email', 'paralegal_phone',
  'billing_name', 'billing_email', 'billing_phone', 'billing_reference',
  'matter_number', 'court_case_number', 'court_jurisdiction',
  'assignment_type', 'conflict_names',
  'hearing_date', 'trial_date', 'deadline', 'other_date', 'other_date_label',
  'payment_arrangement'];

const cleanLegal = v => String(v == null ? '' : v)
  .replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 2000) || null;

/** Insert the structured legal row from a payload-shaped object. Used by the
    ingest and the quick creator; the EDIT route is deliberately a different
    statement (absent-means-unchanged, per-field) because a form that posts
    subsets must never replace-all. */
async function writeLegalRow(env, caseNo, src, userId) {
  const vals = LEGAL_FIELDS.map(f => {
    let v = cleanLegal(src[f]);
    if (f === 'payment_arrangement' && v && !LEGAL_ARRANGEMENTS[v]) v = null;
    return v;
  });
  await env.DB.prepare(
    `INSERT INTO legal_intake (case_no, ${LEGAL_FIELDS.join(', ')}, created_at, updated_by, updated_at)
     VALUES (?, ${LEGAL_FIELDS.map(() => '?').join(', ')}, ?, ?, ?)
     ON CONFLICT(case_no) DO NOTHING`)
    .bind(caseNo, ...vals, nowIso(), userId, userId ? nowIso() : null).run();
}

/** The legal detail for a case, admin-only at the call sites. Falls back to
    the submission payload when the row is absent (an intake that arrived
    before portal-setup ran) so the panel is never blank about facts the
    portal already holds — the fallback is read-only and says so. */
async function legalFor(env, caseNo) {
  if (!(await missingTables(env)).includes('legal_intake')) {
    const row = await env.DB.prepare('SELECT * FROM legal_intake WHERE case_no = ?')
      .bind(caseNo).first();
    if (row) return { ...row, source: 'table' };
  }
  const sub = await env.DB.prepare('SELECT payload FROM submissions WHERE case_no = ?')
    .bind(caseNo).first();
  if (!sub || !isLegalSub(sub)) return null;
  let p = {}; try { p = JSON.parse(sub.payload || '{}'); } catch { p = {}; }
  const out = { case_no: caseNo, source: 'payload' };
  for (const f of LEGAL_FIELDS) out[f] = cleanLegal(p[f]);
  return out;
}

/* UNIT 6 — the one reader for "is this submission a legal assignment". The
   marker is payload.assignment === 'legal', written by the ingest and the
   admin creator into the submission's OWN row: a legal case is kind='consumer'
   (D1 — the CHECK cannot widen, and consumer is what keeps the pricing
   structural), so kind alone cannot answer this. Never inferred from a
   recipient, an email address, or the legal_intake table's presence — the
   table is detail, the payload is the record. */
const isLegalSub = sub => {
  if (!sub) return false;
  try { return JSON.parse(sub.payload || '{}').assignment === 'legal'; }
  catch { return false; }
};
/* Context for a CASE: the payload marker outranks the kind mapping. Callers
   that only have a kind (no row) keep contextForKind — a reference that
   resolves to nothing still sends, the pre-case rule. */
const contextForSub = sub => !sub ? null : (isLegalSub(sub) ? SEND_CONTEXT.LEGAL : contextForKind(sub.kind));

/* The owner's four legal payment arrangements — a REQUEST, never a payment
   (D8): nothing here touches retainer_payment, and the wording the office
   sees says "awaiting", not "paid". Validated here, no CHECK in the schema,
   so a fifth arrangement never needs a table rebuild. */
const LEGAL_ARRANGEMENTS = {
  bill_ach:         'BILL.com invoice / ACH',
  check_pickup:     'Retainer check — pick up at firm',
  check_mail:       'Retainer check — by mail',
  existing_billing: 'Existing billing arrangement',
};
/* Assignment categories (D4): one extensible list, stored as free text so
   "Other / Custom" and future categories need no schema change.

   THE COLUMN IS FREE TEXT AND THIS LIST VALIDATES NOTHING — which is what
   makes the Unit 35 terminology change safe on the way in: a case that already
   recorded 'Witness locate / interview' still saves, still reads back, and is
   never rewritten. The page offers the current wording, keeps a superseded
   value selectable, and shows it under its current label. Data untouched,
   wording current. */
const LEGAL_ASSIGNMENTS = ['Surveillance', 'Locate / Skip trace', 'Background investigation',
  'Witness locate', 'Domestic / custody investigation', 'Civil investigation',
  'Evidence / documentation', 'Process / service support', 'Other / custom assignment'];

/* ================= LEGAL SERVICES — the one catalogue (LEGAL-SERVICES.md) ==

   The pricing-level choice a law firm makes, owner brief 2026-09-02: five
   services, three pricing models. `model` is what the case, the sheet and the
   billing language all key off — `fixed` (a flat fee from LEGAL_FLAT),
   `retainer` (the existing private/legal retainer+hourly product, untouched),
   `custom` (no figure of its own; the existing custom-retainer workflow sets
   one per case).

   Each entry maps onto the EXISTING assignment-type vocabulary (D2) rather
   than duplicating it: the five services are the pricing choice, the nine
   LEGAL_ASSIGNMENTS stay the finer categorisation, and a chosen service
   defaults `assignment_type` only where the form left it blank.

   NO CHECK ANYWHERE — the marker is `payload.legal_service` on the
   submission's own row (the `assignment === 'legal'` shape, D3), so a sixth
   service is an ordinary edit here and historical cases carry no marker at
   all, which is exactly the `retainer` default branch below. */
const LEGAL_MODEL_LABEL = { fixed: 'Fixed price', retainer: 'Retainer / hourly', custom: 'Custom' };
const LEGAL_SERVICES = {
  locate: {
    id: 'locate', label: 'Person Locate / Skip Trace', model: 'fixed',
    assignment_type: 'Locate / Skip trace',
    covers: 'Identifying and locating the named subject — current address and '
          + 'whereabouts suitable for contact, filing or service, with the '
          + 'identifying details checked against what the firm supplied.',
  },
  process: {
    id: 'process', label: 'Process Service', model: 'fixed',
    assignment_type: 'Process / service support',
    covers: 'Service of the firm’s documents on the named recipient, '
          + 'documented attempt by attempt, with the outcome reported to the '
          + 'firm for its file.',
  },
  general: {
    id: 'general', label: 'General Investigation', model: 'retainer',
    assignment_type: 'Civil investigation',
  },
  surveillance: {
    id: 'surveillance', label: 'Surveillance', model: 'retainer',
    assignment_type: 'Surveillance',
  },
  custom: {
    id: 'custom', label: 'Other / Custom Assignment', model: 'custom',
    assignment_type: 'Other / custom assignment',
  },
};
const legalServiceById = id => LEGAL_SERVICES[String(id == null ? '' : id).trim().toLowerCase()] || null;
/* The catalogue as the pages receive it — id, label, model, model label; no
   figure, because a fee belongs beside the surface that quotes it. */
const LEGAL_SVC_LIST = Object.values(LEGAL_SERVICES).map(s => ({
  id: s.id, label: s.label, model: s.model, model_label: LEGAL_MODEL_LABEL[s.model],
}));

/* THE DEFAULT FEE A FIXED SERVICE IS QUOTED AT, resolved in ONE place
   (LEGAL-SERVICES.md D14). Process Service may be given an admin-typed
   default in Settings → Invoice defaults; anything absent, non-positive or
   unparseable falls back to LEGAL_FLAT — a sheet must never print $0 or NaN
   at a firm. Locate deliberately has no override: the owner's adjustable-fee
   brief names Process Service only. A CASE-specific agreed figure outranks
   whatever this answers, everywhere it is read. */
async function legalFlatDefault(env, id) {
  if (id === 'process') {
    const cfg = await billingSettings(env);
    const n = Number(String(cfg.process_fee_default || '').replace(/[$,\s]/g, ''));
    if (Number.isFinite(n) && n > 0 && n <= 1000000) return Math.round(n * 100) / 100;
  }
  return LEGAL_FLAT[id];
}

/* ACCEPTANCE FIXES THE PRICE (D14 — the owner's "historical cases must
   preserve the price they were originally accepted at", made structural).
   When a lead CONVERTS and its service is fixed with no agreed figure on
   record, the default in force RIGHT NOW is written as the case's own
   figure — so a later change to the default cannot rewrite what this case
   was accepted at. Never overwrites: an existing figure is the office's own
   record. Best-effort: a failed snapshot must never fail the conversion,
   and the derivation still answers sensibly until someone converts again
   or agrees a figure by hand. */
async function snapshotFixedFee(env, caseNo, userId) {
  try {
    const sub = await env.DB.prepare(
      'SELECT kind, payload FROM submissions WHERE case_no = ?').bind(caseNo).first();
    const svc = legalServiceForSub(sub);
    if (!svc || svc.model !== 'fixed') return;
    const ret = await env.DB.prepare(
      'SELECT retainer_amount FROM case_retainer WHERE case_no = ?').bind(caseNo).first();
    if (ret && ret.retainer_amount != null) return;
    const fee = await legalFlatDefault(env, svc.id);
    await env.DB.prepare(
      `INSERT INTO case_retainer (case_no, retainer_amount, updated_by, updated_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(case_no) DO NOTHING`)
      .bind(caseNo, fee, userId || null, nowIso()).run();
  } catch { /* the conversion is the point; the snapshot is a record of it */ }
}

/* The service a submission's own record names — one reader, the `isLegalSub`
   rule: never inferred from a recipient, a sheet, or the legal_intake table.
   Null for a non-legal case AND for a legal case with no marker; the two are
   told apart by `isLegalSub` where it matters. */
const legalServiceForSub = sub => {
  if (!sub || !isLegalSub(sub)) return null;
  try { return legalServiceById(JSON.parse(sub.payload || '{}').legal_service); }
  catch { return null; }
};

/* FIXED / RETAINER-HOURLY / CUSTOM, derived and never stored (D3). The
   historical default is `retainer` — a legal case that predates the catalogue
   renders exactly as it did the day it was filed, which is the owner's
   "existing historical cases must remain readable and unchanged" as the
   default branch rather than a migration. */
function legalPricingFor(sub) {
  if (!sub || !isLegalSub(sub)) return null;
  const svc = legalServiceForSub(sub);
  const model = svc ? svc.model : 'retainer';
  return {
    service: svc ? svc.id : null,
    service_label: svc ? svc.label : null,
    model,
    model_label: LEGAL_MODEL_LABEL[model],
    /* The fee a fixed service is quoted at — the catalogue's, from LEGAL_FLAT.
       The case's own agreed figure still outranks this at the money surfaces
       (D7); this is the default the model carries. */
    fee: svc && svc.model === 'fixed' ? LEGAL_FLAT[svc.id] : null,
  };
}

/* ---------------------------------------------- UNIT 7: client profiles

   A PROFILE IS A REUSABLE DEFAULT, A CASE IS A SNAPSHOT (PROFILES.md). These
   constants are the vocabulary; none of them is a CHECK constraint in the
   schema, for the reason written above legal_intake and payment_methods —
   schema.sql is re-applied on every portal-setup run and cannot widen one.

   `kind` is also IMMUTABLE after creation. A firm with history must not be
   re-typed into a private client: the directory lenses, the prefill mapping
   and the roles below all key off it, and the honest correction is to
   deactivate and create the right one. Nothing reads `kind` from an edit. */
const PROFILE_KINDS = {
  law_firm:       'Law firm',
  insurance_org:  'Insurance / organization',
  private_client: 'Private client',
};
/* The roles differ BY KIND, which is the second reason a CHECK could not have
   carried them: one column's constraint would have to be the union of both
   lists, and would then happily accept Adjuster on a law firm. */
const PROFILE_ROLES = {
  law_firm:       ['Attorney', 'Paralegal', 'Legal Assistant', 'Billing Contact', 'Office Manager', 'Other'],
  insurance_org:  ['Adjuster', 'Claims Examiner', 'SIU Contact', 'Attorney', 'Billing Contact', 'Other'],
  private_client: ['Primary contact', 'Billing Contact', 'Other'],
};
/* The phone labels are `PHONE_LABELS`, declared once for case_phone further
   down and reused here rather than copied: mobile/work/home/other is the
   owner's approved set on both sides, and two copies of one vocabulary drift. */
const PROFILE_TABLES = ['profile', 'profile_contact', 'profile_phone', 'case_profile'];

/* Normalisation for COMPARISON ONLY, and deliberately not clever. It folds
   case, punctuation and every kind of space — including the non-breaking and
   zero-width ones that produced four separate defects in the send-context
   work — and does nothing else.

   What it must NOT do is the load-bearing half: no stripping of LLC/PC/Group,
   no St→Street, no Gmail dot or plus-tag removal. Every one of those is
   inference dressed as tidying, and each is exactly how "Smith Law" and
   "Smith Law Group" would become one key — the thing the owner named and
   forbade. The comparison only ever SURFACES candidates to a person. */
const normText = v => String(v == null ? '' : v)
  .replace(/[\u00a0\u1680\u2000-\u200d\u202f\u205f\u3000\ufeff]/g, ' ')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const normDigits = v => String(v == null ? '' : v).replace(/\D+/g, '');
/* Two numbers are the same when their last ten digits are — a leading 1 or a
   +1 must not defeat a match, and nothing shorter than ten digits is compared
   loosely at all. */
const samePhone = (a, b) => {
  const x = normDigits(a), y = normDigits(b);
  if (!x || !y) return false;
  return (x.length >= 10 && y.length >= 10) ? x.slice(-10) === y.slice(-10) : x === y;
};
const cleanProfileText = v => String(v == null ? '' : v)
  .replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 2000) || null;

/** Which of the four profile tables are absent. schema.sql arrives by a MANUAL
    portal-setup dispatch while the Worker deploys on push, so between the two
    these do not exist — every read degrades and the writes 503 by name. */
async function profilesMissing(env) {
  const missing = await missingTables(env);
  return PROFILE_TABLES.filter(t => missing.includes(t));
}
const profilesReady = async env => (await profilesMissing(env)).length === 0;

/* The inverse: which product a context sends. Declared rather than derived with
   a ternary, because a ternary has to pick a side for anything it does not
   recognise and the wrong side here is the one carrying payment methods. This
   returns undefined for an unknown context and every caller refuses on it, so
   an unrecognised value fails CLOSED. */
const CONTEXT_SHEET = {
  [SEND_CONTEXT.PRIVATE]:   'private_retainer',
  [SEND_CONTEXT.INSURANCE]: 'insurance_assignment',
  /* The legal sheet IS the private product (D1/D2): one pricing source, so
     there is no second copy to drift when the private figures move. */
  [SEND_CONTEXT.LEGAL]:     'private_retainer',
};
/* The intake DOOR is per-context, not per-sheet: legal shares the private
   SHEET but must never be sent the private FORM — the legal door retitles the
   flow and asks a law office's questions. Declared per context so an unknown
   context still fails closed. */
const CONTEXT_INTAKE = {
  [SEND_CONTEXT.PRIVATE]:   'private_retainer',
  [SEND_CONTEXT.INSURANCE]: 'insurance_assignment',
  [SEND_CONTEXT.LEGAL]:     'legal_assignment',
};
const intakeForContext = ctx => SHEET_INTAKE[CONTEXT_INTAKE[ctx]];

/* The only rule payment options need. Everything that used to be spread across
   a sheet-id comparison and a recipient lookup is this one line. */
const CONTEXT_TAKES_PAYMENT = ctx => ctx === SEND_CONTEXT.PRIVATE;

/* Kept as a named alias because it reads well at the call sites and because
   this is the sheet-shaped question; it is now derived rather than compared. */
const sheetTakesPayment = sheetId => CONTEXT_TAKES_PAYMENT(contextForSheet(sheetId));

/* A payment URL is admin-entered or ABSENT — it is never built from a handle.
   The order is explicit about this and it is the sharpest line in it: a
   fabricated `cash.app/$handle` that happens to resolve to a real stranger
   sends a client's retainer to the wrong person. So there is no derivation
   here, and there must never be one. Only http(s) is accepted, so a stored
   value can never become `javascript:` in a mail client or the page. */
function safePayUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { return ''; }
  return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : '';
}

/* Every configured method, admin-facing. */
async function paymentConfig(env) {
  const { results } = await env.DB.prepare(
    `SELECT method, enabled, display_name, handle, url, instructions, updated_at
       FROM payment_methods`).all();
  const byId = Object.fromEntries((results || []).map(r => [r.method, r]));
  /* No row yet means the firm's own details above, ON. The owner supplied both
     destinations and asked for both to be clickable, so the out-of-the-box
     state is the working one rather than an empty form somebody has to find.
     A saved row wins completely — configuring a method is how you change or
     switch one off. */
  return PAY_METHODS.map(m => {
    const row = byId[m.id];
    if (!row) {
      return {
        id: m.id, label: m.label, enabled: true,
        display_name: m.display_name, handle: m.handle, url: m.url,
        instructions: '', updated_at: null, from_default: true,
      };
    }
    return {
      id: m.id, label: m.label,
      enabled: Number(row.enabled) === 1,
      display_name: row.display_name || '',
      handle: row.handle || '',
      url: row.url || '',
      instructions: row.instructions || '',
      updated_at: row.updated_at || null,
      from_default: false,
    };
  });
}

/* What a CLIENT may be shown: only methods that are enabled AND actually have
   something to pay to. A method ticked on with no handle and no URL would
   render an empty instruction, which is worse than omitting it — it looks like
   the firm forgot to say where the money goes.

   `wanted` is the admin's per-send selection. Anything not enabled centrally is
   dropped regardless of what the caller asked for, so the send wizard cannot
   turn on a method the configuration has off. */
async function paymentOptionsFor(env, wanted, unusableOut = [], context = null) {
  /* THE CONTEXT IS CHECKED HERE, NOT ONLY AT THE CALL SITES (Codex design
     review, 2026-08-15).

     Every caller already gated on the context before reaching this function, so
     nothing could get through — but the review's point stands: the safety lived
     in call-site convention rather than in the function that actually hands out
     payment methods. A fifth caller added later would inherit no protection at
     all, and it would look correct.

     So the boundary is here as well. `context` is required to be the private
     one; anything else — including the `null` a careless new caller would pass
     by omission — returns nothing. It fails CLOSED, which is the opposite of
     what a defaulted parameter usually does, and is the point. */
  if (!CONTEXT_TAKES_PAYMENT(context)) return [];
  const all = await paymentConfig(env);
  /* NO SELECTION and AN EMPTY SELECTION are different answers, and conflating
     them is how unticking every method sent every method. `null` means the
     caller expressed no preference — take whatever is enabled. An empty ARRAY
     means the admin looked at the list and chose none, which can only ever
     yield nothing; testing `wanted.length` here made 0 falsy and fell through
     to "send them all", the exact opposite of what was asked. The caller
     refuses the send rather than mailing an empty PAYMENT OPTIONS heading. */
  const pick = Array.isArray(wanted) ? all.filter(m => wanted.includes(m.id)) : all;

  /* A method that is switched ON but has no link is a BROKEN CONFIGURATION,
     and it must never be quietly skipped.

     Enabling without a URL used to be allowed, and rows saved under that rule
     still exist. Once every option had to be tappable, this filter started
     dropping them — so an admin could send a sheet, see it succeed, and never
     learn that Venmo was missing from what the client received. Silent loss of
     a payment option is worse than a refusal: nobody goes looking for it.

     The caller is told, by name, and refuses the send. Falling back to the
     built-in URL instead would be far worse than either: a stored row with a
     DIFFERENT handle would inherit the firm's link, and the client would pay
     the wrong destination while the screen said everything was fine. Nothing
     here guesses a URL, and that includes guessing it from ourselves. */
  const enabled = pick.filter(m => m.enabled);
  unusableOut.push(...enabled.filter(m => !safePayUrl(m.url)));

  return enabled
    .filter(m => safePayUrl(m.url))
    .map(m => ({
      id: m.id,
      label: m.display_name.trim() || m.label,
      handle: m.handle.trim(),
      url: safePayUrl(m.url),
      instructions: m.instructions.trim(),
    }));
}

async function setPaymentMethod(request, env, user, id) {
  if (!PAY_IDS.includes(id)) return json({ error: 'no such payment method' }, 404);
  const body = await readJson(request);

  const clean = (v, max) => String(v == null ? '' : v)
    .replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
  const handle = clean(body.handle, 80);
  const display = clean(body.display_name, 80);
  const instructions = clean(body.instructions, 500);

  /* An unusable URL is refused rather than quietly dropped. Silently blanking
     it would leave an admin believing a link was configured when clients are
     being shown only a handle. */
  const rawUrl = String(body.url == null ? '' : body.url).trim();
  const url = safePayUrl(rawUrl);
  if (rawUrl && !url) {
    return json({ error: 'A payment link must be a full http(s) URL, or left empty.' }, 400);
  }

  const enabled = body.enabled === true || body.enabled === 1 || body.enabled === '1' ? 1 : 0;
  /* EVERY OFFERED METHOD MUST BE CLICKABLE (owner, 2026-08-15), so a method
     cannot be enabled without a payment URL. The earlier order allowed a
     handle on its own and rendered it as plain text; the later one governs,
     and this is the structural way to honour it — a method with no link simply
     cannot be turned on, rather than being turned on and quietly degrading to
     text that a client has to retype.

     The URL is still admin-entered and is NEVER derived from the handle. Those
     two rules only look opposed: the answer is that both destinations have a
     real URL, not that the code invents one. */
  if (enabled && !url) {
    return json({ error: handle
      ? 'This method needs a payment link before it can be offered — every payment '
        + 'option a client sees has to be tappable, and a link is never guessed from a handle.'
      : 'Give a payment link and a handle before enabling this method.' }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO payment_methods (method, enabled, display_name, handle, url, instructions,
       updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(method) DO UPDATE SET enabled = excluded.enabled,
       display_name = excluded.display_name, handle = excluded.handle, url = excluded.url,
       instructions = excluded.instructions, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`)
    .bind(id, enabled, display, handle, url, instructions, user.id, nowIso()).run();

  return json({ ok: true, methods: await paymentConfig(env) });
}

/* MASTER §5 — Send Intake from a lead. The email carries the intake link and
   nothing priced. Which door is NEVER the caller's choice: the lead's own
   kind picks it server-side, the same rule SHEET_INTAKE enforces — a carrier
   lead can only ever be sent the carrier door. */
/* The intake invitation, built once and used by both doors into it — the lead
   card, and the pre-case send that has no lead at all. Two copies of this email
   would drift, and the half that drifts is the half nobody is reading. */
function intakeInviteEmail(intake, who) {
  const greet = who ? `${String(who).slice(0, 80)},` : 'Hello,';
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
  return { text, html };
}

/* THIS ROUTE IS INSIDE THE CONTEXT MODEL TOO (Codex stop-time review,
   2026-08-15 — "the context refactor leaves an existing send route outside its
   claimed invariant").

   It was the one client-facing send that had not been brought in. It paired the
   intake with a bare ternary — `kind === 'claims' ? insurance : private` — which
   is worse than merely inconsistent: a ternary must pick a side for anything it
   does not recognise, and the side it picked was PRIVATE, the one that carries
   payment methods. `submissions.kind` is CHECK-constrained today so nothing
   could reach it, but a guard whose safety depends on a constraint somewhere
   else is a guard waiting for that constraint to be widened.

   `contextForKind` returns null for anything it does not know and this refuses
   on it, so an unrecognised kind now fails CLOSED rather than defaulting into
   the payment-carrying side. */
async function sendLeadIntake(request, env, user, caseNo) {
  const lead = await env.DB.prepare(
    'SELECT case_no, kind, client_name, payload FROM submissions WHERE case_no = ?').bind(caseNo).first();
  if (!lead) return json({ error: 'not found' }, 404);

  /* The payload marker outranks the kind mapping (Unit 6): a legal lead is
     kind='consumer' by design, and emailing it the PRIVATE form would ask a
     law office a consumer's questions. */
  const context = contextForSub(lead);
  const intake = intakeForContext(context);
  if (!context || !intake) {
    return json({ error: `${caseNo} does not say whether it is a private client or a claim `
                       + `assignment, so the right intake form cannot be chosen.` }, 409);
  }

  const body = await readJson(request);
  const to = String(body.to || '').trim();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(to) || to.length > 200) {
    return json({ error: 'Enter a valid email address.' }, 400);
  }
  if (!(await withinRateLimit(env, 'mail'))) {
    return json({ error: 'Too many emails in one minute — wait a moment and send again.' }, 429);
  }

  const { text, html } = intakeInviteEmail(intake, lead.client_name);

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
  return json({ ok: true, sent_to: to, intake: intake.label, send_context: context,
                lead_status: (await env.DB.prepare(
                  'SELECT status FROM lead_status WHERE case_no = ?').bind(caseNo).first() || {}).status });
}

/* WHAT THE OFFICE HAS SENT, whether or not it had a case to send it against
   (owner, 2026-08-15 — requirement 6).

   Both logs are read, newest first, and unioned in JavaScript rather than in
   SQL: they are different shapes and a UNION would force one to pretend to be
   the other. `case_no` comes back as null for a pre-case send and the caller
   shows it as such — the absence is information, not a gap to paper over. */
async function sendHistory(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 40, 1), 200);
  const sheets = await env.DB.prepare(
    `SELECT s.id, s.case_no, s.kind, s.sheet_id, s.door, s.recipient, s.ok, s.detail,
            s.sent_at, u.display_name AS sent_by
       FROM send_log s LEFT JOIN users u ON u.id = s.sent_by
      ORDER BY s.id DESC LIMIT ?`).bind(limit).all();
  const pays = await env.DB.prepare(
    `SELECT p.id, p.case_no, p.recipient, p.methods, p.with_sheet, p.ok, p.detail,
            p.sent_at, u.display_name AS sent_by
       FROM payment_send p LEFT JOIN users u ON u.id = p.sent_by
      ORDER BY p.id DESC LIMIT ?`).bind(limit).all();

  const rows = [
    ...(sheets.results || []).map(r => ({
      id: `s${r.id}`, at: r.sent_at, case_no: r.case_no || null,
      kind: r.kind, sheet_id: r.sheet_id || null, door: r.door || null,
      recipient: r.recipient, ok: Number(r.ok) === 1, detail: r.detail || null,
      sent_by: r.sent_by || null, methods: null,
    })),
    /* Only the STANDALONE payment sends. One that rode with a sheet is already
       represented by that sheet's own row, and listing both would report two
       emails where the client received one. */
    ...(pays.results || []).filter(r => Number(r.with_sheet) !== 1).map(r => ({
      id: `p${r.id}`, at: r.sent_at, case_no: r.case_no || null,
      kind: 'payment_options', sheet_id: null, door: null,
      recipient: r.recipient, ok: Number(r.ok) === 1, detail: r.detail || null,
      sent_by: r.sent_by || null, methods: r.methods ? String(r.methods).split(',') : [],
    })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);

  return json({ sends: rows });
}

/* THE INTAKE, SENT BEFORE ANYTHING EXISTS (owner, 2026-08-15 — PRE-CASE SENDS).

   `sendLeadIntake` above is keyed by a case number in its URL, so until now the
   only way to send an intake form was to already have a lead on the desk. That
   is backwards for how the work arrives: someone calls, you take a name and an
   email, and the intake is what turns them into a lead in the first place.

   NAME AND A VALID EMAIL ARE ENOUGH. There is no case number here, optional or
   otherwise, and NOTHING IS CREATED — the owner was explicit that a case must
   not be conjured just to have something to send against. The send is recorded
   in `send_log` with a null `case_no`, which that column has always allowed.

   THE DOOR IS PAIRED FROM AN EXPLICIT KIND, never from a case that does not
   exist. `private` and `insurance` are the only two answers, and each maps to
   its own intake through the same `SHEET_INTAKE` table the sheet sends use — so
   a carrier still cannot land on the consumer picker, and a private client is
   still never offered the claim assignment path. The separation the owner asked
   to preserve rests on the caller naming which product this is, which is a
   stronger thing to rest on than a case lookup that may find nothing. */
async function sendPreCaseIntake(request, env, user) {
  const body = await readJson(request);
  const to = String(body.to || '').trim();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(to) || to.length > 200) {
    return json({ error: 'Enter a valid email address.' }, 400);
  }
  /* The caller names a PRODUCT — which of the two intakes — and the server
     resolves the context from its own table. It is not trusted as a
     classification of the recipient, and it cannot be: there is nothing an
     intake link carries that a payment method could ride on. */
  /* UNIT 6 — 'legal' is the third product, mapped straight to its context so
     the LEGAL door is chosen; it never rides the kind mapping, because a legal
     case's kind is 'consumer' and that mapping would hand out the private
     form. */
  const context = body.kind === 'legal' ? SEND_CONTEXT.LEGAL
    : contextForKind(
        body.kind === 'insurance' || body.kind === 'claims' ? 'claims'
        : body.kind === 'private' || body.kind === 'consumer' ? 'consumer' : null);
  if (!context) {
    return json({ error: 'Say which intake this is — Private Client, Insurance Assignment or '
                       + 'Legal / Law Firm. The forms are never interchangeable.' }, 400);
  }
  const name = String(body.name || '')
    .replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 120);

  if (!(await withinRateLimit(env, 'mail'))) {
    return json({ error: 'Too many emails in one minute — wait a moment and send again.' }, 429);
  }

  // Derived from the context, not from a ternary that must guess for anything
  // it does not recognise — see `intakeForContext`.
  const intake = intakeForContext(context);
  const { text, html } = intakeInviteEmail(intake, name);
  const mail = await sendMail(env, {
    to, subject: `${intake.label} — Always Precise Investigations`, text, html });

  if (!mail.sent) {
    await logSend(env, user, { case_no: null, kind: 'intake', door: intake.url,
      recipient: to, ok: 0, detail: mail.reason || 'send failed' });
    return json({
      error: mail.reason === 'not_configured'
        ? 'Email is not configured on the Worker. Add RESEND_API_KEY to send from here.'
        : 'That did not send. Check the address and try again.',
      reason: mail.reason,
    }, 502);
  }
  /* Logged with no case, which is the point — the history of what the office
     sent must not depend on a record that does not exist yet. Nothing is
     stamped either: there is no lead to move. */
  await logSend(env, user, { case_no: null, kind: 'intake', door: intake.url,
    recipient: to, ok: 1 });
  /* The context is returned so it is observable rather than merely believed —
     the tests assert on it, and it can never be a payment-carrying one here. */
  return json({ ok: true, sent_to: to, intake: intake.label, case_no: null,
                send_context: context });
}

async function emailSheet(request, env, user, id) {
  /* The sheet is built AFTER the case number is known, because the case is
     what says how much the retainer is. Built before it, every private client
     is quoted the standard figure regardless of what was agreed with them. */
  if (!sheetById(id)) return json({ error: 'no such rate sheet' }, 404);

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

  /* THE TYPED VALUE IS A REFERENCE UNTIL IT RESOLVES TO A CASE.

     `case_no` on this route is optional and free — the office types a job
     number off a notepad and it reaches the SUBJECT LINE. It was then written
     into `send_log.case_no` verbatim, which that column does not mean: the
     schema says "null when a sheet is sent with no case", and every case-scoped
     read of the log matches on it. So a pre-case send quoting reference
     `Test123` was counted against a real case `Test123` the day an unrelated
     client's intake created one — `send_count` on the case list reported a send
     that was never made to that client.

     `linkedCase` is the value only where it IS a case. The lookup below already
     had to happen for the sheet/lead guard, so this costs nothing extra, and
     nothing about what is SENT changes — the subject line still carries
     whatever was typed. */
  let linkedCase = null;
  /* The resolved case's own row, kept for the legal-service derivation below —
     the lookup already happens for the sheet/lead guard, so this costs
     nothing extra. */
  let caseSub = null;
  /* The context this send actually happens in: the sheet's, until a resolved
     case says otherwise — a LEGAL case takes the private sheet in the LEGAL
     context, and the answer the office reads must say which (observable and
     asserted, the SEND-CONTEXT rule). */
  let sendCtx = contextForSheet(id);

  /* AN EXPLICITLY DECLARED CONTEXT (Unit 28). A law firm that is not on the
     desk yet has no case for the lookup below to find, so before this there
     was no way to send them anything in the LEGAL context — the sheet's own
     default won, and the private door went out. The Rate Sheets screen now
     names the context it opened, exactly as `/intake-link/email` already
     takes an explicit `kind`.

     IT IS CHECKED AGAINST THE SHEET, not trusted. `SHEET_CONTEXTS_ALLOWED` is
     what stops "the carrier sheet, in the legal context" — a document no law
     firm should receive — and anything undeclared fails closed.

     A RESOLVED CASE STILL WINS. This only decides the context where there is
     no case to say otherwise; the block below overwrites it from the case's
     own record, so a declared context can never talk a real case out of what
     it is. */
  const askedCtx = String(body.send_context || '').trim().toLowerCase();
  if (askedCtx) {
    if (!Object.values(SEND_CONTEXT).includes(askedCtx) || !sheetAllowsContext(id, askedCtx)) {
      return json({ error: `That rate sheet cannot be sent as a ${askedCtx || 'blank'} `
        + 'assignment. Private and Legal share the retainer sheet; the carrier sheet is '
        + 'insurance only.', code: 'context_not_allowed' }, 400);
    }
    sendCtx = askedCtx;
  }

  /* Computed BEFORE the case lookup below, which now consults it: a legal
     case must refuse the payment block at the same door the sheet check is. */
  const includePayment = body.include_payment === true || body.include_payment === 1
    || body.include_payment === '1';

  /* A sheet sent AGAINST a lead must match that lead (audit, 2026-08-14).
     The intake door has always been paired to the sheet server-side, but
     nothing checked the sheet was the right one for the case — so the private
     sheet could be emailed against a claims lead, putting consumer pricing
     AND the consumer picker in front of an adjuster. The page picks correctly;
     the API did not care, and the API is the boundary. */
  if (caseNo) {
    const lead = await env.DB.prepare('SELECT kind, payload FROM submissions WHERE case_no = ?')
      .bind(caseNo).first();
    if (lead) {
      /* The case is named in the BODY here, not the path, so the router's gate
         does not see it. A deleted or archived case must not be able to email a
         client — that was the worst of what earlier versions allowed, and it
         really sent. An UNRESOLVABLE reference still sends, as the pre-case work
         requires: only a case that exists and has been filed away is refused. */
      const refusal = await caseSendRefusal(env, caseNo);
      if (refusal) return refusal;
      linkedCase = caseNo;
      caseSub = lead;
      /* Per-case context (Unit 6): a LEGAL case takes the private sheet —
         same product, same figures, D1 — so `wanted` maps through the context
         table rather than a kind ternary. */
      sendCtx = contextForSub(lead) || sendCtx;
      const caseCtx = sendCtx;
      const wanted = CONTEXT_SHEET[caseCtx];
      if (wanted && id !== wanted) {
        return json({ error: caseCtx === SEND_CONTEXT.INSURANCE
          ? `${caseNo} is a claim assignment — send it the Insurance Assignment Rates, never the consumer sheet.`
          : `${caseNo} is a private client — send it the Private Client Retainer, never the carrier sheet.`,
          expected_sheet: wanted }, 400);
      }
    }
  }

  /* WHICH LEGAL SERVICE THIS SEND IS ABOUT (LEGAL-SERVICES.md D4). An explicit
     pick on the screen wins — the office may deliberately quote a firm a
     different service than the case on file — else the case's own marker
     answers, else there is no service and the send is the retainer product
     exactly as before this unit. Nothing here writes the marker: choosing a
     document for one send is not re-typing the case.

     REFUSED BY NAME off the legal context: a legal service on an insurance or
     private send is a caller error, and silently dropping it would send a
     different document than the screen believed it chose. */
  const askedSvc = String(body.legal_service || '').trim().toLowerCase();
  let legalSvc = null;
  if (askedSvc) {
    if (sendCtx !== SEND_CONTEXT.LEGAL) {
      return json({ error: `Legal services describe legal sends, and this send is ${sendCtx}. `
        + 'Leave the legal service out, or send from the Legal card.',
        code: 'legal_service_not_legal' }, 400);
    }
    legalSvc = legalServiceById(askedSvc);
    if (!legalSvc) {
      return json({ error: 'No such legal service. The services are: '
        + Object.values(LEGAL_SERVICES).map(s => `${s.id} — ${s.label}`).join('; ') + '.',
        code: 'unknown_legal_service' }, 400);
    }
  } else if (sendCtx === SEND_CONTEXT.LEGAL) {
    legalSvc = legalServiceForSub(caseSub);
  }

  /* THE FEE THIS FIXED SEND CARRIES (LEGAL-SERVICES.md D12/D13). `flat_fee`
     is the admin's per-send choice — the Custom Flat Fee box, or a touched
     Standard — validated as a positive currency amount and REFUSED BY NAME on
     any send whose service is not a fixed one: silently dropping it would
     email a different figure than the screen chose. Absent, the case's own
     agreed figure answers, then the configured default — so an untouched
     wizard resolves to exactly what it displayed. */
  let flatFee = null;
  if (body.flat_fee !== undefined && body.flat_fee !== null && String(body.flat_fee).trim() !== '') {
    if (!legalSvc || legalSvc.model !== 'fixed') {
      return json({ error: 'A flat fee describes a fixed-price legal service — this send is not '
        + 'one. Pick Person Locate / Skip Trace or Process Service, or leave the fee out.',
        code: 'flat_fee_not_fixed' }, 400);
    }
    const n = Number(String(body.flat_fee).replace(/[$,\s]/g, ''));
    if (!(Number.isFinite(n) && n > 0 && n <= 1000000)) {
      return json({ error: 'Enter the flat fee as a dollar amount above zero.',
        code: 'bad_flat_fee' }, 400);
    }
    flatFee = Math.round(n * 100) / 100;
  }
  if (legalSvc && legalSvc.model === 'fixed' && flatFee == null) {
    const stored = linkedCase ? await env.DB.prepare(
      'SELECT retainer_amount FROM case_retainer WHERE case_no = ?').bind(linkedCase).first() : null;
    flatFee = stored && stored.retainer_amount != null
      ? Number(stored.retainer_amount)
      : await legalFlatDefault(env, legalSvc.id);
  }

  /* THE PAYMENT HALF OF THE BOUNDARY, AND IT IS ONE CHECK (Unit 28 moved it
     here). It used to live inside the `if (lead)` block above, which was
     correct only while a legal send was impossible without a case: the moment
     the context could be declared for a PRE-CASE send, that placement would
     have let Cash App and Venmo ride out to a law firm that simply was not on
     the desk yet — the exact thing the whole model exists to prevent.

     So it is asked of the RESOLVED context, whether that came from the sheet,
     from an explicit declaration, or from the case. One writer, one rule: Cash
     App and Venmo can only ever attach to a private context. The case is named
     when there is one, because a refusal that says which case is easier to act
     on than one that does not. */
  /* MAIL CHECK IS THE ONE PAYMENT OPTION A LEGAL OR INSURANCE SEND MAY TICK
     (owner, 2026-09-02, MAIL-CHECK.md D5). It carries no handle, no link and
     no address — one sentence pointing at the invoice — so the boundary this
     gate exists for is untouched: Cash App and Venmo still reach a law firm
     or a carrier through no code path, and asking for them here is refused
     exactly as before. On a PRIVATE send, mail_check is refused by name the
     same way — no context is ever quietly widened. */
  const rawMethods = Array.isArray(body.methods) ? body.methods.map(x => String(x)) : null;
  /* The non-private option set is the adapter's answer: Mail Check always,
     Bill.com only once genuinely configured (BILLCOM.md). Asking for
     bill_com while it is not ready is refused BY NAME rather than folded
     into the consumer-method refusal — the admin's fix is Settings, not the
     tick boxes. */
  const billcom = await billcomState(env);
  const npAllowed = billcom.ready ? ['mail_check', 'bill_com'] : ['mail_check'];
  const npPicked = includePayment && !CONTEXT_TAKES_PAYMENT(sendCtx)
    && rawMethods !== null && rawMethods.length > 0
    && rawMethods.every(m => npAllowed.includes(m))
    ? [...new Set(rawMethods)] : [];
  const mailCheckOn = npPicked.includes('mail_check');
  const billcomOn = npPicked.includes('bill_com');
  if (includePayment && !CONTEXT_TAKES_PAYMENT(sendCtx) && !npPicked.length) {
    if ((rawMethods || []).includes('bill_com') && !billcom.ready
        && (rawMethods || []).every(m => m === 'bill_com' || m === 'mail_check')) {
      return json({ error: 'Bill.com is not configured yet — it needs the enable word and the '
        + 'https payment link in Settings → Invoice defaults before it can be offered. '
        + 'Mail Check is available now.', code: 'billcom_not_configured' }, 400);
    }
    const who = linkedCase ? `${linkedCase} is a ${sendCtx} assignment` : `This is a ${sendCtx} assignment`;
    return json({ error: `${who} — Cash App and Venmo are private-client methods and cannot be `
      + `included. The payment options here are Mail Check${billcom.ready ? ' and Bill.com' : ''}.`,
      code: 'legal_no_payment_block' }, 400);
  }
  if (includePayment && CONTEXT_TAKES_PAYMENT(sendCtx)
      && (rawMethods || []).some(m => m === 'mail_check' || m === 'bill_com')) {
    return json({ error: 'Mail Check and Bill.com ride legal and insurance sends. A private '
      + 'client keeps the Cash App and Venmo options.', code: 'mail_check_not_private' }, 400);
  }

  if (!(await withinRateLimit(env, 'mail'))) {
    return json({ error: 'Too many emails in one minute — wait a moment and send again.' }, 429);
  }

  // Now the case is known and checked, so the sheet can carry ITS retainer —
  // or, on a pre-case send where there is no case to read, the figure the
  // admin agreed on screen. A stored figure always wins; see retainerForSend.
  const retainer = await retainerForSend(env, caseNo, body.retainer_amount);
  /* THE DOCUMENT IS BUILT FOR THE CONTEXT, NOT JUST THE PRODUCT (Unit 28).
     `sheetById` returns the raw product, so a legal send emailed the PRIVATE
     card's audience and closing — "Private surveillance, domestic and family
     investigations" — to a law firm, while the screen showed the legal card.
     The figures are identical either way; what differs is who it says it is
     for, which is the owner's "must clearly identify LEGAL / LAW FIRM". */
  /* AND FOR A FIXED LEGAL SERVICE, THE DOCUMENT IS THE SERVICE'S OWN
     (LEGAL-SERVICES.md D4/D5): the concise flat-fee sheet, not the retainer
     product — "a law firm buying a $250 Person Locate should receive a
     concise $250 Person Locate rate sheet". General, Surveillance and Custom
     stay the legal card, which IS the existing legal pricing. */
  const sheet = legalSvc && legalSvc.model === 'fixed'
    ? legalFixedSheet(legalSvc, flatFee)
    : sheetForContext(id, sendCtx, retainer);

  /* The Options step (UIBUILD P18): include the intake, or not. Which intake
     is never the caller's choice.

     IT IS PAIRED TO THE CONTEXT, NOT TO THE SHEET (hotfix, 2026-08-21). The
     sheet is the PRODUCT and the door is the FORM, and Legal is exactly where
     those two part company: a legal case takes the private SHEET by design
     (D1/D2 — one pricing source) while its door is `?assignment=legal`. Keyed
     off `sheet.id`, a law firm was emailed the private door — the one whose
     `pickSvc` refuses `legal`, so the recipient could not have used it. The
     rule was already written down four lines above `CONTEXT_INTAKE` and
     already obeyed by `sendLeadIntake` and `sendPreCaseIntake`; this was the
     third reader, keyed off the wrong thing.

     Resolved ONCE here and passed down, so the body, the URL and the response
     label cannot disagree — three derivations of one answer is three chances
     to drift, which is how this one survived. */
  const includeIntake = body.include_intake === true || body.include_intake === 1 || body.include_intake === '1';
  const baseDoor = includeIntake ? (intakeForContext(sendCtx) || null) : null;
  /* The Start Assignment action opens the form on the service the sheet
     quoted (LEGAL-SERVICES.md D5/D9): the legal door plus `&service=`,
     resolved HERE beside the door itself so the email body, the URL and the
     response label cannot disagree. Any named legal service carries — the
     retainer-model sheet's door preselects too, because that is the service
     the office chose to quote. */
  const intakeDoor = baseDoor && legalSvc
    ? { ...baseDoor, url: `${baseDoor.url}&service=${legalSvc.id}` }
    : baseDoor;
  const intakeUrl = intakeDoor ? intakeDoor.url : null;

  /* Payment instructions ride only with the PRIVATE sheet (PAYMENTS.md).
     Asking for them on the carrier sheet is REFUSED rather than quietly
     dropped: the client is equally safe either way, but a silent drop hides
     the fact that something asked for it, and the whole point of this feature
     is that a carrier never sees a consumer payment handle. If that request
     ever arrives, someone wants to know.

     `methods` is the admin's per-send selection. It can only ever narrow what
     the central configuration has enabled — paymentOptionsFor drops anything
     not enabled there, so the wizard cannot switch a method on. */
  if (includePayment && !npPicked.length && !sheetTakesPayment(sheet.id)) {
    return json({ error: 'Payment options are private-client only and cannot be sent with the '
                       + 'Insurance Assignment Rates.' }, 400);
  }
  /* A SHEET SENDS BEFORE A CASE EXISTS, payment options included (owner,
     2026-08-15 — PRE-CASE SENDS), and the payment boundary does NOT depend on
     that (owner's refactor, same day).

     The context is the sheet: `insurance_assignment` is INSURANCE and can never
     reach a payment method, checked immediately above. A recipient lookup used
     to sit here as well, trying to spot a carrier by their email address; it is
     gone, along with the four defects it produced. Whether a case reference
     resolves, is mistyped, or is absent entirely now changes nothing about what
     may be attached — only about what the subject line says.

     A reference that DOES resolve to a claim assignment is still refused the
     consumer sheet by the pairing rule above, and that check reads
     `submissions.kind`, a typed column with a CHECK constraint. Reading a typed
     field is not inference; comparing email strings was. */
  const wantedMethods = Array.isArray(body.methods)
    ? body.methods.map(x => String(x)).filter(x => PAY_IDS.includes(x)) : null;
  const brokenMethods = [];
  // The sheet's own context is passed through, so the refusal is the function's
  // as well as this route's — two independent gates, not one repeated.
  const payment = (includePayment && !npPicked.length)
    ? await paymentOptionsFor(env, wantedMethods, brokenMethods, contextForSheet(sheet.id)) : [];

  /* A method switched on with no link cannot be offered, and must not be
     dropped in silence — the admin would see a successful send and never learn
     the client got one option instead of two. Named, refused, fixable. */
  if (includePayment && !npPicked.length && brokenMethods.length) {
    const names = brokenMethods.map(m => m.display_name || m.label).join(' and ');
    return json({ error: `${names} is switched on but has no payment link, so it cannot be `
                       + `offered — every payment option a client sees has to be tappable. `
                       + `Add a link in Settings, or switch it off.`,
                  needs_link: brokenMethods.map(m => m.id) }, 400);
  }
  if (includePayment && !npPicked.length && !payment.length) {
    /* Two different reasons for nothing to send, and they need different
       sentences: one is answered in this dialog, the other in Settings. */
    return json({ error: wantedMethods && !wantedMethods.length
      ? 'Choose at least one payment method, or untick payment instructions.'
      : 'No payment method is enabled and configured. Set one up in Settings '
        + 'before including payment instructions.' }, 400);
  }

  /* CONTEXT-GUARDED (LEGAL-SERVICES.md D10): /sheets already excluded the
     private card from the Bill.com line, but this wrap did not — so a PRIVATE
     send with Bill.com configured would have carried the line to a private
     client. The line rides legal and insurance sends only, like Mail Check. */
  const { text, html } = sheetEmail(withBillcomLine(sheet,
    billcom.ready && !CONTEXT_TAKES_PAYMENT(sendCtx)), note, intakeDoor, payment, retainer, npPicked);
  const subject = caseNo
    ? `${sheet.name} — Always Precise Investigations (case ${caseNo})`
    : `${sheet.name} — Always Precise Investigations`;

  const mail = await sendMail(env, { to, subject, text, html });
  if (!mail.sent) {
    await logSend(env, user, { case_no: linkedCase, kind: 'rate_sheet', sheet_id: sheet.id,
      door: intakeUrl, recipient: to, ok: 0, detail: mail.reason || 'send failed' });
    if (payment.length || npPicked.length) {
      await logPaymentSend(env, user, { case_no: linkedCase, recipient: to,
        methods: npPicked.length ? npPicked : payment.map(x => x.id), with_sheet: 1, ok: 0,
        detail: mail.reason || 'send failed' });
    }
    return json({
      error: mail.reason === 'not_configured'
        ? 'Email is not configured on the Worker. Add RESEND_API_KEY to send from here.'
        : 'That did not send. Check the address and try again.',
      reason: mail.reason,
    }, 502);
  }
  await logSend(env, user, { case_no: linkedCase, kind: 'rate_sheet', sheet_id: sheet.id,
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
  if (payment.length || npPicked.length) {
    await logPaymentSend(env, user, { case_no: linkedCase, recipient: to,
      methods: npPicked.length ? npPicked : payment.map(x => x.id), with_sheet: 1, ok: 1 });
  }
  /* §13 — the confirmation lists exactly what WENT. Read back from the record
     of the send rather than echoed from the request, and note that sending
     instructions says nothing whatever about the retainer being paid. */
  return json({ ok: true, sent_to: to, sheet: sheet.id,
    send_context: sendCtx,
    /* Which legal service the document was generated from — observable and
       asserted, the send_context rule applied one level down. Absent when no
       service was named or on file, which is the pre-unit send exactly. */
    legal_service: legalSvc
      ? { id: legalSvc.id, label: legalSvc.label, model: legalSvc.model } : undefined,
    /* The figure the fixed document actually carried — observable, so the
       screen, the record and the email cannot quietly disagree (D13). */
    flat_fee: legalSvc && legalSvc.model === 'fixed' ? flatFee : undefined,
    included: {
      rate_sheet: sheet.name,
      intake: intakeDoor ? intakeDoor.label : null,
      payment_methods: npPicked.length
        ? npPicked.map(id => ({ id, label: id === 'bill_com' ? BILLCOM_LINE.label : MAIL_CHECK_LINE.label }))
        : payment.map(x => ({ id: x.id, label: x.label })),
    } });
}

/* SEND PAYMENT OPTIONS ON THEIR OWN (PAYMENTS.md second handoff §1/§4).

   The private lead card's third send action. Everything about the boundary is
   decided HERE, not by the card declining to draw a button — the card is a
   convenience and the Worker is the enforcement point, the same split the
   rate-sheet pairing already uses.

   THREE RULES, and each has cost something somewhere in this system before:

   1. A CLAIMS LEAD IS REFUSED BY NAME, not quietly given an empty email. The
      whole point of the feature is that a carrier never sees a consumer payment
      handle, and a silent drop hides the fact that something asked for one.

   2. NOTHING HERE MARKS THE RETAINER PAID. Asking for money is not receiving
      it. `payment_send` records that the firm asked; `retainer_payment` records
      arrival; they are separate tables so the two cannot be confused by a
      well-meaning edit later.

   3. THE LEAD IS NOT STAMPED. The nine §5 lead statuses describe the rate
      sheet and the intake, and there is no payment status among them — so
      moving the lead to "Rate Sheet Sent" because payment instructions went
      would put a false event in the history. The send is recorded in
      `payment_send`, which is where it belongs. */
async function emailPaymentOptions(request, env, user) {
  const body = await readJson(request);
  const to = String(body.to || '').trim();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(to) || to.length > 200) {
    return json({ error: 'Enter a valid email address.' }, 400);
  }
  /* Same scrubbing as the sheet send: these reach an email body and a subject
     line, and a CR/LF smuggled into a header is how one email becomes several. */
  const clean = (v, max) => String(v == null ? '' : v)
    .replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);
  const note = clean(body.note, 500);
  const name = clean(body.name, 120);
  const caseNo = String(body.case_no || '').replace(/[^\x20-\x7e]/g, '').slice(0, 64);

  /* THE TYPED VALUE IS A REFERENCE UNTIL IT RESOLVES TO A CASE — the same split
     `emailSheet` makes for `send_log`, and for the same reason.

     `payment_send.case_no` says "null when sent with no case or lead", so the
     free text the office wrote down does not belong in it. The lookup below
     already has to happen for RULE 1, so this costs nothing extra, and nothing
     about what is SENT changes — the subject line still carries whatever was
     typed. */
  let linkedCase = null;

  /* RULE 1, AND IT MUST NOT FAIL OPEN (Codex stop-time review, 2026-08-15).

     This was `if (lead && lead.kind === 'claims')`, and the comment above it
     claimed that "a typo cannot turn a carrier into a private client". It did
     the opposite: a reference that resolved to nothing skipped the check
     entirely and the send went. One wrong character in a carrier's case number
     was enough to put Cash App and Venmo in front of an adjuster, and the
     reproduction confirmed it — status 200, email delivered.

     There are three states here, not two, and conflating the last two is the
     whole bug:

       no reference       — allowed. The owner's §4 says "Optional Case / Lead
                            Reference", and the firm does send instructions to
                            people who have no case yet.
       a private lead     — allowed, which is the ordinary path.
       anything else      — REFUSED. A claims lead obviously; but also a
                            reference the office believes in and the system
                            cannot confirm, because "I cannot find this" is not
                            evidence of "this is safe to send to". */
  if (caseNo) {
    const lead = await env.DB.prepare('SELECT kind, payload FROM submissions WHERE case_no = ?')
      .bind(caseNo).first();
    /* A REFERENCE THAT MATCHES NOTHING DOES NOT BLOCK THE SEND (owner,
       2026-08-15 — PRE-CASE SENDS, a blocking workflow defect).

       This refused an unresolvable reference, and that was wrong for the way
       the office actually works: a client is quoted, sent instructions and
       given a paper reference BEFORE any case exists. Name and a valid email
       are enough to send; the case number, claim number and internal reference
       are optional whenever they happen to be available.

       The boundary does not depend on this and never did. THIS ROUTE IS A
       PRIVATE CONTEXT by construction — it sends exactly one thing, private
       payment instructions — so there is no classification to get wrong here.
       The refusal below is a courtesy on top of that: if the reference DOES
       resolve to a claim assignment, the office has clearly reached for the
       wrong flow and should be told rather than obeyed.

       That check reads `submissions.kind`, a typed column with a CHECK
       constraint. Reading a typed field is not inference. An earlier version
       also tried to recognise the RECIPIENT by comparing their email address
       against stored carrier contacts; it produced four defects in four review
       rounds and the owner removed it. A mistyped or absent reference now
       changes nothing about what may be sent — only what the subject says. */
    if (lead && contextForSub(lead) === SEND_CONTEXT.INSURANCE) {
      return json({ error: `${caseNo} is a claim assignment. Cash App and Venmo are private-client `
                         + `payment methods and are never sent to a carrier or TPA.` }, 400);
    }
    /* UNIT 6 — refused by name, exactly like a claims case: these instructions
       ARE Cash App and Venmo, and a law firm is billed by invoice or retainer
       check. Requesting either of those is never a payment (D8) and is not
       sent from here. */
    if (lead && contextForSub(lead) === SEND_CONTEXT.LEGAL) {
      return json({ error: `${caseNo} is a legal assignment. Cash App and Venmo are private-client `
                         + `payment methods — law firms are billed by BILL.com invoice or retainer check.` }, 400);
    }
    // Past the refusal, so anything found here is a private lead: a real case.
    if (lead) {
      // Same body-not-path reason as the sheet send, and the same one helper —
      // two copies of this rule is exactly how the archived half went missing.
      const refusal = await caseSendRefusal(env, caseNo);
      if (refusal) return refusal;
      linkedCase = caseNo;
    }
  }

  if (!(await withinRateLimit(env, 'mail'))) {
    return json({ error: 'Too many emails in one minute — wait a moment and send again.' }, 429);
  }

  const wantedMethods = Array.isArray(body.methods)
    ? body.methods.map(x => String(x)).filter(x => PAY_IDS.includes(x)) : null;
  const brokenMethods = [];
  const payment = await paymentOptionsFor(env, wantedMethods, brokenMethods,
    SEND_CONTEXT.PRIVATE);

  // Same two refusals, in the same words, as the sheet send — one of them is
  // answered in this dialog and the other in Settings.
  if (brokenMethods.length) {
    const names = brokenMethods.map(m => m.display_name || m.label).join(' and ');
    return json({ error: `${names} is switched on but has no payment link, so it cannot be `
                       + `offered — every payment option a client sees has to be tappable. `
                       + `Add a link in Settings, or switch it off.`,
                  needs_link: brokenMethods.map(m => m.id) }, 400);
  }
  if (!payment.length) {
    return json({ error: wantedMethods && !wantedMethods.length
      ? 'Choose at least one payment method.'
      : 'No payment method is enabled and configured. Set one up in Settings '
        + 'before sending payment instructions.' }, 400);
  }

  // The case's OWN agreed retainer, so this email and the sheet quote the same
  // figure. A client told one number by the sheet and another by the payment
  // email has been given a reason to distrust both.
  const retainer = await retainerForSend(env, caseNo, body.retainer_amount);
  const { text, html } = paymentOnlyEmail(payment, retainer, note, name);
  const subject = caseNo
    ? `Payment options — Always Precise Investigations (case ${caseNo})`
    : 'Payment options — Always Precise Investigations';

  const mail = await sendMail(env, { to, subject, text, html });
  if (!mail.sent) {
    await logPaymentSend(env, user, { case_no: linkedCase, recipient: to,
      methods: payment.map(x => x.id), with_sheet: 0, ok: 0,
      detail: mail.reason || 'send failed' });
    return json({
      error: mail.reason === 'not_configured'
        ? 'Email is not configured on the Worker. Add RESEND_API_KEY to send from here.'
        : 'That did not send. Check the address and try again.',
      reason: mail.reason,
    }, 502);
  }
  /* with_sheet: 0 is what makes this send distinguishable from the one that
     rode along with a rate sheet. The column existed before the route did. */
  await logPaymentSend(env, user, { case_no: linkedCase, recipient: to,
    methods: payment.map(x => x.id), with_sheet: 0, ok: 1 });

  // RULE 2, said out loud in the answer the page shows. The context is stated
  // too: this route is PRIVATE by construction and can be nothing else.
  return json({ ok: true, sent_to: to, retainer_marked_paid: false,
    send_context: SEND_CONTEXT.PRIVATE,
    included: { payment_methods: payment.map(x => ({ id: x.id, label: x.label })) } });
}

/* Manual intake (UIBUILD P17): the office types in what a phone call or an
   email brought, and it becomes a submission like any other — same table,
   same workspace, no parallel lead store to drift. The only hard requirement
   is knowing WHO: everything else can arrive later (INTAKE-NA's principle —
   never force fake information to pass validation). */
async function createManualIntake(request, env, user) {
  const body = await readJson(request);
  /* UNIT 6 — 'legal' is the third product here and the whole Quick Legal
     Assignment path: the office types in what a phone call brought ("come by
     and pick up the papers and the retainer") and fills the rest in later. It
     stores as kind='consumer' with the payload marker, exactly like the public
     legal door (D1), so pricing, retainer and every consumer read work on it
     unchanged. */
  const legal = body.kind === 'legal';
  const kind = body.kind === 'claims' ? 'claims'
             : (body.kind === 'consumer' || legal) ? 'consumer' : null;
  if (!kind) return json({ error: 'Pick Insurance/Commercial, Private Client or Legal / Law Firm first.' }, 400);
  const who = String((kind === 'claims' ? (body.carrier || body.client_name)
                     : legal ? (body.firm_name || body.attorney_name)
                     : body.client_name) || '').trim();
  if (!who) {
    return json({ error: kind === 'claims'
      ? 'Name the carrier or the assigning contact.'
      : legal ? 'Name the law firm (or the attorney, if the firm name is not to hand).'
      : 'Name the client.' }, 400);
  }
  if (legal && body.payment_arrangement && !LEGAL_ARRANGEMENTS[String(body.payment_arrangement)]) {
    return json({ error: 'Pick one of the four legal payment arrangements — BILL.com invoice/ACH, '
      + 'check pick-up, check by mail, or an existing billing arrangement.' }, 400);
  }
  /* LEGAL-SERVICES.md D2/D3 — the pricing-level service, validated against the
     catalogue. OPTIONAL, like the assignment type: a phone call that never
     settled the service files with no marker and renders under the retainer
     model, which is the honest record of what was actually decided. */
  if (legal && body.legal_service != null && String(body.legal_service).trim() !== ''
      && !legalServiceById(body.legal_service)) {
    return json({ error: 'No such legal service. The services are: '
      + Object.values(LEGAL_SERVICES).map(s => s.label).join(', ') + '.' }, 400);
  }

  const fields = ['service', 'client_name', 'client_email', 'client_phone', 'client_address',
    'carrier', 'claim_number', 'policy_number', 'claim_type', 'date_of_loss',
    'adjuster', 'adjuster_email', 'adjuster_phone', 'defense_counsel',
    'subject_name', 'subject_address', 'subject_description', 'subject_relationship',
    'objective', 'timeline', 'notes'];
  const payload = {};
  for (const f of fields) { const v = pick(body, f); if (v) payload[f] = v; }
  if (legal) {
    payload.assignment = 'legal';
    for (const f of LEGAL_FIELDS) { const v = cleanLegal(body[f]); if (v) payload[f] = v; }
    /* The service marker (D3), and the finer category defaulted from it ONLY
       where the office typed none — a typed assignment_type is the office's
       own word and is never overwritten by a mapping. */
    const lsvc = legalServiceById(body.legal_service);
    if (lsvc) {
      payload.legal_service = lsvc.id;
      if (!payload.assignment_type) payload.assignment_type = lsvc.assignment_type;
    }
    /* The attorney is the client-side contact of record when no separate
       client contact was typed — the denormalised columns feed the case list
       and the send flows, and a legal lead with an empty contact column would
       be unreachable from every send door. */
    if (!payload.client_name && payload.attorney_name) payload.client_name = payload.attorney_name;
    if (!payload.client_email && payload.attorney_email) payload.client_email = payload.attorney_email;
    if (!payload.client_phone && payload.attorney_phone) payload.client_phone = payload.attorney_phone;
  }
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
        .bind(caseNo, kind, payload.service || (legal ? 'Legal investigation assignment' : null),
          payload.client_name || null, payload.client_email || null, payload.client_phone || null,
          payload.subject_name || null, payload.carrier || null, payload.claim_number || null,
          JSON.stringify(payload), nowIso()).run();
      /* The structured legal row, guarded like the public ingest's: the
         payload above already holds every field, so a missing table costs
         structure, never data. */
      if (legal && !(await missingTables(env)).includes('legal_intake')) {
        try { await writeLegalRow(env, caseNo, payload, user.id); } catch { /* payload holds it */ }
      }
      /* UNIT 7 — THE PROFILE IS RECORDED AFTER THE CASE IS WRITTEN, AND FROM
         THE BODY ONLY. Prefill happened in the browser: whatever the office
         left in those inputs is what went into `payload` above, so an edit
         made on the way through is an edit to THIS assignment and nothing
         else. Nothing re-reads the profile to build the case, and nothing
         writes back to it — the link row is provenance. */
      const prof = await profileOnCreate(env, caseNo, body, payload, kind, legal, user);
      await notifyAdmins(env, 'intakes', caseNo);
      return json({ ok: true, case_no: caseNo, legal, ...prof }, 201);
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
  const missing = await missingTables(env);
  const have = t => !missing.includes(t);

  /* THE ALERTS STRIP IS "WHAT NEEDS MY ATTENTION TODAY", so a case the office
     archived or deleted does not belong in it. Without this a deleted case came
     straight back into Needs assignment and Out now the moment a day was
     running on it — hidden from the list and loud on the dashboard above it
     (Codex stop-time review, 2026-08-16).

     Guarded on the tables existing, for the deploy-order reason the case list
     already documents. */
  const hide = [
    have('case_archive') ? 'AND case_no NOT IN (SELECT case_no FROM case_archive)' : '',
    have('case_deleted') ? 'AND case_no NOT IN (SELECT case_no FROM case_deleted)' : '',
  ].filter(Boolean).join(' ');
  const scope = admin
    ? (hide ? `WHERE 1 = 1 ${hide}` : '')
    : `WHERE assigned_to = ? ${hide}`;
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
      `SELECT COUNT(*) AS n FROM submissions
        WHERE assigned_to IS NULL AND status != 'closed' ${hide}`).first();
    out.unassigned = row ? Number(row.n) || 0 : 0;
  }

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
    /* UNIT 5 — the dashboard names a dead file store instead of the office
       discovering it at the next upload. Local reads only: env + one D1 row.
       `dropboxState` never calls Dropbox, so this cannot slow the dashboard
       or count against anyone's API. */
    if (user.role === 'admin') {
      /* Admin only, like the /dropbox/status it summarises. A boolean names no
         account — but an investigator learns storage state from the upload
         refusal that affects them, not from a firm-wide flag. */
      try {
        const dbx = await dropboxState(env);
        out.dropbox_ok = Boolean(dbx.connected);
        out.dropbox_configured = Boolean(dbx.app_configured);
      } catch { /* the summary is not allowed to fail over a status read */ }
    }
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

  /* Every alert above is a list of case numbers built by its own query. The
     archived and deleted ones are removed ONCE, here, rather than by copying
     the same NOT IN into each — the copy is what gets forgotten the day a
     seventh alert is added. */
  const hidden = await hiddenCases(env);
  if (hidden.size) {
    for (const k of Object.keys(out)) {
      if (Array.isArray(out[k])) out[k] = out[k].filter(c => !hidden.has(c));
    }
  }

  return json({ summary: out });
}

/* ---- UNIT 5: RECENT ACTIVITY (owner) ----

   "Provide a useful compact Recent Activity section from existing
   structured/audit/activity data... Do not load large media assets just to
   render the activity feed."

   Every source below is a table that already exists, read by indexed-enough
   columns with its own LIMIT, merged and cut in JS. No media is touched —
   evidence contributes its FILENAME and where it went, never bytes. Archived
   and deleted cases are excluded the same way every dashboard read excludes
   them. Admin-only, like the dashboard that draws it: the feed spans every
   case, which is exactly what an investigator's view must never do. */
/* The feed's arm vocabulary IS the hide vocabulary (DASH-DELETE): a line is
   addressed by the arm it came from plus the source row's own id, and
   `/feed/hide` validates the kind against this map — which table the id must
   exist in, and how to learn whose case the line described. `package` is the
   one arm whose case number lives on the parent build. */
const FEED_KINDS = {
  intake:   'SELECT case_no FROM submissions WHERE id = ?',
  day:      'SELECT case_no FROM case_days WHERE id = ?',
  report:   'SELECT case_no FROM case_reports WHERE id = ?',
  evidence: 'SELECT case_no FROM case_evidence WHERE id = ?',
  payment:  'SELECT case_no FROM retainer_payment WHERE id = ?',
  package:  `SELECT b.case_no FROM build_events e
               JOIN case_builds b ON b.id = e.build_id WHERE e.id = ?`,
};

async function recentActivity(env) {
  const hidden = await hiddenCases(env);
  const missing = await missingTables(env);
  /* Hidden lines are excluded IN EACH ARM'S SQL, before that arm's LIMIT, so
     hiding the ten newest lines of one kind surfaces older ones instead of
     emptying the arm. Guarded the way search guards its case_deleted
     subquery: when the table has not arrived, the feed goes unfiltered — an
     arm erroring on a missing table would come back [] through q()'s catch,
     which draws as a quiet week, the one direction this page must never
     fail in. */
  const canHide = !missing.includes('feed_hidden');
  const hide = (kind, idCol) => canHide
    ? `AND NOT EXISTS (SELECT 1 FROM feed_hidden h WHERE h.kind = '${kind}' AND h.ref_id = ${idCol})`
    : '';
  const per = 10, out = [];
  const push = (rows, kind, label) => {
    for (const r of rows || []) {
      if (!r.at || hidden.has(r.case_no)) continue;
      /* `ref` is the source row's own id — what the trash control on the page
         sends back, and the only identity a composed line has. */
      out.push({ at: r.at, kind, ref: r.id, case_no: r.case_no, detail: label(r) });
    }
  };
  const q = async sql => { try { return (await env.DB.prepare(sql).all()).results; } catch { return []; } };

  push(await q(`SELECT id, case_no, created_at AS at, kind FROM submissions
                 WHERE 1 = 1 ${hide('intake', 'submissions.id')}
                 ORDER BY id DESC LIMIT ${per}`),
    'intake', r => r.kind === 'claims' ? 'Carrier assignment received' : 'Intake received');
  push(await q(`SELECT id, case_no, created_at AS at, end_time FROM case_days
                 WHERE 1 = 1 ${hide('day', 'case_days.id')}
                 ORDER BY id DESC LIMIT ${per}`),
    'day', r => r.end_time ? 'Investigation day ended' : 'Investigation day started');
  push(await q(`SELECT id, case_no, status_at AS at, status FROM case_reports
                 WHERE status_at IS NOT NULL ${hide('report', 'case_reports.id')}
                 ORDER BY id DESC LIMIT ${per}`),
    'report', r => `Report ${r.status === 'needs_revision' ? 'sent back' : r.status}`);
  push(await q(`SELECT id, case_no, uploaded_at AS at, filename, r2_key FROM case_evidence
                 WHERE deleted_at IS NULL ${hide('evidence', 'case_evidence.id')}
                 ORDER BY id DESC LIMIT ${per}`),
    'evidence', r => `${String(r.r2_key || '').startsWith('dropbox:') ? 'Filed to Dropbox' : 'Media added'} — ${r.filename}`);
  if (!missing.includes('retainer_payment')) {
    push(await q(`SELECT id, case_no, recorded_at AS at FROM retainer_payment
                   WHERE 1 = 1 ${hide('payment', 'retainer_payment.id')}
                   ORDER BY id DESC LIMIT ${per}`),
      'payment', () => 'Retainer payment recorded');
  }
  push(await q(`SELECT e.id AS id, b.case_no, e.at AS at, e.action FROM build_events e
                 JOIN case_builds b ON b.id = e.build_id
                WHERE e.action IN ('finalized', 'delivered') ${hide('package', 'e.id')}
                ORDER BY e.id DESC LIMIT ${per}`),
    'package', r => r.action === 'delivered' ? 'Package delivered' : 'Package finalized');

  out.sort((a, b) => a.at < b.at ? 1 : -1);
  return out.slice(0, 12);
}

/* ====================================================== UNIT 8: GLOBAL SEARCH

   ONE BOX THAT FINDS THE CASE. Structured operational search over records the
   portal already holds — no document text, no media, no Dropbox, no semantic
   anything. Each arm is a bounded query against a real column, and every
   result says WHAT matched so the office is never guessing why a row appeared.

   THE ROLE BOUNDARY IS IN THE SQL, not in the page. Every case-scoped arm
   joins `submissions` and applies `s.assigned_to = ?` for an investigator, so
   search cannot become the one door that hands them the firm's whole book of
   work. The arms that read the PAYING side — the client's own phone, the firm,
   the attorney, the saved profiles, a colleague's name — do not run for them at
   all: an arm that cannot execute is a stronger boundary than one that filters.

   WHAT IS AND IS NOT INDEXED, stated rather than implied. `case_no` and
   `claim_number` carry indexes and are matched by PREFIX, which can seek.
   Everything else is a substring or a punctuation-stripped comparison, which
   no index can serve — so each of those reads its table, bounded by ARM_CAP and
   by the arm count. That is the deliberate trade for an operational directory
   of this size; it is not dressed up as something faster than it is. */

const SEARCH_ARM_CAP = 8;    // rows any single arm may contribute
const SEARCH_TOTAL_CAP = 24; // rows the whole answer may carry
const SEARCH_MIN = 2;        // shorter than this matches half the database

/* Digits only, for a phone typed any of the ways a phone gets typed. */
const searchDigits = v => String(v == null ? '' : v).replace(/\D+/g, '');
/* Letters and numbers only, upper case: ABC-123, ABC 123 and abc123 are one
   plate. Nothing else is folded — a plate is not a name. */
const searchPlate = v => String(v == null ? '' : v).replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/* SQLite has no regex, so the punctuation a person types into a phone number or
   a plate is stripped in SQL by nesting REPLACE. Written once, here, because
   five copies of this expression is five chances to strip a different set. */
const sqlStrip = (col, chars) =>
  chars.split('').reduce((acc, c) => `REPLACE(${acc}, '${c}', '')`, col);
const SQL_PHONE = col => sqlStrip(col, "()- .+");
const SQL_PLATE = col => `UPPER(${sqlStrip(col, "()- .")})`;

async function globalSearch(request, env, user) {
  const url = new URL(request.url);
  const raw = String(url.searchParams.get('q') || '').trim();
  if (raw.length < SEARCH_MIN) return json({ results: [], q: raw, too_short: true });

  const admin = user.role === 'admin';
  const like = `%${raw.toLowerCase()}%`;
  const prefix = `${raw.toLowerCase()}%`;
  const digits = searchDigits(raw);
  const plate = searchPlate(raw);
  const missing = await missingTables(env);
  const have = t => !missing.includes(t);

  /* A deleted case has left every ordinary view, so it has left this one.
     An archived case is still a real case and is found, badged. */
  const notDeleted = have('case_deleted')
    ? 'AND s.case_no NOT IN (SELECT case_no FROM case_deleted)' : '';
  const mine = admin ? '' : 'AND s.assigned_to = ?';
  const meBind = admin ? [] : [user.id];

  /* One entry per thing found. A case that matches on three arms is ONE
     result carrying three reasons, not three rows saying the same case. */
  const found = new Map();
  const add = (key, row, matched) => {
    const existing = found.get(key);
    if (existing) {
      if (existing.matched.length < 3 && !existing.matched.includes(matched)) existing.matched.push(matched);
      return;
    }
    if (found.size >= SEARCH_TOTAL_CAP) return;
    found.set(key, { ...row, matched: [matched] });
  };

  const run = async (sql, binds) => {
    try { return (await env.DB.prepare(sql).bind(...binds).all()).results || []; }
    catch { return []; }   // one arm's failure must not empty the whole answer
  };

  const CASE_COLS = `s.case_no, s.kind, s.status, s.client_name, s.carrier, s.claim_number,
    s.subject_name, s.created_at, cs.stage,
    CASE WHEN json_valid(s.payload) AND json_extract(s.payload, '$.assignment') = 'legal'
         THEN 1 ELSE 0 END AS legal`;
  const CASE_FROM = `FROM submissions s LEFT JOIN case_status cs ON cs.case_no = s.case_no`;
  const caseRow = r => ({
    type: (r.stage || r.status) === 'new' || (r.stage || r.status) === 'awaiting_client'
      ? 'intake' : 'case',
    case_no: r.case_no, kind: r.kind, legal: !!Number(r.legal),
    stage: r.stage || r.status,
    /* An investigator is never told who is paying, so the line under a case is
       the SUBJECT for them and the client for the office. */
    title: r.case_no,
    subtitle: admin ? (r.legal ? r.client_name : r.kind === 'claims' ? (r.carrier || r.client_name)
      : r.client_name) || r.subject_name || '' : (r.subject_name || ''),
    claim_number: admin ? r.claim_number : null,
    dest: { view: 'case', case_no: r.case_no },
  });

  // ---- the case's own identifiers. Prefix-matched, so the index can seek. --
  for (const [col, label] of [['s.case_no', 'case number'], ['s.claim_number', 'claim number']]) {
    for (const r of await run(
      `SELECT ${CASE_COLS} ${CASE_FROM}
        WHERE LOWER(${col}) LIKE ? ${mine} ${notDeleted}
        ORDER BY s.created_at DESC LIMIT ${SEARCH_ARM_CAP}`, [prefix, ...meBind])) {
      add(`case:${r.case_no}`, caseRow(r), label);
    }
  }

  // ---- who the case is for. Admin only: this is the paying side. ----------
  if (admin) {
    for (const [col, label] of [['s.client_name', 'client name'], ['s.carrier', 'carrier'],
      ['s.client_email', 'email']]) {
      for (const r of await run(
        `SELECT ${CASE_COLS} ${CASE_FROM}
          WHERE LOWER(${col}) LIKE ? ${notDeleted}
          ORDER BY s.created_at DESC LIMIT ${SEARCH_ARM_CAP}`, [like])) {
        add(`case:${r.case_no}`, caseRow(r), label);
      }
    }
    if (digits.length >= 7) {
      for (const r of await run(
        `SELECT ${CASE_COLS} ${CASE_FROM}
          WHERE s.client_phone IS NOT NULL AND ${SQL_PHONE('s.client_phone')} LIKE ?
            ${notDeleted} ORDER BY s.created_at DESC LIMIT ${SEARCH_ARM_CAP}`, [`%${digits}`])) {
        add(`case:${r.case_no}`, caseRow(r), 'client phone');
      }
    }
    // The investigator by name, so "what is Dana on?" is one search.
    for (const r of await run(
      `SELECT ${CASE_COLS} ${CASE_FROM} JOIN users u ON u.id = s.assigned_to
        WHERE LOWER(u.display_name) LIKE ? ${notDeleted}
        ORDER BY s.created_at DESC LIMIT ${SEARCH_ARM_CAP}`, [like])) {
      add(`case:${r.case_no}`, caseRow(r), 'investigator');
    }
  }

  /* ---- the subject. Fieldwork, so BOTH roles, scoped to their own cases. --

     THE STRUCTURED TABLE IS THE PREFERRED SOURCE and it runs first. Every case
     it answers for is remembered here, and the intake fallback below stands
     down on exactly those — so a curated case yields the richer subject row
     and never a second, thinner copy of itself. */
  const structuredSubject = new Set();
  if (have('case_subjects')) {
    for (const [col, label] of [['sub.name', 'subject name'], ['sub.alias', 'alias'],
      ['sub.addresses', 'address']]) {
      for (const r of await run(
        `SELECT ${CASE_COLS}, sub.id AS subject_id, sub.name AS sub_name, sub.alias AS sub_alias
           ${CASE_FROM} JOIN case_subjects sub ON sub.case_no = s.case_no
          WHERE LOWER(${col}) LIKE ? ${mine} ${notDeleted}
          ORDER BY s.created_at DESC LIMIT ${SEARCH_ARM_CAP}`, [like, ...meBind])) {
        structuredSubject.add(r.case_no);
        add(`subject:${r.subject_id}`, {
          ...caseRow(r), type: 'subject',
          title: r.sub_name, subtitle: r.case_no,
          alias: r.sub_alias || null,
          dest: { view: 'case', case_no: r.case_no, tab: 'subject' },
        }, label);
      }
    }
    if (digits.length >= 7) {
      for (const r of await run(
        `SELECT ${CASE_COLS}, sub.id AS subject_id, sub.name AS sub_name
           ${CASE_FROM} JOIN case_subjects sub ON sub.case_no = s.case_no
          WHERE sub.phone IS NOT NULL AND ${SQL_PHONE('sub.phone')} LIKE ?
            ${mine} ${notDeleted} ORDER BY s.created_at DESC LIMIT ${SEARCH_ARM_CAP}`,
        [`%${digits}`, ...meBind])) {
        structuredSubject.add(r.case_no);
        add(`subject:${r.subject_id}`, {
          ...caseRow(r), type: 'subject', title: r.sub_name, subtitle: r.case_no,
          dest: { view: 'case', case_no: r.case_no, tab: 'subject' },
        }, 'subject phone');
      }
    }
  }

  /* ---- THE SUBJECT AS THE INTAKE GAVE THEM (Unit 37A, the Round 2 HIGH).

     `case_subjects` is a companion table an admin fills in on the Subject
     panel. THE PUBLIC INTAKE DOES NOT WRITE IT — it writes the denormalised
     `submissions.subject_name` and puts the address in the payload. So until
     someone curated a case by hand, the arms above had nothing to read and the
     claimant's own name found nothing: "no results", which reads as "we have
     no such case". That is the reassuring direction, and it was the default
     shape of every case that arrived through the form.

     This is the fallback, and it is deliberately a FALLBACK: `structuredSubject`
     holds every case the arms above already answered for, so a curated case is
     never returned twice — once richly and once thinly. The structured row
     wins because it has the alias, the phone and the subject's own id.

     Scoped exactly like the structured arms: `mine` for an investigator,
     `notDeleted`, and the same per-arm cap. The subject is fieldwork rather
     than the paying side — `redactRow` sends `subject_name` to an investigator
     and withholds the client — so both roles search it, and an investigator
     still sees only cases they hold.

     COST, stated rather than implied: `subject_name` is a substring LIKE that
     no index can serve, exactly like the client-name and carrier arms beside
     it. The address is read out of the JSON payload, which is where the intake
     puts it and where the case screen already reads it from; `CASE_COLS`
     already does one `json_extract` per row on every arm in this function, so
     this adds a second of the same order and no new class of work. Both are
     bounded by SEARCH_ARM_CAP and neither statement grows with the data. */
  {
    /* The ADDRESS arm can match a case that has an address and no name yet —
       the intake asks for both and requires neither — so the title falls back
       to the case number rather than drawing an empty row. */
    const intakeRow = r => ({
      ...caseRow(r), type: 'subject',
      title: r.subject_name || r.case_no, subtitle: r.case_no,
      from_intake: true,
      dest: { view: 'case', case_no: r.case_no, tab: 'subject' },
    });
    for (const r of await run(
      `SELECT ${CASE_COLS} ${CASE_FROM}
        WHERE s.subject_name IS NOT NULL AND LOWER(s.subject_name) LIKE ?
          ${mine} ${notDeleted}
        ORDER BY s.created_at DESC LIMIT ${SEARCH_ARM_CAP}`, [like, ...meBind])) {
      if (structuredSubject.has(r.case_no)) continue;
      add(`subject:intake:${r.case_no}`, intakeRow(r), 'subject name');
    }
    for (const r of await run(
      `SELECT ${CASE_COLS} ${CASE_FROM}
        WHERE json_valid(s.payload)
          AND LOWER(json_extract(s.payload, '$.subject_address')) LIKE ?
          ${mine} ${notDeleted}
        ORDER BY s.created_at DESC LIMIT ${SEARCH_ARM_CAP}`, [like, ...meBind])) {
      if (structuredSubject.has(r.case_no)) continue;
      add(`subject:intake:${r.case_no}`, intakeRow(r), 'address');
    }
  }

  // ---- the vehicle. Also fieldwork, also both roles. ----------------------
  if (have('subject_vehicles')) {
    const vRow = r => ({
      ...caseRow(r), type: 'vehicle',
      title: [r.v_year, r.v_make, r.v_model].filter(Boolean).join(' ') || 'Vehicle',
      subtitle: [[r.v_state, r.v_plate].filter(Boolean).join(' '), r.case_no].filter(Boolean).join(' · '),
      plate: r.v_plate || null, color: r.v_color || null,
      dest: { view: 'case', case_no: r.case_no, tab: 'subject' },
    });
    const V = `v.id AS vehicle_id, v.year AS v_year, v.make AS v_make, v.model AS v_model,
      v.color AS v_color, v.plate AS v_plate, v.plate_state AS v_state`;
    const VJOIN = `JOIN case_subjects sub ON sub.case_no = s.case_no
                   JOIN subject_vehicles v ON v.subject_id = sub.id`;
    if (plate.length >= 2) {
      for (const r of await run(
        `SELECT ${CASE_COLS}, ${V} ${CASE_FROM} ${VJOIN}
          WHERE v.plate IS NOT NULL AND ${SQL_PLATE('v.plate')} LIKE ?
            ${mine} ${notDeleted} ORDER BY s.created_at DESC LIMIT ${SEARCH_ARM_CAP}`,
        [`%${plate}%`, ...meBind])) {
        add(`vehicle:${r.vehicle_id}`, vRow(r), 'license plate');
      }
    }
    for (const [col, label] of [['v.make', 'vehicle make'], ['v.model', 'vehicle model'],
      ['v.color', 'vehicle colour']]) {
      for (const r of await run(
        `SELECT ${CASE_COLS}, ${V} ${CASE_FROM} ${VJOIN}
          WHERE LOWER(${col}) LIKE ? ${mine} ${notDeleted}
          ORDER BY s.created_at DESC LIMIT ${SEARCH_ARM_CAP}`, [like, ...meBind])) {
        add(`vehicle:${r.vehicle_id}`, vRow(r), label);
      }
    }
  }

  // ---- the firm on a case, and the matter. ADMIN ONLY: `redactRow` strips
  //      every one of these columns from an investigator's case list, so
  //      search must not be the way back to them.
  if (admin && have('legal_intake')) {
    for (const [col, label] of [['li.firm_name', 'law firm'], ['li.attorney_name', 'attorney'],
      ['li.paralegal_name', 'paralegal'], ['li.billing_name', 'billing contact'],
      ['li.matter_number', 'matter number'], ['li.court_case_number', 'court case number']]) {
      for (const r of await run(
        `SELECT ${CASE_COLS}, li.firm_name, li.attorney_name, li.matter_number
           ${CASE_FROM} JOIN legal_intake li ON li.case_no = s.case_no
          WHERE LOWER(${col}) LIKE ? ${notDeleted}
          ORDER BY s.created_at DESC LIMIT ${SEARCH_ARM_CAP}`, [like])) {
        const row = caseRow(r);
        add(`case:${r.case_no}`, { ...row,
          subtitle: [r.firm_name, r.attorney_name].filter(Boolean).join(' · ') || row.subtitle,
          matter_number: r.matter_number || null }, label);
      }
    }
  }

  /* ---- the saved directory (Unit 7). ADMIN ONLY, and reusing the SAME
     function the picker and the directory read, so the three can never
     disagree about what a search finds. */
  if (admin && !(await profilesMissing(env)).length) {
    const { profiles } = await searchProfiles(env, { q: raw, limit: 6, includeInactive: true });
    for (const p of profiles || []) {
      const who = (p.contacts || [])[0];
      add(`profile:${p.id}`, {
        type: 'profile', profile_kind: p.kind, kind_label: p.kind_label,
        title: p.name,
        subtitle: who ? `${[who.first_name, who.last_name].filter(Boolean).join(' ')}${
          who.role ? `, ${who.role}` : ''}` : (p.email || ''),
        case_count: p.case_count || 0, active: !!p.active,
        dest: { view: 'profile', id: p.id },
      }, 'saved profile');
    }
  }

  return json({
    q: raw,
    results: [...found.values()].slice(0, SEARCH_TOTAL_CAP),
    capped: found.size >= SEARCH_TOTAL_CAP,
  });
}

/* ================================================= UNIT 8: NEEDS ATTENTION

   THE QUESTION IS "WHAT REQUIRES ACTION NOW?", not "here are twenty numbers".
   Every alert names WHAT, WHICH CASE, WHY and WHERE TO GO, and every one of
   them is derived from state the portal already records — an intake nobody has
   accepted, a day that finished with no report, money the ledger says is
   outstanding, a date a firm actually gave us.

   NOTHING IS INFERRED FROM A WEAK ASSUMPTION. There is no "probably stale",
   no deadline derived from another deadline, and no alert whose data does not
   exist yet: a category the schema cannot answer is simply absent, the same
   rule the dashboard cards already follow. A case on hold is not neglected,
   and a paused surveillance day is a decision rather than a problem.

   THERE IS NO DISMISSAL, deliberately. An alert goes away because the thing
   was DONE — the payment recorded, the report written, the intake accepted.
   A dismiss button would be a second status system competing with the first,
   and the one that drifts is the one nobody is looking at.

   Windows, in one place so they are arguable rather than scattered: */
const ATTN = {
  LEGAL_DATE_DAYS: 14,   // a hearing, trial or deadline this close is worth saying
  QUIET_DAYS: 21,        // a working case with nothing recorded for three weeks
  LONG_DAY_HOURS: 14,    // a surveillance day this long was probably never ended
  INTAKE_STALE_DAYS: 2,  // an intake nobody has looked at
  DORMANT_INTAKE_DAYS: 14, // an undecided intake this old is "dormant" to the topic desk (Unit 10)
  PER_KIND: 6,           // rows any single rule may contribute
  TOTAL: 40,
};

/* One row per thing to do. `key` is what makes an alert identical to itself
   across reloads; nothing is stored, so it exists only for the page. */
const attnRow = (severity, kind, caseNo, what, why, action) =>
  ({ key: `${kind}:${caseNo}`, severity, kind, case_no: caseNo, what, why, action });

/* Money in an alert sentence. The two existing `money` helpers are locals
   inside other functions; this is the alert list's own, and it formats only —
   every figure it prints was computed from the ledger by the caller. */
const attnMoney = n => '$' + Number(n).toLocaleString('en-US',
  { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 });

const daysBetween = (aIso, bIso) => {
  const a = Date.parse(aIso), b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / 86400000);
};

/* PORTAL-OPS PHASE 4 — TASKS & FOLLOW-UPS, cross-case (Unit 22).

   `case_tasks` and `tasksPanel` already existed as a case tab; what was
   missing was the view that answers "what is on my desk today" without opening
   twenty cases. This is that read and nothing else — the same rows, bucketed.

   IT DELIBERATELY DOES NOT AUTO-SURFACE. Phase 4's auto-surface list is
   `/attention`'s job, shipped in Unit 8, and one item of that list is
   TRUNCATED in the brief — so re-implementing it here would both duplicate a
   working feature and invent the missing entry. The board carries the MANUAL
   follow-ups; the exception list stays where it lives, and the page links the
   two rather than merging them.

   Role-scoped in the SQL, not by filtering after: an investigator sees tasks
   assigned to them, on cases that are theirs. Hidden cases are excluded
   through the existing helper, so a deleted or archived case cannot put work
   on someone's desk. */
/* UNIT 24 — THE FILE QUEUE, one operational view over files that already
   exist. An AGGREGATION, exactly as the brief requires: no new table, no
   second copy of a file, no duplicate status vocabulary — and **no byte is
   read and no Dropbox call is made**, which is Unit 14's rule and is what
   keeps this screen cheap enough to open all day.

   THE STATES ARE THE ONES THE PORTAL ALREADY HAS. `case_evidence.classification`
   carries a CHECK with five values and they already mean what the mockup's
   queue concepts mean, so nothing is invented to imitate a picture:

     needs_review     → Awaiting review
     needs_redaction  → Awaiting processing (work before it can go out)
     client_deliverable, integrity not recorded → Awaiting verification
     client_deliverable, in a finalized package → Completed
     client_deliverable otherwise               → Ready to file
     internal_only, do_not_use                  → Held back

   "Completed" and "Awaiting verification" are the only derived ones, and both
   are derived from records that already exist — a finalized build carrying the
   file, and an integrity row for it. */
const FILE_QUEUE_CAP = 200;
const FQ_STATE = {
  needs_review: 'awaiting_review',
  needs_redaction: 'awaiting_processing',
  internal_only: 'held_back',
  do_not_use: 'held_back',
};

async function fileQueue(env, user) {
  const missing = await missingTables(env);
  const admin = user.role === 'admin';
  const hidden = await hiddenCases(env);
  const hasIntegrity = !missing.includes('evidence_integrity');
  const hasStamp = !missing.includes('photo_stamp');

  /* One bounded read for the files, scoped in the SQL for the field. */
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.case_no, e.filename, e.content_type, e.size_bytes,
            e.classification, e.uploaded_at, e.note, e.entry_id,
            e.r2_key, u.display_name AS uploaded_by,
            s.client_name, s.subject_name
       FROM case_evidence e
       JOIN submissions s ON s.case_no = e.case_no
       LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE e.deleted_at IS NULL
        AND (?1 = 1 OR s.assigned_to = ?2)
      ORDER BY e.uploaded_at DESC, e.id DESC
      LIMIT ?3`).bind(admin ? 1 : 0, user.id, FILE_QUEUE_CAP).all();

  const rows = (results || []).filter(r => !hidden.has(r.case_no));
  const ids = rows.map(r => r.id);
  const inSet = ids.length ? ids.map(() => '?').join(',') : '0';

  /* Which files have an integrity record, and which are a timestamped copy —
     two small metadata reads over the ids already fetched, never per row. */
  const integ = new Set();
  if (hasIntegrity && ids.length) {
    try {
      const { results: ir } = await env.DB.prepare(
        `SELECT artifact_id FROM evidence_integrity
          WHERE artifact_kind = 'evidence' AND artifact_id IN (${inSet})
            AND superseded_at IS NULL`).bind(...ids).all();
      for (const r of ir || []) integ.add(r.artifact_id);
    } catch { /* an absent column is not a reason to fail the screen */ }
  }
  const stamped = new Set();
  if (hasStamp && ids.length) {
    try {
      const { results: sr } = await env.DB.prepare(
        `SELECT stamped_id FROM photo_stamp
          WHERE stamped_id IN (${inSet}) AND superseded_at IS NULL`).bind(...ids).all();
      for (const r of sr || []) stamped.add(r.stamped_id);
    } catch { /* older shape: the badge is simply not shown */ }
  }
  /* Files that have gone out in a finalized package. One statement. */
  const shipped = new Set();
  if (!missing.includes('build_items') && ids.length) {
    try {
      const { results: br } = await env.DB.prepare(
        `SELECT DISTINCT bi.evidence_id FROM build_items bi
           JOIN case_builds b ON b.id = bi.build_id
          WHERE bi.evidence_id IN (${inSet}) AND b.finalized_at IS NOT NULL`).bind(...ids).all();
      for (const r of br || []) shipped.add(r.evidence_id);
    } catch { /* the state simply falls back to Ready to file */ }
  }

  const kindOf = (ct, name) => {
    const t = String(ct || '');
    if (t.startsWith('image/')) return 'photo';
    if (t.startsWith('video/')) return 'video';
    if (/\.pdf$/i.test(String(name || '')) || t === 'application/pdf') return 'report';
    return 'document';
  };

  const files = rows.map(r => {
    const cls = r.classification;
    let state = FQ_STATE[cls] || null;
    if (!state) {
      state = shipped.has(r.id) ? 'completed'
        : (hasIntegrity && !integ.has(r.id)) ? 'awaiting_verification'
        : 'ready_to_file';
    }
    return {
      id: r.id, case_no: r.case_no, filename: r.filename,
      kind: kindOf(r.content_type, r.filename),
      timestamped: stamped.has(r.id),
      size_bytes: r.size_bytes, uploaded_at: r.uploaded_at,
      uploaded_by: r.uploaded_by || null,
      classification: cls, state,
      /* Unknown is not the same as "no file has one" — Unit 11's rule. */
      integrity: hasIntegrity ? integ.has(r.id) : null,
      note: r.note || null, entry_id: r.entry_id || null,
      subject_name: r.subject_name || null,
      /* Who is PAYING is never sent to the field, here as everywhere. */
      ...(admin ? { client_name: r.client_name || null } : {}),
      /* The App Folder path is admin-only on the way out (Unit 11). */
      ...(admin ? { stored: String(r.r2_key || '').startsWith('dropbox:') ? 'Dropbox' : 'Cloudflare' } : {}),
    };
  });

  const count = st => files.filter(f => f.state === st).length;
  return json({
    files,
    summary: {
      total: files.length,
      awaiting_processing: count('awaiting_processing'),
      awaiting_review: count('awaiting_review'),
      awaiting_verification: count('awaiting_verification'),
      ready_to_file: count('ready_to_file'),
      completed: count('completed'),
      held_back: count('held_back'),
    },
    capped: rows.length >= FILE_QUEUE_CAP,
    integrity_available: hasIntegrity,
    generated_at: nowIso(),
  });
}

async function taskBoard(env, user) {
  if ((await missingTables(env)).includes('case_tasks')) {
    return json({ today: [], upcoming: [], overdue: [], completed: [], not_set_up: true });
  }
  const admin = user.role === 'admin';
  const hidden = await hiddenCases(env);
  const today = nowIso().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.case_no, t.task, t.due_date, t.priority, t.status,
            t.done_at, u.display_name AS assigned_name, t.assigned_to,
            s.client_name, s.subject_name, s.assigned_to AS case_investigator
       FROM case_tasks t
       JOIN submissions s ON s.case_no = t.case_no
       LEFT JOIN users u ON u.id = t.assigned_to
      WHERE (?1 = 1 OR (s.assigned_to = ?2 AND (t.assigned_to IS NULL OR t.assigned_to = ?2)))
      ORDER BY COALESCE(t.due_date, '9999-12-31'), t.id DESC
      LIMIT 300`).bind(admin ? 1 : 0, user.id).all();

  const rows = (results || []).filter(r => !hidden.has(r.case_no)).map(r => ({
    id: r.id, case_no: r.case_no, task: r.task, due_date: r.due_date || null,
    priority: r.priority, status: r.status, done_at: r.done_at || null,
    assigned_name: r.assigned_name || null,
    /* Who the case is FOR is the client's identity, so an investigator is not
       sent it — the FIELD_KEEP boundary, applied to this view too. */
    ...(admin ? { client_name: r.client_name || null } : {}),
    subject_name: r.subject_name || null,
  }));
  const open = rows.filter(r => r.status === 'open');
  return json({
    overdue:   open.filter(r => r.due_date && r.due_date < today),
    today:     open.filter(r => r.due_date === today),
    upcoming:  open.filter(r => !r.due_date || r.due_date > today),
    completed: rows.filter(r => r.status !== 'open').slice(0, 40),
    generated_at: nowIso(),
  });
}

/* PORTAL-OPS PHASE 14 — THE AUDIT TRAIL, composed at read time (Unit 22).

   "Who + what + when" over the changes the brief names: assignments, status,
   authorization, retainer and payments, invoices, report versions, evidence
   classification, package finalization and case closure. Every one of those
   was already being recorded somewhere — this needed no new table and writes
   nothing, the Unit 10 timeline's lesson one altitude up: the timeline answers
   "what happened on this case", this answers "what did we change, lately".

   ADMIN ONLY, by the brief's own line — "Investigators must not see admin-only
   audit information" — and enforced by refusing the route rather than by
   filtering rows out of an answer already fetched. */
const AUDIT_CAP = 40;
async function auditTrail(request, env, user) {
  if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
  const missing = await missingTables(env);
  const has = t => !missing.includes(t);
  const hidden = await hiddenCases(env);
  const out = [];
  const q = async (table, sql, map) => {
    if (!has(table)) return;
    try {
      const { results } = await env.DB.prepare(sql).bind(AUDIT_CAP).all();
      for (const r of results || []) { const e = map(r); if (e && e.at) out.push(e); }
    } catch { /* one unavailable source must not empty the whole trail */ }
  };

  await q('case_status',
    `SELECT case_no, stage, set_at AS at, u.display_name AS who
       FROM case_status LEFT JOIN users u ON u.id = set_by
      ORDER BY set_at DESC LIMIT ?`,
    r => ({ at: r.at, case_no: r.case_no, who: r.who, kind: 'status',
            what: `Status set to ${r.stage}` }));

  await q('invoice_events',
    `SELECT e.at, e.action, e.detail, i.case_no, u.display_name AS who
       FROM invoice_events e JOIN invoices i ON i.id = e.invoice_id
       LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.id DESC LIMIT ?`,
    r => ({ at: r.at, case_no: r.case_no, who: r.who, kind: 'invoice',
            what: `Invoice ${String(r.action).replace(/_/g, ' ')}` }));

  await q('build_events',
    `SELECT e.at, e.action, b.case_no, u.display_name AS who
       FROM build_events e JOIN case_builds b ON b.id = e.build_id
       LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.id DESC LIMIT ?`,
    r => ({ at: r.at, case_no: r.case_no, who: r.who, kind: 'package',
            what: `Package ${String(r.action).replace(/_/g, ' ')}` }));

  await q('retainer_payment',
    `SELECT p.recorded_at AS at, p.case_no, u.display_name AS who
       FROM retainer_payment p LEFT JOIN users u ON u.id = p.recorded_by
      ORDER BY p.id DESC LIMIT ?`,
    r => ({ at: r.at, case_no: r.case_no, who: r.who, kind: 'payment',
            what: 'Retainer payment recorded' }));

  await q('case_closure',
    `SELECT c.closed_at AS at, c.case_no, u.display_name AS who
       FROM case_closure c LEFT JOIN users u ON u.id = c.closed_by
      WHERE c.closed_at IS NOT NULL ORDER BY c.closed_at DESC LIMIT ?`,
    r => ({ at: r.at, case_no: r.case_no, who: r.who, kind: 'closure',
            what: 'Case closed' }));

  await q('retention_event',
    `SELECT e.at, e.case_no, e.action, u.display_name AS who
       FROM retention_event e LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.id DESC LIMIT ?`,
    r => ({ at: r.at, case_no: r.case_no, who: r.who, kind: 'retention',
            what: String(r.action).replace(/_/g, ' ') }));

  await q('report_versions',
    `SELECT v.submitted_at AS at, r.case_no, u.display_name AS who
       FROM report_versions v JOIN case_reports r ON r.id = v.report_id
       LEFT JOIN users u ON u.id = v.submitted_by
      ORDER BY v.id DESC LIMIT ?`,
    r => ({ at: r.at, case_no: r.case_no, who: r.who, kind: 'report',
            what: 'Report version saved' }));

  /* A deleted or archived case is out of the working set, so it is out of this
     view too — the same rule every other cross-case read follows. */
  const rows = out.filter(e => e.case_no && !hidden.has(e.case_no))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 60);
  /* Named rather than implied: a source that has not arrived yet is not the
     same as nothing having happened. */
  const absent = ['case_status', 'invoice_events', 'build_events', 'retainer_payment',
                  'case_closure', 'retention_event', 'report_versions'].filter(t => !has(t));
  return json({ entries: rows, missing_sources: absent, generated_at: nowIso() });
}

async function needsAttention(env, user) {
  /* ADMIN ONLY, like /recent-activity and the storage card it sits beside: this
     is the office's exception list across the whole book of work, and an
     investigator's own outstanding work reaches them through their own
     screens. */
  if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);

  const missing = await missingTables(env);
  /* WHAT THIS LIST COULD NOT LOOK AT, named. Every rule below is guarded on
     its tables existing — which is right, because a half-applied schema must
     not take the dashboard down — but a guard that silently drops a whole
     CATEGORY of work turns "nothing needs you" into a claim nobody checked.
     That sentence is the most reassuring one on the page and it has to be
     earned by every source answering, not by the survivors happening to be
     empty. So the sources that could not be read are collected and returned,
     and the page says its view is partial instead of looking clear. The rule
     is the client-side queue's from Unit 5; only the place it is enforced
     moved when the derivation did. */
  const blind = [];
  const have = (t, names) => {
    const ok = !missing.includes(t);
    if (!ok && names) for (const n of [].concat(names)) if (!blind.includes(n)) blind.push(n);
    return ok;
  };
  const now = nowIso();
  const today = now.slice(0, 10);
  const out = [];
  const q = async (sql, binds = []) => {
    try { return (await env.DB.prepare(sql).bind(...binds).all()).results || []; }
    catch { return []; }
  };
  /* A case that has been archived or deleted is out of the working set, so it
     is out of the list of things that need doing. One read, reused. */
  const hidden = await hiddenCases(env);
  const visible = r => !hidden.has(r.case_no);

  // ---- INTAKES: submitted, and nobody has accepted or declined them. ------
  for (const r of (await q(
    `SELECT s.case_no, s.created_at, s.client_name, s.carrier, s.kind
       FROM submissions s LEFT JOIN case_status cs ON cs.case_no = s.case_no
      WHERE s.status = 'new' AND COALESCE(cs.stage, 'open') IN ('open', 'new')
      ORDER BY s.created_at LIMIT ${ATTN.PER_KIND * 2}`)).filter(visible)) {
    const age = daysBetween(r.created_at, now);
    if (age === null) continue;
    out.push(attnRow(age >= ATTN.INTAKE_STALE_DAYS ? 'urgent' : 'attention', 'intakes',
      r.case_no, 'Intake awaiting a decision',
      `${r.client_name || r.carrier || 'A new submission'} — ${
        age === 0 ? 'arrived today' : age === 1 ? 'waiting a day' : `waiting ${age} days`}`,
      { label: 'Review intake', view: 'case', tab: 'assign' }));
    if (out.length >= ATTN.TOTAL) break;
  }

  // ---- REPORTS: a day was worked and no report exists, or one is waiting.
  if (have('case_days', 'reports owed') && have('case_reports', 'reports owed')) {
    for (const r of (await q(
      `SELECT d.case_no, d.day_date, d.id AS day_id FROM case_days d
         LEFT JOIN case_reports rp ON rp.day_id = d.id
        WHERE d.end_time IS NOT NULL AND rp.id IS NULL
        ORDER BY d.day_date LIMIT ${ATTN.PER_KIND}`)).filter(visible)) {
      out.push(attnRow('attention', 'reports', r.case_no, 'Day worked, no report',
        `The day of ${r.day_date} finished with nothing written up`,
        { label: 'Open reports', view: 'case', tab: 'reports' }));
    }
    for (const r of (await q(
      `SELECT case_no, report_date FROM case_reports
        WHERE status = 'submitted' ORDER BY report_date LIMIT ${ATTN.PER_KIND}`)).filter(visible)) {
      out.push(attnRow('attention', 'reports', r.case_no, 'Report waiting on the office',
        `Submitted for ${r.report_date} and not approved yet`,
        { label: 'Open reports', view: 'case', tab: 'reports' }));
    }
  }

  // ---- PAYMENTS. Arithmetic, never a stored flag — the invoice rule. ------
  if (have('case_retainer', 'retainers outstanding')) {
    /* A private retainer that has been agreed and not fully received. Summed
       across the payment log, so a partial instalment reads as a balance
       rather than as unpaid. */
    const paidCol = have('retainer_payment')
      ? `COALESCE((SELECT SUM(rp.amount) FROM retainer_payment rp
                    WHERE rp.case_no = cr.case_no
                      ${have('retainer_payment_void')
                        ? 'AND rp.id NOT IN (SELECT payment_id FROM retainer_payment_void)' : ''}), 0)`
      : '0';
    for (const r of (await q(
      `SELECT cr.case_no, cr.retainer_amount, cr.received, ${paidCol} AS paid
         FROM case_retainer cr JOIN submissions s ON s.case_no = cr.case_no
        WHERE cr.retainer_amount > 0 AND s.status != 'closed'
        LIMIT ${ATTN.PER_KIND * 2}`)).filter(visible)) {
      const owed = Number(r.retainer_amount) - Number(r.paid || 0);
      if (Number(r.received) && owed <= 0) continue;
      if (owed <= 0) continue;
      const partial = Number(r.paid) > 0;
      out.push(attnRow(partial ? 'attention' : 'urgent', 'payments', r.case_no,
        partial ? 'Retainer part paid' : 'Retainer outstanding',
        partial ? `${attnMoney(owed)} of ${attnMoney(r.retainer_amount)} still to come`
          : `${attnMoney(r.retainer_amount)} agreed, nothing recorded yet`,
        { label: 'Open billing', view: 'case', tab: 'billing' }));
      if (out.length >= ATTN.TOTAL) break;
    }
  }
  if (have('invoices', 'overdue invoices')) {
    /* OVERDUE IS COMPUTED AGAINST TODAY, never stored — and never on a draft
       or a void, which is the rule the invoice module already states. */
    for (const r of (await q(
      `SELECT i.case_no, i.invoice_no, i.due_date,
              COALESCE((SELECT SUM(l.amount) FROM invoice_lines l WHERE l.invoice_id = i.id), 0)
                + i.adjustments AS total,
              COALESCE((SELECT SUM(p.amount) FROM invoice_payments p WHERE p.invoice_id = i.id), 0) AS paid
         FROM invoices i
        WHERE i.status NOT IN ('draft', 'void', 'paid')
          AND i.due_date IS NOT NULL AND i.due_date < ?
        ORDER BY i.due_date LIMIT ${ATTN.PER_KIND}`, [today])).filter(visible)) {
      const owed = Number(r.total) - Number(r.paid);
      if (owed <= 0) continue;
      const late = daysBetween(r.due_date, today);
      out.push(attnRow('urgent', 'payments', r.case_no, 'Invoice overdue',
        `${r.invoice_no} — ${attnMoney(owed)} outstanding, due ${r.due_date}${
          late ? ` (${late} day${late === 1 ? '' : 's'} ago)` : ''}`,
        { label: 'Open billing', view: 'case', tab: 'invoices' }));
    }
  }

  // ---- LEGAL DATES. Only dates a firm actually gave us, never derived. ----
  if (have('legal_intake', 'legal dates')) {
    const soon = new Date(Date.parse(today + 'T00:00:00Z') + ATTN.LEGAL_DATE_DAYS * 86400000)
      .toISOString().slice(0, 10);
    for (const [col, label] of [['hearing_date', 'Hearing'], ['trial_date', 'Trial'],
      ['deadline', 'Investigation deadline']]) {
      for (const r of (await q(
        `SELECT li.case_no, li.${col} AS d, li.firm_name FROM legal_intake li
           JOIN submissions s ON s.case_no = li.case_no
          WHERE li.${col} IS NOT NULL AND li.${col} != '' AND li.${col} >= ? AND li.${col} <= ?
            AND s.status != 'closed'
          ORDER BY li.${col} LIMIT ${ATTN.PER_KIND}`, [today, soon])).filter(visible)) {
        const away = daysBetween(today, r.d);
        out.push(attnRow(away !== null && away <= 3 ? 'urgent' : 'attention', 'legal',
          r.case_no, `${label} approaching`,
          `${r.firm_name ? r.firm_name + ' — ' : ''}${r.d}${
            away === 0 ? ' (today)' : away === 1 ? ' (tomorrow)' : ` (in ${away} days)`}`,
          { label: 'Open the case', view: 'case', tab: 'legal' }));
      }
    }
    /* The retainer cheque the firm asked us to collect. It is a REQUEST, and
       it stays awaiting until the office records the money — so this says
       "still awaiting", never "unpaid". */
    for (const r of (await q(
      `SELECT li.case_no, li.firm_name FROM legal_intake li
         JOIN submissions s ON s.case_no = li.case_no
        WHERE li.payment_arrangement = 'check_pickup' AND s.status != 'closed'
        LIMIT ${ATTN.PER_KIND}`)).filter(visible)) {
      out.push(attnRow('info', 'legal', r.case_no, 'Retainer cheque awaiting pickup',
        `${r.firm_name || 'The firm'} asked us to collect it at their office`,
        { label: 'Open billing', view: 'case', tab: 'billing' }));
    }
  }

  // ---- PACKAGES: started and not finalized. -------------------------------
  if (have('case_builds', 'unfinished packages')) {
    for (const r of (await q(
      `SELECT b.case_no, b.version, b.created_at,
              (SELECT COUNT(*) FROM build_items bi WHERE bi.build_id = b.id) AS items
         FROM case_builds b WHERE b.status = 'draft'
        ORDER BY b.created_at LIMIT ${ATTN.PER_KIND}`)).filter(visible)) {
      out.push(attnRow('attention', 'packages', r.case_no, 'Client package unfinished',
        Number(r.items) ? `Version ${r.version} has ${r.items} exhibit${
          Number(r.items) === 1 ? '' : 's'} chosen and is not finalized`
          : `Version ${r.version} was started with nothing selected yet`,
        { label: 'Open the package', view: 'case', tab: 'package' }));
    }
  }

  // ---- SURVEILLANCE: a day that has almost certainly not been ended. ------
  if (have('case_days')) {
    for (const r of (await q(
      `SELECT d.case_no, d.created_at, u.display_name AS who FROM case_days d
         LEFT JOIN users u ON u.id = d.investigator_id
        WHERE d.end_time IS NULL ORDER BY d.created_at LIMIT ${ATTN.PER_KIND}`)).filter(visible)) {
      const hours = (Date.parse(now) - Date.parse(r.created_at)) / 3600000;
      if (!Number.isFinite(hours) || hours < ATTN.LONG_DAY_HOURS) continue;
      out.push(attnRow('attention', 'cases', r.case_no, 'Day still running',
        `${r.who || 'Someone'} has had a day open for ${Math.floor(hours)} hours`,
        { label: 'Open the case', view: 'case', tab: 'field' }));
    }
  }

  // ---- QUIET CASES, narrowly. A case someone is actively assigned to, with
  //      nothing recorded for three weeks, no day running, and not on hold —
  //      a paused or held case is a decision, not neglect.
  if (have('case_days') && have('activity_log')) {
    const cut = new Date(Date.parse(now) - ATTN.QUIET_DAYS * 86400000).toISOString();
    for (const r of (await q(
      `SELECT s.case_no, s.created_at,
              (SELECT MAX(a.created_at) FROM activity_log a WHERE a.case_no = s.case_no) AS last_act,
              (SELECT MAX(d.created_at) FROM case_days d WHERE d.case_no = s.case_no) AS last_day,
              (SELECT COUNT(*) FROM case_days d WHERE d.case_no = s.case_no AND d.end_time IS NULL) AS running
         FROM submissions s LEFT JOIN case_status cs ON cs.case_no = s.case_no
        WHERE s.assigned_to IS NOT NULL AND s.status IN ('assigned', 'in_progress')
          AND COALESCE(cs.stage, '') NOT IN ('on_hold', 'complete', 'closed', 'cancelled')
        LIMIT 60`)).filter(visible)) {
      if (Number(r.running)) continue;
      const last = [r.last_act, r.last_day, r.created_at].filter(Boolean).sort().pop();
      if (!last || last >= cut) continue;
      const quiet = daysBetween(last, now);
      out.push(attnRow('info', 'cases', r.case_no, 'No activity recently',
        `Nothing recorded for ${quiet} days on an assigned case`,
        { label: 'Open the case', view: 'case' }));
      if (out.length >= ATTN.TOTAL) break;
    }
  }

  // ---- AUTHORIZATION running out, against the configured threshold. ------
  if (have('case_meta', 'authorization limits') && have('case_days', 'authorization limits')) {
    const first = String(await configValue(env, 'auth_warn_thresholds', '75,90,100'))
      .split(',').map(parseFloat).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? 75;
    for (const r of (await q(
      `SELECT m.case_no, m.authorized_hours, COALESCE(SUM(d.hours), 0) AS used
         FROM case_meta m LEFT JOIN case_days d ON d.case_no = m.case_no
         JOIN submissions s ON s.case_no = m.case_no
        WHERE m.authorized_hours > 0 AND s.status != 'closed'
        GROUP BY m.case_no, m.authorized_hours LIMIT 60`)).filter(visible)) {
      const pct = (Number(r.used) / Number(r.authorized_hours)) * 100;
      if (!(pct >= first)) continue;
      out.push(attnRow(pct >= 100 ? 'urgent' : 'attention', 'cases', r.case_no,
        pct >= 100 ? 'Authorization used up' : 'Authorization running low',
        `${Math.round(pct)}% of ${r.authorized_hours} authorized hours used`,
        { label: 'Open authorization', view: 'case', tab: 'auth' }));
      if (out.length >= ATTN.TOTAL) break;
    }
  }

  /* ---- STORAGE. The Dropbox card's rule from Unit 5, applied here: it exists
     ONLY in the broken states. A card that always says "fine" stops being read,
     and this list is the one place that must stay worth reading. Local reads
     only — env plus one row, never a call to Dropbox. */
  const storage = [];
  try {
    const dbx = await dropboxState(env);
    if (!dbx.app_configured) {
      storage.push(attnRow('attention', 'storage', '', 'Dropbox is not configured',
        'New case photos and reports have nowhere to go until it is',
        { label: 'Open settings', view: 'settings' }));
    } else if (!dbx.connected) {
      storage.push(attnRow('urgent', 'storage', '', 'Dropbox is disconnected',
        'An upload will be refused until the connection is made again',
        { label: 'Open settings', view: 'settings' }));
    }
  } catch { /* a status read must not take the list down */ }
  if (have('case_evidence')) {
    try {
      const usage = await evidenceUsage(env);
      const pct = Number(usage && usage.percent_of_free);
      if (Number.isFinite(pct) && pct >= 75) {
        storage.push(attnRow(pct >= 90 ? 'urgent' : 'attention', 'storage', '',
          'Stored evidence is near the cap',
          `${Math.round(pct)}% of the free-tier allowance is in use`,
          { label: 'Open settings', view: 'settings' }));
      }
    } catch { /* likewise */ }
  }

  const SEV = { urgent: 0, attention: 1, info: 2 };
  const all = [...storage, ...out].sort((a, b) => SEV[a.severity] - SEV[b.severity]);
  const counts = { urgent: 0, attention: 0, info: 0 };
  for (const a of all) counts[a.severity]++;
  const kinds = {};
  for (const a of all) kinds[a.kind] = (kinds[a.kind] || 0) + 1;
  return json({
    alerts: all.slice(0, ATTN.TOTAL),
    counts, kinds, total: all.length,
    /* Empty when every source answered. Non-empty means this is a PARTIAL view
       and the page must not draw it as a clear desk. */
    missing_sources: blind,
    windows: { legal_days: ATTN.LEGAL_DATE_DAYS, quiet_days: ATTN.QUIET_DAYS,
      long_day_hours: ATTN.LONG_DAY_HOURS },
  });
}

/* Case numbers that have left the working set: archived or deleted. Guarded on
   each table existing, for the standing deploy-order reason. */
async function hiddenCases(env) {
  const missing = await missingTables(env);
  const out = new Set();
  for (const t of ['case_archive', 'case_deleted']) {
    if (missing.includes(t)) continue;
    const { results } = await env.DB.prepare(`SELECT case_no FROM ${t}`).all();
    for (const r of results || []) out.add(r.case_no);
  }
  return out;
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
  /* The legal door (Unit 6): fixes the path, drops the picker, retitles the
     form "Legal Investigation Assignment". Not a sheet — a door; it rides this
     table because this is where doors live. */
  legal_assignment: { label: 'Legal Investigation Assignment',
    url: 'https://alwayspreciseinvestigations.net/intake/?assignment=legal' },
  private_retainer: { label: 'Private Client Intake',
    // The private door (audit 2026-08-14): the picker without the carrier
    // path. A private client emailed this link is never offered a claim
    // assignment with a private-client price beside it.
    url: 'https://alwayspreciseinvestigations.net/intake/?assignment=private' },
};

/* The PAYMENT OPTIONS block, in both MIME parts (PAYMENTS.md §3/§6/§7).

   `pay` reaches here already filtered by the caller — enabled, private sheet
   only, and each entry with something real to pay to. This function does not
   decide WHETHER payment may appear; that decision is made once, server-side,
   from the sheet id, so there is no second place for it to go wrong.

   A method with an admin-entered URL becomes a button. A method with only a
   handle shows the handle, plainly and in full — it is NEVER turned into a
   link, because a guessed payment URL that resolves to a real stranger sends
   the retainer to the wrong person. */
function paymentBlockText(pay, retainer) {
  if (!pay.length) return '';
  return `
PAYMENT OPTIONS
A ${usd(Number(retainer) > 0 ? retainer : PERSONAL.retainer)} retainer is required to begin investigative services.
The retainer may be submitted using one of the approved methods below.
${pay.map(m => `
PAY WITH ${m.label.toUpperCase()}
${m.handle ? `  ${m.handle}\n` : ''}  ${m.url}${m.instructions ? `\n  ${m.instructions}` : ''}`).join('')}
`;
}

/* THE WHOLE CARD IS THE LINK (owner, 2026-08-15) — "make the entire payment
   button/card clickable, not just a tiny text link", and on a phone tapping it
   opens the provider. So the anchor is the outer element and everything, the
   handle included, sits inside it: a thumb landing anywhere on the card pays.
   A small inline link beside static text is the thing this replaced.

   Written with inline styles and no flexbox because it has to survive Outlook
   and Gmail, which drop most CSS. `display:block` on the anchor is what makes
   the whole rectangle tappable in every client that renders anything at all. */
function paymentBlockHtml(pay, retainer) {
  if (!pay.length) return '';
  return `<div style="margin:0 0 18px;padding:16px 18px;background:#f4f8fa;border:1px solid #dfe7ec;border-radius:10px">
    <p style="margin:0 0 6px;font-weight:800;color:#12305a;letter-spacing:.04em">PAYMENT OPTIONS</p>
    <p style="margin:0 0 14px;font-size:.92rem">A <b>${escHtml(usd(Number(retainer) > 0 ? retainer : PERSONAL.retainer))}</b> retainer is
      required to begin investigative services. The retainer may be submitted using one of the
      approved methods below.</p>
    ${pay.map(m => `<a href="${escHtml(m.url)}"
      style="display:block;margin:0 0 10px;padding:14px 16px;background:#12305a;border-radius:10px;
             text-decoration:none;color:#ffffff;font-family:'Segoe UI',Arial,sans-serif">
      <span style="display:block;font-weight:800;letter-spacing:.05em;font-size:.95rem;color:#ffffff">
        PAY WITH ${escHtml(m.label.toUpperCase())}</span>
      ${m.handle ? `<span style="display:block;margin-top:4px;font-size:1.05rem;font-weight:700;color:#dce6f2">${
        escHtml(m.handle)}</span>` : ''}
      ${m.instructions ? `<span style="display:block;margin-top:4px;font-size:.85rem;color:#b9c9dd">${
        escHtml(m.instructions)}</span>` : ''}
    </a>`).join('')}
  </div>`;
}

/* `intake` is the DOOR the caller already resolved from the send context — not
   a flag to re-derive one from. It used to take a boolean and look the door up
   by `sheet.id`, which is what sent a law firm the private form: the legal
   context shares the private sheet on purpose. One resolution, passed in. */
/* ================== BILL.COM — THE ADAPTER BOUNDARY (BILLCOM.md) ==========

   Everything Bill.com goes through here, so connecting the real account later
   is a configuration act, not a rewrite. LINK-CONFIGURATION ONLY: the adapter
   reads the admin-typed billing settings, validates the shape, and answers
   whether the option may be offered. It calls no external API, invents no
   URL, id or credential, and refuses to be "ready" without an enable word AND
   an https payment link. `sent_to_bill`, `billing_provider = 'bill'` and the
   `bill_ach` legal arrangement — the existing record-keeping — are untouched
   and independent of this. */
const BILLCOM_LINE = { label: 'Bill.com', value: 'Accepted',
  note: 'Electronic payment instructions provided with invoice.' };

function billcomConfig(settings) {
  const enabled = /^(1|on|yes|true)$/i.test(String(settings.billcom_enabled || '').trim());
  const url = String(settings.billcom_payment_url || '').trim();
  const okUrl = /^https:\/\/[^\s]+$/i.test(url);
  return {
    enabled,
    payment_url: okUrl ? url : '',
    org_id: String(settings.billcom_org_id || '').trim() || null,
    environment: String(settings.billcom_environment || '').trim() || null,
    /* NOT READY MEANS NOT OFFERED, ANYWHERE. An enable word without a valid
       https link is still not ready — a half-configuration must never put a
       dead or invented link in front of a firm or a carrier. */
    ready: enabled && okUrl,
  };
}
async function billcomState(env) { return billcomConfig(await billingSettings(env)); }

/* The one writer that puts the Bill.com line on a sheet — applied at the
   consumption points, only when the adapter answers ready, so the static
   sheet definitions stay exactly as the owner approved them. */
function withBillcomLine(sheet, ready) {
  return ready && sheet ? { ...sheet, lines: [...(sheet.lines || []), BILLCOM_LINE] } : sheet;
}

/* THE MAIL CHECK BLOCK — the ticked option's presence in the email, in both
   MIME parts. Deliberately NOT `paymentBlockText`: that block opens with the
   private retainer sentence ("A $1,500 retainer is required…"), which must
   never reach a carrier or a firm. One wording source — MAIL_CHECK_LINE — so
   the sheet's own line, this block, and the page cannot drift. No handle, no
   link, no address: the address is invoice-only, from Settings. */
const NP_PAY_LINES = { mail_check: MAIL_CHECK_LINE, bill_com: BILLCOM_LINE };
function npPayBlockText(picked) {
  const rows = (picked || []).map(id => NP_PAY_LINES[id]).filter(Boolean);
  if (!rows.length) return '';
  return `
PAYMENT
${rows.map(l => `${l.label} — ${l.note}`).join('\n')}
`;
}
function npPayBlockHtml(picked) {
  const rows = (picked || []).map(id => NP_PAY_LINES[id]).filter(Boolean);
  if (!rows.length) return '';
  return `<div style="margin:0 0 18px;padding:14px 18px;background:#f4f8fa;border:1px solid #dfe7ec;border-radius:10px">
    <p style="margin:0 0 4px;font-weight:800;color:#12305a;letter-spacing:.04em">PAYMENT</p>
    ${rows.map(l => `<p style="margin:0;font-size:.95rem"><b>${escHtml(l.label)}</b> — ${escHtml(l.note)}</p>`).join('')}
  </div>`;
}

function sheetEmail(sheet, note, intake, pay, retainer, npPicked) {
  /* Belt and braces on the boundary: even called wrongly, the carrier sheet
     cannot carry a consumer payment handle. */
  const payment = (sheetTakesPayment(sheet.id) && Array.isArray(pay)) ? pay : [];
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
${paymentBlockText(payment, retainer)}${npPayBlockText(npPicked)}${intake ? `\nReady to begin? The ${intake.label} takes a few minutes:\n${intake.url}\n` : ''}
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
  ${paymentBlockHtml(payment, retainer)}${npPayBlockHtml(npPicked)}
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

/* THE PAYMENT INSTRUCTIONS ON THEIR OWN (PAYMENTS.md second handoff §4/§6).

   "This allows payment instructions to be sent later without resending the rate
   sheet." So this is the same PAYMENT OPTIONS block the sheet carries, with a
   short covering note around it and no rate lines at all — a client who already
   has the sheet does not need a second copy of it, and sending one invites them
   to think the terms changed.

   It reuses `paymentBlockText/Html` rather than restating them. Two renderings
   of the same instructions would drift, and the one that drifts is the one
   nobody is looking at.

   `retainer` is the case's agreed figure, so a client who agreed more than the
   standard is told what THEY agreed here too — the same rule the sheet follows. */
function paymentOnlyEmail(pay, retainer, note, name) {
  const hi = name ? `${name},` : 'Hello,';
  const text =
`Always Precise Investigations, LLC — Va DCJS #11-9159

${hi}

Here are the ways you can send the retainer to begin your investigation.
${note ? `\n${note}\n` : ''}${paymentBlockText(pay, retainer)}
If you have already submitted the intake form, nothing further is needed once
the retainer arrives — we will confirm receipt and schedule the work.

Questions: (434) 907-0975
Always Precise Investigations, LLC`;

  const html =
`<div style="font-family:'Segoe UI',Arial,sans-serif;color:#1c2531;line-height:1.55;max-width:560px">
  <p style="margin:0 0 4px;font-size:.82rem;color:#5c6775;letter-spacing:.04em;text-transform:uppercase">
    Always Precise Investigations, LLC &middot; Va DCJS #11-9159</p>
  <h2 style="margin:0 0 14px;color:#12305a">Payment options</h2>
  <p style="margin:0 0 14px">${escHtml(hi)}</p>
  <p style="margin:0 0 18px">Here are the ways you can send the retainer to begin your
    investigation.</p>
  ${note ? `<p style="margin:0 0 18px;padding:12px 14px;background:#f4f8fa;border-left:3px solid #2f7d90">${escHtml(note)}</p>` : ''}
  ${paymentBlockHtml(pay, retainer)}
  <p style="margin:0 0 14px;font-size:.92rem">If you have already submitted the intake form,
    nothing further is needed once the retainer arrives &mdash; we will confirm receipt and
    schedule the work.</p>
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
/* ------------------------------------------- Dropbox as case file storage

   Owner, 2026-08-18: new case photos and generated reports go to the firm's
   own Dropbox App Folder, in per-case folders — Photos, Reports, Video. D1
   stays the structured case record; Dropbox holds bytes and nothing else.

   NOTHING WAS MIGRATED AND NOTHING WAS DELETED (owner, explicitly). Every file
   already in R2 still lives there, still serves, and still counts on the
   storage meter. This decides where the NEXT file goes.

   NEW BYTES GO TO DROPBOX OR NOWHERE (owner, asked directly). There is no R2
   fallback and no double-write: an upload that cannot reach Dropbox is refused
   and says why. The alternative was a silent divergence where half the case is
   in one place and half in the other, discoverable only later.

   THERE IS NO COMPANION TABLE, and that is deliberate. `case_evidence.r2_key`
   already means "where the bytes are", so a Dropbox row records
   `dropbox:<path>` there and the prefix is the entire discriminator. A second
   table would be a second place to look, a second place to fall out of step,
   and — because schema.sql only arrives on a manual portal-setup dispatch — a
   reason no upload could work until someone ran a workflow. One field, no
   schema change, correct the moment it deploys.

   The path is unique because the stored filename carries a short random token.
   That matters more than it looks: delete a photo and upload another of the
   same name and Dropbox sees no conflict to autorename around, so the path
   would repeat and `r2_key`'s UNIQUE constraint would reject the second one.
   The R2 scheme already guards this with a UUID in its key. The operator still
   downloads under the real name — `filename` is untouched and is what
   Content-Disposition sends. */

const DBX_FOLDERS = ['Photos', 'Reports', 'Video'];
const DBX_KEY_PREFIX = 'dropbox:';
const DBX_CONTENT = 'https://content.dropboxapi.com';

function isDropboxKey(key) { return String(key || '').startsWith(DBX_KEY_PREFIX); }
function dropboxPathFromKey(key) { return String(key || '').slice(DBX_KEY_PREFIX.length); }

/* `Dropbox-API-Arg` is an HTTP header, so it has to be ASCII. Filenames are
   sanitised long before they reach here, but escaping is a few lines and a
   header that throws is an upload nobody can explain. */
function dbxArg(obj) {
  let out = '';
  for (const ch of JSON.stringify(obj)) {
    const c = ch.charCodeAt(0);
    out += c < 127 ? ch : '\\u' + c.toString(16).padStart(4, '0');
  }
  return out;
}

/** Which case folder a file belongs in. Video is refused before it can reach
    here; that folder exists because the operator saves timestamped copies into
    it by hand. */
function dropboxFolderFor(contentType) {
  const t = String(contentType || '').toLowerCase();
  if (t.startsWith('image/')) return 'Photos';
  if (t.startsWith('video/')) return 'Video';
  return 'Reports';
}

/** A stored name that cannot collide with one already used on this case —
    including one that was deleted. The real name stays on the row. */
function dropboxStoredName(filename) {
  const token = randomHex(3);
  const dot = filename.lastIndexOf('.');
  if (dot > 0 && dot > filename.length - 9) {
    return filename.slice(0, dot) + '-' + token + filename.slice(dot);
  }
  return filename + '-' + token;
}

/** Why new evidence cannot be stored, or null when it can. One reader, so the
    upload, the status panel and the tests cannot disagree about the reason. */
async function dropboxStorageProblem(env) {
  if (!EXTERNAL_PROVIDERS.dropbox.configured(env)) return 'provider_not_configured';
  if (!(await dropboxRefreshToken(env))) return 'dropbox_not_connected';
  return null;
}

/* The three folders, made once per case. Dropbox creates parents on upload
   anyway, so this exists so Reports and Video are THERE — browsable, obvious,
   and in the same shape on every case — before anything is put in them. A
   folder that already exists comes back as a conflict inside a 200, which is
   the success case here. */
async function dropboxEnsureCaseFolders(env, token, caseNo) {
  try {
    await fetch('https://api.dropboxapi.com/2/files/create_folder_batch', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: DBX_FOLDERS.map((f) => '/' + caseNo + '/' + f),
                             autorename: false, force_async: false }),
    });
  } catch { /* the upload creates what it needs; this is shape, not safety */ }
}

/** Upload bytes. Returns Dropbox's own metadata, or null — never throws, so
    the caller decides what a failure means rather than inheriting a 500. */
async function dropboxUpload(env, token, path, body) {
  try {
    const res = await fetch(DBX_CONTENT + '/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/octet-stream',
        /* `add`, never `overwrite`: an original is no more replaceable here
           than it is in R2. autorename is the backstop if the random token
           ever does collide. */
        'Dropbox-API-Arg': dbxArg({ path, mode: 'add', autorename: true, mute: true }),
      },
      body,
    });
    if (!res.ok) return null;
    const meta = await res.json();
    return meta && meta.path_display ? meta : null;
  } catch { return null; }
}

/** The file itself, as a Response whose body can be streamed onward. Null when
    Dropbox will not give it up. */
async function dropboxDownload(env, token, path) {
  try {
    const res = await fetch(DBX_CONTENT + '/2/files/download', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Dropbox-API-Arg': dbxArg({ path }) },
    });
    return res.ok ? res : null;
  } catch { return null; }
}

/* UPLOAD SESSIONS, for the timestamped video (owner, Part 2).

   A surveillance clip is far larger than anything else this portal moves, and
   a single-request upload has to hold the whole file at once — in the browser,
   in the Worker, and in one HTTP request that fails as a whole. A session
   moves it in pieces: the Worker holds ONE chunk at a time, an interrupted
   upload resumes from its own offset instead of starting again, and abandoning
   it costs nothing because nothing exists at the destination until finish is
   called.

   That last property is what makes Cancel honest here. There is no session to
   tear down and no partial file to clean up — a session nobody finishes simply
   expires, and the case's Video folder never had anything in it. */
const DBX_CHUNK = 8 * 1024 * 1024;

/* Overridable for the same reason the storage caps are: a test that moves a
   real multi-chunk file through the real session code proves more than one
   that moves eight megabytes to prove the same thing slowly. */
function dbxChunkBytes(env) {
  const n = parseInt(env.DBX_CHUNK_BYTES || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DBX_CHUNK;
}

async function dropboxSessionStart(env, token) {
  try {
    const res = await fetch(DBX_CONTENT + '/2/files/upload_session/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token,
                 'Content-Type': 'application/octet-stream',
                 'Dropbox-API-Arg': dbxArg({ close: false }) },
      body: new Uint8Array(0),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.session_id ? j.session_id : null;
  } catch { return null; }
}

/** One chunk at `offset`. Dropbox is the authority on where the session
    actually is, so a retry of the same chunk at the same offset is safe and a
    wrong offset is refused by Dropbox rather than guessed at here. */
async function dropboxSessionAppend(env, token, sessionId, offset, body) {
  try {
    const res = await fetch(DBX_CONTENT + '/2/files/upload_session/append_v2', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token,
                 'Content-Type': 'application/octet-stream',
                 'Dropbox-API-Arg': dbxArg({
                   cursor: { session_id: sessionId, offset }, close: false }) },
      body,
    });
    return res.ok;
  } catch { return false; }
}

async function dropboxSessionFinish(env, token, sessionId, offset, path) {
  try {
    const res = await fetch(DBX_CONTENT + '/2/files/upload_session/finish', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token,
                 'Content-Type': 'application/octet-stream',
                 'Dropbox-API-Arg': dbxArg({
                   cursor: { session_id: sessionId, offset },
                   commit: { path, mode: 'add', autorename: true, mute: true } }) },
      body: new Uint8Array(0),
    });
    if (!res.ok) return null;
    const meta = await res.json();
    return meta && meta.path_display ? meta : null;
  } catch { return null; }
}

async function dropboxDelete(env, token, path) {
  try {
    const res = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    /* Already gone is the harmless direction when the caller is removing it. */
    return res.ok || res.status === 409;
  } catch { return false; }
}

function redactRow(row) {
  /* `retainer_received`, `pay_sent_at` and `pay_methods` join the list for the
     same reason `send_count` and `last_sent_at` are already on it: whether the
     client has paid, and whether the office has asked them to, is the client's
     commercial position. An investigator is never shown who is paying — see
     FIELD_KEEP and the client_* columns above. */
  const { carrier, claim_number, client_name, client_email, client_phone, lead_status,
          send_count, last_sent_at, retainer_received, pay_sent_at, pay_methods,
          /* the firm IS the paying side (Unit 6) — the LEGAL category stays,
             the identity goes */
          legal_firm, legal_attorney, legal_assignment, legal_deadline, legal_arrangement,
          ...rest } = row;
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

  /* ARCHIVED LEAVES THE ACTIVE LIST (owner, WORKFLOW-SIMPLIFICATION §2) and is
     found under its own lens. `?view=archived` asks for exactly the archived
     ones; every other view excludes them.

     GUARDED, because schema.sql is applied by a MANUAL portal-setup dispatch
     while the Worker deploys on push. Between the two, `case_archive` does not
     exist on the live database — and a join against a missing table would take
     out the case list itself, which is the single most-used view in the portal.
     The same failure mode as the `client_token` column that never reached the
     live database, and the same guard the dashboard already uses. */
  const missing = await missingTables(env);
  const haveArchive = !missing.includes('case_archive');
  const haveDeleted = !missing.includes('case_deleted');
  const view = url.searchParams.get('view') || '';
  const wantArchived = view === 'archived';
  /* Deleted is admin-only: an investigator asking for it gets their ordinary
     list, not a view of what the office has taken out of circulation. */
  const wantDeleted = view === 'deleted' && user.role === 'admin';
  /* PAYMENTS.md §10 — the Leads & Intakes card has to say "retainer pending"
     and whether payment instructions already went, so the row carries both.
     Correlated subqueries in the shape `send_count`/`last_sent_at` already use,
     and `idx_paysend_case (case_no, id DESC)` is what the ordered pick reads.

     GUARDED for the same reason the archive join is: a subquery against a table
     the live database has not been given yet takes out the case list, the
     most-used view in the portal. Both tables are old enough to be present in
     practice; the guard costs two lines and `missing` is already computed. */
  const haveRet = !missing.includes('case_retainer');
  const havePay = !missing.includes('payment_send');
  /* UNIT 6 — the lead card's legal identity: firm-led, with the assignment,
     the deadline and the arrangement beside it. Guarded like every table that
     arrives by portal-setup, and STRIPPED by redactRow below — the firm is who
     is paying, which an investigator is never shown. */
  const haveLegal = !missing.includes('legal_intake');
  const legalCols = haveLegal
    ? `(SELECT li.firm_name FROM legal_intake li WHERE li.case_no = s.case_no) AS legal_firm,
       (SELECT li.attorney_name FROM legal_intake li WHERE li.case_no = s.case_no) AS legal_attorney,
       (SELECT li.assignment_type FROM legal_intake li WHERE li.case_no = s.case_no) AS legal_assignment,
       (SELECT li.deadline FROM legal_intake li WHERE li.case_no = s.case_no) AS legal_deadline,
       (SELECT li.payment_arrangement FROM legal_intake li WHERE li.case_no = s.case_no) AS legal_arrangement`
    : `NULL AS legal_firm, NULL AS legal_attorney, NULL AS legal_assignment,
       NULL AS legal_deadline, NULL AS legal_arrangement`;
  const retCol = haveRet
    ? '(SELECT cr.received FROM case_retainer cr WHERE cr.case_no = s.case_no) AS retainer_received'
    : 'NULL AS retainer_received';
  const payCols = havePay
    ? `(SELECT ps.sent_at FROM payment_send ps WHERE ps.case_no = s.case_no AND ps.ok = 1
          ORDER BY ps.id DESC LIMIT 1) AS pay_sent_at,
       (SELECT ps.methods FROM payment_send ps WHERE ps.case_no = s.case_no AND ps.ok = 1
          ORDER BY ps.id DESC LIMIT 1) AS pay_methods`
    : 'NULL AS pay_sent_at, NULL AS pay_methods';
  const archJoin = haveArchive ? 'LEFT JOIN case_archive ar ON ar.case_no = s.case_no' : '';
  const archCol = haveArchive ? 'ar.archived_at' : 'NULL AS archived_at';
  const delJoin = haveDeleted ? 'LEFT JOIN case_deleted del ON del.case_no = s.case_no' : '';
  const delCol = haveDeleted ? 'del.deleted_at' : 'NULL AS deleted_at';
  const joins = `${archJoin} ${delJoin}`;

  const conds = [];
  const where = [];
  // An investigator sees only what is assigned to them. This is enforced here,
  // in the query, rather than by the page hiding rows.
  if (user.role !== 'admin') { conds.push('s.assigned_to = ?'); where.push(user.id); }
  /* A DELETED CASE LEAVES EVERY ORDINARY VIEW, Archived included — that is what
     makes it a delete rather than a second archive. It comes back only under
     its own lens, where an admin can restore it. */
  if (haveDeleted) conds.push(wantDeleted ? 'del.case_no IS NOT NULL' : 'del.case_no IS NULL');
  if (haveArchive && !wantDeleted) {
    conds.push(wantArchived ? 'ar.case_no IS NOT NULL' : 'ar.case_no IS NULL');
  }
  const scope = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const binds = [...where, limit, offset];

  const { results } = await env.DB.prepare(
    `SELECT s.case_no, s.kind, s.service, s.status, s.client_name, s.client_email, s.subject_name,
            /* UNIT 6 — a CATEGORY fact like kind, never a firm detail: the badge
               may say LEGAL to both roles, the firm's identity may not. */
            CASE WHEN json_valid(s.payload)
                  AND json_extract(s.payload, '$.assignment') = 'legal'
                 THEN 1 ELSE 0 END AS legal,
            (SELECT COUNT(*) FROM send_log sl WHERE sl.case_no = s.case_no AND sl.ok = 1) AS send_count,
            (SELECT MAX(sent_at) FROM send_log sl WHERE sl.case_no = s.case_no AND sl.ok = 1) AS last_sent_at,
            s.carrier, s.claim_number, s.created_at, s.assigned_to, u.display_name AS assigned_name,
            cs.stage, ls.status AS lead_status, ${retCol}, ${payCols}, ${legalCols}, ${archCol}, ${delCol}
       FROM submissions s LEFT JOIN users u ON u.id = s.assigned_to
       LEFT JOIN case_status cs ON cs.case_no = s.case_no
       LEFT JOIN lead_status ls ON ls.case_no = s.case_no
       ${joins}
       ${scope}
      ORDER BY s.created_at DESC LIMIT ? OFFSET ?`).bind(...binds).all();

  /* The total has to count the SAME set the rows came from, or the list says
     "12 of 40" while showing the 12 that are not archived. */
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM submissions s ${joins} ${scope}`)
    .bind(...where).first();

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

/* What payment instructions actually went, and to whom (PAYMENTS.md §13).
   The confirmation and the case history both read back from THIS, never from
   the form that was submitted — otherwise they report what was asked for
   rather than what was sent, which is the same class of mistake as marking a
   retainer paid because instructions were emailed. Failures are kept and
   marked for the same reason send_log keeps them. */
async function logPaymentSend(env, user, row) {
  try {
    await env.DB.prepare(
      `INSERT INTO payment_send (case_no, recipient, methods, with_sheet, ok, detail, sent_by, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(row.case_no || null, row.recipient, (row.methods || []).join(','),
            row.with_sheet ? 1 : 0, row.ok ? 1 : 0, row.detail || null,
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
  /* This is the one writer of 'converted', wherever the button lives — so the
     acceptance-time fee snapshot cannot be forgotten by a new door (D14). */
  if (status === 'converted') await snapshotFixedFee(env, caseNo, user ? user.id : null);
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

/* The archive marker for a case, or null when it is not archived.

   Guarded for the same deploy-order reason as the case list: the Worker ships
   on push, `case_archive` arrives on a manual portal-setup dispatch, and a
   workspace that threw in between would take the whole case screen down. */
async function archiveOf(env, caseNo) {
  if ((await missingTables(env)).includes('case_archive')) return null;
  const row = await env.DB.prepare(
    `SELECT a.archived_at, u.display_name AS archived_by
       FROM case_archive a LEFT JOIN users u ON u.id = a.archived_by
      WHERE a.case_no = ?`).bind(caseNo).first();
  return row ? { archived_at: row.archived_at, archived_by: row.archived_by || '' } : null;
}

/* One sentence for every refusal on a deleted case, so the office reads the
   same thing wherever it hits — and one that names the way out rather than
   just saying no. */
const DELETED_CASE = caseNo =>
  `${caseNo} has been deleted, so nothing can be recorded or sent against it. `
  + 'Put the case back first — nothing was destroyed.';

/* ARCHIVED GATES WRITES TOO, and the reason is the hole it closes rather than
   tidiness (Codex stop-time review, 2026-08-16 — "hidden rows can suppress live
   work").

   Archiving takes a case out of the working views. If work could still be
   recorded against it, that work would be invisible: an investigator out in the
   field on an archived case would not appear on Out now, and reports falling due
   on it would not reach the alerts. Hiding a case and letting it stay workable
   are the two halves of a silent failure.

   So the two go together — out of the views, out of the work — and the way back
   is one button. "Archived" means finished, and finishing something you are
   still doing is the contradiction, not the refusal. */
const ARCHIVED_CASE = caseNo =>
  `${caseNo} is archived, so nothing can be recorded against it. `
  + 'Restore the case first — it comes back exactly as it was.';

/* ------------------------------------------------------ case phone numbers */

const PHONE_LABELS = ['mobile', 'work', 'home', 'other'];

/* A number as the office typed it, minus anything that could smuggle a line
   break into an email header. Shape-checked only: numbering plans differ by
   country and the office knows its own numbers. */
function cleanPhone(v) {
  return String(v == null ? '' : v)
    .replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 32);
}
function phoneShapeOk(v) {
  const digits = v.replace(/[^\d]/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

/* THE LIST, READ THROUGH THE LEGACY COLUMN.

   With no rows in `case_phone`, the single number that has always been on the
   case IS the list — so a case nobody has edited reads exactly as it did before
   this table existed, and nothing had to be backfilled. Once the office saves a
   list, these rows are the answer and the legacy column is kept as a mirror of
   the first one (see saveCasePhones).

   Guarded on the table existing for the standing deploy-order reason: the
   Worker ships on push, schema.sql arrives on a manual portal-setup dispatch,
   and the case screen must not go down in between. */
async function phonesFor(env, caseNo, { forAdmin = true } = {}) {
  const out = { client: [], subject: {} };

  /* THE CLIENT'S NUMBERS ARE THE CLIENT'S IDENTITY, so an investigator never
     receives them — the same boundary `redactRow` draws around `client_phone`.
     The SUBJECT's numbers are fieldwork and reach both roles, because the
     subject is who is watched, never who is paying. */
  const legacy = forAdmin
    ? await env.DB.prepare('SELECT client_phone FROM submissions WHERE case_no = ?')
        .bind(caseNo).first()
    : null;
  const legacyClient = (legacy && legacy.client_phone) || '';
  const { results: subjects } = await env.DB.prepare(
    'SELECT id, phone FROM case_subjects WHERE case_no = ?').bind(caseNo).all();

  const have = !(await missingTables(env)).includes('case_phone');
  let rows = [];
  if (have) {
    const r = await env.DB.prepare(
      `SELECT id, owner_kind, subject_id, label, number FROM case_phone
        WHERE case_no = ? ORDER BY owner_kind, position, id`).bind(caseNo).all();
    rows = r.results || [];
  }
  for (const p of rows) {
    const entry = { id: p.id, label: p.label || '', number: p.number };
    if (p.owner_kind === 'client') { if (forAdmin) out.client.push(entry); }
    else {
      const k = String(p.subject_id);
      (out.subject[k] = out.subject[k] || []).push(entry);
    }
  }
  // Read-through: only where the office has not saved a list of its own.
  if (!out.client.length && legacyClient) {
    out.client = [{ id: null, label: '', number: legacyClient, legacy: true }];
  }
  for (const s of subjects) {
    const k = String(s.id);
    if (!(out.subject[k] || []).length && s.phone) {
      out.subject[k] = [{ id: null, label: '', number: s.phone, legacy: true }];
    }
  }
  return out;
}

/* Replace one owner's list. Rows are rewritten wholesale because the office
   edits the list as a list — there is no per-number identity worth preserving
   across a save, and a diff would only be a way to get it wrong.

   THE LEGACY COLUMN IS MIRRORED, NOT ABANDONED: the first number goes back into
   `submissions.client_phone` (or `case_subjects.phone`), so redaction, the
   alert path, the package and every other existing reader keep seeing a primary
   number without knowing this table exists. Saving an empty list clears the
   mirror too — that is the office saying there is no number, not a bug. */
async function saveCasePhones(env, caseNo, ownerKind, subjectId, list) {
  if ((await missingTables(env)).includes('case_phone')) return { skipped: 'not_set_up' };
  const now = nowIso();
  const del = ownerKind === 'client'
    ? env.DB.prepare(`DELETE FROM case_phone WHERE case_no = ? AND owner_kind = 'client'`).bind(caseNo)
    : env.DB.prepare(`DELETE FROM case_phone WHERE case_no = ? AND owner_kind = 'subject' AND subject_id = ?`)
        .bind(caseNo, subjectId);
  await del.run();
  let i = 0;
  for (const p of list) {
    await env.DB.prepare(
      `INSERT INTO case_phone (case_no, owner_kind, subject_id, label, number, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(caseNo, ownerKind, ownerKind === 'subject' ? subjectId : null,
            p.label || null, p.number, i++, now, now).run();
  }
  const primary = list.length ? list[0].number : null;
  if (ownerKind === 'client') {
    await env.DB.prepare('UPDATE submissions SET client_phone = ? WHERE case_no = ?')
      .bind(primary, caseNo).run();
  } else {
    await env.DB.prepare('UPDATE case_subjects SET phone = ? WHERE id = ? AND case_no = ?')
      .bind(primary, subjectId, caseNo).run();
  }
  return { saved: list.length };
}

/* Correct the case's own identity. Admin-only; the route checks that.

   AN ABSENT FIELD MEANS UNCHANGED — the rule the retainer routes learned the
   hard way. Posting a phone list must not blank the email beside it, and
   posting an email must not wipe the phones.

   The denormalised columns and the intake payload are written TOGETHER, because
   both are read: `redactRow` and the case list read the columns, the case screen
   and the package read the payload. Letting them drift is how a case shows one
   client name on the list and another on the screen. */
async function editCase(request, env, user, caseNo) {
  const row = await env.DB.prepare(
    'SELECT case_no, kind, client_name, client_email, client_phone, subject_name, carrier, claim_number, payload '
    + 'FROM submissions WHERE case_no = ?').bind(caseNo).first();
  if (!row) return json({ error: 'not found' }, 404);

  const body = await readJson(request);
  const has = k => Object.prototype.hasOwnProperty.call(body, k);
  const clean = (v, max) => String(v == null ? '' : v)
    .replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);

  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch { payload = {}; }

  const next = {
    client_name:  has('client_name')  ? clean(body.client_name, 120)  : row.client_name,
    client_email: has('client_email') ? clean(body.client_email, 200) : row.client_email,
    subject_name: has('subject_name') ? clean(body.subject_name, 120) : row.subject_name,
    claim_number: has('claim_number') ? clean(body.claim_number, 64)  : row.claim_number,
  };
  if (next.client_email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(next.client_email)) {
    return json({ error: 'Enter a valid email address, or leave it blank.' }, 400);
  }

  /* The address lives in the intake payload, which is where the case screen and
     the package already read it from. */
  const address = has('subject_address') ? clean(body.subject_address, 200) : null;

  /* PHONE LISTS, validated before anything is written so a bad number cannot
     leave the case half-saved. */
  const lists = [];
  if (has('client_phones')) {
    const given = Array.isArray(body.client_phones) ? body.client_phones : [];
    const out = [];
    for (const p of given.slice(0, 10)) {
      const number = cleanPhone(p && p.number);
      if (!number) continue;
      if (!phoneShapeOk(number)) {
        return json({ error: `"${number}" does not look like a phone number — 7 to 15 digits.` }, 400);
      }
      const label = clean(p && p.label, 16).toLowerCase();
      if (label && !PHONE_LABELS.includes(label)) {
        return json({ error: `"${label}" is not a phone label. Use ${PHONE_LABELS.join(', ')}.` }, 400);
      }
      out.push({ number, label });
    }
    lists.push({ ownerKind: 'client', subjectId: null, list: out });
  }
  if (has('subject_phones') && body.subject_phones && typeof body.subject_phones === 'object') {
    for (const [sid, given] of Object.entries(body.subject_phones).slice(0, 20)) {
      if (!/^\d{1,12}$/.test(String(sid))) continue;
      const owns = await env.DB.prepare(
        'SELECT id FROM case_subjects WHERE id = ? AND case_no = ?').bind(sid, caseNo).first();
      if (!owns) return json({ error: 'That subject is not on this case.' }, 400);
      const out = [];
      for (const p of (Array.isArray(given) ? given : []).slice(0, 10)) {
        const number = cleanPhone(p && p.number);
        if (!number) continue;
        if (!phoneShapeOk(number)) {
          return json({ error: `"${number}" does not look like a phone number — 7 to 15 digits.` }, 400);
        }
        const label = clean(p && p.label, 16).toLowerCase();
        if (label && !PHONE_LABELS.includes(label)) {
          return json({ error: `"${label}" is not a phone label. Use ${PHONE_LABELS.join(', ')}.` }, 400);
        }
        out.push({ number, label });
      }
      lists.push({ ownerKind: 'subject', subjectId: parseInt(sid, 10), list: out });
    }
  }

  if (has('client_name'))  payload.client_name  = next.client_name;
  if (has('client_email')) payload.client_email = next.client_email;
  if (has('subject_name')) payload.subject_name = next.subject_name;
  if (has('claim_number')) payload.claim_number = next.claim_number;
  if (address !== null)    payload.subject_address = address;

  await env.DB.prepare(
    `UPDATE submissions SET client_name = ?, client_email = ?, subject_name = ?,
            claim_number = ?, payload = ? WHERE case_no = ?`)
    .bind(next.client_name || null, next.client_email || null, next.subject_name || null,
          next.claim_number || null, JSON.stringify(payload), caseNo).run();

  // Phones last, because saving one mirrors its first number back into the row
  // just written — the mirror must not be overwritten by the update above.
  for (const l of lists) await saveCasePhones(env, caseNo, l.ownerKind, l.subjectId, l.list);

  const after = await env.DB.prepare(
    'SELECT client_name, client_email, client_phone, subject_name, claim_number FROM submissions WHERE case_no = ?')
    .bind(caseNo).first();
  return json({ ok: true, case_no: caseNo, submission: after,
                phones: await phonesFor(env, caseNo) });
}

/* ------------------------------------------------------- admin alerts */

/* The five things the office asked to be told about. The ids are the column
   suffixes in `notify_recipient`, so the list and the table cannot drift. */
const ALERT_EVENTS = [
  ['intakes',  'New intake received'],
  ['payments', 'Payment recorded'],
  ['reports',  'Report ready for review'],
  ['packages', 'Client package finalized'],
  ['tasks',    'Important task due'],
];
const ALERT_IDS = ALERT_EVENTS.map(([id]) => id);
/* An obviously fictional case number for the on-screen previews. Not a real
   case, so a preview can never disclose one. */
const ALERT_PREVIEW_CASE = 'API-EXAMPLE-0001';

/* PRIVACY-SAFE ALERT TEXT, and this is the whole point of writing it here
   rather than at each call site.

   An alert leaves the building. Email goes through Resend; any SMS will go
   through a carrier and a provider. So an alert says WHAT HAPPENED and WHERE TO
   LOOK, and carries nothing that identifies a person or a matter:

     no claimant, client, subject or adjuster name
     no address, vehicle, injury or objective
     no claim number, policy number or carrier
     no phone number or email address
     no amount — what was paid is commercial, and "a payment was recorded" is
       all an alert needs to say to make someone open the portal

   SMS CARRIES NO CASE NUMBER AT ALL (owner, 2026-08-16). Email keeps it: it
   goes to the firm's own inbox through one provider the firm chose. A text
   crosses a carrier network, sits unlocked on a lock screen, and is backed up
   by whatever the handset does — so it says only what happened and to open the
   portal. Not "less detail on SMS" as a matter of taste: the case number is the
   thread that ties a notification to a file, and it is not going over that
   channel.

   The `sms` branch does not read `caseNo` at all, which is stronger than
   filtering it: there is no path by which case data can reach a text, and the
   tests assert the wording is identical whatever case number is passed.

   The detail lives behind the sign-in, which is exactly where it already lives. */
const ALERT_CHANNELS = ['sms', 'email'];
/* WHICH BUSINESS THIS IS (Unit 20). The owner asked that an alert say Private,
   Insurance or Legal, and INTAKE-OPS.md §1 asked for it before that. It is a
   CATEGORY FACT, read from `submissions.kind` — a typed column with a CHECK —
   plus the legal marker `isLegalSub` already owns. Reading it is not inference;
   nothing is guessed from a name or an address, the rule the send context
   fought for. Absent or unresolvable, the alert simply does not say. */
const ALERT_CATEGORY = { claims: 'Insurance', consumer: 'Private' };
async function alertCategory(env, caseNo) {
  const clean = /^[A-Za-z0-9-]{3,64}$/.test(String(caseNo || '')) ? String(caseNo) : '';
  if (!clean) return null;
  try {
    const sub = await env.DB.prepare('SELECT kind, payload FROM submissions WHERE case_no = ?')
      .bind(clean).first();
    if (!sub) return null;
    if (isLegalSub(sub)) return 'Legal';
    return ALERT_CATEGORY[sub.kind] || null;
  } catch { return null; }
}

function alertText(event, caseNo, channel, category) {
  const found = ALERT_EVENTS.find(([id]) => id === event);
  if (!found) return null;
  if (channel === 'sms') {
    /* Deliberately reads NEITHER caseNo NOR category. A text crosses a carrier
       network and sits on a lock screen, so nothing about the case reaches this
       string — not the reference, not which business it is. There is no path by
       which case data can get here, which is stronger than filtering it out. */
    return `${found[1]}. Open the portal.`;
  }
  const clean = /^[A-Za-z0-9-]{3,64}$/.test(String(caseNo || '')) ? String(caseNo) : '';
  const cat = ['Private', 'Insurance', 'Legal'].includes(category) ? category : '';
  return `${found[1]}${cat ? ` — ${cat}` : ''}${clean ? `${cat ? ',' : ' —'} case ${clean}` : ''}`
    + `. Sign in to the portal for the detail.`;
}

/* SEND AN ALERT TO WHOEVER ASKED FOR THAT ONE.

   NEVER THROWS, and every caller awaits it AFTER its own write has committed.
   An alert is a courtesy about something that already happened; a provider
   outage must not fail an intake, a payment or a report. The same rule
   `logSend` follows, for the same reason.

   Only recipients that are (a) switched on, (b) subscribed to THIS event and
   (c) have an email address are written to. A recipient with only a phone
   number is deliberately skipped: SMS has no provider, and quietly emailing
   someone who asked for texts would be inventing a channel they did not choose.

   `event` is checked against ALERT_IDS before it reaches the column name, so
   the interpolation below cannot be anything but one of five known columns.

   The body is `alertText(..., 'email')` and nothing else — no claimant, client,
   subject, address, claim number or amount, ever. One writer for the wording,
   so what is sent is what the Settings page previewed. */
async function notifyAdmins(env, event, caseNo) {
  try {
    if (!ALERT_IDS.includes(event)) return { sent: 0, reason: 'unknown_event' };
    /* NEVER FOR A TEST CASE (INTAKE-OPS.md §1, which puts it in terms: "a test
       intake producing a real email or SMS is the failure this feature is most
       likely to have, so it is what the tests must prove cannot happen").

       ONE GUARD AT THE ONE CHOKEPOINT, not a check at each of the six callers —
       a per-caller list is one somebody adds to and forgets, and the seventh
       alert would arrive silently wrong. `POST /demo-case` happening not to
       call this was never the protection: the moment someone WORKS a test case
       — logs a high task, submits a report, finalizes a package, records a
       payment — every one of those alerts fires for real.

       Matched case-INSENSITIVELY, which is deliberate and is the same reach
       SQLite's LIKE gives `DEMO_LIKE`. That makes the two halves agree: nothing
       `/demo-case/clear` would sweep away can have emailed the office first.
       The prefix is written here rather than shared from DEMO_LIKE for the
       reason the sweep writes it into every statement — it is the whole safety
       mechanism, and it runs beside live work. */
    if (/^TEST-/i.test(String(caseNo || ''))) return { sent: 0, reason: 'test_case' };
    if (!env.RESEND_API_KEY) return { sent: 0, reason: 'not_configured' };
    if ((await missingTables(env)).includes('notify_recipient')) {
      return { sent: 0, reason: 'not_set_up' };
    }
    const { results } = await env.DB.prepare(
      `SELECT email FROM notify_recipient
        WHERE enabled = 1 AND alert_${event} = 1
          AND email IS NOT NULL AND TRIM(email) != ''`).all();
    const to = (results || []).map(r => String(r.email).trim()).filter(Boolean);
    if (!to.length) return { sent: 0, reason: 'no_recipients' };
    /* THE PUBLIC INGEST REACHES THIS SENDER WITH NO SESSION AT ALL (closeout
       audit, 2026-09-03): every admin sender goes through the outbound-mail
       cap and this one did not, so an unauthenticated flood of intakes could
       send unbounded email out of the firm's verified domain. Same cap, same
       bucket; a capped alert is recorded like any other failure, so the
       Settings card says it happened rather than nothing. */
    if (!(await withinRateLimit(env, 'mail'))) {
      await recordAlertFailure(env, event, caseNo, 'rate_limited', to.length);
      return { sent: 0, reason: 'rate_limited' };
    }

    const label = (ALERT_EVENTS.find(([id]) => id === event) || [])[1] || 'Portal alert';
    const clean = /^[A-Za-z0-9-]{3,64}$/.test(String(caseNo || '')) ? String(caseNo) : '';
    /* Resolved HERE, at the one chokepoint, rather than passed by each caller —
       the same reason the TEST- guard lives here. A seventh alert added later
       says which business it is without anyone remembering to thread it. */
    const category = await alertCategory(env, clean);
    const text = alertText(event, clean, 'email', category);
    const subject = `${label}${category ? ` — ${category}` : ''}${clean ? `${category ? ',' : ' —'} case ${clean}` : ''}`;
    const html = `<p style="font:15px/1.5 system-ui,sans-serif">${escHtml(text)}</p>`;

    let sent = 0;
    for (const addr of to) {
      const r = await sendMail(env, { to: addr, subject, text, html });
      if (r.sent) sent++;
    }
    /* REACHING NOBODY IS A FAILURE, AND IT IS NO LONGER SILENT. */
    if (!sent) await recordAlertFailure(env, event, clean, 'send_failed', to.length);
    return { sent, of: to.length };
  } catch {
    /* The event is the point; telling someone about it is not worth failing it. */
    await recordAlertFailure(env, event, caseNo, 'error', 0);
    return { sent: 0, reason: 'error' };
  }
}

/* The minimum that makes a failed alert visible, and nothing more — no queue,
   no retry, no redelivery (the owner deferred the status log by name). Written
   best-effort: a failed record can never change what the caller was told, and
   never turns a recorded intake or payment into an error. */
async function recordAlertFailure(env, event, caseNo, reason, ofCount) {
  try {
    if ((await missingTables(env)).includes('alert_failure')) return;
    const clean = /^[A-Za-z0-9-]{3,64}$/.test(String(caseNo || '')) ? String(caseNo) : null;
    /* A TEST- case never alerts, so it never fails to alert either — keeping
       fixtures out of the office's failure list the same way. */
    if (clean && /^TEST-/i.test(clean)) return;
    await env.DB.prepare(
      `INSERT INTO alert_failure (event, case_no, reason, of_count, at) VALUES (?, ?, ?, ?, ?)`)
      .bind(event, clean, reason, Number(ofCount) || 0, nowIso()).run();
  } catch { /* never breaks the thing it describes */ }
}

/* WHAT CAN ACTUALLY BE DELIVERED TODAY, said plainly so the office is never
   left believing an alert went out.

   Email has a provider: the same Resend key the invitations use. SMS has none —
   there is no provider configured anywhere in this Worker and no credential for
   one, so text delivery is BLOCKED ON A PROVIDER. Recipients, switches and
   choices are all stored and honoured; the sending half of SMS is the piece
   that does not exist yet.

   Read from `env`, never from a literal. Adding a provider is adding its
   credential to the environment and a sender beside `sendMail` — not editing
   this to say yes. */
/* Create or update one recipient. Shared by both routes so the validation
   cannot be right on one and wrong on the other.

   AN ABSENT FIELD MEANS UNCHANGED on an update — the same rule the retainer
   routes learned the hard way. Posting only a toggle must not blank the phone
   number beside it. */
async function saveRecipient(request, env, user, id) {
  const body = await readJson(request);
  const clean = (v, max) => String(v == null ? '' : v)
    .replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);

  const existing = id
    ? await env.DB.prepare('SELECT * FROM notify_recipient WHERE id = ?').bind(id).first()
    : null;
  if (id && !existing) return json({ error: 'not found' }, 404);

  const has = k => Object.prototype.hasOwnProperty.call(body, k);
  const label = has('label') || !existing ? clean(body.label, 80) : existing.label;
  if (!label) return json({ error: 'Give this recipient a name, so the list says who it is.' }, 400);

  const email = has('email') || !existing ? clean(body.email, 200) : (existing.email || '');
  if (email && (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email) || email.length > 200)) {
    return json({ error: 'Enter a valid email address, or leave it blank.' }, 400);
  }

  /* Kept as the admin typed it, minus separators, and only checked for SHAPE.
     Numbering plans differ by country and a Worker is the wrong place to be
     opinionated about them — the office knows its own numbers. No literal
     number appears anywhere in this file. */
  const phoneRaw = has('phone') || !existing ? clean(body.phone, 32) : (existing.phone || '');
  const digits = phoneRaw.replace(/[^\d]/g, '');
  if (phoneRaw && (digits.length < 7 || digits.length > 15)) {
    return json({ error: 'Enter a phone number with 7 to 15 digits, or leave it blank.' }, 400);
  }
  if (!email && !phoneRaw) {
    return json({ error: 'A recipient needs an email address or a phone number — '
                       + 'one with neither could never be told anything.' }, 400);
  }

  const bool = (k, dflt) => has(k) ? (body[k] ? 1 : 0) : dflt;
  const enabled = bool('enabled', existing ? Number(existing.enabled) : 1);
  const alerts = Object.fromEntries(ALERT_IDS.map(k => {
    const given = body.alerts && Object.prototype.hasOwnProperty.call(body.alerts, k);
    return [k, given ? (body.alerts[k] ? 1 : 0) : (existing ? Number(existing['alert_' + k]) : 0)];
  }));

  const now = nowIso();
  if (existing) {
    await env.DB.prepare(
      `UPDATE notify_recipient SET label = ?, email = ?, phone = ?, enabled = ?,
              alert_intakes = ?, alert_payments = ?, alert_reports = ?,
              alert_packages = ?, alert_tasks = ?, updated_at = ?
        WHERE id = ?`)
      .bind(label, email || null, phoneRaw || null, enabled, alerts.intakes, alerts.payments,
            alerts.reports, alerts.packages, alerts.tasks, now, id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO notify_recipient (label, email, phone, enabled, alert_intakes,
         alert_payments, alert_reports, alert_packages, alert_tasks,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(label, email || null, phoneRaw || null, enabled, alerts.intakes, alerts.payments,
            alerts.reports, alerts.packages, alerts.tasks, user.id, now, now).run();
  }

  const row = await env.DB.prepare(
    `SELECT id, label, email, phone, enabled, alert_intakes, alert_payments,
            alert_reports, alert_packages, alert_tasks, created_at, updated_at
       FROM notify_recipient ORDER BY id DESC LIMIT 1`).first();
  const saved = existing
    ? await env.DB.prepare(
        `SELECT id, label, email, phone, enabled, alert_intakes, alert_payments,
                alert_reports, alert_packages, alert_tasks, created_at, updated_at
           FROM notify_recipient WHERE id = ?`).bind(id).first()
    : row;
  return json({ ok: true, delivery: alertDelivery(env), recipient: {
    id: saved.id, label: saved.label, email: saved.email || '', phone: saved.phone || '',
    enabled: Number(saved.enabled) === 1,
    alerts: Object.fromEntries(ALERT_IDS.map(k => [k, Number(saved['alert_' + k]) === 1])),
    created_at: saved.created_at, updated_at: saved.updated_at,
  } }, existing ? 200 : 201);
}

/* WHAT THE OFFICE CAN SEE ABOUT ALERTS THAT DID NOT ARRIVE. Admin-only, like
   everything on this screen. Bounded, newest first, and it carries no client
   detail — the event, the case reference, why, and when. A silent failure is
   the same as no alerting at all, only more expensive (INTAKE-OPS.md §1). */
async function alertFailures(env) {
  try {
    if ((await missingTables(env)).includes('alert_failure')) return { not_set_up: true, recent: [], count: 0 };
    const { results } = await env.DB.prepare(
      'SELECT event, case_no, reason, of_count, at FROM alert_failure ORDER BY id DESC LIMIT 20').all();
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM alert_failure').first();
    return { not_set_up: false, recent: results || [], count: Number((n || {}).n) || 0 };
  } catch { return { not_set_up: false, recent: [], count: 0, unavailable: true }; }
}

function alertDelivery(env) {
  return {
    email: env.RESEND_API_KEY ? 'configured' : 'blocked_on_provider',
    sms: 'blocked_on_provider',
    sms_note: 'No SMS provider is configured for this Worker, so text alerts are '
            + 'saved but not sent. Numbers and choices are kept and will be used '
            + 'once a provider is added.',
  };
}

/* THE SEND ROUTES NAME THEIR CASE IN THE BODY, where the router's gate cannot
   see it, so they have to ask for themselves.

   ONE function rather than two copies, because the first version of this was
   two copies and they drifted immediately: both learned the deleted rule and
   neither learned the archived one, so an archived case went on emailing
   clients and writing `send_log` rows long after every path-addressed write was
   refused (Codex stop-time review, 2026-08-16). A third send route must not be
   able to pick up half the rule.

   Called ONLY once the reference has resolved to a real case. An unresolvable
   one still sends — that is the pre-case rule, and it is not weakened here. */
async function caseSendRefusal(env, caseNo) {
  const gone = await deletedOf(env, caseNo);
  if (gone) return json({ error: DELETED_CASE(caseNo), case_deleted: true }, 409);
  const filed = await archiveOf(env, caseNo);
  if (filed) return json({ error: ARCHIVED_CASE(caseNo), case_archived: true }, 409);
  return null;
}

/* A DAY THAT IS STILL RUNNING CANNOT BE FILED AWAY. Archiving or deleting a
   case whose clock is open would strand that day: the case leaves the views, so
   nobody sees it running, and the gate then refuses the very request that would
   end it. The investigator is left with a clock they cannot stop and an office
   that cannot see them. Refused here instead, naming the day. */
async function openDayBlocking(env, caseNo) {
  if ((await missingTables(env)).includes('case_days')) return null;
  return env.DB.prepare(
    `SELECT d.id, d.day_date, u.display_name AS investigator
       FROM case_days d LEFT JOIN users u ON u.id = d.investigator_id
      WHERE d.case_no = ? AND d.end_time IS NULL ORDER BY d.id DESC LIMIT 1`)
    .bind(caseNo).first();
}

/* The delete tombstone, or null. Guarded like `archiveOf`, and for the same
   deploy-order reason. */
async function deletedOf(env, caseNo) {
  if ((await missingTables(env)).includes('case_deleted')) return null;
  const row = await env.DB.prepare(
    `SELECT d.deleted_at, d.reason, u.display_name AS deleted_by
       FROM case_deleted d LEFT JOIN users u ON u.id = d.deleted_by
      WHERE d.case_no = ?`).bind(caseNo).first();
  return row
    ? { deleted_at: row.deleted_at, deleted_by: row.deleted_by || '', reason: row.reason || '' }
    : null;
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

/* --------------------------------------------- retention controls (Unit 17)

   The owner's seven decisions are verbatim in case-portal/RETENTION.md. The
   five states are DERIVED, never stored as one value: Active is the absence
   of markers, Archived and Deleted are the tables that already exist, and
   these routes add only the retain-until fact, the scheduled-for-deletion
   INTENT, the hold, and the prior/new/actor/reason audit trail.

   THE HOLD IS ENFORCED AT THE WRITERS. /cases/:no/delete, the scheduling
   route and deleteEvidence each refuse 409 naming the hold — a page hiding a
   button is not enforcement. Archive, restore, undelete, billing, reports
   and every read are untouched, exactly as decision 5 draws the line. */

const RETENTION_NOT_SET_UP = 'The retention tables are not on this database yet. '
  + 'Run the portal-setup workflow once and try again.';

async function retentionMissing(env) {
  const m = await missingTables(env);
  return ['case_retention', 'legal_hold', 'retention_event'].filter(t => m.includes(t));
}

/** The active hold on a case, or null — the one question the write gates ask. */
async function activeHold(env, caseNo) {
  if ((await missingTables(env)).includes('legal_hold')) return null;
  return env.DB.prepare(
    'SELECT reason, placed_by, placed_at FROM legal_hold WHERE case_no = ? AND released_at IS NULL')
    .bind(caseNo).first();
}

async function retentionEvent(env, caseNo, action, prior, next, reason, userId) {
  try {
    await env.DB.prepare(
      `INSERT INTO retention_event (case_no, action, prior_value, new_value, reason, user_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(caseNo, action, prior ?? null, next ?? null, reason || null, userId, nowIso()).run();
  } catch { /* the audit row must not break the action it describes */ }
}

async function retentionState(env, caseNo) {
  const missing = await retentionMissing(env);
  const ret = missing.includes('case_retention') ? null : await env.DB.prepare(
    'SELECT retain_until, schedule_state, scheduled_at, updated_at FROM case_retention WHERE case_no = ?')
    .bind(caseNo).first();
  const holdRow = missing.includes('legal_hold') ? null : await env.DB.prepare(
    `SELECT h.reason, h.placed_at, u.display_name AS placed_by
       FROM legal_hold h LEFT JOIN users u ON u.id = h.placed_by
      WHERE h.case_no = ? AND h.released_at IS NULL`).bind(caseNo).first();
  const m2 = await missingTables(env);
  const archived = m2.includes('case_archive') ? false : !!(await env.DB.prepare(
    'SELECT 1 AS x FROM case_archive WHERE case_no = ?').bind(caseNo).first());
  const deleted = m2.includes('case_deleted') ? false : !!(await env.DB.prepare(
    'SELECT 1 AS x FROM case_deleted WHERE case_no = ?').bind(caseNo).first());

  /* Display precedence: Deleted > Scheduled > Archived > Retain Until >
     Active. REVIEW DUE is computed against today on every read (the invoice
     `overdue` rule) — decision 3: a passed date changes only the wording. */
  const today = nowIso().slice(0, 10);
  const reviewDue = !!(ret && ret.retain_until && ret.retain_until < today);
  const state = deleted ? 'deleted'
    : (ret && ret.schedule_state === 'scheduled') ? 'scheduled'
    : archived ? 'archived'
    : (ret && ret.retain_until) ? 'retain_until'
    : 'active';
  return {
    state, archived, deleted,
    retain_until: (ret && ret.retain_until) || null,
    review_due: reviewDue,
    scheduled_at: (ret && ret.schedule_state === 'scheduled' && ret.scheduled_at) || null,
    hold: holdRow ? { reason: holdRow.reason, placed_by: holdRow.placed_by,
                      placed_at: holdRow.placed_at } : null,
    not_set_up: (await retentionMissing(env)).length > 0,
  };
}

async function retentionRead(env, user, caseNo) {
  if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const state = await retentionState(env, caseNo);
  let events = [];
  if (!(await missingTables(env)).includes('retention_event')) {
    const { results } = await env.DB.prepare(
      `SELECT e.action, e.prior_value, e.new_value, e.reason, e.at, u.display_name AS who
         FROM retention_event e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.case_no = ? ORDER BY e.id DESC LIMIT 30`).bind(caseNo).all();
    events = results || [];
  }
  return json({ ...state, events, generated_at: nowIso() });
}

/* Retain Until: set or clear, by hand, no clock (decision 3). The /meta rule:
   an absent field is unchanged; a blank clears. */
async function retentionSave(request, env, user, caseNo) {
  if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  if ((await retentionMissing(env)).length) {
    return json({ error: RETENTION_NOT_SET_UP, code: 'not_set_up' }, 503);
  }
  const body = await readJson(request);
  if (body.retain_until === undefined) return json({ error: 'Nothing to change.' }, 400);
  const raw = String(body.retain_until || '').trim();
  if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return json({ error: 'The retain-until date must be a real date (YYYY-MM-DD).' }, 400);
  }
  const prior = await env.DB.prepare(
    'SELECT retain_until FROM case_retention WHERE case_no = ?').bind(caseNo).first();
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO case_retention (case_no, retain_until, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(case_no) DO UPDATE SET retain_until = ?2, updated_by = ?3, updated_at = ?4`)
    .bind(caseNo, raw || null, user.id, now).run();
  await retentionEvent(env, caseNo, raw ? 'retain_until_set' : 'retain_until_cleared',
    (prior && prior.retain_until) || null, raw || null,
    String(body.reason || '').trim().slice(0, 500) || null, user.id);
  return retentionRead(env, user, caseNo);
}

/* Scheduling deletion is a RECORD OF INTENT (decision 2): it deletes nothing,
   destroys nothing, starts no clock. A hold blocks it by name (decision 5);
   an already-deleted case cannot be scheduled — the ladder has one direction. */
async function retentionSchedule(request, env, user, caseNo, on) {
  if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  if ((await retentionMissing(env)).length) {
    return json({ error: RETENTION_NOT_SET_UP, code: 'not_set_up' }, 503);
  }
  if (on) {
    const hold = await activeHold(env, caseNo);
    if (hold) {
      return json({ error: 'This case is under a legal hold — scheduling deletion is blocked '
        + 'until the hold is released.', code: 'legal_hold' }, 409);
    }
    const st = await retentionState(env, caseNo);
    if (st.deleted) return json({ error: 'This case is already deleted. Restore it first.' }, 409);
    /* Answer with the fresh read like the other three writers: the panel
       repaints from this body, and {ok:true} alone blanked it. */
    if (st.state === 'scheduled') return retentionRead(env, user, caseNo);
  }
  const body = await readJson(request);
  const prior = await env.DB.prepare(
    'SELECT schedule_state FROM case_retention WHERE case_no = ?').bind(caseNo).first();
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO case_retention (case_no, schedule_state, scheduled_by, scheduled_at, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?3, ?4)
     ON CONFLICT(case_no) DO UPDATE SET schedule_state = ?2,
       scheduled_by = CASE WHEN ?2 IS NULL THEN scheduled_by ELSE ?3 END,
       scheduled_at = CASE WHEN ?2 IS NULL THEN scheduled_at ELSE ?4 END,
       updated_by = ?3, updated_at = ?4`)
    .bind(caseNo, on ? 'scheduled' : null, user.id, now).run();
  await retentionEvent(env, caseNo, on ? 'scheduled' : 'unscheduled',
    (prior && prior.schedule_state) || null, on ? 'scheduled' : null,
    String(body.reason || '').trim().slice(0, 500) || null, user.id);
  return retentionRead(env, user, caseNo);
}

/* The hold. Reason is REQUIRED in both directions — decision 7 audits both. */
async function holdWrite(request, env, user, caseNo, place) {
  if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  if ((await retentionMissing(env)).length) {
    return json({ error: RETENTION_NOT_SET_UP, code: 'not_set_up' }, 503);
  }
  const body = await readJson(request);
  const reason = String(body.reason || '').trim().slice(0, 500);
  if (!reason) {
    return json({ error: place ? 'A hold needs its reason — it is the audit record.'
                               : 'Releasing a hold needs its reason — it is the audit record.' }, 400);
  }
  const current = await activeHold(env, caseNo);
  const now = nowIso();
  if (place) {
    if (current) return json({ error: 'A legal hold is already on this case.', code: 'already_held' }, 409);
    await env.DB.prepare(
      `INSERT INTO legal_hold (case_no, reason, placed_by, placed_at, released_by, released_at)
       VALUES (?1, ?2, ?3, ?4, NULL, NULL)
       ON CONFLICT(case_no) DO UPDATE SET reason = ?2, placed_by = ?3, placed_at = ?4,
         released_by = NULL, released_at = NULL`)
      .bind(caseNo, reason, user.id, now).run();
    await retentionEvent(env, caseNo, 'hold_placed', null, reason, reason, user.id);
  } else {
    if (!current) return json({ error: 'No legal hold is on this case.', code: 'not_held' }, 409);
    await env.DB.prepare(
      'UPDATE legal_hold SET released_by = ?, released_at = ? WHERE case_no = ? AND released_at IS NULL')
      .bind(user.id, now, caseNo).run();
    await retentionEvent(env, caseNo, 'hold_released', current.reason, null, reason, user.id);
  }
  return retentionRead(env, user, caseNo);
}

/* -------------------------------------------------- closeout facts (Unit 15)

   Designed from the audit in case-portal/CLOSEOUT.md — no verbatim owner
   brief exists; read that file first. The checklist stays exactly what the
   owner made it: eight ATTESTATIONS, the only door to closed. What this adds
   is the honesty rule the rest of the portal already follows — a staff screen
   must not stay silent about something it can see. Each fact is derived at
   read time from tables that already exist, is worded as a FACT rather than a
   conclusion ("1 invoice shows a balance", never "billing is not done"), and
   BLOCKS NOTHING: closeCase is untouched, and a tick over a contrary fact
   stands because attestation means the human looked and decided. The screen's
   job is to make sure they saw. */

async function closeoutFacts(env, caseNo) {
  const n = async (sql, ...binds) =>
    Number(((await env.DB.prepare(sql).bind(...binds).first()) || {}).n) || 0;
  const facts = {};
  const say = (k, note) => { facts[k] = { note }; };
  const plural = (x, one, many) => x === 1 ? one : many;

  const openDays = await n(
    'SELECT COUNT(*) AS n FROM case_days WHERE case_no = ? AND end_time IS NULL', caseNo);
  if (openDays) say('field_work', `${openDays} ${plural(openDays, 'day is', 'days are')} still running`);

  const quietDays = await n(
    `SELECT COUNT(*) AS n FROM case_days d
      WHERE d.case_no = ? AND NOT EXISTS (
        SELECT 1 FROM activity_log a WHERE a.day_id = d.id
          AND NOT EXISTS (SELECT 1 FROM activity_removed r WHERE r.entry_id = a.id))`, caseNo);
  if (quietDays) say('activity_logs',
    `${quietDays} ${plural(quietDays, 'day has', 'days have')} no activity entries`);

  const noReport = await n(
    `SELECT COUNT(*) AS n FROM case_days d
      WHERE d.case_no = ? AND d.end_time IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM case_reports r WHERE r.day_id = d.id)`, caseNo);
  const notShippable = await n(
    `SELECT COUNT(*) AS n FROM case_reports r LEFT JOIN users u ON u.id = r.investigator_id
      WHERE r.case_no = ? AND r.status NOT IN ('approved', 'delivered') AND u.role != 'admin'`, caseNo);
  {
    const bits = [];
    if (noReport) bits.push(`${noReport} finished ${plural(noReport, 'day has', 'days have')} no report`);
    if (notShippable) bits.push(`${notShippable} ${plural(notShippable, 'report is', 'reports are')} not signed off`);
    if (bits.length) say('report', bits.join('; '));
  }

  const awaiting = await n(
    `SELECT COUNT(*) AS n FROM case_reports WHERE case_no = ? AND status = 'submitted'`, caseNo);
  if (awaiting) say('admin_review',
    `${awaiting} ${plural(awaiting, 'report is', 'reports are')} submitted and waiting on review`);

  const review = await n(
    `SELECT COUNT(*) AS n FROM case_evidence
      WHERE case_no = ? AND deleted_at IS NULL AND classification = 'needs_review'`, caseNo);
  if (review) say('evidence',
    `${review} ${plural(review, 'file is', 'files are')} still marked Needs review`);

  /* Deliverables: a package that was never finalized is stated; a case that
     never opened one says nothing — plenty of cases deliver nothing and a
     warning would be an invented problem. */
  const builds = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM case_builds WHERE case_no = ? GROUP BY status`)
    .bind(caseNo).all();
  const byStatus = Object.fromEntries((builds.results || []).map(r => [r.status, r.n]));
  if ((byStatus.draft || 0) > 0 && !(byStatus.finalized > 0)) {
    say('deliverables', 'a package was started and never finalized');
  }

  const undecided = await n(
    `SELECT COUNT(*) AS n FROM case_expenses
      WHERE case_no = ? AND (reimbursable IS NULL OR billable IS NULL)`, caseNo);
  if (undecided) say('expenses',
    `${undecided} ${plural(undecided, 'expense is', 'expenses are')} not yet reviewed`);

  /* Billing: the balance is arithmetic, computed the way the invoices screen
     computes it — lines plus adjustments minus payments, per live invoice. */
  const { results: invs } = await env.DB.prepare(
    `SELECT id, adjustments FROM invoices WHERE case_no = ? AND status != 'void'`).bind(caseNo).all();
  let owed = 0;
  for (const inv of (invs || [])) {
    const { results: lines } = await env.DB.prepare(
      'SELECT amount FROM invoice_lines WHERE invoice_id = ?').bind(inv.id).all();
    const { results: pays } = await env.DB.prepare(
      'SELECT amount FROM invoice_payments WHERE invoice_id = ?').bind(inv.id).all();
    const money = invoiceMoney(lines || [], inv.adjustments, pays || []);
    if (money.balance_due > 0) owed = Math.round((owed + money.balance_due) * 100) / 100;
  }
  const bits = [];
  if (owed > 0) bits.push(`invoices show a balance of $${owed.toFixed(2)}`);
  const sub = await env.DB.prepare(
    'SELECT kind FROM submissions WHERE case_no = ?').bind(caseNo).first();
  if (sub && sub.kind === 'consumer') {
    const ret = await env.DB.prepare(
      'SELECT retainer_amount, received FROM case_retainer WHERE case_no = ?').bind(caseNo).first();
    if (ret && Number(ret.retainer_amount) > 0 && !ret.received) {
      bits.push('the agreed retainer is not recorded as received');
    }
  }
  if (bits.length) say('billing', bits.join('; '));

  return facts;
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
/* The one answer the code is not allowed to guess. `code` is what the page
   keys off; the sentence is what the admin reads, and it names the check they
   have to make rather than telling them to try again. */
const INDETERMINATE_PAYMENT = {
  error: 'An earlier version of the portal started recording this payment and did not '
       + 'finish saying whether it succeeded. Check the payments listed on this case: if '
       + 'it is already there, nothing more is needed. If it is not, start a new attempt.',
  code: 'payment_indeterminate',
};

/* RECORD A PAYMENT AND CLAIM ITS TOKEN AS ONE FACT.

   D1's batch() is a single transaction, so both statements commit or neither
   does. That removes the state this code kept tripping over: a token claimed
   with no payment behind it. It cannot exist now, so nothing has to guess
   whether such a claim means "the write failed, retry is safe" or "the write is
   still in flight, retry would duplicate" — a distinction the two-step version
   could not make, and got wrong in the direction that duplicates money on a
   double-click.

   The token insert deliberately has NO `ON CONFLICT DO NOTHING`. A repeat token
   must RAISE, so the transaction rolls back and the payment is not written; a
   silent no-op there would let the payment through beside a claim that was
   already taken. The raise is caught by the caller and read as "already
   recorded", which is what it is.

   Returns 'recorded' when the payment was written, 'duplicate' when the token
   had already been used and the money is provably on the ledger — the
   idempotent case, a success from the caller's side — and 'indeterminate' for a
   claim left by the earlier two-step version, whose outcome no code here can
   establish. See the catch for why that third answer has to exist. */
async function recordRetainerPayment(env, caseNo, token, row, userId) {
  const at = nowIso();
  const insertPayment = env.DB.prepare(
    `INSERT INTO retainer_payment (case_no, amount, method, paid_on, reference,
       recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(caseNo, row.amount, row.method, row.paid_on, row.reference, userId, at);

  if (!token) { await insertPayment.run(); return 'recorded'; }

  try {
    /* The payment goes in FIRST so its id is the one the claim points at.
       Sequential inside the transaction, so last_insert_rowid() is this
       payment. If the token is taken the second statement raises and the whole
       thing rolls back — the payment is not written, which is the point. */
    await env.DB.batch([
      insertPayment,
      env.DB.prepare(
        `INSERT INTO retainer_payment_token (token, case_no, payment_id, claimed_at)
         VALUES (?, ?, last_insert_rowid(), ?)`).bind(token, caseNo, at),
    ]);
    return 'recorded';
  } catch (e) {
    /* "Already recorded" has to be PROVEN, not guessed from an error message.
       The batch holds TWO inserts, so a payment that fails its own constraint
       rolls the whole thing back and writes NOTHING — and a message test
       matching "constraint" answered that with "already recorded", telling the
       admin the money was on file while the ledger stayed empty. A payment
       that vanishes silently is worse than the duplicate this guard exists to
       prevent.

       AND THE CLAIM ITSELF IS NOT THE PROOF — the money is. A bare "this token
       exists" still permits a false success in two ways. The token is a GLOBAL
       primary key, so a claim belonging to a different case would answer for
       this one. And claims written by the earlier two-step version are already
       in the live database with nothing behind them: that code inserted the
       token first and the payment second, so any attempt that died between the
       two left a stranded claim. Reading one of those as "already recorded"
       would answer 200 for ever on a payment that was never written.

       So the proof follows the claim through to a payment row ON THIS CASE.
       That is only sound because the two now commit together and the claim
       carries the id. */
    const paid = await env.DB.prepare(
      `SELECT p.id FROM retainer_payment_token t
         JOIN retainer_payment p ON p.id = t.payment_id
        WHERE t.token = ? AND t.case_no = ?`).bind(token, caseNo).first();
    if (paid) return 'duplicate';   // already recorded, and the money is there

    /* A LEGACY CLAIM IS NOT PROOF EITHER WAY, AND MUST NOT BE GUESSED AT.

       The two-step version wrote the claim first and the payment second, and
       never filled in payment_id — so a NULL one means "an attempt was made by
       that code" and NOTHING about whether the money landed. Both outcomes look
       identical: the payment may have committed and the response been dropped,
       or the attempt may have died in between.

       Adopting the claim and writing the payment would duplicate the first
       case. Answering "already recorded" would lose the second. Both were
       tried in earlier rounds of this guard and both are wrong, because the
       information needed to choose is not in the database.

       So the code stops and says exactly that. This is the ONE place a person
       has to decide, and they can: the payment list is on the same screen. The
       route turns this into a specific refusal rather than a 500, and the page
       offers to start a fresh attempt — a new token, deliberately pressed. */
    const legacy = await env.DB.prepare(
      `SELECT 1 AS x FROM retainer_payment_token
        WHERE token = ? AND case_no = ? AND payment_id IS NULL`).bind(token, caseNo).first();
    if (legacy) return 'indeterminate';
    throw e;
  }
}

/* What a private client has actually paid, across instalments.

   TOTAL RECEIVED is the sum of every VALID payment — voided ones stay in the
   log and stop counting, so a mistake is corrected without the record losing
   what was believed at the time. */
async function retainerPaid(env, caseNo) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.amount, p.method, p.paid_on, p.reference, p.recorded_at,
            u.display_name AS recorded_by,
            v.voided_at, v.reason AS void_reason, vu.display_name AS voided_by
       FROM retainer_payment p
       LEFT JOIN users u ON u.id = p.recorded_by
       LEFT JOIN retainer_payment_void v ON v.payment_id = p.id
       LEFT JOIN users vu ON vu.id = v.voided_by
      WHERE p.case_no = ? ORDER BY p.id`).bind(caseNo).all();

  const payments = (results || []).map(r => ({
    id: r.id, amount: Number(r.amount),
    method: r.method || '', method_label: RETAINER_METHOD_LABEL[r.method] || r.method || '',
    paid_on: r.paid_on || '', reference: r.reference || '',
    recorded_by: r.recorded_by || '', recorded_at: r.recorded_at || '',
    voided: !!r.voided_at, voided_by: r.voided_by || '', voided_at: r.voided_at || '',
    void_reason: r.void_reason || '',
  }));

  let total = payments.filter(p => !p.voided)
    .reduce((s, p) => s + (Number.isFinite(p.amount) ? p.amount : 0), 0);

  /* THE LEGACY ROW ALWAYS COUNTS. It was briefly counted only when the log was
     empty, and that undercounts: a case with a $1,500 receipt from before the
     log existed, taking a $500 instalment afterwards, would have reported $500
     received and lost the $1,500 without a word. Money already recorded does
     not stop being money because a newer row arrived beside it.

     Double-counting is prevented at the WRITE end instead — nothing creates a
     legacy row any more, so at most one exists per case and it can never be the
     same payment as a log entry. That is the durable version of the rule; the
     read-side condition was a guess about intent. */
  const legacy = await env.DB.prepare(
    `SELECT r.amount, r.method, r.paid_on, r.reference, r.recorded_at, u.display_name AS recorded_by
       FROM retainer_receipt r LEFT JOIN users u ON u.id = r.recorded_by
      WHERE r.case_no = ?`).bind(caseNo).first();
  if (legacy && legacy.amount != null) total += Number(legacy.amount);
  return { payments, total: Math.round(total * 100) / 100, legacy };
}

async function authorizationFor(env, caseNo, forAdmin) {
  const meta = await env.DB.prepare(
    `SELECT m.authorized_hours, m.authorized_budget, m.case_type_id, t.label AS case_type, t.side
       FROM case_meta m LEFT JOIN case_types t ON t.id = m.case_type_id
      WHERE m.case_no = ?`).bind(caseNo).first();

  /* A REMOVED DAY DOES NOT SPEND THE AUTHORIZATION (Unit 39). The cap is what
     the carrier or the client agreed to pay for; a day the office has taken
     out of the working case is not work being charged for, so counting its
     hours would draw an investigator toward a limit with time that no longer
     belongs to the case. Written as a NOT EXISTS rather than a load-and-filter
     so the sum stays one statement — and guarded, because the table arrives by
     a manual portal-setup dispatch and an authorization read that 500s would
     take the field view with it.

     PUTTING THE DAY BACK RESTORES THE HOURS, with no second write, because
     nothing here is stored. */
  const dayGate = (await missingTables(env)).includes('case_content_removed') ? '' :
    `AND NOT EXISTS (SELECT 1 FROM case_content_removed r
       WHERE r.kind = 'day' AND r.ref_id = case_days.id)`;
  const used = await env.DB.prepare(
    `SELECT COALESCE(SUM(hours), 0) AS h, COALESCE(SUM(miles), 0) AS m
       FROM case_days WHERE case_no = ? ${dayGate}`)
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
    const sub = await env.DB.prepare('SELECT kind, payload FROM submissions WHERE case_no = ?').bind(caseNo).first();
    const kind = sub ? sub.kind : null;
    /* LEGAL-SERVICES.md D7 — which pricing model this case's own record
       carries. Null for a non-legal case; `retainer` for a legal case with no
       marker, which is every case that predates the catalogue, so historical
       cases render exactly as they always did. */
    const legalPricing = legalPricingFor(sub);
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
      /* A FIXED legal case's figure defaults from the catalogue, never from
         PERSONAL.retainer — a fresh $250 locate must not read $1,500 (D7).
         An explicitly agreed per-case figure still outranks the default, the
         agreedRetainer principle applied to a flat fee. */
      const fixed = !!(legalPricing && legalPricing.model === 'fixed');
      const amount = ret && ret.retainer_amount != null ? Number(ret.retainer_amount)
        : fixed ? await legalFlatDefault(env, legalPricing.service) : PERSONAL.retainer;
      /* The panel's own fee line reads the CASE's figure, so the money block
         and the Legal panel cannot show two numbers for one case (D11). */
      if (fixed) legalPricing.fee = amount;
      const applied = Math.round(hoursUsed * rate * 100) / 100;
      const paid = await retainerPaid(env, caseNo);
      /* The legacy single receipt, still shown when it is the only record —
         see retainerPaid for why it still counts. */
      const rc = paid.legacy;
      /* THREE MONEY FIGURES, AND THEY ARE NOT INTERCHANGEABLE (owner, 2026-08-15).

         agreed      — what the client agreed to pay
         received    — what has actually arrived, summed across instalments
         outstanding — agreed minus received: what the client still owes

         `remaining` below is a FOURTH figure and keeps its existing meaning:
         agreed minus the work already applied against it. The owner was
         explicit that "Remaining" must not be reused for the unpaid balance,
         because these two answer different questions and a screen showing both
         under one word would misstate money in whichever direction the reader
         assumed. */
      const received = paid.total;
      const outstanding = Math.round((amount - received) * 100) / 100;
      out.retainer = {
        amount,
        agreed: amount,
        received_total: received,
        outstanding,
        received: received > 0 || !!(ret && ret.received),
        payments: paid.payments,
        /* NEVER CALLED A RETAINER on a fixed case (LEGAL-SERVICES.md D7), and
           never given hourly arithmetic either: a flat fee is the price of
           the whole assignment, so "applied at $100/hr" and "hours remaining"
           are the retainer model's figures and are NULL here rather than
           zero — null is "does not apply", zero would be a numeric claim. The
           page keys every money word off `model`. */
        model: fixed ? 'fixed' : 'retainer',
        service_label: fixed ? legalPricing.service_label : undefined,
        applied: fixed ? null : applied,
        remaining: fixed ? null : Math.round((amount - applied) * 100) / 100,
        approx_hours_remaining: (fixed || !(rate > 0)) ? null
          : Math.round(((amount - applied) / rate) * 10) / 10,
        /* PENDING until money is recorded, PART PAID while some has arrived and
           some has not. Sending payment instructions never reaches any of this —
           payment_send records that the firm asked, which is not being paid. */
        /* ONCE A CASE HAS PAYMENT HISTORY, THE MONEY DECIDES. The old
           `received` flag is an admin ticking "it's in" without saying how
           much; it still speaks for cases that predate the ledger and have no
           rows at all. But on a case whose only payment has been voided, the
           flag would keep announcing "received" over a ledger holding nothing
           — the screen contradicting the money, in the direction that says the
           firm has been paid when it has not. */
        status: received > 0
          ? (outstanding > 0 ? 'part_paid' : 'received')
          : (paid.payments.length || paid.legacy ? 'pending'
             : ((ret && ret.received) ? 'received' : 'pending')),
        receipt: rc ? {
          amount: rc.amount == null ? null : Number(rc.amount),
          method: rc.method || '', method_label: RETAINER_METHOD_LABEL[rc.method] || rc.method || '',
          paid_on: rc.paid_on || '', reference: rc.reference || '',
          recorded_by: rc.recorded_by || '', recorded_at: rc.recorded_at || '',
        } : null,
      };
    }
    /* The service and model on the case's own record, for the legal panel and
       the billing labels — the paying side, so admin only like everything
       else in this block. Undefined for a non-legal case. */
    out.legal_pricing = legalPricing || undefined;
    out.show_client_identity = st.show_client_identity ? 1 : 0;
  }
  return out;
}

async function caseWorkspace(env, user, caseNo) {
  const row = await caseFor(env, user, caseNo);
  if (!row) return json({ error: 'not found' }, 404);
  const admin = user.role === 'admin';

  /* THE JOIN IS GUARDED, like every table added after the live database
     existed. `schema.sql` arrives by a MANUAL portal-setup dispatch while the
     Worker deploys on push, so between the two `activity_source` does not
     exist — and a join against a missing table would take out the workspace,
     which is the most-used screen there is. Absent, an entry simply has no
     recorded source, which is what every entry made before this shipped is. */
  /* ONE schema check for the whole workspace. This is the most-opened screen in
     the portal (the Unit 7 lesson), and `missingTables` is a `sqlite_master`
     scan every time it is called — it was already being called twice here, and
     Unit 27's ending-actor read would have made three. Hoisted instead, so the
     screen costs one. */
  const missing = await missingTables(env);
  const hasSource = !missing.includes('activity_source');

  /* Removed entries still come back, stamped — the page greys them out with a
     way to put one back, and the report skips them. Erasing the row outright
     is what this deliberately does not do. */
  /* CHRONOLOGICAL, OLDEST FIRST (owner, 2026-08-22, Unit 38). A case's activity
     is a narrative — Day 1 before Day 2, 08:15 before 09:40 — and it was
     arriving newest-first, so the log, the field timeline and the REPORT
     chronology all read backwards while the Daily Summary builder sorted
     ascending for itself. One case, two answers about the same day.

     This is the single source all of them read, so the order is fixed once
     here rather than in each consumer. The row id is the tie-break and it is
     load-bearing: two entries recorded in the same minute must not swap places
     between requests, and the id is the only stable thing about them that
     already exists. Nothing about a stored timestamp changes — only which end
     the list starts at.

     The DASHBOARD's Recent activity is a different question and stays
     newest-first: it reads /recent-activity, not this. The page asks the same
     question in three places through newestActivity(), never by indexing this
     array from whichever end happens to be right.

     THE CAP IS STILL TAKEN FROM THE NEWEST END. Ordering ascending and then
     LIMIT 500 would keep the OLDEST five hundred entries and drop the work
     someone did this morning, on the one screen they are standing in front of.
     The inner query takes the newest 500 exactly as it always did; the outer
     one only decides which end the caller reads them from.

     Keep the comment out here: this SQL is a template literal and a backtick
     inside it ends the string. */
  const { results: activity } = await env.DB.prepare(
    `SELECT * FROM (
       SELECT a.id, a.day_id, a.at_date, a.at_time, a.kind, a.description, a.location,
              a.vehicle, a.internal_note, a.edited_at, u.display_name AS investigator,
              COALESCE(m.subject_documented, 0) AS subject_documented,
              COALESCE(m.video_acquired, 0) AS video_acquired,
              COALESCE(m.photo_acquired, 0) AS photo_acquired,
              r.removed_at, ru.display_name AS removed_by
              ${hasSource ? ', s.source, s.command_id' : ''}
         FROM activity_log a LEFT JOIN users u ON u.id = a.investigator_id
         LEFT JOIN activity_media m ON m.entry_id = a.id
         LEFT JOIN activity_removed r ON r.entry_id = a.id
         LEFT JOIN users ru ON ru.id = r.removed_by
         ${hasSource ? 'LEFT JOIN activity_source s ON s.entry_id = a.id' : ''}
        WHERE a.case_no = ?
        ORDER BY a.at_date DESC, a.at_time DESC, a.id DESC
        LIMIT 500
     ) ORDER BY at_date ASC, at_time ASC, id ASC`).bind(caseNo).all();

  /* A PRIOR INVESTIGATOR'S HOURS ARE ADMIN-ONLY (owner, 2026-08-21, locked).
     A reassigned investigator must not see the previous one's "worked hours,
     compensation details, billing detail, or other investigator-specific
     financial information" through "case-scoped reads, API responses, UI
     payloads, exports, reports, or hidden fields" — and this is the
     case-scoped read. `hours`, `miles` and the two mileage readings are the
     figures a day is PAID from, so reassigning a case handed the new
     investigator the old one's timesheet.

     Scoped IN THE SQL, not by dropping fields from the payload afterwards:
     the row never leaves the database, so there is nothing to redact and
     nothing sitting in a network tab. `/calendar` already scopes its own day
     query exactly this way, and `saveDaySummary`, `generateReport` and
     `saveReport` already answer "that day belongs to another investigator" on
     the WRITE side — this read was the way round all four.

     The case's TOTAL hours against its authorization are a different thing and
     deliberately stay: `authorizationFor` is the cap the field is working to,
     not what anybody was paid. */
  const { results: days } = await env.DB.prepare(
    `SELECT d.id, d.day_date, d.start_time, d.end_time, d.start_mileage, d.end_mileage,
            d.hours, d.miles, d.summary, u.display_name AS investigator, d.investigator_id
       FROM case_days d LEFT JOIN users u ON u.id = d.investigator_id
      WHERE d.case_no = ? ${admin ? '' : 'AND d.investigator_id = ?'}
      ORDER BY d.day_date DESC, d.id DESC LIMIT 100`)
    .bind(...(admin ? [caseNo] : [caseNo, user.id])).all();

  /* THE CASE'S DAY COUNT, which is not a timesheet. With the list scoped, the
     field view's "Day 4" would read "Day 1" for an investigator who took the
     case over — a staff screen asserting something untrue about the case,
     which is the defect this project keeps closing. A count carries no hours,
     no mileage, no name and no money, so it is not what the rule protects.
     Read only when the list WAS scoped: an admin already holds every row, and
     this is the most-opened screen in the portal. */
  const daysTotal = admin ? (days || []).length
    : Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM case_days WHERE case_no = ?')
        .bind(caseNo).first() || {}).n || 0);

  /* WHO ENDED EACH DAY (owner, 2026-08-21). One read for the case, decorated
     onto the rows already fetched — no query per day.

     BOTH ROLES. An investigator whose day the office ended is precisely the
     person who most needs to be told, and it is not investigator-specific
     financial information: no hours, no money, only who pressed End on a day
     they can already see. Unit 25's scope means they only ever see their own
     days here anyway.

     `null` from `dayEndActors` means the table has not arrived, and that is
     carried through as `ended_self: null` — UNKNOWN, which the page draws as
     "not recorded". It must never draw as "the investigator ended it". */
  const endActors = await dayEndActors(env, caseNo, missing);
  for (const d of days || []) {
    const rec = endActors ? endActors.get(d.id) : null;
    // Only an ENDED day has an ending actor; a running one has nothing to say.
    if (!d.end_time) { d.ended_self = null; d.ended_by_label = ''; continue; }
    d.ended_self = rec ? rec.ended_by === d.investigator_id : null;
    d.ended_by_name = rec ? (rec.ended_by_name || null) : null;
    d.ended_by_role = rec ? rec.ended_role : null;
    d.ended_by_at = rec ? rec.at : null;
    d.ended_by_label = dayEndLabel(rec, d.investigator_id);
  }

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

  /* THE SAME LOCKED RULE, and this is the half that names money outright:
     `amount`, `reimbursable` and `billable` are one investigator's claim
     against the firm. `/my/expenses` is already `WHERE investigator_id = ?`
     and every expense WRITE route is admin-only — this read was the way round
     both, on the most-opened screen in the portal. */
  const { results: expenses } = await env.DB.prepare(
    `SELECT e.id, e.expense_date, e.category, e.amount, e.miles, e.description,
            e.reimbursable, e.billable, e.internal, e.reviewed_at, e.edited_at,
            e.investigator_id, u.display_name AS investigator
       FROM case_expenses e LEFT JOIN users u ON u.id = e.investigator_id
      WHERE e.case_no = ? ${admin ? '' : 'AND e.investigator_id = ?'}
      ORDER BY e.expense_date DESC, e.id DESC LIMIT 200`)
    .bind(...(admin ? [caseNo] : [caseNo, user.id])).all();

  // Visibility is enforced HERE: an admin-only note never leaves the Worker
  // for anyone else. The page renders what arrives; it decides nothing.
  const { results: notes } = await env.DB.prepare(
    /* `author_id` rides along for Unit 39: a note is removable by its author
       or by the office, and the page cannot draw that button without knowing
       whose it is. It is an internal user id on a case the caller can already
       open, not client data. */
    `SELECT n.id, n.note_type, n.visibility, n.body, n.created_at, n.edited_at,
            n.author_id, u.display_name AS author
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

  /* The record of every timestamped video copy made for this case. There are no
     video bytes here or in R2 — see `recordVideoStamp` — so this is the whole
     of what the portal knows about them, and it rides with the workspace so the
     Evidence tab needs no second round trip.

     GUARDED: `schema.sql` arrives by a manual portal-setup dispatch while the
     Worker deploys on push, so between the two this table does not exist on the
     live database and a query against it would take out the whole workspace. */
  const missingForStamps = missing;   // the one check hoisted above
  const videoStamps = missingForStamps.includes('video_stamp')
    ? [] : await videoStampsFor(env, caseNo);

  /* Which photographs are originals and which are timestamped copies of them.
     The pairing lives here rather than on `case_evidence`, which cannot gain a
     column, and it rides with the workspace so the gallery can badge both
     halves without a second round trip. Guarded for the same reason as the
     line above: this table arrives by a manual portal-setup dispatch. */
  const photoStamps = missingForStamps.includes('photo_stamp')
    ? [] : await photoStampsFor(env, caseNo);

  /* Unit 11: the live integrity record for each artifact, metadata only —
     no byte is read to draw a hash that is already recorded. Null (not [])
     when the table has not arrived, so the page can say "not set up yet"
     instead of drawing every file as unrecorded. Both roles receive it:
     an investigator who can open the case may see the hash of evidence they
     can already download, minus `storage_ref`, which is office filing. */
  const integrity = missingForStamps.includes('evidence_integrity')
    ? null : await integrityFor(env, caseNo, admin);

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
  /* UNIT 39 — what the office has removed from this case's working set. One
     read, one Set, and a marker rather than a filter: a removed row is drawn
     struck through with a way back, which is the treatment `activity_removed`
     already gets and the reason nothing in this portal is unrecoverable in it.
     Filtering here would have made "put it back" unreachable from the only
     screen that knows the row exists. */
  const removedSet = await contentRemovedSet(env, caseNo, missing);
  const mark = (kind, rows) => (rows || []).map(r =>
    removedSet.has(`${kind}:${r.id}`) ? { ...r, removed: true } : r);

  const subjects = (subjectRows || []).map(s => ({
    ...s, vehicles: mark('vehicle', (vehicleRows || []).filter(v => v.subject_id === s.id)),
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
    phones: await phonesFor(env, caseNo, { forAdmin: admin }),
    ...(admin ? { archived: await archiveOf(env, caseNo), deleted: await deletedOf(env, caseNo),
                  build_status: buildStatus, invoice_status: invoiceStatus,
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
    subjects: mark('subject', subjects),
    case_types: admin ? await listCaseTypes(env) : [],
    /* AN ENTRY ON A REMOVED DAY GOES WITH THE DAY — out of the Daily Summary
       source and out of the report chronology, because the owner's own option
       is "Remove day and its case-work records from active use".

       IT IS A SEPARATE FLAG, NOT `removed_at`. Writing the day's removal
       instant onto the entry would draw it as "Removed by Corey at 14:02",
       which is a staff screen asserting something that did not happen: nobody
       removed that entry. It says what is true — the entry is on a day that
       was removed — and comes back the moment the day does, with no second
       write to undo. */
    activity: (activity || []).map(a =>
      removedSet.has(`day:${a.day_id}`) ? { ...a, removed_with_day: true } : a),
    days: mark('day', days),
    days_total: daysTotal,
    open_day: openDay || null,
    reports: reports || [],
    expenses: mark('expense', expenses),
    notes: mark('note', notes),
    comms: mark('comm', comms),
    evidence: evidence || [],
    video_stamps: videoStamps,
    photo_stamps: photoStamps,
    /* The authored daily-summary paragraphs, one per investigation day (Unit
       12). Guarded like the two stamp tables: the table arrives by a manual
       portal-setup dispatch, and `null` here means UNKNOWN — the page must
       draw "not set up yet" rather than "no day has a summary". Both roles:
       the summary is report prose, and the investigator who writes the day's
       report writes its paragraph under the same rules. */
    day_summaries: missingForStamps.includes('case_day_summary') ? null
      : await daySummariesFor(env, caseNo, removedSet),
    integrity,
    /* UNIT 6 — the firm, the matter, the dates and the arrangement. ADMIN
       ONLY: who is paying is exactly what an investigator is never sent, and
       every one of these fields names the paying side. The subject fields the
       field needs ride the ordinary payload allow-list, not this. */
    legal: admin ? await legalFor(env, caseNo) : undefined,
    /* LEGAL-SERVICES.md — the service catalogue for the Legal panel's pricing
       selector, one writer with the Worker's own vocabulary so the page never
       grows a second copy to drift. Admin-only beside `legal` above. */
    legal_services: admin ? LEGAL_SVC_LIST : undefined,
    /* UNIT 7 — which saved profile this assignment came from, and (only when
       there is none) the possible match computed from the case's own values.
       ADMIN ONLY for the same reason as the line above: a profile IS the
       paying side. An investigator gets no key at all, so the field does not
       reach their browser to be read out of the network tab. */
    profile: admin ? await caseProfileFor(env, caseNo) : undefined,
    tasks: mark('task', tasks),
    offers: offers || [],
    my_offer: myOffer || null,
    /* THE REMOVED SET IS NOT SENT. It was, briefly: the whole `kind:ref_id`
       list, so the page could decide what to strike through. Nothing read it —
       every row already carries its own `removed` flag from `mark()` — so it
       was a list of record ids riding to an investigator's browser for no
       reason at all. `FIELD_KEEP`'s rule is that a field the page declines to
       draw is still sitting in the network tab; the answer is not to send it. */
  });
}

/* UNIT 6 — the Legal panel's writer. THE /meta RULES, deliberately: an absent
   key means unchanged, a blank string clears, and the untouched fields are
   resolved INSIDE the statement rather than read-then-written, so two admins
   posting different subsets cannot interleave into a silent loss. The SET list
   is built from LEGAL_FIELDS filtered to the keys the request actually
   mentioned — column names come only from that constant, never from input.

   It also BACKFILLS: a legal intake that arrived before portal-setup ran has
   its facts in the payload but no row; the first Save writes the row from the
   posted fields plus nothing else, and the fallback reader stops being needed
   for that case. */
async function setLegalDetail(request, env, user, caseNo) {
  const sub = await env.DB.prepare('SELECT kind, payload FROM submissions WHERE case_no = ?')
    .bind(caseNo).first();
  if (!sub) return json({ error: 'not found' }, 404);
  if (!isLegalSub(sub)) {
    return json({ error: `${caseNo} is not a legal assignment — the Legal panel writes only to `
      + `legal cases, and a private client or a carrier file has no firm record to hold.` }, 400);
  }
  const body = await readJson(request);
  const mentioned = LEGAL_FIELDS.filter(f => body[f] !== undefined);
  /* LEGAL-SERVICES.md D8 — the pricing-level service, under the same absent/
     blank rules as everything else here. It lives in the submission PAYLOAD
     (the marker of record, D3), not in legal_intake, so it is written the way
     /cases/:no/edit writes payload fields — and a service-only edit therefore
     works even before legal_intake exists. Blank clears the marker and the
     case returns to the retainer presentation; nothing here touches
     assignment_type, which on an EDIT is the office's own word. */
  const svcMentioned = body.legal_service !== undefined;
  let svcValue = null;
  if (svcMentioned) {
    const raw = String(body.legal_service == null ? '' : body.legal_service).trim();
    if (raw !== '') {
      const svc = legalServiceById(raw);
      if (!svc) {
        return json({ error: 'No such legal service. The services are: '
          + Object.values(LEGAL_SERVICES).map(s => s.label).join(', ') + '.' }, 400);
      }
      svcValue = svc.id;
    }
  }
  if (!mentioned.length && !svcMentioned) return json({ error: 'Nothing to change.' }, 400);
  if (mentioned.length && (await missingTables(env)).includes('legal_intake')) {
    return json({ error: 'The legal_intake table is not on this database yet. Run the '
      + 'portal-setup workflow once and save again — nothing typed is lost meanwhile, the '
      + 'intake payload still holds what the firm sent.', code: 'not_set_up' }, 503);
  }
  const vals = {};
  for (const f of mentioned) {
    let v = cleanLegal(body[f]);
    if (f === 'payment_arrangement' && v && !LEGAL_ARRANGEMENTS[v]) {
      return json({ error: 'Pick one of the four legal payment arrangements.' }, 400);
    }
    vals[f] = v;
  }
  let updatedPayload = null;
  if (svcMentioned) {
    let p = {}; try { p = JSON.parse(sub.payload || '{}'); } catch { p = {}; }
    if (svcValue) p.legal_service = svcValue; else delete p.legal_service;
    updatedPayload = JSON.stringify(p);
    await env.DB.prepare('UPDATE submissions SET payload = ? WHERE case_no = ?')
      .bind(updatedPayload, caseNo).run();
  }
  if (mentioned.length) {
    /* Ensure the row exists (the backfill), then update only what was named. */
    await env.DB.prepare(
      `INSERT INTO legal_intake (case_no, created_at) VALUES (?, ?)
       ON CONFLICT(case_no) DO NOTHING`).bind(caseNo, nowIso()).run();
    await env.DB.prepare(
      `UPDATE legal_intake SET ${mentioned.map(f => `${f} = ?`).join(', ')},
         updated_by = ?, updated_at = ? WHERE case_no = ?`)
      .bind(...mentioned.map(f => vals[f]), user.id, nowIso(), caseNo).run();
  }
  return json({ ok: true, legal: await legalFor(env, caseNo),
    legal_pricing: legalPricingFor(updatedPayload != null
      ? { ...sub, payload: updatedPayload } : sub) });
}

/* ======================================================================
   REPEAT CLIENT / FIRM PROFILES (Unit 7 — the derivations are in
   case-portal/PROFILES.md, one per entry).

   THE WHOLE ARCHITECTURE IN ONE SENTENCE: a profile is a reusable DEFAULT,
   a case is a SNAPSHOT, and the only thing connecting them is one explicit
   `case_profile` row. Prefill copies profile values into the assignment form;
   `createManualIntake` writes the case from the form BODY exactly as it always
   did; no case read joins a profile. So "editing a firm must not rewrite prior
   cases" is a property of the shape rather than a rule to remember — there is
   no code path by which it could.

   AND NOTHING HERE INFERS. A possible match is computed only when an admin is
   looking at the question, and every outcome is a button they press. There is
   no merge routine, no upsert and no writer that puts submitted values into an
   existing profile — "never auto-merge" is the absence of the code, not a
   guard in front of it. The recipientIsCarrier() history is why.
   ====================================================================== */

const NO_PROFILES = 'The client profile tables are not on this database yet. '
  + 'Run the portal-setup workflow once and try again — nothing else is affected.';

/** One profile with its people and their numbers. Three queries, never one per
    contact: the phones come back for the whole profile in a single read and
    are attached in memory. */
async function profileDetail(env, id) {
  if (!(await profilesReady(env))) return null;
  const p = await env.DB.prepare('SELECT * FROM profile WHERE id = ?').bind(id).first();
  if (!p) return null;
  const { results: contacts } = await env.DB.prepare(
    `SELECT id, first_name, last_name, role, email, preferred, active, position, notes
       FROM profile_contact WHERE profile_id = ? ORDER BY active DESC, position, id`)
    .bind(id).all();
  const { results: phones } = await env.DB.prepare(
    `SELECT id, contact_id, label, number, position FROM profile_phone
      WHERE profile_id = ? ORDER BY position, id`).bind(id).all();
  const own = [], byContact = new Map();
  for (const ph of phones || []) {
    const entry = { id: ph.id, label: ph.label || '', number: ph.number };
    if (ph.contact_id == null) own.push(entry);
    else {
      const k = String(ph.contact_id);
      if (!byContact.has(k)) byContact.set(k, []);
      byContact.get(k).push(entry);
    }
  }
  return {
    ...p,
    kind_label: PROFILE_KINDS[p.kind] || p.kind,
    phones: own,
    contacts: (contacts || []).map(c => ({ ...c, phones: byContact.get(String(c.id)) || [] })),
  };
}

/** The cases this profile has been used on. The reverse read of the ONE link
    table — cheap, indexed and capped, and it holds no copy of anything.
    A deleted case is out (it is out of every ordinary view); an archived one
    stays, badged, because a firm's history is the point of the list. */
async function profileMatters(env, id, limit = 10) {
  const missing = await missingTables(env);
  const deletedCut = missing.includes('case_deleted') ? ''
    : 'AND cp.case_no NOT IN (SELECT case_no FROM case_deleted)';
  const archived = missing.includes('case_archive') ? '0'
    : '(SELECT COUNT(*) FROM case_archive a WHERE a.case_no = cp.case_no)';
  /* The legal marker rides along, because a legal case IS kind='consumer' —
     a Type column reading `kind` alone labelled every law firm's matters
     "Private", on the law firm's own screen. Same category fact the lead card
     and the case list already carry. */
  const { results } = await env.DB.prepare(
    `SELECT cp.case_no, cp.linked_at, cp.source, s.kind, s.status, s.client_name,
            s.created_at, ${archived} AS archived,
            CASE WHEN json_valid(s.payload) AND json_extract(s.payload, '$.assignment') = 'legal'
                 THEN 1 ELSE 0 END AS legal
       FROM case_profile cp JOIN submissions s ON s.case_no = cp.case_no
      WHERE cp.profile_id = ? ${deletedCut}
      ORDER BY s.created_at DESC LIMIT ?`).bind(id, limit).all();
  return (results || []).map(r => ({ ...r, archived: !!Number(r.archived), legal: !!Number(r.legal) }));
}

/* THE DUPLICATE WARNING. Returns candidates and WHY each one surfaced, so the
   office reads "same phone number" rather than a bare list it has to work out.
   It never returns a decision: `POST /profiles` refuses without an explicit
   confirm_new, and there is nothing it could call to merge if it wanted to.

   Inactive profiles are INCLUDED deliberately. A duplicate check that skips
   them manufactures the duplicate it exists to prevent, the first time an old
   firm comes back. */
async function profileMatchesFor(env, { name, email, phone, address, exclude } = {}) {
  if (!(await profilesReady(env))) return [];
  const nn = normText(name), ne = String(email || '').trim().toLowerCase();
  const na = normText(address), nd = normDigits(phone);
  const hits = new Map();
  const add = (row, why) => {
    if (!row || (exclude && Number(row.id) === Number(exclude))) return;
    const k = String(row.id);
    if (!hits.has(k)) hits.set(k, { id: row.id, kind: row.kind, name: row.name, active: !!row.active, why: [] });
    if (!hits.get(k).why.includes(why)) hits.get(k).why.push(why);
  };

  if (nn) {
    /* Exact normalised equality, then containment either way — "Smith Law"
       inside "Smith Law Group" and the reverse. Containment is a SUGGESTION
       and is never treated as sameness; the office decides. Guarded at four
       characters so "law" does not match the whole directory. */
    const { results } = await env.DB.prepare(
      `SELECT id, kind, name, name_norm, active FROM profile
        WHERE name_norm = ?1 OR (LENGTH(?1) >= 4 AND name_norm LIKE '%' || ?1 || '%')
           OR (LENGTH(name_norm) >= 4 AND INSTR(?1, name_norm) > 0)
        LIMIT 25`).bind(nn).all();
    for (const r of results || []) add(r, r.name_norm === nn ? 'name' : 'similar_name');
  }
  if (ne) {
    const { results } = await env.DB.prepare(
      `SELECT id, kind, name, active FROM profile WHERE LOWER(TRIM(email)) = ? LIMIT 25`)
      .bind(ne).all();
    for (const r of results || []) add(r, 'email');
    const { results: cc } = await env.DB.prepare(
      `SELECT p.id, p.kind, p.name, p.active FROM profile_contact c
         JOIN profile p ON p.id = c.profile_id
        WHERE LOWER(TRIM(c.email)) = ? LIMIT 25`).bind(ne).all();
    for (const r of cc || []) add(r, 'contact_email');
  }
  if (nd.length >= 7) {
    /* Matched on the last ten digits, so formatting and a leading 1 cannot
       defeat it. The stored `digits` column is what makes this an index read
       rather than string surgery in SQL, which D1 has no regex for anyway. */
    const tail = nd.slice(-10);
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT p.id, p.kind, p.name, p.active FROM profile_phone ph
         JOIN profile p ON p.id = ph.profile_id
        WHERE ph.digits LIKE '%' || ? LIMIT 25`).bind(tail).all();
    for (const r of results || []) add(r, 'phone');
  }
  if (na && na.length >= 8) {
    /* An indexed equality on the stored normalised column, like the name.
       It began as a bounded scan — SELECT ... LIMIT 400 — on the reasoning
       that an address is the weakest signal and not worth an index. That was
       wrong in the way that matters: the limit had no ORDER BY and no relation
       to the address being compared, so past four hundred addressed profiles
       the arm silently stopped finding anything, and it failed toward CREATING
       the duplicate the check exists to prevent. A signal that quietly switches
       off as the directory grows is worse than no signal. */
    const { results } = await env.DB.prepare(
      `SELECT id, kind, name, active FROM profile WHERE address_norm = ? LIMIT 25`)
      .bind(na).all();
    for (const r of results || []) add(r, 'address');
  }
  return [...hits.values()].slice(0, 10);
}

/* The directory and the picker are the SAME read, which is why the two can
   never disagree about what a search finds. The contacts, phones and case
   counts for the whole result set come back in one query each — never one per
   profile.

   WHAT THE SEARCH ARMS ACTUALLY COST, said plainly rather than claimed away:
   a substring search is `LIKE '%x%'`, and no index can seek that, so each arm
   reads its table. That is the deliberate trade for an admin-only, debounced
   search over a directory of hundreds — and it is bounded on both ends: each
   arm takes at most CANDIDATE_CAP ids, and the page itself is capped below.
   The lookups that CAN be indexed — the duplicate check's name, address and
   phone equalities — are, and those are the ones that run without a person
   asking for them.

   THE CAP IS NOT COSMETIC. D1 allows a limited number of bound parameters in
   one statement (100 at the time of writing), and the `id IN (...)` list below
   is built from the arms above — so an unbounded candidate set is a statement
   that grows with the customer's data and fails only in production, which
   node:sqlite would never show. Capped here, where the number is visible. */
const CANDIDATE_CAP = 40;
/* And the page itself, because the per-row reads bind one id each. */
const PAGE_CAP = 60;
async function searchProfiles(env, { q = '', kind = '', includeInactive = false, limit = 60 } = {}) {
  if (!(await profilesReady(env))) return { profiles: [], not_set_up: true };
  const term = String(q || '').trim();
  const nq = normText(term), dq = normDigits(term);
  const raw = term.toLowerCase();
  let ids = null;

  if (term) {
    ids = new Set();
    const take = rs => {
      for (const r of rs || []) { if (ids.size >= CANDIDATE_CAP) return; ids.add(Number(r.id)); }
    };
    const { results: byName } = await env.DB.prepare(
      `SELECT id FROM profile WHERE name_norm LIKE '%' || ? || '%' LIMIT ${CANDIDATE_CAP}`).bind(nq).all();
    take(byName);
    if (raw.includes('@') || raw.length >= 3) {
      /* The org's own fields, INCLUDING the billing desk — the owner's list of
         searchable fields names the billing contact, and one typed into the
         profile's billing fields rather than added as a person was unfindable. */
      const { results: byEmail } = await env.DB.prepare(
        `SELECT id FROM profile
          WHERE (email IS NOT NULL AND LOWER(email) LIKE '%' || ?1 || '%')
             OR (billing_email IS NOT NULL AND LOWER(billing_email) LIKE '%' || ?1 || '%')
             OR (billing_name IS NOT NULL AND LOWER(billing_name) LIKE '%' || ?1 || '%')
          LIMIT ${CANDIDATE_CAP}`)
        .bind(raw).all();
      take(byEmail);
      const { results: byContact } = await env.DB.prepare(
        `SELECT DISTINCT profile_id AS id FROM profile_contact
          WHERE name_norm LIKE '%' || ?1 || '%'
             OR (email IS NOT NULL AND LOWER(email) LIKE '%' || ?2 || '%') LIMIT ${CANDIDATE_CAP}`)
        .bind(nq, raw).all();
      take(byContact);
    }
    if (dq.length >= 3) {
      const { results: byPhone } = await env.DB.prepare(
        `SELECT DISTINCT profile_id AS id FROM profile_phone WHERE digits LIKE '%' || ? || '%' LIMIT ${CANDIDATE_CAP}`)
        .bind(dq).all();
      take(byPhone);
    }
    if (!ids.size) return { profiles: [] };
  }

  const where = [], binds = [];
  if (ids) { where.push(`id IN (${[...ids].map(() => '?').join(',')})`); binds.push(...ids); }
  if (kind && PROFILE_KINDS[kind]) { where.push('kind = ?'); binds.push(kind); }
  if (!includeInactive) where.push('active = 1');
  const { results } = await env.DB.prepare(
    `SELECT id, kind, name, email, address, active, payment_arrangement
       FROM profile ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY active DESC, name COLLATE NOCASE LIMIT ?`)
    .bind(...binds, Math.min(PAGE_CAP, limit)).all();
  const rows = results || [];
  if (!rows.length) return { profiles: [] };

  /* Two reads for the whole page, not two per row. */
  const inList = rows.map(() => '?').join(',');
  const rowIds = rows.map(r => r.id);
  const { results: contacts } = await env.DB.prepare(
    `SELECT id, profile_id, first_name, last_name, role, email, preferred, active
       FROM profile_contact WHERE profile_id IN (${inList}) AND active = 1
      ORDER BY preferred DESC, position, id`).bind(...rowIds).all();
  const { results: phones } = await env.DB.prepare(
    `SELECT id, profile_id, contact_id, label, number FROM profile_phone
      WHERE profile_id IN (${inList}) ORDER BY position, id`).bind(...rowIds).all();
  const { results: counts } = await env.DB.prepare(
    `SELECT profile_id, COUNT(*) AS n FROM case_profile
      WHERE profile_id IN (${inList}) GROUP BY profile_id`).bind(...rowIds).all();

  const cIdx = new Map(), pOwn = new Map(), pFor = new Map(), nCase = new Map();
  for (const c of contacts || []) {
    const k = String(c.profile_id);
    if (!cIdx.has(k)) cIdx.set(k, []);
    cIdx.get(k).push(c);
  }
  for (const ph of phones || []) {
    const entry = { id: ph.id, label: ph.label || '', number: ph.number };
    if (ph.contact_id == null) {
      const k = String(ph.profile_id);
      if (!pOwn.has(k)) pOwn.set(k, []);
      pOwn.get(k).push(entry);
    } else {
      const k = String(ph.contact_id);
      if (!pFor.has(k)) pFor.set(k, []);
      pFor.get(k).push(entry);
    }
  }
  for (const c of counts || []) nCase.set(String(c.profile_id), Number(c.n) || 0);

  return {
    profiles: rows.map(r => ({
      ...r,
      active: !!r.active,
      kind_label: PROFILE_KINDS[r.kind] || r.kind,
      phones: pOwn.get(String(r.id)) || [],
      contacts: (cIdx.get(String(r.id)) || []).map(c => ({
        ...c, preferred: !!c.preferred, active: !!c.active,
        phones: pFor.get(String(c.id)) || [],
      })),
      case_count: nCase.get(String(r.id)) || 0,
    })),
  };
}

/* A phone list, replaced wholesale — the `saveCasePhones` rule, and for the
   same reason: the office edits a list as a list, and a diff would only be a
   way to get it wrong. `digits` is written here, beside the number, so the
   search key can never be missing from a row that exists. */
async function saveProfilePhones(env, profileId, contactId, list) {
  const del = contactId == null
    ? env.DB.prepare('DELETE FROM profile_phone WHERE profile_id = ? AND contact_id IS NULL').bind(profileId)
    : env.DB.prepare('DELETE FROM profile_phone WHERE profile_id = ? AND contact_id = ?').bind(profileId, contactId);
  await del.run();
  const now = nowIso();
  let i = 0;
  for (const p of Array.isArray(list) ? list : []) {
    const number = cleanPhone(p && p.number);
    if (!number) continue;
    const label = PHONE_LABELS.includes(String(p.label || '').toLowerCase())
      ? String(p.label).toLowerCase() : null;
    await env.DB.prepare(
      `INSERT INTO profile_phone (profile_id, contact_id, label, number, digits, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(profileId, contactId, label, number, normDigits(number), i++, now, now).run();
  }
  return i;
}

/* PROFILE FIELDS, once. `kind` is NOT here: it is set at creation and never
   read from an edit (PROFILES.md D2). Neither is anything with a figure in
   it — there is no retainer, rate or matter number on a profile, so the
   authoritative pricing source stays the only one. */
const PROFILE_FIELDS = ['name', 'email', 'address', 'billing_name', 'billing_email',
  'payment_arrangement', 'notes'];

function readProfileBody(body, kind) {
  const out = {};
  for (const f of PROFILE_FIELDS) {
    if (body[f] === undefined) continue;
    out[f] = cleanProfileText(body[f]);
  }
  if (out.payment_arrangement) {
    /* The one commercial default a profile carries, and it is an ARRANGEMENT
       rather than a payment — the same four the case panel validates against,
       and law firms only. It prefills a select; it can never mark anything
       paid, and nothing here touches retainer_payment. */
    if (kind !== 'law_firm') return { error: 'A payment arrangement is a law-firm preference — '
      + 'insurance and private clients are billed under their own existing rules.' };
    if (!LEGAL_ARRANGEMENTS[out.payment_arrangement]) {
      return { error: 'Pick one of the four legal payment arrangements.' };
    }
  }
  return { out };
}

async function listProfilesRoute(request, env) {
  const url = new URL(request.url);
  const missing = await profilesMissing(env);
  if (missing.length) {
    return json({ profiles: [], not_set_up: true, missing,
      note: NO_PROFILES }, 200);
  }
  const out = await searchProfiles(env, {
    q: url.searchParams.get('q') || '',
    kind: url.searchParams.get('kind') || '',
    includeInactive: url.searchParams.get('inactive') === '1',
    /* Bounded for the same reason CANDIDATE_CAP is: `limit` binds a parameter
       per row in the contact, phone and count reads below. */
    /* `Number('-1')` is truthy, so `||` never fired and Math.min handed SQLite
       a negative LIMIT — which SQLite reads as NO limit, defeating PAGE_CAP
       and building a bind list that grows with the customer's data (closeout
       audit, 2026-09-03). Clamped at both ends, as the sheet reader already
       does. */
    limit: Math.min(PAGE_CAP, Math.max(1, Number(url.searchParams.get('limit')) || 60)),
  });
  return json({ ...out, kinds: PROFILE_KINDS, roles: PROFILE_ROLES, phone_labels: PHONE_LABELS });
}

async function getProfileRoute(env, id) {
  if ((await profilesMissing(env)).length) return json({ error: NO_PROFILES, code: 'not_set_up' }, 503);
  const p = await profileDetail(env, id);
  if (!p) return json({ error: 'not found' }, 404);
  return json({ profile: p, matters: await profileMatters(env, id),
    roles: PROFILE_ROLES[p.kind] || PROFILE_ROLES.law_firm, phone_labels: PHONE_LABELS });
}

/* CREATE. Always an INSERT — there is deliberately no upsert here, so no
   request can rewrite an existing profile by resembling it.

   A possible match REFUSES the write and names what matched. The office then
   either uses the existing profile or posts again with confirm_new, which is
   the owner's "Use Existing / Continue as New" as two different requests
   rather than a flag someone could default to true. */
async function createProfile(request, env, user) {
  if ((await profilesMissing(env)).length) return json({ error: NO_PROFILES, code: 'not_set_up' }, 503);
  const body = await readJson(request);
  const kind = String(body.kind || '');
  if (!PROFILE_KINDS[kind]) {
    return json({ error: 'Pick a profile type: law firm, insurance / organization, or private client.' }, 400);
  }
  const read = readProfileBody(body, kind);
  if (read.error) return json({ error: read.error }, 400);
  const vals = read.out;
  if (!vals.name) {
    return json({ error: kind === 'private_client' ? 'Name the client.'
      : kind === 'law_firm' ? 'Name the law firm.' : 'Name the carrier or organization.' }, 400);
  }

  const firstPhone = Array.isArray(body.phones) && body.phones.length ? body.phones[0].number : body.phone;
  if (!body.confirm_new) {
    const matches = await profileMatchesFor(env, {
      name: vals.name, email: vals.email, phone: firstPhone, address: vals.address });
    if (matches.length) {
      return json({ error: 'Possible existing profile.', code: 'possible_duplicate', matches }, 409);
    }
  }

  const now = nowIso();
  const res = await env.DB.prepare(
    `INSERT INTO profile (kind, name, name_norm, email, address, address_norm, billing_name,
       billing_email, payment_arrangement, notes, active, created_by, created_at, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
    .bind(kind, vals.name, normText(vals.name), vals.email || null, vals.address || null,
      normText(vals.address), vals.billing_name || null, vals.billing_email || null,
      vals.payment_arrangement || null, vals.notes || null, user.id, now, user.id, now).run();
  const id = res.meta.last_row_id;

  const phones = Array.isArray(body.phones) ? body.phones
    : (body.phone ? [{ number: body.phone, label: body.phone_label }] : []);
  await saveProfilePhones(env, id, null, phones);
  for (const c of Array.isArray(body.contacts) ? body.contacts : []) {
    await insertContact(env, id, c, user);
  }
  return json({ ok: true, profile: await profileDetail(env, id) }, 201);
}

/** One contact row plus its numbers. Shared by create-with-contacts and the
    add-a-contact route so a contact is written in exactly one place. */
async function insertContact(env, profileId, c, user) {
  if (!c || typeof c !== 'object') return null;
  const first = cleanProfileText(c.first_name), last = cleanProfileText(c.last_name);
  if (!first && !last) return null;
  const now = nowIso();
  const preferred = c.preferred ? 1 : 0;
  if (preferred) {
    /* One preferred per profile, and the index enforces it — this clears the
       old one so setting a new preferred is not a refusal. */
    await env.DB.prepare('UPDATE profile_contact SET preferred = 0 WHERE profile_id = ?')
      .bind(profileId).run();
  }
  const pos = await env.DB.prepare(
    'SELECT COALESCE(MAX(position), -1) + 1 AS n FROM profile_contact WHERE profile_id = ?')
    .bind(profileId).first();
  const res = await env.DB.prepare(
    `INSERT INTO profile_contact (profile_id, first_name, last_name, name_norm, role, email,
       preferred, active, position, notes, created_by, created_at, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
    .bind(profileId, first, last, normText(`${first || ''} ${last || ''}`),
      cleanProfileText(c.role), cleanProfileText(c.email), preferred,
      Number(pos && pos.n) || 0, cleanProfileText(c.notes), user.id, now, user.id, now).run();
  const id = res.meta.last_row_id;
  const phones = Array.isArray(c.phones) ? c.phones
    : (c.phone ? [{ number: c.phone, label: c.phone_label }] : []);
  await saveProfilePhones(env, profileId, id, phones);
  return id;
}

/* EDIT. The /meta write rules: an absent key means unchanged, a blank string
   clears, and the untouched columns are resolved INSIDE the UPDATE rather than
   read a moment earlier — two admins posting different subsets must not
   interleave into a silent loss. `kind` is never read. */
async function updateProfile(request, env, user, id) {
  if ((await profilesMissing(env)).length) return json({ error: NO_PROFILES, code: 'not_set_up' }, 503);
  const row = await env.DB.prepare('SELECT id, kind FROM profile WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);
  const body = await readJson(request);
  const read = readProfileBody(body, row.kind);
  if (read.error) return json({ error: read.error }, 400);
  const vals = read.out;
  if (body.name !== undefined && !vals.name) return json({ error: 'A profile needs a name.' }, 400);

  /* A RENAME IS A CREATE, FOR THIS PURPOSE. Without this, the one door the
     duplicate check does not guard is editing firm A's name into firm B's —
     which lands exactly where "never merge, never guess" is trying not to be,
     just by a different route. `exclude` keeps a profile from matching itself. */
  if (!body.confirm_new && (vals.name !== undefined || vals.email !== undefined
      || vals.address !== undefined || Array.isArray(body.phones))) {
    const firstPhone = Array.isArray(body.phones) && body.phones.length ? body.phones[0].number : null;
    const matches = await profileMatchesFor(env, {
      name: vals.name, email: vals.email, address: vals.address, phone: firstPhone, exclude: id });
    if (matches.length) {
      return json({ error: 'Possible existing profile.', code: 'possible_duplicate', matches }, 409);
    }
  }

  const sets = [], binds = [];
  for (const f of PROFILE_FIELDS) {
    if (vals[f] === undefined) continue;
    sets.push(`${f} = ?`); binds.push(vals[f]);
    /* The derived columns move with their source in the same statement. A
       normalised copy written by only two of three writers is the stale
       duplicate-of-a-boundary this project already refuses elsewhere. */
    if (f === 'name') { sets.push('name_norm = ?'); binds.push(normText(vals[f])); }
    if (f === 'address') { sets.push('address_norm = ?'); binds.push(normText(vals[f])); }
  }
  if (body.active !== undefined) { sets.push('active = ?'); binds.push(body.active ? 1 : 0); }
  if (Array.isArray(body.phones)) await saveProfilePhones(env, id, null, body.phones);
  if (sets.length) {
    await env.DB.prepare(
      `UPDATE profile SET ${sets.join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`)
      .bind(...binds, user.id, nowIso(), id).run();
  } else if (!Array.isArray(body.phones)) {
    return json({ error: 'Nothing to change.' }, 400);
  }
  return json({ ok: true, profile: await profileDetail(env, id) });
}

/* ADD A CONTACT. A likely duplicate WARNS and does not write; posting again
   with confirm_new writes it, because two people at a firm really can share a
   name and the owner said so explicitly. Nothing merges either way. */
async function addProfileContact(request, env, user, id) {
  if ((await profilesMissing(env)).length) return json({ error: NO_PROFILES, code: 'not_set_up' }, 503);
  const p = await env.DB.prepare('SELECT id FROM profile WHERE id = ?').bind(id).first();
  if (!p) return json({ error: 'not found' }, 404);
  const body = await readJson(request);
  const first = cleanProfileText(body.first_name), last = cleanProfileText(body.last_name);
  if (!first && !last) return json({ error: 'A contact needs a first or last name.' }, 400);

  if (!body.confirm_new) {
    const dupes = await contactDuplicates(env, id, body);
    if (dupes.length) {
      return json({ error: 'Possible duplicate contact.', code: 'possible_duplicate_contact',
        matches: dupes }, 409);
    }
  }
  const cid = await insertContact(env, id, body, user);
  return json({ ok: true, contact_id: cid, profile: await profileDetail(env, id) }, 201);
}

/** Obvious duplicates WITHIN one organisation: the same email, the same
    number, or the same name. Returns what matched and never acts on it. */
async function contactDuplicates(env, profileId, c, excludeId) {
  const ne = String(c.email || '').trim().toLowerCase();
  const nn = normText(`${c.first_name || ''} ${c.last_name || ''}`);
  const phone = Array.isArray(c.phones) && c.phones.length ? c.phones[0].number : c.phone;
  const nd = normDigits(phone);
  const { results } = await env.DB.prepare(
    `SELECT id, first_name, last_name, role, email, name_norm FROM profile_contact
      WHERE profile_id = ? AND active = 1`).bind(profileId).all();
  const out = [];
  for (const r of results || []) {
    if (excludeId && Number(r.id) === Number(excludeId)) continue;
    const why = [];
    if (ne && String(r.email || '').trim().toLowerCase() === ne) why.push('email');
    if (nn && r.name_norm === nn) why.push('name');
    if (why.length) out.push({ id: r.id, first_name: r.first_name, last_name: r.last_name,
      role: r.role, email: r.email, why });
  }
  if (nd.length >= 7 && out.length < 5) {
    const tail = nd.slice(-10);
    const { results: ph } = await env.DB.prepare(
      `SELECT DISTINCT c.id, c.first_name, c.last_name, c.role, c.email FROM profile_phone p
         JOIN profile_contact c ON c.id = p.contact_id
        WHERE p.profile_id = ? AND c.active = 1 AND p.digits LIKE '%' || ?`)
      .bind(profileId, tail).all();
    for (const r of ph || []) {
      if (excludeId && Number(r.id) === Number(excludeId)) continue;
      const seen = out.find(o => Number(o.id) === Number(r.id));
      if (seen) { if (!seen.why.includes('phone')) seen.why.push('phone'); }
      else out.push({ ...r, why: ['phone'] });
    }
  }
  return out;
}

async function updateProfileContact(request, env, user, id, cid) {
  if ((await profilesMissing(env)).length) return json({ error: NO_PROFILES, code: 'not_set_up' }, 503);
  const row = await env.DB.prepare(
    'SELECT * FROM profile_contact WHERE id = ? AND profile_id = ?').bind(cid, id).first();
  if (!row) return json({ error: 'not found' }, 404);
  const body = await readJson(request);
  const sets = [], binds = [];
  const named = k => body[k] !== undefined;
  if (named('first_name') || named('last_name')) {
    const first = named('first_name') ? cleanProfileText(body.first_name) : row.first_name;
    const last = named('last_name') ? cleanProfileText(body.last_name) : row.last_name;
    if (!first && !last) return json({ error: 'A contact needs a first or last name.' }, 400);
    sets.push('first_name = ?', 'last_name = ?', 'name_norm = ?');
    binds.push(first, last, normText(`${first || ''} ${last || ''}`));
  }
  for (const f of ['role', 'email', 'notes']) {
    if (named(f)) { sets.push(`${f} = ?`); binds.push(cleanProfileText(body[f])); }
  }
  if (named('active')) { sets.push('active = ?'); binds.push(body.active ? 1 : 0); }
  if (named('preferred')) {
    if (body.preferred) {
      await env.DB.prepare('UPDATE profile_contact SET preferred = 0 WHERE profile_id = ?').bind(id).run();
    }
    sets.push('preferred = ?'); binds.push(body.preferred ? 1 : 0);
  }
  if (Array.isArray(body.phones)) await saveProfilePhones(env, id, cid, body.phones);
  if (sets.length) {
    await env.DB.prepare(
      `UPDATE profile_contact SET ${sets.join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`)
      .bind(...binds, user.id, nowIso(), cid).run();
  } else if (!Array.isArray(body.phones)) {
    return json({ error: 'Nothing to change.' }, 400);
  }
  return json({ ok: true, profile: await profileDetail(env, id) });
}

/** Removing a CONTACT is always allowed: the cases that used them copied what
    mattered at intake, so nothing historical moves. Deactivating is offered
    beside it in the page as the gentler state. */
async function removeProfileContact(env, id, cid) {
  if ((await profilesMissing(env)).length) return json({ error: NO_PROFILES, code: 'not_set_up' }, 503);
  const row = await env.DB.prepare(
    'SELECT id FROM profile_contact WHERE id = ? AND profile_id = ?').bind(cid, id).first();
  if (!row) return json({ error: 'not found' }, 404);
  await env.DB.prepare('DELETE FROM profile_phone WHERE profile_id = ? AND contact_id = ?')
    .bind(id, cid).run();
  await env.DB.prepare('DELETE FROM profile_contact WHERE id = ?').bind(cid).run();
  return json({ ok: true, profile: await profileDetail(env, id) });
}

/* DELETE A PROFILE — and it REFUSES when any case has ever been linked to it,
   naming the count and pointing at Deactivate instead. That refusal is what
   makes "never cascades to cases" structural: the only profile that can be
   deleted is one no case has ever used, so there is nothing for a cascade to
   reach. Nothing about a case is touched on either path. */
async function deleteProfile(env, id) {
  if ((await profilesMissing(env)).length) return json({ error: NO_PROFILES, code: 'not_set_up' }, 503);
  const row = await env.DB.prepare('SELECT id, name FROM profile WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);
  /* COUNTED HONESTLY. The refusal protects EVERY link, including one on a case
     the office has since removed from the working set — but Recent matters
     excludes those, so a bare total said "on 1 case" while the profile showed
     none, with no route out. The sentence now names what the admin can see and
     says separately when a removed case is holding it. */
  const used = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM case_profile WHERE profile_id = ?').bind(id).first();
  const n = Number(used && used.n) || 0;
  if (n) {
    const missing = await missingTables(env);
    const hidden = missing.includes('case_deleted') ? { n: 0 } : await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM case_profile cp
        WHERE cp.profile_id = ? AND cp.case_no IN (SELECT case_no FROM case_deleted)`)
      .bind(id).first();
    const gone = Number(hidden && hidden.n) || 0;
    const shown = n - gone;
    return json({ error: `${row.name} is on ${shown} case${shown === 1 ? '' : 's'}`
      + (gone ? `, and ${gone} more that ${gone === 1 ? 'has' : 'have'} been removed from the `
        + 'working set' : '')
      + '. It is kept — set it to Inactive instead, which takes it out of the picker and the '
      + 'directory\'s Active view and leaves every one of those cases untouched.',
      code: 'profile_in_use', cases: n, visible_cases: shown, removed_cases: gone }, 409);
  }
  await env.DB.prepare('DELETE FROM profile_phone WHERE profile_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM profile_contact WHERE profile_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM profile WHERE id = ?').bind(id).run();
  return json({ ok: true, deleted: id });
}

/** Which profile a case was started from, for the admin workspace.

    IT DOES NOT GO LOOKING FOR A MATCH. The first version computed the possible
    match here, so every admin opening any unlinked case ran the whole
    duplicate check — four reads of the profile tables, on the most-opened
    screen in the portal, for a question nobody had asked. The comment claimed
    it was fine "because an admin is looking at that case and asked for it";
    they had not asked, and D7's own words are that a match is computed only
    when an admin is looking at THE QUESTION. The card now offers Look for a
    match, and that press is what runs it. */
async function caseProfileFor(env, caseNo) {
  if ((await profilesMissing(env)).length) return { not_set_up: true };
  const link = await env.DB.prepare('SELECT * FROM case_profile WHERE case_no = ?').bind(caseNo).first();
  if (!link) return { link: null };
  const p = await profileDetail(env, link.profile_id);
  /* The person is read from the LINK, not resolved through the live contact
     list: provenance is a snapshot like the rest of the case, so removing
     someone from the firm cannot blank a line on a case that did not change. */
  return { link, profile: p ? { id: p.id, kind: p.kind, kind_label: p.kind_label,
    name: p.name, email: p.email, address: p.address, active: !!p.active } : null,
    contact_name: link.contact_name || null };
}

/** The match for one case, when an admin presses for it. Same function the
    duplicate refusal uses, reading the case's OWN values. */
async function caseProfileMatch(env, caseNo) {
  if ((await profilesMissing(env)).length) return json({ matches: [], not_set_up: true });
  const sub = await env.DB.prepare(
    `SELECT case_no, kind, payload, client_name, client_email, client_phone, carrier
       FROM submissions WHERE case_no = ?`).bind(caseNo).first();
  if (!sub) return json({ error: 'not found' }, 404);
  let p = {}; try { p = JSON.parse(sub.payload || '{}'); } catch { p = {}; }
  const name = isLegalSub(sub) ? (p.firm_name || sub.client_name)
    : sub.kind === 'claims' ? (sub.carrier || sub.client_name) : sub.client_name;
  return json({ matches: await profileMatchesFor(env, {
    name, email: sub.client_email || p.firm_email, phone: sub.client_phone || p.firm_phone,
    address: p.firm_address || p.client_address }) });
}

/* LINKING A CASE TO A PROFILE, and it is the only writer of `case_profile`
   besides the create-from-profile path.

   It lives at /cases/:no/profile ON PURPOSE: the router's deleted/archived
   chokepoint matches any non-GET under /cases|submissions|leads/:no/, so this
   inherits that gate rather than needing a check of its own. A route named
   /profiles/:id/cases carrying the case number in its BODY would be invisible
   to it — which is exactly the trap caseSendRefusal() was written to close. */
async function linkCaseProfile(request, env, user, caseNo) {
  if ((await profilesMissing(env)).length) return json({ error: NO_PROFILES, code: 'not_set_up' }, 503);
  const sub = await env.DB.prepare('SELECT case_no, kind, payload, client_name, client_email, client_phone, carrier '
    + 'FROM submissions WHERE case_no = ?').bind(caseNo).first();
  if (!sub) return json({ error: 'not found' }, 404);
  const body = await readJson(request);

  if (body.clear) {
    await env.DB.prepare('DELETE FROM case_profile WHERE case_no = ?').bind(caseNo).run();
    return json({ ok: true, profile: await caseProfileFor(env, caseNo) });
  }

  /* SAVE AS PROFILE — the explicit action on a submission that matches
     nothing. It creates a NEW profile from the case's own values and links it;
     it never writes into an existing one, which is the owner's "do not
     silently overwrite saved contact information" as an absent code path. */
  if (body.save_as_profile) {
    let p = {}; try { p = JSON.parse(sub.payload || '{}'); } catch { p = {}; }
    const legal = isLegalSub(sub);
    const kind = legal ? 'law_firm' : sub.kind === 'claims' ? 'insurance_org' : 'private_client';
    const name = cleanProfileText(body.name) || cleanProfileText(
      legal ? (p.firm_name || p.attorney_name) : sub.kind === 'claims' ? (sub.carrier || sub.client_name)
        : sub.client_name);
    if (!name) return json({ error: 'This case has no firm, carrier or client name to save.' }, 400);
    const matches = body.confirm_new ? []
      : await profileMatchesFor(env, { name, email: sub.client_email, phone: sub.client_phone });
    if (matches.length) {
      return json({ error: 'Possible existing profile.', code: 'possible_duplicate', matches }, 409);
    }
    const now = nowIso();
    const res = await env.DB.prepare(
      `INSERT INTO profile (kind, name, name_norm, email, address, address_norm, billing_name,
         billing_email, payment_arrangement, notes, active, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?)`)
      .bind(kind, name, normText(name),
        cleanProfileText(legal ? (p.firm_email || sub.client_email) : sub.client_email),
        cleanProfileText(legal ? p.firm_address : p.client_address),
        normText(legal ? p.firm_address : p.client_address),
        cleanProfileText(legal ? p.billing_name : null),
        cleanProfileText(legal ? p.billing_email : null),
        legal && LEGAL_ARRANGEMENTS[p.payment_arrangement] ? p.payment_arrangement : null,
        user.id, now, user.id, now).run();
    const pid = res.meta.last_row_id;
    const mainPhone = legal ? (p.firm_phone || sub.client_phone) : sub.client_phone;
    if (mainPhone) await saveProfilePhones(env, pid, null, [{ number: mainPhone, label: 'work' }]);
    /* The people the case already names become contacts — the owner's
       "if the assignment already contains the information, reuse those
       entered values", so nobody retypes a firm they just filed. */
    if (legal) {
      for (const [prefix, role] of [['attorney', 'Attorney'], ['paralegal', 'Paralegal'],
        ['billing', 'Billing Contact']]) {
        const who = cleanProfileText(p[`${prefix}_name`]);
        if (!who) continue;
        const parts = who.split(/\s+/);
        await insertContact(env, pid, {
          first_name: parts.slice(0, -1).join(' ') || who,
          last_name: parts.length > 1 ? parts[parts.length - 1] : '',
          role, email: p[`${prefix}_email`], phone: p[`${prefix}_phone`], phone_label: 'work',
          preferred: prefix === 'attorney',
        }, user);
      }
    } else if (sub.kind === 'claims' && p.adjuster) {
      const parts = String(p.adjuster).trim().split(/\s+/);
      await insertContact(env, pid, {
        first_name: parts.slice(0, -1).join(' ') || p.adjuster,
        last_name: parts.length > 1 ? parts[parts.length - 1] : '',
        role: 'Adjuster', email: p.adjuster_email, phone: p.adjuster_phone, phone_label: 'work',
        preferred: true,
      }, user);
    }
    await writeCaseProfile(env, caseNo, pid, null, 'saved_from_case', user);
    return json({ ok: true, created: true, profile: await caseProfileFor(env, caseNo) }, 201);
  }

  const pid = Number(body.profile_id);
  if (!Number.isInteger(pid) || pid <= 0) return json({ error: 'Pick a profile.' }, 400);
  const p = await env.DB.prepare('SELECT id FROM profile WHERE id = ?').bind(pid).first();
  if (!p) return json({ error: 'That profile no longer exists.' }, 404);
  await writeCaseProfile(env, caseNo, pid, body.contact_id, 'linked', user);
  return json({ ok: true, profile: await caseProfileFor(env, caseNo) });
}

/* What a newly created assignment does about profiles, in one place so the
   three quick forms behave identically.

   Two separate things, and they are deliberately not the same thing:

   - `profile_id` came from the picker, so the link is recorded. The case's
     own values are already written and are never revisited.
   - `save_profile` is the "also keep this as a reusable profile" tick. It
     creates a profile ONLY on a clean miss. Where a possible match exists it
     creates NOTHING and says so, because a convenience tick must not be the
     one door that walks past the warning every deliberate door stops at —
     the office is pointed at Save as profile on the case, where Use existing
     is offered beside it.

   Never throws: a profile is a convenience and must not be able to lose an
   assignment that has already been written. */
async function profileOnCreate(env, caseNo, body, payload, kind, legal, user) {
  if ((await profilesMissing(env)).length) return {};
  try {
    const pid = Number(body.profile_id);
    if (Number.isInteger(pid) && pid > 0) {
      const p = await env.DB.prepare('SELECT id FROM profile WHERE id = ?').bind(pid).first();
      if (p) {
        await writeCaseProfile(env, caseNo, pid, body.profile_contact_id, 'prefill', user);
        return { profile_id: pid };
      }
      return {};
    }
    if (!body.save_profile) return {};
    const pkind = legal ? 'law_firm' : kind === 'claims' ? 'insurance_org' : 'private_client';
    const name = cleanProfileText(legal ? (payload.firm_name || payload.attorney_name)
      : kind === 'claims' ? (payload.carrier || payload.client_name) : payload.client_name);
    if (!name) return { profile_saved: false, profile_reason: 'no_name' };
    const matches = await profileMatchesFor(env, {
      name, email: payload.client_email, phone: payload.client_phone });
    if (matches.length) return { profile_saved: false, profile_reason: 'possible_duplicate', matches };
    const now = nowIso();
    const res = await env.DB.prepare(
      `INSERT INTO profile (kind, name, name_norm, email, address, address_norm, billing_name,
         billing_email, payment_arrangement, active, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
      .bind(pkind, name, normText(name),
        /* THE ORGANISATION'S OWN ADDRESS, never a person's. On a claims quick
           form the only contact fields are the adjuster's, and filing those as
           the CARRIER's main email and switchboard is how the next assignment
           from that carrier prefills somebody's direct line as the company
           number — with no contact row to choose from at all. A carrier's
           general address is left empty until someone types one. */
        cleanProfileText(legal ? (payload.firm_email || payload.client_email)
          : kind === 'claims' ? null : payload.client_email),
        cleanProfileText(legal ? payload.firm_address
          : kind === 'claims' ? null : payload.client_address),
        normText(legal ? payload.firm_address : kind === 'claims' ? null : payload.client_address),
        cleanProfileText(payload.billing_name), cleanProfileText(payload.billing_email),
        legal && LEGAL_ARRANGEMENTS[payload.payment_arrangement] ? payload.payment_arrangement : null,
        user.id, now, user.id, now).run();
    const newId = res.meta.last_row_id;
    const mainPhone = legal ? (payload.firm_phone || payload.client_phone)
      : kind === 'claims' ? payload.firm_phone : payload.client_phone;
    if (mainPhone) await saveProfilePhones(env, newId, null, [{ number: mainPhone, label: 'work' }]);
    /* The person the assignment names becomes a contact on the organisation —
       the same shape Save as profile builds from a case. */
    const asContact = (who, role, email, phone) => {
      const parts = String(who).trim().split(/\s+/);
      return { first_name: parts.slice(0, -1).join(' ') || who,
        last_name: parts.length > 1 ? parts[parts.length - 1] : '',
        role, email, phone, phone_label: 'work', preferred: true };
    };
    if (legal && payload.attorney_name) {
      await insertContact(env, newId, asContact(payload.attorney_name, 'Attorney',
        payload.attorney_email, payload.attorney_phone), user);
    } else if (kind === 'claims') {
      const who = payload.adjuster || payload.client_name;
      if (who) {
        await insertContact(env, newId, asContact(who, 'Adjuster',
          payload.adjuster_email || payload.client_email,
          payload.adjuster_phone || payload.client_phone), user);
      }
    }
    await writeCaseProfile(env, caseNo, newId, null, 'saved_from_case', user);
    return { profile_saved: true, profile_id: newId };
  } catch { return {}; }
}

/** The only statement that writes `case_profile`. One row per case, so
    re-associating replaces rather than accumulates, and the stamp is the
    "assignment started from profile" audit entry.

    The contact's NAME is copied in beside their id, because provenance is a
    snapshot: reading it back through the live contact list meant removing a
    person from the firm blanked a line on a case that had not changed. */
async function writeCaseProfile(env, caseNo, profileId, contactId, source, user) {
  const cid = Number(contactId);
  const id = Number.isInteger(cid) && cid > 0 ? cid : null;
  let name = null;
  if (id) {
    const c = await env.DB.prepare(
      'SELECT first_name, last_name FROM profile_contact WHERE id = ? AND profile_id = ?')
      .bind(id, profileId).first();
    if (c) name = [c.first_name, c.last_name].filter(Boolean).join(' ') || null;
  }
  await env.DB.prepare(
    `INSERT INTO case_profile (case_no, profile_id, contact_id, contact_name, source, linked_by, linked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(case_no) DO UPDATE SET profile_id = excluded.profile_id,
       contact_id = excluded.contact_id, contact_name = excluded.contact_name,
       source = excluded.source, linked_by = excluded.linked_by, linked_at = excluded.linked_at`)
    .bind(caseNo, profileId, id, name, source, user ? user.id : null, nowIso()).run();
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
  /* AN ABSENT FIELD MEANS UNCHANGED (Codex stop-time review, 2026-08-16).

     This route used to be replace-all: `num(undefined)` is null, so a caller
     that posted only a case type wrote NULL over `authorized_hours` and
     `authorized_budget` — and was told it succeeded. The Authorization form
     always posts all three, so nothing noticed until Edit Case began sending
     just the type, at which point saving a correction to a client's name would
     silently erase the hours a carrier had authorised.

     BLANK STILL CLEARS. An explicit empty string is the office saying "there is
     no figure", which is how the Authorization form clears one; only an ABSENT
     key is left alone. The two were the same thing before and are not now. */
  const has = k => Object.prototype.hasOwnProperty.call(body, k);

  /* WHICH FIELDS THIS REQUEST IS ABOUT. Everything else is resolved from the row
     INSIDE the UPDATE below — never from a value read a moment earlier.

     A read-then-write here loses a concurrent edit without a sound: two admins
     posting different subsets interleave as A reads, B reads, A writes, B
     writes, and B's write puts back the value A had just changed on a field B
     never mentioned. The retainer route already says this in its own words —
     "resolved inside the UPDATE so no other write can slip between a read and
     this statement" — and this is the same statement. */
  const givenHours = has('authorized_hours') ? 1 : 0;
  const givenBudget = has('authorized_budget') ? 1 : 0;
  const givenType = has('case_type_id') ? 1 : 0;

  const hours = givenHours ? num(body.authorized_hours) : null;
  const budget = givenBudget ? num(body.authorized_budget) : null;
  if (hours === undefined || budget === undefined) {
    return json({ error: 'Hours and budget must be numbers, or left blank.' }, 400);
  }
  let typeId = null;
  if (givenType
      && body.case_type_id !== null && body.case_type_id !== undefined
      && String(body.case_type_id) !== '') {
    typeId = parseInt(body.case_type_id, 10);
    if (!Number.isFinite(typeId)) return json({ error: 'invalid case type' }, 400);
    const t = await env.DB.prepare('SELECT 1 AS x FROM case_types WHERE id = ? AND active = 1').bind(typeId).first();
    if (!t) return json({ error: 'no such case type' }, 400);
  }

  /* ?7/?8/?9 say whether this request mentioned each field at all. A field it
     did not mention keeps whatever the ROW holds when this statement runs, so a
     concurrent edit to it survives; a field it did mention is written even when
     the value is NULL, because a blank is the office clearing it. That is the
     whole difference between "absent" and "empty", resolved atomically. */
  await env.DB.prepare(
    `INSERT INTO case_meta (case_no, case_type_id, authorized_hours, authorized_budget, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(case_no) DO UPDATE SET
       case_type_id      = CASE WHEN ?7 = 1 THEN ?2 ELSE case_meta.case_type_id END,
       authorized_hours  = CASE WHEN ?8 = 1 THEN ?3 ELSE case_meta.authorized_hours END,
       authorized_budget = CASE WHEN ?9 = 1 THEN ?4 ELSE case_meta.authorized_budget END,
       updated_by = ?5, updated_at = ?6`)
    .bind(caseNo, typeId, hours, budget, null, nowIso(),
          givenType, givenHours, givenBudget).run();

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
  /* THE READ ABOVE AND THIS WRITE ARE NOT ONE ACT (owner, 2026-09-03). Two
     taps on a flaky connection, or two devices, can both pass the check and
     arrive here — so `idx_days_open_one` refuses the second at the database,
     and this catch turns that refusal into the SAME answer the check gives:
     the 409 naming the day that is already running. The loser of a race and
     the second tap are the same event to the person holding the phone, so
     they read the same on screen; only a raw 500 would have been new. The
     re-read is what makes the answer true rather than assumed — it returns
     the id of the day that actually won. */
  let res;
  try {
    res = await env.DB.prepare(
      `INSERT INTO case_days (case_no, investigator_id, day_date, start_time, start_mileage, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`).bind(caseNo, user.id, date, time, miles, nowIso()).run();
  } catch (e) {
    if (!/UNIQUE|constraint/i.test(String(e))) throw e;
    const won = await env.DB.prepare(
      'SELECT id FROM case_days WHERE case_no = ? AND investigator_id = ? AND end_time IS NULL')
      .bind(caseNo, user.id).first();
    /* If the row is gone by now the day was ended between the collision and
       this read, and there is genuinely nothing running — say so plainly
       rather than pointing at an id that no longer exists. */
    return json(won
      ? { error: 'You already have a day running on this case.', day_id: won.id }
      : { error: 'That day could not be started — try again.' }, 409);
  }
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

/* Which running day this caller may act on — HIGH #2 (2026-08-14).
 *
 * Pause, resume and end used to require BOTH `caseFor()` and
 * `investigator_id = user.id`, which closed every door at once the moment a
 * case was reassigned with a day running: the original investigator now failed
 * `caseFor`, and the new investigator and the admin both failed the
 * investigator match. The day stayed open forever — permanently in Out Now,
 * `hours` never written — with no way to fix it inside the product at all.
 *
 * The rule that made that scoping right is kept: you can only stop your OWN
 * clock. Two doors are added around it.
 *
 *   - **Your own running day stays yours** whether or not the case still is.
 *     This is the owner's KEEP decision applied where it matters most: you
 *     started that clock and you are the one who knows when you stopped.
 *   - **An admin can close a day nobody else can reach.** A recovery path that
 *     does not exist is how a day ends up hand-edited in D1.
 *
 * A different investigator still cannot touch someone else's clock, and a
 * caller with no claim on the case at all gets the same 404 as before — so
 * nothing here reveals whether a day is running on a case they cannot see. */
const DAY_COLS = 'id, day_date, start_time, start_mileage, created_at, investigator_id';
async function openDayForAction(env, user, caseNo, { allowOthers = false, dayId = null } = {}) {
  /* THE EXPLICIT ROUTE RESOLVES ENTIRELY HERE, BEFORE the own-day shortcut
     below (Codex stop-time review, 2026-08-16).

     That shortcut answers "your own running day" and it used to run first for
     every caller. On `/day/end-other` that is exactly wrong: two admins out on
     one case is the situation this feature exists for, so the admin pressing
     "End Bea's session" HAS a day of their own — and the shortcut handed back
     that day and ended it. Reproduced: Trever pressed the button labelled "Bea
     Older", carrying Bea's `day_id`, and Trever's own clock stopped while Bea
     and Cal stayed out. A confirmed target that the resolver then ignores is
     worse than no target at all, because the screen said whose it was.

     So this branch never falls through to `own`. A named session is the one
     meant, whoever it belongs to — including the caller's own, if that is what
     they named. */
  if (allowOthers) {
    if (!(await caseFor(env, user, caseNo))) return { status: 404, error: 'not found' };
    if (user.role !== 'admin') return { status: 403, error: ADMIN_ONLY };
    if (dayId) {
      const one = await env.DB.prepare(
        `SELECT ${DAY_COLS} FROM case_days
          WHERE id = ? AND case_no = ? AND end_time IS NULL`).bind(dayId, caseNo).first();
      if (!one) {
        return { status: 409, error: 'That session is not running on this case any more — '
                                   + 'it may already have been ended. Reload and look again.' };
      }
      return { day: one };
    }
    /* No id: honoured only where there is exactly ONE session to mean. The
       caller's own counts towards that total — with two running, "whichever"
       is precisely the guess this exists to refuse. */
    const { results: openDays } = await env.DB.prepare(
      `SELECT ${DAY_COLS} FROM case_days
        WHERE case_no = ? AND end_time IS NULL ORDER BY id DESC`).bind(caseNo).all();
    if ((openDays || []).length > 1) {
      return { status: 409, ambiguous: true,
        error: `${openDays.length} sessions are running on this case. Say which one to end — `
             + 'ending "whichever" would stop the wrong person\'s clock.' };
    }
    if (openDays && openDays[0]) return { day: openDays[0] };
    return { status: 409, error: 'No investigation day is running on this case.' };
  }

  const own = await env.DB.prepare(
    `SELECT ${DAY_COLS} FROM case_days
      WHERE case_no = ? AND investigator_id = ? AND end_time IS NULL
      ORDER BY id DESC LIMIT 1`).bind(caseNo, user.id).first();
  if (own) return { day: own };

  // No day of their own here, so the ordinary case boundary applies.
  if (!(await caseFor(env, user, caseNo))) return { status: 404, error: 'not found' };

  /* TWO ADMINS MAY BE OUT ON THE SAME CASE AT ONCE (owner, WORKFLOW-SIMPLIFICATION
     §5: "never let one Admin silently stop or overwrite the other Admin's work").

     Reaching another admin's day used to be an UNCONDITIONAL fallback here,
     which made an ordinary End or Pause hit whatever day happened to be open:
     the desk's End button silently ended the field's day. That path now lives
     entirely in the `allowOthers` branch at the top — its own route, its own
     control, its own confirmation — and END, PAUSE AND RESUME NEVER SET IT, so
     from here down a caller can only ever touch their own session. */

  /* An admin pressing the ordinary control on someone else's running day is
     told whose it is and what the separate action is — refusing without saying
     why is how people go looking for a workaround. Only an admin is told, and
     only about a case they already passed `caseFor` for. */
  if (user.role === 'admin') {
    const other = await env.DB.prepare(
      `SELECT d.id, d.day_date, u.display_name AS investigator
         FROM case_days d LEFT JOIN users u ON u.id = d.investigator_id
        WHERE d.case_no = ? AND d.end_time IS NULL ORDER BY d.id DESC LIMIT 1`)
      .bind(caseNo).first();
    if (other) {
      return { status: 409, other_session: true,
        error: `${other.investigator || 'Another admin'} has a day running on this case, `
             + 'started ' + (other.day_date || 'earlier') + '. You can only end or pause your '
             + 'own session — use End their session if theirs needs closing.' };
    }
  }
  return { status: 409, error: 'No investigation day is running on this case.' };
}

async function pauseDay(request, env, user, caseNo) {
  const found = await openDayForAction(env, user, caseNo);
  if (!found.day) {
    /* Forward the flags the page acts on: whose session it is, and whether
       more than one is running. The page must not have to parse a sentence. */
    return json({ error: found.error,
      ...(found.other_session ? { other_session: true } : {}),
      ...(found.ambiguous ? { ambiguous: true } : {}) }, found.status);
  }
  const day = found.day;
  const state = await dayPauseState(env, day.id);
  if (state.paused_at) return json({ error: 'The day is already paused.' }, 409);
  const reason = String((await readJson(request)).reason || '').slice(0, 200) || null;
  await env.DB.prepare(
    'INSERT INTO case_day_pauses (day_id, started_at, reason, by_user) VALUES (?, ?, ?, ?)')
    .bind(day.id, nowIso(), reason, user.id).run();
  return json({ ok: true, day_id: day.id, ...(await dayPauseState(env, day.id)), server_now: nowIso() });
}

async function resumeDay(env, user, caseNo) {
  const found = await openDayForAction(env, user, caseNo);
  if (!found.day) {
    /* Forward the flags the page acts on: whose session it is, and whether
       more than one is running. The page must not have to parse a sentence. */
    return json({ error: found.error,
      ...(found.other_session ? { other_session: true } : {}),
      ...(found.ambiguous ? { ambiguous: true } : {}) }, found.status);
  }
  const day = found.day;
  const state = await dayPauseState(env, day.id);
  if (!state.paused_at) return json({ error: 'The day is not paused.' }, 409);
  await env.DB.prepare(
    'UPDATE case_day_pauses SET ended_at = ? WHERE day_id = ? AND ended_at IS NULL')
    .bind(nowIso(), day.id).run();
  return json({ ok: true, day_id: day.id, ...(await dayPauseState(env, day.id)), server_now: nowIso() });
}

async function endDay(request, env, user, caseNo, opts) {
  /* The body is read FIRST so the session being ended can be named in it.
     `day_id` is honoured ONLY on the explicit end-other route; the ordinary End
     never sets allowOthers, so it can never address anyone else's day. */
  const body = await readJson(request);
  const wantDay = opts && opts.allowOthers && /^\d{1,12}$/.test(String(body.day_id || ''))
    ? parseInt(body.day_id, 10) : null;
  const found = await openDayForAction(env, user, caseNo, { ...(opts || {}), dayId: wantDay });
  if (!found.day) {
    /* Forward the flags the page acts on: whose session it is, and whether
       more than one is running. The page must not have to parse a sentence. */
    return json({ error: found.error,
      ...(found.other_session ? { other_session: true } : {}),
      ...(found.ambiguous ? { ambiguous: true } : {}) }, found.status);
  }
  const day = found.day;

  const time = String(body.end_time || '');
  if (!TIME_RE.test(time)) return json({ error: 'An end time is needed.' }, 400);

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
     below is over complete spans and no break is left hanging open.

     It closes at the instant the DAY ended — never at `now`. This is the whole
     of HIGH #1 (2026-08-14): `span` is minutes on the investigator's TYPED
     clock, while a pause is a pair of SERVER instants, and closing an open
     pause at `now` subtracted one from the other. Break off at noon, file the
     day honestly at eight in the evening as having ended at 12:00, and a real
     four-hour day became `Math.max(0, 240 - 480)` — zero, floored so silently
     that the response still added up. `hours` is what authorization and
     invoices draw against, so that was billable time destroyed in place.

     `created_at` is the server instant the day was recorded — the same
     timestamp the field timer already derives from, precisely because a
     phone's clock cannot move it. The day therefore ended at
     `created_at + span`, and a break is clamped to close no earlier than it
     opened and no later than now. A break that began at or after the day's
     claimed end contributes nothing, which is the honest reading of it: they
     stopped working when the break began. */
  const openPause = await env.DB.prepare(
    'SELECT id, started_at FROM case_day_pauses WHERE day_id = ? AND ended_at IS NULL')
    .bind(day.id).first();
  if (openPause) {
    const startedMs = Date.parse(openPause.started_at);
    const dayEndMs = Date.parse(day.created_at) + span * 60000;
    const closeMs = Number.isFinite(startedMs) && Number.isFinite(dayEndMs)
      ? Math.max(startedMs, Math.min(dayEndMs, Date.now()))
      : Date.now();
    await env.DB.prepare('UPDATE case_day_pauses SET ended_at = ? WHERE id = ?')
      .bind(new Date(closeMs).toISOString(), openPause.id).run();
  }

  /* Breaks come off the billable total. An investigator who stopped for an
     hour did not work that hour, and `hours` is what authorization and
     invoices are drawn against — so it is the WORKED figure. The paused total
     is returned beside it rather than hidden, and the day-end review shows
     both. A duration is timezone-independent, so subtracting spans measured
     in UTC from a local-clock span is sound. */
  const paused = (await dayPauseState(env, day.id)).paused_ms;
  /* Clamped to the span rather than floored to zero afterwards. Breaks totalling
     more than the day they sit inside means the two clocks disagree, and the old
     `Math.max(0, …)` answered that by throwing the day away without saying so.
     Capping the subtraction keeps `worked` non-negative by construction AND
     keeps `paused_hours` equal to what was actually taken off, so the day-end
     screen can never name a break that did not come off the total. */
  const pausedMins = Math.min(Math.round(paused / 60000), span);
  const worked = span - pausedMins;
  const hours = Math.round((worked / 60) * 100) / 100;
  const pausedHours = Math.round((pausedMins / 60) * 100) / 100;
  const miles = endMiles != null && day.start_mileage != null
    ? Math.round((endMiles - day.start_mileage) * 10) / 10 : null;

  await env.DB.prepare(
    `UPDATE case_days SET end_time = ?, end_mileage = ?, hours = ?, miles = ?,
            summary = ?, ended_at = ? WHERE id = ?`)
    .bind(time, endMiles, hours, miles, String(body.summary || '').slice(0, 4000), nowIso(), day.id).run();

  /* WHO ENDED IT (owner, 2026-08-21, at closeout): "Never make it appear the
     original investigator ended it."

     The actor is the CALLER, which is the only honest source — `user` is the
     account that passed authorization to reach this line, and
     `day.investigator_id` is whose day it is. The two differing IS the case
     this record exists for, and the authorization that allows it is already
     upstream: only `/day/end-other` sets `allowOthers`, and that branch of
     `openDayForAction` requires `caseFor` AND the admin role before it will
     resolve anyone else's session. Nothing here re-decides who may end a day;
     it records who did.

     Written after the day is safely ended, and it NEVER fails the day-end —
     an investigator left holding a clock they cannot stop is the failure this
     portal already refuses. But it is not swallowed either: the response says
     `ended_by_recorded` with a reason, the Unit 11 rule, because the one thing
     forbidden here is a day that READS as self-ended when it was not, and a
     silently missing record is exactly that. Every read below treats an absent
     record as UNKNOWN and says so, never as "the investigator ended it".

     `ON CONFLICT DO NOTHING` keeps the FIRST actor. A day ends once — the
     resolver requires `end_time IS NULL` — so this cannot normally fire; if it
     ever did, the original presser is the truth. */
  let endedRecorded = false;
  let endedReason = null;
  if ((await missingTables(env)).includes('case_day_end')) {
    endedReason = 'not_set_up';
  } else {
    try {
      await env.DB.prepare(
        `INSERT INTO case_day_end (day_id, case_no, ended_by, ended_role, at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(day_id) DO NOTHING`)
        .bind(day.id, caseNo, user.id, user.role, nowIso()).run();
      endedRecorded = true;
    } catch { endedReason = 'error'; }
  }

  return json({ ok: true, day_id: day.id, hours, miles,
                paused_hours: pausedHours,
                span_hours: Math.round((span / 60) * 100) / 100,
                /* Observable rather than believed, like every send context and
                   integrity outcome in this Worker. */
                ended_by_recorded: endedRecorded,
                ...(endedRecorded ? {} : { ended_by_reason: endedReason }),
                ended_self: user.id === day.investigator_id,
                ended_by_label: dayEndLabel(
                  { ended_by: user.id, ended_role: user.role, ended_by_name: user.display_name },
                  day.investigator_id),
                authorization: await authorizationFor(env, caseNo, user.role === 'admin') });
}

/* THE ONE WRITER OF THIS WORDING. The office screen, the field screen, the
   timeline and the day-end response all read it from here — two renderings of
   one fact drift, and the one that drifts is the one nobody is looking at
   (the `paymentBlockText` rule).

   Three answers, and the third is the point of the whole record:
     - the day's own investigator ended it  -> '' , there is nothing to say
     - somebody else ended it               -> who, and whether they were Admin
     - no record                            -> said plainly as unknown, NEVER
       as though the investigator ended it. Every day ended before this table
       existed is in that third case, and stays readable. */
function dayEndLabel(rec, investigatorId) {
  if (!rec) return 'Ending actor not recorded';
  if (rec.ended_by === investigatorId) return '';
  const name = String(rec.ended_by_name || '').trim();
  if (rec.ended_role === 'admin') return name ? `Ended by Admin — ${name}` : 'Ended by Admin';
  return name ? `Ended by ${name}` : 'Ended by another authorized user';
}

/* The ending actor for one case's days. `null` — never an empty Map — when the
   table has not arrived, so a caller can tell "not set up" from "no day has
   one". One read per case, never per row. */
async function dayEndActors(env, caseNo, missing) {
  const m = missing || await missingTables(env);
  if (m.includes('case_day_end')) return null;
  const { results } = await env.DB.prepare(
    `SELECT e.day_id, e.ended_by, e.ended_role, e.at, u.display_name AS ended_by_name
       FROM case_day_end e LEFT JOIN users u ON u.id = e.ended_by
      WHERE e.case_no = ?`).bind(caseNo).all();
  const out = new Map();
  for (const r of results || []) out.set(r.day_id, r);
  return out;
}

/* ---- the activity log ---- */

const ACTIVITY_KINDS = ['activity', 'photo', 'video', 'location', 'vehicle', 'note', 'mileage', 'expense'];

async function addActivity(request, env, user, caseNo) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const body = await readJson(request);

  /* §8's OTHER HALF — the one the browser cannot do for itself. The loop
     already refuses a speech engine's repeated final result, but a POST that
     landed and whose response was lost looks exactly like one that never
     arrived, and only this side can tell them apart. The client names each
     utterance and keeps that name across every retry, so a second arrival
     returns the entry that already exists instead of writing another.

     CHECKED BEFORE ANYTHING IS WRITTEN, and it returns the ORIGINAL id, so a
     retrying client ends up pointing at the same row rather than believing it
     failed. */
  const eventId = /^[A-Za-z0-9_-]{8,64}$/.test(String(body.event_id || ''))
    ? String(body.event_id) : null;
  const hasEvents = eventId && !(await missingTables(env)).includes('activity_voice_event');
  if (hasEvents) {
    const seen = await env.DB.prepare(
      'SELECT entry_id FROM activity_voice_event WHERE event_id = ? AND case_no = ?')
      .bind(eventId, caseNo).first();
    if (seen) return json({ ok: true, id: seen.entry_id, duplicate: true }, 200);
  }
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

  /* HOW IT WAS CAPTURED (SURVEILLANCE-VOICE.md §3). A companion row, never a
     column on activity_log — the owner's instruction and the only idempotent
     option, since schema.sql is re-applied on every portal-setup run.

     THE ENTRY IS ALREADY WRITTEN by this point, and that ordering is the whole
     safety of it: the marker is a note about an activity that exists, so a
     database that has not had portal-setup run yet, or any failure recording
     it, costs the marker and never the investigator's entry. */
  /* Recorded AFTER the entry exists, and never allowed to fail it: the worst
     case is a retry writing a second entry, which is the situation before this
     table existed. The best case, and the ordinary one, is that it does not. */
  if (id && hasEvents) {
    try {
      await env.DB.prepare(
        `INSERT INTO activity_voice_event (event_id, entry_id, case_no, at)
         VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`)
        .bind(eventId, id, caseNo, nowIso()).run();
    } catch { /* an entry that exists beats a note about how it got here */ }
  }

  if (id && ACTIVITY_SOURCES.includes(String(body.source || ''))) {
    if (!(await missingTables(env)).includes('activity_source')) {
      try {
        await env.DB.prepare(
          `INSERT INTO activity_source (entry_id, source, command_id, heard, at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(entry_id) DO NOTHING`)
          .bind(id, String(body.source), String(body.command_id || '').slice(0, 64) || null,
                String(body.heard || '').slice(0, 2000) || null, nowIso()).run();
      } catch { /* an entry that exists beats a note about how it was made */ }
    }
  }

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

/* ================= CASE CONTENT REMOVAL (Unit 39) =================

   Owner: "Admin must have a quick, obvious way to remove incorrectly entered
   or no-longer-needed information from BOTH test cases AND REAL PRODUCTION
   CASES ... Today too much case/package information can only be edited and
   then sits permanently in the working case."

   ACTIVITY AND EVIDENCE ALREADY HAD A WAY OUT — `activity_removed` and
   `case_evidence.deleted_at`. Everything else did not, and the shape here is
   theirs: the record stays, a marker says it is out of the working case, and
   putting it back is one press. Nothing in this unit destroys a row.

   ONE TABLE KEYED BY (kind, ref_id) rather than seven companion tables. Seven
   would be seven guards to remember, seven DEMO_SWEEP lines and seven places
   for one rule to drift. The two that already exist keep their own shape,
   because rewriting them is a migration schema.sql cannot do idempotently.

   THE ALLOW-LIST IS HERE, NOT IN THE SCHEMA. `kind` carries no CHECK for the
   reason Unit 7 wrote down: a CHECK edited in place leaves a fresh database
   accepting a value the live one still refuses. So the Worker validates, and
   an eighth kind is an ordinary edit to this constant.

   AUTHORITY MIRRORS THE EXISTING EDIT RULE, which is the owner's own line —
   "investigators may only delete items they are already authorized to
   edit/remove under existing role rules". Each entry below says whose it is,
   and `contentTarget` resolves the row and the permission in one place so a
   new kind cannot arrive with the check forgotten. Where removal is
   consequential the entry is admin-only even though the EDIT is not: the
   owner's other line, "Admin-only for consequential deletion", is a ceiling
   the edit rule sits under, not a contradiction of it. */
const CONTENT_KINDS = ['day', 'day_summary', 'note', 'comm', 'expense',
                       'subject', 'vehicle', 'task', 'evidence'];

/* Every row is scoped to the case IN THE SAME STATEMENT — the Unit 11 rule, so
   a wrong-case id and an id that never existed answer identically and these
   routes cannot be used to probe another case's ids. `subject_vehicles` has no
   case_no of its own, so it is scoped through its subject. */
const CONTENT_SPEC = {
  day: {
    what: 'investigation day', admin: true,
    sql: 'SELECT id, day_date AS label, investigator_id, end_time FROM case_days WHERE id = ? AND case_no = ?',
  },
  day_summary: {
    what: 'daily summary',
    sql: 'SELECT day_id AS id, day_id FROM case_day_summary WHERE day_id = ? AND case_no = ?',
  },
  note: {
    what: 'note',
    sql: 'SELECT id, author_id, note_type AS label FROM case_notes WHERE id = ? AND case_no = ?',
  },
  comm: {
    what: 'comm log entry', admin: true,
    sql: 'SELECT id, person AS label FROM case_comms WHERE id = ? AND case_no = ?',
  },
  expense: {
    what: 'expense',
    sql: 'SELECT id, investigator_id, reviewed_at, description AS label FROM case_expenses WHERE id = ? AND case_no = ?',
  },
  subject: {
    what: 'subject', admin: true,
    sql: 'SELECT id, name AS label FROM case_subjects WHERE id = ? AND case_no = ?',
  },
  vehicle: {
    what: 'vehicle', admin: true,
    sql: `SELECT v.id, v.plate AS label FROM subject_vehicles v
            JOIN case_subjects s ON s.id = v.subject_id
           WHERE v.id = ? AND s.case_no = ?`,
  },
  task: {
    what: 'task', admin: true,
    sql: 'SELECT id, task AS label FROM case_tasks WHERE id = ? AND case_no = ?',
  },
  /* Evidence is here for the TRAIL and for the storage meter's preserve
     marker; its removed/restored STATE stays in its own columns, where every
     existing reader already looks. Two answers to "is this deleted?" would be
     one answer too many. */
  evidence: {
    what: 'file', admin: true,
    sql: 'SELECT id, filename AS label FROM case_evidence WHERE id = ? AND case_no = ?',
  },
};

/* The removed set for a case, as `kind:ref_id` strings. One read, one Set —
   `.has`, never `.includes`, the mistake Unit 22 already paid for. Degrades to
   an EMPTY set when the table has not arrived, because portal-setup is a
   manual dispatch and a case list that 500s is worse than one that shows a row
   somebody meant to remove. */
async function contentRemovedSet(env, caseNo, missingKnown) {
  /* `missingKnown` is the caller's already-hoisted schema check. `caseWorkspace`
     does one `sqlite_master` scan for the whole screen and says so in its own
     comment — this took a second one until it was given the answer. The Unit 7
     lesson, on the most-opened screen in the portal. */
  const missing = missingKnown || await missingTables(env);
  if (missing.includes('case_content_removed')) return new Set();
  const { results } = await env.DB.prepare(
    'SELECT kind, ref_id FROM case_content_removed WHERE case_no = ?').bind(caseNo).all();
  return new Set((results || []).map(r => `${r.kind}:${r.ref_id}`));
}

/* Written best-effort: a failed trail row can never change what the caller is
   told, and never turns a completed removal into an error. The
   `storage_failure` and `retention_event` rule. */
async function logContentEvent(env, caseNo, kind, refId, action, actor, reason) {
  try {
    await env.DB.prepare(
      `INSERT INTO case_content_event (kind, ref_id, case_no, action, reason, actor, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(kind, refId, caseNo, action, reason || null, actor, nowIso()).run();
    return true;
  } catch { return false; }
}

/* Resolve the row, the permission and the wording in ONE place. Returns either
   `{ row, spec }` or a Response to hand straight back. */
async function contentTarget(env, user, caseNo, kind, refId) {
  const spec = CONTENT_SPEC[kind];
  if (!spec) return { res: json({ error: 'Not something this portal removes.' }, 400) };
  if (!(await caseFor(env, user, caseNo))) return { res: json({ error: 'not found' }, 404) };

  const missing = await missingTables(env);
  if (missing.includes('case_content_removed') || missing.includes('case_content_event')) {
    return { res: json({ error: 'Removal is not set up on this database yet — run the '
      + 'portal-setup workflow.', code: 'not_set_up' }, 503) };
  }

  const row = await env.DB.prepare(spec.sql).bind(refId, caseNo).first();
  if (!row) return { res: json({ error: 'not found' }, 404) };

  const admin = user.role === 'admin';
  if (spec.admin && !admin) return { res: json({ error: ADMIN_ONLY }, 403) };

  /* The two that are not admin-only are the two whose EDIT rule is already
     "yours, or the office's". Said here rather than at each call site so a new
     kind cannot arrive with the check in only one of the two directions. */
  if (!admin) {
    if (kind === 'note' && row.author_id !== user.id) {
      return { res: json({ error: 'That note is somebody else’s.' }, 403) };
    }
    if (kind === 'expense') {
      if (row.investigator_id !== user.id) {
        return { res: json({ error: 'That expense belongs to another investigator.' }, 403) };
      }
      /* REVIEWED MONEY IS THE OFFICE'S. The owner's limit is "no
         billing/history destruction"; once the office has reviewed a claim,
         withdrawing it is their decision, not the claimant's. */
      if (row.reviewed_at) {
        return { res: json({ error: 'The office has already reviewed that expense — ask them to remove it.' }, 403) };
      }
    }
    if (kind === 'day_summary') {
      /* saveDaySummary's own rule, inherited rather than restated: the day's
         investigator holds the pen until the report is with the office. */
      const day = await env.DB.prepare(
        'SELECT investigator_id FROM case_days WHERE id = ? AND case_no = ?').bind(refId, caseNo).first();
      if (!day || day.investigator_id !== user.id) {
        return { res: json({ error: 'That day belongs to another investigator.' }, 403) };
      }
      const rep = await env.DB.prepare(
        'SELECT status FROM case_reports WHERE day_id = ? AND case_no = ?').bind(refId, caseNo).first();
      if (rep && !['draft', 'needs_revision'].includes(rep.status)) {
        return { res: json({ error: 'That day’s report is with the office — they can remove the summary.' }, 409) };
      }
    }
  }
  return { row, spec };
}

/* The one writer of the marker, and the one writer of the trail beside it. */
async function markContentRemoved(env, user, caseNo, kind, refId, reason) {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO case_content_removed (kind, ref_id, case_no, removed_by, removed_at, reason)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(kind, ref_id) DO UPDATE SET removed_by = ?4, removed_at = ?5, reason = ?6`)
    .bind(kind, refId, caseNo, user.id, now, reason || null).run();
  const logged = await logContentEvent(env, caseNo, kind, refId, 'removed', user.id, reason);
  return { at: now, logged };
}

async function clearContentRemoved(env, user, caseNo, kind, refId, reason) {
  await env.DB.prepare('DELETE FROM case_content_removed WHERE kind = ? AND ref_id = ?')
    .bind(kind, refId).run();
  const logged = await logContentEvent(env, caseNo, kind, refId, 'restored', user.id, reason);
  return { logged };
}

/* WHAT REMOVING THIS WOULD MEAN, before anybody presses anything.

   The owner asked for the day's confirmation to name the date and day number,
   the entry count, the evidence count, whether a summary exists and whether
   the day is already in a report or package. Those are FACTS READ FROM THE
   RECORD, never a prediction: the same discipline as Unit 15's closeout, where
   the panel states what the tables can see and the person still decides.

   It is one route for every kind, because a confirmation that names the wrong
   thing is the failure mode here and one writer of the wording cannot. */
async function contentPreflight(env, user, caseNo, kind, refId) {
  const t = await contentTarget(env, user, caseNo, kind, refId);
  if (t.res) return t.res;
  const out = { kind, id: refId, what: t.spec.what, label: t.row.label || null,
                removed: false, facts: [], blocks: [] };

  const rm = await env.DB.prepare(
    'SELECT removed_at FROM case_content_removed WHERE kind = ? AND ref_id = ?')
    .bind(kind, refId).first();
  out.removed = Boolean(rm);

  const hold = await activeHold(env, caseNo);
  if (hold) out.blocks.push('This case is under a legal hold — nothing can be removed until it is released.');

  if (kind === 'day') {
    const day = await env.DB.prepare(
      'SELECT id, day_date, end_time FROM case_days WHERE id = ? AND case_no = ?').bind(refId, caseNo).first();
    /* THE CASE'S OWN DAY NUMBER, not a position in a scoped list — Unit 25's
       rule. Counted by date order across the whole case. */
    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM case_days
        WHERE case_no = ? AND (day_date < ? OR (day_date = ? AND id <= ?))`)
      .bind(caseNo, day.day_date, day.day_date, refId).first();
    out.day_no = Number(n && n.n) || 1;
    out.day_date = day.day_date;
    out.running = !day.end_time;
    if (out.running) {
      out.blocks.push('This day is still running. End it first — an investigator '
        + 'with a clock nobody can see is exactly what removing it would create.');
    }

    const ent = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM activity_log a
        WHERE a.day_id = ? AND a.case_no = ?
          AND NOT EXISTS (SELECT 1 FROM activity_removed r WHERE r.entry_id = a.id)`)
      .bind(refId, caseNo).first();
    const ev = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM case_evidence e
         JOIN activity_log a ON a.id = e.entry_id
        WHERE a.day_id = ? AND e.case_no = ? AND e.deleted_at IS NULL`)
      .bind(refId, caseNo).first();
    const sum = await env.DB.prepare(
      'SELECT day_id FROM case_day_summary WHERE day_id = ? AND case_no = ?').bind(refId, caseNo).first();
    const rep = await env.DB.prepare(
      'SELECT id, status FROM case_reports WHERE day_id = ? AND case_no = ?').bind(refId, caseNo).first();
    let inPkg = null;
    if (rep) {
      inPkg = await env.DB.prepare(
        `SELECT b.id, b.status FROM build_reports br
           JOIN case_builds b ON b.id = br.build_id
          WHERE br.report_id = ? ORDER BY b.id DESC LIMIT 1`).bind(rep.id).first();
    }
    out.entries = Number(ent && ent.n) || 0;
    out.evidence = Number(ev && ev.n) || 0;
    out.has_summary = Boolean(sum);
    out.report = rep ? { id: rep.id, status: rep.status } : null;
    out.in_package = inPkg ? { id: inPkg.id, status: inPkg.status } : null;

    out.facts.push(`Day ${out.day_no} — ${day.day_date}`);
    out.facts.push(out.entries === 1 ? '1 activity entry' : `${out.entries} activity entries`);
    /* THE EVIDENCE COUNT IS SAID WITH WHAT HAPPENS TO IT. The owner's line is
       "Do not silently destroy child evidence", and the honest half of that is
       saying out loud that it is not being touched. */
    out.facts.push(out.evidence === 0
      ? 'No photographs or files are attached to this day'
      : `${out.evidence} file${out.evidence === 1 ? '' : 's'} attached — ${
          out.evidence === 1 ? 'it stays' : 'they stay'} in Case media, untouched`);
    out.facts.push(out.has_summary ? 'A daily summary is written for this day'
                                   : 'No daily summary has been written');
    if (out.in_package) {
      out.facts.push(`This day is in package #${out.in_package.id}${
        out.in_package.status === 'final' ? ', which is finalized' : ''} — the package will be marked as needing a rebuild`);
    } else if (out.report) {
      out.facts.push(`A report exists for this day (${out.report.status})`);
    }
  }

  if (kind === 'day_summary') {
    const ent = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM activity_log a
        WHERE a.day_id = ? AND a.case_no = ?
          AND NOT EXISTS (SELECT 1 FROM activity_removed r WHERE r.entry_id = a.id)`)
      .bind(refId, caseNo).first();
    out.entries = Number(ent && ent.n) || 0;
    /* THE DISTINCTION THE OWNER ASKED FOR, IN WORDS, on the screen where it
       matters: "Delete Summary != Delete Day Activity." */
    out.facts.push('Only the written paragraph is removed');
    out.facts.push(out.entries === 1
      ? 'The 1 activity entry on this day is not touched'
      : `The ${out.entries} activity entries on this day are not touched`);
  }

  if (kind === 'evidence') {
    const e = await env.DB.prepare(
      'SELECT filename, r2_key, deleted_at FROM case_evidence WHERE id = ? AND case_no = ?')
      .bind(refId, caseNo).first();
    out.removed = Boolean(e && e.deleted_at);
    out.facts.push('The file itself is not deleted — it stays where it is stored');
    out.facts.push('It leaves Case media, the File Queue and every package count');
    const inPkg = await env.DB.prepare(
      `SELECT b.id, b.status FROM build_items i JOIN case_builds b ON b.id = i.build_id
        WHERE i.evidence_id = ? ORDER BY b.id DESC LIMIT 1`).bind(refId).first();
    if (inPkg) {
      out.in_package = { id: inPkg.id, status: inPkg.status };
      out.facts.push(`It is in package #${inPkg.id} — that package will be marked as needing a rebuild`);
    }
  }

  out.recoverable = true;
  return json(out);
}

async function removeContent(request, env, user, caseNo, kind, refId) {
  const t = await contentTarget(env, user, caseNo, kind, refId);
  if (t.res) return t.res;

  /* THE HOLD OUTRANKS. Unit 17's decision 5 named evidence removal by name;
     this unit is that same act applied to eight more record types, so the
     refusal follows it rather than stopping at the one route that existed when
     the decision was written. Restores are deliberately NOT refused — putting
     something back is not what a hold guards against. */
  const hold = await activeHold(env, caseNo);
  if (hold) {
    return json({ error: 'This case is under a legal hold — nothing can be removed until '
      + 'the hold is released.', code: 'legal_hold' }, 409);
  }

  const body = await readJson(request).catch(() => ({}));
  const reason = String((body && body.reason) || '').trim().slice(0, 500) || null;

  if (kind === 'day' && !t.row.end_time) {
    return json({ error: 'That day is still running — end it first.', code: 'day_running' }, 409);
  }

  /* EVIDENCE KEEPS ITS STATE WHERE IT ALWAYS WAS. Every existing reader — the
     workspace, the gallery, the meter, the package gate, the File Queue —
     already looks at `deleted_at`, so a second answer to the same question
     would be one too many. What this adds is the trail and the preserve
     marker. */
  if (kind === 'evidence') return deleteEvidence(env, user, caseNo, refId, reason);

  const { at, logged } = await markContentRemoved(env, user, caseNo, kind, refId, reason);
  return json({ ok: true, kind, id: refId, removed_at: at,
                what: t.spec.what, audit_recorded: logged,
                ...(logged ? {} : { audit_reason: 'trail write failed' }) });
}

async function restoreContentRoute(request, env, user, caseNo, kind, refId) {
  const t = await contentTarget(env, user, caseNo, kind, refId);
  if (t.res) return t.res;
  const body = await readJson(request).catch(() => ({}));
  const reason = String((body && body.reason) || '').trim().slice(0, 500) || null;
  if (kind === 'evidence') return restoreEvidence(env, user, caseNo, refId, reason);
  const { logged } = await clearContentRemoved(env, user, caseNo, kind, refId, reason);
  return json({ ok: true, kind, id: refId, what: t.spec.what, audit_recorded: logged });
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

  /* AN ABSENT FIELD MEANS UNCHANGED — the rule `/cases/:no/meta` already
     states in its own words, and for the same reason. This was replace-all,
     and nothing noticed while the timeline's Edit form was the only caller,
     because it always posts all four. The moment a screen corrects just the
     wording — §10's Last activity, which fixes a typo without leaving the
     field — a caller posting only a description would write NULL over the
     location and the vehicle the investigator recorded, and be told it
     succeeded.

     A BLANK STRING STILL CLEARS: that is the operator saying there is no
     location, and it is how the full form removes one. Only an absent key is
     left alone.

     And it is resolved INSIDE the UPDATE, from the row, never from a value
     read a moment earlier — two people correcting different fields of the same
     entry interleave as A reads, B reads, A writes, B writes, and a
     read-then-write loses one of them without a sound. */
  const has = (k) => body != null && Object.prototype.hasOwnProperty.call(body, k);
  await env.DB.prepare(
    `UPDATE activity_log SET description = ?1,
            location      = CASE WHEN ?2 = 1 THEN ?3 ELSE location END,
            vehicle       = CASE WHEN ?4 = 1 THEN ?5 ELSE vehicle END,
            internal_note = CASE WHEN ?6 = 1 THEN ?7 ELSE internal_note END,
            edited_at = ?8, edited_by = ?9 WHERE id = ?10`)
    .bind(description,
          has('location') ? 1 : 0, String(body.location || '').slice(0, 300) || null,
          has('vehicle') ? 1 : 0, String(body.vehicle || '').slice(0, 300) || null,
          has('internal_note') ? 1 : 0, String(body.internal_note || '').slice(0, 2000) || null,
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
  /* REVIEWED MONEY IS THE OFFICE'S — the rule `contentTarget` already applies
     to REMOVING an expense, applied here to EDITING one (closeout audit,
     2026-09-03). Without it an investigator could rewrite the figure on an
     expense the office had already reviewed, and the UPDATE clears
     reviewed_at/reviewed_by, so who reviewed it went with it. */
  if (!admin && row.reviewed_at) {
    return json({ error: 'The office has already reviewed that expense — ask them to change it.' }, 403);
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
  /* "Important" is the priority the office already sets: high or urgent. A
     normal task is work, not news, and alerting on every one is how an alert
     stops being read. */
  if (priority === 'high' || priority === 'urgent') await notifyAdmins(env, 'tasks', caseNo);
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
  /* MAIL-CHECK.md — the check remittance address. EMPTY ON PURPOSE: no
     mailing address exists anywhere in this configuration and nothing here
     may invent one. The owner supplies it in Settings -> Billing; until then
     the rate sheets say "mailing instructions provided with invoice" and the
     invoices print no remittance section. Never seeded, never derived. */
  remit_address: '',
  /* BILLCOM.md — PREPARED, NOT CONNECTED (owner, 2026-09-02). All four start
     EMPTY and none is a secret: the enable word, the payment link Bill.com
     will supply, an account reference, and the environment name. Until the
     owner types real values, `billcomConfig` answers not-ready and nothing
     anywhere offers, prints or sends Bill.com. NO credential lives here or in
     any table — if a full API integration is ever wanted, its secrets go in
     Worker env vars (the RESEND_API_KEY pattern) and are read inside the
     adapter and nowhere else. */
  billcom_enabled: '',
  billcom_payment_url: '',
  billcom_org_id: '',
  billcom_environment: '',
  /* LEGAL-SERVICES.md D14 (owner, 2026-09-02) — the DEFAULT Process Service
     flat fee. Empty means the standard LEGAL_FLAT figure; a typed positive
     amount overrides it for everything that has no case-specific figure of
     its own. Historical cases are safe from a change here because acceptance
     SNAPSHOTS the fee in force onto the case (snapshotFixedFee) and a stored
     figure always wins. */
  process_fee_default: '',
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

/* A VOIDED PAYMENT IS STILL A RECORD AND STOPS BEING MONEY (Unit 18). The
   row is never deleted — `paidRows` is what every figure counts, and the full
   list still travels so the office can see what was voided and by whom. One
   place decides it, so no later reader can forget.

   `overpaid` is derived rather than stored, like every other figure here: a
   negative balance is a CREDIT, and calling it "Balance due -$500" on a
   client's own invoice is the document contradicting itself. */
const paidRows = payments => (payments || []).filter(pm => !pm.voided_at);

function invoiceMoney(lines, adjustments, payments) {
  const subtotal = Math.round((lines || []).reduce((t, l) => t + Number(l.amount || 0), 0) * 100) / 100;
  const total = Math.round((subtotal + Number(adjustments || 0)) * 100) / 100;
  const paid = Math.round(paidRows(payments).reduce((t, pm) => t + Number(pm.amount || 0), 0) * 100) / 100;
  const balance = Math.round((total - paid) * 100) / 100;
  return { subtotal, total, amount_paid: paid, balance_due: balance,
           /* Both are stated so no reader has to work it out from a sign. */
           overpaid: balance < 0, credit_due: balance < 0 ? Math.abs(balance) : 0 };
}

/* Overdue is a fact about today, computed on read — never stored where it
   could go stale. Void never reads as overdue. */
function invoiceDisplayStatus(inv, money) {
  if (inv.status === 'void') return 'void';
  if (money.balance_due <= 0 && money.total > 0 && money.amount_paid > 0) return 'paid';
  if (money.amount_paid > 0 && money.balance_due > 0) return 'partially_paid';
  /* A PAID STATUS OUTLIVING ITS MONEY (Unit 18). Void the only payment on a
     paid invoice and the column still says `paid`, which the fall-through at
     the bottom would repeat to the office and the client. Money is arithmetic
     here, so with nothing received neither payment status is true and the
     stored one is not echoed. The void route puts the column back to the
     status the invoice actually held before the payment moved it, read from
     its own event trail; this is the guard for a row that never got there. */
  if (money.amount_paid <= 0 && (inv.status === 'paid' || inv.status === 'partially_paid')) {
    if (inv.due_date && inv.due_date < nowIso().slice(0, 10) && money.balance_due > 0) return 'overdue';
    return 'ready';
  }
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
async function retainerBlock(env, inv, sub) {
  if (inv.invoice_type !== 'private') return null;
  /* LEGAL-SERVICES.md D7 — the caller already read the case's submission row
     for the send-context/remittance decision, so the pricing model costs no
     extra query. A FIXED legal case's document must not print the retainer
     drawdown: its fee defaults from the catalogue, and the hourly-model
     figures are null — the page prints a one-line flat-fee statement off
     `model` instead of the deposit table. */
  const legalPricing = legalPricingFor(sub);
  const fixed = !!(legalPricing && legalPricing.model === 'fixed');
  const ret = await env.DB.prepare(
    'SELECT retainer_amount, received FROM case_retainer WHERE case_no = ?').bind(inv.case_no).first();
  const amount = ret && ret.retainer_amount != null ? Number(ret.retainer_amount)
    : fixed ? await legalFlatDefault(env, legalPricing.service) : PERSONAL.retainer;
  /* A DRAFT INVOICE IS NOT EARNED MONEY (owner decision, 2026-08-21): "UNSENT
     or DRAFT invoices MUST NOT reduce the client-facing retainer balance. Only
     finalized/issued billable work may affect the client-facing retainer
     figure."

     This filtered only `status != 'void'`, so a draft nobody had issued drew
     the retainer down on the client's own document — while `outstanding`
     excluded that same draft from what the client owed. One document, two
     answers about one invoice.

     AND `ready` IS UNSENT TOO (owner, 2026-08-21, closing the question this
     unit left open): "Ready/Reviewed but not yet sent still counts as UNSENT
     and must NOT reduce the client-facing retainer." Ready means reviewed and
     waiting to go out — the client has not been shown it, so it has not
     consumed their deposit. `UNSENT_STATUSES` is the one place that list
     lives, so the rule cannot be half-applied by a later reader.

     Note this deliberately does NOT match `outstanding`, which excludes only
     drafts: a ready invoice IS a receivable the office is owed, and is not
     yet money the client has been told about. The two answer different
     questions and are allowed to differ — what is forbidden is one DOCUMENT
     giving two answers about the same invoice. */
  const { results: sib } = await env.DB.prepare(
    `SELECT i.id, i.adjustments FROM invoices i
      WHERE i.case_no = ? AND i.status NOT IN ('void', 'draft', 'ready')`)
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
    model: fixed ? 'fixed' : 'retainer',
    service_label: fixed ? legalPricing.service_label : undefined,
    received: !!(ret && ret.received),
    applied: fixed ? null : applied,
    balance: fixed ? null : Math.round((amount - applied) * 100) / 100,
    // Only "additional" when it is genuinely above the retainer.
    additional_authorized: !fixed && budget != null && budget > amount
      ? Math.round((budget - amount) * 100) / 100 : null,
  };
}

async function invoiceWithMoney(env, inv) {
  const { results: lines } = await env.DB.prepare(
    'SELECT id, sort, description, qty, rate, amount FROM invoice_lines WHERE invoice_id = ? ORDER BY sort, id')
    .bind(inv.id).all();
  /* The void marker rides with the payment, so `paidRows` can do its job and
     the page can strike the row through in the same pass. Guarded: the table
     arrives by a manual portal-setup dispatch while the Worker deploys on
     push, and a join against a missing table would take out every invoice
     read — the `case_archive` lesson. Without it, nothing is voided yet, which
     is exactly the truth on a database that has not run setup. */
  const hasVoid = !(await missingTables(env)).includes('invoice_payment_void');
  const { results: payments } = await env.DB.prepare(
    `SELECT p.id, p.amount, p.paid_date, p.method, p.reference, p.provider,
            p.external_payment_id, p.notes, p.recorded_at, u.display_name AS recorded_by
            ${hasVoid ? `, v.voided_at, v.reason AS void_reason, vu.display_name AS voided_by` : ''}
       FROM invoice_payments p LEFT JOIN users u ON u.id = p.recorded_by
       ${hasVoid ? `LEFT JOIN invoice_payment_void v ON v.payment_id = p.id
                    LEFT JOIN users vu ON vu.id = v.voided_by` : ''}
      WHERE p.invoice_id = ? ORDER BY p.paid_date, p.id`).bind(inv.id).all();
  const money = invoiceMoney(lines, inv.adjustments, payments);
  let refs = {};
  try { refs = JSON.parse(inv.refs_json || '{}'); } catch { refs = {}; }
  /* MAIL-CHECK.md — which business this invoice belongs to, and whether a
     check remittance section may print on its document. DECIDED HERE, in the
     Worker, from the case's own typed kind and legal marker: the page prints
     `remit_address` when it arrives and composes nothing itself. A PRIVATE
     invoice never carries the field at all — absent, not empty — and neither
     does anything else until the owner has typed a real address into
     Settings -> Billing. Nothing is invented. */
  const invSub = await env.DB.prepare(
    'SELECT kind, payload FROM submissions WHERE case_no = ?').bind(inv.case_no).first();
  const invCtx = invSub ? contextForSub(invSub) : null;
  let remit, billcomUrl;
  if (invCtx === SEND_CONTEXT.LEGAL || invCtx === SEND_CONTEXT.INSURANCE) {
    const cfg = await billingSettings(env);
    const addr = String(cfg.remit_address || '').trim();
    if (addr) remit = addr;
    /* BILLCOM.md — the invoice offers the Bill.com link only when the adapter
       is genuinely ready. Nothing is invented: the URL is the one the owner
       typed, or the field is ABSENT — never a placeholder. Private invoices
       never carry it, the remit_address rule again. */
    const billcom = billcomConfig(cfg);
    if (billcom.ready) billcomUrl = billcom.payment_url;
  }
  return { ...inv, refs_json: undefined, refs, lines: lines || [], payments: payments || [],
           send_context: invCtx || undefined, remit_address: remit, billcom_url: billcomUrl,
           ...money, retainer: await retainerBlock(env, inv, invSub),
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
    /* VOID MEANS VOID, ON BOTH HALVES (Unit 18). This reduced over `full`,
       so a paid invoice that was later voided went on reporting its cash as
       money taken this month — `live` was defined one line above and used by
       every other figure here. A voided PAYMENT stops counting too, through
       the same `voided_at` marker the balance uses. */
    paid_this_month: Math.round(live.reduce((t, i) => t + i.payments
      .filter(pm => !pm.voided_at && String(pm.paid_date || '').slice(0, 7) === month)
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

  /* Money that has been received is not a draft any more — HIGH #3
     (2026-08-14). `sent_to_bill` and `sent_to_client` were guarded and `ready`
     validated only the CONTENT, but `draft` was guarded by nothing, so an
     invoice with real payments against it could be walked backwards. Two
     things followed. The edit lock is `!['draft','ready'].includes(status)`,
     so lines and adjustments became rewritable underneath money already taken;
     and `outstanding`, `drafts` and the dashboard all sum on the STORED
     status, so a part-paid invoice dropped out of the receivable while
     `balance_due` went on honestly saying it was owed. Money the office is
     owed stopped being visible, which is the one thing an invoice list exists
     to prevent.

     Both unlocking statuses are refused once anything is recorded. The way back
     from a paid invoice is Void, which is deliberate, kept in the record, and
     already releases the retainer it consumed. */
  if (status === 'draft' || status === 'ready') {
    const paid = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM invoice_payments WHERE invoice_id = ?').bind(id).first();
    if (Number(paid && paid.n) > 0) {
      return json({ error: 'A payment has been recorded against this invoice, so it cannot go back to '
        + status + '. Void it instead — that keeps the record and releases the retainer.' }, 400);
    }
  }

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
  /* IDEMPOTENT, the retainer-payment pattern exactly (Unit 18). A double
     click, a retried request or a dropped response used to record the money
     twice, with no way to take one back — `invoice_payments` had INSERT and
     SELECT and nothing else.

     The payment goes in FIRST so `last_insert_rowid()` is the row the claim
     points at, and the claim insert deliberately has NO `ON CONFLICT DO
     NOTHING`: a repeat token must RAISE so the whole batch rolls back and the
     second payment is never written. A claim therefore cannot exist without
     the money behind it, which is the state the retainer version was rebuilt
     to remove — so "already recorded" is PROVEN by following the claim
     through to a payment row on THIS invoice, never guessed from an error
     message. `token` is a global primary key, so the proof is scoped. */
  const at = nowIso();
  const insertPayment = env.DB.prepare(
    `INSERT INTO invoice_payments (invoice_id, amount, paid_date, method, reference, provider,
       external_payment_id, notes, recorded_by, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, Math.round(amount * 100) / 100, date, method,
          String(body.reference || '').trim().slice(0, 120) || null, provider,
          String(body.external_payment_id || '').trim().slice(0, 120) || null,
          String(body.notes || '').trim().slice(0, 1000) || null, user.id, at);

  const token = String(body.client_token || '').trim().slice(0, 100);
  const canClaim = token && !(await missingTables(env)).includes('invoice_payment_token');
  let duplicate = false;
  if (!canClaim) {
    await insertPayment.run();
  } else {
    try {
      await env.DB.batch([
        insertPayment,
        env.DB.prepare(
          `INSERT INTO invoice_payment_token (token, invoice_id, payment_id, claimed_at)
           VALUES (?, ?, last_insert_rowid(), ?)`).bind(token, id, at),
      ]);
    } catch {
      /* The batch holds TWO inserts, so a payment failing its own constraint
         rolls everything back and writes nothing — which is why the answer is
         the LEDGER, not the error text. Money on file is the only proof. */
      const paid = await env.DB.prepare(
        `SELECT p.id FROM invoice_payment_token t
           JOIN invoice_payments p ON p.id = t.payment_id
          WHERE t.token = ? AND t.invoice_id = ?`).bind(token, id).first();
      if (!paid) {
        return json({ error: 'That payment could not be confirmed as recorded. Reload the '
          + 'invoice and check its payments before entering it again.',
          code: 'indeterminate_payment' }, 409);
      }
      /* Already recorded, and the money is provably there: a success from the
         caller's side, which is the whole point of an idempotency key. */
      duplicate = true;
    }
  }

  /* Payment status is arithmetic, never a claim: the stored status moves to
     paid only when the balance actually reaches zero. */
  const out = await invoiceWithMoney(env, inv);
  const newStatus = out.balance_due <= 0 ? 'paid' : 'partially_paid';
  await env.DB.prepare('UPDATE invoices SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?')
    .bind(newStatus, user.id, nowIso(), id).run();
  /* A DEDUPLICATED RETRY IS NOT AN EVENT AND NOT AN ALERT. The money was
     recorded once, so the trail and the notification say so once — the same
     defect the retainer route still carries, fixed here at the source rather
     than by counting alerts downstream. */
  if (!duplicate) {
    await invoiceEvent(env, id, user, 'payment_recorded', `${amount} ${method}` + (newStatus === 'paid' ? ' — PAID IN FULL' : ''));
  }
  const after = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  /* The alert says a payment was recorded and never how much — the amount is
     commercial, and it is one sign-in away. */
  if (!duplicate) await notifyAdmins(env, 'payments', after ? after.case_no : '');
  return json({ ok: true, duplicate, invoice: await invoiceWithMoney(env, after) });
}

/* VOID A PAYMENT — a correction that keeps the history (Unit 18). Nothing is
   deleted: the row stays, the marker says who voided it and why, every figure
   stops counting it, and the page prints it struck through. That is the same
   promise `activity_removed`, the invoice void and evidence `deleted_at`
   already make — nothing the office does in this portal is unrecoverable in
   it, and financial history least of all.

   Correcting a payment is therefore void-then-record, two visible acts, rather
   than an edit that silently rewrites what a client was told. */
async function voidInvoicePayment(request, env, user, invoiceId, paymentId) {
  if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
  if ((await missingTables(env)).includes('invoice_payment_void')) {
    return json({ error: 'The payment-void table is not on this database yet. Run the '
      + 'portal-setup workflow once and try again.', code: 'not_set_up' }, 503);
  }
  /* Scoped to the invoice IN THE SAME STATEMENT, so a wrong-invoice id and a
     never-existed id answer identically and the route cannot probe. */
  const pay = await env.DB.prepare(
    'SELECT id FROM invoice_payments WHERE id = ? AND invoice_id = ?')
    .bind(paymentId, invoiceId).first();
  if (!pay) return json({ error: 'not found' }, 404);

  const body = await readJson(request);
  const reason = String(body.reason || '').trim().slice(0, 500);
  const already = await env.DB.prepare(
    'SELECT payment_id FROM invoice_payment_void WHERE payment_id = ?').bind(paymentId).first();
  if (already) return json({ error: 'That payment is already voided.', code: 'already_void' }, 409);

  await env.DB.prepare(
    `INSERT INTO invoice_payment_void (payment_id, reason, voided_by, voided_at)
     VALUES (?, ?, ?, ?)`).bind(paymentId, reason || null, user.id, nowIso()).run();

  /* THE STATUS GOES BACK TO WHAT THE RECORD SAYS IT WAS, never to a guess.
     Voiding the last payment on a paid invoice must stop it reading as paid —
     but which status it held before is not something to invent, because
     `ready`, `sent_to_bill` and `sent_to_client` mean three different things
     to a client. `invoice_events` already logs every transition as
     `status_<value>`, so the answer is read from the invoice's own trail. With
     money still on it the arithmetic decides, exactly as it always has. */
  const inv = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(invoiceId).first();
  const out = await invoiceWithMoney(env, inv);
  if (inv.status !== 'draft' && inv.status !== 'void') {
    let next = null;
    if (out.amount_paid > 0) {
      next = out.balance_due <= 0 ? 'paid' : 'partially_paid';
    } else {
      const prior = await env.DB.prepare(
        `SELECT action FROM invoice_events
          WHERE invoice_id = ? AND action LIKE 'status\\_%' ESCAPE '\\'
            AND action NOT IN ('status_paid', 'status_partially_paid')
          ORDER BY id DESC LIMIT 1`).bind(invoiceId).first();
      next = prior ? String(prior.action).slice(7) : null;
      if (!INVOICE_STATUSES.includes(next)) next = null;
    }
    if (next && next !== inv.status) {
      await env.DB.prepare('UPDATE invoices SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?')
        .bind(next, user.id, nowIso(), invoiceId).run();
    }
  }
  await invoiceEvent(env, invoiceId, user, 'payment_voided',
    `payment ${paymentId}` + (reason ? ` — ${reason}` : ''));
  const after = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(invoiceId).first();
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
  /* THIS METER IS ABOUT CLOUDFLARE, so it counts only what is in Cloudflare.
     Dropbox-backed rows are excluded from both halves: their bytes are not on
     the R2 free tier the cap defends, and their uploads are not R2 write
     operations. Left in, a folder full of photographs that never touched
     Cloudflare would drive the storage card toward a limit it cannot reach and
     eventually refuse uploads for space that was never being used. */
  /* A REMOVED FILE STILL WEIGHS WHAT IT WEIGHS (Unit 39). Removing evidence
     used to delete the object, so `deleted_at IS NULL` and "still on the
     account" meant the same thing. They do not any more: the owner's limit is
     that no bytes are destroyed, so a legacy R2 file that has been removed
     from the case is still sitting in the bucket the free tier is measuring.
     Not counting it would be the failsafe under-reporting, which is the one
     direction it must never fail in.

     THE MARKER IS WHAT TELLS THE TWO ERAS APART. A row removed BEFORE Unit 39
     had its object deleted at the time, so its bytes really are gone and
     counting them would over-report by exactly as much. A row removed after
     has a `case_content_removed` marker and its file is still there. So the
     condition is "not removed, OR removed and preserved" — and it degrades to
     the old behaviour when the table has not arrived, which is correct,
     because before it arrives nothing has been preserved. */
  const keepsBytes = (await missingTables(env)).includes('case_content_removed')
    ? 'deleted_at IS NULL'
    : `(deleted_at IS NULL OR EXISTS (SELECT 1 FROM case_content_removed m
         WHERE m.kind = 'evidence' AND m.ref_id = case_evidence.id))`;
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(size_bytes), 0) AS b FROM case_evidence
      WHERE ${keepsBytes} AND r2_key NOT LIKE '${DBX_KEY_PREFIX}%'`).first();
  const up = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM case_evidence
      WHERE uploaded_at LIKE ? AND r2_key NOT LIKE '${DBX_KEY_PREFIX}%'`)
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

/* --------------------------------------------------- STORAGE HEALTH (Unit 14)

   Designed from the audit in case-portal/STORAGE-HEALTH.md — no verbatim owner
   brief exists, so read that file before changing this. One admin route that
   answers, from METADATA ONLY, the storage questions nothing else answers:
   where the bytes are (Dropbox vs legacy R2), what the open legacy-video
   decision actually covers, how much of the firm's Dropbox is used, how much
   of the live evidence carries no integrity record, and which cases weigh the
   most. No byte is read, no folder is listed, nothing is written.

   THE ONE EXTERNAL CALL is users/get_space_usage, only here, degrading to
   null with a named reason — a guessed quota would be the meter lying in the
   reassuring direction. */

/* A refused storage write leaves a row — best-effort, and NEVER able to
   change what the caller is told. The try/catch is the whole contract. */
async function logStorageFailure(env, kind, caseNo, filename, reason, userId) {
  try {
    if ((await missingTables(env)).includes('storage_failure')) return;
    await env.DB.prepare(
      `INSERT INTO storage_failure (at, kind, case_no, filename, reason, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(nowIso(), kind, caseNo || null, filename || null, String(reason || 'unknown'),
            userId || null).run();
  } catch { /* the health record must not break the thing it watches */ }
}

async function dropboxSpace(env, token) {
  if (!token) return { space: null, space_reason: 'dropbox_unreachable' };
  try {
    const res = await fetch('https://api.dropboxapi.com/2/users/get_space_usage', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token },
    });
    if (!res.ok) return { space: null, space_reason: 'dropbox_refused' };
    const d = await res.json();
    const alloc = d && d.allocation ? d.allocation.allocated : null;
    if (!d || !Number.isFinite(d.used)) return { space: null, space_reason: 'unreadable_answer' };
    return { space: { used_bytes: d.used,
      allocated_bytes: Number.isFinite(alloc) ? alloc : null,
      percent_used: Number.isFinite(alloc) && alloc > 0
        ? Math.round((d.used / alloc) * 1000) / 10 : null } };
  } catch { return { space: null, space_reason: 'dropbox_unreachable' }; }
}

const SH_TOP_CASES = 8;

async function storageHealth(env) {
  const like = DBX_KEY_PREFIX + '%';
  /* Every arm is one aggregate statement over an indexed or full-scan-once
     table — no per-case loop, no statement that grows with the data. */
  const agg = async (where, binds = []) => {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS b FROM case_evidence WHERE ${where}`)
      .bind(...binds).first();
    return { count: Number(r && r.n) || 0, bytes: Number(r && r.b) || 0 };
  };
  const dbxLive = await agg("deleted_at IS NULL AND r2_key LIKE ?", [like]);
  const dbxGone = await agg("deleted_at IS NOT NULL AND r2_key LIKE ?", [like]);
  const r2Live = await agg("deleted_at IS NULL AND r2_key NOT LIKE ?", [like]);
  /* THE OPEN DECISION'S INVENTORY. Legacy video in R2 is untouched by policy
     (owner, 2026-08-17) and whether to export and remove it is a decision
     nobody has made — this screen informs that decision and must not perform
     it. Nothing in this route writes. */
  const r2Video = await agg(
    "deleted_at IS NULL AND r2_key NOT LIKE ? AND content_type LIKE 'video/%'", [like]);
  const r2Gone = await agg("deleted_at IS NOT NULL AND r2_key NOT LIKE ?", [like]);

  /* Copies the portal filed elsewhere: timestamped video sent to the case
     folder, and report PDFs. Metadata counts — the files live in Dropbox. */
  const missing = await missingTables(env);
  const vstCopies = missing.includes('video_stamp') ? null
    : Number((await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM video_stamp WHERE dropbox_path IS NOT NULL').first() || {}).n) || 0;
  const pdfFiled = Number((await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM build_events WHERE action = 'report_pdf_saved'`).first() || {}).n) || 0;

  /* Integrity coverage: how much of the LIVE evidence has a live hash record.
     Unknown (null) when the table has not arrived — unknown must not draw as
     "nothing is recorded". */
  let integrity = null;
  if (!missing.includes('evidence_integrity')) {
    const cov = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM case_evidence e
        WHERE e.deleted_at IS NULL AND EXISTS (
          SELECT 1 FROM evidence_integrity i
           WHERE i.artifact_kind = 'evidence' AND i.artifact_id = e.id
             AND i.superseded_at IS NULL AND i.sha256 IS NOT NULL)`).first();
    const total = dbxLive.count + r2Live.count;
    const withHash = Number(cov && cov.n) || 0;
    integrity = { live_files: total, with_hash: withHash,
                  not_yet_recorded: Math.max(0, total - withHash) };
  }

  /* The heaviest cases, one GROUP BY, bounded. Split by store so "move this
     case" conversations start from facts. */
  const { results: top } = await env.DB.prepare(
    `SELECT case_no,
            COALESCE(SUM(CASE WHEN r2_key LIKE ?1 THEN size_bytes END), 0) AS dropbox_bytes,
            COALESCE(SUM(CASE WHEN r2_key NOT LIKE ?1 THEN size_bytes END), 0) AS r2_bytes,
            COUNT(*) AS files
       FROM case_evidence WHERE deleted_at IS NULL
      GROUP BY case_no ORDER BY SUM(size_bytes) DESC LIMIT ?2`)
    .bind(like, SH_TOP_CASES).all();

  /* SAFE TO STORE, answered passively: the same three conditions every upload
     door checks, plus one minted token shared with the space question — the
     route asks Dropbox once, not once per fact. */
  const problem = await dropboxStorageProblem(env);
  const token = problem ? null : await dropboxAccessToken(env);
  const readiness = problem ? { ok: false, code: problem }
    : token ? { ok: true } : { ok: false, code: 'dropbox_unreachable' };

  /* LAST SUCCESSFUL UPLOAD derives from the rows that exist — no new write,
     nothing to drift. */
  const lastUp = await env.DB.prepare(
    `SELECT MAX(uploaded_at) AS at FROM case_evidence WHERE r2_key LIKE ?`).bind(like).first();

  /* FAILED UPLOADS, the record the owner asked for. Unknown (null) when the
     table has not arrived — unknown must not draw as "none ever failed". */
  let failures = null;
  if (!missing.includes('storage_failure')) {
    const total = Number((await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM storage_failure').first() || {}).n) || 0;
    const { results: recent } = await env.DB.prepare(
      `SELECT f.at, f.kind, f.case_no, f.filename, f.reason, u.display_name AS who
         FROM storage_failure f LEFT JOIN users u ON u.id = f.user_id
        ORDER BY f.id DESC LIMIT 10`).all();
    failures = { total, recent: recent || [] };
  }

  return {
    readiness,
    cloudflare: { ...(await evidenceUsage(env)),
      live: r2Live, live_video: r2Video, deleted_rows: r2Gone.count },
    dropbox: { live: dbxLive, deleted_rows: dbxGone.count,
      video_copies_filed: vstCopies, report_pdfs_filed: pdfFiled,
      last_upload_at: (lastUp && lastUp.at) || null,
      ...(await dropboxSpace(env, token)) },
    integrity,
    failures,
    top_cases: top || [],
    generated_at: nowIso(),
  };
}

const EVIDENCE_CLASSES = ['client_deliverable', 'internal_only', 'do_not_use', 'needs_review', 'needs_redaction'];

/* ------------------------------------------------------- EVIDENCE INTEGRITY

   Unit 11. The owner's brief is verbatim in case-portal/EVIDENCE-INTEGRITY.md
   and the decisions this build DERIVED are listed there one per entry; read it
   before changing any of this.

   THE HASH DESCRIBES THE EXACT BYTES OF THE ARTIFACT IT IS RECORDED AGAINST.
   An original and its timestamped copy are two artifacts and will have two
   different hashes — this file never claims otherwise, and there is no code
   path that copies one artifact's digest onto another.

   WHERE THE HASHING HAPPENS IS THE WHOLE DESIGN. Every supported artifact is
   hashed AT THE MOMENT IT IS ALREADY BEING FILED, out of the buffer the route
   is holding anyway: the upload, the timestamped photograph and the report PDF
   all read `file.arrayBuffer()` before handing it to Dropbox, so hashing costs
   one digest over bytes that are already in memory and NOTHING is downloaded
   to compute it. The one exception is the timestamped video, which arrives in
   8 MB pieces and is never in one place here at all — see `hash_origin`.

   AND NOTHING IS BACKFILLED. Historical files are not fetched from Dropbox to
   populate this table; they read as "not yet recorded" until an admin asks. */

const INTEGRITY_ARTIFACTS = ['evidence', 'video_stamp', 'report_pdf'];
const INTEGRITY_ROLES = ['original', 'derivative'];
const INTEGRITY_DERIVATIVES = ['timestamped_photo', 'timestamped_video', 'report_pdf', 'other_generated'];
const INTEGRITY_ORIGINS = ['worker', 'device'];
const HEX64 = /^[0-9a-f]{64}$/;
const INTEGRITY_NOT_SET_UP = 'Evidence integrity is not set up on this database yet. '
  + 'Run the portal-setup workflow once and try again.';

/* The ceiling on a re-read. Recording or verifying a hash for a file already in
   storage means holding it whole, and this Worker's memory is not the place to
   discover that a 400 MB clip does not fit. It defaults to the per-file upload
   limit because anything filed through this portal is already under it, and it
   is env-overridable so the tests can exercise the refusal with small files. */
function integrityReadCap(env) {
  const n = parseInt(env && env.INTEGRITY_MAX_BYTES, 10);
  return Number.isFinite(n) && n > 0 ? n : storageLimits(env).maxFileBytes;
}

/** SHA-256 of raw bytes, lowercase hex. The one hashing primitive for this
    feature; `sha256Hex` above takes a string and is for tokens. */
async function sha256Bytes(buf) {
  return hex(await crypto.subtle.digest('SHA-256', buf));
}

async function integrityMissing(env) {
  return (await missingTables(env)).includes('evidence_integrity');
}

/* WRITE ONE INTEGRITY RECORD, AND NEVER LIE ABOUT HAVING DONE IT.

   Returns `{ ok: true, id }` or `{ ok: false, reason }` — it does not throw and
   it does not decide what the caller's response should be. That matters at the
   filing routes: the bytes are already safely stored by the time this runs, so
   a failure here must not turn a successful upload into an error, and it must
   not be swallowed either. The caller reports `integrity: 'not_recorded'` with
   the reason, which is the brief's rule ("do not falsely show success if hash
   recording failed") pointed in the direction that keeps the file.

   A RE-RECORD SUPERSEDES. The previous live row for this artifact is stamped
   and kept — `photo_stamp`'s shape, and the reason is the same: an integrity
   history that can be quietly overwritten is worth nothing in the one
   conversation it exists for. */
async function recordIntegrity(env, rec) {
  if (!env.DB) return { ok: false, reason: 'no_database' };
  if (await integrityMissing(env)) return { ok: false, reason: 'not_set_up' };
  if (!INTEGRITY_ARTIFACTS.includes(rec.artifact_kind)) return { ok: false, reason: 'bad_artifact' };
  if (!INTEGRITY_ROLES.includes(rec.artifact_role)) return { ok: false, reason: 'bad_role' };
  if (rec.derivative_type && !INTEGRITY_DERIVATIVES.includes(rec.derivative_type)) {
    return { ok: false, reason: 'bad_derivative_type' };
  }
  if (!INTEGRITY_ORIGINS.includes(rec.hash_origin)) return { ok: false, reason: 'bad_origin' };
  /* A DIGEST THAT IS NOT A DIGEST IS REFUSED. The device-computed path means a
     value arrives over the wire, and "sha256" that is 12 characters of
     something else would sit in the manifest looking like evidence. */
  if (rec.sha256 != null && !HEX64.test(String(rec.sha256))) return { ok: false, reason: 'bad_hash' };
  const now = nowIso();
  try {
    await env.DB.prepare(
      `UPDATE evidence_integrity SET superseded_at = ?
        WHERE artifact_kind = ? AND artifact_id = ? AND superseded_at IS NULL`)
      .bind(now, rec.artifact_kind, rec.artifact_id).run();
    const res = await env.DB.prepare(
      `INSERT INTO evidence_integrity
         (case_no, artifact_kind, artifact_id, filename, content_type, byte_size, sha256,
          hash_origin, artifact_role, derivative_type, source_kind, source_id, source_ref,
          storage_provider, storage_ref, capture_at, generated_at, filed_at, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(rec.case_no, rec.artifact_kind, rec.artifact_id, rec.filename || null,
            rec.content_type || null, Number.isFinite(rec.byte_size) ? rec.byte_size : null,
            rec.sha256 || null, rec.hash_origin, rec.artifact_role, rec.derivative_type || null,
            rec.source_kind || null, Number.isInteger(rec.source_id) ? rec.source_id : null,
            rec.source_ref || null, rec.storage_provider || null, rec.storage_ref || null,
            rec.capture_at || null, rec.generated_at || null, rec.filed_at || null,
            rec.recorded_by || null, now).run();
    return { ok: true, id: res.meta ? res.meta.last_row_id : null };
  } catch { return { ok: false, reason: 'write_failed' }; }
}

/* Hash the bytes a filing route is already holding, and record them. Wrapped
   because all three worker-side filing paths do exactly this and a fourth copy
   of it is a fourth chance to forget the supersede or the provenance. */
async function recordIntegrityForBytes(env, buf, rec) {
  let digest = null;
  try { digest = await sha256Bytes(buf); } catch { return { ok: false, reason: 'hash_failed' }; }
  return recordIntegrity(env, { ...rec, sha256: digest, hash_origin: 'worker',
                                byte_size: buf.byteLength });
}

/* THE LIVE RECORD FOR ONE ARTIFACT — the newest row that has not been
   superseded. Everything on screen reads through here, so "the current record"
   has one definition. */
async function integrityRow(env, kind, id) {
  if (await integrityMissing(env)) return null;
  return env.DB.prepare(
    `SELECT * FROM evidence_integrity
      WHERE artifact_kind = ? AND artifact_id = ? AND superseded_at IS NULL
      ORDER BY id DESC LIMIT 1`).bind(kind, id).first();
}

/* ORDINARY RENDERING READS METADATA AND NOTHING ELSE. This is the query the
   case workspace runs: one bounded pass over the case's live integrity rows,
   no join to storage, no byte anywhere near it.

   `storage_ref` IS ADMIN-ONLY. It is the path inside the firm's own App Folder
   — no token and no credential, but it is the office's filing rather than the
   field's, and the investigator boundary in this project is an allow-list
   rather than a judgement call. */
function integrityOut(r, admin) {
  return {
    id: r.id, artifact_kind: r.artifact_kind, artifact_id: r.artifact_id,
    filename: r.filename, content_type: r.content_type, byte_size: r.byte_size,
    sha256: r.sha256, hash_origin: r.hash_origin, artifact_role: r.artifact_role,
    derivative_type: r.derivative_type, source_kind: r.source_kind, source_id: r.source_id,
    source_ref: r.source_ref, storage_provider: r.storage_provider,
    capture_at: r.capture_at, generated_at: r.generated_at, filed_at: r.filed_at,
    recorded_at: r.recorded_at, recorded_by: r.recorded_by_name || null,
    ...(admin ? { storage_ref: r.storage_ref } : {}),
  };
}

const INTEGRITY_CAP = 400;

async function integrityFor(env, caseNo, admin) {
  if (await integrityMissing(env)) return null;
  const { results } = await env.DB.prepare(
    `SELECT e.*, u.display_name AS recorded_by_name
       FROM evidence_integrity e LEFT JOIN users u ON u.id = e.recorded_by
      WHERE e.case_no = ? AND e.superseded_at IS NULL
      ORDER BY e.id DESC LIMIT ?`).bind(caseNo, INTEGRITY_CAP).all();
  return (results || []).map(r => integrityOut(r, admin));
}

/* READ AN ARTIFACT'S AUTHORITATIVE BYTES, ONCE, ON PURPOSE.

   Only the two explicit admin actions call this — Record integrity hash and
   Verify integrity. Nothing on an ordinary case open, nothing on the dashboard,
   and never a sweep of a folder.

   It refuses rather than guessing: a file the store will not give up is
   `unavailable`, and one too large to hold is `too_large`. Neither writes
   anything, because a hash nobody could compute is not a hash. */
async function artifactBytes(env, row) {
  const cap = integrityReadCap(env);
  if (Number.isFinite(row.size_bytes) && row.size_bytes > cap) {
    return { error: 'too_large', cap };
  }
  try {
    if (isDropboxKey(row.r2_key)) {
      const token = await dropboxAccessToken(env);
      if (!token) return { error: 'unavailable', why: 'dropbox_unreachable' };
      const got = await dropboxDownload(env, token, dropboxPathFromKey(row.r2_key));
      if (!got) return { error: 'unavailable', why: 'missing_from_dropbox' };
      const buf = await got.arrayBuffer();
      if (buf.byteLength > cap) return { error: 'too_large', cap };
      return { buf };
    }
    if (!env.EVIDENCE) return { error: 'unavailable', why: 'no_bucket' };
    const obj = await env.EVIDENCE.get(row.r2_key);
    if (!obj) return { error: 'unavailable', why: 'missing_from_bucket' };
    const buf = await obj.arrayBuffer();
    if (buf.byteLength > cap) return { error: 'too_large', cap };
    return { buf };
  } catch { return { error: 'unavailable', why: 'read_failed' }; }
}

function storageOfKey(key) { return isDropboxKey(key) ? 'dropbox' : 'r2'; }


async function uploadEvidence(request, env, user, caseNo) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  let form;
  try { form = await request.formData(); } catch { return json({ error: 'Send the file as multipart form data.' }, 400); }
  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.size) return json({ error: 'Attach a file.' }, 400);

  /* VIDEO IS DEVICE-FIRST FROM HERE ON (owner, 2026-08-17). New video bytes do
     not become permanent Cloudflare storage: the original stays on the
     investigator's device and the timestamped derivative is generated there and
     saved back there. Refused IN THE WORKER rather than by the page hiding a
     button, because "no persistent R2 video object is created" is a property,
     and a property enforced by a page is enforced by nothing.

     Checked BEFORE the size and cap tests on purpose — a refused video must
     not first be told to split itself into smaller parts, which is advice for
     a path that no longer exists.

     LEGACY VIDEO ALREADY IN R2 IS UNTOUCHED — this refuses new writes and
     deletes nothing. Photographs are unaffected and keep the existing model. */
  if (String(file.type || '').startsWith('video/')) {
    return json({ error: 'Video is not stored in the portal any more. Keep the original '
      + 'on your device and use Video timestamp to generate the timestamped copy — it '
      + 'is made on your own machine and saved back to it.', code: 'video_device_first' }, 400);
  }

  /* THE PER-FILE LIMIT STAYS, and the two Cloudflare failsafes do not apply
     here any more. `hardCapBytes` and `maxUploadsPerMonth` exist to keep the
     R2 free tier from ever billing; these bytes never reach Cloudflare, so
     enforcing them would refuse a Dropbox upload because of what LEGACY R2
     files weigh — a failsafe firing about storage it is not protecting. The
     size limit is kept because it is also comfortably under Dropbox's
     single-request upload limit, and because loosening a bound the owner set
     is not something to do as a side effect. */
  const lim = storageLimits(env);
  if (file.size > lim.maxFileBytes) {
    return json({ error: `That file is ${(file.size / 1048576).toFixed(1)} MB and the per-file limit is `
      + `${Math.floor(lim.maxFileBytes / 1048576)} MB.` }, 413);
  }

  /* NEW BYTES GO TO DROPBOX OR NOWHERE (owner). Refused with the reason rather
     than quietly written to R2: a fallback would split a case across two
     stores and nobody would find out until they went looking for the half that
     was not where they expected. */
  const filename = String(file.name || 'file').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) || 'file';
  const problem = await dropboxStorageProblem(env);
  if (problem === 'provider_not_configured') {
    await logStorageFailure(env, 'evidence', caseNo, filename, problem, user.id);
    return json({ error: 'Dropbox is not set up on this Worker yet, and new case files are stored there. '
      + EXTERNAL_PROVIDERS.dropbox.note, code: problem }, 503);
  }
  if (problem) {
    await logStorageFailure(env, 'evidence', caseNo, filename, problem, user.id);
    return json({ error: 'No Dropbox account is connected, and new case files are stored there. '
      + 'An admin can connect one from the portal, then try this upload again.', code: problem }, 503);
  }
  const dbxToken = await dropboxAccessToken(env);
  if (!dbxToken) {
    await logStorageFailure(env, 'evidence', caseNo, filename, 'dropbox_unreachable', user.id);
    return json({ error: 'Dropbox could not be reached just now, so this file was not stored. '
      + 'Nothing was lost — try again in a moment.', code: 'dropbox_unreachable' }, 503);
  }

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

  /* Photos to Photos, documents and reports to Reports. The folders are made
     first so a case has the same three either way, even before anything has
     been put in two of them. */
  const folder = dropboxFolderFor(file.type);
  await dropboxEnsureCaseFolders(env, dbxToken, caseNo);
  /* HELD ONCE, USED TWICE (Unit 11). The buffer was already being read whole to
     hand to Dropbox; keeping the reference lets the digest be taken from the
     same bytes rather than fetching the file back afterwards to hash it. No
     second copy is made and nothing extra is read. */
  const buf = await file.arrayBuffer();
  const meta = await dropboxUpload(env, dbxToken,
    `/${caseNo}/${folder}/${dropboxStoredName(filename)}`, buf);
  /* NOTHING IS RECORDED UNTIL THE BYTES ARE SAFE. A row written before the
     upload succeeded is a case file the portal lists and cannot produce. */
  if (!meta) {
    await logStorageFailure(env, 'evidence', caseNo, filename, 'dropbox_refused_upload', user.id);
    return json({ error: 'Dropbox refused the upload, so this file was not stored. '
      + 'Nothing was lost — try again in a moment.', code: 'dropbox_unreachable' }, 503);
  }
  /* The path Dropbox ACTUALLY used, not the one that was asked for: if
     autorename moved it, the record has to name where the file really is. */
  const key = DBX_KEY_PREFIX + meta.path_display;
  const now = nowIso();
  const res = await env.DB.prepare(
    `INSERT INTO case_evidence (case_no, r2_key, filename, content_type, size_bytes, classification,
       entry_id, subject_id, note, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(caseNo, key, filename, file.type || null, file.size, classification,
          entryId, subjectId, note, user.id, now).run();
  const evId = res.meta ? res.meta.last_row_id : null;

  /* THE INTEGRITY RECORD GOES AFTER THE ROW IT DESCRIBES, and its failure never
     turns a stored file into an error: the bytes are safe by now, so the honest
     answer is the upload succeeded and the hash did not get written, with the
     reason. Reported rather than swallowed — the brief forbids both lies. */
  const integ = evId == null ? { ok: false, reason: 'no_row' }
    : await recordIntegrityForBytes(env, buf, {
        case_no: caseNo, artifact_kind: 'evidence', artifact_id: evId,
        filename, content_type: file.type || null,
        /* AN UPLOADED FILE IS AN ORIGINAL. This route is the door material
           comes IN through; the two derivative doors are elsewhere and say so
           for themselves, and nothing here infers a source from a filename. */
        artifact_role: 'original',
        storage_provider: 'dropbox', storage_ref: meta.path_display,
        /* FILED, NOT CAPTURED. When the picture was taken is the camera's to
           say and this route is not told it — substituting the upload moment
           would be the portal inventing a capture time. */
        filed_at: now, recorded_by: user.id,
      });
  return json({ ok: true, id: evId, usage: await evidenceUsage(env),
                integrity: integ.ok ? 'recorded' : 'not_recorded',
                ...(integ.ok ? {} : { integrity_reason: integ.reason }) }, 201);
}

/* THE ONLY PLACE EVIDENCE BYTES LEAVE, whichever store they are in — which is
   what makes the Dropbox move safe. The file is PROXIED through the Worker so
   it stays behind `caseFor`, the role check and the case's own gates. A shared
   Dropbox link would be a URL that works for anyone who has it, for as long as
   it exists, with none of that in front of it: do not add one. */
/* SAVING A TIMESTAMPED COPY TO DROPBOX (owner, Part 2, 2026-08-18).

   OPTIONAL AND EXPLICIT. Nothing here runs by itself: the copy is generated on
   the operator's device as it always was, saved to that device as it always
   was, and this route exists only for the moment they press a button asking
   for it to go to the case folder as well. There is no automatic upload, and
   the ordinary evidence upload still refuses video by name — the device-first
   decision of 2026-08-17 is intact, and this is a second door beside it rather
   than a way around it.

   THE ORIGINAL IS NEVER TOUCHED. What moves is the derivative that was just
   made; the source clip stays where it was shot and this Worker never sees it.

   NO R2 COPY, at any size. The bytes go to the case's Video folder and nowhere
   else — which is also why the free-plan failsafe is not consulted: it defends
   the Cloudflare free tier, and nothing here goes near it.

   NOT ADMIN-ONLY. The investigator who shot the footage is the one standing in
   the field with it; `caseFor` scopes them to their own cases, which is the
   boundary that matters. */
async function videoStampToDropbox(request, env, user, caseNo, stampId, step) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  if ((await missingTables(env)).includes('video_stamp')) {
    return json({ error: 'The video record table is not on this database yet. Run the '
      + 'portal-setup workflow once and try again.', code: 'not_set_up' }, 503);
  }
  const row = await env.DB.prepare(
    `SELECT id, case_no, derivative_name, original_name, dropbox_path
       FROM video_stamp WHERE id = ? AND case_no = ?`).bind(stampId, caseNo).first();
  if (!row) return json({ error: 'not found' }, 404);

  const problem = await dropboxStorageProblem(env);
  if (problem === 'provider_not_configured') {
    return json({ error: 'Dropbox is not set up on this Worker yet, so there is nowhere to put '
      + 'the copy. ' + EXTERNAL_PROVIDERS.dropbox.note, code: problem }, 503);
  }
  if (problem) {
    return json({ error: 'No Dropbox account is connected, so there is nowhere to put the copy. '
      + 'The timestamped file is already on this device.', code: problem }, 503);
  }
  const token = await dropboxAccessToken(env);
  if (!token) {
    return json({ error: 'Dropbox could not be reached. The timestamped copy is still on this '
      + 'device — nothing was lost.', code: 'dropbox_unreachable' }, 503);
  }

  if (step === 'start') {
    const sid = await dropboxSessionStart(env, token);
    if (!sid) {
      return json({ error: 'Dropbox would not start the upload. The copy is still on this device.',
        code: 'dropbox_unreachable' }, 503);
    }
    return json({ ok: true, session_id: sid, chunk_bytes: dbxChunkBytes(env) });
  }

  const url = new URL(request.url);
  if (step === 'append') {
    const sid = String(url.searchParams.get('session') || '');
    const offset = parseInt(url.searchParams.get('offset'), 10);
    if (!sid || !Number.isInteger(offset) || offset < 0) {
      return json({ error: 'bad cursor' }, 400);
    }
    const body = await request.arrayBuffer();
    /* One chunk at a time is the whole point — a caller that sends more than
       was agreed is refused rather than allowed to define the memory use. */
    if (body.byteLength > dbxChunkBytes(env)) return json({ error: 'chunk too large' }, 413);
    if (!(await dropboxSessionAppend(env, token, sid, offset, body))) {
      return json({ error: 'Dropbox refused that part of the upload. It can be retried from the '
        + 'same point.', code: 'dropbox_unreachable', offset }, 503);
    }
    return json({ ok: true, offset: offset + body.byteLength });
  }

  const b = await readJson(request);
  const sid = String(b.session_id || '');
  const offset = parseInt(b.offset, 10);
  if (!sid || !Number.isInteger(offset) || offset < 0) return json({ error: 'bad cursor' }, 400);
  const name = String(row.derivative_name || ('timestamped-' + row.id))
    .replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) || ('timestamped-' + row.id);
  await dropboxEnsureCaseFolders(env, token, caseNo);
  const meta = await dropboxSessionFinish(env, token, sid, offset,
    `/${caseNo}/Video/${dropboxStoredName(name)}`);
  if (!meta) {
    await logStorageFailure(env, 'video_stamp', caseNo, name, 'dropbox_refused_upload', user.id);
    return json({ error: 'Dropbox would not complete the upload. The copy is still on this device.',
      code: 'dropbox_unreachable' }, 503);
  }
  /* `dropbox_path` was reserved on this table when it was written and nothing
     has filled it until now — so the record of where the copy went needs no
     new column and no schema dispatch. */
  await env.DB.prepare('UPDATE video_stamp SET dropbox_path = ? WHERE id = ?')
    .bind(meta.path_display, stampId).run();

  /* THE ONE ARTIFACT THIS WORKER CANNOT HASH ITSELF, and the record says so.

     A timestamped clip arrives in 8 MB pieces and is never in one place here —
     that is the whole point of the session upload, and holding it whole to take
     a digest would undo it. Web Crypto has no incremental digest, so there is
     no honest way for the Worker to compute this one.

     So the DEVICE THAT GENERATED THE FILE hashes it, out of the very blob it
     just saved, and sends the digest with `finish`. `hash_origin: 'device'`
     records that, exactly the way `photo_stamp.source` records whether a
     timestamp came from the camera or from a person — an integrity record whose
     origin is unstated is one nobody can weigh.

     AND IT IS OPTIONAL. An older page that sends no digest still uploads; the
     copy simply reads as not yet recorded rather than being refused, and a
     value that is not a SHA-256 is refused by `recordIntegrity` rather than
     stored looking like one. */
  const claimed = String(b.sha256 || '').trim().toLowerCase();
  let integ = { ok: false, reason: 'no_hash_sent' };
  if (claimed) {
    integ = await recordIntegrity(env, {
      case_no: caseNo, artifact_kind: 'video_stamp', artifact_id: stampId,
      filename: name, content_type: 'video/webm',
      byte_size: Number.isInteger(offset) ? offset : null,
      sha256: claimed, hash_origin: 'device',
      artifact_role: 'derivative', derivative_type: 'timestamped_video',
      /* THE SOURCE IS NOT IN THE PORTAL. The original clip never leaves the
         device that shot it, so there is no id to point at — only the name it
         was made from, which `video_stamp` already recorded. Saying 'external'
         is the truthful answer; inventing an evidence id would not be. */
      source_kind: 'external', source_ref: row.original_name || null,
      storage_provider: 'dropbox', storage_ref: meta.path_display,
      generated_at: nowIso(), filed_at: nowIso(), recorded_by: user.id,
    });
  }
  return json({ ok: true, path: meta.path_display,
                integrity: integ.ok ? 'recorded' : 'not_recorded',
                ...(integ.ok ? {} : { integrity_reason: integ.reason }) });
}

/* THE FINAL REPORT AS A REAL FILE (owner, 2026-08-18: "Final Reports need a
   real PDF file, not Print only").

   THE PDF IS MADE ON THE OPERATOR'S MACHINE, not here. The package document is
   already rendered in their browser, so it is rendered ONCE and turned into a
   PDF there — the same device-first shape as the video timestamping, and for
   the same two reasons: this Worker's CPU budget is small enough that signing
   in already strains it, and a second server-side rendering of a document that
   exists on screen is a second thing to drift.

   NO R2 COPY (owner, explicit). The bytes go to the case's Dropbox Reports
   folder and nowhere else. Nothing is written to `case_evidence` either: a
   report of the case is not evidence in it, and putting it there would list it
   in the gallery and put it under the deliverable-classification gate that
   governs material, not paperwork. The record is a `build_events` row — the
   audit trail this build already keeps, whose `action` is free text, so
   recording a new kind of act needs no CHECK widened and no table added. */
async function saveBuildPdf(request, env, user, buildId) {
  if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
  const b = await env.DB.prepare(
    'SELECT id, case_no, version FROM case_builds WHERE id = ?').bind(buildId).first();
  if (!b) return json({ error: 'not found' }, 404);
  if (!(await caseFor(env, user, b.case_no))) return json({ error: 'not found' }, 404);

  const problem = await dropboxStorageProblem(env);
  if (problem === 'provider_not_configured') {
    return json({ error: 'Dropbox is not set up on this Worker yet, so there is nowhere to file '
      + 'the report. ' + EXTERNAL_PROVIDERS.dropbox.note, code: problem }, 503);
  }
  if (problem) {
    return json({ error: 'No Dropbox account is connected, so there is nowhere to file the report. '
      + 'An admin can connect one from the portal.', code: problem }, 503);
  }

  let form;
  try { form = await request.formData(); } catch { return json({ error: 'Send the PDF as multipart form data.' }, 400); }
  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.size) return json({ error: 'Attach the PDF.' }, 400);
  /* Named rather than sniffed, but a PDF is what this route is for and a
     mislabelled upload would file something else under the report's name. */
  if (String(file.type || '') !== 'application/pdf') {
    return json({ error: 'That is not a PDF.', code: 'not_a_pdf' }, 400);
  }
  const lim = storageLimits(env);
  if (file.size > lim.maxFileBytes) {
    return json({ error: `That PDF is ${(file.size / 1048576).toFixed(1)} MB and the per-file limit is `
      + `${Math.floor(lim.maxFileBytes / 1048576)} MB.` }, 413);
  }

  const token = await dropboxAccessToken(env);
  if (!token) {
    await logStorageFailure(env, 'report_pdf', b.case_no, null, 'dropbox_unreachable', user.id);
    return json({ error: 'Dropbox could not be reached just now, so the report was not filed. '
      + 'Nothing was lost — download it or try again in a moment.', code: 'dropbox_unreachable' }, 503);
  }
  await dropboxEnsureCaseFolders(env, token, b.case_no);
  const name = `${b.case_no} report v${b.version || 1}.pdf`;
  const buf = await file.arrayBuffer();
  const meta = await dropboxUpload(env, token,
    `/${b.case_no}/Reports/${dropboxStoredName(name)}`, buf);
  if (!meta) {
    await logStorageFailure(env, 'report_pdf', b.case_no, name, 'dropbox_refused_upload', user.id);
    return json({ error: 'Dropbox refused the file, so the report was not filed. '
      + 'Nothing was lost — download it or try again in a moment.', code: 'dropbox_unreachable' }, 503);
  }

  const at = nowIso();
  await env.DB.prepare(
    'INSERT INTO build_events (build_id, action, detail, user_id, at) VALUES (?, ?, ?, ?, ?)')
    .bind(buildId, 'report_pdf_saved', meta.path_display, user.id, at).run();

  /* THE FILED PDF IS HASHED, AND ONLY BECAUSE IT WAS DELIBERATELY FILED. A PDF
     the operator merely downloads is not an artifact this portal holds, so it
     gets no record — the brief's "hash the final generated artifact IF it is
     being deliberately filed". `artifact_id` is the BUILD, because a report PDF
     is not a `case_evidence` row (a report of the case is not evidence in it)
     and the build is what it is a rendering of. */
  const integ = await recordIntegrityForBytes(env, buf, {
    case_no: b.case_no, artifact_kind: 'report_pdf', artifact_id: buildId,
    filename: name, content_type: 'application/pdf',
    artifact_role: 'derivative', derivative_type: 'report_pdf',
    source_kind: 'build', source_id: buildId, source_ref: `Case build v${b.version || 1}`,
    storage_provider: 'dropbox', storage_ref: meta.path_display,
    generated_at: at, filed_at: at, recorded_by: user.id,
  });
  return json({ ok: true, path: meta.path_display, bytes: file.size,
                integrity: integ.ok ? 'recorded' : 'not_recorded',
                ...(integ.ok ? {} : { integrity_reason: integ.reason }) });
}

/* WHAT MAY BE RENDERED IN A BROWSER IS AN ALLOW-LIST, and it is a security
   boundary rather than a display preference.

   `case_evidence.content_type` is whatever the uploading browser put in the
   multipart part — it is CALLER-CONTROLLED, and nothing on the way in checks
   it (only `video/*` is refused, and for a storage reason). This route answers
   on the portal's OWN origin: the Worker is mounted at
   `alwayspreciseinvestigations.net/portal-api/*` and the page is at
   `/portal/`, deliberately, so a session cookie is sent. Served `inline` as
   `text/html` or `image/svg+xml`, an uploaded file is therefore a script
   running inside the portal with the viewing admin's session — an
   investigator account escalating to admin actions by uploading a file and
   waiting for the office to open it. The cookie is HttpOnly, which stops it
   being read and stops nothing else.

   So a type that is not on this list is served as opaque bytes with
   `attachment`, which renders nowhere. An ALLOW-list for the `FIELD_KEEP`
   reason: a content type nobody has considered yet is refused inline by
   default, where a block-list would ship the next one. `image/svg+xml` is
   named out because it is the one image type that is a document with script
   in it — an `<img>` tag will not run it, following the link will.

   The `<img src>` galleries and the package document are unaffected: a browser
   ignores `Content-Disposition` on a subresource, and every type they draw is
   on the list. `X-Content-Type-Options: nosniff` is set on every response the
   Worker makes, so a declared type is also the served one.

   NO Content-Security-Policy is set here on purpose. `default-src 'none'` or
   `sandbox` would be a second belt, but both can stop a browser's built-in PDF
   viewer, and a filed report that will not open is a real workflow broken for
   a defence the allow-list has already made. */
function inlineSafeType(contentType) {
  const t = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (!t) return null;
  if (t === 'image/svg+xml' || t === 'image/svg') return null;
  if (t.startsWith('image/') || t.startsWith('video/') || t.startsWith('audio/')) return t;
  if (t === 'application/pdf' || t === 'text/plain') return t;
  return null;
}

async function serveEvidence(env, user, caseNo, eid, rangeHeader) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  const row = await env.DB.prepare(
    'SELECT r2_key, filename, content_type, deleted_at FROM case_evidence WHERE id = ? AND case_no = ?')
    .bind(eid, caseNo).first();
  if (!row || row.deleted_at) return json({ error: 'not found' }, 404);
  const safe = inlineSafeType(row.content_type);
  const headers = {
    'Content-Type': safe || 'application/octet-stream',
    'Content-Disposition': `${safe ? 'inline' : 'attachment'}; filename="${row.filename.replace(/"/g, '')}"`,
    'Cache-Control': 'private, no-store',
  };

  if (isDropboxKey(row.r2_key)) {
    const token = await dropboxAccessToken(env);
    if (!token) {
      return json({ error: 'Dropbox could not be reached, so this file cannot be shown right now. '
        + 'It is still there.', code: 'dropbox_unreachable' }, 503);
    }
    const got = await dropboxDownload(env, token, dropboxPathFromKey(row.r2_key));
    if (!got) return json({ error: 'The stored file is missing from Dropbox.' }, 404);
    return new Response(got.body, { status: 200, headers });
  }

  /* EVERY FILE UPLOADED BEFORE THIS CHANGE IS STILL HERE and still reads from
     the bucket. Nothing was migrated and nothing was deleted (owner). */
  if (!env.EVIDENCE) return json({ error: 'Evidence storage is not attached.' }, 503);
  /* RANGE REQUESTS (closeout audit, 2026-09-03): iOS Safari's media loader
     asks for `bytes=0-1` first and refuses to play a 200 that ignores it, so
     a legacy video row in R2 would not play on a phone. R2 serves a range
     natively and still reports the object's full size. Dropbox-backed rows
     are untouched — video was never written there. */
  const range = parseByteRange(rangeHeader);
  const obj = await env.EVIDENCE.get(row.r2_key, range
    ? { range: range.end == null ? { offset: range.start } : { offset: range.start, length: range.end - range.start + 1 } }
    : undefined);
  if (!obj) return json({ error: 'The stored object is missing from the bucket.' }, 404);
  headers['Accept-Ranges'] = 'bytes';
  if (range && typeof obj.size === 'number' && range.start < obj.size) {
    const end = Math.min(range.end == null ? obj.size - 1 : range.end, obj.size - 1);
    headers['Content-Range'] = `bytes ${range.start}-${end}/${obj.size}`;
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { status: 200, headers });
}

/* `bytes=a-b` or `bytes=a-`; anything else (multi-range, the suffix form) is
   ignored and the whole object is served, which every client accepts. */
function parseByteRange(h) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(h || '').trim());
  if (!m) return null;
  const start = parseInt(m[1], 10), end = m[2] === '' ? null : parseInt(m[2], 10);
  if (!Number.isFinite(start) || (end != null && end < start)) return null;
  return { start, end };
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

/* REMOVING A FILE FROM THE CASE NO LONGER DESTROYS IT (Unit 39).

   THIS USED TO DELETE THE BYTES. `dropboxDelete` for a Dropbox-backed row,
   `env.EVIDENCE.delete` for a legacy R2 one, and only then the tombstone — so
   the row survived and the file did not, which is why there was no Restore to
   write: there was nothing left to put back.

   The owner's Unit 39 limits are explicit — "Do NOT physically delete Dropbox
   bytes in this unit", "Do NOT overwrite originals", "support Restore where
   existing architecture permits" — and the brief asks for a confirmation that
   no evidence bytes are physically destroyed. That could not be given while
   this function was the thing destroying them. So it stops.

   WHAT THE STORAGE METER NEEDS FROM THIS. `evidenceUsage` counts
   `deleted_at IS NULL` over rows that are NOT Dropbox-backed, so a legacy R2
   file that is tombstoned but still present would stop counting while its
   bytes stayed on the account — the free-plan failsafe under-reporting, which
   is the one direction it must never fail in. The `case_content_removed`
   marker written here is what tells the two eras apart: a row deleted BEFORE
   this change has no marker and its bytes really are gone; a row deleted from
   here on has one and its bytes are still there. The meter reads that.

   Dropbox-backed rows — everything uploaded since 2026-08-18 — are excluded
   from the meter either way, so preserving them costs the failsafe nothing.

   `Clear test cases` still removes Dropbox objects for `TEST-` cases. That is
   deliberate, pre-existing, and scoped to disposable data; it is not this
   route and is not changed here. */
async function deleteEvidence(env, user, caseNo, eid, reason) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
  /* THE HOLD OUTRANKS (Unit 17, decision 5): "evidence removal" is named in
     the owner's own list of what a hold blocks. Metadata edits and every read
     stay open; only the destructive act is refused, by name. */
  const hold = await activeHold(env, caseNo);
  if (hold) {
    return json({ error: 'This case is under a legal hold — evidence cannot be removed until '
      + 'the hold is released.', code: 'legal_hold' }, 409);
  }
  const row = await env.DB.prepare(
    'SELECT r2_key, deleted_at FROM case_evidence WHERE id = ? AND case_no = ?').bind(eid, caseNo).first();
  if (!row) return json({ error: 'not found' }, 404);
  if (row.deleted_at) return json({ ok: true, already: true });

  // The record of the removal, with who and when. The file stays where it is.
  await env.DB.prepare('UPDATE case_evidence SET deleted_by = ?, deleted_at = ? WHERE id = ?')
    .bind(user.id, nowIso(), eid).run();

  /* The marker AND the trail. The marker is the meter's; the trail is the
     history's, and it matters most here because a restore CLEARS the columns
     above — without it, putting a file back would erase the fact that it was
     ever removed. Both are best-effort and neither can turn a completed
     removal into an error. */
  let recorded = false;
  try {
    const missing = await missingTables(env);
    if (!missing.includes('case_content_removed')) {
      await markContentRemoved(env, user, caseNo, 'evidence', eid, reason || null);
      recorded = true;
    }
  } catch { recorded = false; }

  return json({ ok: true, usage: await evidenceUsage(env),
                file_preserved: true, audit_recorded: recorded,
                ...(recorded ? {} : { audit_reason: 'not_set_up' }) });
}

/* PUTTING ONE BACK. Only possible because the bytes were never destroyed —
   and only offered where they genuinely still exist, which is why a file
   removed BEFORE Unit 39 is refused by name rather than restored into a
   gallery entry that would 404 when somebody opened it. The absence of the
   marker is what says the old code deleted the object. */
async function restoreEvidence(env, user, caseNo, eid, reason) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
  const row = await env.DB.prepare(
    'SELECT id, filename, deleted_at FROM case_evidence WHERE id = ? AND case_no = ?')
    .bind(eid, caseNo).first();
  if (!row) return json({ error: 'not found' }, 404);
  if (!row.deleted_at) return json({ ok: true, already: true });

  const marker = await env.DB.prepare(
    `SELECT ref_id FROM case_content_removed WHERE kind = 'evidence' AND ref_id = ?`)
    .bind(eid).first();
  if (!marker) {
    return json({ error: 'This file was removed before the portal began keeping the original — '
      + 'its bytes were deleted from storage at the time, so the record can be read but the '
      + 'file cannot be put back.', code: 'bytes_gone' }, 409);
  }

  await env.DB.prepare('UPDATE case_evidence SET deleted_by = NULL, deleted_at = NULL WHERE id = ?')
    .bind(eid).run();
  await env.DB.prepare(`DELETE FROM case_content_removed WHERE kind = 'evidence' AND ref_id = ?`)
    .bind(eid).run();
  const logged = await logContentEvent(env, caseNo, 'evidence', eid, 'restored', user.id, reason);
  return json({ ok: true, id: eid, filename: row.filename,
                usage: await evidenceUsage(env), audit_recorded: logged });
}

/* ------------------------------------------------- integrity on demand

   TWO ADMIN ACTIONS AND NOTHING AUTOMATIC. Historical files are not swept, the
   dashboard verifies nothing, and opening a case reads metadata only. Bytes are
   re-read here and only here, because somebody pressed a button asking for it.

   Both are admin-only. An investigator SEES the integrity record for evidence
   they can already open — it rides with the workspace — but recording and
   verifying spend bandwidth against the firm's Dropbox and are office actions,
   the same boundary `editEvidence` already draws. */

/** The evidence row plus its live integrity record, or a Response to return. */
async function integrityTarget(env, user, caseNo, eid) {
  if (!(await caseFor(env, user, caseNo))) return { res: json({ error: 'not found' }, 404) };
  if (user.role !== 'admin') return { res: json({ error: ADMIN_ONLY }, 403) };
  if (await integrityMissing(env)) {
    return { res: json({ error: INTEGRITY_NOT_SET_UP, code: 'not_set_up' }, 503) };
  }
  /* SCOPED TO THE CASE IN THE SAME STATEMENT, so this route cannot be used to
     ask whether some other case's evidence id exists — the brief's "do not
     allow a hash endpoint to become a way to probe unrelated file existence".
     A row on another case answers exactly as a row that never existed. */
  const row = await env.DB.prepare(
    `SELECT id, case_no, r2_key, filename, content_type, size_bytes, uploaded_at, deleted_at
       FROM case_evidence WHERE id = ? AND case_no = ?`).bind(eid, caseNo).first();
  if (!row) return { res: json({ error: 'not found' }, 404) };
  return { row };
}

/* RECORD INTEGRITY HASH — the explicit backfill, one file at a time.

   This is the only way a file that was filed before this feature existed gets a
   hash, and it is deliberately a button rather than a migration: downloading
   every historical object to populate a table would spend the firm's bandwidth
   on a question nobody asked. */
async function recordEvidenceHash(env, user, caseNo, eid) {
  const t = await integrityTarget(env, user, caseNo, eid);
  if (t.res) return t.res;
  const row = t.row;
  /* Removed evidence keeps its record and its earlier hash; there are no bytes
     left to read, so there is nothing honest to record now. */
  if (row.deleted_at) {
    return json({ error: 'That file was removed from the case, so there are no bytes to hash. '
      + 'Any hash recorded before it was removed is still on the record.',
      code: 'deleted' }, 400);
  }
  const got = await artifactBytes(env, row);
  if (got.error === 'too_large') {
    return json({ error: `That file is larger than the ${Math.floor(got.cap / 1048576)} MB this `
      + 'can hold in one piece, so its hash cannot be computed here.',
      code: 'too_large', status: 'unavailable' }, 413);
  }
  if (got.error) {
    /* NOTHING IS WRITTEN. "Do not invent a hash" — a file the store will not
       give up leaves the record exactly as it was. */
    return json({ error: 'The stored file could not be read just now, so nothing was recorded. '
      + 'Its integrity status is unchanged.', code: got.why, status: 'unavailable' }, 503);
  }

  const existing = await integrityRow(env, 'evidence', row.id);
  const digest = await sha256Bytes(got.buf);
  const rec = await recordIntegrity(env, {
    case_no: caseNo, artifact_kind: 'evidence', artifact_id: row.id,
    filename: row.filename, content_type: row.content_type, byte_size: got.buf.byteLength,
    sha256: digest, hash_origin: 'worker',
    /* WHAT IT IS, NOT WHAT IT LOOKS LIKE. If this file is the stamped half of a
       recorded pair it is a derivative of the original that pair names — read
       from `photo_stamp`, which is an explicit relationship, never from the
       filename. Anything else is an original. */
    ...(await roleFromRecord(env, row.id)),
    storage_provider: storageOfKey(row.r2_key), storage_ref: row.r2_key,
    filed_at: row.uploaded_at || null, recorded_by: user.id,
  });
  if (!rec.ok) return json({ error: 'The hash could not be written.', code: rec.reason }, 500);
  return json({ ok: true, sha256: digest, byte_size: got.buf.byteLength,
                /* A RE-READ IS NAMED AS ONE, and it says whether the answer
                   changed — recording over a differing hash silently is the
                   thing the supersede history exists to prevent. */
                re_recorded: !!existing,
                ...(existing && existing.sha256
                    ? { previous_sha256: existing.sha256, changed: existing.sha256 !== digest }
                    : {}),
                integrity: await integrityRowOut(env, 'evidence', row.id) });
}

/** Whether an evidence row is an original or the derivative half of a recorded
    pair. The ONLY source is `photo_stamp` — an explicit relationship. */
async function roleFromRecord(env, evidenceId) {
  if ((await missingTables(env)).includes('photo_stamp')) {
    return { artifact_role: 'original' };
  }
  const pair = await env.DB.prepare(
    `SELECT p.original_id, e.filename FROM photo_stamp p
       LEFT JOIN case_evidence e ON e.id = p.original_id
      WHERE p.stamped_id = ? ORDER BY p.id DESC LIMIT 1`).bind(evidenceId).first();
  if (!pair) return { artifact_role: 'original' };
  return { artifact_role: 'derivative', derivative_type: 'timestamped_photo',
           source_kind: 'evidence', source_id: pair.original_id,
           source_ref: pair.filename || null };
}

async function integrityRowOut(env, kind, id) {
  const r = await integrityRow(env, kind, id);
  return r ? integrityOut(r, true) : null;
}

/* VERIFY INTEGRITY — does what is stored now still match what was recorded?

   IT WRITES NOTHING, deliberately. A stored "verified on the 3rd" would draw as
   a present-tense claim about bytes nobody has looked at since, which is the
   failure this project has already been bitten by in three other places. The
   answer is about NOW, so it is computed now and shown now. */
async function verifyEvidenceHash(env, user, caseNo, eid) {
  const t = await integrityTarget(env, user, caseNo, eid);
  if (t.res) return t.res;
  const row = t.row;
  const rec = await integrityRow(env, 'evidence', row.id);
  if (!rec || !rec.sha256) {
    return json({ status: 'not_recorded',
      message: 'No hash has been recorded for this file yet, so there is nothing to compare against.' });
  }
  if (row.deleted_at) {
    return json({ status: 'unavailable', recorded_sha256: rec.sha256,
      message: 'That file was removed from the case, so its current bytes cannot be read.' });
  }
  const got = await artifactBytes(env, row);
  if (got.error === 'too_large') {
    return json({ status: 'unavailable', recorded_sha256: rec.sha256, code: 'too_large',
      message: `That file is larger than the ${Math.floor(got.cap / 1048576)} MB this can hold in `
        + 'one piece, so it cannot be re-read here.' });
  }
  if (got.error) {
    /* UNAVAILABLE IS NOT A PASS. An unreadable file must never render as a
       match — that is a failsafe reporting the opposite of the truth. */
    return json({ status: 'unavailable', recorded_sha256: rec.sha256, code: got.why,
      message: 'The stored file could not be read just now, so nothing could be compared.' });
  }
  const digest = await sha256Bytes(got.buf);
  return json({
    status: digest === rec.sha256 ? 'match' : 'mismatch',
    recorded_sha256: rec.sha256, current_sha256: digest,
    byte_size: got.buf.byteLength, recorded_at: rec.recorded_at,
    message: digest === rec.sha256
      ? 'The current bytes match the hash recorded by this portal.'
      : 'The current bytes do NOT match the hash recorded by this portal.',
  });
}

/* THE EVIDENCE MANIFEST — composed from integrity metadata and the evidence
   rows beside it, on demand, admin-only.

   NO BYTES ARE READ TO BUILD IT and no Dropbox call is made: everything in it
   is already in D1. It carries no token, no credential and no share link —
   `storage_provider` says where the file lives and `storage_ref` is the path
   inside the firm's own App Folder, which is filing, not access. */
async function evidenceManifest(env, user, caseNo) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
  const missing = await missingTables(env);
  const haveIntegrity = !missing.includes('evidence_integrity');

  const { results: rows } = await env.DB.prepare(
    `SELECT e.id, e.filename, e.content_type, e.size_bytes, e.classification, e.entry_id,
            e.uploaded_at, e.deleted_at, e.r2_key, u.display_name AS uploaded_by
       FROM case_evidence e LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE e.case_no = ? ORDER BY e.id ASC LIMIT ?`).bind(caseNo, INTEGRITY_CAP).all();

  /* ONE STATEMENT for every integrity row on the case, then a pass over what is
     already in memory — never one lookup per file. */
  const byArtifact = new Map();
  if (haveIntegrity) {
    const { results: ints } = await env.DB.prepare(
      `SELECT e.*, u.display_name AS recorded_by_name
         FROM evidence_integrity e LEFT JOIN users u ON u.id = e.recorded_by
        WHERE e.case_no = ? AND e.superseded_at IS NULL
        ORDER BY e.id DESC LIMIT ?`).bind(caseNo, INTEGRITY_CAP).all();
    for (const r of ints || []) byArtifact.set(r.artifact_kind + ':' + r.artifact_id, r);
  }

  let n = 0;
  const items = (rows || []).map(e => {
    const r = byArtifact.get('evidence:' + e.id);
    return {
      n: ++n, evidence_id: e.id, filename: e.filename, content_type: e.content_type,
      byte_size: e.size_bytes, classification: e.classification,
      uploaded_by: e.uploaded_by || null, filed_at: e.uploaded_at || null,
      deleted_at: e.deleted_at || null,
      storage_provider: storageOfKey(e.r2_key),
      artifact_role: r ? r.artifact_role : null,
      derivative_type: r ? r.derivative_type : null,
      source_id: r ? r.source_id : null, source_ref: r ? r.source_ref : null,
      capture_at: r ? r.capture_at : null, generated_at: r ? r.generated_at : null,
      sha256: r ? r.sha256 : null, hash_origin: r ? r.hash_origin : null,
      recorded_at: r ? r.recorded_at : null,
      recorded_by: r ? (r.recorded_by_name || null) : null,
      /* THE STATUS IS DERIVED FROM WHAT IS RECORDED, not from a stored flag —
         so it cannot go stale, the same rule invoices already follow for
         `overdue`. Nothing here claims a file was verified: only that a hash
         is on record, or that none is. */
      status: r && r.sha256 ? 'recorded' : 'not_recorded',
    };
  });

  /* The artifacts that are NOT `case_evidence` rows — the filed report PDFs and
     the timestamped video copies — listed apart, because they are not case
     evidence and the manifest must not imply they are. */
  const others = [];
  if (haveIntegrity) {
    for (const [k, r] of byArtifact) {
      if (k.startsWith('evidence:')) continue;
      others.push({
        artifact_kind: r.artifact_kind, artifact_id: r.artifact_id, filename: r.filename,
        content_type: r.content_type, byte_size: r.byte_size, sha256: r.sha256,
        hash_origin: r.hash_origin, artifact_role: r.artifact_role,
        derivative_type: r.derivative_type, source_ref: r.source_ref,
        storage_provider: r.storage_provider, generated_at: r.generated_at,
        filed_at: r.filed_at, recorded_at: r.recorded_at,
        recorded_by: r.recorded_by_name || null,
      });
    }
    others.sort((a, b) => String(a.filed_at || '').localeCompare(String(b.filed_at || '')));
  }

  const sub = await env.DB.prepare(
    'SELECT case_no, client_name, subject_name, carrier, claim_number FROM submissions WHERE case_no = ?')
    .bind(caseNo).first();

  return json({
    case_no: caseNo,
    case: sub ? { client: sub.client_name, subject: sub.subject_name,
                  carrier: sub.carrier, claim_number: sub.claim_number } : null,
    items, other_artifacts: others,
    counts: {
      total: items.length,
      recorded: items.filter(i => i.status === 'recorded').length,
      not_recorded: items.filter(i => i.status === 'not_recorded').length,
      removed: items.filter(i => i.deleted_at).length,
    },
    /* NAMED RATHER THAN IMPLIED — the Unit 10 rule. A manifest built before the
       table arrived must not read as a case whose files have no hashes. */
    ...(haveIntegrity ? {} : { missing_sources: ['evidence_integrity'] }),
    generated_at: nowIso(),
  });
}

/* ------------------------------------------------- video timestamp records

   VIDEO IS DEVICE-FIRST (owner, 2026-08-17). Neither the original nor the
   timestamped derivative is stored here or in R2 — the original never leaves
   the investigator's device, the derivative is rendered in their own browser
   and saved back to their own device, and what the portal keeps is the RECORD
   that it happened. There is no blob column on `video_stamp` and there must
   never be one; nothing in this file reads or writes video bytes.

   This is the project's existing audit shape, not a new one: `send_log`,
   `build_events` and `invoice_events` are all append-only per-feature tables,
   and a correction inserts a row rather than editing one — the same reasoning
   that produced `activity_removed`.

   THE ACCESS BOUNDARY IS THE EVIDENCE BOUNDARY. Every route here goes through
   `caseFor`, so an investigator reaches only cases assigned to them and a
   record is never broadened by existing. */

const VSTAMP_NOT_SET_UP = 'Video timestamping is not set up on this database yet. '
  + 'Run the portal-setup workflow once and try again.';

/* An entered wall-clock time is meaningless without the zone it was entered in,
   so the zone is stored beside the instant and validated on the way in — a junk
   value would make the burned-in EST/EDT wording impossible to re-derive. */
function validZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

async function videoStampsFor(env, caseNo) {
  const { results } = await env.DB.prepare(
    `SELECT v.id, v.case_no, v.original_name, v.original_size, v.original_hash,
            v.start_utc, v.tz, v.derivative_name, v.generated_at, v.saved_at,
            v.superseded_at, v.created_at, u.display_name AS generated_by_name
       FROM video_stamp v LEFT JOIN users u ON u.id = v.generated_by
      WHERE v.case_no = ? ORDER BY v.id DESC`).bind(caseNo).all();
  return results || [];
}

async function listVideoStamps(env, user, caseNo) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  /* Degrades rather than 503s: this read feeds a panel inside the Evidence tab,
     and a missing table must not take the tab out — the same rule the archive
     read follows. The write route below is where the workflow is named. */
  if ((await missingTables(env)).includes('video_stamp')) {
    return json({ stamps: [], not_set_up: true });
  }
  return json({ stamps: await videoStampsFor(env, caseNo) });
}

async function recordVideoStamp(request, env, user, caseNo) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  if ((await missingTables(env)).includes('video_stamp')) {
    return json({ error: VSTAMP_NOT_SET_UP, code: 'not_set_up' }, 503);
  }
  const body = await readJson(request);

  const originalName = String(body.original_name || '').trim().slice(0, 240);
  if (!originalName) return json({ error: 'Name the video the copy was made from.' }, 400);

  const startRaw = String(body.start_utc || '');
  const startMs = Date.parse(startRaw);
  if (!Number.isFinite(startMs)) {
    return json({ error: 'Send the chosen start time as an instant the portal can read.' }, 400);
  }
  const tz = String(body.tz || 'America/New_York');
  if (!validZone(tz)) return json({ error: 'That is not a time zone this portal knows.' }, 400);

  const size = Number.isFinite(Number(body.original_size)) && Number(body.original_size) > 0
    ? Math.round(Number(body.original_size)) : null;
  /* A hash is recorded only when the browser could actually compute one. An
     absent hash is stored as absent — never as a placeholder, which would read
     as a fingerprint that had been checked. */
  const hash = /^[0-9a-f]{64}$/.test(String(body.original_hash || '')) ? String(body.original_hash) : null;
  const derivative = String(body.derivative_name || '').trim().slice(0, 240) || null;

  const now = nowIso();
  /* REGENERATION (brief §9). A corrected start time does not edit the row it
     corrects: the earlier records for this same original are stamped superseded
     and a new one is inserted, so "what was generated, when, and by whom"
     survives the correction and the ACTIVE derivative is the one row on this
     original with no `superseded_at`.

     Matched on the original's own name rather than a caller-supplied id: the
     operator picks a file from their device, so the file is what identifies the
     work, and a caller cannot supersede a record belonging to another original
     by naming its id. */
  await env.DB.prepare(
    'UPDATE video_stamp SET superseded_at = ? WHERE case_no = ? AND original_name = ? AND superseded_at IS NULL')
    .bind(now, caseNo, originalName).run();

  const res = await env.DB.prepare(
    `INSERT INTO video_stamp (case_no, original_name, original_size, original_hash, start_utc, tz,
       derivative_name, generated_by, generated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(caseNo, originalName, size, hash, new Date(startMs).toISOString(), tz,
          derivative, user.id, now, now).run();

  return json({ ok: true, id: res.meta ? res.meta.last_row_id : null,
                stamps: await videoStampsFor(env, caseNo) }, 201);
}

/* SAVED IS THE OPERATOR'S WORD, NOT AN ASSUMPTION. A browser cannot see where a
   download went, so nothing here is written when the file is generated — only
   when the save the operator started has actually completed, or when they
   confirm it did. A generated copy that was never saved therefore reads as not
   saved rather than as done.

   Written once. A second call is a no-op that succeeds: the moment the file
   reached the device is the FIRST one, and a repeat tap on a flaky connection
   must not move it. */
async function markVideoStampSaved(env, user, caseNo, id) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  if ((await missingTables(env)).includes('video_stamp')) {
    return json({ error: VSTAMP_NOT_SET_UP, code: 'not_set_up' }, 503);
  }
  const row = await env.DB.prepare('SELECT id, saved_at FROM video_stamp WHERE id = ? AND case_no = ?')
    .bind(id, caseNo).first();
  if (!row) return json({ error: 'not found' }, 404);
  if (!row.saved_at) {
    await env.DB.prepare('UPDATE video_stamp SET saved_at = ? WHERE id = ?').bind(nowIso(), id).run();
  }
  return json({ ok: true, stamps: await videoStampsFor(env, caseNo) });
}


/* ------------------------------------------------- photo timestamp records

   THE PHOTOGRAPH'S ANSWER TO THE SAME BRIEF, and it differs from video's in
   exactly one way, for exactly one reason. The owner's rules are unchanged —
   the original is never modified, the derivative is separate, the two are
   distinguishable, the burn is into the pixels — but video is device-first
   because video bytes must never become Cloudflare storage, and photographs
   have gone to the firm's own Dropbox since 2026-08-18. So the stamped
   photograph is STORED, in the case's own Photos folder, as an ordinary
   second `case_evidence` row.

   Which means this route creates no new storage architecture at all: it is the
   existing Dropbox upload plus a row saying which original the copy belongs to.
   The reasoning, and what is DERIVED rather than asked for, is in
   PHOTO-TIMESTAMP.md.

   TWO REFUSALS ARE LOAD-BEARING:

   1. The copy INHERITS the original's classification. Something held back as
      internal only, needs redaction or do not use must not become deliverable
      by the act of being timestamped — that would make this route a way around
      the package gate, which is the one thing the gate exists to stop.
   2. A timestamped copy cannot itself be stamped. Two burned faces on one
      picture is a document that asserts two different things about the same
      moment. */

const PSTAMP_NOT_SET_UP = 'Photo timestamping is not set up on this database yet. '
  + 'Run the portal-setup workflow once and try again.';

/* Where the burned instant came from, and it is provenance rather than
   decoration: 'exif' is the camera's own DateTimeOriginal, 'operator' is a
   person who typed it. An evidence timestamp whose origin is unrecorded is one
   nobody can defend later. */
const PHOTO_STAMP_SOURCES = ['exif', 'operator'];

async function photoStampsFor(env, caseNo) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.case_no, p.original_id, p.stamped_id, p.taken_utc, p.tz, p.source,
            p.generated_at, p.superseded_at, u.display_name AS generated_by_name
       FROM photo_stamp p LEFT JOIN users u ON u.id = p.generated_by
      WHERE p.case_no = ? ORDER BY p.id DESC`).bind(caseNo).all();
  return results || [];
}

async function recordPhotoStamp(request, env, user, caseNo) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  if ((await missingTables(env)).includes('photo_stamp')) {
    return json({ error: PSTAMP_NOT_SET_UP, code: 'not_set_up' }, 503);
  }

  let form;
  try { form = await request.formData(); } catch { return json({ error: 'Send the file as multipart form data.' }, 400); }
  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.size) return json({ error: 'Attach the timestamped copy.' }, 400);

  /* THE ORIGINAL IS LOOKED UP, NEVER TRUSTED FROM THE BODY. It has to be this
     case's, still present, and a picture — the pairing is meaningless
     otherwise, and a mistyped id must fail loudly rather than attach a copy to
     someone else's photograph. */
  const originalId = parseInt(form.get('original_id'), 10);
  if (!Number.isInteger(originalId)) return json({ error: 'Which photograph is this a copy of?' }, 400);
  const original = await env.DB.prepare(
    `SELECT id, filename, content_type, classification, entry_id, subject_id, deleted_at
       FROM case_evidence WHERE id = ? AND case_no = ?`).bind(originalId, caseNo).first();
  if (!original) return json({ error: 'That photograph is not on this case.' }, 400);
  if (original.deleted_at) return json({ error: 'That photograph has been removed from the case.' }, 400);
  if (!String(original.content_type || '').toLowerCase().startsWith('image/')) {
    return json({ error: 'Only a photograph can be timestamped this way. Video stays on the device — '
      + 'use Video timestamp for a clip.', code: 'not_a_photo' }, 400);
  }

  /* A COPY OF A COPY IS REFUSED BY NAME. Burning a second face onto an already
     stamped picture produces a document making two claims about one moment. */
  const isCopy = await env.DB.prepare(
    'SELECT id FROM photo_stamp WHERE stamped_id = ?').bind(originalId).first();
  if (isCopy) {
    return json({ error: 'That is already a timestamped copy. Timestamp the original instead, '
      + 'and this copy will be replaced.', code: 'already_a_copy' }, 400);
  }

  const takenMs = Date.parse(String(form.get('taken_utc') || ''));
  if (!Number.isFinite(takenMs)) return json({ error: 'That date and time cannot be read.' }, 400);
  const tz = String(form.get('tz') || 'America/New_York');
  if (!validZone(tz)) return json({ error: 'That time zone is not one this system knows.' }, 400);
  const source = String(form.get('source') || '');
  if (!PHOTO_STAMP_SOURCES.includes(source)) {
    return json({ error: 'Say where the date and time came from — the camera or the operator.' }, 400);
  }

  /* THE PACKAGE RULE (owner, 2026-08-18): *"Preserve the original untouched as
     case evidence, but do not automatically include both original and
     timestamped copy in the client package. Add 'Include timestamped copy in
     client package' default ON. Original keeps its existing classification
     unless Admin explicitly selects it."*

     The copy is the one that goes to the client, so ON means it is born with
     the original's classification and OFF means it is born held back. There is
     NO SECOND FLAG: package eligibility already IS
     `classification === 'client_deliverable'`, and a second source of truth for
     one question is how the two come to disagree. The classification is the
     record of what was chosen, and it stays correct when an admin changes their
     mind through the control that already exists.

     ON CANNOT WIDEN ANYTHING. A held-back original still produces a held-back
     copy — the inheritance ceiling is the package gate — and OFF on an original
     that was already held back inherits rather than rewriting `do_not_use` into
     the milder `internal_only`. The switch chooses between "as the original"
     and "held back", never "wider than the original".

     AND THE ORIGINAL IS NOT TOUCHED, here or anywhere else in this route. Its
     classification is the admin's, exactly as the owner said. */
  const askedInclude = form.get('include_copy');
  const includeCopy = askedInclude == null
    || !['0', 'false', 'no', 'off'].includes(String(askedInclude).trim().toLowerCase());
  const copyClass = (includeCopy || original.classification !== 'client_deliverable')
    ? original.classification : 'internal_only';

  const lim = storageLimits(env);
  if (file.size > lim.maxFileBytes) {
    return json({ error: `That copy is ${(file.size / 1048576).toFixed(1)} MB and the per-file limit is `
      + `${Math.floor(lim.maxFileBytes / 1048576)} MB.` }, 413);
  }

  /* The same three Dropbox conditions the ordinary upload names, in the same
     words, because it is the same store and a caller must not have to learn a
     second vocabulary for the same outage. */
  const problem = await dropboxStorageProblem(env);
  if (problem === 'provider_not_configured') {
    return json({ error: 'Dropbox is not set up on this Worker yet, and new case files are stored there. '
      + EXTERNAL_PROVIDERS.dropbox.note, code: problem }, 503);
  }
  if (problem) {
    return json({ error: 'No Dropbox account is connected, and new case files are stored there. '
      + 'An admin can connect one from the portal, then try this again.', code: problem }, 503);
  }
  const dbxToken = await dropboxAccessToken(env);
  if (!dbxToken) {
    await logStorageFailure(env, 'photo_stamp', caseNo, original.filename, 'dropbox_unreachable', user.id);
    return json({ error: 'Dropbox could not be reached just now, so the copy was not stored. '
      + 'Nothing was lost — try again in a moment.', code: 'dropbox_unreachable' }, 503);
  }

  const base = String(original.filename || 'photo').replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const filename = (base + '-timestamped.jpg').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120);
  await dropboxEnsureCaseFolders(env, dbxToken, caseNo);
  /* Held once and used twice — see the note in `uploadEvidence`. The digest is
     of THE COPY'S OWN BYTES: a timestamped derivative is a different file from
     its original and this route never claims the two match. */
  const buf = await file.arrayBuffer();
  const meta = await dropboxUpload(env, dbxToken,
    `/${caseNo}/Photos/${dropboxStoredName(filename)}`, buf);
  /* NOTHING IS RECORDED UNTIL THE BYTES ARE SAFE — and nothing about the
     original has been touched at any point above or below this line. */
  if (!meta) {
    await logStorageFailure(env, 'photo_stamp', caseNo, filename, 'dropbox_refused_upload', user.id);
    return json({ error: 'Dropbox refused the upload, so the copy was not stored. '
      + 'Nothing was lost — try again in a moment.', code: 'dropbox_unreachable' }, 503);
  }

  const now = nowIso();
  const res = await env.DB.prepare(
    `INSERT INTO case_evidence (case_no, r2_key, filename, content_type, size_bytes, classification,
       entry_id, subject_id, note, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(caseNo, DBX_KEY_PREFIX + meta.path_display, filename, 'image/jpeg', file.size,
          /* inherited, never widened — and held back outright when the office
             said not to send this copy. See the package rule above. */
          copyClass,
          /* the copy sits where the original sits, so the timeline and the
             subject card show the pair together rather than in two places */
          original.entry_id, original.subject_id, null, user.id, now).run();
  const stampedId = res.meta ? res.meta.last_row_id : null;

  /* A CORRECTION SUPERSEDES. Matched on the original's id, so no caller can
     supersede another photograph's stamp by naming it, and the earlier
     derivative's own evidence row is left exactly where it is — removing it
     would be a purge, and nothing here purges. */
  await env.DB.prepare(
    'UPDATE photo_stamp SET superseded_at = ? WHERE original_id = ? AND superseded_at IS NULL')
    .bind(now, originalId).run();
  await env.DB.prepare(
    `INSERT INTO photo_stamp (case_no, original_id, stamped_id, taken_utc, tz, source,
       generated_by, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(caseNo, originalId, stampedId, new Date(takenMs).toISOString(), tz, source, user.id, now).run();

  /* THE DERIVATIVE'S INTEGRITY RECORD, with the relationship stated rather than
     inferred: `source_id` is the original's evidence id — the same id the
     pairing itself is keyed on — never a guess from a similar filename. The
     capture instant is the one that was burned into the pixels, which is the
     only authoritative answer this route has, and `generated_at` is separate
     from it because when the picture was taken and when the copy was made are
     two different facts. */
  const integ = stampedId == null ? { ok: false, reason: 'no_row' }
    : await recordIntegrityForBytes(env, buf, {
        case_no: caseNo, artifact_kind: 'evidence', artifact_id: stampedId,
        filename, content_type: 'image/jpeg',
        artifact_role: 'derivative', derivative_type: 'timestamped_photo',
        source_kind: 'evidence', source_id: originalId, source_ref: original.filename || null,
        storage_provider: 'dropbox', storage_ref: meta.path_display,
        capture_at: new Date(takenMs).toISOString(), generated_at: now, filed_at: now,
        recorded_by: user.id,
      });

  /* Returned so the choice is observable and asserted rather than believed —
     the same reason every send route returns its `send_context`. */
  return json({ ok: true, id: stampedId, include_copy: includeCopy, classification: copyClass,
                photo_stamps: await photoStampsFor(env, caseNo),
                integrity: integ.ok ? 'recorded' : 'not_recorded',
                ...(integ.ok ? {} : { integrity_reason: integ.reason }),
                usage: await evidenceUsage(env) }, 201);
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
    /* The app's OWN credentials are secrets and are the prerequisite. Whether a
       connection exists on top of them is a separate question — `dropboxState`
       answers it — because "the app is set up" and "an admin has connected the
       company account" fail differently and the office needs to know which. */
    configured: env => Boolean(env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET),
    note: 'Add DROPBOX_APP_KEY and DROPBOX_APP_SECRET as Worker secrets, then an admin '
        + 'connects the company App Folder from Settings. Until then video delivery is '
        + 'arranged separately and nothing else waits.',
  },
};

/* ================= DROPBOX OAUTH — the company App Folder =================

   Owner, 2026-08-18: connect and callback, secrets only, and no file migration
   yet. This is the connection and nothing more — there is no upload, download,
   list or move route in this file, deliberately.

   THE LIVE REDIRECT URI, which is what the Dropbox App Console must be given:

       https://alwayspreciseinvestigations.net/portal-api/dropbox/callback

   It is derived, never typed: `SITE_ORIGIN` plus the Worker's own mount prefix.
   Dropbox matches the redirect string EXACTLY, so a hand-copied constant that
   drifts from the route is a failure that only shows up in production — and it
   is sent identically on the authorize and the token-exchange calls, which
   Dropbox also requires.

   SECRETS ONLY. `DROPBOX_APP_KEY` and `DROPBOX_APP_SECRET` are Worker secrets.
   Neither appears in this file, in `schema.sql`, in the page, or in any
   response — there is a test that greps for them.

   THE CSRF STATE RIDES IN A COOKIE, not a table. It is HttpOnly, Secure,
   SameSite=Lax and short-lived; Lax is correct because Dropbox returns the
   browser by a top-level GET navigation, which Lax permits and which a
   cross-site POST could not forge. The cookie is cleared the moment it is read,
   so a state is single-use.

   AND THE CALLBACK REQUIRES AN ADMIN SESSION of its own. The state proves the
   response belongs to a request this portal made; the session proves who is
   making it. Neither alone is enough: a state cookie without a session would
   let anyone who obtained the URL complete a connection, and a session without
   a state would accept an authorization code the portal never asked for. */

const DBX_STATE_COOKIE = 'dbx_oauth';
const DBX_STATE_TTL = 600;                  // ten minutes is long enough to sign in to Dropbox
/* App Folder apps are confined to their own folder by Dropbox, so these are the
   narrowest scopes that still let the delivery work land later. They are asked
   for now because re-authorising is a manual act by the owner and asking twice
   is worse than asking once. */
const DBX_SCOPES = 'account_info.read files.metadata.read files.metadata.write '
  + 'files.content.read files.content.write';

function dropboxRedirectUri(env) {
  const origin = String(env.SITE_ORIGIN || '').replace(/\/+$/, '');
  return `${origin}${API_PREFIX}/dropbox/callback`;
}

function dbxStateCookie(value, seconds) {
  return `${DBX_STATE_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; `
    + `Path=${API_PREFIX}/dropbox; Max-Age=${seconds}`;
}
/* THE CALLBACK CANNOT SEE THE SESSION, AND THAT IS NOT SOMETHING TO ROUTE
   AROUND BY WEAKENING THE SESSION.

   `sessionCookie` is SameSite=Strict on purpose. A browser does not attach a
   Strict cookie to a request that ANOTHER site navigated to, and dropbox.com
   sending the operator back here is exactly that — so `currentUser` saw no
   cookie and the callback answered "Not signed in" to an admin who was signed
   in in that very tab. Reported live, 2026-08-18.

   The tempting fix is Lax on the session cookie. That is the portal's CSRF
   defence (see `originAllowed`, which calls itself defence in depth BEHIND
   it), and every route in the Worker would pay for one OAuth return. So the
   callback carries its own credential instead: this cookie, which only
   /dropbox/connect mints and only for an admin. It holds the random state
   Dropbox echoes back, WHICH admin started the connect, when it expires, and
   an HMAC over all three.

   The signature is what makes the admin id worth trusting. HttpOnly stops a
   page writing this cookie, but that is a weaker claim than it sounds: a
   sibling subdomain can set a Domain= cookie that this Worker cannot tell
   apart from its own. Signed, a forged cookie cannot name an admin it did not
   come from. The key is DROPBOX_APP_SECRET — HMAC never exposes its key, the
   flow cannot run without that secret anyway, and reusing it means no new
   secret for the owner to set and no "key is missing" branch to get wrong. */
async function dbxSignState(env, state, uid, exp) {
  return hmacHex(String(env.DROPBOX_APP_SECRET || ''), `${state}.${uid}.${exp}`);
}

async function dbxStateValue(env, state, uid, exp) {
  return `${state}.${uid}.${exp}.${await dbxSignState(env, state, uid, exp)}`;
}

/* Split rather than matched. A regex built by string concatenation carried one
   backslash too many and compiled to a literal `\s`, so the cookie was never
   found and every callback failed the state check — a bug that reads as a
   security refusal and is really a typo. Splitting has nothing to escape. */
function dbxCookieRaw(request) {
  for (const part of String(request.headers.get('Cookie') || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== DBX_STATE_COOKIE) continue;
    return part.slice(at + 1).trim();
  }
  return '';
}

/** The state cookie, checked all the way through: shape, expiry, signature,
    and that Dropbox echoed back the same random half. Returns the id of the
    admin who started the connect, or null. Never throws, and never reports
    WHICH check failed — the caller says only "state". */
async function dbxVerifyState(env, request, echoed) {
  const raw = dbxCookieRaw(request);
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const [state, uid, exp, sig] = parts;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(state)) return null;
  if (!/^[0-9]{1,15}$/.test(uid)) return null;
  if (!/^[0-9]{1,15}$/.test(exp)) return null;
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  if (Number(exp) * 1000 < Date.now()) return null;
  if (typeof echoed !== 'string' || echoed !== state) return null;
  return sameHex(sig, await dbxSignState(env, state, uid, exp)) ? Number(uid) : null;
}

function redirectTo(url, extra = {}) {
  return new Response(null, { status: 302, headers: { Location: url, ...extra } });
}

/* ---- WHERE THE FIRM'S FILES ARE, AS A LINK AN ADMIN CAN OPEN ----

   Owner, 2026-08-18: the portal stores case files in Dropbox but said so
   nowhere. This is the visible half — connection, account, and a way through
   to the folder — and it is deliberately NOT a file manager: nothing here
   lists, renames, moves or downloads anything. The gallery already shows what
   is on a case, proxied through `serveEvidence` where the case's permission
   checks are.

   A DROPBOX WEB LINK IS NOT A SHARED LINK, and the difference is the whole
   safety of this. `https://www.dropbox.com/home/...` opens the FIRM'S OWN
   Dropbox in the browser of whoever clicks it: signed in to that account they
   see the folder, and signed in to any other account they see nothing. It
   carries no token and no bytes. `create_shared_link_with_settings` would be
   the opposite — a URL that hands the files to anyone holding it — and it is
   not called anywhere in this Worker. Do not add it.

   THE APP FOLDER NAME CANNOT BE DERIVED. This app has App-folder access, so
   every path the API returns is relative to that folder: `/API-1234/Photos`,
   never `/Apps/<name>/API-1234/Photos`. Dropbox does not tell an app-folder app
   what its own folder was called, and the web URL needs it. So an admin records
   it once, in `app_config` — an existing table, so no schema change and no
   portal-setup dispatch stands between this merging and it working.

   UNTIL THEY DO, THERE IS NO PER-CASE LINK. `case_url_template` is null rather
   than a guess: sending someone to a path that does not exist is worse than
   the Apps folder plus one click, which is what `web_url` falls back to. */

const DBX_WEB_HOME = 'https://www.dropbox.com/home';
const DBX_FOLDER_KEY = 'dropbox_folder';

/* Dropbox refuses these in a folder name, so a value carrying one was mistyped
   and would build a URL that goes nowhere. Named rather than stripped: silently
   editing what an admin typed is how a wrong value looks right. */
const DBX_NAME_BAD = /[\\\/:?*<>"|]/;

/** The one place the web URL's SHAPE is written. The page substitutes into the
    template; it never assembles a path of its own, so there is no second
    version of this to drift. */
function dropboxWebUrls(folderName) {
  const name = String(folderName || '').trim();
  if (!name) return { web_url: `${DBX_WEB_HOME}/Apps`, case_url_template: null };
  const base = `${DBX_WEB_HOME}/Apps/${encodeURIComponent(name)}`;
  return { web_url: base, case_url_template: `${base}/{case}/{folder}` };
}

/* What the office is told. Never the token — not here and not anywhere. */
async function dropboxState(env) {
  const out = {
    app_configured: EXTERNAL_PROVIDERS.dropbox.configured(env),
    redirect_uri: dropboxRedirectUri(env),
    connected: false, account_email: null, account_name: null,
    connected_at: null, scopes: null, source: null, not_set_up: false,
    /* The three per-case folders, sent rather than hard-coded in the page:
       `dropboxFolderFor` decides where an upload lands and this is the same
       list, so a fourth folder cannot appear in one place and not the other. */
    folders: DBX_FOLDERS.slice(),
    folder_name: null, web_url: null, case_url_template: null,
  };
  /* Read BEFORE the early returns. The folder name is what makes a link
     openable, and it is just as useful on a connection held as a Worker
     secret as on one an admin made.

     SWALLOWED ON PURPOSE, the way `dropboxAccessToken` and `sendMail` are: this
     function's whole job is to degrade rather than take the Settings screen
     down, and it now performs a read it did not before. The cost of losing it
     is a fallback to the Apps folder and no per-case link — never a link that
     goes somewhere wrong — while the connection state below still reports its
     own failures. */
  let folderName = null;
  try { folderName = await configValue(env, DBX_FOLDER_KEY, null); } catch { folderName = null; }
  out.folder_name = folderName || null;
  Object.assign(out, dropboxWebUrls(folderName));
  /* A refresh token supplied as a Worker SECRET still counts, and outranks the
     stored one. That path existed before this flow did, and an owner who has
     already pasted a token should not be told they are disconnected. */
  if (env.DROPBOX_REFRESH_TOKEN) {
    out.connected = true; out.source = 'worker secret';
    return out;
  }
  if ((await missingTables(env)).includes('dropbox_auth')) { out.not_set_up = true; return out; }
  const row = await env.DB.prepare(
    `SELECT d.account_email, d.account_name, d.scopes, d.connected_at, u.display_name AS by_name
       FROM dropbox_auth d LEFT JOIN users u ON u.id = d.connected_by WHERE d.id = 1`).first();
  if (row) {
    out.connected = true; out.source = 'connected by an admin';
    out.account_email = row.account_email; out.account_name = row.account_name;
    out.connected_at = row.connected_at; out.scopes = row.scopes;
    out.connected_by = row.by_name || null;
  }
  return out;
}

/* The refresh token, read for one purpose: minting a short-lived access token.
   It is never returned to a caller and never logged. */
async function dropboxRefreshToken(env) {
  if (env.DROPBOX_REFRESH_TOKEN) return env.DROPBOX_REFRESH_TOKEN;
  if ((await missingTables(env)).includes('dropbox_auth')) return null;
  const row = await env.DB.prepare('SELECT refresh_token FROM dropbox_auth WHERE id = 1').first();
  return row ? row.refresh_token : null;
}

function dropboxBasic(env) {
  return 'Basic ' + btoa(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`);
}

/* Access tokens are short-lived and are MINTED, never stored — there is nothing
   to leak later and nothing to go stale. Returns null rather than throwing, the
   way `sendMail` does: an outage here must not take a screen down. */
async function dropboxAccessToken(env) {
  if (!EXTERNAL_PROVIDERS.dropbox.configured(env)) return null;
  const refresh = await dropboxRefreshToken(env);
  if (!refresh) return null;
  try {
    const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { Authorization: dropboxBasic(env),
                 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return d.access_token || null;
  } catch { return null; }
}

async function buildEvent(env, buildId, user, action, detail) {
  await env.DB.prepare(
    'INSERT INTO build_events (build_id, action, detail, user_id, at) VALUES (?, ?, ?, ?, ?)')
    .bind(buildId, action, detail || null, user ? user.id : null, nowIso()).run();
}

/* ---- WHICH REPORTS A PACKAGE MAY CARRY (owner, 2026-08-19) ----

   "For an Admin who is assembling and delivering the case themselves, remove
   redundant approval barriers." The review flow exists for a HANDOFF — an
   investigator submits, the office signs off. A report whose day was worked
   by an ADMIN has no handoff in it: the author IS the office, and making them
   approve their own words back to themselves was ritual, not review.

   So the rule, in one place: a report is package-ready when it has been
   approved or delivered, OR when its author holds the admin role — decided by
   the author's CURRENT role, because "is there a reviewer above this person"
   is a question about now, not about the day the report was filed. An
   investigator's report still waits for the office however it arrives, and an
   investigator still cannot approve anything (`setReportStatus` is unchanged).

   Statuses stay the single record: finalize stamps any still-draft
   admin-authored report `approved` at the moment the package is sealed, so
   the completed desk, the dashboard and the badges never disagree with what
   actually shipped. */
async function latestShippableReport(env, caseNo) {
  return await env.DB.prepare(
    `SELECT r.id, r.report_date, r.status FROM case_reports r
      LEFT JOIN users u ON u.id = r.investigator_id
      WHERE r.case_no = ? AND (r.status IN ('approved', 'delivered') OR u.role = 'admin')
      ORDER BY r.report_date DESC, r.id DESC LIMIT 1`).bind(caseNo).first();
}

/* Every package-ready day on the case, oldest first — the order a reader
   expects Day 1, Day 2, Day 3 to appear in. */
async function shippableReports(env, caseNo) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.report_date, r.status, r.day_id FROM case_reports r
      LEFT JOIN users u ON u.id = r.investigator_id
      WHERE r.case_no = ? AND (r.status IN ('approved', 'delivered') OR u.role = 'admin')
      ORDER BY r.report_date ASC, r.id ASC`).bind(caseNo).all();
  return results || [];
}

/* MASTER §13 — a package carries the whole investigation. When a build is
   opened, every approved day is attached; the admin can drop one, and adding
   a later day is one click. Ordered by the day's own date, never by the order
   the office happened to approve them in. */
async function seedBuildReports(env, buildId, caseNo, user) {
  const reps = await shippableReports(env, caseNo);
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
            u.display_name AS investigator, u.role AS investigator_role,
            d.day_date, d.start_time, d.end_time, d.hours, d.miles, d.summary AS day_summary
       FROM build_reports br
       JOIN case_reports r ON r.id = br.report_id AND r.case_no = ?
       LEFT JOIN users u ON u.id = r.investigator_id
       LEFT JOIN case_days d ON d.id = r.day_id
      WHERE br.build_id = ?
      ORDER BY r.report_date ASC, br.sort ASC, r.id ASC`).bind(caseNo, buildId).all();
  return results || [];
}

/* ------------------------------------------------ UNIT 9: report templates

   SIX STYLES, ONE ENGINE. A template is a presentation choice — the document's
   title, its section headings, their order and which optional sections appear.
   It decides nothing about the facts: the report body, the evidence selection,
   the timestamps and the activity entries are the same records whichever one
   is chosen, and the document, the PDF, the print view and the Dropbox copy
   all still come from the one renderer.

   THE IDS ARE VALIDATED HERE and carry no CHECK in the schema, so a seventh
   style is an ordinary edit. `general` is the fallback and the format every
   report that exists today already prints in. */
const REPORT_TEMPLATES = ['surveillance', 'domestic', 'insurance', 'legal', 'process', 'general'];
const DEFAULT_TEMPLATE = 'general';

/* Which template a build is using. ABSENT MEANS GENERAL — every existing
   report has no row and must keep rendering exactly as it does. Guarded, like
   every table added after the live database existed. */
async function buildTemplate(env, buildId) {
  if ((await missingTables(env)).includes('build_template')) return DEFAULT_TEMPLATE;
  const row = await env.DB.prepare('SELECT template FROM build_template WHERE build_id = ?')
    .bind(buildId).first();
  const t = row && row.template;
  return REPORT_TEMPLATES.includes(t) ? t : DEFAULT_TEMPLATE;
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
        `SELECT r.id, r.report_date, r.status, r.body, u.role AS investigator_role
           FROM case_reports r LEFT JOIN users u ON u.id = r.investigator_id
          WHERE r.id = ? AND r.case_no = ?`)
        .bind(build.report_id, caseNo).first();
    }
    reports = await buildReports(env, build.id, caseNo);
    /* The authored daily-summary paragraph for each day this package carries
       (Unit 12) — attached to the report rows the document already renders,
       through ONE guarded statement on the build. Named `narrative` because
       `day_summary` on these rows is already the field day's own end-of-day
       note (case_days.summary), and two meanings under one key is how a
       document says the wrong thing politely. */
    if (reports.length && !(await missingTables(env)).includes('case_day_summary')) {
      const { results: dsRows } = await env.DB.prepare(
        `SELECT day_id, narrative FROM case_day_summary
          WHERE day_id IN (SELECT r.day_id FROM build_reports br
                             JOIN case_reports r ON r.id = br.report_id
                            WHERE br.build_id = ? AND r.day_id IS NOT NULL)`)
        .bind(build.id).all();
      /* UNIT 39 — a summary the office has removed does not print. The row
         still exists and is still restorable; the client document simply
         stops carrying a paragraph somebody struck out. Same shape as the
         removed-entry caption rule above it. */
      const dsGone = await contentRemovedSet(env, caseNo);
      const dsBy = new Map((dsRows || [])
        .filter(r => !dsGone.has(`day_summary:${r.day_id}`))
        .map(r => [r.day_id, r.narrative]));
      for (const r of reports) {
        const n = r.day_id != null ? dsBy.get(r.day_id) : null;
        if (n && String(n).trim()) r.narrative = n;
      }
    }
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
    /* UNIT 9 — the fields the subject and dates sections of a template draw
       from. Straight off the intake payload and the legal row, exactly as
       recorded: a template that has no value for one of these simply does not
       print that line, and none of them is ever filled with a placeholder. */
    subject_description: payload.subject_description || '',
    subject_address: payload.subject_address || '',
    vehicle: payload.vehicle || payload.subject_vehicle || '',
  } : null;
  /* The dates a firm actually gave us, when this is a legal matter and the
     table is there. Never derived from one another. */
  if (caseInfo && !(await missingTables(env)).includes('legal_intake')) {
    const li = await env.DB.prepare(
      'SELECT hearing_date, trial_date, deadline FROM legal_intake WHERE case_no = ?')
      .bind(caseNo).first();
    if (li) {
      caseInfo.hearing_date = li.hearing_date || '';
      caseInfo.trial_date = li.trial_date || '';
      caseInfo.deadline = li.deadline || '';
    }
  }

  /* WHAT CHANGED UNDER A FINISHED PACKAGE.

   The owner: "If deleting something changes an already-generated
   report/package, do not leave the old document looking current. Show a clear
   state such as SOURCE DATA CHANGED — REBUILD REQUIRED ... Do not silently
   rewrite a finalized historical report."

   BOTH HALVES MATTER AND THEY PULL AGAINST EACH OTHER. The document must not
   be rewritten, and it must not lie about being current. So nothing here
   touches the build: it reads the instants that already exist and answers
   whether any of them lands after the package was finalized.

   THE SOURCES ARE THE THREE THINGS THAT CAN LEAVE A CASE — content removals
   and restores (Unit 39's own trail), evidence deletions, and activity
   removals. A RESTORE COUNTS TOO: putting a photograph back after finalizing
   changes what the package would contain just as surely as taking one out,
   and a package that quietly gained an exhibit is the same defect wearing the
   opposite sign.

   `case_content_event` is the trail rather than `case_content_removed`,
   because the marker is deleted by a restore — reading state would make a
   remove-then-restore look like nothing ever happened, and the document in
   between is the one somebody may have sent. */
async function buildStaleness(env, caseNo, build) {
  /* 'finalized', not 'final' — the value the CHECK on case_builds.status
     actually allows. Written the other way first, which made this whole
     function return null on every package there is; the test that put a real
     package into the finalized state is what caught it. */
  if (!build || build.status !== 'finalized' || !build.finalized_at) return null;
  const at = build.finalized_at;
  const missing = await missingTables(env);
  const since = [];

  const ev = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM case_evidence WHERE case_no = ? AND deleted_at > ?')
    .bind(caseNo, at).first();
  if (Number(ev && ev.n) > 0) since.push(Number(ev.n) === 1 ? 'a file was removed from the case'
    : `${ev.n} files were removed from the case`);

  if (!missing.includes('activity_removed')) {
    const ar = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM activity_removed r
         JOIN activity_log a ON a.id = r.entry_id
        WHERE a.case_no = ? AND r.removed_at > ?`).bind(caseNo, at).first();
    if (Number(ar && ar.n) > 0) since.push(Number(ar.n) === 1 ? 'an activity entry was removed'
      : `${ar.n} activity entries were removed`);
  }

  if (!missing.includes('case_content_event')) {
    const { results } = await env.DB.prepare(
      `SELECT kind, action, COUNT(*) AS n FROM case_content_event
        WHERE case_no = ? AND at > ? GROUP BY kind, action`).bind(caseNo, at).all();
    const WORD = { day: 'investigation day', day_summary: 'daily summary', evidence: 'file',
                   note: 'note', comm: 'comm log entry', expense: 'expense',
                   subject: 'subject', vehicle: 'vehicle', task: 'task' };
    for (const r of results || []) {
      /* Evidence removals are already counted above from `deleted_at`, which
         is the state every other reader uses; counting the trail as well would
         say "2 files removed" about one file. Restores are NOT double-counted,
         because a restore clears `deleted_at` and leaves nothing for the query
         above to find — so they are named here and only here. */
      if (r.kind === 'evidence' && r.action === 'removed') continue;
      const what = WORD[r.kind] || r.kind;
      const verb = r.action === 'restored' ? 'put back' : 'removed';
      since.push(Number(r.n) === 1 ? `a ${what} was ${verb}` : `${r.n} ${what}s were ${verb}`);
    }
  }

  if (!since.length) return null;
  return {
    stale: true,
    label: 'SOURCE DATA CHANGED — REBUILD REQUIRED',
    finalized_at: at,
    /* WHAT changed, in the office's words, because "this is stale" without a
       reason is an alarm somebody learns to click past. */
    changes: since,
    /* Said out loud, because the owner's other limit is the reassuring half:
       the finished document was not touched. */
    note: 'The finalized package was not rewritten. Reopen it to rebuild with the case as it stands now.',
  };
}

/* Approved days not in the package — the admin adds a later day without
     rebuilding, and sees at a glance that one is missing. */
  const inPkg = new Set(reports.map(r => r.id));
  const available = (await shippableReports(env, caseNo)).filter(r => !inPkg.has(r.id));

  return {
    invoices: caseInvoices || [],
    build: build || null,
    /* UNIT 39 — SOURCE DATA CHANGED, REBUILD REQUIRED. Derived at read time,
       never stored: the owner's rule is that a document whose source moved
       must not go on looking current, and a stored flag is a second answer to
       a question the timestamps already answer. Invoice `overdue` and the
       retention ladder are the same shape.

       Only a FINALIZED build can be stale. One that is still open is being
       assembled — its contents changing is the point of it — and marking that
       "needs a rebuild" would be an alarm about somebody doing their job. */
    stale: await buildStaleness(env, caseNo, build),
    report: report ? { id: report.id, report_date: report.report_date, status: report.status,
                       body: report.body } : null,
    reports,
    available_reports: available,
    summary,
    custom,
    /* The chosen style. The page renders the document from this; nothing about
       the report's CONTENT is decided by it. */
    template: build ? await buildTemplate(env, build.id) : DEFAULT_TEMPLATE,
    templates: REPORT_TEMPLATES,
    package_type: build ? (custom ? 'custom' : build.package_type) : null,
    case_info: caseInfo,
    items: items || [],
    evidence: evidence || [],
    external_files: extRows || [],
    events: events || [],
    gates,
    approved_report: await latestShippableReport(env, caseNo),
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
    /* Two different situations were behind one message. "Approve a daily
       report first" told an ADMIN with no reports at all to approve something
       that did not exist — and told an admin whose own drafts now seed
       automatically nothing useful either. Say which it is. */
    const any = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM case_reports WHERE case_no = ?').bind(build.case_no).first();
    /* "Still with the investigator" would be wrong for a SUBMITTED report —
       that one is with the office. One sentence that is true of a draft and
       of a submission alike, and names the admin's own next act. */
    gates.push(Number(any && any.n)
      ? 'No report is attached — the daily reports on this case are not approved yet.'
      : 'No report is attached — generate a daily report first.');
  } else {
    for (const r of set) {
      /* The handoff rule (see latestShippableReport): an investigator's
         report waits for the office; an admin's own report does not. */
      if (!['approved', 'delivered'].includes(r.status) && r.investigator_role !== 'admin') {
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
/* ---------------------------------------------- delivery center (Unit 16)

   The owner's spec is CASEBUILD.md's own paragraph — "CLIENT DELIVERY panel:
   case, report ready, photos, videos, link active, invoice sent, delivery
   status" — and the audit against it is in case-portal/DELIVERY-CENTER.md.
   One bounded read over cases that have ever opened a package; children
   resolve through parent subqueries; delivery status is DERIVED from stamps
   case_builds already holds, never stored; and the video-link fact goes
   through the same classification-gated shape /completed uses, because a
   second looser copy of that rule is how evidence leaves by the back door. */

const DELIVERY_CAP = 60;

async function deliveryCenter(env) {
  const missing = await missingTables(env);
  const notArchived = missing.includes('case_archive') ? ''
    : 'AND s.case_no NOT IN (SELECT case_no FROM case_archive)';
  const notDeleted = missing.includes('case_deleted') ? ''
    : 'AND s.case_no NOT IN (SELECT case_no FROM case_deleted)';
  const { results } = await env.DB.prepare(
    `SELECT s.case_no, s.kind, s.client_name, s.carrier,
            b.id AS build_id, b.version, b.status AS build_status,
            b.finalized_at, b.delivered_at,
            uf.display_name AS finalized_by, ud.display_name AS delivered_by
       FROM submissions s
       JOIN case_builds b ON b.id = (
         SELECT id FROM case_builds WHERE case_no = s.case_no
          ORDER BY status = 'finalized' DESC, version DESC, id DESC LIMIT 1)
       LEFT JOIN users uf ON uf.id = b.finalized_by
       LEFT JOIN users ud ON ud.id = b.delivered_by
      WHERE 1=1 ${notArchived} ${notDeleted}
      ORDER BY COALESCE(b.delivered_at, b.finalized_at, '9999') DESC, b.id DESC
      LIMIT ?`).bind(DELIVERY_CAP).all();

  const out = [];
  for (const r of (results || [])) {
    const roleCounts = await env.DB.prepare(
      `SELECT role, COUNT(*) AS n FROM build_items WHERE build_id = ? GROUP BY role`)
      .bind(r.build_id).all();
    const counts = Object.fromEntries((roleCounts.results || []).map(x => [x.role, x.n]));
    const reports = Number(((await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM build_reports WHERE build_id = ?').bind(r.build_id).first()) || {}).n) || 0;
    const pdf = await env.DB.prepare(
      `SELECT at FROM build_events WHERE build_id = ? AND action = 'report_pdf_saved'
        ORDER BY id DESC LIMIT 1`).bind(r.build_id).first();
    /* The one link this desk may mention is the one /completed may hand out:
       uploaded, unrevoked, client-deliverable, and STILL IN the finalized
       package. Same statement shape, same reasons. */
    const link = r.build_status !== 'finalized' ? null : await env.DB.prepare(
      `SELECT x.id FROM external_files x
         JOIN case_evidence e ON e.id = x.evidence_id
        WHERE e.case_no = ? AND x.external_share_url IS NOT NULL
          AND x.share_revoked_at IS NULL AND x.upload_status = 'uploaded'
          AND e.deleted_at IS NULL AND e.classification = 'client_deliverable'
          AND EXISTS (SELECT 1 FROM build_items bi
                       WHERE bi.build_id = ? AND bi.evidence_id = x.evidence_id)
        LIMIT 1`).bind(r.case_no, r.build_id).first();
    const inv = await env.DB.prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN status IN ('sent_to_bill','sent_to_client','partially_paid','paid') THEN 1 ELSE 0 END) AS sent
         FROM invoices WHERE case_no = ? AND status != 'void'`).bind(r.case_no).first();
    const sends = missing.includes('send_log') ? null : await env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(sent_at) AS last FROM send_log
        WHERE case_no = ? AND ok = 1`).bind(r.case_no).first();
    out.push({
      case_no: r.case_no, kind: r.kind, client_name: r.client_name, carrier: r.carrier,
      build: { version: r.version, status: r.build_status,
        finalized_at: r.finalized_at, finalized_by: r.finalized_by,
        delivered_at: r.delivered_at, delivered_by: r.delivered_by },
      contents: { reports, photos: counts.photo || 0, videos: counts.video || 0,
        attachments: counts.attachment || 0 },
      pdf_filed_at: (pdf && pdf.at) || null,
      link_active: !!link,
      invoices: { total: Number(inv && inv.n) || 0, sent: Number(inv && inv.sent) || 0 },
      sends: sends ? { total: Number(sends.n) || 0, last: sends.last || null } : null,
    });
  }
  return { cases: out, cap: DELIVERY_CAP, generated_at: nowIso() };
}

async function completedCases(env) {
  /* THE COMPLETED DESK IS AN ORDINARY VIEW, so archived and deleted cases leave
     it too. "Leaves active views" would be a half-truth if a case the office
     archived kept appearing on the desk it reads to see what is finished.

     Both exclusions are guarded on the table existing, for the same
     deploy-order reason as the case list — this desk must not go down in the
     window between the Worker deploying and portal-setup being dispatched. */
  const missing = await missingTables(env);
  const notArchived = missing.includes('case_archive') ? ''
    : 'AND s.case_no NOT IN (SELECT case_no FROM case_archive)';
  const notDeleted = missing.includes('case_deleted') ? ''
    : 'AND s.case_no NOT IN (SELECT case_no FROM case_deleted)';
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
        ${notArchived}
        ${notDeleted}
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
    /* The completed desk offers this URL as "Copy video link", so it is a
       delivery path and carries the same rule as the package document — HIGH #4
       (2026-08-14). It filtered on the link alone: a video reclassified to
       do-not-use, or soft-deleted, kept its Copy button here long after the
       document stopped printing it. The evidence count two lines above already
       honours deleted_at; this did not.

       Membership is the third condition, and the one that makes this agree with
       the package panel, which has always required it (`inPkg`). This desk is
       the archive of DELIVERED work, so the only link it may hand out is one
       belonging to material actually selected into the finalized package. A
       file merely sitting on the case — never chosen, or chosen and then taken
       out again — is not part of what the client received, and offering its
       link here would deliver by the back door exactly what the build screen
       declined to put in the front. No finalized build means no package
       delivery, so `build_id` being NULL yields no link at all. */
    const share = await env.DB.prepare(
      `SELECT x.external_share_url FROM external_files x
         JOIN case_evidence e ON e.id = x.evidence_id
        WHERE e.case_no = ? AND x.external_share_url IS NOT NULL
          AND x.share_revoked_at IS NULL AND x.upload_status = 'uploaded'
          AND e.deleted_at IS NULL AND e.classification = 'client_deliverable'
          AND EXISTS (SELECT 1 FROM build_items bi
                       WHERE bi.build_id = ? AND bi.evidence_id = x.evidence_id)
        ORDER BY x.id DESC LIMIT 1`).bind(c.case_no, c.build_id).first();
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

  /* PACKAGES IS A WORKING VIEW TOO, and it was the last case-scoped read that
     did not say so. `caseSummary`, `outNow` and the calendar all filter through
     `hiddenCases()`, and `/completed` excludes both sets in its own SQL — this
     one excluded neither, so an archived case kept its place on the dashboard's
     Case packages band with its retainer and balance on it, and could reach
     Today / next actions through the `retainer` and `build` sets that read this
     payload. Out of the views and out of the work go together.

     Filtered HERE, above the per-case loop, so a hidden case also stops costing
     the seven queries below it. The same helper the other three call — the rule
     lives in one place, and a `NOT IN` written into this query would be the
     second copy that gets forgotten the day a third hidden state exists. */
  const hidden = await hiddenCases(env);
  const visible = (rows || []).filter(c => !hidden.has(c.case_no));

  const packages = [];
  for (const c of visible) {
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
                                   received: auth.retainer.received,
                                   /* The card's money words follow the model
                                      (LEGAL-SERVICES.md D7). */
                                   model: auth.retainer.model,
                                   service_label: auth.retainer.service_label } : null;
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
  /* The resume arm deliberately carries NO tombstone/archive exclusion. A
     running day blocks both markers at their own routes ("a day still running
     is refused, naming the day") and blocks the intake hard-delete as a
     protected dependent, so an open day can never point at a hidden case —
     and a filter here would be the one way to strand a legitimately running
     day's clock behind a screen that no longer offers it. */
  const row = await env.DB.prepare(
    `SELECT d.id, d.case_no, d.day_date, d.start_time, d.start_mileage,
            d.created_at AS started_at, s.kind, s.subject_name
       FROM case_days d JOIN submissions s ON s.case_no = d.case_no
      WHERE d.investigator_id = ? AND d.end_time IS NULL
      ORDER BY d.id DESC LIMIT 1`).bind(user.id).first();
  if (!row) {
    /* Nothing running: the launcher offers the assignments they could start.
       Tombstoned and archived cases are excluded HERE, in the SQL — the same
       rule outNow states one function down. This arm used to skip it, so a
       case the office deleted or archived weeks earlier was still offered on
       the home-screen launcher as a startable assignment (found live,
       2026-09-02). The exclusion sits BEFORE the LIMIT on purpose: filtering
       the 25 rows after the read would let a page of hidden cases empty the
       launcher while live assignments wait beyond the cap. Starting a day on
       a hidden case was already refused at the route chokepoint; this makes
       the offer agree with the gate instead of advertising what the gate
       refuses. Guarded like every read that touches the marker tables — a
       database portal-setup has not reached degrades to the unfiltered list,
       never to a 500 on the field's own screen. */
    const missing = await missingTables(env);
    const notArchived = missing.includes('case_archive') ? ''
      : 'AND s.case_no NOT IN (SELECT case_no FROM case_archive)';
    const notDeleted = missing.includes('case_deleted') ? ''
      : 'AND s.case_no NOT IN (SELECT case_no FROM case_deleted)';
    const { results } = await env.DB.prepare(
      `SELECT s.case_no, s.kind, s.subject_name, st.stage
         FROM submissions s LEFT JOIN case_status st ON st.case_no = s.case_no
        WHERE s.status != 'closed' ${notArchived} ${notDeleted}
              ${user.role === 'admin' ? '' : 'AND s.assigned_to = ?'}
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
  /* Out now is an ordinary working view, so an archived or deleted case does
     not belong on it — a day left running on a case the office removed would
     otherwise keep announcing itself here for ever. */
  const hidden = await hiddenCases(env);
  const out = [];
  for (const d of (results || []).filter(d => !hidden.has(d.case_no))) {
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

/* Every table a TEST- case can leave a row in, children before parents.
   THE LIST IS THE FEATURE, and it is written out rather than derived.

   The first version named five tables — activity_log, case_reports, case_days,
   case_meta, submissions — and a demo case can put rows in twenty-six. So
   pressing "Remove test cases" on a case anyone had actually WORKED deleted
   the submission and left its invoices, evidence, packages, builds, subjects,
   phone numbers, tasks and send history behind: rows whose case_no no longer
   matched anything, invisible in every view precisely because every view joins
   through submissions, and impossible to find again from the UI. The button
   whose entire promise is "removed cleanly" was the one manufacturing orphans.

   Worse, the evidence rows survived, and the storage meter is
   SUM(size_bytes) WHERE deleted_at IS NULL over case_evidence with no join to
   a case — so a cleared demo case went on consuming the free-tier allowance
   the cap exists to protect, with nothing on screen to explain why.

   Rules this obeys:

   - TEST- is written into EVERY statement. The prefix is the whole safety
     mechanism; a scope computed once and passed around is a scope one edit
     away from being wrong, and this runs next to live work.
   - Children resolve through a subquery on their parent, so a child row is
     matched by whose case it belongs to and never by a prefix of its own.
   - ORDER IS LOAD-BEARING. activity_log, case_reports and case_expenses all
     carry day_id REFERENCES case_days(id), so case_days goes after all three
     or D1 rejects the batch on a foreign key.
   - Tables the database does not have are skipped. Cleanup has to work on a
     half-applied schema — that is exactly the state that strands test rows,
     and "run an unrelated workflow first" would be the wrong way round.
   - The R2 objects go too. Deleting only the D1 row would clear the meter
     while the bytes stayed on the account, which is the failsafe reporting
     the opposite of the truth. */
const DEMO_LIKE = 'TEST-%';

/* =============================== DASH-DELETE: QUICK DELETE FOR FRESH INTAKES

   The owner's quick delete is a HARD delete, and the dependency guard is what
   makes that compatible with the standing "Delete Case is a tombstone, no
   purge" decision: it refuses — naming what it found — the moment the intake
   carries ANY dependent record, so the only thing it can ever destroy is the
   intake's own paperwork. The dictated confirmation ("This cannot be undone")
   is then TRUE, which is the standard every screen here is held to. A
   developed case's answer is the existing workflow: tombstone delete or
   archive, both recoverable.

   EVERY case-scoped table is classified into exactly one of the three lists
   below, and a test derives the case-scoped inventory from DEMO_SWEEP and
   fails on an unclassified table — the sweep-completeness pattern applied a
   second time, so a future table cannot quietly escape the guard. */

/* What intake creation and lead-desk handling themselves write — the only
   rows the quick delete removes. Each statement is skipped when its table has
   not arrived on the live database; submissions goes LAST (the parent every
   view joins through); the whole set runs as one D1 batch, one transaction. */
const INTAKE_OWNED = [
  ['case_comms',    'DELETE FROM case_comms    WHERE case_no = ?1'],
  ['feed_hidden',   'DELETE FROM feed_hidden   WHERE case_no = ?1'],
  ['case_profile',  'DELETE FROM case_profile  WHERE case_no = ?1'],
  ['case_phone',    'DELETE FROM case_phone    WHERE case_no = ?1'],
  ['case_retainer', 'DELETE FROM case_retainer WHERE case_no = ?1'],
  ['case_meta',     'DELETE FROM case_meta     WHERE case_no = ?1'],
  ['case_status',   'DELETE FROM case_status   WHERE case_no = ?1'],
  ['lead_status',   'DELETE FROM lead_status   WHERE case_no = ?1'],
  ['legal_intake',  'DELETE FROM legal_intake  WHERE case_no = ?1'],
  ['submissions',   'DELETE FROM submissions   WHERE case_no = ?1'],
];

/* A row in ANY of these means the intake became a real case: refuse and name
   it. Children that cannot exist without one of these parents (invoice lines,
   build items, activity media, day pauses…) are blocked through the parent. */
const INTAKE_BLOCKERS = [
  ['case_days',            'an investigation day'],
  ['activity_log',         'activity entries'],
  ['activity_voice_event', 'voice activity events'],
  ['case_evidence',        'case media'],
  ['photo_stamp',          'a timestamped photo record'],
  ['video_stamp',          'a timestamped video record'],
  ['evidence_integrity',   'integrity records'],
  ['case_reports',         'a report'],
  ['case_day_summary',     'a daily summary'],
  ['case_day_end',         'a day-end record'],
  ['invoices',             'an invoice'],
  ['case_builds',          'a client package'],
  ['retainer_payment',     'a recorded retainer payment'],
  ['retainer_payment_token', 'a retainer payment in progress'],
  ['retainer_receipt',     'a recorded retainer receipt'],
  ['case_expenses',        'expenses'],
  ['case_tasks',           'tasks'],
  ['case_notes',           'internal notes'],
  ['case_subjects',        'curated subject records'],
  ['case_offers',          'an assignment offer'],
  ['case_closure',         'a closing record'],
  ['case_details',         'curated case details'],
  ['case_settings',        'case billing settings'],
  ['case_retention',       'a retention setting'],
  ['retention_event',      'retention history'],
  ['case_content_removed', 'content-removal records'],
  ['case_content_event',   'content-removal history'],
  ['storage_failure',      'storage-failure records'],
];

/* Neither deleted nor blocking, each with its reason on the record. The
   completeness test reads these keys. */
const INTAKE_EXEMPT = {
  alert_failure: 'alert history is non-deletable, and a failed alert about a duplicate must not make it immortal',
  /* OWNER RULE, 2026-09-02: sending a rate sheet, an intake link or payment
     instructions ALONE must not make a disposable duplicate undeletable —
     and send history is non-deletable by the owner's standing limit. So
     these rows neither block nor die: they stay, describing sends that
     really happened, exactly like a pre-case send whose reference resolves
     to nothing. */
  send_log: 'send history is non-deletable and a send alone must not block deletion',
  payment_send: 'send history is non-deletable and a send alone must not block deletion',
  /* Unit 4: a SIMULATED — NOT SENT rehearsal is Beta audit history — kept for
     the same reason the send log is kept, and a dry run about a duplicate
     must not make the duplicate immortal. */
  assistant_log: 'the Beta audit trail is non-deletable and a simulation alone must not block deletion',
  case_archive: 'the archived gate refuses this route before any list is consulted',
  case_deleted: 'the deleted gate refuses this route before any list is consulted',
  legal_hold: 'the hold refusal runs before any list is consulted',
  activity_media: 'child of activity_log', activity_removed: 'child of activity_log',
  activity_source: 'child of activity_log',
  case_day_pauses: 'child of case_days',
  report_versions: 'child of case_reports',
  build_items: 'child of case_builds', build_reports: 'child of case_builds',
  build_summary: 'child of case_builds', build_custom: 'child of case_builds',
  build_events: 'child of case_builds', build_template: 'child of case_builds',
  external_files: 'child of case_evidence',
  invoice_lines: 'child of invoices', invoice_payments: 'child of invoices',
  invoice_events: 'child of invoices', invoice_retainer: 'child of invoices',
  invoice_payment_token: 'child of invoices', invoice_payment_void: 'child of invoices',
  retainer_payment_void: 'child of retainer_payment',
  subject_vehicles: 'child of case_subjects',
};

/* The blocker probe, extracted so the DELETE and the EXPLANATION cannot
   drift: the Assistant's "why can't I delete this?" (Unit 7) names exactly
   what this route would refuse over, because it runs the same statement.

   One statement, constant shape: a UNION of EXISTS probes, one per present
   blocker table. Nothing here grows with the customer's data.

   THE BINDS ARE COUNTED EXACTLY — one anonymous `?` per arm, one value per
   `?` — because the first version reused `?1` across every arm with a
   single bound value, which node:sqlite accepts and LIVE D1 REFUSED: the
   route 500'd on the owner's first real delete while every suite was
   green. The same class as the 401-parameter statement Unit 7 paid for —
   a shape the test database tolerates and production does not. A test
   pins this builder to anonymous binds. */
async function intakeBlockersFound(env, caseNo) {
  const missing = await missingTables(env);
  const arms = INTAKE_BLOCKERS.filter(([t]) => !missing.includes(t));
  const sql = arms.map(([t]) =>
    `SELECT '${t}' AS t WHERE EXISTS (SELECT 1 FROM ${t} WHERE case_no = ?)`)
    .join(' UNION ALL ');
  return sql
    ? (await env.DB.prepare(sql).bind(...arms.map(() => caseNo)).all()).results.map(r => r.t)
    : [];
}

async function intakeDelete(env, user, caseNo) {
  const sub = await env.DB.prepare(
    'SELECT case_no, client_name FROM submissions WHERE case_no = ?').bind(caseNo).first();
  if (!sub) return json({ error: 'not found' }, 404);

  /* THE HOLD OUTRANKS (Unit 17, decision 5) — and a hard delete is the most
     destructive act this Worker has, so it is refused first and by name. */
  const hold = await activeHold(env, caseNo);
  if (hold) {
    return json({ error: 'This case is under a legal hold — deleting is blocked until the '
      + 'hold is released.', code: 'legal_hold' }, 409);
  }

  const missing = await missingTables(env);
  const found = await intakeBlockersFound(env, caseNo);
  if (found.length) {
    const what = INTAKE_BLOCKERS.filter(([t]) => found.includes(t)).map(([, w]) => w);
    return json({
      error: `${caseNo} has become a real case — it carries ${what.slice(0, 4).join(', ')}`
        + `${what.length > 4 ? ` and ${what.length - 4} more kinds of record` : ''}. `
        + 'The quick delete is for fresh intakes only. To take it off the desk without '
        + 'destroying anything, open the case and use Archive or Delete case '
        + '(Billing & closing) — both remove it from every list and both can be undone.',
      code: 'intake_developed', dependents: found, use_case_workflow: true,
    }, 409);
  }

  const owned = INTAKE_OWNED.filter(([t]) => !missing.includes(t));
  const results = await env.DB.batch(owned.map(([, q]) => env.DB.prepare(q).bind(caseNo)));
  const removed = {};
  owned.forEach(([t], i) => {
    const n = results[i] && results[i].meta ? results[i].meta.changes || 0 : 0;
    if (n) removed[t] = n;
  });
  return json({ ok: true, case_no: caseNo, deleted: true, removed,
                client_name: sub.client_name || null });
}

const DEMO_SWEEP = [
  /* --- children, addressed through their parent's id --- */
  ['activity_media',        'DELETE FROM activity_media WHERE entry_id IN (SELECT id FROM activity_log WHERE case_no LIKE ?)'],
  ['activity_removed',      'DELETE FROM activity_removed WHERE entry_id IN (SELECT id FROM activity_log WHERE case_no LIKE ?)'],
  ['activity_source',       'DELETE FROM activity_source WHERE entry_id IN (SELECT id FROM activity_log WHERE case_no LIKE ?)'],
  /* BOTH WAYS ROUND, because this one carries a case_no of its own AND hangs
     off an activity_log row. The parent subquery is the rule for children; the
     direct match catches a row whose parent has already gone. ?1 twice, one
     bind, because the sweep binds a single value. */
  ['activity_voice_event',  'DELETE FROM activity_voice_event WHERE case_no LIKE ?1 OR entry_id IN (SELECT id FROM activity_log WHERE case_no LIKE ?1)'],
  ['case_day_pauses',       'DELETE FROM case_day_pauses WHERE day_id IN (SELECT id FROM case_days WHERE case_no LIKE ?)'],
  ['build_items',           'DELETE FROM build_items WHERE build_id IN (SELECT id FROM case_builds WHERE case_no LIKE ?)'],
  ['build_events',          'DELETE FROM build_events WHERE build_id IN (SELECT id FROM case_builds WHERE case_no LIKE ?)'],
  ['build_reports',         'DELETE FROM build_reports WHERE build_id IN (SELECT id FROM case_builds WHERE case_no LIKE ?)'],
  ['build_summary',         'DELETE FROM build_summary WHERE build_id IN (SELECT id FROM case_builds WHERE case_no LIKE ?)'],
  ['build_custom',          'DELETE FROM build_custom WHERE build_id IN (SELECT id FROM case_builds WHERE case_no LIKE ?)'],
  ['build_template',        'DELETE FROM build_template WHERE build_id IN (SELECT id FROM case_builds WHERE case_no LIKE ?)'],
  ['external_files',        'DELETE FROM external_files WHERE evidence_id IN (SELECT id FROM case_evidence WHERE case_no LIKE ?)'],
  ['invoice_lines',         'DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE case_no LIKE ?)'],
  /* Unit 18 — both point AT a payment, so they go before the payments they
     guard, and each resolves through its own parent invoice. */
  ['invoice_payment_void',  'DELETE FROM invoice_payment_void WHERE payment_id IN (SELECT p.id FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.case_no LIKE ?)'],
  ['invoice_payment_token', 'DELETE FROM invoice_payment_token WHERE invoice_id IN (SELECT id FROM invoices WHERE case_no LIKE ?)'],
  ['invoice_payments',      'DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE case_no LIKE ?)'],
  ['invoice_events',        'DELETE FROM invoice_events WHERE invoice_id IN (SELECT id FROM invoices WHERE case_no LIKE ?)'],
  ['invoice_retainer',      'DELETE FROM invoice_retainer WHERE invoice_id IN (SELECT id FROM invoices WHERE case_no LIKE ?)'],
  ['report_versions',       'DELETE FROM report_versions WHERE report_id IN (SELECT id FROM case_reports WHERE case_no LIKE ?)'],
  ['subject_vehicles',      'DELETE FROM subject_vehicles WHERE subject_id IN (SELECT id FROM case_subjects WHERE case_no LIKE ?)'],
  ['retainer_payment_void', 'DELETE FROM retainer_payment_void WHERE payment_id IN (SELECT id FROM retainer_payment WHERE case_no LIKE ?)'],

  ['storage_failure',       'DELETE FROM storage_failure WHERE case_no LIKE ?'],
  ['case_retention',        'DELETE FROM case_retention WHERE case_no LIKE ?'],
  ['legal_hold',            'DELETE FROM legal_hold WHERE case_no LIKE ?'],
  ['retention_event',       'DELETE FROM retention_event WHERE case_no LIKE ?'],
  ['alert_failure',         'DELETE FROM alert_failure WHERE case_no LIKE ?'],
  ['feed_hidden',           'DELETE FROM feed_hidden WHERE case_no LIKE ?'],
  /* UNIT 39. Both carry their own case_no and neither carries a foreign key —
     `ref_id` is deliberately not one, because the table is keyed by (kind,
     ref_id) across eight different parents. So they need no ordering against
     anything; they are here with the other case_no-keyed rows. */
  ['case_content_removed',  'DELETE FROM case_content_removed WHERE case_no LIKE ?'],
  ['case_content_event',    'DELETE FROM case_content_event WHERE case_no LIKE ?'],
  /* --- the four that reference case_days, before case_days itself --- */
  ['case_day_summary',      'DELETE FROM case_day_summary WHERE case_no LIKE ?'],
  /* Before `case_days`, like every other day child — it carries no foreign
     key, but the ordering rule here is whose parent goes last. */
  ['case_day_end',          'DELETE FROM case_day_end WHERE case_no LIKE ?'],
  ['activity_log',          'DELETE FROM activity_log WHERE case_no LIKE ?'],
  ['case_reports',          'DELETE FROM case_reports WHERE case_no LIKE ?'],
  ['case_expenses',         'DELETE FROM case_expenses WHERE case_no LIKE ?'],
  ['case_days',             'DELETE FROM case_days WHERE case_no LIKE ?'],

  /* --- photo_stamp points at case_evidence TWICE, so it goes first --- */
  ['photo_stamp',           'DELETE FROM photo_stamp WHERE case_no LIKE ?'],
  /* Integrity records go with the case they describe — a hash of a deleted test
     file is not evidence of anything. Before case_evidence, which it points at. */
  ['evidence_integrity',    'DELETE FROM evidence_integrity WHERE case_no LIKE ?'],
  ['legal_intake',          'DELETE FROM legal_intake WHERE case_no LIKE ?'],
  /* The LINK goes, the PROFILE stays. A link is case data; a firm is
     reference data that other cases still point at, so clearing a test case
     must not delete a real client. `profile`, `profile_contact` and
     `profile_phone` are deliberately absent from this list. */
  ['case_profile',          'DELETE FROM case_profile WHERE case_no LIKE ?'],

  /* --- everything else keyed by case_no --- */
  ['case_evidence',         'DELETE FROM case_evidence WHERE case_no LIKE ?'],
  ['case_builds',           'DELETE FROM case_builds WHERE case_no LIKE ?'],
  ['invoices',              'DELETE FROM invoices WHERE case_no LIKE ?'],
  ['case_subjects',         'DELETE FROM case_subjects WHERE case_no LIKE ?'],
  ['case_meta',             'DELETE FROM case_meta WHERE case_no LIKE ?'],
  ['case_status',           'DELETE FROM case_status WHERE case_no LIKE ?'],
  ['case_closure',          'DELETE FROM case_closure WHERE case_no LIKE ?'],
  ['case_archive',          'DELETE FROM case_archive WHERE case_no LIKE ?'],
  ['case_deleted',          'DELETE FROM case_deleted WHERE case_no LIKE ?'],
  ['lead_status',           'DELETE FROM lead_status WHERE case_no LIKE ?'],
  ['case_phone',            'DELETE FROM case_phone WHERE case_no LIKE ?'],
  ['case_retainer',         'DELETE FROM case_retainer WHERE case_no LIKE ?'],
  ['case_tasks',            'DELETE FROM case_tasks WHERE case_no LIKE ?'],
  ['case_notes',            'DELETE FROM case_notes WHERE case_no LIKE ?'],
  ['case_details',          'DELETE FROM case_details WHERE case_no LIKE ?'],
  ['case_comms',            'DELETE FROM case_comms WHERE case_no LIKE ?'],
  ['case_offers',           'DELETE FROM case_offers WHERE case_no LIKE ?'],
  ['case_settings',         'DELETE FROM case_settings WHERE case_no LIKE ?'],
  ['retainer_payment',      'DELETE FROM retainer_payment WHERE case_no LIKE ?'],
  ['retainer_receipt',      'DELETE FROM retainer_receipt WHERE case_no LIKE ?'],
  ['retainer_payment_token','DELETE FROM retainer_payment_token WHERE case_no LIKE ?'],
  ['send_log',              'DELETE FROM send_log WHERE case_no LIKE ?'],
  ['payment_send',          'DELETE FROM payment_send WHERE case_no LIKE ?'],
  /* Unit 4: a TEST- case's rehearsals go with it. Pre-case simulations carry a
     null case_no and are untouched, like a pre-case send. */
  ['assistant_log',         'DELETE FROM assistant_log WHERE case_no LIKE ?'],
  ['video_stamp',           'DELETE FROM video_stamp WHERE case_no LIKE ?'],

  /* --- the spine, last --- */
  ['submissions',           'DELETE FROM submissions WHERE case_no LIKE ?'],
];

/* Tables holding a case_no that DEMO_SWEEP must account for. The regression
   test reads this and fails when the schema gains a case-scoped table nobody
   added to the sweep — which is the only way this drifts back out of date. */
const DEMO_CASE_SCOPED = DEMO_SWEEP
  .filter(([, sql]) => /WHERE case_no LIKE \?$/.test(sql))
  .map(([t]) => t);

async function clearDemoCases(env) {
  const missing = await missingTables(env);

  /* The bucket first, and read the keys before anything is deleted — once the
     case_evidence rows are gone there is no way left to find the objects, and
     an unreferenced object in R2 is billable weight nobody can see. */
  let objects = 0;
  if (env.EVIDENCE && !missing.includes('case_evidence')) {
    try {
      const { results } = await env.DB.prepare(
        'SELECT r2_key FROM case_evidence WHERE case_no LIKE ?').bind(DEMO_LIKE).all();
      const dbxToken = (results || []).some((r) => isDropboxKey(r.r2_key))
        ? await dropboxAccessToken(env) : null;
      for (const row of results || []) {
        /* One failed object must not strand the other twenty. The database
           sweep below runs either way: a row pointing at an object that is
           already gone is the harmless direction of this pair. */
        try {
          /* A demo case's files go from whichever store holds them. Sweeping
             only R2 would leave TEST- photographs sitting in the firm's real
             Dropbox after the button that promises a clean removal. */
          if (isDropboxKey(row.r2_key)) {
            if (dbxToken && await dropboxDelete(env, dbxToken, dropboxPathFromKey(row.r2_key))) objects++;
          } else { await env.EVIDENCE.delete(row.r2_key); objects++; }
        } catch { /* keep going */ }
      }
    } catch { /* no evidence table, or unreadable — the sweep still runs */ }
  }

  const detail = {};
  let removed = 0;
  for (const [table, sql] of DEMO_SWEEP) {
    if (missing.includes(table)) continue;
    const r = await env.DB.prepare(sql).bind(DEMO_LIKE).run();
    const n = (r.meta && r.meta.changes) || 0;
    if (n) detail[table] = n;
    if (table === 'submissions') removed = n;
  }

  /* `removed` stays the number of CASES, which is what the page reports and
     what the older callers read. `rows` and `detail` are additions. */
  return json({
    ok: true,
    removed,
    rows: Object.values(detail).reduce((a, b) => a + b, 0),
    objects_removed: objects,
    detail,
  });
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

  /* UNIT 39 — a removed day does not get reported on. Refused at the writer
     rather than filtered at the reader: a report drafted from a day the office
     has taken out of the working case would be a document asserting work that
     the record says is not part of this case any more. Putting the day back is
     one press, and then this works exactly as it did. */
  if ((await contentRemovedSet(env, caseNo)).has(`day:${dayId}`)) {
    return json({ error: 'That investigation day has been removed from the case. Put it back '
      + 'first if you want to report on it.', code: 'day_removed' }, 409);
  }

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

/* ----------------------------------------------- daily summary (Unit 12)

   THE PARAGRAPH IS AUTHORED MATERIAL AND THE ACTIVITY LOG IS ITS SOURCE, in
   exactly the relationship case_reports.body already has: the builder reads
   the day's recorded facts, a person chooses and edits, and what is stored
   here is what they wrote. Nothing in these routes reads or writes
   activity_log — there is no code path by which building a narrative can
   alter the record it narrates.

   THE SENTENCES THEMSELVES ARE COMPOSED IN THE PAGE, deterministically, from
   structured values — the Worker stores and serves. No LLM is called anywhere
   in this feature (the brief forbids it), and no case fact leaves the portal
   to build a paragraph. */

const DS_NARRATIVE_MAX = 20000;
const DS_CONFIG_MAX = 30000;
const DSUMMARY_NOT_SET_UP = 'The daily summary table is not on this database yet. '
  + 'Run the portal-setup workflow once and try again.';

async function daySummariesFor(env, caseNo, removedKnown) {
  const { results } = await env.DB.prepare(
    `SELECT s.day_id, s.narrative, s.config, s.updated_at, s.created_at,
            u.display_name AS updated_by
       FROM case_day_summary s LEFT JOIN users u ON u.id = COALESCE(s.updated_by, s.created_by)
      WHERE s.case_no = ? ORDER BY s.day_id LIMIT 100`).bind(caseNo).all();
  /* UNIT 39 — a removed summary is MARKED, not dropped. The paragraph is
     authored prose and the office may want it back; dropping it here would
     make "put it back" unreachable from the only screen that knows it exists.
     Every reader that ships a summary into a document checks the flag. */
  const removed = removedKnown || await contentRemovedSet(env, caseNo);
  return (results || []).map(r =>
    removed.has(`day_summary:${r.day_id}`) ? { ...r, removed: true } : r);
}

/* WHO MAY WRITE A DAY'S SUMMARY IS WHO MAY WRITE THAT DAY'S REPORT — the
   saveReport rules, deliberately mirrored rather than invented: an admin
   always; the day's own investigator while the day's report (if one exists)
   is still theirs to edit. Once the report is with the office or signed off,
   the investigator's summary is too — prose that prints beside the report
   must not be editable around a review the report itself already had. No new
   finalization authority is granted to anyone. */
async function saveDaySummary(request, env, user, caseNo, dayId) {
  if (!(await caseFor(env, user, caseNo))) return json({ error: 'not found' }, 404);
  if ((await missingTables(env)).includes('case_day_summary')) {
    return json({ error: DSUMMARY_NOT_SET_UP, code: 'not_set_up' }, 503);
  }
  /* The day is scoped to the case IN THE STATEMENT, so a day id from another
     case answers exactly like one that never existed. */
  const day = await env.DB.prepare(
    'SELECT id, investigator_id FROM case_days WHERE id = ? AND case_no = ?')
    .bind(dayId, caseNo).first();
  if (!day) return json({ error: 'not found' }, 404);

  const admin = user.role === 'admin';
  if (!admin && day.investigator_id !== user.id) {
    return json({ error: 'That day belongs to another investigator.' }, 403);
  }
  if (!admin) {
    const rep = await env.DB.prepare(
      'SELECT status FROM case_reports WHERE day_id = ?').bind(dayId).first();
    if (rep && !['draft', 'needs_revision'].includes(rep.status)) {
      return json({ error: 'This day’s report is with the office for review.' }, 409);
    }
  }

  const body = await readJson(request);
  /* THE /meta RULE: an absent field is unchanged, a present one is the new
     value (an empty narrative is the writer clearing it). Resolved INSIDE the
     upsert from the row, so two writers posting different subsets interleave
     without one erasing the other's half. */
  const hasNarrative = body.narrative !== undefined;
  const hasConfig = body.config !== undefined;
  if (!hasNarrative && !hasConfig) return json({ error: 'Nothing to change.' }, 400);
  const narrative = hasNarrative ? String(body.narrative || '') : null;
  if (narrative != null && narrative.length > DS_NARRATIVE_MAX) {
    return json({ error: 'That narrative is longer than a report day can hold.' }, 400);
  }
  let config = null;
  if (hasConfig) {
    if (typeof body.config !== 'object' || body.config == null || Array.isArray(body.config)) {
      return json({ error: 'The builder selections did not read as an object.' }, 400);
    }
    config = JSON.stringify(body.config);
    if (config.length > DS_CONFIG_MAX) return json({ error: 'Those selections are too large to store.' }, 400);
  }
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO case_day_summary (day_id, case_no, narrative, config, created_by, created_at, updated_by, updated_at)
     VALUES (?1, ?2, COALESCE(?3, ''), COALESCE(?4, '{}'), ?5, ?6, ?5, ?6)
     ON CONFLICT(day_id) DO UPDATE SET
       narrative = COALESCE(?3, narrative),
       config    = COALESCE(?4, config),
       updated_by = ?5, updated_at = ?6`)
    .bind(dayId, caseNo, narrative, config, user.id, now).run();
  return json({ ok: true, day_id: dayId,
                day_summaries: await daySummariesFor(env, caseNo) });
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
  // Only the hand-off that needs someone's attention, not every status move.
  if (next === 'submitted') await notifyAdmins(env, 'reports', caseNo);
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

/* =========================================================================
   UNIT 10 — THE CASE TIMELINE (owner brief, 2026-08-20)

   "The timeline is a VIEW over existing case records. Source records remain
   authoritative." So there is NO timeline table, nothing is copied, and every
   arm below is a case-scoped read of a table that already existed. Editing
   happens where the record lives; this route only reads.

   IT NEEDED NO SCHEMA AND NO INDEX, and that was checked rather than assumed:
   every arm is an equality lookup on a column that is already the leading part
   of an index — activity_log(case_no, at_date, at_time), case_days(case_no,
   day_date), case_reports(case_no, report_date), case_evidence(case_no),
   retainer_payment(case_no, id), invoices(case_no), invoice_payments
   (invoice_id), invoice_events(invoice_id), case_builds(case_no), build_events
   (build_id), photo_stamp(case_no, id), video_stamp(case_no, id),
   case_offers(case_no, status), legal_intake(case_no), and the four
   single-row markers keyed by case_no. Nothing here scans.

   AND NO STATEMENT GROWS WITH THE CASE. Every arm carries its own LIMIT from
   the TL block; the invoice and build children are read with ONE statement
   each through a subquery on their parent rather than a query per parent, so
   a case with forty invoices costs the same two reads as a case with one.
   Unit 7's 401-bound-parameter lesson: a query whose width follows the
   customer's data is green in every test and broken only in production. */

const TL_TZ = 'America/New_York';

const TL = {
  PAGE: 200,            // events returned when the caller asks for no size
  MAX:  600,            // the most one request will ever return
  // Per-source caps. Bounded reads, newest first at the source.
  ACTIVITY: 500, EVIDENCE: 400, DAYS: 200, REPORTS: 200, STAMPS: 200,
  PAYMENTS: 200, INVOICES: 100, INVOICE_EVENTS: 150,
  BUILDS: 60, BUILD_EVENTS: 150, OFFERS: 50,
};

/* Same-instant ties break on this, then on the source row id. Insertion order
   is NOT chronology — an entry typed at 9pm about something seen at 8pm has to
   land at 8pm — so the sort key is the event's own time and this table is what
   makes two events sharing one keep a stable, explainable order. */
const TL_RANK = {
  case_created: 10, assigned: 20, status: 25,
  day_start: 30, activity: 35, day_end: 40,
  photo: 50, video: 51, photo_stamp: 52, video_stamp: 53,
  report_created: 60, report_status: 61,
  payment: 70, payment_void: 71, invoice: 72, invoice_status: 73,
  package: 80, legal_date: 90, archived: 95, deleted: 96,
};

/* The filter buckets. One per event type, so a chip cannot disagree with what
   it filters. `legal` is the brief's IMPORTANT DATES. */
const TL_CATEGORY = {
  case_created: 'case', assigned: 'case', status: 'case',
  archived: 'case', deleted: 'case',
  day_start: 'activity', day_end: 'activity', activity: 'activity',
  photo: 'media', video: 'media', photo_stamp: 'media', video_stamp: 'media',
  report_created: 'reports', report_status: 'reports',
  payment: 'payments', payment_void: 'payments',
  invoice: 'payments', invoice_status: 'payments',
  package: 'package', legal_date: 'legal',
};

/* The timeline's own words. The Worker composes each title because the TITLE
   is what says which of several facts a row is — "Report approved" against
   "Report submitted" is the whole content of that event — and deriving it
   again in the page would be the same rule written twice. Unit 8's
   needsAttention already composes its sentences here for the same reason. */
const TL_STAGE_WORD = { open: 'Open', assigned: 'Assigned', in_progress: 'In progress',
  report_review: 'Report review', awaiting_client: 'Awaiting client', complete: 'Complete',
  on_hold: 'On hold', cancelled: 'Cancelled', closed: 'Closed' };
const TL_REPORT_WORD = { submitted: 'submitted', needs_revision: 'sent back for revision',
  approved: 'approved', delivered: 'delivered' };
const TL_METHOD_WORD = { cash_app: 'Cash App', venmo: 'Venmo', check: 'Check', cash: 'Cash',
  ach_bill: 'ACH / BILL', ach: 'ACH', card: 'Card', wire: 'Wire', other: 'Other' };
const TL_INVOICE_WORD = { voided: 'voided', status_paid: 'paid',
  status_sent_to_bill: 'sent to BILL', status_sent_to_client: 'sent to the client',
  status_ready: 'marked ready' };
const TL_BUILD_WORD = { created: 'started', finalized: 'finalized',
  delivered: 'delivered', reopened: 'reopened' };

/* ---------------------------------------------------------------- the zone

   EST OR EDT FROM THE DATE ITSELF. Two kinds of timestamp live in this
   database and a chronology has to sort them against each other:

     - UTC INSTANTS — created_at, uploaded_at, recorded_at, status_at,
       taken_utc, start_utc, at. Written by nowIso(); unambiguous.
     - LOCAL WALL CLOCK — activity_log.at_date/at_time, case_days.day_date with
       start_time/end_time, retainer_payment.paid_on, invoice_payments
       .paid_date, case_reports.report_date and the legal dates. These are what
       a person wrote down where they were standing, and `ymdLocal` in the page
       files them in the investigator's own local day for exactly that reason.

   Comparing the two without converting is how an 8:15 PM observation sorts
   ahead of a 9:00 PM one that was recorded an hour earlier. So wall-clock
   values are read AS America/New_York, both kinds land on one UTC axis for the
   sort, and the axis is never shown to anybody.

   WHAT IS DISPLAYED IS COMPOSED HERE, in that zone, and sent as strings. A
   laptop set to Pacific must not draw a Virginia surveillance entry three
   hours early while the report beside it says otherwise, and one writer is
   this project's standing answer to two renderings of one fact.

   NOTHING IS REWRITTEN. A wall-clock row keeps the date and time it was
   recorded with, verbatim; only the sort key is derived. */

function etFields(ms) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', {
      timeZone: TL_TZ, hour12: false, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZoneName: 'short' }).formatToParts(new Date(ms))) p[x.type] = x.value;
  if (p.hour === '24') p.hour = '00';     // en-US writes midnight as hour 24
  return p;
}

/* -240 in EDT, -300 in EST — read from the instant, never assumed. */
function etOffsetMinutes(ms) {
  const p = etFields(ms);
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms) / 60000;
}

/* An instant, as the Eastern wall clock shows it. */
function tlAt(iso) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return null;
  const p = etFields(ms);
  return { at: new Date(ms).toISOString(), date: `${p.year}-${p.month}-${p.day}`,
           time: `${p.hour}:${p.minute}`, tz: p.timeZoneName || '' };
}

/* An Eastern wall-clock date, and optionally a time, as the instant it names.
   TWO PASSES: the offset is read at the naive guess and again at the corrected
   instant, which is what makes the changeover weekends come out right instead
   of being an hour wrong twice a year.

   `time` stays null when the record carries only a date. A date-only event is
   sorted at the start of its day and SAYS it has no time — inventing noon to
   make it sort nicely would be a precision claim the record does not make. */
function tlLocal(ymd, hhmm) {
  const d = String(ymd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const raw = String(hhmm || '');
  const t = /^\d{2}:\d{2}/.test(raw) ? raw.slice(0, 5) : null;
  const guess = Date.parse(`${d}T${t || '00:00'}:00Z`);
  if (!Number.isFinite(guess)) return null;
  let ms = guess - etOffsetMinutes(guess) * 60000;
  ms = guess - etOffsetMinutes(ms) * 60000;
  const p = etFields(ms);
  return { at: new Date(ms).toISOString(), date: d, time: t, tz: p.timeZoneName || '' };
}

/* One event. `when` is a tlAt/tlLocal result; `rec` is the moment the record
   was MADE, carried only when it is a different calendar day from the event —
   "logged the next morning" is worth saying, "logged the same minute" is
   noise. */
function tlEvent(type, when, fields, rec) {
  if (!when) return null;
  const recAt = rec && rec !== when.at ? tlAt(rec) : null;
  return {
    type, category: TL_CATEGORY[type] || 'case',
    at: when.at, date: when.date, time: when.time || null, tz: when.tz || '',
    rank: TL_RANK[type] || 50, seq: 0,
    ...(recAt && recAt.date !== when.date
        ? { recorded_at: recAt.at, recorded_date: recAt.date, recorded_time: recAt.time }
        : {}),
    ...fields,
  };
}

const tlNum = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const tlMoney = v => (tlNum(v) == null ? '' : '$' + Number(v).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/* Long free text is a TITLE on a timeline, not the whole entry. The Activity
   log is one tap away and holds the entry in full; a chronology that prints a
   400-word note stops being a chronology. */
function tlShort(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

/* ------------------------------------------------------------ the composer */
async function caseTimeline(env, user, caseNo, url) {
  const row = await caseFor(env, user, caseNo);
  if (!row) return json({ error: 'not found' }, 404);
  const admin = user.role === 'admin';
  const q = url ? url.searchParams : new URLSearchParams();

  let limit = parseInt(q.get('limit') || '', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = TL.PAGE;
  limit = Math.min(limit, TL.MAX);

  /* THE RANGE NARROWS THE READ rather than the rendering, so "last 7 days" on
     a large case comes back complete instead of capped. An Eastern calendar
     range means two different windows in SQL — a UTC instant window for the
     instant columns, and a plain string window for the date columns — and both
     are BOUND, never interpolated. Absent bounds become sentinels that sort
     outside every real value, so the statements keep one shape. */
  const dayOk = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const fromD = dayOk(q.get('from')) ? q.get('from') : null;
  const toD   = dayOk(q.get('to'))   ? q.get('to')   : null;
  const LO_D = fromD || '0000-01-01', HI_D = toD || '9999-12-31';
  const LO = fromD ? tlLocal(fromD, '00:00').at : '0000-01-01T00:00:00.000Z';
  const HI = toD
    ? new Date(Date.parse(tlLocal(toD, '23:59').at) + 59999).toISOString()
    : '9999-12-31T23:59:59.999Z';

  const missing = await missingTables(env);
  /* NAME WHAT CANNOT BE SEEN. A table that has not arrived yet (schema.sql
     comes by a manual portal-setup dispatch while the Worker deploys on push)
     must not read as "nothing happened" — the collector below carries every
     source that could not be consulted into the response. */
  const blind = [];
  const have = (t, label) => {
    const ok = !missing.includes(t);
    if (!ok && label && !blind.includes(label)) blind.push(label);
    return ok;
  };

  /* `caseFor` returns only what the permission check needs, so the facts the
     header and the first event want are read once, here, rather than twice. */
  const info = await env.DB.prepare(
    `SELECT created_at, subject_name, client_name, carrier, claim_number
       FROM submissions WHERE case_no = ?`).bind(caseNo).first() || {};
  const stRow = have('case_status')
    ? await env.DB.prepare(
        `SELECT s.stage, s.set_at, u.display_name AS who FROM case_status s
           LEFT JOIN users u ON u.id = s.set_by WHERE s.case_no = ?`).bind(caseNo).first()
    : null;

  const ev = [];
  const capped = [];
  /* THE RANGE APPLIES TO EVERY EVENT, including the handful that come from a
     single row and so have no LIMIT of their own. Without this, narrowing to
     the last seven days still returned "Case opened" from two years ago — a
     filter that quietly exempts some of its subject is worse than no filter. */
  const inRange = when => Boolean(when) && when.at >= LO && when.at <= HI;
  const push = (e, seq) => { if (e) { e.seq = Number(seq) || 0; ev.push(e); } };
  const cap = (rows, n, label) => {
    if (rows && rows.length >= n && !capped.includes(label)) capped.push(label);
    return rows || [];
  };

  /* ------------------------------------------------------------ 1. the case */
  const opened = tlAt(info.created_at);
  if (inRange(opened)) {
    push(tlEvent('case_created', opened, {
      title: 'Case opened',
      detail: row.kind === 'claims' ? 'Claim assignment' : 'Client intake',
      link: { tab: 'overview' },
    }), 0);
  }

  /* ONE status event, and that is not a shortcut — `case_status` is
     current-state only, one row per case. There is no stage history table, so
     a timeline listing every status change would be inventing the ones nobody
     recorded. What is shown is what is known: the stage the case is in, and
     when it was set. */
  const stAt = stRow && stRow.set_at ? tlAt(stRow.set_at) : null;
  if (inRange(stAt)) {
    push(tlEvent('status', stAt, {
      title: 'Status set to ' + (TL_STAGE_WORD[stRow.stage] || stRow.stage),
      who: stRow.who || '', status: stRow.stage, link: { tab: 'assign' },
    }), 0);
  }

  if (admin && have('case_archive')) {
    const a = await env.DB.prepare(
      `SELECT a.archived_at, u.display_name AS who FROM case_archive a
         LEFT JOIN users u ON u.id = a.archived_by WHERE a.case_no = ?`).bind(caseNo).first();
    const at = a ? tlAt(a.archived_at) : null;
    if (inRange(at)) push(tlEvent('archived', at,
      { title: 'Case archived', who: a.who || '', link: { tab: 'billing' } }), 0);
  }
  if (admin && have('case_deleted')) {
    const d = await env.DB.prepare(
      `SELECT d.deleted_at, d.reason, u.display_name AS who FROM case_deleted d
         LEFT JOIN users u ON u.id = d.deleted_by WHERE d.case_no = ?`).bind(caseNo).first();
    const at = d ? tlAt(d.deleted_at) : null;
    if (inRange(at)) push(tlEvent('deleted', at,
      { title: 'Case deleted', detail: d.reason || '', who: d.who || '',
        link: { tab: 'billing' } }), 0);
  }

  /* Assignment. `submissions.assigned_to` keeps no history, so the record of
     WHEN somebody was put on this case is the offer they accepted — an actual
     recorded moment rather than one derived from the current column. Offers
     are admin territory in the workspace and stay admin territory here. */
  if (admin) {
    const offers = cap((await env.DB.prepare(
      `SELECT o.id, o.status, o.responded_at, o.offered_at, u.display_name AS who
         FROM case_offers o LEFT JOIN users u ON u.id = o.investigator_id
        WHERE o.case_no = ? AND o.status = 'accepted' AND o.responded_at IS NOT NULL
          AND o.responded_at >= ? AND o.responded_at <= ?
        ORDER BY o.id DESC LIMIT ?`).bind(caseNo, LO, HI, TL.OFFERS).all()).results,
      TL.OFFERS, 'assignments');
    for (const o of offers) {
      push(tlEvent('assigned', tlAt(o.responded_at), {
        title: 'Investigator assigned', detail: o.who ? o.who + ' accepted the assignment' : '',
        who: o.who || '', link: { tab: 'assign' },
      }, o.offered_at), o.id);
    }
  }

  /* ------------------------------------------------------- 2. investigation */
  /* THE LOCKED HOURS RULE REACHES HERE TOO. The day_end event prints
     "8 hr · 62 mi" beside the investigator's name, which is the same timesheet
     the workspace read was handing over — a chronology is an export of the
     case, and the owner's line names exports. Scoped in the SQL like the
     workspace and the calendar; an admin's timeline is unchanged. */
  const days = cap((await env.DB.prepare(
    `SELECT d.id, d.day_date, d.start_time, d.end_time, d.hours, d.miles, d.created_at,
            d.ended_at, d.investigator_id, u.display_name AS who
       FROM case_days d LEFT JOIN users u ON u.id = d.investigator_id
      WHERE d.case_no = ? AND d.day_date >= ? AND d.day_date <= ?
        ${admin ? '' : 'AND d.investigator_id = ?'}
      ORDER BY d.day_date DESC, d.id DESC LIMIT ?`)
    .bind(...(admin ? [caseNo, LO_D, HI_D, TL.DAYS]
                    : [caseNo, LO_D, HI_D, user.id, TL.DAYS])).all()).results,
    TL.DAYS, 'investigation days');
  /* WHO ENDED EACH DAY (owner, 2026-08-21). A chronology is where "the office
     ended this one" is most likely to be read as "the investigator did", so
     the label rides the day_end event. One read, decorated onto rows already
     fetched. `who` stays the day's INVESTIGATOR — whose day it is — and the
     ending actor is named in the detail, which is the honest shape: the event
     is about their day, and the label says who closed it. */
  const tlEndActors = await dayEndActors(env, caseNo, missing);
  for (const d of days) {
    push(tlEvent('day_start', tlLocal(d.day_date, d.start_time), {
      title: 'Investigation day started', who: d.who || '', link: { tab: 'field' },
    }, d.created_at), d.id);
    if (d.end_time) {
      const bits = [];
      if (tlNum(d.hours) != null) bits.push(tlNum(d.hours) + ' hr');
      if (tlNum(d.miles) != null) bits.push(tlNum(d.miles) + ' mi');
      const endedLabel = dayEndLabel(
        tlEndActors ? tlEndActors.get(d.id) : null, d.investigator_id);
      if (endedLabel) bits.push(endedLabel);
      push(tlEvent('day_end', tlLocal(d.day_date, d.end_time), {
        title: 'Investigation day ended', detail: bits.join(' · '),
        who: d.who || '', link: { tab: 'field' },
      }, d.ended_at), d.id);
    }
  }

  /* The activity log, removed entries included and marked. `activity_removed`
     is the project's standing shape — an entry can be removed, never erased —
     so the chronology shows it struck out rather than pretending the moment
     never happened, which is the same thing the Activity log itself does. */
  const hasSource = have('activity_source', 'voice-created entries');
  const hasRemoved = have('activity_removed', 'removed entries');
  const acts = cap((await env.DB.prepare(
    `SELECT a.id, a.day_id, a.at_date, a.at_time, a.kind, a.description, a.location,
            a.vehicle, a.created_at, a.edited_at, u.display_name AS who
            ${hasRemoved ? ', r.removed_at, ru.display_name AS removed_by' : ''}
            ${hasSource ? ', s.source' : ''}
       FROM activity_log a LEFT JOIN users u ON u.id = a.investigator_id
       ${hasRemoved ? `LEFT JOIN activity_removed r ON r.entry_id = a.id
                       LEFT JOIN users ru ON ru.id = r.removed_by` : ''}
       ${hasSource ? 'LEFT JOIN activity_source s ON s.entry_id = a.id' : ''}
      WHERE a.case_no = ? AND a.at_date >= ? AND a.at_date <= ?
      ORDER BY a.at_date DESC, a.at_time DESC, a.id DESC LIMIT ?`)
    .bind(caseNo, LO_D, HI_D, TL.ACTIVITY).all()).results, TL.ACTIVITY, 'activity entries');

  /* ------------------------------------------------------------- 3. media */
  const evidence = cap((await env.DB.prepare(
    `SELECT e.id, e.filename, e.content_type, e.entry_id, e.classification,
            e.uploaded_at, e.deleted_at, u.display_name AS who
       FROM case_evidence e LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE e.case_no = ? ${admin ? '' : 'AND e.deleted_at IS NULL'}
        AND e.uploaded_at IS NOT NULL AND e.uploaded_at >= ? AND e.uploaded_at <= ?
      ORDER BY e.id DESC LIMIT ?`)
    .bind(caseNo, LO, HI, TL.EVIDENCE).all()).results, TL.EVIDENCE, 'case media');

  /* THE RELATIONSHIP IS THE COLUMN, NEVER THE CLOCK. `case_evidence.entry_id`
     is the only thing that says a photograph documents a moment; two records
     sharing a minute say nothing. So an activity entry carries the files that
     NAME it and no others, and this is a pass over rows already fetched — no
     second query, and nothing per entry. */
  const byEntry = new Map();
  for (const f of evidence) {
    if (!f.entry_id || f.deleted_at) continue;
    const list = byEntry.get(f.entry_id) || [];
    list.push({ id: f.id, filename: f.filename,
                kind: String(f.content_type || '').startsWith('video/') ? 'video' : 'photo' });
    byEntry.set(f.entry_id, list);
  }

  for (const a of acts) {
    const extra = [];
    if (a.location) extra.push('at ' + a.location);
    if (a.vehicle) extra.push('vehicle ' + a.vehicle);
    const att = byEntry.get(a.id) || [];
    push(tlEvent('activity', tlLocal(a.at_date, a.at_time), {
      title: tlShort(a.description, 180),
      detail: extra.join(' · '),
      who: a.who || '',
      kind: a.kind,
      ...(hasSource && a.source === 'voice' ? { source: 'voice' } : {}),
      ...(a.removed_at ? { removed: true, status: 'Removed',
                           removed_by: a.removed_by || '' } : {}),
      ...(a.edited_at ? { edited: true } : {}),
      ...(att.length ? { attached: att.slice(0, 12) } : {}),
      link: { tab: 'activity', id: a.id },
    }, a.created_at), a.id);
  }

  const stampedIds = new Set();

  /* The timestamped copies. Their EVENT time is the instant burned into the
     pixels — what the photograph or the footage says happened — and their
     RECORD time is when the copy was generated. Those are genuinely different
     facts and the pair is exactly what PHOTO-TIMESTAMP.md exists to keep
     apart, so both are carried. Superseded corrections are left out: the
     active derivative is the one that stands. */
  if (have('photo_stamp', 'timestamped photographs')) {
    const stamps = cap((await env.DB.prepare(
      `SELECT p.id, p.taken_utc, p.generated_at, p.source, p.stamped_id, p.original_id,
              e.filename, u.display_name AS who
         FROM photo_stamp p
         LEFT JOIN case_evidence e ON e.id = COALESCE(p.stamped_id, p.original_id)
         LEFT JOIN users u ON u.id = p.generated_by
        WHERE p.case_no = ? AND p.superseded_at IS NULL
          AND p.taken_utc >= ? AND p.taken_utc <= ?
        ORDER BY p.id DESC LIMIT ?`)
      .bind(caseNo, LO, HI, TL.STAMPS).all()).results, TL.STAMPS, 'timestamped photographs');
    for (const s of stamps) {
      if (s.stamped_id) stampedIds.add(s.stamped_id);
      push(tlEvent('photo_stamp', tlAt(s.taken_utc), {
        title: s.filename || 'Timestamped photograph',
        detail: 'Timestamped copy filed — taken time from '
              + (s.source === 'exif' ? 'the camera' : 'the operator'),
        who: s.who || '',
        link: s.stamped_id ? { tab: 'evidence', id: s.stamped_id } : { tab: 'evidence' },
      }, s.generated_at), s.id);
    }
  }

  /* Video is device-first: no bytes here and none in Cloudflare, so this table
     IS the whole of what the portal knows about a timestamped clip. */
  if (have('video_stamp', 'timestamped video')) {
    const stamps = cap((await env.DB.prepare(
      `SELECT v.id, v.original_name, v.derivative_name, v.start_utc, v.generated_at,
              v.saved_at, u.display_name AS who
         FROM video_stamp v LEFT JOIN users u ON u.id = v.generated_by
        WHERE v.case_no = ? AND v.superseded_at IS NULL
          AND v.start_utc >= ? AND v.start_utc <= ?
        ORDER BY v.id DESC LIMIT ?`)
      .bind(caseNo, LO, HI, TL.STAMPS).all()).results, TL.STAMPS, 'timestamped video');
    for (const s of stamps) {
      push(tlEvent('video_stamp', tlAt(s.start_utc), {
        title: s.derivative_name || s.original_name || 'Timestamped video',
        detail: 'Timestamped copy generated on the device'
              + (s.saved_at ? '' : ' — not yet confirmed saved'),
        who: s.who || '', status: s.saved_at ? '' : 'Not confirmed saved',
        link: { tab: 'evidence' },
      }, s.generated_at), s.id);
    }
  }

  /* A DERIVATIVE IS NOT A SECOND FILING. A timestamped copy has its own
     `case_evidence` row, so without this it would appear twice — once at the
     moment burned into it and once at the moment it was written to Dropbox,
     under the same filename, which is the flooding the brief warns about. The
     stamp event is the one that says something, so the plain filing is
     dropped for exactly those rows. The ORIGINAL is untouched and still shows
     as its own filing, because it is a different file. */
  for (const f of evidence) {
    if (stampedIds.has(f.id)) continue;
    const video = String(f.content_type || '').startsWith('video/');
    push(tlEvent(video ? 'video' : 'photo', tlAt(f.uploaded_at), {
      title: f.filename,
      detail: f.entry_id ? 'Filed against an activity entry' : '',
      who: f.who || '',
      status: f.deleted_at ? 'Removed' : '',
      ...(f.deleted_at ? { removed: true } : {}),
      classification: f.classification || '',
      link: { tab: 'evidence', id: f.id },
    }), f.id);
  }

  /* ------------------------------------------------------------ 4. reports */
  const reports = cap((await env.DB.prepare(
    `SELECT r.id, r.report_date, r.status, r.created_at, r.status_at,
            u.display_name AS who, su.display_name AS status_by
       FROM case_reports r LEFT JOIN users u ON u.id = r.investigator_id
       LEFT JOIN users su ON su.id = r.status_by
      WHERE r.case_no = ? ORDER BY r.report_date DESC, r.id DESC LIMIT ?`)
    .bind(caseNo, TL.REPORTS).all()).results, TL.REPORTS, 'reports');
  for (const r of reports) {
    const created = tlAt(r.created_at);
    if (inRange(created)) {
      push(tlEvent('report_created', created, {
        title: 'Report drafted',
        detail: r.report_date ? 'for ' + r.report_date : '',
        who: r.who || '', status: r.status, link: { tab: 'reports', id: r.id },
      }), r.id);
    }
    /* `status_at` is one moment, not a history — a report that went draft →
       submitted → approved keeps only the last of those. So one status event
       per report, saying what it says. */
    if (r.status_at && r.status !== 'draft') {
      const sa = tlAt(r.status_at);
      if (inRange(sa)) {
        push(tlEvent('report_status', sa, {
          title: 'Report ' + (TL_REPORT_WORD[r.status] || r.status),
          detail: r.report_date ? 'for ' + r.report_date : '',
          who: r.status_by || '', status: r.status, link: { tab: 'reports', id: r.id },
        }), r.id);
      }
    }
  }

  /* ----------------------------------------------------------- 5. the money
     ADMIN ONLY, and by not running rather than by filtering. An investigator
     is never sent what the client pays — the boundary redactRow draws around
     client_phone and FIELD_KEEP draws around the not-to-exceed. */
  if (admin) {
    if (have('retainer_payment', 'retainer payments')) {
      const voidOk = have('retainer_payment_void', 'voided payments');
      const pays = cap((await env.DB.prepare(
        `SELECT p.id, p.amount, p.method, p.paid_on, p.reference, p.recorded_at,
                u.display_name AS who
                ${voidOk ? ', v.voided_at, v.reason AS void_reason, vu.display_name AS voided_by' : ''}
           FROM retainer_payment p LEFT JOIN users u ON u.id = p.recorded_by
           ${voidOk ? `LEFT JOIN retainer_payment_void v ON v.payment_id = p.id
                       LEFT JOIN users vu ON vu.id = v.voided_by` : ''}
          WHERE p.case_no = ? ORDER BY p.id DESC LIMIT ?`)
        .bind(caseNo, TL.PAYMENTS).all()).results, TL.PAYMENTS, 'retainer payments');
      for (const p of pays) {
        const when = p.paid_on ? tlLocal(p.paid_on, null) : tlAt(p.recorded_at);
        if (inRange(when)) {
          push(tlEvent('payment', when, {
            title: tlMoney(p.amount) + ' retainer payment recorded',
            detail: [TL_METHOD_WORD[p.method] || p.method || '',
                     p.reference ? 'ref ' + p.reference : ''].filter(Boolean).join(' · '),
            who: p.who || '',
            ...(voidOk && p.voided_at ? { removed: true, status: 'Voided' } : {}),
            link: { tab: 'billing', id: p.id },
          }, p.recorded_at), p.id);
        }
        if (voidOk && p.voided_at) {
          const va = tlAt(p.voided_at);
          if (inRange(va)) {
            push(tlEvent('payment_void', va, {
              title: 'Payment of ' + tlMoney(p.amount) + ' voided',
              detail: p.void_reason || '', who: p.voided_by || '',
              status: 'Voided', link: { tab: 'billing', id: p.id },
            }), p.id);
          }
        }
      }
    }

    const invoices = cap((await env.DB.prepare(
      `SELECT i.id, i.invoice_no, i.status, i.created_at, u.display_name AS who
         FROM invoices i LEFT JOIN users u ON u.id = i.created_by
        WHERE i.case_no = ? ORDER BY i.id DESC LIMIT ?`)
      .bind(caseNo, TL.INVOICES).all()).results, TL.INVOICES, 'invoices');
    const invNo = new Map(invoices.map(i => [i.id, i.invoice_no]));
    for (const i of invoices) {
      const c = tlAt(i.created_at);
      if (inRange(c)) {
        push(tlEvent('invoice', c, {
          title: 'Invoice ' + (i.invoice_no || '') + ' created',
          who: i.who || '', status: i.status, link: { tab: 'invoices', id: i.id },
        }), i.id);
      }
    }
    if (invoices.length) {
      /* ONE statement for every invoice's payments, resolved through a
         subquery on the parent — never a query per invoice. Same shape as
         DEMO_SWEEP's children, and the reason is the same: a read whose COUNT
         follows the customer's data is the N+1 this brief names by name. */
      const pays = cap((await env.DB.prepare(
        `SELECT p.id, p.invoice_id, p.amount, p.method, p.paid_date, p.recorded_at,
                p.reference, u.display_name AS who
           FROM invoice_payments p LEFT JOIN users u ON u.id = p.recorded_by
          WHERE p.invoice_id IN (SELECT id FROM invoices WHERE case_no = ?)
          ORDER BY p.id DESC LIMIT ?`)
        .bind(caseNo, TL.PAYMENTS).all()).results, TL.PAYMENTS, 'invoice payments');
      for (const p of pays) {
        const when = p.paid_date ? tlLocal(p.paid_date, null) : tlAt(p.recorded_at);
        if (!inRange(when)) continue;
        push(tlEvent('payment', when, {
          title: tlMoney(p.amount) + ' payment recorded',
          detail: [invNo.get(p.invoice_id) ? 'Invoice ' + invNo.get(p.invoice_id) : '',
                   TL_METHOD_WORD[p.method] || p.method || '',
                   p.reference ? 'ref ' + p.reference : ''].filter(Boolean).join(' · '),
          who: p.who || '', link: { tab: 'invoices', id: p.invoice_id },
        }, p.recorded_at), p.id);
      }

      /* The invoice audit trail, narrowed to the transitions that are events.
         `edited`, `lines_replaced` and `bill_ref_added` are bookkeeping — the
         brief's "every low-value technical event" — and `payment_recorded`
         would say a second time what the payment row above already says. */
      const iev = cap((await env.DB.prepare(
        `SELECT e.id, e.invoice_id, e.action, e.detail, e.at, u.display_name AS who
           FROM invoice_events e LEFT JOIN users u ON u.id = e.user_id
          WHERE e.invoice_id IN (SELECT id FROM invoices WHERE case_no = ?)
            AND e.action IN ('voided','status_paid','status_sent_to_bill',
                             'status_sent_to_client','status_ready')
            AND e.at IS NOT NULL AND e.at >= ? AND e.at <= ?
          ORDER BY e.id DESC LIMIT ?`)
        .bind(caseNo, LO, HI, TL.INVOICE_EVENTS).all()).results,
        TL.INVOICE_EVENTS, 'invoice history');
      for (const e of iev) {
        push(tlEvent('invoice_status', tlAt(e.at), {
          title: 'Invoice ' + (invNo.get(e.invoice_id) || '') + ' — '
               + (TL_INVOICE_WORD[e.action] || e.action),
          who: e.who || '', status: e.action === 'voided' ? 'void' : '',
          ...(e.action === 'voided' ? { removed: true } : {}),
          link: { tab: 'invoices', id: e.invoice_id },
        }), e.id);
      }
    }
  }

  /* --------------------------------------------------------- 6. the package
     Admin territory, like /build itself. Narrowed to the lifecycle: an item
     added or a summary edited is work in progress, not a case event. */
  if (admin) {
    const builds = cap((await env.DB.prepare(
      'SELECT id, version FROM case_builds WHERE case_no = ? ORDER BY id DESC LIMIT ?')
      .bind(caseNo, TL.BUILDS).all()).results, TL.BUILDS, 'packages');
    const version = new Map(builds.map(b => [b.id, b.version]));
    if (builds.length) {
      const bev = cap((await env.DB.prepare(
        `SELECT e.id, e.build_id, e.action, e.detail, e.at, u.display_name AS who
           FROM build_events e LEFT JOIN users u ON u.id = e.user_id
          WHERE e.build_id IN (SELECT id FROM case_builds WHERE case_no = ?)
            AND e.action IN ('created','finalized','delivered','reopened')
            AND e.at IS NOT NULL AND e.at >= ? AND e.at <= ?
          ORDER BY e.id DESC LIMIT ?`)
        .bind(caseNo, LO, HI, TL.BUILD_EVENTS).all()).results,
        TL.BUILD_EVENTS, 'package history');
      for (const e of bev) {
        push(tlEvent('package', tlAt(e.at), {
          title: 'Client package ' + (TL_BUILD_WORD[e.action] || e.action)
               + (version.has(e.build_id) ? ' — v' + version.get(e.build_id) : ''),
          detail: e.action === 'finalized' ? String(e.detail || '') : '',
          who: e.who || '', status: e.action,
          link: { tab: 'package', id: e.build_id },
        }), e.id);
      }
    }
  }

  /* ---------------------------------------------------- 7. important dates
     ONLY WHAT A FIRM ACTUALLY GAVE US. These are typed into the legal panel;
     nothing here derives one date from another, and a case with no legal row
     simply has no dates — the brief's "do not invent problems from weak
     assumptions", one unit later. Admin only, like the Legal panel itself:
     the firm is who is paying. */
  if (admin && have('legal_intake', 'legal dates')) {
    const L = await env.DB.prepare(
      `SELECT hearing_date, trial_date, deadline, other_date, other_date_label
         FROM legal_intake WHERE case_no = ?`).bind(caseNo).first();
    if (L) {
      const dates = [['hearing_date', 'Hearing'], ['trial_date', 'Trial'],
                     ['deadline', 'Deadline'],
                     ['other_date', String(L.other_date_label || '').trim() || 'Key date']];
      let n = 0;
      for (const [k, word] of dates) {
        if (!dayOk(L[k]) || L[k] < LO_D || L[k] > HI_D) continue;
        push(tlEvent('legal_date', tlLocal(L[k], null), {
          title: word, detail: 'Recorded by the firm', link: { tab: 'legal' },
        }), ++n);
      }
    }
  }

  /* ------------------------------------------------------------- the order
     Event time first — an entry typed the next morning about something seen
     at 8pm belongs at 8pm — then the fixed type rank, then the source row id.
     Deterministic and explainable; no two runs can disagree. */
  ev.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)
                 || (a.rank - b.rank) || (a.seq - b.seq));

  const counts = {};
  for (const e of ev) counts[e.category] = (counts[e.category] || 0) + 1;

  const order = String(q.get('order') || '') === 'asc' ? 'asc' : 'desc';
  const ordered = order === 'asc' ? ev : ev.slice().reverse();
  const events = ordered.slice(0, limit);

  /* The header context the brief asks for — enough to know whose chronology
     this is, never a second copy of the case header. The client is the paying
     side and stays admin-only; the subject reaches both roles, the way it
     always does here. */
  const assignee = row.assigned_to ? await env.DB.prepare(
    'SELECT display_name FROM users WHERE id = ?').bind(row.assigned_to).first() : null;

  const span = ev.length
    ? { from: ev[0].date, to: ev[ev.length - 1].date } : null;

  return json({
    case_no: caseNo,
    context: {
      case_no: caseNo,
      kind: row.kind,
      stage: stRow ? stRow.stage : (row.status === 'new' ? 'open' : row.status),
      subject: info.subject_name || '',
      investigator: assignee ? assignee.display_name : '',
      /* The paying side is the office's, exactly as it is everywhere else
         here: an investigator's header carries the subject and the case. */
      ...(admin ? { client: row.kind === 'claims'
                      ? (info.carrier || info.client_name || '')
                      : (info.client_name || ''),
                    claim_number: info.claim_number || '' } : {}),
      span,
    },
    events,
    counts,
    total: ev.length,
    order,
    limit,
    from: fromD, to: toD,
    /* Sources whose reads hit their own cap, and sources that could not be
       read at all. Both are named rather than drawn as an empty stretch of
       chronology: a timeline that quietly stops is worse than one that says
       where it stops. */
    capped_sources: capped,
    missing_sources: blind,
    tz: TL_TZ,
    server_now: nowIso(),
  });
}

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
    /* The provider's message commonly quotes the offending address, and a
       client's, adjuster's or firm's email must not land in the Worker log —
       the same rule alertText keeps for what leaves the building (closeout
       audit, 2026-09-03). The status is what a person debugging needs. */
    console.error('email rejected', res.status);
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
  'activity_removed', 'build_reports', 'build_summary', 'build_custom', 'legal_intake',
  'case_day_pauses', 'lead_status', 'send_log', 'invoice_retainer',
  'payment_methods', 'payment_send', 'retainer_receipt', 'case_archive', 'case_deleted', 'notify_recipient', 'case_phone',
  'retainer_payment', 'retainer_payment_void', 'retainer_payment_token',
  'invoice_payment_token', 'invoice_payment_void', 'alert_failure',
  'video_stamp', 'dropbox_auth', 'activity_source', 'activity_voice_event',
  'photo_stamp',
  'profile', 'profile_contact', 'profile_phone', 'case_profile',
  'build_template', 'evidence_integrity', 'case_day_summary', 'storage_failure',
  'case_retention', 'legal_hold', 'retention_event', 'case_day_end',
  'case_content_removed', 'case_content_event', 'feed_hidden', 'assistant_log',
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

/* ================== API ASSISTANT — BETA / DRY RUN (ASSISTANT.md) =========

   An INTERNAL operations copilot behind the existing sign-in, Units 1–3:
   shell + enforcement, navigation, live status. Owner master spec 2026-09-02.

   THE WHOLE SAFETY MODEL, in one place:

   - BETA IS PERMANENT IN V1. There is no Live Mode switch anywhere in this
     code, and the Assistant can never create one: no /assistant route writes
     the settings store, sends mail, or touches money, status, deletion or
     archival. A source test counts the calls, the intake-delete pattern.
   - Every tool runs as the SIGNED-IN USER through the same functions the
     ordinary routes use, so the role boundary is the SQL it always was. The
     Assistant grants nothing: an investigator's Assistant is an investigator.
   - CONSEQUENTIAL VERBS ARE REFUSED BY NAME, server-side, before any tool
     runs — conversational wording cannot bypass a classifier that runs on
     the server and matches the act, not the phrasing.
   - No AI provider is required or contacted. `assistantProvider` answers
     not_configured until BOTH env vars exist (the billcomConfig shape), and
     nothing else reads the key. Model text never becomes a route: navigation
     answers are REGISTRY IDS the page resolves against its own handlers. */

const assistantProvider = env => {
  const provider = String(env.ASSISTANT_PROVIDER || '').trim().toLowerCase();
  const key = String(env.ASSISTANT_API_KEY || '').trim();
  return { provider: provider || null, ready: !!(provider && key),
           reason: provider && key ? null : 'not_configured' };
};

/* The navigation registry — the TAB map `shell()` already routes, plus the
   action doors and the case door. `roles` decides what each account is even
   TOLD exists; aliases are matched lower-cased with filler words stripped. */
const ASSISTANT_NAV = [
  { id: 'dashboard', kind: 'tab', label: 'Dashboard', roles: ['admin'],
    aliases: ['dashboard', 'home', 'main screen'] },
  { id: 'search', kind: 'tab', label: 'Search', roles: ['admin', 'investigator'],
    aliases: ['search'] },
  { id: 'cases', kind: 'tab', label: 'Cases', roles: ['admin', 'investigator'],
    aliases: ['cases', 'case list', 'my assignments', 'assignments'] },
  { id: 'tasks', kind: 'tab', label: 'Tasks', roles: ['admin', 'investigator'],
    aliases: ['tasks', 'task board', 'follow ups'] },
  { id: 'leads', kind: 'tab', label: 'Intakes', roles: ['admin'],
    aliases: ['intakes', 'intake', 'leads', 'new intakes', 'leads and intakes'] },
  { id: 'profiles', kind: 'tab', label: 'Clients & Firms', roles: ['admin'],
    aliases: ['clients', 'firms', 'clients and firms', 'client directory', 'contacts directory'] },
  { id: 'calendar', kind: 'tab', label: 'Calendar', roles: ['admin', 'investigator'],
    aliases: ['calendar', 'schedule'] },
  { id: 'filequeue', kind: 'tab', label: 'File queue', roles: ['admin', 'investigator'],
    aliases: ['file queue', 'files', 'uploads'] },
  { id: 'delivery', kind: 'tab', label: 'Reports & Packages', roles: ['admin'],
    aliases: ['reports and packages', 'packages', 'delivery', 'reports'] },
  { id: 'sheets', kind: 'tab', label: 'Rate Sheets', roles: ['admin'],
    aliases: ['rate sheets', 'sheets', 'pricing sheets'] },
  { id: 'invoices', kind: 'tab', label: 'Billing', roles: ['admin'],
    aliases: ['billing', 'invoices', 'invoice section', 'unpaid invoices', 'balances'] },
  { id: 'staff', kind: 'tab', label: 'Staff', roles: ['admin'],
    aliases: ['staff', 'team', 'investigators'] },
  { id: 'audit', kind: 'tab', label: 'Audit trail', roles: ['admin'],
    aliases: ['audit', 'audit trail', 'history log'] },
  { id: 'settings', kind: 'tab', label: 'Settings', roles: ['admin'],
    aliases: ['settings', 'configuration'] },
  { id: 'today', kind: 'tab', label: 'Today', roles: ['investigator'],
    aliases: ['today', 'my day'] },
  { id: 'myreports', kind: 'tab', label: 'Reports', roles: ['investigator'],
    aliases: ['my reports', 'reports'] },
  { id: 'myexpenses', kind: 'tab', label: 'Expenses', roles: ['investigator'],
    aliases: ['expenses', 'my expenses'] },
  { id: 'surveillance', kind: 'action', label: 'Active Surveillance', roles: ['admin', 'investigator'],
    aliases: ['active surveillance', 'surveillance mode', 'field view', 'field mode'] },
  { id: 'vst', kind: 'action', label: 'Timestamp Video', roles: ['admin', 'investigator'],
    aliases: ['timestamp video', 'video timestamp', 'video tool'] },
  { id: 'pst', kind: 'action', label: 'Timestamp Photo', roles: ['admin', 'investigator'],
    aliases: ['timestamp photo', 'photo timestamp', 'photo tool'] },
  { id: 'newlead', kind: 'tab', label: 'Intake a Client', roles: ['admin'],
    aliases: ['intake a client', 'new lead', 'quick intake', 'manual intake'] },
];
const assistantNavFor = role =>
  ASSISTANT_NAV.filter(n => n.roles.includes(role)).map(({ id, kind, label }) => ({ id, kind, label }));

/* What each destination IS, for "where am I?" / "explain this page" — written
   from the portal's own rules, one short honest paragraph each. The `case`
   entry covers the case workspace, which is not a TAB. */
const ASSISTANT_EXPLAIN = {
  dashboard: 'The Dashboard answers "what needs my attention today": the alert cards up top are clickable filters, the outstanding balance and case packages sit below, and every number is the Worker\'s own — a zero is a real answer, not decoration.',
  search: 'Search finds cases, claim and matter numbers, clients, carriers, subjects, vehicles, firms and staff by the records the portal already holds. What you can find is decided server-side by your role.',
  cases: 'The case list, with lenses for Active, Completed, Archived and Deleted. Opening a row opens the full case workspace.',
  tasks: 'The task board buckets the same case tasks the case tabs write into Overdue, Today, Upcoming and Completed.',
  leads: 'Leads & Intakes is the desk where new submissions land: review a fresh intake, send a rate sheet or intake link, record how the lead moved, or accept it into working state.',
  profiles: 'Clients & Firms is the saved directory — law firms, insurance organizations and private clients — so a repeat assignment starts prefilled instead of retyped. A profile is a default; every case stays a snapshot.',
  calendar: 'The calendar shows investigation days and dated case events for the month.',
  filequeue: 'The file queue lists uploads needing review, per your role.',
  delivery: 'Reports & Packages is the delivery desk: report status, package builds, and the completed-case artifacts.',
  sheets: 'Rate Sheets is where the office emails pricing: the private retainer sheet, the insurance assignment rates, and the legal cards including the fixed-fee services. Sending is always a person\'s explicit act.',
  invoices: 'Billing holds invoices, balances, payments and their documents. Money is arithmetic here — paid is what a zero balance means, never a stored flag.',
  staff: 'Staff manages accounts and invitations. Accounts exist only by invitation.',
  audit: 'The audit trail composes who/what/when from the records that already exist — status, invoices, packages, payments, closure, retention and report versions.',
  settings: 'Settings holds notification recipients, billing defaults (including the check remittance address and the Process Service default fee), payment methods, Dropbox status, storage health and the developer tools.',
  today: 'Today is your day at a glance: your assignments, your open day and what is due.',
  myreports: 'Your reports: drafts, submissions and what the office returned.',
  myexpenses: 'Your expenses: what you have recorded and its review state.',
  newlead: 'Quick intake: the office types in what a phone call brought — Insurance, Private or Legal — and fills the rest in later.',
  case: 'A case workspace: Overview answers "what now", with Activity, Daily Summary, Evidence, Report and Billing one tap away. Everything you do here lands on the same records the rest of the portal reads.',
};

/* The verbs Beta refuses BY NAME (owner: "conversational wording must never
   bypass this restriction"). Matched against the utterance server-side; the
   answer names the block and the manual door that still works. */
const ASSISTANT_BLOCKED = [
  [/\b(send|email|resend)\b/i, 'sending anything to a client'],
  [/\brecord (a )?payment\b|\bmark .*paid\b/i, 'recording payments'],
  [/\bdelete\b/i, 'deleting records'],
  [/\barchiv/i, 'archiving'],
  [/\bclose (the )?case\b|\bclose this\b/i, 'closing cases'],
  [/\bassign\b/i, 'assigning investigators'],
  [/\bapprove\b/i, 'approvals'],
  [/\b(change|set|update) .*(price|fee|rate|retainer)\b/i, 'changing pricing'],
  [/\bauthoriz|\bauthoris/i, 'changing a case authorization'],
];

const asstStrip = s => String(s || '').toLowerCase()
  .replace(/[?.!,]/g, ' ')
  .replace(/\b(please|can you|could you|would you|the|my|our|a|an|to|me|us|section|page|screen|tab)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

function assistantNavMatch(text, role) {
  const t = asstStrip(text);
  if (!t) return null;
  let best = null;
  for (const n of ASSISTANT_NAV) {
    if (!n.roles.includes(role)) continue;
    for (const a of n.aliases) {
      const al = asstStrip(a);
      if (t === al || t.includes(al)) {
        if (!best || al.length > best.len) best = { nav: n, len: al.length };
      }
    }
  }
  return best ? best.nav : null;
}

/* GET /assistant/state — what the panel needs to draw: the Beta facts, the
   provider's honest state, and the navigation this ROLE may be offered. */
async function assistantState(env, user) {
  return json({
    beta: true,
    banner: 'ASSISTANT BETA — DRY RUN MODE. No external client messages or consequential actions will be sent.',
    provider: assistantProvider(env),
    role: user.role,
    nav: assistantNavFor(user.role),
  });
}

/* The live counts a status question reads — the same tables the dashboard
   reads, bounded, hidden cases excluded, scoped per role. */
async function assistantCounts(env, user) {
  const missing = await missingTables(env);
  const have = t => !missing.includes(t);
  const hide = [
    have('case_archive') ? 'AND s.case_no NOT IN (SELECT case_no FROM case_archive)' : '',
    have('case_deleted') ? 'AND s.case_no NOT IN (SELECT case_no FROM case_deleted)' : '',
  ].filter(Boolean).join(' ');
  if (user.role === 'admin') {
    const fresh = await env.DB.prepare(
      `SELECT s.case_no, s.kind, s.client_name, s.carrier, s.created_at, s.payload
         FROM submissions s
        WHERE s.status = 'new' ${hide}
          AND NOT EXISTS (SELECT 1 FROM lead_status l WHERE l.case_no = s.case_no
                            AND l.status IN ('converted','declined','closed_lead'))
        ORDER BY s.id DESC LIMIT 6`).all();
    const open = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM submissions s WHERE s.status != 'closed' ${hide}`).first();
    return { fresh: (fresh.results || []).map(r => {
      let svc = null; try { svc = (legalServiceForSub(r) || {}).label || null; } catch { svc = null; }
      return { case_no: r.case_no, kind: r.kind,
               who: r.kind === 'claims' ? (r.carrier || r.client_name) : r.client_name,
               legal_service: svc, created_at: r.created_at };
    }), open: Number(open && open.n) || 0 };
  }
  const mine = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM submissions s WHERE s.assigned_to = ? AND s.status != 'closed' ${hide}`)
    .bind(user.id).first();
  return { fresh: [], open: Number(mine && mine.n) || 0 };
}

/* ---------------- UNIT 4 — intake preparation, preview, SIMULATE ----------

   The owner's §12: the Assistant may PREPARE an intake link exactly as the
   real desk would — the same validation, the same email rendering, the same
   door pairing — and then SIMULATE the send. The rehearsal is complete and
   the send never happens: the mail sender is not called, the real send
   history gains no row, and the lead ladder does not move (source pins count
   all three). What a simulation writes is `assistant_log`, its own table,
   where every row states the outcome on its face. */

const ASSISTANT_SIM_OUTCOME = 'SIMULATED — NOT SENT';

/* One resolver for prepare and simulate, mirroring the two real doors: a case
   reference resolves the door from the case's own record (the payload marker
   outranking kind, exactly as the desk send does — `contextForSub`), and a
   pre-case rehearsal names an explicit kind, the same three answers
   `/intake-link/email` accepts. A rehearsal must also mirror the REFUSALS the
   real send would hit — a dry run that answers READY TO SEND about a send the
   portal would refuse is a rehearsal of the wrong play — so the deleted and
   archived gates run here too, through the same shared helper. */
async function assistantIntakePlan(env, body) {
  const to = String(body.to || '').trim();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(to) || to.length > 200) {
    return { fail: json({ error: 'Enter a valid email address.' }, 400) };
  }
  let name = String(body.name || '')
    .replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 120);

  /* Both branches produce a CONTEXT and nothing else; the door is derived
     from it exactly once below, because the context-to-door table having one
     reader per sender is the guard that caught the sheet-keyed door bug. */
  let context = null, caseNo = null;
  const ref = String(body.case_no || '').trim().slice(0, 64);
  if (ref) {
    if (!CASE_NO_RE.test(ref)) {
      return { fail: json({ error: 'That case reference is not a case number.' }, 400) };
    }
    const lead = await env.DB.prepare(
      'SELECT case_no, kind, client_name, payload FROM submissions WHERE case_no = ?').bind(ref).first();
    if (!lead) {
      return { fail: json({ error: `No case ${ref} exists. For someone who is not on the desk yet, `
        + `leave the case blank and say which intake this is.` }, 404) };
    }
    const refusal = await caseSendRefusal(env, ref);
    if (refusal) return { fail: refusal };
    context = contextForSub(lead);
    if (!context) {
      return { fail: json({ error: `${ref} does not say whether it is a private client or a claim `
        + `assignment, so the right intake form cannot be chosen.` }, 409) };
    }
    caseNo = ref;
    if (!name) name = String(lead.client_name || '');
  } else {
    const kind = String(body.kind || '').trim().toLowerCase();
    context = kind === 'legal' ? SEND_CONTEXT.LEGAL
      : contextForKind(
          kind === 'insurance' || kind === 'claims' ? 'claims'
          : kind === 'private' || kind === 'consumer' ? 'consumer' : null);
  }
  const intake = context ? intakeForContext(context) : null;
  if (!intake) {
    return { fail: json({ error: 'Say which intake this is — Private Client, Insurance Assignment or '
                       + 'Legal / Law Firm. The forms are never interchangeable.' }, 400) };
  }
  return { to, name, context, intake, caseNo };
}

/* POST /assistant/prepare-intake — the rehearsal's PREVIEW: what WOULD go,
   rendered by the same function the real send renders with, plus the door,
   context and subject line. Reads only; nothing is spent, logged or sent. */
async function assistantPrepareIntake(request, env) {
  const plan = await assistantIntakePlan(env, await readJson(request));
  if (plan.fail) return plan.fail;
  const { text } = intakeInviteEmail(plan.intake, plan.name);
  return json({ ok: true, dry_run: true,
    to: plan.to, name: plan.name || null, case_no: plan.caseNo,
    send_context: plan.context, intake: plan.intake.label, door: plan.intake.url,
    subject: `${plan.intake.label} — Always Precise Investigations`,
    body_text: text });
}

/* THE ONE LOG WRITER (Unit 5 extracted it from the intake simulate so a
   second rehearsal kind could not become a second INSERT — the source pin
   counts one, and one it stays). Honest about itself: a missing table
   degrades to logged:false with the named reason — the integrity-record
   rule, because a success that hides an unrecorded rehearsal and a 500 that
   eats the answer are both lies — and a refused row answers the same way. */
async function assistantLogged(env, user, action, base, detail) {
  if ((await missingTables(env)).includes('assistant_log')) {
    return json({ ...base, logged: false, reason: 'not_set_up',
      note: 'Run the portal-setup workflow to add the Assistant log table; until then rehearsals are not recorded.' });
  }
  try {
    await env.DB.prepare(
      `INSERT INTO assistant_log (action, outcome, case_no, recipient, detail, done_by, done_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(action, ASSISTANT_SIM_OUTCOME, base.case_no || null, base.to,
            JSON.stringify(detail), user ? user.id : null, nowIso()).run();
  } catch {
    return json({ ...base, logged: false, reason: 'log_write_failed' });
  }
  return json({ ...base, logged: true });
}

/* POST /assistant/simulate-intake — the rehearsal recorded. */
async function assistantSimulateIntake(request, env, user) {
  const plan = await assistantIntakePlan(env, await readJson(request));
  if (plan.fail) return plan.fail;
  const subject = `${plan.intake.label} — Always Precise Investigations`;
  return assistantLogged(env, user, 'intake_send',
    { ok: true, outcome: ASSISTANT_SIM_OUTCOME, to: plan.to,
      case_no: plan.caseNo, send_context: plan.context, intake: plan.intake.label },
    { context: plan.context, door: plan.intake.url, subject });
}

/* ---------------- UNIT 5 — rate-sheet preparation, preview, SIMULATE ------

   The intake rehearsal's shape applied to the sheet sender: this resolver
   MIRRORS the real route's resolution step for step — the context rules, the
   case pairing, the legal service and its fee, the payment-method boundary —
   and contains no way to send. It is deliberately a pinned mirror rather
   than surgery on the real sender: the suite holds the two together the
   strong way, same inputs through both producing the SAME subject and body
   byte for byte and the same refusals by code, so a divergence fails loudly
   instead of drifting. If a THIRD consumer of this resolution ever appears,
   extract the shared resolver then — the third-reader lesson. */
async function assistantSheetPlan(env, body) {
  const id = String(body.id || body.sheet || '').trim();
  if (!sheetById(id)) return { fail: json({ error: 'no such rate sheet' }, 404) };
  const to = String(body.to || '').trim();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(to) || to.length > 200) {
    return { fail: json({ error: 'Enter a valid email address.' }, 400) };
  }
  const note = String(body.note || '')
    .replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 500);
  const caseNo = String(body.case_no || '').replace(/[^\x20-\x7e]/g, '').slice(0, 64);

  let linkedCase = null, caseSub = null;
  let sendCtx = contextForSheet(id);
  const askedCtx = String(body.send_context || '').trim().toLowerCase();
  if (askedCtx) {
    if (!Object.values(SEND_CONTEXT).includes(askedCtx) || !sheetAllowsContext(id, askedCtx)) {
      return { fail: json({ error: `That rate sheet cannot be sent as a ${askedCtx || 'blank'} `
        + 'assignment. Private and Legal share the retainer sheet; the carrier sheet is '
        + 'insurance only.', code: 'context_not_allowed' }, 400) };
    }
    sendCtx = askedCtx;
  }
  const includePayment = body.include_payment === true || body.include_payment === 1
    || body.include_payment === '1';
  if (caseNo) {
    const lead = await env.DB.prepare('SELECT kind, payload FROM submissions WHERE case_no = ?')
      .bind(caseNo).first();
    if (lead) {
      const refusal = await caseSendRefusal(env, caseNo);
      if (refusal) return { fail: refusal };
      linkedCase = caseNo;
      caseSub = lead;
      sendCtx = contextForSub(lead) || sendCtx;
      const wanted = CONTEXT_SHEET[sendCtx];
      if (wanted && id !== wanted) {
        return { fail: json({ error: sendCtx === SEND_CONTEXT.INSURANCE
          ? `${caseNo} is a claim assignment — send it the Insurance Assignment Rates, never the consumer sheet.`
          : `${caseNo} is a private client — send it the Private Client Retainer, never the carrier sheet.`,
          expected_sheet: wanted }, 400) };
      }
    }
  }
  const askedSvc = String(body.legal_service || '').trim().toLowerCase();
  let legalSvc = null;
  if (askedSvc) {
    if (sendCtx !== SEND_CONTEXT.LEGAL) {
      return { fail: json({ error: `Legal services describe legal sends, and this send is ${sendCtx}. `
        + 'Leave the legal service out, or send from the Legal card.',
        code: 'legal_service_not_legal' }, 400) };
    }
    legalSvc = legalServiceById(askedSvc);
    if (!legalSvc) {
      return { fail: json({ error: 'No such legal service. The services are: '
        + Object.values(LEGAL_SERVICES).map(s => `${s.id} — ${s.label}`).join('; ') + '.',
        code: 'unknown_legal_service' }, 400) };
    }
  } else if (sendCtx === SEND_CONTEXT.LEGAL) {
    legalSvc = legalServiceForSub(caseSub);
  }
  let flatFee = null;
  if (body.flat_fee !== undefined && body.flat_fee !== null && String(body.flat_fee).trim() !== '') {
    if (!legalSvc || legalSvc.model !== 'fixed') {
      return { fail: json({ error: 'A flat fee describes a fixed-price legal service — this send is not '
        + 'one. Pick Person Locate / Skip Trace or Process Service, or leave the fee out.',
        code: 'flat_fee_not_fixed' }, 400) };
    }
    const n = Number(String(body.flat_fee).replace(/[$,\s]/g, ''));
    if (!(Number.isFinite(n) && n > 0 && n <= 1000000)) {
      return { fail: json({ error: 'Enter the flat fee as a dollar amount above zero.',
        code: 'bad_flat_fee' }, 400) };
    }
    flatFee = Math.round(n * 100) / 100;
  }
  if (legalSvc && legalSvc.model === 'fixed' && flatFee == null) {
    const stored = linkedCase ? await env.DB.prepare(
      'SELECT retainer_amount FROM case_retainer WHERE case_no = ?').bind(linkedCase).first() : null;
    flatFee = stored && stored.retainer_amount != null
      ? Number(stored.retainer_amount)
      : await legalFlatDefault(env, legalSvc.id);
  }
  const rawMethods = Array.isArray(body.methods) ? body.methods.map(x => String(x)) : null;
  const billcom = await billcomState(env);
  const npAllowed = billcom.ready ? ['mail_check', 'bill_com'] : ['mail_check'];
  const npPicked = includePayment && !CONTEXT_TAKES_PAYMENT(sendCtx)
    && rawMethods !== null && rawMethods.length > 0
    && rawMethods.every(m => npAllowed.includes(m))
    ? [...new Set(rawMethods)] : [];
  if (includePayment && !CONTEXT_TAKES_PAYMENT(sendCtx) && !npPicked.length) {
    if ((rawMethods || []).includes('bill_com') && !billcom.ready
        && (rawMethods || []).every(m => m === 'bill_com' || m === 'mail_check')) {
      return { fail: json({ error: 'Bill.com is not configured yet — it needs the enable word and the '
        + 'https payment link in Settings → Invoice defaults before it can be offered. '
        + 'Mail Check is available now.', code: 'billcom_not_configured' }, 400) };
    }
    const who = linkedCase ? `${linkedCase} is a ${sendCtx} assignment` : `This is a ${sendCtx} assignment`;
    return { fail: json({ error: `${who} — Cash App and Venmo are private-client methods and cannot be `
      + `included. The payment options here are Mail Check${billcom.ready ? ' and Bill.com' : ''}.`,
      code: 'legal_no_payment_block' }, 400) };
  }
  if (includePayment && CONTEXT_TAKES_PAYMENT(sendCtx)
      && (rawMethods || []).some(m => m === 'mail_check' || m === 'bill_com')) {
    return { fail: json({ error: 'Mail Check and Bill.com ride legal and insurance sends. A private '
      + 'client keeps the Cash App and Venmo options.', code: 'mail_check_not_private' }, 400) };
  }
  /* No rate-limit spend here: nothing is about to be sent. */
  const retainer = await retainerForSend(env, caseNo, body.retainer_amount);
  const sheet = legalSvc && legalSvc.model === 'fixed'
    ? legalFixedSheet(legalSvc, flatFee)
    : sheetForContext(id, sendCtx, retainer);
  const includeIntake = body.include_intake === true || body.include_intake === 1 || body.include_intake === '1';
  const baseDoor = includeIntake ? (intakeForContext(sendCtx) || null) : null;
  const intakeDoor = baseDoor && legalSvc
    ? { ...baseDoor, url: `${baseDoor.url}&service=${legalSvc.id}` }
    : baseDoor;
  if (includePayment && !npPicked.length && !sheetTakesPayment(sheet.id)) {
    return { fail: json({ error: 'Payment options are private-client only and cannot be sent with the '
                       + 'Insurance Assignment Rates.' }, 400) };
  }
  const wantedMethods = Array.isArray(body.methods)
    ? body.methods.map(x => String(x)).filter(x => PAY_IDS.includes(x)) : null;
  const brokenMethods = [];
  const payment = (includePayment && !npPicked.length)
    ? await paymentOptionsFor(env, wantedMethods, brokenMethods, contextForSheet(sheet.id)) : [];
  if (includePayment && !npPicked.length && brokenMethods.length) {
    const names = brokenMethods.map(m => m.display_name || m.label).join(' and ');
    return { fail: json({ error: `${names} is switched on but has no payment link, so it cannot be `
                       + `offered — every payment option a client sees has to be tappable. `
                       + `Add a link in Settings, or switch it off.`,
                  needs_link: brokenMethods.map(m => m.id) }, 400) };
  }
  if (includePayment && !npPicked.length && !payment.length) {
    return { fail: json({ error: wantedMethods && !wantedMethods.length
      ? 'Choose at least one payment method, or untick payment instructions.'
      : 'No payment method is enabled and configured. Set one up in Settings '
        + 'before including payment instructions.' }, 400) };
  }
  const { text } = sheetEmail(withBillcomLine(sheet,
    billcom.ready && !CONTEXT_TAKES_PAYMENT(sendCtx)), note, intakeDoor, payment, retainer, npPicked);
  const subject = caseNo
    ? `${sheet.name} — Always Precise Investigations (case ${caseNo})`
    : `${sheet.name} — Always Precise Investigations`;
  return { to, subject, text, sendCtx, legalSvc, flatFee, sheet, intakeDoor,
           payment, npPicked, linkedCase, caseNo };
}

/* POST /assistant/prepare-sheet — what WOULD go, priced by the real
   resolvers, and the response shaped like the real sender's own answer. */
async function assistantPrepareSheet(request, env) {
  const plan = await assistantSheetPlan(env, await readJson(request));
  if (plan.fail) return plan.fail;
  return json({ ok: true, dry_run: true, to: plan.to, case_no: plan.linkedCase,
    send_context: plan.sendCtx, sheet: plan.sheet.id, sheet_name: plan.sheet.name,
    legal_service: plan.legalSvc
      ? { id: plan.legalSvc.id, label: plan.legalSvc.label, model: plan.legalSvc.model } : undefined,
    flat_fee: plan.legalSvc && plan.legalSvc.model === 'fixed' ? plan.flatFee : undefined,
    included: {
      rate_sheet: plan.sheet.name,
      intake: plan.intakeDoor ? plan.intakeDoor.label : null,
      payment_methods: plan.npPicked.length
        ? plan.npPicked.map(m => ({ id: m, label: m === 'bill_com' ? BILLCOM_LINE.label : MAIL_CHECK_LINE.label }))
        : plan.payment.map(x => ({ id: x.id, label: x.label })),
    },
    subject: plan.subject, body_text: plan.text });
}

/* POST /assistant/simulate-sheet — the sheet rehearsal recorded, through the
   one log writer. */
async function assistantSimulateSheet(request, env, user) {
  const plan = await assistantSheetPlan(env, await readJson(request));
  if (plan.fail) return plan.fail;
  return assistantLogged(env, user, 'sheet_send',
    { ok: true, outcome: ASSISTANT_SIM_OUTCOME, to: plan.to,
      case_no: plan.linkedCase, send_context: plan.sendCtx,
      sheet: plan.sheet.id, sheet_name: plan.sheet.name },
    { context: plan.sendCtx, sheet_id: plan.sheet.id, subject: plan.subject,
      door: plan.intakeDoor ? plan.intakeDoor.url : null,
      methods: plan.npPicked.length ? plan.npPicked : plan.payment.map(x => x.id) });
}

/* ---------------- UNIT 6 (completed) — the ZERO-WRITE invoice preview -----

   Owner rule: the Assistant may show the invoice EXACTLY as it would be
   prepared and must not create an invoice row, a draft, a number
   reservation, a payment record or any persistent billing write. So this is
   a VIEW-MODEL over the same derivations the real `createInvoice` runs — the
   same bill-to, refs, terms, authorization-seeded lines and agreed figures —
   composed from reads alone. The would-be invoice number comes from the same
   MAX-derived read the real route uses, so deriving it consumes nothing: the
   next real invoice still receives exactly the number the preview showed,
   and a test proves it. `invoiceMoney` and `retainerBlock` are pure over
   what they are handed (the block reads only `invoice_type` and `case_no`),
   so the preview's money is the real arithmetic. The suite pins the mirror
   the Unit 5 way: a twin case created for real must match the preview field
   for field. */
const ASSISTANT_PREVIEW_OUTCOME = 'SIMULATED — NOT CREATED';

async function assistantInvoicePreview(env, caseNo) {
  const sub = await env.DB.prepare('SELECT * FROM submissions WHERE case_no = ?').bind(caseNo).first();
  if (!sub) return { fail: json({ error: 'not found' }, 404) };
  const refusal = await caseSendRefusal(env, caseNo);
  if (refusal) return { fail: refusal };

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
  const billingEmail = (type === 'insurance'
    ? (payload.billing_email || payload.adjuster_email)
    : (sub.client_email || payload.client_email)) || null;
  const terms = type === 'insurance' ? cfg.terms_insurance : cfg.terms_private;

  /* The from-authorization seeding, mirrored read-for-read. */
  const lines = [];
  let clientNotes = null;
  if (type === 'insurance') {
    const meta = await env.DB.prepare(
      'SELECT authorized_hours FROM case_meta WHERE case_no = ?').bind(caseNo).first();
    const hours = meta ? Number(meta.authorized_hours) : null;
    const pkg = hours != null ? RATES.packages.find(pk => pk.hours === hours) : null;
    if (pkg) {
      lines.push({ description: `${pkg.hours}-Hour Surveillance Authorization`, qty: 1, rate: null, amount: pkg.price });
    } else if (hours) {
      lines.push({ description: 'Authorized Surveillance', qty: hours, rate: RATES.surveillance.standard,
        amount: Math.round(hours * RATES.surveillance.standard * 100) / 100 });
    }
  } else {
    const ret = await env.DB.prepare(
      'SELECT retainer_amount FROM case_retainer WHERE case_no = ?').bind(caseNo).first();
    const retAmount = ret && ret.retainer_amount != null ? Number(ret.retainer_amount) : PERSONAL.retainer;
    lines.push({ description: 'Investigation Retainer', qty: 1, rate: null, amount: retAmount });
    clientNotes = 'Retainer is applied toward authorized investigative services.';
  }

  const money = invoiceMoney(lines, 0, []);
  const retainer = await retainerBlock(env, { invoice_type: type, case_no: caseNo }, sub);
  const wouldBeNo = await nextInvoiceNo(env);
  const dup = await env.DB.prepare(
    "SELECT invoice_no FROM invoices WHERE case_no = ? AND status != 'void' LIMIT 1").bind(caseNo).first();

  const fmt = n => '$' + (Math.round(Number(n || 0) * 100) / 100)
    .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const text = [
    `DRY RUN — INVOICE PREVIEW`,
    ASSISTANT_PREVIEW_OUTCOME,
    ``,
    `Case: ${caseNo} (${type})`,
    `Would-be number: ${wouldBeNo} — derived, NOT reserved`,
    `Issue date: ${nowIso().slice(0, 10)} · Terms: ${terms || '—'}`,
    `Bill to: ${billTo || '—'}`,
    billingEmail ? `Billing email: ${billingEmail}` : null,
    Object.keys(refs).length
      ? `Refs: ${Object.entries(refs).map(([k, v]) => `${k}=${v}`).join(' · ')}` : null,
    ``,
    ...lines.map(l => `  ${l.description} — ${l.qty} × ${l.rate == null ? 'flat' : fmt(l.rate)} = ${fmt(l.amount)}`),
    lines.length ? null : `  (no authorization on file — the real Create would open with no lines)`,
    ``,
    `Subtotal ${fmt(money.subtotal)} · Total ${fmt(money.total)} · Balance due ${fmt(money.balance_due)}`,
    retainer ? `${retainer.model === 'fixed' ? 'Agreed flat fee' : 'Retainer'}: ${fmt(retainer.amount)}`
      + ` · received: ${retainer.received ? 'yes' : 'not yet'}`
      + (retainer.applied != null ? ` · applied ${fmt(retainer.applied)} · remaining ${fmt(retainer.balance)}` : '') : null,
    clientNotes ? `Note: ${clientNotes}` : null,
    dup ? `` : null,
    dup ? `⚠ ${dup.invoice_no} already bills this case — the real Create will ask to confirm a supplemental.` : null,
    ``,
    `Nothing was written. Create the real invoice from Billing when ready.`,
  ].filter(x => x !== null).join('\n');

  return { ok: true, preview: {
    case_no: caseNo, invoice_type: type, would_be_no: wouldBeNo, terms: terms || null,
    bill_to: billTo || null, billing_email: billingEmail, refs, lines, clientNotes,
    subtotal: money.subtotal, total: money.total, balance_due: money.balance_due,
    retainer, duplicate_of: dup ? dup.invoice_no : null,
  }, text };
}

/* ---------------- UNIT 7 — case health and operational assistance ---------

   Every answer is composed from RECORDED FACTS through functions that
   already exist: `closeoutFacts` for "ready to close", the extracted
   `intakeBlockersFound` for "why can't I delete", `shippableReports` for
   package readiness, and the case's own rows for everything else. Activity
   is quoted VERBATIM, counts are counted, and a fact that is not recorded
   is said to be absent — nothing here writes prose on anyone's behalf, and
   nothing invents an event, a time, a vehicle or an amount. */

const asstFmt$ = n => '$' + (Math.round(Number(n || 0) * 100) / 100)
  .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* The one writer of a case's next step — the what-should-I-do branch and the
   health summary both read it, so they cannot disagree. */
async function assistantCaseNextStep(env, caseNo) {
  const day = await env.DB.prepare(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN end_time IS NULL THEN 1 ELSE 0 END) AS open
       FROM case_days WHERE case_no = ?`).bind(caseNo).first();
  const rep = await env.DB.prepare(
    `SELECT status FROM case_reports WHERE case_no = ? ORDER BY id DESC LIMIT 1`).bind(caseNo).first();
  return Number(day && day.open) > 0 ? 'An investigation day is running — continue the activity log, and end the day when the field work is done.'
    : !Number(day && day.n) ? 'No investigation day has run yet. Starting one is the next step.'
    : !rep ? 'Field days exist with no report. Drafting the report is the next step.'
    : rep.status === 'draft' ? 'The report is still a draft. Finishing and submitting it is the next step.'
    : rep.status === 'submitted' ? 'The report is with the office for review.'
    : 'Field work and reporting are in hand — billing and the client package are the remaining stations.';
}

/* The shared facts a health answer reads — bounded, role-scoped by the
   caller having already passed `caseFor`. */
async function assistantCaseHealth(env, caseNo) {
  const days = await env.DB.prepare(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN end_time IS NULL THEN 1 ELSE 0 END) AS open,
            MAX(day_date) AS last_date FROM case_days WHERE case_no = ?`).bind(caseNo).first();
  const acts = await env.DB.prepare(
    `SELECT COUNT(*) AS n, MAX(at_date) AS last FROM activity_log a
      WHERE a.case_no = ?
        AND NOT EXISTS (SELECT 1 FROM activity_removed r WHERE r.entry_id = a.id)`).bind(caseNo).first();
  const reps = (await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM case_reports WHERE case_no = ? GROUP BY status`).bind(caseNo).all()).results || [];
  const ev = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM case_evidence WHERE case_no = ? AND deleted_at IS NULL`).bind(caseNo).first();
  return { days, acts, reps, evidence: Number(ev && ev.n) || 0 };
}

/* The recorded chronology, verbatim: Day N — date, then each surviving entry
   as "HH:MM — text". The one composition both the daily summary answer and
   the report draft read. Capped and the cap is named. */
async function assistantChronology(env, caseNo, { dayId = null, cap = 200 } = {}) {
  const days = (await env.DB.prepare(
    `SELECT id, day_date, start_time, end_time FROM case_days
      WHERE case_no = ? ${dayId ? 'AND id = ?' : ''} ORDER BY id`)
    .bind(...(dayId ? [caseNo, dayId] : [caseNo])).all()).results || [];
  const out = [];
  let used = 0, cut = false;
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const entries = (await env.DB.prepare(
      `SELECT at_time, description FROM activity_log a
        WHERE a.day_id = ?
          AND NOT EXISTS (SELECT 1 FROM activity_removed r WHERE r.entry_id = a.id)
        ORDER BY a.at_date, a.at_time, a.id LIMIT ?`).bind(d.id, cap - used + 1).all()).results || [];
    out.push(`Day ${i + 1} — ${d.day_date}${d.end_time ? '' : ' (still running)'}`);
    for (const e of entries) {
      if (used >= cap) { cut = true; break; }
      out.push(`  ${e.at_time || '—'} — ${String(e.description || '').slice(0, 300)}`);
      used++;
    }
    if (!entries.length) out.push('  (no recorded entries)');
    if (cut) break;
  }
  if (cut) out.push(`… capped at ${cap} entries — the full log is on the Activity tab.`);
  return { text: out.join('\n'), days: days.length, entries: used, capped: cut };
}

/* ---------------- UNIT 8 — Assistant Watch: proactive INTERNAL attention --

   Beta Watch is a COMPOSITION, not a notifier: it answers when asked, inside
   the signed-in panel, and there is no path from here to email, SMS, a
   client, a payment or a destructive act — the same absence-of-code that
   protects everything else in this block. It prefers existing portal state
   over new machinery: the exception list IS `needsAttention` (merged whole,
   its severities kept), and the added arms — fresh intakes by business,
   overdue and due-soon invoices, packages finalized but not delivered,
   refused uploads, unassigned cases, and the delivered-and-paid conjunction
   worth a closeout look — are each ONE bounded read over rows that already
   exist. Nothing is stored, nothing polls, nothing fires on its own. */
async function assistantWatch(env, user) {
  const hidden = await hiddenCases(env);
  const missing = await missingTables(env);
  const rows = [];
  const push = (group, title, line, caseNo) =>
    rows.push({ title: `${group}: ${title}`, line, case_no: caseNo || null });

  /* The existing exception list, whole — same role gate, same derivations. */
  const att = await (await needsAttention(env, user)).json();
  for (const a of (att.alerts || []).slice(0, 12)) {
    push('Attention', a.what, [a.severity, a.case_no, a.why].filter(Boolean).join(' · '), a.case_no);
  }

  const c = await assistantCounts(env, user);
  for (const f of c.fresh) {
    push('Intake', `new ${f.kind === 'claims' ? 'Insurance' : f.legal_service ? `Legal — ${f.legal_service}` : 'Private / Legal'} intake`,
      [f.who, f.created_at ? String(f.created_at).slice(0, 10) : ''].filter(Boolean).join(' · '), f.case_no);
  }

  const inv = await (await listInvoices(new Request('http://assistant.internal/invoices'), env)).json();
  const live = (inv.invoices || []).filter(i => i.status !== 'void' && !hidden.has(i.case_no));
  for (const i of live.filter(x => x.display_status === 'overdue').slice(0, 6)) {
    push('Money', `${i.invoice_no} is overdue`, `${i.case_no} · balance ${asstFmt$(i.balance_due)}`, i.case_no);
  }
  const dueSoon = Number((inv.summary || {}).due_soon) || 0;
  if (dueSoon) push('Money', `${dueSoon} invoice${dueSoon === 1 ? '' : 's'} due within 14 days`, 'listed on Billing', null);

  const readyPk = (await env.DB.prepare(
    `SELECT id, case_no, finalized_at FROM case_builds
      WHERE status = 'finalized' AND delivered_at IS NULL ORDER BY id DESC LIMIT 6`).all()).results || [];
  for (const b of readyPk.filter(b2 => !hidden.has(b2.case_no))) {
    push('Delivery', `package #${b.id} finalized, not delivered`,
      `${b.case_no} · finalized ${String(b.finalized_at || '').slice(0, 10)}`, b.case_no);
  }

  if (!missing.includes('storage_failure')) {
    const fails = (await env.DB.prepare(
      `SELECT case_no, reason, at FROM storage_failure ORDER BY id DESC LIMIT 5`).all()).results || [];
    for (const f of fails) {
      push('Storage', 'an upload was refused', [f.case_no, f.reason, String(f.at || '').slice(0, 10)]
        .filter(Boolean).join(' · '), f.case_no);
    }
  }

  const unassigned = (await env.DB.prepare(
    `SELECT case_no, client_name FROM submissions
      WHERE assigned_to IS NULL AND status NOT IN ('new', 'closed')
      ORDER BY id DESC LIMIT 6`).all()).results || [];
  for (const u of unassigned.filter(u2 => !hidden.has(u2.case_no))) {
    push('Cases', 'accepted with no investigator', u.client_name || u.case_no, u.case_no);
  }

  /* Delivered AND paid AND still open — three recorded facts, worded softly:
     the closeout checklist is where a person decides. */
  const delivered = (await env.DB.prepare(
    `SELECT DISTINCT b.case_no FROM case_builds b
       JOIN submissions s ON s.case_no = b.case_no
      WHERE b.delivered_at IS NOT NULL AND s.status != 'closed' LIMIT 12`).all()).results || [];
  const balByCase = {};
  for (const i of live) {
    if (i.status === 'draft') continue;
    balByCase[i.case_no] = (balByCase[i.case_no] || 0) + Math.max(0, Number(i.balance_due) || 0);
  }
  let closeN = 0;
  for (const d of delivered) {
    if (hidden.has(d.case_no) || (balByCase[d.case_no] || 0) > 0 || closeN >= 5) continue;
    push('Cases', 'delivered and nothing outstanding — worth the closeout checklist', d.case_no, d.case_no);
    closeN++;
  }

  return rows.slice(0, 30);
}

/* ---------------- UNIT 10 — TOPIC COMMANDS: a menu that talks back --------

   A bare word — "intakes", "invoices", "cases" — answers with LIVE STATUS
   plus the actions that fit the situation, so a non-technical member of
   staff types one word and knows what is happening, whether anything needs
   attention, and where to go. Counts are counted, never invented; the
   primary action changes with the state; and every offered action is a
   NAVIGATION (registry id), a SAY (a phrase fed back through this same
   deterministic grammar, exactly as if typed), or a SEED (text placed in
   the box for the person to finish) — nothing here can delete, archive,
   send, pay or close, in Beta or by these buttons ever.

   DORMANT-INTAKE INTELLIGENCE runs the SAME eligibility probe the real
   delete runs (`intakeBlockersFound`), so "eligible for cleanup review"
   means exactly "the quick delete would not refuse this", and PROTECTED
   names what it carries. The Assistant identifies and explains; deleting
   stays the manual control on the intake card, and the answer says so. */

const nav = (label, id, kind = 'tab') => ({ label, navigate: kind === 'case' ? { kind, case_no: id } : { kind, id } });
const say = (label, text) => ({ label, say: text });
const seed = (label, text) => ({ label, seed: text });

/* The undecided-intake base: on the desk, no final decision recorded. */
const UNDECIDED = `FROM submissions s WHERE s.status = 'new'
  AND NOT EXISTS (SELECT 1 FROM lead_status l WHERE l.case_no = s.case_no
                    AND l.status IN ('converted','declined','closed_lead'))`;

async function assistantIntakeFacts(env) {
  const cutoff = new Date(Date.now() - ATTN.DORMANT_INTAKE_DAYS * 86400000).toISOString();
  const one = async sql => Number(((await env.DB.prepare(sql).bind(cutoff).first()) || {}).n) || 0;
  const fresh = Number(((await env.DB.prepare(
    `SELECT COUNT(*) AS n ${UNDECIDED} AND s.created_at >= ?`).bind(cutoff).first()) || {}).n) || 0;
  const dormant = await one(`SELECT COUNT(*) AS n ${UNDECIDED} AND s.created_at < ?`);
  const decided = Number(((await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM lead_status WHERE status IN ('closed_lead','declined')`).first()) || {}).n) || 0;
  const dupRows = (await env.DB.prepare(
    `SELECT s.client_name AS name, COUNT(*) AS n ${UNDECIDED}
       AND s.client_name IS NOT NULL AND s.client_name != ''
      GROUP BY s.client_name HAVING COUNT(*) > 1 LIMIT 6`).all()).results || [];
  return { fresh, dormant, decided, dupRows, cutoff };
}

/* Classify the dormant list the way the DELETE would judge it — capped, each
   probe the same bounded UNION statement the real route runs. */
async function assistantDormantList(env, cutoff, dupNames) {
  const rows = (await env.DB.prepare(
    `SELECT s.case_no, s.client_name, s.created_at,
            (SELECT status FROM lead_status l WHERE l.case_no = s.case_no) AS lead
       ${UNDECIDED} AND s.created_at < ? ORDER BY s.created_at LIMIT 8`).bind(cutoff).all()).results || [];
  const out = [];
  for (const r of rows) {
    let cls, why;
    const hold = await activeHold(env, r.case_no);
    if (hold) { cls = 'PROTECTED / LEGAL HOLD'; why = 'a legal hold refuses every removal'; }
    else {
      const found = await intakeBlockersFound(env, r.case_no);
      if (found.length) {
        const what = INTAKE_BLOCKERS.filter(([t]) => found.includes(t)).map(([, w]) => w);
        cls = 'PROTECTED / DEVELOPED CASE';
        why = `carries ${what.slice(0, 3).join(', ')}${what.length > 3 ? '…' : ''}`;
      } else if (dupNames.has(r.client_name || '')) {
        cls = 'POSSIBLE DUPLICATE'; why = `"${r.client_name}" appears on more than one undecided intake`;
      } else if (r.lead) {
        cls = 'NEEDS REVIEW'; why = `the lead is being worked (${r.lead}) — not a cleanup candidate`;
      } else {
        cls = 'ELIGIBLE FOR CLEANUP REVIEW'; why = 'no dependent records — the quick delete would not refuse it';
      }
    }
    out.push({ case_no: r.case_no, who: r.client_name || r.case_no,
      age_days: Math.floor((Date.now() - Date.parse(r.created_at)) / 86400000), cls, why });
  }
  return out;
}

const topicJson = (topic, lines, actions, card) => json({ ok: true, kind: 'topic',
  text: `${topic}\n${lines.filter(Boolean).join('\n')}`, actions, card: card || null });

async function assistantTopicAnswer(env, user, short, caseNo) {
  const admin = user.role === 'admin';
  const adminOnly = what => json({ ok: true, kind: 'status',
    text: `${what} is an admin desk. Cases and Today carry your own work.` });
  const is = re => re.test(short);

  /* ---- intakes ---- */
  if (is(/^(new )?(intakes?|leads?)$|^new cases$/)) {
    if (!admin) return adminOnly('Intake review');
    const f = await assistantIntakeFacts(env);
    const lines = [
      f.fresh ? `${f.fresh} new intake${f.fresh === 1 ? ' is' : 's are'} waiting for review.`
              : 'No new intakes are waiting for review.',
      (f.dormant || f.dupRows.length || f.decided) ? 'I found:' : null,
      f.dormant ? `- ${f.dormant} older undecided intake${f.dormant === 1 ? '' : 's'} (${ATTN.DORMANT_INTAKE_DAYS}+ days)` : null,
      f.dupRows.length ? `- ${f.dupRows.length} possible duplicate name${f.dupRows.length === 1 ? '' : 's'}` : null,
      f.decided ? `- ${f.decided} closed/declined lead record${f.decided === 1 ? '' : 's'} (kept)` : null,
      (!f.fresh && !f.dormant) ? 'No new or dormant intakes currently need attention.' : null,
    ];
    const actions = [];
    if (f.fresh) actions.push(nav('REVIEW NEW INTAKES', 'leads'));
    else if (f.dormant) actions.push(say('REVIEW CLEANUP CANDIDATES', 'old intakes'));
    if (f.dupRows.length) actions.push(say('CHECK FOR DUPLICATES', 'duplicate intakes'));
    if (!f.fresh) actions.push(nav('OPEN INTAKES', 'leads'));
    actions.push(say('PREPARE AN INTAKE', 'prepare an intake'));
    actions.push(seed('FIND AN INTAKE', 'Find '));
    return topicJson('INTAKES', lines, actions);
  }
  if (is(/^(old|dormant) intakes?$|^cleanup( candidates)?$/)) {
    if (!admin) return adminOnly('Intake review');
    const f = await assistantIntakeFacts(env);
    const list = await assistantDormantList(env, f.cutoff, new Set(f.dupRows.map(d => d.name)));
    if (!list.length) {
      return topicJson('DORMANT INTAKES', ['No undecided intake is older than '
        + `${ATTN.DORMANT_INTAKE_DAYS} days.`], [nav('OPEN INTAKES', 'leads')]);
    }
    const elig = list.filter(x => x.cls === 'ELIGIBLE FOR CLEANUP REVIEW').length;
    const prot = list.filter(x => x.cls.startsWith('PROTECTED')).length;
    return topicJson('DORMANT INTAKES', [
      `${list.length} older undecided intake${list.length === 1 ? '' : 's'} — ${elig} eligible for cleanup review, ${prot} protected.`,
      'The Assistant identifies and explains; deleting stays the manual control on the intake card, and Beta never deletes anything.',
    ], [nav('OPEN INTAKES', 'leads')],
      list.map(x => ({ title: `${x.cls} — ${x.who}`, case_no: x.case_no,
        line: `${x.case_no} · ${x.age_days}d old · ${x.why}` })));
  }
  if (is(/^duplicate intakes?$|^duplicates$/)) {
    if (!admin) return adminOnly('Intake review');
    const f = await assistantIntakeFacts(env);
    if (!f.dupRows.length) {
      return topicJson('DUPLICATE INTAKES', ['No undecided intake shares its client name with another.'],
        [nav('OPEN INTAKES', 'leads')]);
    }
    return topicJson('DUPLICATE INTAKES', [
      `${f.dupRows.length} name${f.dupRows.length === 1 ? '' : 's'} appear${f.dupRows.length === 1 ? 's' : ''} on more than one undecided intake — exact name matches only, nothing inferred.`,
    ], [nav('OPEN INTAKES', 'leads'), say('REVIEW CLEANUP CANDIDATES', 'old intakes')],
      f.dupRows.map(d => ({ title: d.name, line: `${d.n} undecided intakes carry this exact name` })));
  }

  /* ---- invoices / money ---- */
  if (is(/^(invoices?|billing|payments?)$/)) {
    if (!admin) return adminOnly('Billing');
    const data = await (await listInvoices(new Request('http://assistant.internal/invoices'), env)).json();
    const live = (data.invoices || []).filter(i => i.status !== 'void');
    const owing = live.filter(i => i.status !== 'draft' && Number(i.balance_due) > 0);
    const over = live.filter(i => i.display_status === 'overdue');
    const s = data.summary || {};
    const lines = [
      owing.length ? `${owing.length} invoice${owing.length === 1 ? ' has a balance' : 's have balances'} due.`
                   : 'No live invoice carries a balance.',
      over.length ? `${over.length} ${over.length === 1 ? 'is' : 'are'} overdue.` : null,
      `${asstFmt$(s.outstanding)} total outstanding.`,
    ];
    const actions = [nav('OPEN BILLING', 'invoices')];
    if (over.length) actions.push(say('SHOW OVERDUE', 'overdue'));
    if (owing.length) actions.push(say('SHOW UNPAID', 'unpaid'));
    actions.push(seed('FIND AN INVOICE', 'Find '));
    if (caseNo) actions.push(say('PREPARE INVOICE PREVIEW', 'invoice preview'));
    return topicJson('INVOICES', lines, actions);
  }
  if (is(/^overdue( invoices?)?$/)) {
    if (!admin) return adminOnly('Billing');
    const data = await (await listInvoices(new Request('http://assistant.internal/invoices'), env)).json();
    const over = (data.invoices || []).filter(i => i.status !== 'void' && i.display_status === 'overdue');
    return topicJson('OVERDUE', [over.length
      ? `${over.length} overdue invoice${over.length === 1 ? '' : 's'}, oldest first.`
      : 'Nothing is overdue.'], [nav('OPEN BILLING', 'invoices')],
      over.slice(0, 8).map(i => ({ title: `${i.invoice_no} — ${i.case_no}`, case_no: i.case_no,
        line: `balance ${asstFmt$(i.balance_due)} · due ${i.due_date || '—'}` })));
  }
  if (is(/^unpaid( invoices?)?$/)) {
    if (!admin) return adminOnly('Billing');
    const data = await (await listInvoices(new Request('http://assistant.internal/invoices'), env)).json();
    const owing = (data.invoices || []).filter(i =>
      i.status !== 'void' && i.status !== 'draft' && Number(i.balance_due) > 0);
    return topicJson('UNPAID', [owing.length
      ? `${owing.length} live invoice${owing.length === 1 ? ' carries' : 's carry'} a balance (drafts never count).`
      : 'No live invoice carries a balance.'], [nav('OPEN BILLING', 'invoices')],
      owing.slice(0, 8).map(i => ({ title: `${i.invoice_no} — ${i.display_status}`, case_no: i.case_no,
        line: `${i.case_no} · balance ${asstFmt$(i.balance_due)}` })));
  }

  /* ---- cases ---- */
  if (is(/^cases$/)) {
    /* Hidden cases leave every count, the assistantCounts pattern — and the
       clause has to name the right alias, so it is built per query. */
    const missingC = await missingTables(env);
    const hideOn = a => [
      missingC.includes('case_archive') ? '' : `AND ${a}case_no NOT IN (SELECT case_no FROM case_archive)`,
      missingC.includes('case_deleted') ? '' : `AND ${a}case_no NOT IN (SELECT case_no FROM case_deleted)`,
    ].filter(Boolean).join(' ');
    if (!admin) {
      const mine = await env.DB.prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN EXISTS (SELECT 1 FROM case_days d
             WHERE d.case_no = s.case_no AND d.end_time IS NULL) THEN 1 ELSE 0 END) AS active
           FROM submissions s WHERE s.assigned_to = ? AND s.status != 'closed'
             ${hideOn('s.')}`).bind(user.id).first();
      return topicJson('CASES', [
        `You have ${Number(mine.n) || 0} open assignment${Number(mine.n) === 1 ? '' : 's'}${Number(mine.active) ? ` — ${Number(mine.active)} with a day running now` : ''}.`,
      ], [nav('OPEN CASES', 'cases'), nav('TODAY', 'today')]);
    }
    const hide = hideOn('s.');
    const open = (await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM submissions s WHERE s.status != 'closed' ${hide}`).first());
    const activeNow = (await env.DB.prepare(
      `SELECT COUNT(DISTINCT case_no) AS n FROM case_days WHERE end_time IS NULL
         ${hideOn('')}`).first());
    const unassigned = (await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM submissions s
        WHERE s.assigned_to IS NULL AND s.status NOT IN ('new','closed') ${hide}`).first());
    const due = (await env.DB.prepare(
      `SELECT COUNT(DISTINCT d.case_no) AS n FROM case_days d WHERE d.end_time IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM case_reports r WHERE r.day_id = d.id)
         ${hideOn('d.')}`).first());
    const lines = [
      `${Number(open.n) || 0} open · ${Number(activeNow.n) || 0} active right now · ${Number(unassigned.n) || 0} unassigned · ${Number(due.n) || 0} with a finished day and no report.`,
    ];
    const actions = [nav('OPEN CASES', 'cases')];
    if (Number(unassigned.n)) actions.push(say('SHOW UNASSIGNED', 'unassigned'));
    if (Number(due.n)) actions.push(say('REPORTS DUE', 'reports due'));
    actions.push(say('READY TO CLOSE', 'ready to close'));
    return topicJson('CASES', lines, actions);
  }
  if (is(/^unassigned( cases?)?$/)) {
    if (!admin) return adminOnly('Assignment');
    const hidden = await hiddenCases(env);
    const rows = ((await env.DB.prepare(
      `SELECT case_no, client_name, kind FROM submissions
        WHERE assigned_to IS NULL AND status NOT IN ('new','closed') ORDER BY id DESC LIMIT 8`).all())
      .results || []).filter(r => !hidden.has(r.case_no));
    return topicJson('UNASSIGNED', [rows.length
      ? `${rows.length} accepted case${rows.length === 1 ? '' : 's'} with no investigator.`
      : 'Every accepted case has an investigator.'], [nav('OPEN CASES', 'cases')],
      rows.map(r => ({ title: r.client_name || r.case_no, case_no: r.case_no,
        line: `${r.case_no} · ${r.kind === 'claims' ? 'insurance' : 'private'}` })));
  }
  if (is(/^reports? due$/)) {
    if (!admin) return adminOnly('The report review desk');
    const hidden = await hiddenCases(env);
    const rows = ((await env.DB.prepare(
      `SELECT DISTINCT d.case_no FROM case_days d WHERE d.end_time IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM case_reports r WHERE r.day_id = d.id)
        ORDER BY d.case_no LIMIT 8`).all()).results || []).filter(r => !hidden.has(r.case_no));
    return topicJson('REPORTS DUE', [rows.length
      ? `${rows.length} case${rows.length === 1 ? ' has' : 's have'} a finished day with no report.`
      : 'Every finished day has its report.'], [nav('OPEN REPORTS & PACKAGES', 'delivery')],
      rows.map(r => ({ title: r.case_no, case_no: r.case_no, line: 'finished day, no report yet' })));
  }
  if (is(/^ready (to )?close$/)) {
    if (!admin) return adminOnly('Closing');
    const hidden = await hiddenCases(env);
    const data = await (await listInvoices(new Request('http://assistant.internal/invoices'), env)).json();
    const bal = {};
    for (const i of (data.invoices || [])) {
      if (i.status === 'void' || i.status === 'draft') continue;
      bal[i.case_no] = (bal[i.case_no] || 0) + Math.max(0, Number(i.balance_due) || 0);
    }
    const delivered = ((await env.DB.prepare(
      `SELECT DISTINCT b.case_no FROM case_builds b JOIN submissions s ON s.case_no = b.case_no
        WHERE b.delivered_at IS NOT NULL AND s.status != 'closed' LIMIT 12`).all()).results || [])
      .filter(r => !hidden.has(r.case_no) && !(bal[r.case_no] > 0)).slice(0, 8);
    return topicJson('READY TO CLOSE', [delivered.length
      ? `${delivered.length} open case${delivered.length === 1 ? '' : 's'} with a delivered package and nothing outstanding — worth the closeout checklist. The eight attestations stay human; nothing here closes anything.`
      : 'No open case pairs a delivered package with a clear balance yet.'],
      [nav('OPEN CASES', 'cases')],
      delivered.map(r => ({ title: r.case_no, case_no: r.case_no,
        line: 'delivered · no outstanding balance' })));
  }

  /* ---- rate sheets ---- */
  if (is(/^(rate ?sheets?|pricing sheets?)$/)) {
    if (!admin) return adminOnly('Rate Sheets');
    const recent = (await env.DB.prepare(
      `SELECT sheet_id, recipient, ok, sent_at FROM send_log
        WHERE kind = 'rate_sheet' ORDER BY id DESC LIMIT 5`).all()).results || [];
    const waiting = Number(((await env.DB.prepare(
      `SELECT COUNT(*) AS n ${UNDECIDED}
         AND NOT EXISTS (SELECT 1 FROM lead_status l2 WHERE l2.case_no = s.case_no)`).first()) || {}).n) || 0;
    return topicJson('RATE SHEETS', [
      recent.length ? `${recent.length} sent recently (newest: ${recent[0].sheet_id} to ${recent[0].recipient}${Number(recent[0].ok) ? '' : ' — FAILED'}).`
                    : 'Nothing has been sent yet.',
      waiting ? `${waiting} undecided intake${waiting === 1 ? ' has' : 's have'} had nothing sent at all.` : null,
      'Private and Legal share the retainer sheet; Insurance has its own. Sending is always a person\'s explicit act.',
    ], [say('PREPARE RATE SHEET', 'prepare a rate sheet'), nav('VIEW RATE SHEETS', 'sheets'),
        seed('FIND CLIENT', 'Find ')]);
  }

  /* ---- surveillance ---- */
  if (is(/^surveillance$/)) {
    if (!admin) {
      const mine = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM case_days WHERE investigator_id = ? AND end_time IS NULL`).bind(user.id).first();
      return topicJson('SURVEILLANCE', [Number(mine.n)
        ? 'Your day is running — the field view has the clock.' : 'No day of yours is running.'],
        [nav('ACTIVE SURVEILLANCE', 'surveillance', 'action'), nav('TODAY', 'today')]);
    }
    const active = (await env.DB.prepare(
      `SELECT d.case_no, u.display_name AS who, d.start_time FROM case_days d
         LEFT JOIN users u ON u.id = d.investigator_id
        WHERE d.end_time IS NULL ORDER BY d.id DESC LIMIT 8`).all()).results || [];
    const due = Number(((await env.DB.prepare(
      `SELECT COUNT(DISTINCT d.case_no) AS n FROM case_days d WHERE d.end_time IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM case_reports r WHERE r.day_id = d.id)`).first()) || {}).n) || 0;
    const actions = [nav('OPEN CALENDAR', 'calendar'), nav('ACTIVE SURVEILLANCE', 'surveillance', 'action')];
    if (due) actions.push(say('REPORTS DUE', 'reports due'));
    return topicJson('SURVEILLANCE', [
      active.length ? `${active.length} day${active.length === 1 ? ' is' : 's are'} running right now.` : 'Nobody is out right now.',
      due ? `${due} case${due === 1 ? ' has' : 's have'} a finished day awaiting its report.` : null,
    ], actions, active.map(a => ({ title: `${a.who || 'Unassigned'} — ${a.case_no}`, case_no: a.case_no,
      line: `out since ${a.start_time || '—'}` })));
  }

  /* ---- reports ---- */
  if (is(/^reports?$/)) {
    const mineClause = admin ? '' : 'WHERE investigator_id = ?';
    const st = (await env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM case_reports ${mineClause} GROUP BY status`)
      .bind(...(admin ? [] : [user.id])).all()).results || [];
    const line = st.length ? st.map(r => `${r.n} ${r.status}`).join(' · ') : 'none yet';
    if (!admin) {
      return topicJson('REPORTS', [`Your reports: ${line}.`], [nav('OPEN REPORTS', 'myreports')]);
    }
    const due = Number(((await env.DB.prepare(
      `SELECT COUNT(DISTINCT d.case_no) AS n FROM case_days d WHERE d.end_time IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM case_reports r WHERE r.day_id = d.id)`).first()) || {}).n) || 0;
    const actions = [nav('OPEN REPORTS & PACKAGES', 'delivery')];
    if (due) actions.push(say('REPORTS DUE', 'reports due'));
    return topicJson('REPORTS', [`Across the book: ${line}.`,
      due ? `${due} case${due === 1 ? ' has' : 's have'} a finished day with no report.` : null], actions);
  }

  /* ---- clients ---- */
  if (is(/^(clients?|firms?|clients and firms|client directory)$/)) {
    if (!admin) return adminOnly('The client directory');
    if ((await missingTables(env)).includes('profile')) {
      return topicJson('CLIENTS & FIRMS', ['The saved directory is not set up on this database yet (portal-setup).'],
        [nav('OPEN CLIENTS & FIRMS', 'profiles')]);
    }
    const rows = (await env.DB.prepare(
      `SELECT kind, COUNT(*) AS n FROM profile WHERE active = 1 GROUP BY kind`).all()).results || [];
    const k = Object.fromEntries(rows.map(r => [r.kind, Number(r.n)]));
    return topicJson('CLIENTS & FIRMS', [
      `${k.law_firm || 0} law firm${(k.law_firm || 0) === 1 ? '' : 's'} · ${k.insurance_org || 0} insurance org${(k.insurance_org || 0) === 1 ? '' : 's'} · ${k.private_client || 0} private client${(k.private_client || 0) === 1 ? '' : 's'} saved.`,
      'A profile is a default; every case stays a snapshot.',
    ], [nav('OPEN CLIENTS & FIRMS', 'profiles'), seed('FIND CLIENT', 'Find ')]);
  }

  /* ---- tasks ---- */
  if (is(/^tasks?$/)) {
    const t = await (await taskBoard(env, user)).json();
    const c = b => (t[b] || []).length;
    const lines = [`${c('overdue')} overdue · ${c('today')} due today · ${c('upcoming')} upcoming.`];
    return topicJson('TASKS', lines, [nav('OPEN TASKS', 'tasks')]);
  }

  /* ---- today ---- */
  if (is(/^(today|day|my day)$/)) {
    if (!admin) {
      const mine = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM case_days WHERE investigator_id = ? AND end_time IS NULL`).bind(user.id).first();
      const t = await (await taskBoard(env, user)).json();
      return topicJson('TODAY', [
        Number(mine.n) ? 'Your day is running.' : 'No day of yours is running.',
        `${(t.today || []).length} task${(t.today || []).length === 1 ? '' : 's'} due today, ${(t.overdue || []).length} overdue.`,
      ], [nav('OPEN TODAY', 'today'), nav('ACTIVE SURVEILLANCE', 'surveillance', 'action')]);
    }
    const f = await assistantIntakeFacts(env);
    const activeNow = Number(((await env.DB.prepare(
      `SELECT COUNT(DISTINCT case_no) AS n FROM case_days WHERE end_time IS NULL`).first()) || {}).n) || 0;
    const t = await (await taskBoard(env, user)).json();
    const data = await (await listInvoices(new Request('http://assistant.internal/invoices'), env)).json();
    const over = (data.invoices || []).filter(i => i.status !== 'void' && i.display_status === 'overdue').length;
    const actions = [];
    if (f.fresh) actions.push(nav('REVIEW NEW INTAKES', 'leads'));
    actions.push(nav('OPEN DASHBOARD', 'dashboard'));
    if (over) actions.push(say('SHOW OVERDUE', 'overdue'));
    return topicJson('TODAY', [
      `${f.fresh} new intake${f.fresh === 1 ? '' : 's'} · ${activeNow} day${activeNow === 1 ? '' : 's'} running · ${(t.today || []).length} task${(t.today || []).length === 1 ? '' : 's'} due today · ${over} overdue invoice${over === 1 ? '' : 's'}.`,
    ], actions);
  }

  return null;
}

/* POST /assistant/command — the deterministic Beta grammar. Every branch
   composes from live reads or the registry; the fallback says plainly what
   Beta understands rather than pretending.

   §11 — EXPLAIN & GUIDE ME lives HERE, in the wrapper, because the first
   build's toggle was INERT: the page sent `context.guide` on every command
   and no branch read it — a control that renders is not a control that
   works, the profile-contact-select defect again. Guide ON leads a STATUS
   answer with the plain-language paragraph for the screen the person is on
   (the case workspace's when a case is in context); everything else —
   refusals, navigation, explanations that already are the paragraph — is
   untouched, and OFF is exactly the compact answer it always was. */
async function assistantCommand(request, env, user) {
  const body = await readJson(request);
  const res = await assistantCommandCore(body, env, user);
  const ctx = body.context && typeof body.context === 'object' ? body.context : {};
  if (ctx.guide !== true) return res;
  let d; try { d = await res.json(); } catch { return res; }
  if (!d || d.kind !== 'status') return json(d, res.status);
  const route = String(ctx.route || '').slice(0, 40);
  const caseNo = CASE_NO_RE.test(String(ctx.case_no || '')) ? String(ctx.case_no) : '';
  const key = caseNo ? 'case' : (ASSISTANT_EXPLAIN[route] ? route : null);
  if (key) d.guide_intro = ASSISTANT_EXPLAIN[key];
  return json(d, res.status);
}

async function assistantCommandCore(body, env, user) {
  const text = String(body.text || '').slice(0, 500);
  const ctx = body.context && typeof body.context === 'object' ? body.context : {};
  const route = String(ctx.route || '').slice(0, 40);
  const caseNo = CASE_NO_RE.test(String(ctx.case_no || '')) ? String(ctx.case_no) : '';
  const t = ' ' + asstStrip(text) + ' ';

  /* ---- UNIT 4: the one send-shaped act Beta can REHEARSE. An utterance
     about sending or preparing an INTAKE opens the workbench instead of the
     flat refusal — the doing is two explicit routes, the send still never
     happens, and destructive verbs about an intake still refuse below. */
  if (/\bintake\b/i.test(text)
      && /\b(prepare|send|email|simulate|draft|rehears|dry.?run)\b/i.test(text)
      && !/\bdelete\b|\barchiv/i.test(text)) {
    if (user.role !== 'admin') {
      return json({ ok: true, kind: 'status',
        text: 'Sending intake links is an admin desk — this action requires Admin permission.' });
    }
    const mail = (text.match(/[^@\s]+@[^@\s.]+\.[^@\s]+/) || [null])[0];
    const kindGuess = /insuran|carrier|claim/i.test(text) ? 'insurance'
      : /legal|law firm|attorney|\bfirm\b/i.test(text) ? 'legal'
      : /private|consumer/i.test(text) ? 'private' : '';
    return json({ ok: true, kind: 'prepare_intake',
      text: 'Dry run: say who this intake link is for and preview exactly what would go. '
          + `Nothing is sent — the SIMULATE step records the rehearsal as ${ASSISTANT_SIM_OUTCOME}.`,
      form: { kind: kindGuess, to: mail || '', name: '', case_no: caseNo || '' } });
  }

  /* ---- UNIT 5: the same carve-out for RATE SHEETS — pick the audience,
     preview the priced document, SIMULATE. Ordered after the intake one, so
     a sentence naming both is taken as the intake. */
  if (/rate sheet|ratesheet|pricing sheet|rate card/i.test(text)
      && /\b(prepare|send|email|simulate|draft|rehears|dry.?run)\b/i.test(text)
      && !/\bdelete\b|\barchiv/i.test(text)) {
    if (user.role !== 'admin') {
      return json({ ok: true, kind: 'status',
        text: 'Sending rate sheets is an admin desk — this action requires Admin permission.' });
    }
    const mail = (text.match(/[^@\s]+@[^@\s.]+\.[^@\s]+/) || [null])[0];
    const ctxGuess = /insuran|carrier|claim/i.test(text) ? 'insurance'
      : /legal|law firm|attorney|\bfirm\b/i.test(text) ? 'legal'
      : /private|consumer/i.test(text) ? 'private' : '';
    return json({ ok: true, kind: 'prepare_sheet',
      text: 'Dry run: pick the audience, preview the exact sheet email, then SIMULATE — '
          + `recorded as ${ASSISTANT_SIM_OUTCOME}, and nothing is sent.`,
      form: { context: ctxGuess, to: mail || '', case_no: caseNo || '' } });
  }

  /* ---- Beta enforcement FIRST: a consequential verb is refused before any
     intent could act on it, whatever else the sentence says. Pure questions
     ("why can't I delete this?") are let through to the explainers below. */
  const asking = /\bwhy\b|\bexplain\b|\bwhat\b|\bcan (i|we)\b|\bis this\b/i.test(text);
  if (!asking) {
    for (const [re, what] of ASSISTANT_BLOCKED) {
      if (re.test(text)) {
        return json({ ok: true, kind: 'refused', code: 'assistant_beta',
          text: `Beta dry-run: ${what} is disabled for the Assistant — nothing was done, `
              + `and no message left the building. The ordinary portal controls still work; `
              + `I can rehearse intake links ("prepare an intake") and rate sheets ("prepare `
              + `a rate sheet"), and invoice preparation arrives in a later Assistant unit.` });
      }
    }
  }

  /* ---- UNIT 4: the Beta audit trail, readable where it is written (§26) —
     what has been simulated, each row wearing its outcome. */
  if (/simulation (log|history)|\b(show|list|recent|what have)\b[^]*simulat/i.test(text)) {
    if (user.role !== 'admin') {
      return json({ ok: true, kind: 'status', text: 'The simulation log is an admin desk.' });
    }
    if ((await missingTables(env)).includes('assistant_log')) {
      return json({ ok: true, kind: 'status',
        text: 'The Assistant log table has not been set up yet — run the portal-setup workflow to add it. Until then rehearsals are not recorded.' });
    }
    const rows = await env.DB.prepare(
      `SELECT a.action, a.outcome, a.case_no, a.recipient, a.done_at, u.display_name AS who
         FROM assistant_log a LEFT JOIN users u ON u.id = a.done_by
        ORDER BY a.id DESC LIMIT 8`).all();
    const list = rows.results || [];
    if (!list.length) {
      return json({ ok: true, kind: 'status', text: 'No simulations have been recorded yet.' });
    }
    return json({ ok: true, kind: 'status',
      text: `${list.length} recorded simulation${list.length === 1 ? '' : 's'}, newest first — every one ${ASSISTANT_SIM_OUTCOME}.`,
      card: list.map(r => ({ title: `${r.action} → ${r.recipient}`, case_no: r.case_no || null,
        line: [r.outcome, r.case_no || 'no case', String(r.done_at || '').slice(0, 16).replace('T', ' '),
               r.who || ''].filter(Boolean).join(' · ') })) });
  }

  /* ---- where am I / explain this page ---- */
  if (/where am i|what is this (page|for)|what does this page do|what can i do here|explain this page|^ *explain page *$/i.test(text)) {
    const key = caseNo ? 'case' : (ASSISTANT_EXPLAIN[route] ? route : null);
    const nav = ASSISTANT_NAV.find(n => n.id === route);
    const name = caseNo ? `the case workspace for ${caseNo}` : nav ? nav.label : 'this screen';
    return json({ ok: true, kind: 'explain',
      text: key ? `You are in ${name}. ${ASSISTANT_EXPLAIN[key]}`
                : `You are in ${name}. I do not have a write-up for this screen yet — that is a gap in my notes, not a hidden feature.` });
  }

  /* ---- navigation: "take me to…", "open billing", "go to intakes" ---- */
  const navPhrase = text.match(/(?:take me (?:to|back to)|go (?:to|back to)|open|show me|navigate to)\s+(.{2,60})/i);
  if (navPhrase) {
    const dest = assistantNavMatch(navPhrase[1], user.role);
    if (dest) {
      return json({ ok: true, kind: 'navigate', navigate: { kind: dest.kind, id: dest.id },
        text: `Opening ${dest.label}.` });
    }
    /* Not a destination — fall through to search, "open Vanessa's case". */
  }

  /* ---- UNIT 6 completed: the ZERO-WRITE invoice preview. "Prepare the
     invoice" here means SHOW it — the owner's Beta invoice rule: no row, no
     draft, no number reservation, no billing write of any kind. Placed
     before the billing-status read because its phrases are the more
     specific. Admin-only, like every Billing door. */
  if (/prepare (the |an |this )?invoice|can we invoice|what would (this|the) invoice look like|invoice preview|preview (the |an )?invoice/i.test(text)) {
    if (user.role !== 'admin') {
      return json({ ok: true, kind: 'status', text: 'Billing is an admin desk.' });
    }
    if (!caseNo) {
      return json({ ok: true, kind: 'status',
        text: 'Open the case first — an invoice preview is built from a case\'s own record. '
            + 'Find it with "Find <name or case number>".' });
    }
    const pv = await assistantInvoicePreview(env, caseNo);
    if (pv.fail) return pv.fail;
    return json({ ok: true, kind: 'invoice_preview', outcome: ASSISTANT_PREVIEW_OUTCOME,
      preview: pv.preview, text: pv.text });
  }

  /* ---- UNIT 6 (the read half): billing answered from the SAME money reads
     the Billing screen uses — listInvoices' own composition, drafts excluded
     from outstanding exactly as everywhere. Placed AFTER navigation so
     "take me to billing" still navigates. The preparation/simulation half is
     deliberately deferred: the portal has no invoice-send route to rehearse,
     and creating a draft invoice is a real write this block structurally
     cannot make — the owner's call, named in ASSISTANT.md. */
  if (/what.{0,30}(outstanding|owed|balance)|\b(billing|invoice) status\b|\b(outstanding|unpaid) invoices?\b|what (do|does) .{0,40}owe/i.test(text)) {
    if (user.role !== 'admin') {
      return json({ ok: true, kind: 'status', text: 'Billing is an admin desk.' });
    }
    const ires = await listInvoices(new Request('http://assistant.internal/invoices'), env);
    const data = await ires.json();
    const fmt = n => '$' + (Math.round(Number(n || 0) * 100) / 100)
      .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (caseNo) {
      const mine = (data.invoices || []).filter(i => i.case_no === caseNo && i.status !== 'void');
      if (!mine.length) {
        return json({ ok: true, kind: 'status', text: `${caseNo} has no live invoices.`,
          actions: [{ label: 'Open Billing', navigate: { kind: 'tab', id: 'invoices' } }] });
      }
      const due = mine.filter(i => i.status !== 'draft')
        .reduce((t, i) => t + Math.max(0, Number(i.balance_due) || 0), 0);
      return json({ ok: true, kind: 'status',
        text: `${caseNo} carries ${mine.length} live invoice${mine.length === 1 ? '' : 's'} — ${fmt(due)} outstanding. Drafts never count toward what is owed.`,
        card: mine.slice(0, 6).map(i => ({ title: `${i.invoice_no} — ${i.display_status}`, case_no: caseNo,
          line: `Total ${fmt(i.total)} · paid ${fmt(i.amount_paid)} · balance ${fmt(i.balance_due)}` })),
        actions: [{ label: 'Open Billing', navigate: { kind: 'tab', id: 'invoices' } }] });
    }
    const s = data.summary || {};
    return json({ ok: true, kind: 'status',
      text: `Outstanding across live invoices: ${fmt(s.outstanding)} — ${s.overdue || 0} overdue, ${s.due_soon || 0} due within 14 days.`,
      actions: [{ label: 'Open Billing', navigate: { kind: 'tab', id: 'invoices' } }] });
  }

  /* ---- UNIT 7: case health and operational assistance — recorded facts
     only, through the functions the portal already trusts. Each needs a
     case; the shared gate reads it once with the caller's own access. */
  const u7Case = async () => {
    if (!caseNo) return { fail: json({ ok: true, kind: 'status',
      text: 'Open the case first — this is answered from a case\'s own record. '
          + 'Find it with "Find <name or case number>".' }) };
    const row = await caseFor(env, user, caseNo);
    if (!row) return { fail: json({ ok: true, kind: 'status',
      text: `I cannot read ${caseNo} with your access.` }) };
    return { row };
  };

  if (/ready to invoice/i.test(text)) {
    if (user.role !== 'admin') return json({ ok: true, kind: 'status', text: 'Billing is an admin desk.' });
    const g = await u7Case(); if (g.fail) return g.fail;
    const facts = await closeoutFacts(env, caseNo);
    const hold = ['field_work', 'activity_logs', 'report', 'expenses']
      .filter(k => facts[k]).map(k => facts[k].note);
    const live = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM invoices WHERE case_no = ? AND status != 'void'").bind(caseNo).first();
    const n = Number(live && live.n) || 0;
    return json({ ok: true, kind: 'status',
      text: (hold.length
        ? `Not yet, by the record: ${hold.join('; ')}.`
        : 'The record shows nothing in the way of invoicing.')
        + (n ? ` ${n} live invoice${n === 1 ? ' already bills' : 's already bill'} this case.` : '')
        + ' Say "invoice preview" to see exactly what would be prepared — nothing is created.' });
  }

  /* Case-scoped when a case is open; the BARE phrase with no case falls
     through to the Unit 10 topic, which lists close-worthy cases book-wide. */
  if (caseNo && /ready to close|can (we|i) close/i.test(text)) {
    if (user.role !== 'admin') return json({ ok: true, kind: 'status', text: 'Closing is an admin desk.' });
    const g = await u7Case(); if (g.fail) return g.fail;
    const notes = Object.values(await closeoutFacts(env, caseNo)).map(f => f.note);
    return json({ ok: true, kind: 'status',
      text: notes.length
        ? `The record shows ${notes.length} thing${notes.length === 1 ? '' : 's'} to look at first: `
          + `${notes.join('; ')}. The eight closeout attestations stay yours — nothing here closes anything.`
        : 'The record shows nothing standing in the way. Closing is still the eight human attestations '
          + 'on Billing & closing — the Assistant cannot and does not close cases.' });
  }

  if (/package (readiness|ready|status)|ready to (deliver|ship)/i.test(text)) {
    if (user.role !== 'admin') return json({ ok: true, kind: 'status', text: 'Packages are an admin desk.' });
    const g = await u7Case(); if (g.fail) return g.fail;
    const build = await env.DB.prepare(
      'SELECT id, status, finalized_at FROM case_builds WHERE case_no = ? ORDER BY id DESC LIMIT 1')
      .bind(caseNo).first();
    const ship = await shippableReports(env, caseNo);
    const dev = await env.DB.prepare(
      `SELECT SUM(CASE WHEN classification = 'client_deliverable' THEN 1 ELSE 0 END) AS ok,
              COUNT(*) AS total FROM case_evidence WHERE case_no = ? AND deleted_at IS NULL`)
      .bind(caseNo).first();
    const okN = Number(dev && dev.ok) || 0, totN = Number(dev && dev.total) || 0;
    const held = totN - okN;
    return json({ ok: true, kind: 'status',
      text: `${build
        ? `Package #${build.id} is ${build.status}${build.finalized_at ? ` (finalized ${String(build.finalized_at).slice(0, 10)})` : ''}.`
        : 'No package has been started.'} `
        + `${ship.length} report${ship.length === 1 ? ' is' : 's are'} ready to ride; `
        + `${okN} of ${totN} file${totN === 1 ? '' : 's'} cleared to ship`
        + `${held ? ` (${held} held back by classification)` : ''}. The build screen holds the gates.` });
  }

  if (/can.?t i delete|can i delete|what.?s blocking (the )?delete|delete.?block/i.test(text)) {
    if (user.role !== 'admin') return json({ ok: true, kind: 'status', text: 'Deleting is an admin act.' });
    const g = await u7Case(); if (g.fail) return g.fail;
    const hold = await activeHold(env, caseNo);
    if (hold) {
      return json({ ok: true, kind: 'status',
        text: `${caseNo} is under a legal hold — every removal is refused until the hold is released `
            + '(Billing & closing → Retention, with a reason on the record).' });
    }
    const found = await intakeBlockersFound(env, caseNo);
    if (!found.length) {
      return json({ ok: true, kind: 'status',
        text: 'Nothing blocks the quick intake delete — it would remove only the intake\'s own '
            + 'paperwork, and its confirmation says exactly that.' });
    }
    const what = INTAKE_BLOCKERS.filter(([t]) => found.includes(t)).map(([, w]) => w);
    return json({ ok: true, kind: 'status',
      text: `${caseNo} has become a real case — it carries ${what.slice(0, 6).join(', ')}`
        + `${what.length > 6 ? ` and ${what.length - 6} more kinds of record` : ''}. The quick delete is `
        + 'for fresh intakes only; Archive or Delete case (Billing & closing) take it off the desk, '
        + 'and both can be undone.' });
  }

  if (/summari[sz]e today|today.?s activity|draft (the |a )?daily summary/i.test(text)) {
    const g = await u7Case(); if (g.fail) return g.fail;
    const day = await env.DB.prepare(
      `SELECT id FROM case_days WHERE case_no = ? AND end_time IS NULL ORDER BY id DESC LIMIT 1`)
      .bind(caseNo).first()
      || await env.DB.prepare(
        `SELECT id FROM case_days WHERE case_no = ? ORDER BY id DESC LIMIT 1`).bind(caseNo).first();
    if (!day) {
      return json({ ok: true, kind: 'status',
        text: 'No investigation day has been recorded on this case yet — there is nothing to summarize.' });
    }
    const chron = await assistantChronology(env, caseNo, { dayId: day.id });
    return json({ ok: true, kind: 'chronology',
      text: `Recorded entries, verbatim — nothing composed:\n\n${chron.text}\n\n`
          + 'The Daily Summary Builder (Report tab) writes the paragraph deterministically from these.' });
  }

  if (/draft (a |the )?report/i.test(text)) {
    const g = await u7Case(); if (g.fail) return g.fail;
    const chron = await assistantChronology(env, caseNo, {});
    if (!chron.days) {
      return json({ ok: true, kind: 'status',
        text: 'No investigation day has been recorded on this case yet — a report draft would have nothing true to say.' });
    }
    return json({ ok: true, kind: 'chronology',
      text: `DRAFT FROM RECORDED FACTS ONLY — ${chron.days} day${chron.days === 1 ? '' : 's'}, `
          + `${chron.entries} entr${chron.entries === 1 ? 'y' : 'ies'}, quoted verbatim:\n\n${chron.text}\n\n`
          + 'Nothing here is invented. The Report screen builds the formal document, and the office signs it.' });
  }

  if (/check this case|what.?s holding this up|summari[sz]e (this |the )?case|case summary|case health/i.test(text)) {
    const g = await u7Case(); if (g.fail) return g.fail;
    const h = await assistantCaseHealth(env, caseNo);
    const next = await assistantCaseNextStep(env, caseNo);
    const repLine = h.reps.length ? h.reps.map(r => `${r.n} ${r.status}`).join(', ') : 'none';
    let money = '';
    if (user.role === 'admin') {
      const inv = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM invoices WHERE case_no = ? AND status != 'void'`).bind(caseNo).first();
      money = ` Invoices: ${Number(inv && inv.n) || 0} live — "billing status" has the figures.`;
    }
    return json({ ok: true, kind: 'status',
      text: `${caseNo} — ${g.row.kind === 'claims' ? 'insurance' : 'private'} · status ${g.row.status}. `
        + `Days: ${Number(h.days.n) || 0}${Number(h.days.open) ? ` (${Number(h.days.open)} running)` : ''}`
        + `${h.days.last_date ? `, last ${h.days.last_date}` : ''}. `
        + `Activity entries: ${Number(h.acts.n) || 0}${h.acts.last ? `, last ${h.acts.last}` : ''}. `
        + `Reports: ${repLine}. Files: ${h.evidence}.${money}\n`
        + `RECOMMENDED NEXT STEP — ${next}` });
  }

  /* ---- live status: anything new / new intakes ---- */
  if (/anything new|what'?s new|any (new )?(intake|lead)|has any intake|intake forms? shown up|new legal intake/i.test(text)) {
    if (user.role !== 'admin') {
      return json({ ok: true, kind: 'status',
        text: 'Intake review is an admin desk. Your own open assignments are under Cases.' });
    }
    const c = await assistantCounts(env, user);
    if (!c.fresh.length) {
      return json({ ok: true, kind: 'status',
        text: 'No new intakes are currently waiting for review.',
        actions: [{ label: 'Open Intakes', navigate: { kind: 'tab', id: 'leads' } }] });
    }
    const wantLegal = /legal/i.test(text);
    const rows = c.fresh.filter(r => !wantLegal || r.legal_service || r.kind === 'consumer');
    return json({ ok: true, kind: 'status',
      text: `${c.fresh.length === 1 ? 'Yes — 1 new intake is' : `Yes — ${c.fresh.length} new intakes are`} waiting for review.`,
      card: rows.map(r => ({ title: r.who || r.case_no, case_no: r.case_no,
        line: [r.kind === 'claims' ? 'Insurance' : r.legal_service ? `Legal — ${r.legal_service}` : 'Private / Legal',
               r.created_at ? r.created_at.slice(0, 10) : ''].filter(Boolean).join(' · ') })),
      actions: [{ label: 'Open Intakes', navigate: { kind: 'tab', id: 'leads' } }] });
  }

  /* ---- UNIT 8: the watch list — the whole internal picture on demand ---- */
  if (/\bwatch( list| mode)?\b|anything i should know|what needs (my )?attention|needs attention/i.test(text)) {
    if (user.role !== 'admin') {
      return json({ ok: true, kind: 'status',
        text: 'The office-wide watch is an admin desk. Cases and Today carry your own work.' });
    }
    const rows = await assistantWatch(env, user);
    if (!rows.length) {
      return json({ ok: true, kind: 'status',
        text: 'Watch: nothing is waiting — no fresh intakes, nothing overdue, no refused uploads, '
            + 'no finalized package sitting undelivered. Internal only; Watch never emails, texts '
            + 'or touches anything.',
        actions: [{ label: 'Open Dashboard', navigate: { kind: 'tab', id: 'dashboard' } }] });
    }
    return json({ ok: true, kind: 'status',
      text: `Watch: ${rows.length} item${rows.length === 1 ? '' : 's'} worth a look, grouped and `
          + 'newest first. Internal only — Watch never emails, texts or touches anything.',
      card: rows, actions: [{ label: 'Open Dashboard', navigate: { kind: 'tab', id: 'dashboard' } }] });
  }

  /* ---- what should I do (the one-recommendation briefing) ---- */
  if (/what should i do|morning briefing/i.test(text)) {
    if (caseNo) {
      /* On a case: the same derivation the case page draws as NEXT STEP —
         answered from the case's own record, one recommendation, not fifteen.
         Extracted (Unit 7) so the health summary and this branch cannot say
         two different next steps about one case. */
      const row = await caseFor(env, user, caseNo);
      if (!row) return json({ ok: true, kind: 'status', text: `I cannot read ${caseNo} with your access.` });
      return json({ ok: true, kind: 'status',
        text: `RECOMMENDED NEXT STEP — ${await assistantCaseNextStep(env, caseNo)}` });
    }
    if (user.role !== 'admin') {
      const c = await assistantCounts(env, user);
      return json({ ok: true, kind: 'status',
        text: `You have ${c.open} open assignment${c.open === 1 ? '' : 's'}. Cases and Today show what each needs.`,
        actions: [{ label: 'Open Cases', navigate: { kind: 'tab', id: 'cases' } }] });
    }
    const c = await assistantCounts(env, user);
    const first = c.fresh[0];
    return json({ ok: true, kind: 'status',
      text: first
        ? `RECOMMENDED NEXT STEP — review the newest intake: ${first.who || first.case_no} (${first.case_no}). ${c.fresh.length - 1 > 0 ? `${c.fresh.length - 1} more are waiting behind it. ` : ''}The dashboard's alert cards carry the rest.`
        : `Nothing is waiting in intake review. The dashboard's alert cards are the live answer for the rest — reports due, authorization, money outstanding.`,
      actions: [{ label: first ? 'Open Intakes' : 'Open Dashboard',
                  navigate: { kind: 'tab', id: first ? 'leads' : 'dashboard' } }] });
  }

  /* ---- find a record: "find …", "open Vanessa's case" ---- */
  const findPhrase = text.match(/(?:find|look up|search for|open)\s+(.{2,80})/i);
  if (findPhrase) {
    const q = findPhrase[1].replace(/'s case\b|case\b/ig, ' ').trim().slice(0, 80);
    if (q) {
      /* The EXISTING search, called as itself — same role boundary, same
         caps, nothing re-implemented. A synthetic Request carries the query
         because globalSearch reads its URL; nothing external is fetched. */
      const sres = await globalSearch(
        new Request('http://assistant.internal/search?q=' + encodeURIComponent(q)), env, user);
      const data = await sres.json();
      const hits = [];
      for (const row of data.results || []) {
        if (row.case_no && !hits.some(x => x.case_no === row.case_no)) {
          hits.push({ case_no: row.case_no, title: row.subtitle || row.case_no,
                      line: [row.case_no, (row.matched || []).join(', ')].filter(Boolean).join(' · ') });
        }
        if (hits.length >= 6) break;
      }
      if (hits.length === 1) {
        return json({ ok: true, kind: 'navigate',
          navigate: { kind: 'case', case_no: hits[0].case_no },
          text: `Opening ${hits[0].title} — ${hits[0].case_no}.` });
      }
      if (hits.length > 1) {
        return json({ ok: true, kind: 'choices',
          text: `I found ${hits.length} matches. Which one?`, card: hits });
      }
      return json({ ok: true, kind: 'status',
        text: `Nothing in the portal matched "${q}". Search covers case, claim and matter numbers, names, firms, subjects and vehicles — the full Search screen has the detail.`,
        actions: [{ label: 'Open Search', navigate: { kind: 'tab', id: 'search' } }] });
    }
  }

  /* ---- UNIT 10: topic commands — a bare word or short phrase answers with
     live status and the actions that fit the state. Runs LAST so every
     richer phrasing above keeps its own handler; only inputs of up to four
     stripped words reach the topic table. */
  {
    const shortT = asstStrip(text);
    if (shortT && shortT.split(' ').length <= 4) {
      const topicAns = await assistantTopicAnswer(env, user, shortT, caseNo);
      if (topicAns) return topicAns;
    }
  }

  /* ---- the honest fallback ---- */
  const provider = assistantProvider(env);
  return json({ ok: true, kind: 'help',
    text: 'Beta understands set phrases so far: "Where am I?", "Explain this page", '
        + '"Take me to <a portal section>", "Anything new?", "What should I do?", '
        + '"What needs attention?", "What is outstanding?", "Find <a name or case number>", '
        + '"Prepare an intake", "Prepare a rate sheet", "invoice preview", bare topics like '
        + '"intakes", "invoices", "cases", "rate sheets", "surveillance", "reports", "clients", '
        + '"tasks", "today", and on a case: '
        + '"Check this case", "Is this ready to close?", "Is this ready to invoice?", '
        + '"Summarize today\'s activity", "Draft a report", "Package readiness", '
        + '"Why can\'t I delete this?". '
        + (provider.ready ? 'Freer phrasing arrives in a later unit.'
           : 'The AI provider is not connected, so freer phrasing is not available yet — '
           + 'nothing here guesses.') });
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
    /* Anonymous callers get the COUNT (closeout audit, 2026-09-03): the list
       of missing table NAMES was a partial map of the schema handed to anyone
       who asked. The names still go to a signed-in admin — the page's "not
       fully set up" banner reads them — and verify.sh reads the count. */
    let who = null;
    try { who = await currentUser(request, env); } catch { who = null; }
    let storagePct = null;
    if (env.DB && !missing.includes('case_evidence')) {
      /* One aggregate a minute per isolate: the daily probe and the page both
         read this figure, and an anonymous flood must not re-run the sum. */
      const now = Date.now();
      let hit = env.DB ? HEALTH_CACHE.get(env.DB) : null;
      if (!hit || now - hit.at > 60_000) {
        let pct = null;
        try { pct = (await evidenceUsage(env)).percent_of_free; } catch { pct = null; }
        hit = { at: now, pct };
        if (env.DB) HEALTH_CACHE.set(env.DB, hit);
      }
      storagePct = hit.pct;
    }
    return json({
      ok: true,
      configured: Boolean(env.DB && env.INGEST_KEY),
      email: Boolean(env.RESEND_API_KEY),
      // How many expected tables are absent — a half-applied schema announces
      // itself here, to the live check and to the portal alike.
      schema_missing: missing.length,
      // Which ones, for the office only.
      ...(who && who.role === 'admin' ? { missing_tables: missing } : {}),
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

  /* THE ONE ROUTE THAT AUTHENTICATES ITSELF, and it sits here because it
     cannot pass the gate below — see dbxSignState for why a Strict session
     cookie is never sent on Dropbox's return trip. The state cookie IS the
     credential: minted only by /dropbox/connect, only for an admin, signed,
     and good for ten minutes.

     The admin it names is re-read from `users` on the way through, so an
     account demoted or deactivated between pressing Connect and coming back
     does not finish the connection. Being above the gate buys this route
     nothing else: it is a GET, it changes nothing until the state verifies,
     and every failure leaves by the same door. */
  if (p === '/dropbox/callback' && method === 'GET') {
    /* Cleared on EVERY exit from here, success or failure, so a state is
       single-use whatever happened to it. */
    const clear = { 'Set-Cookie': dbxStateCookie('x', 0) };
    const back = (status) => redirectTo(`${env.SITE_ORIGIN}/portal/?dropbox=${status}`, clear);

    const url = new URL(request.url);
    const err = url.searchParams.get('error');
    // The operator pressing Cancel on Dropbox's own screen is not a failure.
    if (err) return back(err === 'access_denied' ? 'cancelled' : 'error');

    /* Before the state check, not after: without the app secret there is no
       key to verify a signature with, and reporting that as a bad state would
       send someone hunting a cookie problem that is really an unset secret. */
    if (!EXTERNAL_PROVIDERS.dropbox.configured(env)
        || (await missingTables(env)).includes('dropbox_auth')) return back('error');

    const code = url.searchParams.get('code');
    if (!code) return back('state');
    const uid = await dbxVerifyState(env, request, url.searchParams.get('state'));
    if (!uid) return back('state');
    const starter = await env.DB.prepare(
      'SELECT id, role, active FROM users WHERE id = ?').bind(uid).first();
    if (!starter || !starter.active || starter.role !== 'admin') return back('unauthorised');

    let tok;
    try {
      const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: { Authorization: dropboxBasic(env),
                   'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code,
          // Dropbox requires this to match the authorize call exactly.
          redirect_uri: dropboxRedirectUri(env),
        }),
      });
      if (!res.ok) return back('exchange');
      tok = await res.json();
    } catch { return back('exchange'); }
    if (!tok || !tok.refresh_token) return back('exchange');

    /* THE CONNECTION IS PROVEN BEFORE IT IS CLAIMED. The account read is what
       makes "connected" a fact rather than an assumption, and it is also where
       the email in the status panel comes from — a connection nobody can
       identify is a connection nobody can audit. A token that will not answer
       is not stored at all. */
    let acct = null;
    try {
      const who = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST', headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      if (who.ok) acct = await who.json();
    } catch { acct = null; }
    if (!acct) return back('unverified');

    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO dropbox_auth (id, refresh_token, account_id, account_email, account_name,
         scopes, connected_by, connected_at, last_checked_at)
       VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT(id) DO UPDATE SET refresh_token = ?1, account_id = ?2, account_email = ?3,
         account_name = ?4, scopes = ?5, connected_by = ?6, connected_at = ?7, last_checked_at = ?7`)
      .bind(tok.refresh_token, acct.account_id || null, (acct.email || null),
            (acct.name && acct.name.display_name) || null, tok.scope || DBX_SCOPES,
            starter.id, now).run();
    return back('connected');
  }

  // Everything below needs a signed-in caller.
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in.' }, 401);

  if (p === '/auth/me') return json({ user });

  /* A DELETED CASE DOES NOT PARTICIPATE IN WORK (Codex stop-time review,
     2026-08-16 — "deleted cases remain operational and visible in ordinary
     workflow paths").

     Hiding a deleted case from the lists was only half of "removes it from
     normal views". Reproduced against the first version: a deleted case could
     still start a day, log activity, raise an invoice and — worst of it —
     EMAIL THE CLIENT A RATE SHEET, which really sent. It also came back into
     Active surveillance, the dashboard alerts and the calendar the moment a day
     was running on it.

     So the tombstone is a gate as well as a filter. Reads stay open on purpose:
     an admin has to be able to look at a deleted case to decide whether to put
     it back, and the workspace is where the Put-the-case-back button lives.
     WRITES are refused, at one chokepoint rather than in thirty routes, because
     a per-route check is a list somebody will add to and forget.

     `/undelete` is the one write that must still work — it is the way out. */
  if (method !== 'GET') {
    const cm = p.match(/^\/(?:cases|submissions|leads)\/([A-Za-z0-9-]{3,64})(?:\/|$)/);
    /* Invoices and package builds are addressed by their own ID, so the case
       number is never in the path. Resolved here rather than left to each of
       their routes to remember. */
    const im = p.match(/^\/invoices\/(\d{1,12})(?:\/|$)/);
    const bm = p.match(/^\/build\/(\d{1,12})(?:\/|$)/);
    /* OFFERS ARE ADDRESSED BY ID TOO, and they were the way in that the first
       version of this gate missed: an investigator could accept an offer on a
       deleted case, which assigns them to it and moves its stage. */
    const om = p.match(/^\/(?:my\/)?offers\/(\d{1,12})(?:\/|$)/);
    let subject = cm ? cm[1] : null;
    if (!subject && (im || bm || om)) {
      const [table, id] = im ? ['invoices', im[1]]
        : bm ? ['case_builds', bm[1]] : ['case_offers', om[1]];
      const row = await env.DB.prepare(`SELECT case_no FROM ${table} WHERE id = ?`)
        .bind(id).first();
      subject = row && row.case_no ? row.case_no : null;
    }
    /* The writes that must still work, matched on the WHOLE path rather than a
       suffix — `/cases/:no/activity/:id/delete` also ends in "delete", and
       letting that through would leave a deleted case's timeline editable.

       Delete and undelete always pass: they are the way out of deleted, and
       deleting twice stays a no-op so a double tap on a flaky connection is not
       an error the office has to interpret. Archive and restore pass only when
       the case is NOT deleted — a deleted case is not archivable. */
    const isDeleteRoute  = /^\/cases\/[A-Za-z0-9-]{3,64}\/(?:un)?delete$/.test(p);
    /* The retention family (Unit 17) is lifecycle bookkeeping of the same
       class as archive/restore themselves: a hold must be placeable on a
       FINISHED case without un-finishing it (decision 5 — the hold outranks),
       and scheduling deletion on an archived case is the ordinary sequence.
       The DELETED gate is untouched — a deleted case still refuses retention
       writes, and restore-first is the intended answer there. */
    const isArchiveRoute = /^\/cases\/[A-Za-z0-9-]{3,64}\/(?:archive|restore|retention|retention\/(?:schedule|unschedule)|hold|hold\/release)$/.test(p);
    if (subject) {
      const gone = await deletedOf(env, subject);
      if (gone && !isDeleteRoute) {
        return json({ error: DELETED_CASE(subject), case_deleted: true }, 409);
      }
      if (!gone && !isDeleteRoute && !isArchiveRoute) {
        const filed = await archiveOf(env, subject);
        if (filed) return json({ error: ARCHIVED_CASE(subject), case_archived: true }, 409);
      }
    }
  }

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

  /* INTERNAL / NO UI EXPECTED (classified in Unit 31, and deliberately kept).

     The Production Truth Audit listed this among the routes with no page
     caller. It is not dead: it is the internal rate card — `RATES`, the
     package ladder and an optional quote — and its ABSENCE from the UI is the
     feature. Carrier pricing is quoted per assignment and a negotiated rate is
     never advertised, so exposing it merely because a route exists would be
     the opposite of what PRICING.md asks for.

     It is also a tested BOUNDARY rather than a curiosity: the worker suite
     asserts 403 to an investigator and 401 unauthenticated, and the portal
     suite asserts the page itself gets 403. Do not add a screen for it.

     Internal rates. Admin-only and deliberately not reachable from the intake
     form or any public page. `hours` and `rate` are optional and produce a
     quote against the configured standard. */
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
    /* ?case= makes the PREVIEW the same document as the send. Without it the
       admin reads $1,500 on screen, presses send, and the client receives the
       $3,000 that was actually agreed — or worse, believes the screen. Same
       pinning as the case number itself: untrusted, so it is matched to the
       pattern before it reaches a query. */
    const wantCase = url.searchParams.get('case') || '';
    const caseNo = /^[A-Za-z0-9-]{3,64}$/.test(wantCase) ? wantCase : '';
    /* The RESOLVED figure travels beside the sheets, because the selector has
       to open on what this case already agreed. Parsing it back out of the
       sheet's name ("$3,000 Retainer") would work until someone reworded the
       name, and would then quietly preselect the wrong preset — the selector
       must read a number, not a sentence. */
    /* `?retainer=` is the figure the admin has chosen on a send where there is
       no case to store it against. Honoured only where nothing is stored, by
       the same helper the send uses — the preview and the email must resolve
       identically or the screen lies about what will go out. */
    const retainer = await retainerForSend(env, caseNo, url.searchParams.get('retainer'));
    /* LEGAL-SERVICES.md — the case's own service marker, so a wizard opened
       from a legal lead preselects the service the email will actually be
       generated from. Null when the reference resolves to nothing or the case
       carries no marker; the preview then honestly shows the retainer sheet. */
    const caseSubRow = caseNo ? await env.DB.prepare(
      'SELECT kind, payload FROM submissions WHERE case_no = ?').bind(caseNo).first() : null;
    const caseSvc = legalServiceForSub(caseSubRow);
    /* The FEE the case would be quoted at (D12): its own agreed figure, else
       the configured default — what the wizard's Standard/Custom control
       opens on, so the screen and the email resolve identically. */
    let caseFlatFee = null;
    if (caseSvc && caseSvc.model === 'fixed') {
      const stored = await env.DB.prepare(
        'SELECT retainer_amount FROM case_retainer WHERE case_no = ?').bind(caseNo).first();
      caseFlatFee = stored && stored.retainer_amount != null
        ? Number(stored.retainer_amount)
        : await legalFlatDefault(env, caseSvc.id);
    }
    const feeDefaults = {
      locate: await legalFlatDefault(env, 'locate'),
      process: await legalFlatDefault(env, 'process'),
    };
    /* BILLCOM.md — the cards gain the Bill.com line and the wizard learns it
       may offer the tick ONLY from the adapter's answer. Not-ready costs
       nothing and shows nothing new. The PRIVATE card never gains the line —
       the map is legal/insurance contexts only. */
    const billcom = await billcomState(env);
    return json({ sheets: sheetCards(retainer).map(c =>
                    c.context === SEND_CONTEXT.PRIVATE ? c : withBillcomLine(c, billcom.ready)),
                  retainer,
                  /* LEGAL-SERVICES.md — the catalogue the legal send wizard
                     offers. price_label is COMPOSED HERE so no figure ever
                     lives in the page source (the no-dollar guard), and
                     sheet_name is what the preview step names for a fixed
                     service, so the screen and the email cannot disagree. */
                  legal_services: Object.values(LEGAL_SERVICES).map(s => ({
                    id: s.id, label: s.label, model: s.model,
                    model_label: LEGAL_MODEL_LABEL[s.model],
                    price_label: s.model === 'fixed'
                      ? '$' + Number(feeDefaults[s.id]).toLocaleString('en-US') + ' Flat Fee' : null,
                    sheet_name: s.model === 'fixed' ? legalFixedSheet(s, feeDefaults[s.id]).name : null,
                    /* D12 — the Standard/Custom fee control draws only for a
                       service the owner made adjustable, and its Standard
                       label is composed HERE so no figure lives in the page. */
                    adjustable: s.id === 'process',
                    fee_default: s.model === 'fixed' ? feeDefaults[s.id] : null,
                  })),
                  case_legal_service: caseSvc ? caseSvc.id : null,
                  case_flat_fee: caseFlatFee,
                  billcom_ready: billcom.ready,
                  email_configured: Boolean(env.RESEND_API_KEY) });
  }

  m = p.match(/^\/sheets\/([a-z_]{3,32})\/email$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return emailSheet(request, env, user, m[1]);
  }

  /* Payment instructions WITHOUT the sheet (PAYMENTS.md second handoff §4).
     Admin-only like every other money route — an investigator has no business
     asking a client for the retainer, and knowing where the firm's money
     arrives is not fieldwork. */
  if (p === '/payment-options/email' && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return emailPaymentOptions(request, env, user);
  }

  /* Private-client payment configuration (PAYMENTS.md). Admin-only on both
     verbs: an investigator has no business knowing where the firm's money
     arrives, and the handle is the firm's, not the case's. Read is gated as
     hard as write — a 403 on POST alone would leave the configuration
     browsable. */
  if (p === '/payment-methods' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return json({ methods: await paymentConfig(env) });
  }

  m = p.match(/^\/payment-methods\/([a-z_]{3,32})$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return setPaymentMethod(request, env, user, m[1]);
  }

  /* Counts for the dashboard. Scoped like everything else — an investigator's
     totals are their own cases, not the firm's book of work. */
  if (p === '/summary' && method === 'GET') return caseSummary(env, user);

  /* UNIT 8 — one box that finds the case. Role-scoped INSIDE the SQL, not by
     the page: an investigator's search reaches only cases assigned to them,
     and the arms that read the paying side do not run for them at all. */
  if (p === '/search' && method === 'GET') return globalSearch(request, env, user);
  /* And the exception list the office works from. Admin-only, like the
     recent-activity feed and the storage card it summarises. */
  if (p === '/attention' && method === 'GET') return needsAttention(env, user);
  /* API ASSISTANT (ASSISTANT.md) — Beta dry-run, both roles: everything the
     Assistant can do is a read the signed-in user could already make, the
     consequential verbs are refused inside the command handler by name, and
     no /assistant route writes anything anywhere. */
  if (p === '/assistant/state' && method === 'GET') return assistantState(env, user);
  if (p === '/assistant/command' && method === 'POST') return assistantCommand(request, env, user);
  /* Unit 4 — admin-only, exactly like the real intake-send doors these
     rehearse (`/leads/:no/send-intake`, `/intake-link/email`). */
  if (p === '/assistant/prepare-intake' && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return assistantPrepareIntake(request, env);
  }
  if (p === '/assistant/simulate-intake' && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return assistantSimulateIntake(request, env, user);
  }
  /* Unit 5 — admin-only like `/sheets/:id/email`, the door this rehearses. */
  if (p === '/assistant/prepare-sheet' && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return assistantPrepareSheet(request, env);
  }
  if (p === '/assistant/simulate-sheet' && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return assistantSimulateSheet(request, env, user);
  }

  if (p === '/tasks' && method === 'GET') return taskBoard(env, user);
  if (p === '/file-queue' && method === 'GET') return fileQueue(env, user);
  if (p === '/audit' && method === 'GET') return auditTrail(request, env, user);
  if (p === '/recent-activity' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return json({ activity: await recentActivity(env) });
  }

  /* DASH-DELETE — remove one line from the feed above. A MARKER, never a touch
     on a source row: the feed is composed from intakes, days, reports, media,
     money and package events, and money, sends and audit rows are non-deletable
     by the owner's own limits. So "delete this entry" here can only ever mean
     "stop drawing it", the underlying record stays exactly where it was, and
     the marker keeps who hid it and when. Idempotent by PRIMARY KEY — a double
     tap on a flaky connection is not an error the office has to interpret. */
  if (p === '/feed/hide' && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    if ((await missingTables(env)).includes('feed_hidden')) {
      return json({ error: 'Hiding feed entries is not set up on this database yet. Run the '
                         + 'portal-setup workflow once and try again.' }, 503);
    }
    const body = await readJson(request);
    const kind = String(body.kind || '');
    const refId = Math.floor(Number(body.ref_id));
    if (!FEED_KINDS[kind]) return json({ error: 'Unknown feed entry kind.' }, 400);
    if (!Number.isFinite(refId) || refId <= 0) {
      return json({ error: 'ref_id must be the feed row\'s id.' }, 400);
    }
    /* The row must exist, and whose case the line described is recorded from
       the row itself — never from anything the page sent. */
    const row = await env.DB.prepare(FEED_KINDS[kind]).bind(refId).first();
    if (!row) return json({ error: 'That feed entry no longer exists.' }, 404);
    await env.DB.prepare(
      `INSERT INTO feed_hidden (kind, ref_id, case_no, hidden_by, hidden_at)
       VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(kind, ref_id) DO NOTHING`)
      .bind(kind, refId, row.case_no, user.id, nowIso()).run();
    return json({ ok: true, kind, ref_id: refId, case_no: row.case_no, hidden: true });
  }

  /* The case workspace. Every route below re-checks that this caller may open
     this case, against the database, so a changed case number in the URL is
     not a way into someone else's work. */
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/workspace$/);
  if (m && method === 'GET') return caseWorkspace(env, user, m[1]);

  /* THE TIMELINE IS A READ, and reads stay open on a deleted or archived case
     on purpose: an admin has to be able to see what happened before deciding
     whether to put one back. `caseTimeline` re-checks the caller through
     `caseFor` like every route here, and the paying-side arms simply do not
     run for an investigator. */
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/timeline$/);
  if (m && method === 'GET') return caseTimeline(env, user, m[1], url);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/meta$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return setCaseMeta(request, env, m[1]);
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/day\/start$/);
  if (m && method === 'POST') return startDay(request, env, user, m[1]);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/day\/end$/);
  if (m && method === 'POST') return endDay(request, env, user, m[1]);

  /* END SOMEONE ELSE'S SESSION — its own route, deliberately (owner, 2026-08-16:
     "ending another admin's session requires a separate explicit confirm
     action").

     A separate path rather than a flag on `/day/end`, so the ordinary control
     CANNOT reach it however it is called. A flag is one stray `true` away from
     being back where this started; a route the End button never calls is not.

     Admin-only, and it is also the recovery path from HIGH #2 — a day stranded
     by a reassignment, where the original investigator can no longer pass
     `caseFor` and nobody else could reach the clock. No reason is asked for
     (owner): the confirmation is the deliberate act. */
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/day\/end-other$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return endDay(request, env, user, m[1], { allowOthers: true });
  }

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

  /* UNIT 39 — one door for every removable record, keyed by kind. Under
     `/cases/:no/`, so the router's deleted-case chokepoint below already
     refuses every one of them on a tombstoned case without a per-route check:
     the trap `caseSendRefusal()` was written for. The preflight is a GET and
     deliberately stays open on a deleted case, for the same reason its reads
     do — an admin has to be able to see what a record is before deciding. */
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/content\/([a-z_]{3,20})\/(\d{1,12})\/preflight$/);
  if (m && method === 'GET') return contentPreflight(env, user, m[1], m[2], parseInt(m[3], 10));

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/content\/([a-z_]{3,20})\/(\d{1,12})\/remove$/);
  if (m && method === 'POST') return removeContent(request, env, user, m[1], m[2], parseInt(m[3], 10));

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/content\/([a-z_]{3,20})\/(\d{1,12})\/restore$/);
  if (m && method === 'POST') return restoreContentRoute(request, env, user, m[1], m[2], parseInt(m[3], 10));



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
  if (p === '/delivery-center' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return json(await deliveryCenter(env));
  }

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

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/legal$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return setLegalDetail(request, env, user, m[1]);
  }

  /* ------------------------------------------------- UNIT 7: profiles

     ADMIN ONLY AT EVERY DOOR, exactly like /sheets and /pricing. There is no
     public route into any of this: the ingest never reads a profile table, so
     a public intake user cannot browse firms, search saved attorneys or
     discover a saved contact — not because a check refuses them, but because
     no route exists on that side of the wall. */
  if (p === '/profiles' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return listProfilesRoute(request, env);
  }
  if (p === '/profiles' && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return createProfile(request, env, user);
  }
  /* The possible-match check on its own, so the page can warn while the office
     is still typing rather than only when they press Save. It reads; it never
     writes, and it is the same function the refusal uses. */
  /* INTERNAL / NO UI EXPECTED (Unit 31). The screen uses the per-case
     `/cases/:no/profile-match` — the "Look for a match" button — so this
     unscoped variant has no caller. Kept: it is part of the admin-only profile
     boundary walk the suite performs (an investigator must be refused it), and
     it is the pre-create duplicate check the directory would need if that
     button ever moves. Deprecating it would mean removing a boundary
     assertion. */
  if (p === '/profiles/match' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    if ((await profilesMissing(env)).length) return json({ matches: [], not_set_up: true });
    const u = new URL(request.url);
    return json({ matches: await profileMatchesFor(env, {
      name: u.searchParams.get('name'), email: u.searchParams.get('email'),
      phone: u.searchParams.get('phone'), address: u.searchParams.get('address'),
      exclude: u.searchParams.get('exclude'),
    }) });
  }
  m = p.match(/^\/profiles\/(\d+)$/);
  if (m) {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    if (method === 'GET') return getProfileRoute(env, Number(m[1]));
    if (method === 'POST') return updateProfile(request, env, user, Number(m[1]));
  }
  m = p.match(/^\/profiles\/(\d+)\/delete$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return deleteProfile(env, Number(m[1]));
  }
  m = p.match(/^\/profiles\/(\d+)\/contacts$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return addProfileContact(request, env, user, Number(m[1]));
  }
  m = p.match(/^\/profiles\/(\d+)\/contacts\/(\d+)$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return updateProfileContact(request, env, user, Number(m[1]), Number(m[2]));
  }
  m = p.match(/^\/profiles\/(\d+)\/contacts\/(\d+)\/remove$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return removeProfileContact(env, Number(m[1]), Number(m[2]));
  }
  /* Under /cases/:no/ deliberately, so the deleted- and archived-case gate
     above sees it without a check of its own. */
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/profile$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return linkCaseProfile(request, env, user, m[1]);
  }
  /* Look for a saved profile matching THIS case — a read, run because an admin
     pressed for it rather than every time a case is opened. */
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/profile-match$/);
  if (m && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return caseProfileMatch(env, m[1]);
  }

  if (p === '/intakes' && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return createManualIntake(request, env, user);
  }

  /* PRE-CASE SENDS (owner, 2026-08-15). The intake form sent to a name and an
     email, with no case and nothing created. */
  if (p === '/intake-link/email' && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return sendPreCaseIntake(request, env, user);
  }

  /* The send history, INCLUDING sends that have no case (owner requirement 6).
     Every other view of `send_log` hangs off a case, so a pre-case send was
     being written correctly and was then invisible — written and never read,
     which is the same gap this project has hit before. Admin-only: an
     investigator is never told who the client was emailed. */
  if (p === '/sends' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return sendHistory(request, env);
  }

  // Active Surveillance Mode: resume-anywhere for whoever is asking, and the
  // office's view of who is out. Both scoped by the caller's own identity.
  if (p === '/my/active' && method === 'GET') return myActiveDay(env, user);
  if (p === '/active' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return outNow(env);
  }

  /* INTERNAL / NO UI EXPECTED (Unit 31). Named by the Production Truth Audit
     as a candidate for removal and KEPT after checking its callers: the
     Dropbox card reads the richer `/dropbox/status`, but this route is the
     generic provider-capability probe and it is exercised by three assertions,
     one of which is an authorization boundary (an investigator gets 403
     through the `/build/` prefix gate above). Removing it would delete a
     passing boundary check to gain nothing. A route with tests and no screen
     is internal, not dead. */
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
    const rep = await latestShippableReport(env, m[1]);
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
      seeded.length > 1 ? `on ${seeded.length} reports, ${seeded[0].report_date} to ${seeded[seeded.length - 1].report_date}`
        : rep ? `on the report of ${rep.report_date}` : 'no report ready yet');
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
      `SELECT r.id, r.report_date, r.status, u.role AS investigator_role
         FROM case_reports r LEFT JOIN users u ON u.id = r.investigator_id
        WHERE r.id = ? AND r.case_no = ?`)
      .bind(rid, b.case_no).first();
    if (!r) return json({ error: 'That report is not on this case.' }, 400);
    /* An investigator's report still needs the office's sign-off before it can
       ride in a package; an admin attaching their own draft IS the office. */
    if (!['approved', 'delivered'].includes(r.status) && r.investigator_role !== 'admin') {
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

  /* UNIT 9 — which of the six styles this document prints in. The same rule
     the rest of the build follows: a finalized package is changed by reopening
     it, never by a quiet edit underneath a document somebody may already have
     sent. Nothing about the report's content moves either way. */
  m = p.match(/^\/build\/(\d{1,12})\/template$/);
  if (m && method === 'POST') {
    const b = await adminBuild(env, user, parseInt(m[1], 10));
    if (!b) return json({ error: 'not found' }, 404);
    if ((await missingTables(env)).includes('build_template')) {
      return json({ error: 'The build_template table is not on this database yet. Run the '
        + 'portal-setup workflow once and try again — every report still prints in the general '
        + 'format meanwhile.', code: 'not_set_up' }, 503);
    }
    if (b.status !== 'draft') {
      return json({ error: 'This package is finalized. Reopen it to change the report template — '
        + 'a finalized document is not restyled underneath a client who may already have it.' }, 400);
    }
    const body = await readJson(request);
    const t = String(body.template || '');
    if (!REPORT_TEMPLATES.includes(t)) {
      return json({ error: `Unknown report template. Choose one of: ${REPORT_TEMPLATES.join(', ')}.` }, 400);
    }
    await env.DB.prepare(
      `INSERT INTO build_template (build_id, template, set_by, set_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(build_id) DO UPDATE SET template = excluded.template,
         set_by = excluded.set_by, set_at = excluded.set_at`)
      .bind(b.id, t, user.id, nowIso()).run();
    await buildEvent(env, b.id, user, 'template', t);
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
          `${seeded.length} report(s) at finalize`);
      }
    }
    const { results: items } = await env.DB.prepare(
      'SELECT id, evidence_id, role FROM build_items WHERE build_id = ?').bind(b.id).all();
    const report = b.report_id ? await env.DB.prepare(
      'SELECT id, report_date, status FROM case_reports WHERE id = ? AND case_no = ?')
      .bind(b.report_id, b.case_no).first() : null;
    const attachedNow = await buildReports(env, b.id, b.case_no);
    const gates = await buildGates(env, b, items || [], report,
      attachedNow, await isCustomBuild(env, b.id));
    if (gates.length) return json({ error: 'Not ready to finalize.', gates }, 400);
    /* THE FINALIZE IS THE SIGN-OFF. Any report still unapproved here passed
       the gates, so it is an admin's own work — stamp it approved as part of
       sealing the package, recorded against the finalizing admin, so the
       status column stays the one answer to "was this signed off" everywhere
       else in the portal. A stamp, not a silent bypass: status_by names who,
       status_at names when, and the build event names which. */
    const unapproved = attachedNow.filter(r => !['approved', 'delivered'].includes(r.status));
    for (const r of unapproved) {
      await env.DB.prepare(
        'UPDATE case_reports SET status = ?, status_at = ?, status_by = ? WHERE id = ?')
        .bind('approved', nowIso(), user.id, r.id).run();
    }
    if (unapproved.length) {
      await buildEvent(env, b.id, user, 'reports_approved',
        `${unapproved.map(r => r.report_date).join(', ')} — the finalizing admin's sign-off`);
    }
    await env.DB.prepare(
      'UPDATE case_builds SET status = ?, finalized_by = ?, finalized_at = ?, updated_by = ?, updated_at = ? WHERE id = ?')
      .bind('finalized', user.id, nowIso(), user.id, nowIso(), b.id).run();
    /* WHAT IT WAS FINALIZED WITH, on the record. The marker row already holds
       it and a finalized build refuses to change it — this puts it in the
       audit trail too, so "which style did that document go out in" is
       answerable from the events without inferring anything. */
    const finalTemplate = await buildTemplate(env, b.id);
    await buildEvent(env, b.id, user, 'finalized',
      `v${b.version}, ${(items || []).length} item(s), ${finalTemplate} template`);
    await notifyAdmins(env, 'packages', b.case_no);
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
  m = p.match(/^\/build\/(\d{1,12})\/report-pdf$/);
  if (m && method === 'POST') return saveBuildPdf(request, env, user, parseInt(m[1], 10));

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
  if (m && method === 'GET') {
    return serveEvidence(env, user, m[1], parseInt(m[2], 10), request.headers.get('Range'));
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/evidence\/(\d{1,12})$/);
  if (m && method === 'POST') return editEvidence(request, env, user, m[1], parseInt(m[2], 10));

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/evidence\/(\d{1,12})\/restore$/);
  if (m && method === 'POST') return restoreEvidence(env, user, m[1], parseInt(m[2], 10), null);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/evidence\/(\d{1,12})\/delete$/);
  if (m && method === 'POST') return deleteEvidence(env, user, m[1], parseInt(m[2], 10));

  /* Video timestamping. Addressed under /cases/:no/ on purpose, so the deleted
     and archived chokepoint above already covers the two writes and neither has
     to remember the rule for itself. */
  /* ---- DROPBOX: connect, callback, status, disconnect ----

     Admin-only, all four. An investigator has no business holding the firm's
     Dropbox connection open or closed, and `/status` is admin-only too because
     it names the connected account. */

  if (p === '/dropbox/status' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return json({ dropbox: await dropboxState(env) });
  }

  if (p === '/dropbox/connect' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    if (!EXTERNAL_PROVIDERS.dropbox.configured(env)) {
      return json({ error: 'Dropbox is not set up on this Worker yet. '
        + EXTERNAL_PROVIDERS.dropbox.note, code: 'provider_not_configured' }, 503);
    }
    if ((await missingTables(env)).includes('dropbox_auth')) {
      return json({ error: 'The Dropbox connection table is not on this database yet. Run the '
        + 'portal-setup workflow once and try again.', code: 'not_set_up' }, 503);
    }
    const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const url = new URL('https://www.dropbox.com/oauth2/authorize');
    url.searchParams.set('client_id', env.DROPBOX_APP_KEY);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', dropboxRedirectUri(env));
    url.searchParams.set('state', state);
    /* `offline` is what returns a REFRESH token. Without it Dropbox hands back a
        four-hour access token and the connection quietly dies overnight. */
    url.searchParams.set('token_access_type', 'offline');
    url.searchParams.set('scope', DBX_SCOPES);
    /* Dropbox is given the RANDOM half only. The admin id rides home in the
       cookie, not in a URL that lands in Dropbox's logs and the browser's
       history. */
    const exp = Math.floor(Date.now() / 1000) + DBX_STATE_TTL;
    const carried = await dbxStateValue(env, state, user.id, exp);
    return redirectTo(url.toString(), { 'Set-Cookie': dbxStateCookie(carried, DBX_STATE_TTL) });
  }


  /* THE APP FOLDER'S NAME, recorded once so the links resolve. It is not a
     credential and not a path the Worker uploads to — every upload addresses
     the App Folder root, which needs no name. This value builds a WEB URL and
     nothing else, so getting it wrong costs a link that lands in the wrong
     place in the admin's own Dropbox, never a misplaced file.

     An empty value CLEARS it, and that is the admin saying they would rather
     have no link than a wrong one. `configValue` reads the row back, so an
     absent key and a cleared key answer identically. */
  if (p === '/dropbox/folder' && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    const body = await readJson(request);
    const name = String(body.folder_name == null ? '' : body.folder_name).trim().slice(0, 120);
    if (name && DBX_NAME_BAD.test(name)) {
      return json({ error: 'A Dropbox folder name cannot contain \\ / : ? * < > " or |. '
        + 'Type the folder name on its own, not a path or a web address.',
        code: 'bad_folder_name' }, 400);
    }
    await env.DB.prepare(
      `INSERT INTO app_config (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET value = ?2, updated_by = ?3, updated_at = ?4`)
      .bind(DBX_FOLDER_KEY, name, user.id, nowIso()).run();
    return json({ ok: true, dropbox: await dropboxState(env) });
  }

  if (p === '/dropbox/disconnect' && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    if ((await missingTables(env)).includes('dropbox_auth')) {
      return json({ error: 'Nothing is stored to disconnect.', code: 'not_set_up' }, 503);
    }
    /* REVOKE AT DROPBOX FIRST, then forget it here. Deleting the row alone
       would leave a live token on the account with nothing in the portal to
       revoke it with — the opposite of disconnecting. If the revoke cannot be
       reached the row still goes, and the answer says so rather than implying
       the token is dead. */
    let revoked = false;
    const at = await dropboxAccessToken(env);
    if (at) {
      try {
        const r = await fetch('https://api.dropboxapi.com/2/auth/token/revoke', {
          method: 'POST', headers: { Authorization: `Bearer ${at}` } });
        revoked = r.ok;
      } catch { revoked = false; }
    }
    await env.DB.prepare('DELETE FROM dropbox_auth WHERE id = 1').run();
    return json({ ok: true, revoked,
      detail: revoked ? 'The token was revoked at Dropbox and forgotten here.'
        : 'Forgotten here. Dropbox could not be reached to revoke it, so remove this app '
          + 'from the Dropbox account page as well.',
      dropbox: await dropboxState(env) });
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/video-stamps$/);
  if (m && method === 'GET') return listVideoStamps(env, user, m[1]);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/video-stamp$/);
  if (m && method === 'POST') return recordVideoStamp(request, env, user, m[1]);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/video-stamp\/(\d{1,12})\/dropbox\/(start|append|finish)$/);
  if (m && method === 'POST') {
    return videoStampToDropbox(request, env, user, m[1], parseInt(m[2], 10), m[3]);
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/video-stamp\/(\d{1,12})\/saved$/);
  if (m && method === 'POST') return markVideoStampSaved(env, user, m[1], parseInt(m[2], 10));

  /* The case number is in the path, so the deleted/archived chokepoint above
     refuses this before it is reached — nothing extra to remember here. */
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/photo-stamp$/);
  if (m && method === 'POST') return recordPhotoStamp(request, env, user, m[1]);

  /* Unit 11: integrity is explicit. Two byte-reading actions and one metadata
     view; nothing here runs on an ordinary case open. */
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/evidence\/(\d{1,12})\/record-hash$/);
  if (m && method === 'POST') return recordEvidenceHash(env, user, m[1], parseInt(m[2], 10));

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/evidence\/(\d{1,12})\/verify$/);
  if (m && method === 'POST') return verifyEvidenceHash(env, user, m[1], parseInt(m[2], 10));

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/manifest$/);
  if (m && method === 'GET') return evidenceManifest(env, user, m[1]);

  if (p === '/storage' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return json({ storage: await evidenceUsage(env) });
  }

  m = null;
  if (p === '/storage-health' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return json(await storageHealth(env));
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
  m = p.match(/^\/invoices\/(\d{1,12})\/payments\/(\d{1,12})\/void$/);
  if (m && method === 'POST') {
    return voidInvoicePayment(request, env, user, parseInt(m[1], 10), parseInt(m[2], 10));
  }
  if (p === '/billing-settings' && method === 'GET') return json({ settings: await billingSettings(env) });
  if (p === '/billing-settings' && method === 'POST') {
    const body = await readJson(request);
    /* THE PREFIX IS THE ONE FIELD THAT IS NOT FREE TEXT (Unit 29). It is what
       every invoice number starts with — `nextInvoiceNo` builds
       `<prefix>-<year>-0001` and reads the sequence back from the LAST hyphen —
       so an empty or exotic prefix does not make an ugly invoice, it makes a
       numbering scheme that cannot be parsed. Checked HERE and not only in the
       page, because the page is not the boundary. */
    if (body.invoice_prefix !== undefined) {
      const pre = String(body.invoice_prefix).trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/.test(pre)) {
        return json({ error: 'The invoice number prefix must be 1–20 characters of letters, '
          + 'numbers or hyphens, and cannot start with a hyphen or be empty.',
          code: 'bad_prefix' }, 400);
      }
    }
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
    /* AN ABSENT AMOUNT MEANS UNCHANGED, NOT "BACK TO THE DEFAULT".

       This defaulted to PERSONAL.retainer whenever the field was missing, and
       the upsert below writes retainer_amount unconditionally — so any caller
       that did not resend the figure silently reset it. Record Payment is
       exactly such a caller: it sends the receipt, not the amount. A case
       agreed at $2,500 dropped to $1,500 the moment the office recorded the
       money arriving, and `remaining` then recomputed against a retainer the
       client never agreed to. Nothing announced it.

       The default belongs where there is genuinely nothing to preserve — a
       case with no retainer row yet. */
    const raw = body.retainer_amount;
    const absent = raw === undefined || raw === null || String(raw).trim() === '';
    if (!absent && !Number.isFinite(Number(raw))) {
      return json({ error: 'The retainer must be a number.' }, 400);
    }
    /* ZERO IS REFUSED, and it is not pedantry (owner: "validated as a positive
       dollar amount"). `rateSheets()` falls back to PERSONAL.retainer for
       anything not above zero, so a stored 0 would leave the case record saying
       $0 while the sheet the client receives says $1,500 — the record and the
       document disagreeing, silently, which is the exact defect #123 fixed in
       the other direction. Refuse it at the door rather than let the two drift. */
    if (!absent && Number(raw) <= 0) {
      return json({ error: 'The retainer has to be more than $0. To record that this case has no '
                         + 'retainer, leave the amount alone rather than setting it to zero.' }, 400);
    }
    /* NULL means "leave it alone", and the SQL below resolves that against the
       row's own current value. Reading the amount here and writing it back
       would be read-then-write: a concurrent request that changed the retainer
       between the SELECT and the upsert would be silently overwritten by this
       one, putting back a figure that was already superseded. Two admins on the
       same private case — one adjusting the retainer, one recording the
       payment — is an ordinary Monday, not a race worth ignoring. */
    const amount = absent ? null : Number(raw);
    /* AN ABSENT `received` MEANS UNCHANGED TOO — the same rule as the amount,
       for the same reason, in the other column.

       This read `body.received === true ? 1 : 0`, so a caller that sent only
       the amount silently set received back to 0 and cleared received_at. The
       retainer SELECTOR is exactly such a caller: it changes the agreed figure
       and knows nothing about whether the money arrived. Raising an agreed
       retainer from $1,500 to $3,000 would have un-received a retainer that had
       genuinely been paid, and the case would read RETAINER PENDING with the
       payments still sitting in the log underneath.

       `false` is still a real answer and still un-marks it — the settings panel
       unticks that box on purpose. Only undefined and null mean "I am not
       talking about this". */
    const recAbsent = body.received === undefined || body.received === null;
    const received = recAbsent ? null
      : (body.received === true || body.received === 1 || body.received === '1' ? 1 : 0);

    /* THE RECEIPT: what actually arrived (PAYMENTS.md §5/§11). `received` on
       its own is a flag — it can say money came in and nothing about which
       money, so nobody can reconcile it against a bank statement later. The
       details are optional, because an admin who knows the money landed should
       not be blocked from saying so while they hunt for the reference. */
    const clean = (v, max) => String(v == null ? '' : v)
      .replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
    const rcMethod = clean(body.method, 32);
    if (rcMethod && !RETAINER_METHODS.includes(rcMethod)) {
      return json({ error: 'Pick a real payment method.' }, 400);
    }
    const rcPaidOn = clean(body.paid_on, 10);
    if (rcPaidOn && !/^\d{4}-\d{2}-\d{2}$/.test(rcPaidOn)) {
      return json({ error: 'The payment date should be a calendar date.' }, 400);
    }
    const rcRaw = body.amount_received;
    const rcAmount = rcRaw === undefined || rcRaw === null || String(rcRaw).trim() === ''
      ? null : Number(rcRaw);
    if (rcAmount !== null && !(Number.isFinite(rcAmount) && rcAmount >= 0)) {
      return json({ error: 'The amount received must be a number.' }, 400);
    }
    const rcRef = clean(body.reference, 200);

    /* MONEY IS RECORDED IN THE LOG, NOT HERE. This route used to write
       retainer_receipt, which is keyed by case_no and therefore holds one
       instalment — and it kept creating new legacy rows after the log existed,
       which is what made the totals ambiguous. It now writes a payment like any
       other, so there is exactly one place money enters the ledger.

       A payment only lands if a figure was given: `received: true` on its own
       is the office ticking "the money is in" without saying how much, which is
       the flag, not a payment.

       Un-marking no longer deletes anything. A payment recorded in error is
       voided through its own route, which keeps the record; unticking a
       checkbox is not a reason to erase a payment history. */
    if (received === 1 && rcAmount !== null && rcAmount > 0) {
      const tok = clean(body.client_token, 64);
      const outcome = await recordRetainerPayment(env, m[1], tok,
        { amount: rcAmount, method: rcMethod, paid_on: rcPaidOn, reference: rcRef }, user.id);
      /* Nothing else on this request may proceed on an outcome nobody knows —
         the retainer row must not be marked received on the strength of a
         payment that may not exist. */
      if (outcome === 'indeterminate') return json(INDETERMINATE_PAYMENT, 409);
    }

    await env.DB.prepare(
      /* ?2 NULL = the caller said nothing about the amount. On a new row that
         means the standard retainer (?6); on an existing one it means the value
         already there, resolved inside the UPDATE so no other write can slip
         between a read and this statement.

         ?3 NULL = the caller said nothing about receipt, and resolves the same
         way: 0 on a brand-new row (a retainer nobody has mentioned has not
         arrived), and the row's own current value on an existing one. Both
         columns are preserved by the statement rather than by a prior read, so
         two admins on one private case cannot overwrite each other. */
      `INSERT INTO case_retainer (case_no, retainer_amount, received, received_at, updated_by, updated_at)
       VALUES (?1, COALESCE(?2, ?6), COALESCE(?3, 0),
               CASE WHEN COALESCE(?3, 0) = 1 THEN ?4 ELSE NULL END, ?5, ?4)
       ON CONFLICT(case_no) DO UPDATE SET
         retainer_amount = COALESCE(?2, case_retainer.retainer_amount),
         received = COALESCE(?3, case_retainer.received),
         received_at = CASE WHEN COALESCE(?3, case_retainer.received) = 1
                            THEN COALESCE(case_retainer.received_at, ?4) ELSE NULL END,
         updated_by = ?5, updated_at = ?4`)
      .bind(m[1], amount, received, nowIso(), user.id, PERSONAL.retainer).run();
    return json({ ok: true, authorization: await authorizationFor(env, m[1], true) });
  }

  /* A retainer INSTALMENT. Additive: a second payment never overwrites a first,
     because a client paying $1,000 twice against a $3,000 retainer has paid
     $2,000 and the record has to say so. Private cases only — a claim
     assignment is authorized in hour blocks and has no retainer to pay. */
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/retainer\/payment$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    const sub = await env.DB.prepare('SELECT kind FROM submissions WHERE case_no = ?').bind(m[1]).first();
    if (!sub) return json({ error: 'not found' }, 404);
    if (sub.kind === 'claims') {
      return json({ error: 'Retainers are the private-client model — a claim assignment is authorized in hour blocks.' }, 400);
    }
    const body = await readJson(request);
    const clean = (v, max) => String(v == null ? '' : v)
      .replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
    const amt = Number(body.amount);
    /* An amount is required HERE, unlike the older combined route: a payment
       with no figure cannot be summed, and a total that silently skips a row
       is worse than a refusal. */
    if (!Number.isFinite(amt) || amt <= 0) {
      return json({ error: 'A payment needs a positive amount.' }, 400);
    }
    const meth = clean(body.method, 32);
    if (meth && !RETAINER_METHODS.includes(meth)) {
      return json({ error: 'Pick a real payment method.' }, 400);
    }
    const on = clean(body.paid_on, 10);
    if (on && !/^\d{4}-\d{2}-\d{2}$/.test(on)) {
      return json({ error: 'The payment date should be a calendar date.' }, 400);
    }
    /* IDEMPOTENT. A retry, a double tap or an offline replay delivers the same
       payment twice, and an additive ledger would take both — two rows, twice
       the money, a total nobody can reconcile against the bank. The token is
       one per payment ATTEMPT, and the second arrival does nothing rather than
       erroring, so a client retrying after a dropped response still sees the
       state it expected. */
    const tok = clean(body.client_token, 64);
    /* A repeat token writes nothing and still answers 200 with the current
       state: from the caller's side the payment IS recorded, which is the whole
       point of an idempotency key. Erroring here would make a dropped response
       look like a failure and invite the very retry that duplicates. */
    const outcome = await recordRetainerPayment(env, m[1], tok,
      { amount: amt, method: meth, paid_on: on, reference: clean(body.reference, 200) }, user.id);
    if (outcome === 'indeterminate') return json(INDETERMINATE_PAYMENT, 409);
    /* The money is on the ledger; the alert says so and never how much — and
       says it ONCE (Unit 20). This fired on 'duplicate' too, so a double click
       or a retry recorded one payment and sent two alerts: the ledger was
       idempotent and the notification about it was not. Probed and recorded as
       a defect on 2026-08-17, fixed here. */
    if (outcome !== 'duplicate') await notifyAdmins(env, 'payments', m[1]);
    return json({ ok: true, authorization: await authorizationFor(env, m[1], true) });
  }

  /* Correcting a payment VOIDS it. The row stays, so the record still shows
     what was believed at the time and who corrected it — history is not
     rewritten, the same rule evidence and submitted reports already follow. */
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/retainer\/payment\/(\d+)\/void$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    const row = await env.DB.prepare(
      'SELECT id FROM retainer_payment WHERE id = ? AND case_no = ?').bind(m[2], m[1]).first();
    if (!row) return json({ error: 'not found' }, 404);
    const body = await readJson(request);
    await env.DB.prepare(
      `INSERT INTO retainer_payment_void (payment_id, reason, voided_by, voided_at)
       VALUES (?1, ?2, ?3, ?4) ON CONFLICT(payment_id) DO NOTHING`)
      .bind(row.id, String(body.reason || '').slice(0, 200), user.id, nowIso()).run();
    return json({ ok: true, authorization: await authorizationFor(env, m[1], true) });
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/retention$/);
  if (m && method === 'GET') return retentionRead(env, user, m[1]);
  if (m && method === 'POST') return retentionSave(request, env, user, m[1]);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/retention\/(schedule|unschedule)$/);
  if (m && method === 'POST') return retentionSchedule(request, env, user, m[1], m[2] === 'schedule');

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/hold$/);
  if (m && method === 'POST') return holdWrite(request, env, user, m[1], true);
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/hold\/release$/);
  if (m && method === 'POST') return holdWrite(request, env, user, m[1], false);

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/closeout$/);
  if (m && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    if (!(await caseFor(env, user, m[1]))) return json({ error: 'not found' }, 404);
    return json({ facts: await closeoutFacts(env, m[1]), generated_at: nowIso() });
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/closure$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return saveClosure(request, env, user, m[1]);
  }

  /* ARCHIVE AND RESTORE (owner, WORKFLOW-SIMPLIFICATION §2). Admin-only, like
     every other lifecycle control.

     NOTHING ABOUT THE CASE IS TOUCHED — not the stage, not the status, not a
     row anywhere else. Archiving writes one marker and restoring removes it,
     so "preserves everything and is restorable" is true by construction rather
     than by remembering to put things back. */
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/archive$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    if ((await missingTables(env)).includes('case_archive')) {
      return json({ error: 'Archiving is not set up on this database yet. Run the portal-setup '
                         + 'workflow once and try again.' }, 503);
    }
    const sub = await env.DB.prepare('SELECT case_no FROM submissions WHERE case_no = ?')
      .bind(m[1]).first();
    if (!sub) return json({ error: 'not found' }, 404);
    const running = await openDayBlocking(env, m[1]);
    if (running) {
      return json({ error: `${m[1]} has a day still running${
        running.investigator ? ` — ${running.investigator}'s, from ${running.day_date}` : ''
      }. End it before archiving, or the clock keeps going where nobody can see it.`,
        open_day: true }, 409);
    }
    await env.DB.prepare(
      `INSERT INTO case_archive (case_no, archived_by, archived_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(case_no) DO NOTHING`).bind(m[1], user.id, nowIso()).run();
    return json({ ok: true, case_no: m[1], archived: await archiveOf(env, m[1]) });
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/restore$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    if ((await missingTables(env)).includes('case_archive')) {
      return json({ error: 'Archiving is not set up on this database yet. Run the portal-setup '
                         + 'workflow once and try again.' }, 503);
    }
    const sub = await env.DB.prepare('SELECT case_no FROM submissions WHERE case_no = ?')
      .bind(m[1]).first();
    if (!sub) return json({ error: 'not found' }, 404);
    await env.DB.prepare('DELETE FROM case_archive WHERE case_no = ?').bind(m[1]).run();
    return json({ ok: true, case_no: m[1], archived: null });
  }

  /* EDIT CASE — correcting the case's own identity (owner, 2026-08-16).

     Until now nothing could change these at all: every `UPDATE submissions SET`
     in this Worker touched only `assigned_to` and `status`, so a name typed
     wrong at intake stayed wrong for the life of the case.

     THE CASE NUMBER IS READ-ONLY and is never read from the body — it is the
     case's identity, and it is already in the send log, on invoices and in
     every email subject line that has gone out. There is no rename here.

     Fields that have a route of their own — case type, agreed retainer, status,
     assignment, internal notes — are NOT duplicated here. The page calls those
     existing routes alongside this one, the way `saveCaseMeta` already does, so
     each thing keeps one writer. */
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/edit$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return editCase(request, env, user, m[1]);
  }

  /* WHO GETS TOLD WHAT. Admin-only, like every other office setting.

     Guarded on the table existing for the standing deploy-order reason: the
     Worker ships on push and schema.sql arrives on a manual portal-setup
     dispatch, so between the two this table is not there. Settings that 500
     would be a worse first impression than settings that explain themselves. */
  if (p === '/notify-recipients' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    if ((await missingTables(env)).includes('notify_recipient')) {
      return json({ recipients: [], events: ALERT_EVENTS.map(([id, label]) => ({ id, label })),
                    delivery: alertDelivery(env), needs_setup: true });
    }
    const { results } = await env.DB.prepare(
      `SELECT id, label, email, phone, enabled, alert_intakes, alert_payments,
              alert_reports, alert_packages, alert_tasks, created_at, updated_at
         FROM notify_recipient ORDER BY id`).all();
    return json({
      /* Alerts that reached nobody — admin-only, bounded, no client detail. */
      failures: await alertFailures(env),
      recipients: (results || []).map(r => ({
        id: r.id, label: r.label, email: r.email || '', phone: r.phone || '',
        enabled: Number(r.enabled) === 1,
        alerts: Object.fromEntries(ALERT_IDS.map(k => [k, Number(r['alert_' + k]) === 1])),
        created_at: r.created_at, updated_at: r.updated_at,
      })),
      /* THE EXACT WORDS EACH ALERT WOULD CARRY, composed by the Worker and
         returned for display. The office can SEE what leaves rather than take
         it on trust, the page never composes alert text of its own — one
         writer, so the preview cannot disagree with the alert — and the tests
         can hold every event to the privacy rule rather than just one. */
      events: ALERT_EVENTS.map(([id, label]) => ({
        id, label,
        /* BOTH channels, shown side by side, because the difference is the
           point: a text carries no case number and an email does. The office
           reads exactly what each one would send. */
        preview: alertText(id, ALERT_PREVIEW_CASE, 'email'),
        preview_sms: alertText(id, ALERT_PREVIEW_CASE, 'sms'),
      })),
      channels: ALERT_CHANNELS,
      delivery: alertDelivery(env),
      sample: alertText('intakes', ALERT_PREVIEW_CASE, 'email'),
    });
  }

  if (p === '/notify-recipients' && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    if ((await missingTables(env)).includes('notify_recipient')) {
      return json({ error: 'Notification settings are not set up on this database yet. '
                         + 'Run the portal-setup workflow once and try again.' }, 503);
    }
    return saveRecipient(request, env, user, null);
  }

  m = p.match(/^\/notify-recipients\/(\d{1,12})$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    if ((await missingTables(env)).includes('notify_recipient')) {
      return json({ error: 'Notification settings are not set up on this database yet. '
                         + 'Run the portal-setup workflow once and try again.' }, 503);
    }
    return saveRecipient(request, env, user, parseInt(m[1], 10));
  }

  m = p.match(/^\/notify-recipients\/(\d{1,12})\/delete$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    if ((await missingTables(env)).includes('notify_recipient')) {
      return json({ error: 'Notification settings are not set up on this database yet. '
                         + 'Run the portal-setup workflow once and try again.' }, 503);
    }
    const row = await env.DB.prepare('SELECT id FROM notify_recipient WHERE id = ?')
      .bind(m[1]).first();
    if (!row) return json({ error: 'not found' }, 404);
    /* A recipient is CONFIGURATION, not a record of anything that happened, so
       removing one really removes it. The tombstone rule is about case records
       — evidence, reports, money, audit — and a phone number that should no
       longer be told things is not one of those. Switching `enabled` off is the
       softer option and is one tap away. */
    await env.DB.prepare('DELETE FROM notify_recipient WHERE id = ?').bind(m[1]).run();
    return json({ ok: true, id: Number(m[1]) });
  }

  /* DELETE CASE — a tombstone, never a purge (owner, WORKFLOW-SIMPLIFICATION §2
     answer). Admin-only.

     The ONLY write is the marker. Nothing is removed: not the submission, not
     evidence, not reports, not invoices, not payment history, not the send or
     audit logs. A delete that deleted rows would not be a tombstone, and the
     owner ruled a true purge is not wanted.

     It differs from archive in REACH, not in destructiveness: a deleted case
     leaves every ordinary view including Archived, and comes back only under
     the Deleted lens — where an admin can restore it. */
  /* DASH-DELETE — the quick delete on the Leads desk. Matches no gate
     carve-out on purpose: a tombstoned case refuses it (restore first) and an
     archived one refuses it (the existing workflow is the answer), through
     the chokepoint above rather than checks repeated here. */
  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/intake-delete$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return intakeDelete(env, user, m[1]);
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/delete$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    if ((await missingTables(env)).includes('case_deleted')) {
      return json({ error: 'Deleting is not set up on this database yet. Run the portal-setup '
                         + 'workflow once and try again.' }, 503);
    }
    const sub = await env.DB.prepare('SELECT case_no FROM submissions WHERE case_no = ?')
      .bind(m[1]).first();
    if (!sub) return json({ error: 'not found' }, 404);
    const running = await openDayBlocking(env, m[1]);
    if (running) {
      return json({ error: `${m[1]} has a day still running${
        running.investigator ? ` — ${running.investigator}'s, from ${running.day_date}` : ''
      }. End it before deleting, or the clock keeps going where nobody can see it `
        + 'and nobody can stop it.', open_day: true }, 409);
    }
    /* THE HOLD OUTRANKS (Unit 17, decision 5): a case under a legal hold
       cannot be deleted until the hold is released, and the refusal names it. */
    const hold = await activeHold(env, m[1]);
    if (hold) {
      return json({ error: 'This case is under a legal hold — deleting is blocked until the '
        + 'hold is released.', code: 'legal_hold' }, 409);
    }
    const body = await readJson(request);
    const reason = String(body.reason == null ? '' : body.reason)
      .replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200);
    await env.DB.prepare(
      `INSERT INTO case_deleted (case_no, reason, deleted_by, deleted_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(case_no) DO NOTHING`).bind(m[1], reason || null, user.id, nowIso()).run();
    return json({ ok: true, case_no: m[1], deleted: await deletedOf(env, m[1]) });
  }

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/undelete$/);
  if (m && method === 'POST') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    if ((await missingTables(env)).includes('case_deleted')) {
      return json({ error: 'Deleting is not set up on this database yet. Run the portal-setup '
                         + 'workflow once and try again.' }, 503);
    }
    const sub = await env.DB.prepare('SELECT case_no FROM submissions WHERE case_no = ?')
      .bind(m[1]).first();
    if (!sub) return json({ error: 'not found' }, 404);
    await env.DB.prepare('DELETE FROM case_deleted WHERE case_no = ?').bind(m[1]).run();
    return json({ ok: true, case_no: m[1], deleted: null });
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

  m = p.match(/^\/cases\/([A-Za-z0-9-]{3,64})\/days\/(\d{1,12})\/summary$/);
  if (m && method === 'POST') return saveDaySummary(request, env, user, m[1], parseInt(m[2], 10));

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
      /* `case_no` is selected for BOTH roles so archived and deleted cases can
         be filtered out below, then deleted again from an investigator's rows —
         it is deliberately not theirs to see, and it never reaches the
         response. */
      `SELECT o.id, o.investigation_date, o.expected_hours, o.general_location, o.status,
              o.case_no, ${admin ? 'u.display_name AS investigator,' : ''}
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

    /* The calendar is a working view too. Filtered here rather than in both
       queries, and the investigator's rows give `case_no` back up afterwards. */
    const hidden = await hiddenCases(env);
    const calDays = (days || []).filter(d => !hidden.has(d.case_no));
    const calOffers = (offers || []).filter(o => !hidden.has(o.case_no))
      .map(o => { if (admin) return o; const { case_no, ...rest } = o; return rest; });

    return json({ month, days: calDays, offers: calOffers });
  }

  if (p === '/my/comp' && method === 'GET') {
    const r = await env.DB.prepare('SELECT hourly, mileage FROM user_rates WHERE user_id = ?')
      .bind(user.id).first();
    return json({ hourly: r ? r.hourly : null, mileage: r ? r.mileage : null });
  }

  if (p === '/my/reports' && method === 'GET') return myReports(env, user);
  if (p === '/my/expenses' && method === 'GET') return myExpenses(env, user);

  /* ADMIN, LIKE THE POST BESIDE IT AND LIKE THE WORKSPACE ALREADY DECIDED
     (Unit 30). `caseWorkspace` sends `case_types: admin ? … : []` — the field
     is deliberately not given the catalogue — while this route handed it to
     anyone signed in. Two answers to one question is what this codebase treats
     as a defect, and nothing calls it from the field: the only page caller is
     the admin-only Settings panel. A consistency fix, not a leak of client
     data — a case type is a business category, not identity or money. */
  if (p === '/case-types' && method === 'GET') {
    if (user.role !== 'admin') return json({ error: ADMIN_ONLY }, 403);
    return json({ case_types: await listCaseTypes(env) });
  }
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
  /* There is deliberately no route that CREATES an account directly: accounts
     exist only by redeeming an invitation. An admin can, however, set an
     existing user's password — `/users/:id/password` below, kept for the case
     where somebody is locked out and cannot reach their email. It is not the
     ordinary path: `/users/:id/reset-link` is what the page offers, and it
     leaves a `password_resets` row naming who issued it, which a direct set
     does not. Said plainly here because this comment claimed the opposite
     until the closeout audit of 2026-09-03 read it against the routes. */
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
    // Pages sets this for the site; the Worker answers on the same origin and
    // now says the same thing (closeout audit, 2026-09-03).
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    return new Response(res.body, { status: res.status, headers });
  },
};
