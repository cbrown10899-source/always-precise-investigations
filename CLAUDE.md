# Always Precise Investigations — working notes

Static marketing site for Always Precise Investigations, LLC (Virginia PI firm).
No build step, no dependencies. Cloudflare Pages serves the repo root.

Live: https://alwayspreciseinvestigations.net

## Orchestration workflow

When the session's main model is **Fable 5**, it is the orchestrator: plan,
decompose, delegate, synthesize, keep its own context lean.

| Work | Goes to |
| --- | --- |
| Architecture, schema/migration design, non-obvious debugging, security and data-boundary questions, "is this requirement actually met?" | `deep-reasoner` (Opus) |
| Suites, greps and inventories, applying a decided change, docs and ledgers, test scaffolding | `fast-worker` (Sonnet) |
| A second independent take on a hard call | Codex (`/codex:rescue --background`) — **a peer, not a reviewer** |

**High-stakes decisions:** put Opus and Codex on the same problem in parallel,
**neither shown the other's answer**, then synthesize. Two independent
derivations that agree is evidence; one answer reviewed by a second model is
mostly agreement bias.

Both subagent definitions live in `.claude/agents/`. They are pinned to their
models there, so `Agent(subagent_type: "deep-reasoner")` needs no `model`
override.

### What NOT to fan out on, in this repo specifically

The portal is essentially **three enormous files** — `case-portal/worker.js`,
`portal/index.html`, and their two suites. Parallel agents editing any one of
them will clobber each other, and the loser fails silently because a
`str.replace` that matches nothing still writes the file.

So: **fan out on reading, serialize on writing.** Auditing, inventorying,
tracing a boundary across the codebase — parallel, and the natural fit for
this project's recurring "verify every requirement" work. Editing the same
file — one agent at a time, or one agent for the whole file.

`portal/test-portal.mjs` is Playwright and slow; it is worth handing to
`fast-worker` while reasoning continues elsewhere, but two agents must not run
it at once — they bind the same port.

### The rule that outranks the workflow

A subagent's report is a claim, not a fact. When one says a thing is done,
the orchestrator wants the route, the table, the control and the test — the
same evidence standard `RECONCILIATION.md` was written to enforce. Do not
relay a subagent's conclusion to the owner as verified unless it came with
that evidence, and do not let delegation become a way for an unchecked claim
to reach them wearing a confident voice.

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

## What reaches the public site — an allow-list, not an exclude list

`.github/deploy-manifest.txt` holds **file patterns** for everything that is
site content. `.github/stage-site.mjs` matches them against the repository and
builds `_site/` from the files that match, and `deploy.yml` runs that script.
**A file that matches no pattern is not deployed** — a new handoff note, agent
definition or tooling file cannot reach the internet by being added to the
repo, and cannot break the deploy either.

**The patterns are file-level on purpose.** The first version of this list named
directories and copied them whole, which is default-deny at the top level and
default-**allow** inside anything listed: `portal/` was allowed, so
`portal/anything.txt` would have shipped. That is the same hole one level down,
and the comment above it claimed otherwise. Name files, use `*` and `**`, and
do not reintroduce a bare directory entry — a test fails if one appears.

This replaced a list of `rsync --exclude` flags, and the reason is worth
keeping: with excludes, everything was public **by default**, and the only
thing between a new file and the internet was a guard that failed the whole
build. On 2026-08-14 `.claude/agents/*.md` arrived, the markdown guard
correctly refused it, and **the public site stopped deploying for four merges
while `deploy-portal.yml` kept shipping the Worker** — so the portal moved and
the website did not, with nothing saying so. A red workflow nobody reads is the
same as no workflow. The guard was right; the list was wrong.

Adding a page means adding its path to the manifest, or it will not be
published. The stager **fails if a listed path is missing**, so a renamed
directory is caught at build time instead of by someone finding a 404 later.

```bash
node .github/test-deploy.mjs   # 68 checks: what may and may not be published
```

It runs the real stager and asserts both halves — that the site is complete,
and that `.claude/**`, `case-portal/**`, every `.md`, every `.mjs`, the schema
and the generator stay out. One check plants a file in the repo root and an
agent definition in `.claude/agents/` and proves they are ignored **without
failing the build**, which is the incident itself.

`/.well-known/build.txt` carries the deployed short SHA and build time, so
"is the site actually current?" is one request rather than a guess.

## Deploy topology

Nine workflows, all in `.github/workflows/`:

| Workflow              | Trigger                              | Does                                       |
| --------------------- | ------------------------------------ | ------------------------------------------ |
| `deploy.yml`          | any push to `master`                 | rsyncs the site to Cloudflare Pages        |
| `build-locations.yml` | push to `master` touching the generator | regenerates location pages, commits, deploys |
| `deploy-worker.yml`   | push touching `visitor-alerts/worker.js` | uploads the Worker, preserving bindings |
| `deploy-portal.yml`   | push touching `case-portal/worker.js`   | tests, then uploads the portal Worker      |
| `site-health.yml`     | daily cron, 11:00 UTC                | probes the live domain; opens one issue on failure |
| `portal-setup.yml`    | manual dispatch                      | one-shot Cloudflare setup for the portal   |
| `r2-setup.yml`        | manual dispatch                      | probes the token for R2, creates the private evidence bucket |
| `save-point.yml`      | human push to `master`, or manual    | tags a `save/…` point and cuts a Release   |
| `harden-check.yml`    | manual, plus weekly Monday 11:30 UTC | runs `verify.sh` live-site security checks |

Every workflow carries a `concurrency` group. They were added after runs
collided: on 2026-08-07 five runs started in the same minute and two were
cancelled. Without the guards, a push that touches `build-locations.py` starts
one deploy of the *pre-rebuild* tree while `build-locations.yml` dispatches a
second deploy of the *rebuilt* tree — a race whose loser can publish stale
pages over fresh ones. Do not remove them.

## Save points and rollback

Work that exists only inside a session's container dies with the container —
that is how the insurance build was nearly lost once. Two rules and one
mechanism keep a point of return at all times:

- **Push after every milestone.** Commit and push to the working branch as each
  substantive piece lands, not at the end. An unpushed tree is one crash from
  gone; scratchpad files doubly so.
- **Master is the recovery line.** Everything merged is on GitHub — the
  off-site copy — and `save-point.yml` names each human merge as a tag
  (`save/<date>-<sha>`) with a GitHub Release. The Release's auto-attached
  *Source code (zip)* is the desktop copy: Releases page → download. Manual
  runs of the workflow are the "save now" button.
- **Rollback:** `git revert <bad-sha>` and push for one bad change (the deploy
  workflow republishes the site); `git checkout -B master save/<tag>` and a
  `--force-with-lease` push to return the whole tree to a save point.

**The case database is not in git, on purpose** — claimant names and signatures
must not land in a repo. Its point of return is Cloudflare **D1 Time Travel**,
which keeps 30 days of automatic history; commands are in
`case-portal/README.md`. A repo save point plus a Time Travel restore together
recover the whole system to a moment.

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

**A carrier must never be shown the consumer side.** Every "Submit an Assignment"
button on the insurance pages, and the `/insurance-investigations/submit/`
redirect, points at **`/intake/?assignment=insurance`** — the carrier door. It
fixes the service to a claim assignment, drops the service picker from the flow
entirely, retitles the page "Secure Assignment Intake", and asks an adjuster for
their title and organization type instead of a mailing address and the best time
to reach them. Landing an adjuster on the shared picker offers them domestic
surveillance with a private-client price beside it.

Bare `/intake/` is unchanged and still offers all three services, for anyone who
did not arrive via the insurance pages. There is a test that fails if a bare
`/intake/` link reappears on a carrier page.

**`/intake/?assignment=private` is the mirror door** — what the private rate
sheet emails. The service step stays (a private client still chooses between
surveillance and process serving) but the carrier path is not offered, and
`pickSvc` refuses it even called directly. `SHEET_INTAKE` in the Worker pairs
each sheet to its door server-side; the page only ever says *whether* to
include a link, never which one.

Known limit: the consumer step markup still sits in the shared file's `<script>`,
so it is in View Source even though no carrier-facing screen renders it. The
tests assert what an adjuster *sees*. Removing it from the source means splitting
the form into two pages that share plumbing — a structural change nobody has
asked for yet.

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

**A field's value and its availability are separate things** (INTAKE-NA.md).
Almost nothing is required: contact name, one contact method, the service, the
carrier on the claims path, a claimant name *or* a claim number so the file can
be identified, and a one-line objective. Everything else — claim number, date
of loss, address, vehicle, start date, billing contact, the authorization
itself — can be marked "I don't have this information right now", which
disables the input and writes `<field>_status` beside an **empty** value.
**Never write "N/A", "Unknown", 0000 or a placeholder date into a data field**;
a test scans every value field for exactly those and fails. Statuses are the
one place unavailability is spelled out, and `FIELD_KEEP` carries only the
FIELD-side ones — an investigator is told the address is not known yet, never
whether the carrier's claim number exists.

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

Headline numbers: $150/hr standard, 8-hour minimum day, $135–$150
preferred-volume band, $125 floor. The flat-fee ladder a carrier is quoted is
**$1,200 / $2,300 / $3,300** for 8 / 16 / 24 hours, with overage at $150/hr and
never without written approval. Those hours match the authorization presets on
the intake form.

**`RATES.packages` is guarded.** A test fails if any block falls below the $125
floor, and the floor is written out separately in the test so lowering it takes
a deliberate edit in two places. That guard is there because a bad price does
not look like one: $1,000 / $1,800 / $2,600 reads like sensible round numbers
and is $125.00 / $112.50 / $108.33 an hour.

**No additional fees, on both sides of the business.** The quoted price is the
invoiced price — mileage, travel time, tolls, parking, database and record fees,
video review and report preparation are all inside the block, never added
afterwards. This is written into the signed terms on the carrier path *and* the
private-client path, so it is a promise to clients, not an internal setting: do
not reintroduce expense billing without changing `intake/index.html` at the same
time. The one carve-out is the one already published — travel for an assignment
outside the service area is quoted and agreed before acceptance.

A second test checks the ladder still clears the floor *after* absorbing about
60 miles a day, because an all-in price is only affordable if it was priced for
it. The three-day block lands near $132/hr; the rejected $2,600 draft would land
near $103.

The reasoning — including why $800/day is rejected for carrier work — is in
`PRICING.md`. Read it before quoting anything.

## No price appears on the public site

**The intake form quotes nothing and charges nothing.** There is no rate card,
no package step and no payment step on it any more, on either path. A test fails
if a dollar figure appears anywhere in `intake/index.html`, and another checks
the homepage, both insurance pages and the two service pages.

Pricing lives in the portal as two rate sheets an admin opens and emails
(`rateSheets()` in `case-portal/worker.js`):

- **`private_retainer` ("$1,500 Retainer")** — private clients. The retainer is a
  deposit applied to work billed at $100/hr, 4-hour minimum. `PERSONAL` in the
  Worker sets it.
- **`insurance_assignment` ("Insurance Assignment Rates")** — carriers. The
  `RATES.packages` ladder, package/authorization-based. The two sheets are
  separate products (see `case-portal/RATESHEETS.md`): separate config,
  separate copy, never combined, and neither shows internal strategy.

`GET /sheets` and `POST /sheets/:id/email` are admin-only; an investigator gets
403 from both, and from `/pricing`. Sending goes through `sendMail()`, the same
Resend path the invitations use, and never throws — a provider outage costs a
copy-and-paste, not a lost quote.

The consumer flow therefore ends at the **agreement**, not a payment: submitting
records the case, the office reads it and sends the sheet, and work starts once
the client agrees. The terms say exactly that.

## The dashboard

`summaryCards()` draws an alerts strip above the case list, built to answer
"what needs my attention today": Open cases, Needs assignment, Out now (a day
running), Reports due (finished day with no report, or a report waiting on
review), Authorization low (past the first configured threshold). Cards with
work behind them are **clickable** — `/summary` returns the case numbers behind
each count, and clicking filters the list to exactly those cases, with a chip
to clear. Carrier/private counts live in the Cases bar as text. Cards whose
data does not exist yet (client responses, expenses, closure) are deliberately
absent until their features land — no fake zeros. Scoped per role as always:
an investigator's alerts are their own cases and days.

**It draws even when there are no cases**, and on an empty portal the worked
example is shown unasked so the cards are not all zero and a new admin can see
the shape of the thing. The banner says the totals include the example. There is
one Hide button, over the case list — not two.

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
node intake/test-intake.mjs      # 205 checks; needs Playwright, skips cleanly without it
node visitor-alerts/test-worker.mjs   # 47 checks
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
  The same rule already applies to `/watch/`. And robots.txt must not even
  *mention* either of them: it once carried a comment explaining this very
  policy, which announced their existence in a public file. The live check
  (`verify.sh`, run by `harden-check.yml`) fails on the word "portal" appearing
  in robots.txt at all, comments included — the explanation lives here instead.
- The intake posts to Web3Forms *and* the portal. Email is the client's
  confirmation path; the portal copy is fire-and-forget so an outage there can
  never lose a client.
- Nothing submitted before the ingest key was set exists in the portal.
  Submissions used to be emailed and nowhere else.
- Passwords are PBKDF2-SHA256 with the round count stored per user. Sessions are
  server-side, and the database holds only the SHA-256 of the cookie value.

Tests:

```bash
node case-portal/test-worker.mjs   # 986 checks: auth, invites, roles, redaction, rates, ingest
node portal/test-portal.mjs        # 785 checks: the page against the real Worker
```

The portal tests run the real page against the real Worker against real SQLite,
so they catch SQL and permission mistakes rather than mocking past them.

## The client package

The Package tab builds what the client actually receives. Four things about it
are load-bearing:

**A case is not a day.** A surveillance case runs three days and approves three
daily reports. `case_builds.report_id` holds exactly one, so a package built
from it shipped the *last* day and dropped the rest without a word.
`build_reports` is the ordered set the package carries — every approved day,
oldest first, because that is the order Day 1 / Day 2 / Day 3 has to read in.
A day approved after the build was opened appears as an offer, never silently.
`report_id` still exists and still points at a report that is in the package,
so older single-report reads keep working; do not delete it.

**The Combined Summary is two halves on purpose.** The facts — days, span,
hours, miles, exhibit counts — are derived when the document renders and are
never stored, so adding a day cannot leave a stale sentence behind. The
paragraph above them is the admin's own, in `build_summary`. Nothing writes
narrative prose on their behalf, and nothing should start.

**`custom` is a marker, not an enum value.** `case_builds.package_type` carries
a CHECK constraint. Widening a CHECK in SQLite means rebuilding the table,
which `schema.sql` — re-applied on every `portal-setup` run — cannot do
idempotently. Editing the constraint in place would leave a **fresh** database
able to store `custom` while the **live** one, created before the edit, still
refused it: a divergence that passes every test and fails only in production.
So Custom lives in `build_custom` and stores `full` underneath. The same
reasoning already produced `activity_removed`; reach for a side table, not an
`ALTER TABLE`.

Custom skips the type-based video gate and **only** that one. It means "the
admin chose the contents", not "anything may ship" — material marked needs
redaction, internal only or do not use is still refused by name.

**The document holds no copy of anything.** Every image points at the original
evidence route; building, printing and finalizing touch `build_*` tables only.
Original evidence must never be overwritten by a report copy or a thumbnail.

**The classification is checked where the material LEAVES, not only where it is
approved.** The finalize gate runs once, at finalize; holding something back
afterwards has to reach a package that is already finalized. So the document
renders only currently-deliverable evidence and names what it withheld, the
gate strip stays visible on a finalized build, printing re-reads the package
first (a stale tab would otherwise print the copy it drew before the change),
and a delivery link is offered only while its evidence is **in the package and
still cleared to ship** — on the package panel and on `/completed` alike.
Reclassifying a finalized package's material is deliberately still allowed:
refusing it would preserve the unsafe classification at exactly the moment
someone is trying to withdraw it. Do not "simplify" any of these back to a
single check at finalize.

**Nothing about withheld material may sit inside `#pkgdoc`.** The print
stylesheet makes only `#pkgdoc` visible, so everything in it is the client's
document — and a *count* of withheld exhibits announces that evidence exists
which was classified internal only, needs redaction or do not use. The first
version of this fix put the notice there and disclosed exactly what the
classification withholds. The office is told on the package screen
(`pkgWithheldNote()`, outside the printed region); the document prints the
deliverable material with contiguous numbering and explains no gap. Tests
assert structurally that no gate strip lives inside `#pkgdoc`, so the guard
survives a rewording.

## Invoices

Money is arithmetic here, never a stored flag. Totals come from the lines and
the payments on every read; `paid` is what a zero balance means, not a button;
and **`overdue` is computed against today** so it cannot go stale, is never
shown on a draft, and never on a void.

The same rule now covers the private retainer. **Amount applied is summed
across every live invoice on the case**, not just the one on screen —
otherwise a second invoice reads as though the first never happened — and
voiding one releases what it consumed. Additional authorization is
`case_meta.authorized_budget`, and only when it is genuinely above the
retainer. A negative balance is not an error: it prints as "Beyond the
retainer", which is when the office most needs to see it.

Sent to BILL is not paid. BILL collects; the portal stays the operational
record, and nothing about a case depends on BILL existing.

**Write-Off is deliberately absent.** MASTER §28 says "if needed later" and the
owner's own status list agrees. When it is wanted it goes in as a side table —
`invoices.status` carries a CHECK constraint, and see the `custom` note above
for why that is not something to edit in place.

## The free-plan failsafe

The owner runs Cloudflare on free tiers and wants zero possibility of a
charge. Cloudflare has no spend cap, so **the Worker is the cap**: evidence
uploads are refused at 9 GB of the 10 GB R2 free tier (507, `storage_cap`),
at 75 MB per file, and at 50k uploads/month. The meter is
`SUM(size_bytes) WHERE deleted_at IS NULL` in `case_evidence` — computed,
never stored. The admin dashboard's Storage card warns at 75%, and
`site-health.yml` opens a single GitHub issue when `/portal-api/health`'s
`storage_pct` (a bare number, deliberately public) crosses 75. Limits are
env-overridable (`STORAGE_HARD_CAP` etc.) so the tests exercise the
refusals with real uploads. Do not raise the caps without the owner.
A Cloudflare-side Budget Alert ($10 → owner's email) exists as the
independent second net; it alerts, it cannot block.

## Active Surveillance Mode

`SV` in `portal/index.html` is the field view: a dark, one-handed, full-screen
mode reached from a button on the assignment or from `/portal/?surveillance=1`
(the PWA start URL, `portal/manifest.webmanifest`, "API Surveillance").

**It is a VIEW of the case, and there must never be a surveillance table.**
Every write goes through routes that already existed — `day/start`, `day/end`,
`activity`, `evidence` — so leaving the mode leaves the work in the ordinary
portal. Only two routes were added, and neither stores anything: `/my/active`
(is a day running, else what could start one) and `/active` (admin: who is out).

**The timer derives from the server.** `case_days.created_at` is the instant
the day was recorded; the page measures its skew against the Worker's
`server_now` once and computes elapsed from timestamps. It never counts ticks,
so a reload, a sleeping phone or a wrong device clock cannot move it — there is
a test that reloads mid-day and asserts the clock did not restart. The
investigator's own `start_time` stays what the day's hours are computed from.

**Pausing obeys the same rule.** A break is a SPAN recorded server-side in
`case_day_pauses`, and elapsed is `(now - started) - the closed spans`. While a
pause is open the page substitutes the server's `paused_at` for `now`, so the
display freezes without anything here stopping a tick — and it is still frozen,
on the same number, after a reload. One open pause per day is enforced by a
partial unique index, not by a check in the route, so two taps on a flaky
connection cannot open two. **Breaks come off the billable total**: `hours` is
what authorization and invoices draw against, so it is the WORKED figure, and
the day-end message names the break that was subtracted rather than quietly
returning a shorter day.

**The phone's bottom bars must clear the screen edge.** Both the case section
bar and the field bar are `position:fixed; bottom:0`, and both used to sit
flush against it. `env(safe-area-inset-bottom)` reports **zero** on iOS unless
the viewport meta carries `viewport-fit=cover`, which this page deliberately
does not — so `calc(6px + env(...))` added nothing and the buttons landed on
the home indicator, where a thumb cannot reach cleanly. Both now use
`max(14px, env(safe-area-inset-bottom))`, which is correct in either mode and
needs no viewport change. Targets are `min-height` 52/50px — Apple's minimum is
44 — and a test measures both the height and the gap rather than trusting how
it looks. Do not go back to `calc()`.

**The field view has a top-level door.** `svLaunchButton()` used to render only
inside a case's Overview tab, so on an iPad you had to open Cases, open a case
and land on Overview before any way in existed — and `?surveillance=1` assumes
the icon is already on the home screen. Both roles now carry an **Active
surveillance** item in the navigation that opens the same launcher, and a test
asserts it at iPad and phone widths. Do not remove it in favour of the
case-level button; that button is the shortcut, not the door.

**An entry can be removed but never erased** (owner, 2026-08-14). `activity_removed`
is a companion table — not columns on `activity_log`, because `schema.sql` is
re-applied on every portal-setup run and `ALTER TABLE ADD COLUMN` is not
idempotent. A removed entry still comes back from the workspace, stamped with
who removed it and when; the page strikes it through and offers to put it back,
and the report and package skip it. Evidence has always worked this way.

**Field uploads are client-deliverable by default** (owner, 2026-08-14). The
firm shoots its own footage and writes its own reports, so nothing waits behind
a review it would only give itself. The classifications all still exist —
Needs redaction, Internal only, Do not use are how you deliberately HOLD
something back, and the Case Build gate still refuses those. If outside
investigators are ever engaged, flip the default in `addEvidence` and the
review gate returns.

Two rules worth keeping: **Out now carries no location** — no GPS in this
phase, and a test asserts the payload has none — and **nothing spoken is ever
auto-submitted**; the transcript is shown for review and only Use Text turns it
into an entry. The privacy wording says only what is verifiable ("this page
keeps no audio"), never the mockup's "never stored".

## The /watch/ dashboard

`watch/` is a private, passcode- and Face ID-gated dashboard showing live site
visitors, installable as a PWA. It is backed by the `api-visitor-alerts`
Worker in `visitor-alerts/` and is deliberately `noindex` and absent from
`robots.txt` — keep it that way. `beacon.js` on each page is what feeds it.
