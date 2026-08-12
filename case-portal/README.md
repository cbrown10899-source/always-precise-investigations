# Case portal

Stores every intake submission and puts it behind staff logins.

Two roles. **Admins** (you and your partner) see every case, assign work and
manage accounts. **Investigators** see only the cases assigned to them — that
is enforced in the SQL query, not by the page hiding rows.

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

**3. Deploy**

```bash
npx wrangler deploy
```

The first deploy must be a real `wrangler deploy` so the D1 binding is
attached. After that, pushing a change to `worker.js` on `master` runs
`deploy-portal.yml`, which uploads content only and preserves the binding.

**4. Create your admin account**

```bash
curl -X POST https://api-case-portal.corlinllc.workers.dev/setup \
  -H "X-Bootstrap-Token: <the BOOTSTRAP_TOKEN you set>" \
  -H "Content-Type: application/json" \
  -d '{"username":"trever","display_name":"Trever Brown","password":"<a long password>"}'
```

This only works while no account exists. Once it succeeds, remove the token so
the endpoint cannot be used again:

```bash
npx wrangler secret delete BOOTSTRAP_TOKEN
```

Then sign in at `/portal/` and add your partner and your investigators from the
Staff tab.

**5. Point the intake form at the portal**

In `intake/index.html`, replace `PASTE_INGEST_KEY` with the `INGEST_KEY` from
step 2. Until that is done the form still works and still emails — it just does
not record anything.

That key sits in a public page, so it is not a secret. It keeps casual noise
out of the table; the Worker's size cap and the unique constraint on case
numbers are what actually protect it.

## Tests

```bash
node case-portal/test-worker.mjs
```

54 checks covering login, lockout, account enumeration, ingest, role
separation, account handling and CORS. They run the real worker against an
in-memory SQLite database through a D1-shaped adapter, so the SQL is genuinely
executed.

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
