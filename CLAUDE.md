# Always Precise Investigations — working notes

Static marketing site for Always Precise Investigations, LLC (Virginia PI firm).
No build step, no dependencies. Cloudflare Pages serves the repo root.

Live: https://alwayspreciseinvestigations.net

## Read this before querying GitHub Actions

**Do not call `list_workflow_runs` (or any Actions listing) without narrowing it.**

The GitHub API returns ~15 KB per run object — full `repository`,
`head_repository`, `actor`, `triggering_actor` and `head_commit` blobs — for
what is about 136 bytes of useful information. That is a 113x waste ratio.

Measured against this repo:

| Query                        | Payload    | Approx. tokens |
| ---------------------------- | ---------- | -------------- |
| 30 runs (one default page)   | 461 KB     | ~115,000       |
| all 84 runs                  | 1.29 MB    | ~323,000       |

A single unfiltered call therefore costs more than an entire context window
and will end the session. This repo accumulates runs quickly — five workflows,
one of them a daily cron — so the count only grows.

**`per_page` does not work on this tool.** Measured on 2026-08-12: asking for
`per_page: 2` with `resource_id: deploy.yml` returned **30 runs, 464 KB**. The
`resource_id` filter is honoured — only that workflow's runs came back — but the
count is not, so scoping alone still overflows.

What actually works:

- For "did my push deploy?", use `pull_request_read` with `get_status` or
  `get_check_runs`. Those return a few hundred bytes, not half a megabyte.
- If you do call an Actions listing, **expect it to overflow and plan for it**.
  The harness saves the payload to a file and hands you the path. Parse that
  file with a small python script that prints only the fields you want — never
  read it into context. That path works reliably and costs nothing:

  ```python
  d = json.loads(open(path).read()[open(path).read().find('{'):])
  for r in d['workflow_runs'][:5]:
      print(r['created_at'], r['conclusion'] or r['status'], r['name'], r['head_sha'][:8])
  ```

Do not "fix" this by adding `per_page` back. It was tried and it does nothing.

The same caution applies to `get_job_logs` on this repo: `site-health.yml`
emits a long step summary.

## Deploy topology

Five workflows, all in `.github/workflows/`:

| Workflow              | Trigger                              | Does                                       |
| --------------------- | ------------------------------------ | ------------------------------------------ |
| `deploy.yml`          | any push to `master`                 | rsyncs the site to Cloudflare Pages        |
| `build-locations.yml` | push to `master` touching the generator | regenerates location pages, commits, deploys |
| `deploy-worker.yml`   | push touching `visitor-alerts/worker.js` | uploads the Worker, preserving bindings |
| `deploy-portal.yml`   | push touching `case-portal/worker.js`   | tests, then uploads the portal Worker      |
| `site-health.yml`     | daily cron, 11:00 UTC                | probes the live domain; opens one issue on failure |

Every workflow carries a `concurrency` group. They were added after runs
collided: on 2026-08-07 five runs started in the same minute and two were
cancelled. Without the guards, a push that touches `build-locations.py` starts
one deploy of the *pre-rebuild* tree while `build-locations.yml` dispatches a
second deploy of the *rebuilt* tree — a race whose loser can publish stale
pages over fresh ones. Do not remove them.

## Generated files

`private-investigator/**` and `sitemap.xml` are **generated** by
`build-locations.py`. Edit the `PLACES` list in that script, not the HTML.
Pushing a change to the script makes CI regenerate, commit and deploy.

`build-locations.py` is the source of truth but the generated HTML is what is
committed and served, so the two can drift if you hand-edit the output. Run
`python3 build-locations.py` and check `git status` is clean before pushing.

Current output: a hub page plus 6 location pages (~98 KB total), 10 sitemap
URLs. The markets are Roanoke, Lynchburg, Charlottesville, Danville, Bedford
and Farmville — deliberately scoped to about an hour's drive. An earlier
version generated 27 near-duplicate city pages; that was consolidated on
purpose, so resist re-expanding it without a reason.

## CI pushes to master

`build-locations.yml` commits and pushes to `master` as `github-actions[bot]`.
If you pushed a generator change, your local clone is stale seconds later —
`git pull` before you push again or the push is rejected. This is the most
common source of an apparent "something else is editing the repo" conflict.

## Service pages

`infidelity-investigations/` and `child-custody-investigations/` are
hand-written pages for the two highest-intent searches. They are linked from
the services grid on the homepage with a "how we document it" call to action.

`insurance-investigations/` is the third, aimed at carriers, TPAs, self-insured
employers and defense firms rather than consumers. It is linked from the
homepage nav, the services grid, every location page and `_headers`. Its
`vendor-information/` subpage carries the firm identification a carrier's
onboarding form asks for.

**Nothing on that page or its subpage states a rate, a coverage limit, a tax
identifier or a policy number.** Carrier rates are quoted per assignment and
documents are issued on request, so there is no figure in the HTML that can go
stale or be quoted to the wrong carrier. Keep it that way.

The page's "Submit an Assignment" buttons point at `/intake/`, which is the
Secure Assignment Intake its copy describes — the carrier path issues a request
number immediately, exactly as promised there. `_redirects` also maps the older
`/insurance-investigations/submit/` URL to `/intake/`.

## Contact and intake

Both forms (homepage and `intake/`) post to Web3Forms. The access key lives in
the page source; it is a public key by design, but it is the only thing making
the forms deliver, so do not strip it.

**What the relay is allowed to see is a hard boundary.** Web3Forms is a third
party, so `intake/` sends it only a notice — case number, service, and the
contact's name, phone and email. The claimant, address, vehicle, alleged
injury, objective, claim and policy numbers and the signature go to the case
portal on our own Cloudflare account and nowhere else. `buildNotice()` is what
enforces that; do not widen it, and do not spread the full payload into the
notice. There is a test that fails if any of those values reaches the relay.

`intake/` is a single-file wizard with **three paths** off the service step:

- **Surveillance** — seven steps. An extra coverage step where the client buys
  a block of hours, then a Venmo or Cash App payment for that block.
- **Process serving** — six steps, ending in payment of the flat fee.
- **Carrier** — insurance claim assignment. Eight steps: an extra claim-details
  step (carrier/TPA, claim number, policy, claim type, date of loss, adjuster,
  defense counsel, prior surveillance), claimant-specific wording on the
  subject and scope steps, a scheduling-and-authorization step, carrier terms in
  place of the consumer agreement, and a billing step instead of payment.
  Nothing is charged at assignment.

  The authorization step offers 8 / 16 / 24 hours or custom — **hours, never a
  rate**, because that page is public. It also collects the not-to-exceed
  amount, start date, permitted days and times, weekend authorization, priority
  and geographic limits. Everything there except the not-to-exceed is
  allow-listed to investigators: they cannot work inside an authorization they
  cannot see, but a budget is commercial.

The step list is chosen by `steps()`; all three share the first two steps,
which is what makes switching service mid-flow safe. **No claims rate is
published in the form** — carrier work is invoiced per fee schedule and
confirmed in writing, so there is no number to get wrong or to leak. The
consumer blocks below are consumer pricing and must never appear on the claims
path.

## Carrier rates are internal — and this file is public-adjacent

The insurance rate strategy lives in `case-portal/PRICING.md`, with the
machine-readable copy as `RATES` in `case-portal/worker.js`. **Both are in
`case-portal/` deliberately** — that directory is excluded from the Pages
deploy, and it is the only safe home for anything internal.

`deploy.yml` rsyncs the repo root to Cloudflare Pages. `CLAUDE.md` was **not**
excluded until 2026-08-12, so this file was being served publicly. It is
excluded now, and the workflow fails the build if any markdown file is staged
for deploy. Do not put a rate, a negotiated discount or an internal note
anywhere the rsync can reach.

Carrier pricing is never published: not on `insurance-investigations/`, not on
the vendor page, not in the intake form. `/pricing` on the Worker is admin-only
and returns 403 to an investigator. The public language is "final rates and
authorization will be confirmed before the assignment is accepted."

Headline numbers: $150/hr standard, 8-hour minimum day, 24 hours ($3,600) as
the typical initial authorization, $135–$150 preferred-volume band, $125 floor.
The reasoning — including why $800/day is rejected for carrier work — is in
`PRICING.md`. Read it before quoting anything.

## The rate card

`PACKAGES` and `HOURLY` near the top of `intake/index.html` are **the only place
a price is set.** Change a number there and it changes the option the client
picks, the agreement they sign, the amount in the Venmo and Cash App deep links,
the printed sheet and what is recorded in the portal. Nothing downstream
hard-codes a figure, and a test fails if any block price appears anywhere else
in the file.

Current blocks: 4 hours $400, 8 hours $800, 16 hours $1,500, 24 hours $2,200,
with overage at $100/hr and never without the client's prior approval. These
replaced a $1,500 retainer plus $100/hr with a 4-hour minimum. `id` is what gets
stored, so keep an id stable once a real case has used it.

A block also sets `authorized_hours` on the stored case — deliberately, because
that is the one allow-listed field an investigator can see, and they need to
know the cap they are working to. The price fields (`package`, `package_price`,
`fee_due`) stay admin-only by default, which is the allow-list doing its job.

Tests, which intercept form delivery so a run never reaches the firm's inbox:

```bash
node intake/test-intake.mjs      # 105 checks; needs Playwright, skips cleanly without it
node visitor-alerts/test-worker.mjs   # 41 checks
```

Note the payment handles in `FIRM` are still personal accounts — the source
comment flags them to be swapped for business accounts before client use.

## The case portal

`/portal/` is the staff case system, backed by the `api-case-portal` Worker in
`case-portal/` and a D1 database. Setup is in `case-portal/README.md`.

Two roles. Admins see every case, assign work and manage accounts.
Investigators see **only** cases assigned to them — enforced in the SQL query,
not by the page hiding rows. Test that boundary if you touch the queries.

**An investigator is never sent the client.** They get the fieldwork — subject,
address, vehicle, restrictions, scope, authorized hours, deadline, notes — and
none of what identifies who is paying: the carrier, the adjuster and their
contact details, the claim and policy numbers, defense counsel, the billing
contact, the consumer client's own name and number, and the signature. An
investigator who leaves should not be leaving with the client list.

`FIELD_KEEP` in `case-portal/worker.js` is what enforces it, and it is an
**allow-list on purpose**: when the intake form gains a field it stays
admin-only until someone decides otherwise. A delete-list would leak every new
field by default. `redactRow` also drops the denormalised `carrier`,
`claim_number`, `client_name`, `client_email` and `client_phone` columns — a
claim number is the carrier's own reference and names them just as plainly.

This is enforced in the Worker, not the page. A field the page merely declines
to draw is still sitting in the browser's network tab. `portal/index.html`
carries a copy of `FIELD_KEEP` solely so the built-in example shows an
investigator the truth; a test compares the two lists and fails if they drift.

**Accounts exist only by invitation.** There is no public sign-up and no route
that creates an account directly — an admin issues a one-time link and the
invitee chooses their own password. Do not add a create-account endpoint.

It is a **separate Worker from `api-visitor-alerts` on purpose**: this one holds
claimant names, injuries, claim numbers and signature images; that one holds
anonymous counters. Do not merge them.

Things that are load-bearing:

- **The Worker must stay on `alwayspreciseinvestigations.net/portal-api/*`.** A
  session cookie set by a `workers.dev` hostname is cross-site and never sent
  back — Safari blocks third-party cookies outright. Moving it off the domain
  silently breaks every sign-in.
- **Case numbers are untrusted.** They come from a public form and are rendered
  in an admin's browser, so ingest pins them to `[A-Za-z0-9-]{3,64}` and the
  page passes them through `data-` attributes read by a delegated listener —
  never into an inline handler, where the browser decodes an escaped quote back
  into script. There is a regression test that plants a hostile row directly in
  the database.
- `case-portal/` is excluded from the Pages deploy in `deploy.yml`, the same way
  `visitor-alerts/` is. Worker source must not ship to the public site.
- `/portal/` is kept out of search by `noindex` plus an `X-Robots-Tag` in
  `_headers` — **not** by a `robots.txt` entry, which would only advertise it.
  The same rule already applies to `/watch/`.
- The intake posts to Web3Forms *and* the portal. Email is the client's
  confirmation path; the portal copy is fire-and-forget so an outage there can
  never lose a client.
- Nothing submitted before the ingest key was set exists in the portal.
  Submissions used to be emailed and nowhere else.
- Passwords are PBKDF2-SHA256 with the round count stored per user. Sessions are
  server-side, and the database holds only the SHA-256 of the cookie value.

Tests:

```bash
node case-portal/test-worker.mjs   # 152 checks: auth, invites, roles, redaction, rates, ingest
node portal/test-portal.mjs        # 93 checks: the page against the real Worker
```

The portal tests run the real page against the real Worker against real SQLite,
so they catch SQL and permission mistakes rather than mocking past them.

## The /watch/ dashboard

`watch/` is a private, passcode- and Face ID-gated dashboard showing live site
visitors, installable as a PWA. It is backed by the `api-visitor-alerts`
Worker in `visitor-alerts/` and is deliberately `noindex` and absent from
`robots.txt` — keep it that way. `beacon.js` on each page is what feeds it.
