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

When you need deploy or health status, do one of these instead:

- Pass `minimal_output: true`, and always set `per_page` to 5–10.
- Filter to what you actually want: `workflow_runs_filter: {status, event, branch}`,
  or scope to one workflow by passing `deploy.yml` as `resource_id`.
- For "did my push deploy?", check the commit status rather than listing runs.

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

`intake/` is a single-file wizard with **two paths** off the service step:

- **Consumer** — surveillance or process serving. Six steps, ends in a Venmo
  or Cash App payment for the retainer or flat fee.
- **Carrier** — insurance claim assignment. Seven steps: an extra claim-details
  step (carrier/TPA, claim number, policy, claim type, date of loss, adjuster,
  defense counsel, prior surveillance), claimant-specific wording on the
  subject and scope steps, carrier terms in place of the consumer agreement,
  and a billing step instead of payment. Nothing is charged at assignment.

The step list is chosen by `steps()`; both paths share the first two steps,
which is what makes switching service mid-flow safe. **No claims rate is
published in the form** — carrier work is invoiced per fee schedule and
confirmed in writing, so there is no number to get wrong or to leak.

Tests, which intercept form delivery so a run never reaches the firm's inbox:

```bash
node intake/test-intake.mjs      # needs Playwright; skips cleanly without it
node visitor-alerts/test-worker.mjs
```

Note the payment handles in `FIRM` are still personal accounts — the source
comment flags them to be swapped for business accounts before client use.

## The case portal

`/portal/` is the staff case system, backed by the `api-case-portal` Worker in
`case-portal/` and a D1 database. Setup is in `case-portal/README.md`.

Two roles. Admins see every case, assign work and manage accounts.
Investigators see **only** cases assigned to them — enforced in the SQL query,
not by the page hiding rows. Test that boundary if you touch the queries.

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
node case-portal/test-worker.mjs   # 79 checks: auth, invites, roles, ingest, origin
node portal/test-portal.mjs        # 35 checks: the page against the real Worker
```

The portal tests run the real page against the real Worker against real SQLite,
so they catch SQL and permission mistakes rather than mocking past them.

## The /watch/ dashboard

`watch/` is a private, passcode- and Face ID-gated dashboard showing live site
visitors, installable as a PWA. It is backed by the `api-visitor-alerts`
Worker in `visitor-alerts/` and is deliberately `noindex` and absent from
`robots.txt` — keep it that way. `beacon.js` on each page is what feeds it.
