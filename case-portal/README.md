# Case portal

Stores every intake submission and puts it behind staff logins.

Two roles. **Admins** (you and your partner) see every case, assign work and
manage accounts. **Investigators** see only the cases assigned to them — that
is enforced in the SQL query, not by the page hiding rows.

**There is no public sign-up, and no route that creates an account directly.**
An account exists only by redeeming an invitation, and only an admin can issue
one. The invitee follows a one-time link and chooses their own password, so
nobody — including the admin who invited them — ever knows it. Links expire in
7 days, work once, and can be revoked.

- `worker.js` — the API. A separate Worker from `api-visitor-alerts` on purpose:
  this one holds claimant names, injuries, claim numbers and signatures, that
  one holds anonymous counters. Different secrets, different blast radius.
- `schema.sql` — the D1 tables. Safe to re-run.
- `test-worker.mjs` — runs the real worker against real SQLite. No network.
- The page lives at `/portal/` in the site root, and is excluded from search.

## What is stored

The full intake payload as submitted, plus denormalised columns so the case
list can be searched without parsing JSON. That includes claimant names,
alleged injuries, claim numbers and the signature image.

Passwords are PBKDF2-SHA256 with a per-user salt, and the iteration count is
stored per user so it can be raised later without invalidating anyone. Sessions
are server-side: the cookie holds a random token and the database holds only
its SHA-256, so a copy of the database yields no usable cookie.

## Setup

Once, from the repo root.

**1. Create the database**

```bash
npx wrangler d1 create api-case-portal
```

Put the returned `database_id` into `wrangler.toml`, then create the tables:

```bash
npx wrangler d1 execute api-case-portal --remote --file=case-portal/schema.sql
```

**2. Set the secrets**

```bash
cd case-portal
npx wrangler secret put INGEST_KEY        # any long random string
npx wrangler secret put BOOTSTRAP_TOKEN   # used once, below, then delete it
```

**3. Deploy — on the site's own domain**

```bash
npx wrangler deploy
```

`wrangler.toml` routes the Worker to
`alwayspreciseinvestigations.net/portal-api/*`. **That route is load-bearing.**
A session cookie set by a `workers.dev` hostname is cross-site: Safari drops
third-party cookies outright and `SameSite=Strict` blocks them everywhere else,
so sign-in would appear to succeed and then every following request would 401.
Same-origin also removes CORS and preflights entirely.

The first deploy must be a real `wrangler deploy` so the D1 binding and the
route are attached. After that, pushing a change to `worker.js` on `master`
runs `deploy-portal.yml`, which uploads content only and preserves both.

**4. Create your admin account**

```bash
curl -X POST https://alwayspreciseinvestigations.net/portal-api/setup \
  -H "X-Bootstrap-Token: <the BOOTSTRAP_TOKEN you set>" \
  -H "Content-Type: application/json" \
  -d '{"username":"trever","display_name":"Trever Brown","password":"<a long password>"}'
```

This only works while no account exists. Once it succeeds, remove the token so
the endpoint cannot be used again:

```bash
npx wrangler secret delete BOOTSTRAP_TOKEN
```

Then sign in at `/portal/`. Invite your partner as an **admin** and your
investigators as **investigators** from the Staff tab. Each invitation produces
a one-time link — copy it, or use the "Email it" button, which opens your own
mail client with the link already written. The link is shown once and is not
recoverable afterwards; reissue instead of hunting for it, which automatically
invalidates the previous one.

**5. Point the intake form at the portal**

In `intake/index.html`, replace `PASTE_INGEST_KEY` with the `INGEST_KEY` from
step 2. Until that is done the form still works and still emails — it just does
not record anything.

That key sits in a public page, so it is not a secret. It keeps casual noise
out of the table; the size cap, the case-number format check, the per-minute
rate limit and the unique constraint on case numbers are what actually protect
it.

## Tests

```bash
node case-portal/test-worker.mjs
```

```bash
node portal/test-portal.mjs      # needs Playwright
```

79 Worker checks and 35 end-to-end, covering login, lockout, account
enumeration, invitations, ingest validation and rate limiting, role separation,
account handling, the origin guard and a stored-XSS regression. The Worker
tests run against an in-memory SQLite database through a D1-shaped adapter, so
the SQL genuinely executes. The end-to-end tests mount the Worker at
`/portal-api/*` on the same origin as the page, because that is how it is
deployed — serving it from a second origin in the test would hide a cross-site
cookie bug, which is exactly what it did once.

## Things to know

- **Email still delivers.** The intake posts to Web3Forms *and* the portal. If
  the portal is down the client still gets a confirmation and you still get the
  email; only the stored copy is missed.
- **Nothing before this exists.** Submissions were only ever emailed, so the
  portal starts empty and fills from the first submission after the ingest key
  is set. Older intakes exist only in the inbox.
- **CPU on the free plan.** PBKDF2 at 100,000 rounds may exceed the free tier's
  per-request CPU limit on login. If sign-in fails with a CPU error, lower
  `PBKDF2_ITER` in `wrangler.toml` or move the Worker to a paid plan. Only
  logins and password changes are affected; everything else is a plain query.
- **Deactivate, don't delete.** Removing a user would orphan the assignment on
  their cases. Disabling ends their sessions immediately and keeps the history.
- **Case numbers are untrusted input.** They arrive from a public form and end
  up rendered in an admin's browser, so ingest pins them to
  `[A-Za-z0-9-]{3,64}`. Do not loosen that without also checking how the page
  renders them.
- **The ingest rate limit is real.** 60 submissions a minute by default, which
  is far above genuine traffic. Exceeding it drops portal writes for that
  minute only; the email path is untouched, so a flood can never stop a client
  reaching the firm.
