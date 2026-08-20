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

## The legal intake is the private pricing path wearing a firm's name

Unit 6 (owner brief verbatim in `case-portal/LEGAL-INTAKE.md`, derived
decisions listed there one per entry). The three intake businesses are
**Private / Insurance / Legal**, and legal rests on two structural choices:

**A legal case IS `kind='consumer'`.** The `kind` CHECK cannot widen
idempotently, and it should not: consumer typing is what makes the pricing
rule structural rather than synchronised — `agreedRetainer()`,
`case_retainer`, the private sheet and the invoice retainer block all key off
consumer, so Legal reflects Private pricing because it IS the private pricing
path. The marker of record is `payload.assignment === 'legal'` on the
submission's own row (`isLegalSub()`, the one reader — never inferred from a
recipient, an address, or the table's presence); the `legal_intake` companion
table carries the structured firm/attorney/paralegal/billing/matter detail,
guarded through `missingTables()`, swept by `DEMO_SWEEP`.

**Cash App and Venmo reach a law firm through no code path.**
`SEND_CONTEXT.LEGAL` joins the model and `CONTEXT_TAKES_PAYMENT` stays
`=== PRIVATE` — the same shape that protects carriers. A legal case takes the
private SHEET (same figures, one source) in the LEGAL context; the payment
block is refused on it by name, `/payment-options/email` refuses it in words,
and the response's `send_context` states the case's real context (it briefly
said "private" about a legal send until the suite caught it). The legal
payment ARRANGEMENTS — BILL.com invoice/ACH, check pick-up, check by mail,
existing billing — are a **request, never a payment**: they live on the legal
row, `check_pickup` reads as *Awaiting pickup* everywhere, and nothing about
them touches `retainer_payment`.

**The firm is who is paying**, so an investigator is never sent it: no
`WS.legal`, no `legal_*` list columns (stripped in `redactRow`), no Legal tab
— while the LEGAL badge itself is a category fact like `kind` and survives.
The subject still reaches the field.

**Doors**: `?assignment=legal` is the public door (picker dropped, retitled
"Legal Investigation Assignment"); bare `/intake/` offers all three; the
private door refuses `legal` in `pickSvc` like it refuses `claims`. **Quick
Legal Assignment** is `createManualIntake` with `kind:'legal'` — firm OR
attorney is the one hard requirement, and the agreed retainer goes through the
existing `/cases/:no/retainer` writer. `POST /cases/:no/legal` edits the panel
under the `/meta` rules (absent unchanged, blank clears, resolved in the
statement) and backfills the row for intakes that arrived before portal-setup.

**Documents attach after acceptance** through the existing authenticated
case-media upload — the public form grew no upload door, and says so.

**Adding this table means a manual `portal-setup.yml` dispatch after merge.**

## A profile is a default; a case is a snapshot

Unit 7 (owner brief verbatim in `case-portal/PROFILES.md`, derived decisions
listed there one per entry). Saved **Clients & Firms** — law firm, insurance
organization, private client — so a repeat assignment starts prefilled instead
of retyped.

**The architecture is one sentence:** prefill copies profile values into the
assignment form, `createManualIntake` writes the case from that **body** exactly
as it always did, and no case read joins a profile. So *"editing a firm must not
rewrite prior cases"* is a property of the shape rather than a rule someone has
to remember — there is no code path by which it could. The suite proves it the
only way worth proving it: create a case from a firm, rename the firm, read both
stored copies of the case back byte for byte.

Four additive tables. `profile` is the org **or** the person — one `name`
column, so the directory, the picker and the duplicate check all search one
place; a private client needs no contact row. `profile_contact` keeps first and
last names apart (never concatenated, and nothing stores a composed display
string to drift). `profile_phone` is the `case_phone` pattern — one row per
number, label, number as typed — plus a stored `digits` key, because phone
search must match `(540) 555-1212` against `5405551212` and D1 has no regex.
`case_profile` is the **one** link, keyed by `case_no`.

**`kind` carries no CHECK.** `submissions.kind` is this project's own proof of
the cost — it could not widen for Legal, so a legal case is `consumer` plus a
payload marker. A fourth client category must be an ordinary Worker edit. The
roles differ *by kind* anyway, which a single-column CHECK could not express at
all. `kind` is also immutable after creation: a firm with history is never
re-typed into a private client.

**There is no merge, and that is the absence of code rather than a guard.** No
upsert, no `merged_into`, no routine that writes submitted values into an
existing profile. A possible match **refuses the write** and names what it
matched; *Continue as new* is a second request. Normalisation is deliberately
not clever — no stripping of LLC/PC/Group, no St→Street, no Gmail-dot removal,
because each of those is inference dressed as tidying and is exactly how "Smith
Law" and "Smith Law Group" would become one key. Inactive profiles stay inside
duplicate detection: skipping them manufactures the duplicate the check exists
to prevent.

**No figure lives on a profile.** No retainer, rate, matter number or billing
reference — `agreedRetainer()`, `PERSONAL` and `RATES` stay the only pricing
sources, so nothing can freeze a price into a firm. The one commercial default
is the legal payment **arrangement**, law-firm only, validated against the same
`LEGAL_ARRANGEMENTS` the case panel uses: a request, never a payment, and no
profile read touches `retainer_payment` or `case_retainer`.

**Delete refuses a profile any case has ever used** (409 naming the count,
offering Inactive). That refusal is what makes "never cascades to cases"
structural: the only deletable profile is one nothing points at.

**The link route is `POST /cases/:no/profile` on purpose** — the router's
deleted/archived chokepoint matches any non-GET under `/cases|submissions|leads/:no/`,
so it inherits the gate. A route named `/profiles/:id/cases` with the case
number in its body would be invisible to it, which is the `caseSendRefusal()`
trap already paid for once. `case_profile` is in `DEMO_SWEEP`; the three
reference tables deliberately are not — a link is case data, a firm is not.

**Admin-only at every door, and the public side has none.** The ingest reads no
profile table, so a submitted payload naming a `profile_id` links nothing
(asserted). `WS.profile` is admin-gated like `WS.legal`; the case list gained no
profile columns; investigators get no directory, no picker, no chip.

**A match is computed when an admin asks, never when they open a case.** The
first build ran the whole duplicate check inside the case workspace read — four
profile-table reads on the most-opened screen in the portal, billed per row
read, for a question nobody had asked, behind a comment claiming they had.
**Look for a match** is a button, and `GET /cases/:no/profile-match` is what it
calls. The comparisons that DO run unasked (name, address, phone equality) are
indexed lookups; the substring search is not, and `PROFILES.md` says so rather
than claiming otherwise.

**No statement may grow with the customer's data.** The search once built one
query with up to 401 bound parameters — D1 caps them, `node:sqlite` does not,
so it was green in every test and broken only in production. `CANDIDATE_CAP`
and `PAGE_CAP` bound it and a test counts the widest bind. The same class of
mistake as the `client_token` column that never reached the live database.

Four page and data bugs this unit found, all familiar shapes: the quick-intake
form was uncontrolled, so the repaint after choosing a profile would have
discarded whatever was typed and submitted the empty value while reporting
success (it holds a draft now — the `EDIT_DRAFT` rule); the directory only
fetched when it had never loaded, so a firm saved from a case was missing from
the screen whose whole job is answering "do we already have them?"; the contact
`<select>` was **inert**, because the page had no `change` listener at all — it
rendered, it looked right, and choosing a different attorney did nothing (a
control that draws is not a control that works, the Timestamp Video lesson at a
different layer); and removing a contact blanked a case's record of who it was
started from while the screen said "no case changed", so the link carries
`contact_name` now — provenance is a snapshot like the rest of the case.

**Adding these tables means a manual `portal-setup.yml` dispatch after merge.**

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
  Worker sets the **standard** figure, and it is only a starting point:
  `case_retainer.retainer_amount` holds what a particular client actually
  agreed, an admin picks it from $1,500 / $2,000 / $3,000 / Custom on the
  private send wizard, and `agreedRetainer()` is the single read that feeds the
  sheet, the subject line, the payment block and the preview. **The rate and the
  4-hour minimum are not per-case** — only the retainer is. A retainer of zero
  is refused, because `rateSheets()` falls back to the standard for anything not
  above zero and the record would then disagree with the client's own sheet.

  Two rules hold this together and are easy to break by accident. **An absent
  field means unchanged, in both columns:** posting only an amount must not
  un-receive a paid retainer, and posting only a receipt must not reset the
  agreed figure. And **an untouched selector writes nothing** — opened from Rate
  sheets there is no case number yet, so it shows the standard figure, and
  saving that would re-cut a client's retainer as a side effect of previewing an
  email.
- **`insurance_assignment` ("Insurance Assignment Rates")** — carriers. The
  `RATES.packages` ladder, package/authorization-based. The two sheets are
  separate products (see `case-portal/RATESHEETS.md`): separate config,
  separate copy, never combined, and neither shows internal strategy.

**Payment instructions can also go on their own.** `POST /payment-options/email`
sends the PAYMENT OPTIONS block with no rate sheet and no intake attached, from
a **Send payment options** action on a private lead card — so instructions can
follow later without resending the sheet, which a client would reasonably read
as the terms having changed. Three rules hold it: a **claims case is refused by
name** (never quietly emptied); **nothing about it marks the retainer paid**
(`payment_send` records that the firm asked, `retainer_payment` records arrival,
and they are separate tables so no later edit can confuse them); and **the lead
is not stamped**, because none of the nine §5 lead statuses describes a payment
and moving it would write an event that did not happen. The email reuses
`paymentBlockText/Html` rather than restating them — two renderings of the same
instructions drift, and the one that drifts is the one nobody is looking at.

**Every send works before a case exists** (owner, 2026-08-15 — a blocking
workflow defect). Private Intake, Private Rate Sheet, Private Payment Options,
Insurance Intake and Insurance Rate Sheet all send on **a name and a valid email
alone**; case number, claim number and internal reference are optional whenever
they happen to be available, and **nothing is auto-created** to have something to
send against.

The API mostly did not require a case — **the doors did.** The intake and the
payment options could only be reached from a lead card, so someone had to be on
the desk before the office could email them anything, and the intake is what
turns a phone call into a lead. `POST /intake-link/email` is the pre-case route,
`Send to someone new` on Rate sheets is the door, and `GET /sends` is the
history: every other view of a send hangs off a case, so a pre-case send was
being written correctly and was then invisible.

**What the separation rests on, now that a case lookup may find nothing:** the
carrier sheet can never carry payment options at all (`sheetTakesPayment`); a
reference that *does* resolve to a claim assignment is still refused both the
consumer sheet and the payment instructions; and the pre-case intake door is
paired from an **explicit `kind`**, never from a lookup. Resting it on the
product being sent is stronger than resting it on a case that may not exist.

## The send context — never guess a recipient's type from their email

**Every outgoing send is PRIVATE or INSURANCE, and which one is decided by WHAT
IS BEING SENT — never by who it is going to.** `SEND_CONTEXT`, `SHEET_CONTEXT`
and `KIND_CONTEXT` in `case-portal/worker.js` are the whole model, and
`CONTEXT_TAKES_PAYMENT` is the entire payment boundary: Cash App and Venmo can
only ever attach to a private context. Each send route returns its
`send_context` so it is observable and asserted rather than believed.

**This replaced `recipientIsCarrier()`, and the reason is worth keeping.** That
function tried to classify the *recipient* by comparing their email address
against stored carrier contacts. It produced **four defects in four review
rounds**, in both directions:

1. it matched **substrings**, so a private client at `jane@example.com` was
   refused because an unrelated claims payload held `mary.jane@example.com`;
2. it matched addresses quoted in **free-text notes**, blocklisting people who
   were merely mentioned;
3. it **failed open** on stored addresses carrying whitespace;
4. and it still failed open on **non-breaking** whitespace after that was fixed —
   the exact paste-from-Outlook case the fix was written for.

Each fix narrowed the string comparison and the next round found another way for
a string comparison to be wrong. **Do not reintroduce inference of any kind
here.** If durable recipient classification is ever genuinely needed, it goes in
as an explicit typed field or a companion table under the usual migration rules —
not as matching against an address.

**Reading `submissions.kind` is not inference** and is still done: it is a typed
column with a CHECK constraint, so the record is stating what it is. A case
reference that resolves to a claim assignment is still refused the consumer
sheet and the payment instructions. A reference that is mistyped or absent now
changes nothing about what may be attached — only what the subject line says.

The tests assert the property that matters: **the recipient's address makes no
difference at all**. Casing, leading and trailing spaces, non-breaking and
zero-width spaces, an address that is a substring of a carrier's and one that a
carrier's is a substring of, and two same-named contacts on opposite sides — all
of them previously changed the outcome, and none of them does now.

**`send_log.case_no` is null unless the case actually exists.** The `case_no` on
a sheet send is optional and unvalidated — free text the office wrote down,
which reaches the **subject line** and nothing else. It was also being written
straight into `send_log.case_no`, and that column means something narrower:
the schema says *"null when a sheet is sent with no case"*, and every
case-scoped read (`send_count` and `last_sent_at` on the case list, a case's own
send history) matches on it. So a reference sat in the log until a real case of
the same name appeared and adopted it — a client credited with a send they never
received. `emailSheet` now records the case number only where the lookup it
already performs finds a case, on the success and the failure path alike. The
reference is unchanged in the subject; nothing about what is sent moved.

**Its sibling `payment_send.case_no` follows the same rule**, from both writers:
the standalone `/payment-options/email` and the copy that rides with a rate
sheet, each on its success and its failure path — four writes, and the kind of
set where one gets fixed and the rest are forgotten. That column says "null when
sent with no case or lead" and the table is indexed on `(case_no, id DESC)`,
which exists for a case-scoped read. Nothing reads it that way yet, so unlike
`send_log` it was misattributing nothing — it was the same shape that would, the
moment such a read was added. `emailPaymentOptions` reuses the lookup RULE 1
already performs, so nothing extra is queried and a claims case is still refused
before it can be recorded at all.

**A failed history load is never rendered as an empty history.** `loadSends()`
used to set `SENDS = []` in its catch, and an empty list draws as "Nothing sent
yet" — so a 500 or a dropped connection told the office that nothing had ever
been emailed to anyone, in the one panel whose whole job is answering "did that
go out?", and in the direction that reads as reassuring. Three states are kept
apart now: never loaded, loaded and genuinely empty, and failed. Only the middle
one may say nothing was sent.

`GET /sheets` and `POST /sheets/:id/email` are admin-only; an investigator gets
403 from both, from `/payment-options/email`, and from `/pricing`. Sending goes through `sendMail()`, the same
Resend path the invitations use, and never throws — a provider outage costs a
copy-and-paste, not a lost quote.

The consumer flow therefore ends at the **agreement**, not a payment: submitting
records the case, the office reads it and sends the sheet, and work starts once
the client agrees. The terms say exactly that.

## Unit 5 — the shell is measured, not styled

Every Unit 5 change began as a number from a four-width probe (320/390/768/
1200) and was re-measured before it was kept; the suite asserts the numbers.
Three rules came out of it that outlive the unit:

- **A class name is a contest.** `.qgrid` already belonged to the field view's
  84px action grid at the other end of the stylesheet, and the later rule won
  silently — the third source-order casualty on record (the dead `.dlg` phone
  rule and the buried burger base rule are the others). New shell classes get
  distinct names (`.qtgrid`), and phone overrides live at the END of the
  stylesheet, after everything they override.
- **The dim must be an element.** The drawer's backdrop was a 100vmax
  box-shadow — decoration — so a tap "outside the menu" passed through to live
  controls underneath, and the open drawer covered the burger with nothing left
  to close it. `.navback` is a real button: it intercepts, it closes, and the
  burger sits above it (z-index) swapping ☰/✕ off `body.navopen` with
  `aria-expanded` kept true-to-state.
- **A primary action never shrinks below its own words.** Intake Accept
  measured 42–60px wide × up to 119px tall — the flex row handed the ghost
  cluster the width and let the primary wrap letter by letter.

**Stacked records, not hidden columns**: under 560px, `.stacktbl` tables draw
each row as a block labelled from its own `data-l` — same markup, same
handlers — and the columns `.hide` drops come BACK, because a stacked record
has the room the row did not. The 16px-input rule is portal-wide on phones
(any smaller input makes iOS zoom on focus), with the 44px floor on form
controls and one `:focus-visible` treatment on every interactive control.

**Recent activity is existing tables, cheaply.** `GET /recent-activity`
merges per-source LIMITed reads (submissions, days, report statuses, evidence
filenames — never bytes — retainer payments, build events), excludes hidden
cases, cuts at 12, admin-only. The Dropbox needs-attention card **exists only
in the broken states** — a card that always says "fine" stops being read — and
its flag rides `/summary` for admins from local state; nothing on the
dashboard calls Dropbox.

## One search box, and a queue that says why

Unit 8. `GET /search` is structured operational search over records the portal
already holds — case, claim and matter numbers, client and carrier, the
subject's name, alias, address and phone, the vehicle's make, model, colour and
plate, the firm and its people, the saved directory, and the investigator by
name. **No document text, no media, no Dropbox, no semantic anything**, and the
brief says so explicitly.

**The role boundary is in the SQL.** Case-scoped arms apply `s.assigned_to` for
an investigator; the arms that read the PAYING side — the client's own phone,
the firm, the attorney, the saved profiles, a colleague's name — **do not run
for them at all**, which is stronger than filtering their output. The test is a
walk: every field the brief names, tried against a case the investigator is not
on, each expected to find nothing.

**Formatting must not decide whether something is found.** A phone typed four
ways and a plate typed three all match, because SQLite has no regex and the
punctuation is stripped in SQL by nested `REPLACE` — written once as
`SQL_PHONE`/`SQL_PLATE`, since five copies of that expression is five chances
to strip a different set.

**What is and is not indexed is stated, not implied.** `case_no` and
`claim_number` are matched by PREFIX and can seek; everything else is a
substring or a punctuation-stripped comparison that no index can serve, so each
of those reads its table, bounded by `SEARCH_ARM_CAP` and `SEARCH_TOTAL_CAP`.
Unit 7's parameter-bound lesson holds: no statement here grows with the
customer's data.

`GET /attention` turns Unit 5's counts into the exception list. Each alert says
**what, which case, why and where to go**, and every one is derived from state
already recorded — an intake nobody accepted, a day that finished with no
report, money the ledger says is outstanding, a date a firm actually gave us.
**Nothing is inferred from a weak assumption**: no deadline derived from
another, no category the schema cannot answer, and a case **on hold is not
neglected** (there is a test for exactly that). Windows live in one `ATTN`
block so they are arguable rather than scattered: 14 days for a legal date, 21
for a quiet case, 14 hours for a day that was probably never ended.

**There is no dismissal, deliberately.** An alert leaves because the thing was
DONE — the payment recorded, the report written, the intake accepted. A dismiss
button would be a second status system competing with the first, and the one
that drifts is the one nobody is looking at. Severity is a **word** as well as
a colour, so it reads the same to someone who cannot tell the two shades apart.

The page keeps the Unit 5 queue card, its one-row-per-case rule and its refusal
to draw a failed read as a clear desk; only the data source moved. Search has a
door for **both** roles — an investigator has no dashboard, and what they find
is decided in the Worker rather than by leaving the door out.

**A caution this unit paid for:** removing the three helpers the old
client-side derivation left behind, I cut back to the wrong comment boundary
and deleted `recentlyCompletedHtml`, `quickToolsHtml` and `loadRecent` with
them. The page threw on sign-in and rendered nothing. When deleting a region of
this file, check afterwards that every top-level declaration on master still
has one here — the check is three lines of Python and it would have caught it
before the suite did.

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

**It draws even when there are no cases**, because a page that shows nothing at
all looks broken — but every number on it is the Worker's, and a zero IS the
answer when there is no work.

**There are no fabricated example cases, anywhere** (2026-08-16). The portal
used to hold two invented cases in `portal/index.html` — a Blue Ridge Mutual
carrier assignment and a client intake — shown unasked on a first sign-in and
counted into the dashboard totals so the cards would not read zero. They are
gone, along with `SHOW_EXAMPLE`, `examplesFor`, `redactExample`,
`exampleBodyHtml` and the Show/Hide controls.

The reason is the one this file applies everywhere else: **a staff screen must
not assert something untrue.** An invented client can be photographed, quoted
or acted on as though they were real, and the person least able to tell is the
new member of staff the example existed to teach — while the padded totals made
the first number a new admin reads the one number they could not trust.

`casesEmptyHtml()` replaced it, and it keeps three states apart: **did not
load** (checked first — an outage that reads as a quiet week is the failure this
page has already been bitten by), **nothing matched that search**, and
**genuinely empty**, which says what will fill it. The way to see the layout
with data in it is a **TEST- case from Settings** — a real row, badged wherever
it appears, created and removed deliberately. Do not reintroduce page-held
example data; a test fails on `EXAMPLE-` appearing in the page at all.

## Test cases, and removing them completely

`POST /demo-case` writes a **real** row prefixed `TEST-`, so the portal can be
worked through with something in it. `POST /demo-case/clear` is the way back,
and `DEMO_SWEEP` in `case-portal/worker.js` is the list it sweeps.

**The list is the feature.** The first version named five tables — `activity_log`,
`case_reports`, `case_days`, `case_meta`, `submissions` — while a demo case can
put rows in **twenty-six**. So clearing a case anyone had actually worked
deleted the submission and left its invoices, evidence, packages, builds,
subjects, phone numbers, tasks and send history behind: rows whose `case_no`
matched nothing, invisible in every view *precisely because every view joins
through `submissions`*, and unreachable from the UI. The button whose entire
promise is "removed cleanly" was the one manufacturing orphans.

The evidence rows were the worst of it. The storage meter is
`SUM(size_bytes) WHERE deleted_at IS NULL` over `case_evidence` with **no join
to a case**, so a cleared demo case went on consuming the free-tier allowance
the cap exists to protect, with nothing on screen to explain why.

Four rules hold it together:

- **`TEST-` is written into every statement**, not computed once and passed
  around. This runs next to live work; the prefix is the whole safety mechanism.
- **Children resolve through a subquery on their parent**, so a child row is
  matched by whose case it belongs to and never by a prefix of its own.
- **Order is load-bearing.** `activity_log`, `case_reports` and `case_expenses`
  all carry `day_id REFERENCES case_days(id)`, so `case_days` goes after all
  three or D1 rejects the batch on a foreign key — and D1 runs a `--file` batch
  in one transaction, so getting it wrong fails everything rather than half-
  applying it. `submissions` is last.
- **The R2 objects go too**, read before the rows that point at them. Deleting
  only the D1 row would clear the meter while the bytes stayed on the account,
  which is the failsafe reporting the opposite of the truth.

**Adding a case-scoped table means adding it to `DEMO_SWEEP`.** A test derives
the case-scoped table list from `schema.sql` and fails if one is missing, so
this cannot quietly drift out of date again; a second test plants a row in
every one of those tables plus fifteen child tables, clears, and asserts
nothing survives while an identically-shaped real case is untouched.

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
to draw is still sitting in the browser's network tab. `worker.js` is now the
**only** place `FIELD_KEEP` is written: `portal/index.html` used to carry a
second copy so the page-held example could be redacted the same way, and when
the example went (2026-08-16) the copy lost its only consumer. A stale
duplicate of a security boundary is worse than no duplicate, so a test fails if
`FIELD_KEEP` reappears in the page.

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
node case-portal/test-worker.mjs   # 2258 checks: auth, invites, roles, redaction, rates, ingest
node portal/test-portal.mjs        # the page against the real Worker
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

## Reports: the review is for a handoff, and an admin has none

**Owner, 2026-08-19:** *"For an Admin who is assembling and delivering the case
themselves, remove redundant approval barriers... Keep approval/review
requirements for non-admin/investigator roles where appropriate. Do not weaken
role boundaries."*

The rule, written once in `latestShippableReport`/`shippableReports`: a report
may ride in a package when it is **approved or delivered, OR its author holds
the admin role** — the review flow exists for the investigator→office handoff,
and a report whose author IS the office has no handoff in it. Forcing the admin
through draft → submitted → approved on their own words was ritual: two clicks
and a status that briefly claimed the report was "with the office" while the
office was the one clicking.

**Finalize is the sign-off, and it is recorded as one.** Any still-draft report
in a finalizing package passed the gates, so it is an admin's own; finalize
stamps it `approved` with `status_by` = the finalizing admin and a
`reports_approved` build event. The status column stays the single answer to
"was this signed off" — nothing downstream learned a second vocabulary.

**The boundary did not move.** An investigator's report still seeds nothing,
still cannot be attached (*"approve it first"*), still gates finalize by name,
and the investigator still cannot approve anything — `setReportStatus` is
untouched. On a mixed case only the admin's own day seeds, and finalize never
stamps an investigator's draft. Both sides are pinned from both suites. The
page offers an admin **Approve report** directly on a draft; **Submit report**
is the investigator's button now, because submitting to yourself is not a
thing.

The package mini-row says **Ready** — never "Approved" — about a shippable
draft: a staff screen must not assert a status the row does not hold.

**The mobile report fix was measured, not eyeballed** (375px): the report
editor was 223px wide because four nested paddings ate 148px a side — and the
phone rule that should have fixed `.dlg` was **dead code**, written above the
base rule that overrode it. The working block now lives at the END of the
stylesheet and the suite asserts the COMPUTED padding, so source order cannot
silently kill it twice. With it: the editor is ≥16px (under 16, iOS zooms the
page on focus), the five report sub-tabs wrap instead of hiding behind an
unmarked scroll, and every control in the report screen meets the 44px tap
floor the field bars already enforce. The portal-wide pass is item 5; this was
deliberately scoped to the report screen.

## Six report styles, one report engine

Unit 9. The client document can print in six styles — Surveillance, Domestic /
Custody, Insurance, Legal, Process / Locate, General — and **there is still one
renderer, one PDF writer and one package workflow**. A template is
configuration: a title, section headings, their order, and which optional
sections a style includes. It decides nothing about the facts.

**The architecture works because of a decision Unit 4 already made.** The PDF
is written from the rendered `#pkgdoc`, not from the data behind it — so a
template that changes the document changes the preview, the print view, the
downloaded file and the Dropbox copy together. Six templates are six configs
over that one renderer; six renderers would be six things to drift, and a test
asserts there is exactly one `%PDF-1.` writer in the page.

**A section with nothing in it is skipped**, whichever template asked for it —
a heading over nothing is how a document starts implying it has something to
say. And templates provide **labels, never narrative**: a style may call a
section "Observed Activities", it may not write a sentence about what was
observed. No template asserts service was effected, a custody arrangement was
breached, or a claim was fraudulent; those are conclusions, and this system
only prints conclusions a person actually wrote. There is a test for each.

**`build_template` is a marker table** beside `case_builds` — the `build_custom`
reasoning, since `schema.sql` is re-applied on every portal-setup run and a
column cannot be added idempotently. The id carries **no CHECK**, so a seventh
style is an ordinary Worker edit. **Absent means general**: every report that
exists today has no row and keeps printing exactly as it always did, which is
also what stops a later change to the definitions from rewriting historical
documents.

**A finalized package refuses to be restyled** and says to reopen it — the rule
the rest of the build already follows, and the reason is that a document a
client may already have is not restyled underneath them. Finalize writes which
template it went out in into the build event, so the trail answers "which style
did that go in" without inferring.

**The default is suggested, never applied.** It is inferred only from the case's
own type or its category marker — legal marker → Legal, claims → Insurance,
custody/domestic case type → Domestic, locate/process → Process / Locate — and
never from free text. It decides what the picker opens on; it writes nothing.

Switching is a local repaint first and the one write after, so previewing
another style costs no server work and stores no PDF. If that write fails the
picker rolls back and says so — a preview showing one style while the record
holds another is the exact drift this unit exists to avoid. That is also why it
calls `api()` rather than `pkgApi()`: `pkgApi` swallows its own failure.

**Adding this table means a manual `portal-setup.yml` dispatch after merge.**

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

## Editing a case

**The case number is read-only and is never read from the edit body.** It is on
invoices, in the send history and in every email subject line already sent.
There is no rename.

Until 2026-08-16 nothing could change a case's identity at all: every
`UPDATE submissions SET` touched only `assigned_to` and `status`, so a name
typed wrong at intake stayed wrong for the life of the case. `POST /cases/:no/edit`
is that one writer, and it writes the denormalised columns and the intake
payload **together** — the case list reads the columns, the case screen and the
package read the payload, and letting them drift shows one client name on the
list and another on the screen.

**Nothing else is duplicated into it.** Case type, agreed retainer, status and
assignment already have routes; the Edit Case screen calls those, the way
`saveCaseMeta` already does, so each thing keeps one writer. Internal notes are
a list with their own panel and are linked, not copied.

**And that is why `/cases/:no/meta` treats an absent field as unchanged.** It
used to be replace-all — `num(undefined)` is null, so a caller that posted only
a case type wrote NULL over `authorized_hours` and `authorized_budget` and was
told it succeeded. Nothing noticed while the Authorization form was the only
caller, because it always posts all three; the moment Edit Case sent just the
type, correcting a client's **name** would silently erase the hours a carrier
had authorised. **A blank string still clears** — that is the office saying
there is no figure, and it is how the Authorization form removes one. Only an
absent key is left alone. A route that several screens post different subsets
to cannot be replace-all. And it resolves the untouched fields INSIDE the UPDATE, from
the row, never from a value read a moment earlier: a read-then-write loses a
concurrent edit without a sound, because two admins posting different subsets
interleave as A reads, B reads, A writes, B writes. `?7/?8/?9` say which fields
the request mentioned; everything else keeps whatever the row holds when the
statement runs. The retainer route already states this rule in its own words.

**Phone numbers are rows** (`case_phone`), one per number, each with an optional
label — the same reasoning that made `notify_recipient` one row per recipient.
Client numbers and subject numbers are separate: a case can watch more than one
person and their numbers must not pool.

**The single numbers already on cases are not migrated and not lost.**
`submissions.client_phone` and `case_subjects.phone` stay where they are.
`phonesFor()` reads THROUGH: with no rows, the legacy value IS the list, so a
case nobody has edited answers exactly as it always did. Saving a list mirrors
the first number back into the legacy column, so redaction, alerts and every
other existing reader keep seeing a primary number without knowing the table
exists. Nothing had to be backfilled and no half-run migration can drop
anything.

**A client's numbers are the client's identity.** `phonesFor` takes `forAdmin`
and returns none of them to an investigator — the same boundary `redactRow`
draws around `client_phone`. Subject numbers reach both roles, because the
subject is who is watched, never who is paying. There is a test that fails if
that inverts.

**The form keeps a draft** (`EDIT_DRAFT`), for the reason `RET_DRAFT` exists.
Every paint rebuilds the inputs from `WS`; adding a phone row repaints, so
without it a corrected name silently reverted to the stored value and the save
sent the old one back **while reporting success**. Anything that repaints must
call `edCollect()` first.

**Overview names three money figures apart**: Retainer, Received, and Balance
owed. It used to label `remaining` — the retainer the recorded WORK has not
consumed — as "Balance", which is the word this file already reserves for what
the client still owes.

## Case lifecycle — closed, reopened, archived

**Closing goes through the checklist and nothing else.** `setStatus` refuses
`closed` outright and says so; `closeCase` is the only door. **Reopening is a
button on the panel where the closure happened** — it posts the existing
`/submissions/:no/status` with the existing `open` stage, so the Worker clears
the closing stamp and the eight ticks stay as history. It used to be a sentence
saying "set a status above and save", and nothing was above it: the closing
panel is Admin → Billing & closing while the status selector is Admin →
Assignment, a different tab. Do not put that instruction back.

**ARCHIVED is a companion table, not a status** (`case_archive`).
`submissions.status` carries a CHECK and `case_status.stage` is validated
against `STAGES`; widening either is the non-idempotent rebuild `schema.sql`
cannot do, and editing a CHECK in place leaves a **fresh** database accepting
the new value while the **live** one still refuses it. Same reasoning as
`activity_removed` and `build_custom`.

Because it is only a marker, archiving touches nothing: a case can be archived
at any stage and restores to the stage it already had. "Preserves everything"
is structural, not remembered.

**The archive read is guarded, and that guard is load-bearing.** `schema.sql`
arrives by a **manual** `portal-setup.yml` dispatch while the Worker deploys on
push, so between the two `case_archive` does not exist on the live database. A
join against a missing table would take out the case list — the most-used view
in the portal, and the same shape as the `client_token` column that never
reached production. `listSubmissions` and the workspace check `missingTables`
first and degrade to "not archived"; the archive route returns 503 naming the
workflow to run. **Adding a table means adding that guard too.**

The Cases lens gained **Archived**, and it is a different *query* rather than a
filter over loaded rows — the Worker excludes archived cases from every other
view, so turning the lens reloads.

**Delete Case is a tombstone and never a purge** (`case_deleted`). The owner's
answer is explicit: *"an Admin-only soft-delete/tombstone that removes it from
normal views but preserves records"*, and *"a true irreversible data purge is
NOT needed now."* The only write is the marker. Nothing is removed — not the
submission, not evidence, reports, invoices, payment history, or the send and
audit logs — and a test asserts the row counts are unchanged across a delete on
a case carrying a day, an activity entry, a report and an invoice.

**It differs from archive in REACH, not in destructiveness.** Archived is a
normal end state, browsable under its own lens. Deleted means the case should
not be in the working set at all, so it leaves **every** ordinary view including
Archived and the Completed desk, and returns only under **Deleted** — where an
admin can put it back. Deleting never touches the archive marker, so a case that
was archived is archived again when it is put back.

That recoverability is the point, not a convenience: `activity_removed` offers
"Put it back", a voided payment prints struck-through, deleted evidence still
reads *"removed — the record stays"*. **Nothing the office does in the portal is
unrecoverable in the portal.** If a real purge is ever wanted it is a different
feature with a different name, and the owner has said it is not wanted now.

**A deleted case does not participate in work, and hiding it from the lists was
only half of that.** The first version was filter-only, and a deleted case could
still start a day, log activity, raise an invoice and **email the client a rate
sheet** — which really sent — while reappearing in Out now, the dashboard alerts
and the calendar the moment a day ran on it. So the tombstone is a **gate** as
well as a filter:

- **One chokepoint in `route()`**, not a check in thirty routes — a per-route
  list is one somebody adds to and forgets. Any non-GET on
  `/cases|submissions|leads/:no/...` is refused with 409 and `case_deleted`.
- **Invoices and builds are addressed by id**, so the case number is not in the
  path; the gate resolves it.
- **The two send routes name the case in the BODY**, so the router cannot see
  it and each checks for itself, through **one shared `caseSendRefusal()`**.
  That helper exists because the first version was two copies and they drifted
  immediately: both learned the deleted rule and neither learned the archived
  one, so an archived case went on emailing clients and writing `send_log` rows
  long after every path-addressed write was refused. A third send route must not
  be able to pick up half the rule. An *unresolvable* reference still sends —
  the pre-case rule — only a case that exists and has been filed away is
  refused.
- **`/delete` and `/undelete` are the way out** and pass the gate. Matched on
  the whole path: `/cases/:no/activity/:id/delete` also ends in "delete", and
  letting that through would leave a deleted case's timeline editable.
- **Reads stay open on purpose.** An admin has to be able to read a deleted case
  to decide whether to put it back, and the workspace is where that button is.

**Archived gates writes as well, and that is what makes hiding it safe.** The
first version let an archived case stay workable while removing it from the
working views — the two halves of a silent failure. An investigator out in the
field on an archived case would not appear on Out now; reports falling due on it
would not reach the alerts. Out of the views and out of the work go together,
and the way back is one button. Archived means *finished*, and finishing
something you are still doing is the contradiction, not the refusal.

**Archiving or deleting a case with a day still running is refused**, naming the
day. Otherwise the day is stranded: the case leaves the views so nobody sees the
clock, and the gate then refuses the very request that would end it — an
investigator with a clock they cannot stop and an office that cannot see them.
Refusing at the door is also what makes the filtering safe, because nothing live
can ever be behind a hidden case.

`caseSummary`, `outNow` and the calendar filter both sets through
`hiddenCases()`, once, rather than repeating a `NOT IN` in each query.

**Offers are addressed by their own id**, and that was the actionable route the
first gate missed: accepting one assigns the investigator and moves the case's
stage. `/offers/:id/*` and `/my/offers/:id/*` resolve through the gate like
invoices and builds.

## Who gets told — admin alert recipients

`notify_recipient` is **one row per recipient**, so "multiple phone numbers" is
rows rather than a delimited column: each number carries its own enable switch
and its own choice of the five alerts (intakes, payments, reports, packages,
important tasks). One number can take payments and packages while another takes
intakes only, and switching one off never touches the other.

**Nothing is hardcoded.** Every number and address is typed by an admin and
lives only in that table; the schema seeds no default recipient and the page
holds no provider credential. A test greps `worker.js` for dialable-looking
digit runs and for provider names, and greps `schema.sql` for a seeded INSERT.

**Email alerts are wired; SMS is not.** `notifyAdmins(env, event, caseNo)` is
called at six points — the public ingest and the manual intake (`intakes`), the
retainer payment route and `recordInvoicePayment` (`payments`), a report moving
to `submitted` (`reports`), a build being finalized (`packages`), and a task
created at **high or urgent** priority (`tasks`). "Important" is the priority the
office already sets: alerting on every normal task is how an alert stops being
read.

It writes only to recipients that are switched on, subscribed to that event and
**have an email address** — a phone-only recipient is skipped rather than
emailed, because quietly substituting a channel they did not choose is worse
than waiting for the provider.

**It never throws, and every caller awaits it after its own write has
committed.** An alert is a courtesy about something that already happened; a
provider outage must not fail an intake, a payment or a report. There is a test
that throws from the provider and asserts the intake is still accepted and the
money still on the ledger. (The Worker's `fetch` takes no `ctx`, so there is no
`waitUntil` — the send is awaited inline, capped by `sendMail`'s 8s timeout.)

**SMS delivery is blocked on a provider, and the portal says so.** There is no
SMS provider configured anywhere in this Worker — `alertDelivery()` reports
`sms: 'blocked_on_provider'` with a sentence, and the Settings card shows *"not
sent yet"*. Recipients, switches and choices are stored and honoured; the
sending half is what does not exist. Adding a provider means adding its
credential to the environment and a sender beside `sendMail()` — never editing
that function to claim yes.

**Alert text carries nothing about the case, and a text message carries no case
number either.** An alert leaves the building: email goes through Resend, and
any SMS will go through a carrier and a provider. So `alertText()` says what
happened and where to look, and never a claimant, client, subject or adjuster
name, address, vehicle, injury, objective, claim or policy number, carrier,
phone, email — **or an amount**, because what was paid is commercial and "a
payment was recorded" is all an alert needs to say.

**The two channels differ on exactly one thing** (owner, 2026-08-16):

| Channel | Text |
| --- | --- |
| SMS | `New intake received. Open the portal.` |
| Email | `New intake received — case API-EXAMPLE-0001. Sign in to the portal for the detail.` |

A text crosses a carrier network, sits unlocked on a lock screen and is backed
up by whatever the handset does, so **no case number goes over it**. Email
reaches the firm's own inbox through one provider the firm chose, and keeps the
reference that makes an alert actionable.

**The `sms` branch does not read `caseNo` at all**, which is stronger than
filtering it out: there is no path by which case data can reach a text. The test
that matters asserts the SMS wording is **identical on two different databases**,
one of which has a real loaded case — a filter can be got wrong, an absent path
cannot.

The tests plant a case carrying every forbidden value and assert none appears in
**either** channel of **any** event. The wording is composed by the Worker and
returned as `preview` and `preview_sms`, so the Settings page shows both side by
side and cannot drift from what is sent — one writer, as everywhere else here.

## New case files live in Dropbox, not R2

Since 2026-08-18 (owner) **new case photos and generated reports go to the
firm's own Dropbox App Folder**, in per-case `Photos` / `Reports` / `Video`
folders chosen by content type. `case-portal/DROPBOX.md` carries the detail.
Four things are load-bearing:

- **New bytes go to Dropbox or nowhere.** No R2 fallback, no double-write. An
  upload that cannot reach Dropbox is refused and names which of three
  conditions it is. A fallback splits one case across two stores and nobody
  finds out until they go looking for the half that moved.
- **Nothing was migrated and nothing was deleted.** Every existing R2 object
  still serves and is still what the storage meter counts. Do not sweep them.
- **Files are proxied through the Worker, never handed out as Dropbox links.**
  `serveEvidence` is the only place bytes leave, so the case's permission checks
  stay in front of them.
- **No new table.** `case_evidence.r2_key` already means "where the bytes are",
  so a Dropbox row records `dropbox:<path>` and the prefix is the whole
  discriminator — no companion table to fall out of step, and no portal-setup
  dispatch standing between a merge and a working upload.

Video is still refused by the ordinary upload; the device-first decision below
is untouched.

**And since 2026-08-19 the portal SAYS all of this** (owner: *"visible Dropbox
portal UI for Admin: connection status, account, Open Dropbox Folder, and case
links for Photos Reports Video. Use existing Dropbox backend; do not build a
file manager."*). Settings carries a Dropbox card; Case media carries **In
Dropbox** with one link per folder. **No storage behaviour changed** — the
routes, folders and refusals are exactly as they were, and nothing lists,
renames, moves, deletes or downloads a file.

**A Dropbox web link is not a shared link, and that is the whole safety of it.**
`https://www.dropbox.com/home/...` opens the FIRM'S OWN Dropbox: signed in to
that account you see the folder, signed in to any other you see nothing. It
carries no token and no bytes. `create_shared_link_with_settings` would hand the
case files to anyone holding the URL — it is called nowhere, and a test asserts
no `api.dropboxapi.com/2/sharing` call exists at all. Do not add one. Every link
carries `rel="noopener noreferrer"`, because the portal URL holds the case
number and it must not ride to Dropbox in a `Referer`.

**The App Folder name cannot be derived, so it is asked for once.** App-folder
access means every path the API returns is app-relative — `/API-1234/Photos`,
never `/Apps/<name>/API-1234/Photos` — and Dropbox does not tell an app what its
own folder was called. It lives in **`app_config`**, an existing table, so this
needed no schema change and **no portal-setup dispatch**. Until it is filled in
there is **no per-case link at all**: `case_url_template` is null rather than a
guess and Open Dropbox goes to `/home/Apps`, which is correct plus one click.
The name builds a URL and nothing else — uploads address the App Folder root,
which needs no name — so a wrong name costs a link, never a misplaced file, and
a test asserts the upload path cannot read it. `dropboxWebUrls()` is the one
writer of the shape; the page substitutes into its template and assembles no
path of its own. Detail in `case-portal/DROPBOX.md`.

## The free-plan failsafe

The owner runs Cloudflare on free tiers and wants zero possibility of a
charge. Cloudflare has no spend cap, so **the Worker is the cap**: evidence
uploads are refused at 75 MB per file. **The 9 GB and 50k/month refusals no
longer govern an upload**, because since the Dropbox move no upload writes to
R2 at all — applying them would refuse a photograph over what LEGACY files
weigh, a failsafe firing about storage it is not protecting. They still
describe the meter, and the meter now counts **only what is actually in
Cloudflare**: Dropbox-backed rows are excluded from both the byte total and the
monthly count. The meter is
`SUM(size_bytes) WHERE deleted_at IS NULL` in `case_evidence` — computed,
never stored. The admin dashboard's Storage card warns at 75%, and
`site-health.yml` opens a single GitHub issue when `/portal-api/health`'s
`storage_pct` (a bare number, deliberately public) crosses 75. Limits are
env-overridable (`STORAGE_HARD_CAP` etc.) so the tests exercise the
refusals with real uploads. Do not raise the caps without the owner.
A Cloudflare-side Budget Alert ($10 → owner's email) exists as the
independent second net; it alerts, it cannot block.

## Video is device-first, and the timestamp is burned into the pixels

**No new video byte becomes Cloudflare storage** (owner, 2026-08-17). A clip
stays on the device that shot it; the timestamped copy is rendered in that
device's own browser and saved back to it; the portal keeps the **record** and
nothing else. `uploadEvidence` refuses `video/*` with `code: 'video_device_first'`
**in the Worker** — a property enforced by a page is enforced by nothing — and
it refuses **before** the size and cap tests, so a video is never first told to
split itself into parts on a path that no longer exists.

**Legacy video already in R2 is untouched, deliberately.** The refusal blocks
new writes and deletes nothing: existing rows still read, still serve, still
count on the storage meter, still pass the package video gate, and are badged
*"stored earlier"* in the gallery. Whether they should eventually be exported
and removed is an **open decision nobody has made** — do not sweep them as a
side effect of anything. Both suites now plant such a row directly, because that
is the only way one can exist.

**`video_stamp` is metadata and audit only. There is no blob column and there
must never be one** — a test reads `schema.sql` rather than a comment about it.
A correction does not edit a row: it inserts a new one and stamps the earlier
one `superseded_at`, matched on the original's own filename so a caller cannot
supersede another original by naming its id. This is the project's existing
audit shape (`send_log`, `build_events`, `invoice_events`), not a new one.

**`saved_at` is the operator's word, never an assumption.** A browser cannot see
where a download went, so `showSaveFilePicker` resolving is the only path that
claims "saved" by itself; everything else says the download has *started* and
the operator confirms it arrived. It is written once — a second tap does not
move the moment the file reached the device. Safari cannot silently put a file
in Photos and nothing here pretends it can.

**The renderer is canvas + `MediaRecorder` (VP9/WebM), and mp4 is refused by
construction.** A capability proof run before any feature code found WebCodecs
**absent** in this browser, so the architecture audit's first recommendation
could not be used or proven; the same proof took a clip through decode → canvas
→ burn → encode → **re-decode** and found the burned marker present in the
output with a control pixel elsewhere clean. It also found `video/mp4` reporting
supported while its only real codec `avc1` reports **not** — recording to it
produces a file nothing can play. `vstMime()` never offers it.

**The clock runs on the footage's timeline, never on this machine's.** The label
for a frame is the operator's chosen start plus that frame's own presentation
time. `Intl.DateTimeFormat` resolves **EST or EDT from the date itself**, so a
summer stamp is not an hour wrong — do not hard-code an offset. The face is
monospace on purpose: a proportional one shifts the seconds digits sideways as
they change, and the stamp must not move.

Known limits, stated rather than papered over: the copy is **picture only** (no
dependable cross-browser audio capture, and the original with its audio is
untouched on the device), the output is **WebM**, rendering is **real time**
because the clip is played through once, and the original's SHA-256 is taken
only up to 128 MB and recorded as **absent** above that — never as a placeholder.

`VST` and the `#vstamp` sibling root follow the evidence viewer's pattern for
one more reason: a render runs as long as the clip does, and nothing underneath
may be rebuilt while it goes.

**Adding this table means a manual `portal-setup.yml` dispatch after merge.**
Every read is guarded through `missingTables()` — the list degrades, the
workspace carries an empty array, the write returns 503 naming the workflow.

**Timestamp Video is a top-level door, not a case feature.** It is in the
navigation foot for both roles on every screen and as one compact `.qtools` row
on the Dashboard; an investigator has no Dashboard, which is why the nav door is
the real answer. Its `data-case` is empty **on purpose** so it cannot adopt
whichever case is open behind it — opened from outside a case it asks, against
the caller's own `/submissions` list, and the record still goes through
`caseFor`. A copy may also be made with no case at all, and the screen then says
plainly that the portal holds no record of it until it is attached.

**A control that renders is not a control that can be seen.** The Timestamp Video
quick tool was drawn on the first screenful at every width and the owner still
could not find it: white on a near-white page, and drawn only by `dashView()` —
which an investigator never sees, while under 900px the navigation rail holding
the other copy is behind the burger. `quickToolsHtml()` is called from `shell()`
for that reason: one row, one writer, every top-level screen, both roles, one
wording. There is an assertion that the control's surface differs from the page
behind it by at least 8 luminance points, and it caught a "fix" that differed
by 3.

**A `.mov` that fails is a codec failure, not a container-label failure.** The
browser sniffs a blob's bytes and ignores its declared type — measured: identical
decodable bytes load as `video/quicktime`, `application/octet-stream` or with no
type at all. So re-wrapping fixes nothing. `vstBoxCodec()` names the codec from
the file's own `stsd` box with no decoder, walking to the END because iPhone
QuickTime writes `moov` last (182 bytes read of a 5 MB fixture), and returns
**null** rather than guessing when it cannot read it. The decode probe runs when
the file is CHOSEN, so an undecodable file never gets a Generate button under a
fatal error — it gets the reason where the action was, with Edit timestamp and
Cancel still offered.

**Browser-side FFmpeg/WASM is ruled out and the measurements are in
`VIDEO-TIMESTAMP.md`:** no `SharedArrayBuffer` (no threads), `@ffmpeg/core` is
64.7 MB against Cloudflare Pages' 25 MiB per-file cap, and `file.arrayBuffer()`
throws above 1 GB. It would work on demo clips and fail on surveillance files.
The recommendation for HEVC is the iPhone's *Most Compatible* camera setting,
which writes H.264 that the existing renderer already handles.

**Media wording:** *Upload video / picture* names the entry point for ADDING,
*Case media* names what is already there. **Keys, routes, tables and variables
are unchanged** — `evidence` is still the tab key, the route and the table. The
button under the section reads *Upload picture or document*, because a control
saying "upload video" would promise what the Worker refuses; the section carries
the owner's word and no individual control states an untruth. The four field
actions stay **Activity / Photo / Video / Note**, asserted by name and count.

## A photograph is timestamped into the case, not onto the device

**The owner's brief for this is four words** — *"Build Timestamp Photo"*, item 2
of the locked roadmap order. `case-portal/PHOTO-TIMESTAMP.md` is the durable
record of what was taken from **their own video brief** (the original is never
modified, the derivative is separate, the two are distinguishable, the burn is
into the pixels, the zone is resolved from the date) and what this build
**DERIVED**. Read it before changing any of this; each derived decision is
listed separately so it can be overturned on its own.

**It follows Timestamp Video's ORDER exactly** (owner, after a device test,
2026-08-19): *"choose a local photo first on iOS Android Mac or Windows,
timestamp it locally, then optionally choose a case only for Dropbox or case
filing."* Pick the picture, set the moment, burn it on that machine, keep it.
**Nothing is uploaded and the portal holds no record unless a case is
deliberately chosen** — the same bargain the video tool makes. That is a rule
with a test: the suite asserts the byte store and both tables are unchanged
after the copy exists and while a case is being chosen.

Two earlier decisions of mine were overruled by the field, in order. The first
put the door only on a photograph already in the case, so with nothing uploaded
there was no way in at all. The fix for that led with a **required case picker**,
which made a utility ask about filing before it would do its one job. Both are
recorded as superseded in `PHOTO-TIMESTAMP.md` with their original reasoning
kept.

**When a case IS chosen, the storage is unchanged**: the stamped photograph is an
ordinary second `case_evidence` row in the case's own `Photos` folder, and
`POST /cases/:no/photo-stamp` adds no storage architecture — it is the existing
Dropbox upload plus a row saying which original the copy belongs to. A picture
that came off a device has its **original filed first**, untouched, because the
owner's rule is that the original is preserved as case evidence and the pair is
meaningless without it. A picture already in the case is already the original and
nothing extra is uploaded.

**The burn is `vstDraw` and the wording is `vstLabel`** — the same functions the
video renderer uses, not copies of them. Two renderings of one stamp drift, and
the one that drifts is the one nobody is looking at.

**`vstDraw` sizes the face from the WIDTH, and that is load-bearing.** It has
been wrong twice. `H * 0.05` — the height — while the stamp runs along the width
left 2 to 11 pixels of margin on portrait; sizing from the short side fixed the
margin and left the PROPORTION wrong, so a portrait picture carried a stamp
across 70% of its width against 52% on landscape, and the owner rejected it on
sight. It now measures the text once at a known size to learn how wide that face
actually draws the string, then solves for a target share of the width — which
also absorbs whatever fallback font a device picks, because that is the font
being measured. `H * 0.08` caps a wide, short picture; a bounded loop guarantees
the whole date, time and zone land inside the margins.

**The test asserts AGREEMENT between orientations, not fit.** Every geometry
fitted inside its margins under the version the owner rejected — *"it fits"* was
true of the broken one. What was wrong was portrait carrying a bigger stamp than
landscape, so that is what is measured: portrait 51.4%, landscape 51.7%. Do not
re-derive this from a height.

**`photo_stamp` is a companion table** for the reason every other one here is:
`case_evidence` cannot gain a column while `schema.sql` is re-applied on every
portal-setup run. Guarded on every read, named in `EXPECTED_TABLES`, and swept
**before** `case_evidence` because it points at it twice.

Two refusals are load-bearing:

- **The copy inherits the original's classification.** Something held back as
  internal only, needs redaction or do not use must not become deliverable by
  the act of being timestamped — that would make this route a way around the
  package gate, which is the one thing the gate exists to stop. A caller asking
  for a wider classification changes nothing, because the field is never read.
- **A timestamped copy cannot itself be stamped.** Two burned faces on one
  picture is a document making two claims about the same moment.

**Nothing is guessed about when the picture was taken.** EXIF
`DateTimeOriginal` seeds the fields when the file carries it, and the screen
says the camera is where it came from; `OffsetTimeOriginal` makes the instant
exact, and without it the reading is interpreted as Eastern **and says so**.
With no EXIF the fields are **empty** and the screen says nothing has been
filled in. `file.lastModified` is not a second opinion about when a picture was
taken — on a Photos export it is when the export was written — and today's date
is the one value guaranteed to be wrong. Neither is used, and a test asserts the
current year never appears as a seed. What was burned records **which** it was:
`photo_stamp.source` is `exif` or `operator`, and touching any field is what
turns one into the other.

**A correction supersedes rather than overwrites**, matched on the original's
id so no caller can supersede another photograph's stamp by naming it. The
earlier derivative keeps its evidence row and its file: removing it would be a
purge, and nothing in this portal purges.

**A package never carries both halves of the pair by default** (owner,
2026-08-18): *"do not automatically include both original and timestamped copy
in the client package. Add 'Include timestamped copy in client package' default
ON. Original keeps its existing classification unless Admin explicitly selects
it."*

That lands in two places, and **not** in a new column. Package eligibility
already IS `classification === 'client_deliverable'`, so the checkbox decides
the classification the copy is **born with** — ON gives it the original's, OFF
gives it `internal_only` — and the classification stays the single record of the
decision even after an admin changes it by hand. A second `include_in_package`
flag would be a second answer to one question, and the two would disagree the
first time someone used the ordinary control.

The switch **cannot widen**: a held-back original still produces a held-back
copy, and OFF on a `do_not_use` original inherits rather than rewriting it as
the milder `internal_only`. It picks between *as the original* and *held back*,
never a third meaning.

**The original's classification is never touched by any of this.** The
"not both" half is enforced where inclusion actually happens — the package
picker shows an original whose live copy is deliverable as having the copy
going in its place, and its Add becomes an explicit **Add anyway**. Nothing
refuses it: `POST /build/:id/items` is unchanged, because an Admin explicitly
selecting the original is exactly what the owner allowed for.

**It has the same doors Timestamp Video has, and that was a correction.** The
first build put the action only on the photograph — the gallery card and the
field view's media card — reasoning that unlike a clip the picture is already in
the case. True, and not enough: with nothing uploaded there is no card, so there
was no entry point **anywhere** and the owner could not find the tool at all.

Four doors now: the **navigation foot** (both roles, every screen), the
**dashboard quick tools row**, its **own card on Case media** (its own card, not
a button under the video card — that paragraph is about clips), and the **field
view's media screen**, because inside the field view the navigation rail is not
on screen and the nav door does not reach it.

The top-level copies carry an **empty `data-case`** for the same reason
Timestamp Video's does: the utility asks which case rather than adopting
whichever one is open behind it. Unlike video it always needs a case, so "no
case" is a question here and never a skip, and a case with no photographs says
so and says where one comes from.

The action stays on the card too — `caseFor` is the boundary that matters and
the investigator who took the picture is the one standing in the field with it.
**The reachability tests are written as a pair across both tools**, so a door
that exists for one and not the other fails rather than ships.

**Adding this table means a manual `portal-setup.yml` dispatch after merge.**

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

**Two admins may be out on one case at once, and neither can stop the other by
accident.** The data layer already allowed it: `startDay` checks for an existing
open day scoped to `investigator_id = user.id`, not to the case, and the only
unique index here is one open *pause* per *day* — already per session. So
concurrency needed no schema change and none was made.

What did change is `openDayForAction`. Its admin fallback used to be
**unconditional**, so an ordinary End or Pause reached whatever day happened to
be open: one admin at the desk could silently end the day of one standing in the
rain. It now takes `allowOthers`, set **only** by `/cases/:no/day/end-other` —
its own route, its own control, its own confirmation. End, pause and resume never
set it, so they can only ever touch the caller's own session.

**The confirmation is bound to the session it ends.** The page draws one
button per running session, each labelled with a different person, and the
request carries that session's `day_id`. It used to carry nothing while the
Worker took the newest open day — so with two admins out, the button saying one
name ended the other's clock. An absent id is honoured only when exactly ONE
session is running (the recovery case, where there is nothing to get wrong) and
refused with `ambiguous` when there is more than one.

**A separate route rather than a flag on `/day/end`**, so the ordinary control
cannot reach it however it is called. A flag is one stray `true` away from being
back where this started. That route is also the HIGH #2 recovery path for a day
stranded by reassignment, and it asks for **no reason** (owner): the confirmation
is the deliberate act.

When an admin presses the ordinary control on someone else's day the refusal
names whose it is and sets `other_session`, so the page can offer the separate
action rather than parse a sentence. The field panel shows "X has a day running…
starting your own below runs alongside theirs" — because two admins on one case
is the ordinary situation, and ending someone else's is the unusual one.

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
