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

Two ways. The workflow is easier and repeatable; the manual steps are below it
if you would rather see each one happen.

### The easy way: run the setup workflow

**The API token needs to be able to do this.** The stored
`CLOUDFLARE_API_TOKEN` was created for Pages deploys and Worker uploads, so it
very likely cannot touch D1 or zone routes — the first setup run failed with
Cloudflare error 10000, Authentication error, for exactly that reason. In the
Cloudflare dashboard, **My Profile → API Tokens**, edit that token so it has
all of:

| Scope | Resource | Level |
| --- | --- | --- |
| Account | D1 | Edit |
| Account | Workers Scripts | Edit |
| Account | Cloudflare Pages | Edit |
| Zone | Workers Routes | Edit (alwayspreciseinvestigations.net) |
| Zone | Zone | Read (alwayspreciseinvestigations.net) |

The workflow checks all five before touching anything and lists every missing
one in a single run, so you fix the token once rather than discovering the gaps
one failure at a time.

Second prerequisite, because a password should never come from a machine that
then tells you what it is — add your admin password as a repository secret:

**Settings → Secrets and variables → Actions → New repository secret**
Name it `PORTAL_ADMIN_PASSWORD`. At least 12 characters, with an uppercase
letter, a lowercase letter and a digit.

Then **Actions → Set up the case portal → Run workflow**, fill in your username
and display name, and run it. It will:

- find or create the `api-case-portal` D1 database
- apply `schema.sql` to it
- generate the ingest key and commit it into the intake form
- put both secrets on the Worker
- deploy, attaching the D1 binding and the `/portal-api/*` route
- wait until the route actually answers
- create your admin account, then destroy the bootstrap token
- redeploy the site so the intake form picks up the key

It is safe to run more than once: a second run finds the existing database,
reuses the committed ingest key, and skips the admin because the account exists.
Re-run it any time something looks half-configured.

The one thing it cannot do is upgrade your plan. **Do that first** — sign-in
exceeds the free plan's 10 ms CPU limit while everything else keeps working,
which reads as a bug rather than a billing setting.

### The manual way

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

**6. Check it**

```bash
./case-portal/verify.sh
```

Read-only, creates nothing, sends no real data. It checks the Worker is
answering on the site's own domain, the D1 binding and ingest key are set, the
schema is applied, ingest refuses an unkeyed submission, case data is refused
to anyone not signed in, the portal page is served with its noindex and CSP
headers, and the intake form no longer carries the placeholder.

Run it after setup and after any deploy that touches the Worker. Two things it
cannot check are printed at the end: that you deleted `BOOTSTRAP_TOKEN`, and
that you are on the Workers Paid plan.

## Going live

The insurance pages, the vendor page and the carrier intake path need none of
the above — they are static and go live the moment the branch merges. Only the
portal needs Cloudflare set up, and until it is, the intake form still works and
still emails; it simply records nothing.

| | Needs setup? |
| --- | --- |
| `/insurance-investigations/` and its vendor page | no |
| Carrier path in `/intake/` | no |
| Storing submissions, `/portal/`, staff logins | yes — steps 1–6 |

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

- **The portal is the record; email is only an alert.** The email relay is a
  third party, so it is sent the case number, the service, and the contact's
  name, phone and email — nothing else. The claimant, the address, the vehicle,
  the alleged injury, the objective, the claim and policy numbers and the
  signature never leave this account. The alert says whether the portal write
  succeeded and where to read the rest.
- **If the portal write fails**, the alert says so in capitals and the client is
  told on screen to keep or print their copy. That is deliberate: the
  alternative is emailing the case content to a third party to avoid losing it,
  which is the thing this design exists to prevent. You still get their name and
  number, so the enquiry is never silently lost.
- **Nothing before this exists.** Submissions were only ever emailed, so the
  portal starts empty and fills from the first submission after the ingest key
  is set. Older intakes exist only in the inbox.
- **The free plan is worth trying before paying.** Sign-in is the only
  expensive request the portal makes — password hashing is deliberately slow.
  Everything else is a plain query, well inside any limit. `PBKDF2_ITER` in
  `wrangler.toml` is what decides whether sign-in fits, and it now ships at
  25,000 rather than 100,000 for that reason.

  That number has **not** been measured against Cloudflare's free-plan CPU
  limit. Deploy, try signing in, and find out. If it fails with a CPU error,
  halve it and redeploy. If it works, you are done — and you can raise it when
  you move to the paid plan.

  The count is stored per user with their hash, so changing it never locks
  anyone out; it applies to passwords set afterwards. To re-harden an existing
  account at a higher count, reset its password from the Staff tab.
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
