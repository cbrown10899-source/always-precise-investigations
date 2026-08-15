# WORK ORDER — master reconciliation + finish pass (INTERNAL)

**Issued by the owner, 2026-08-15.** Delivered through the repo rather than
pasted, because it is too long to move through a phone → Remote Desktop
clipboard without silent truncation.

**Read this whole file, then work it.** Section 1 is the owner's prompt
verbatim. Section 2 is an addendum verified against the code at master
`aa107b4` — where the addendum and any `.md` disagree, the addendum and the
code win.

**Sequencing the owner asked for:** finish any HIGH item currently in flight
first. Then Phase 0–1 plus the addendum, land and commit. Then Phase 2 onward.
Do not attempt all fourteen phases in one unbroken run.

---

# SECTION 0 — WHAT HAPPENED WHILE YOU WERE WORKING (read first)

Written 2026-08-15 by the remote session, after the owner asked for a deploy.
Master is now **`9ef482e`**. Three things changed underneath you.

### 1. Your work is merged and deployed

`claude/arrival-sentence-generator` was merged as **PR #72**, and deliberately
**merged rather than squashed** — every one of your seventeen commits is on
master with its **original SHA**, verified with `git merge-base --is-ancestor`.
So there is no rebase dance. `git merge origin/master` into your branch and
carry on; nothing of yours needs replaying.

All four suites were run on your branch before the merge and were green:
worker **885**, portal **713**, intake **205**, alerts **47** — 1,850 checks.

`portal-setup.yml` was dispatched afterwards with `create_admin` off, so
`payment_methods` and `payment_send` are applied to the live D1. The Worker
will not 500 on those routes.

### 2. The public site had not deployed since Thursday — now fixed

`deploy.yml` excluded `.git` and `.github` from its rsync but **not
`.claude`**. The remote session's subagent definitions in `.claude/agents/`
were landing in `_site/`, and the no-markdown guard failed the build. Correct
behaviour by the guard; the exclude list was what was wrong.

It survived four merges because it was **half** a failure: `deploy-portal.yml`
succeeded every time, so the portal shipped on schedule while the public site
sat frozen at `62c9b64` from 2026-08-14 14:53. **A red workflow nobody reads
is the same as no workflow** — if you add a file type to the repo root, check
that `deploy.yml` still passes, not just the suites.

Fixed in **PR #73** (`--exclude '.claude'`). The site deploy is green again.

### 3. Two stale rows in RECONCILIATION.md were corrected

Both invoicing **retainer** findings still read `BEING FIXED NOW` and `OPEN`
on master though **PR #69** fixed both. Re-verified against `worker.js`
~2214-2229 and ~2357-2373 and marked FIXED with that evidence. Do not re-fix
them.

### What still needs the owner, not you

- **Cash App and Venmo handles.** The payment configuration is built and
  deliberately empty. It needs the firm's **business** account details. The
  old handles in git history were the owner's personal accounts — do not
  recover them, do not seed defaults, do not invent a payment URL.
- **The three Dropbox secrets** (Phase 7).
- **"Serving ALL of Virginia since 2014"** (Phase 9) — an open coverage
  decision, surface it rather than resolving it.

---

# SECTION 1 — THE OWNER'S PROMPT (verbatim)

MASTER RECONCILIATION + FINISH PASS — ALWAYS PRECISE INVESTIGATIONS

I want a complete reconciliation of the Always Precise Investigations project
against ALL handoffs, additions, UX requests, security findings and owner
decisions from the past several days.

Do not assume a feature is complete merely because a handoff says it shipped.

Do not rebuild working features merely because they appear in an older handoff.

The actual code, current tests, current routes and current deployed behavior
are the source of truth.

## PHASE 0 — ESTABLISH CURRENT STATE SAFELY

Before changing anything:

1. Show:
   - current branch
   - git status
   - latest local commit
   - latest origin/master commit
   - whether this branch is ahead/behind master
   - open/unmerged work relevant to this branch

2. Preserve all current work.

3. Read ALL relevant project handoff/state files, including at minimum:
   - CLAUDE.md
   - case-portal/NEXT.md
   - case-portal/RECONCILIATION.md
   - case-portal/MASTER-HANDOFF.md
   - INTAKE-NA.md
   - SURVEILLANCE.md
   - any other handoff/requirements markdown referenced by those files

4. Search the repo for additional handoff docs created during the recent
   sessions.

5. Build one reconciliation table:

REQUIREMENT | DONE | PARTIAL | MISSING | VERIFIED BY | NEXT ACTION

Do not rely on stale DONE claims without checking the implementation.

## PHASE 1 — FINISH VERIFIED HIGH-RISK BUGS FIRST

Continue/finish any remaining verified HIGH findings before cosmetic work.

Known queue has included:

1. Surveillance/open-pause timing can turn a real investigation day into 0
   hours.
2. Reassigning a case can strand a running investigation day.
3. Backward invoice status can reopen a paid invoice / corrupt Outstanding.
4. Case Build finalize control/gate can disappear when a package is actually
   ready.
5. MEDIUM: UTC-date vs local-time surveillance records can place evening work
   on the wrong day.

Some of these may already be fixed.

For each:
- independently verify current state
- if already fixed, prove it with tests
- if still broken, write a failing regression test first
- fix the smallest correct boundary
- run relevant suites
- use Codex as an independent reviewer
- update NEXT.md / RECONCILIATION.md

Do not re-fix completed items.

## PHASE 2 — PRIVATE CLIENT ONBOARDING + CASH APP / VENMO

This is an explicit owner requirement and must be fully implemented.

PRIVATE CLIENT ONLY.

The Private Client rate-sheet/intake workflow must support:

RATE SHEET:
- $1,500 retainer
- $100/hr
- 4-hour minimum
- current approved billing wording preserved

PRIVATE LEAD CARD should make these actions obvious:
- Review
- Message
- Send Rate Sheet
- Send Intake
- Send Payment Options
- Accept

Do not clutter the card unnecessarily. Group secondary send actions if needed.

### PRIVATE RATE-SHEET SEND FLOW

At the bottom of the Private $1,500 rate sheet, the current tiny helper text
beside:

SEND THIS SHEET →

is too small and vague.

Replace it with a clearly readable next-step block.

Example:

NEXT STEP

Choose what to include with this email:

✓ Private Client Intake Form
✓ Payment Options

This must be large enough to read at a glance.

On mobile, stack it cleanly.

### PRIVATE SEND WIZARD

Clicking SEND THIS SHEET should show:

INCLUDE WITH THIS EMAIL

☐ Private Client Intake Form
☐ Payment Options

If Payment Options is selected:

PAYMENT METHODS

☑ Cash App
☑ Venmo

Cash App and Venmo must be independently checkable/uncheckable.

Examples that must work:

- Intake + Cash App + Venmo
- Intake + Cash App only
- Intake + Venmo only
- Payment Options without Intake
- Intake without Payment Options

The preview and resulting email must exactly reflect selections.

### STANDALONE PAYMENT SEND

Private leads also need:

SEND PAYMENT OPTIONS

This should allow Admin to send payment instructions later without resending
the rate sheet.

Dialog:
- Recipient Email
- Recipient Name
- Lead/Case reference if appropriate
- Optional message
- Cash App checkbox
- Venmo checkbox
- Preview
- Send

### CENTRAL PAYMENT CONFIGURATION

Create/reuse Admin-only:

SETTINGS → PRIVATE CLIENT PAYMENT METHODS

Cash App:
- Enabled
- Display Name
- Handle
- Optional Payment URL
- Instructions

Venmo:
- Enabled
- Display Name
- Handle
- Optional Payment URL
- Instructions

Do NOT duplicate handles throughout templates.

Do NOT store payment passwords, login credentials or secrets.

If a safe direct payment URL is configured, make:

PAY WITH CASH APP
PAY WITH VENMO

clickable.

If only a handle exists, show the handle clearly.

Do not invent payment URLs.

### PAYMENT STATUS

Sending payment instructions NEVER means payment was received.

Keep:

RETAINER PENDING

until Admin records receipt.

Admin must be able to record:
- Retainer Received
- Amount Received
- Date
- Payment Method
- Reference / Note

Methods:
- Cash App
- Venmo
- Check
- Cash
- Credit Card
- ACH / BILL
- Other

Returned Private intake should show something like:

PRIVATE INTAKE RECEIVED ✓
RETAINER PENDING

[ Send Payment Options ]
[ Record Payment ]
[ Review Intake ]

If instructions were already sent:

PAYMENT INSTRUCTIONS SENT
Cash App + Venmo
[ Resend ]

### STRICT INSURANCE BOUNDARY

Insurance flows must NEVER automatically contain:
- Cash App
- Venmo
- Private payment instructions

Regression-test this boundary.

Insurance should remain paired only with the Insurance Assignment Intake.

## PHASE 3 — RATE SHEET / INTAKE PAIRING

There are TWO distinct rate-sheet workflows.

INSURANCE:
- 8 hrs / $1,200
- 16 hrs / $2,300
- 24 hrs / $3,300
- Additional authorized hours $150/hr
- correct Insurance Assignment Intake

PRIVATE:
- $1,500 retainer
- $100/hr
- 4-hour minimum
- correct Private Client Intake
- optional Private Payment Instructions

Never mix these.

Send confirmation should explicitly show what was sent.

Example Private:

SENT TO:
client@email.com

Included:
✓ Private Client Rate Sheet
✓ Private Client Intake Form
✓ Payment Options
✓ Cash App
✓ Venmo

Example Insurance:

Included:
✓ Insurance Assignment Rate Sheet
✓ Insurance Assignment Intake Form

## PHASE 4 — MAKE THE PORTAL LESS BUSY

Audit the current Admin and Investigator portal visually.

The portal has accumulated many functions.

The goal is NOT fewer capabilities.

The goal is:

SEE WHAT MATTERS.
KNOW WHAT TO DO NEXT.
ONE CLICK TO CONTINUE.

Use progressive disclosure.

Do not put every control on screen at the same priority.

### ADMIN DASHBOARD

Keep the left sidebar design.

Top metrics should be limited to the most useful operational items.

Prefer:
- Open Cases
- Needs Assignment
- Reports Due
- Ready to Close
- Outstanding

Do not fill the top with 10+ equally weighted counters.

Below:

CASE PACKAGES

Each case card should visually show applicable status:

Activity ✓
Report ◐
Photos ✓
Video ✓
Build ○
Invoice ○

and ONE computed:

NEXT STEP

Examples:
- Start Investigation
- Continue Activity
- Review Report
- Select Evidence
- Build Package
- Create Invoice
- Ready to Close

Clicking NEXT STEP must go directly to that task.

### CASE DETAIL

Keep the simplified hierarchy.

Admin:
- Overview
- Fieldwork
- Report & Evidence
- Admin

Investigator:
- Assignment
- Activity
- Evidence
- Report

Do not return to the old many-equal-tabs interface.

Use contextual back buttons consistently.

### ACTIVITY ENTRY

Keep timeline-first.

Default entry should only show:
- Time
- Action
- Details
- Subject documented
- Photo taken
- Video acquired

Put:
- Location
- Vehicle
- Internal note
- evidence linking
under MORE DETAILS.

Do not make investigators complete a giant form for each observation.

### LEADS & INTAKES

The current lead cards are becoming busy.

Audit their hierarchy.

The main information should be:
- Private / Insurance
- New / Received / Accepted
- Client/Carrier
- Subject
- authorization/retainer state
- next action

Secondary actions may be grouped under:
SEND →
or MORE →

but key workflow actions must remain obvious.

Do not hide essential tasks behind several clicks.

## PHASE 5 — ACTIVE SURVEILLANCE MODE

Audit against SURVEILLANCE.md and the mobile design handoffs.

This must remain a mobile-first view of the SAME case/data.

No parallel database.

Launch from assigned surveillance case:

START ACTIVE SURVEILLANCE MODE

Mobile home should support:

- Case #
- Case type
- Day #
- elapsed timer
- End Investigation Day
- Activity
- Photo
- Video
- Note
- Voice Entry
- Last Activity
- Timeline

Bottom navigation:
- Home
- Activity
- Evidence
- Report
- More

Timer must survive:
- screen lock
- refresh
- browser suspension

based on persisted server time.

### QUICK ACTIVITY

Keep:
- Favorites
- Arrival
- No Activity
- Subject
- Vehicle
- Location
- Surveillance

Maintain the arrival sentence generator.

Include realistic options such as:
- direct view
- indirect view
- primary route of departure
- vehicle count

One-tap:
NO CHANGE

### VOICE ENTRY

Native phone dictation must work.

Where custom speech-to-text is supported:

TAP TO SPEAK
→ transcript
→ review
→ USE TEXT / DISCARD

Never auto-submit dictated text into an official report without review.

### REPORT

Activity automatically builds the draft report.

No copying timeline entries manually.

## PHASE 6 — REPORT / EVIDENCE / CASE BUILD

Audit against the Case Build handoffs.

Verify:

- submitted report versions cannot be mutated
- removed activity does not appear in report/package
- original evidence is never overwritten
- multi-day cases include all approved days in order
- late-approved day becomes an OFFER rather than silently
  appearing/disappearing
- Report + Photos produces a polished combined PDF
- Case Build works for multi-day surveillance
- Case Build finalize button is visible at the correct state
- evidence classifications are enforced
- Custom package does not bypass held-back evidence rules

Completed cases should expose:
- Final Report
- Evidence Index
- Client Package
- Video Delivery Link
- Invoice

## PHASE 7 — DROPBOX VIDEO DELIVERY

Audit/finish the optional large-video delivery handoff.

Portal remains the source of truth.

Dropbox may hold client delivery copies of large video.

Provider-neutral fields should be used where practical.

Admin Case Build flow:

Select Video
→ Add Video to Package
→ Upload selected delivery copy
→ Create share link
→ Copy link
→ include link/reference in client package

Never delete/replace the only original evidence copy.

## PHASE 8 — INVOICING / BILL

Audit current invoice system against prior handoffs.

Portal:
CREATE → REVIEW → PDF → MOVE TO BILL → TRACK PAYMENT

Do not make case operations dependent on BILL.

Insurance invoice should support:
- carrier
- adjuster
- case #
- claim #
- authorization
- PO
- vendor #
- service dates
- terms
- due date
- line items
- total
- balance

Private invoice:
- client
- retainer
- applied amount
- additional authorization
- balance

Preserve the corrected retainer accounting rules.

Do not change current rates.

## PHASE 9 — INSURANCE SEO / PUBLIC WEBSITE

Audit and finish the recent Insurance SEO handoff.

The public site should clearly serve TWO paths:

INSURANCE & COMMERCIAL

PRIVATE INVESTIGATIONS

Insurance should be prominent near the top without burying:
- adultery / infidelity
- child custody
- domestic
- general surveillance

Identify the strongest existing Insurance Investigations route and make it the
canonical insurance SEO landing page.

Audit:
- title
- meta description
- H1/H2
- canonical
- sitemap
- robots
- indexability
- Open Graph
- structured data
- internal linking
- mobile performance
- CTA routing

Insurance page should naturally address legitimate searches such as:
- insurance investigations
- insurance surveillance
- workers compensation surveillance
- claims investigations
- SIU investigation services
- insurance field investigations

No keyword stuffing.
No fake locations.
No fake offices.
No fake certifications.
No fake coverage claims.

Public Insurance page should lead to:
SUBMIT AN INSURANCE ASSIGNMENT

not expose Admin portal URLs.

## PHASE 10 — REMOVE SOCIAL MEDIA SEARCH

Confirm Social Media Search / Social Media Research is removed from the
CURRENT public service offering.

Audit:
- homepage
- navigation
- footer
- metadata
- sitemap
- structured data
- public intake choices
- FAQs

Do NOT destroy historical case records using that older service type.

## PHASE 11 — SECURITY / ROLE BOUNDARIES

Re-audit server-side boundaries.

Standard Investigator must not receive:
- client/carrier identity unless explicitly permitted
- adjuster contact
- client billing
- invoice data
- margin
- Admin notes
- other investigator pay

Do not rely only on hidden UI.

Re-check the historical-record OWNER DECISION already recorded: investigators
may retain their own historical submitted work where allowed, but must not
regain live client/case information after reassignment.

Use existing decision/guard tests.

## PHASE 12 — RESPONSIVE / BROWSER VISUAL PASS

Use browser tools if available.

Inspect live/current implementations at:
- desktop
- laptop
- tablet
- iPhone-size viewport

Specifically inspect:
- Dashboard
- Leads & Intakes
- Rate Sheets
- Private send wizard
- Private payment flow
- Insurance send flow
- Case Overview
- Activity
- Evidence
- Report
- Case Build
- Active Surveillance Mode
- Invoices
- public Insurance page

Look for:
- tiny helper text
- overcrowded cards
- horizontal overflow
- duplicate controls
- confusing next steps
- dead buttons
- poor mobile tap targets

Fix verified usability defects without unnecessary redesign.

## PHASE 13 — CODEX INDEPENDENT REVIEW

Use Codex as an independent reviewer across these areas:

1. permissions/client-data boundaries
2. rate-sheet/intake pairing
3. Private Cash App/Venmo boundary
4. payment-status logic
5. report/evidence packaging
6. invoice state/accounting
7. Active Surveillance Mode
8. SEO public/private route exposure
9. unsafe HTML/URL escaping
10. regression test completeness

Treat Codex findings as reviewer claims until verified.

Do not blindly implement them.

## PHASE 14 — TEST / SHIP DISCIPLINE

For each meaningful work unit:

1. inspect current implementation
2. reproduce missing/broken behavior
3. failing regression test first when practical
4. smallest correct fix
5. run relevant suites
6. Codex review where appropriate
7. address verified findings
8. rerun tests
9. update NEXT.md / RECONCILIATION.md
10. commit / PR / merge / rebase using the existing repo workflow
11. continue to the next item

Do not stop just because one item is complete.

## AUTO-CONTINUE

Continue through the reconciliation queue automatically.

You MAY autonomously:
- read/search code
- run tests
- make routine code fixes
- make UX fixes clearly required by these handoffs
- update NEXT.md / RECONCILIATION.md
- run Codex read-only reviews
- create normal regression tests
- follow established PR workflow

STOP and ask the owner only for:

- destructive schema/data migration
- deleting/overwriting evidence
- credentials/secrets
- changing client RATE amounts
- legal/compliance wording decisions
- irreversible production actions
- a genuine product-policy decision not already covered by owner
  decisions/handoffs

## FINAL RECONCILIATION

Do not call this finished until you can produce:

DONE
PARTIAL
MISSING
DEFERRED — OWNER DECISION
TEST COUNTS
CODEX FINDINGS VERIFIED
LIVE BROWSER CHECKS
NEXT

Also update NEXT.md so a brand-new Claude Code session can resume without
needing this conversation.

Additionally, list what you changed in CLAUDE.md. That file has drifted from
the code in at least two places (see the addendum), and it is the file every
future session reads first. A reconciliation that fixes the code and leaves
the map wrong has only moved the problem.

The finished product should feel like ONE connected system:

PUBLIC WEBSITE
→ Rate Sheet / Intake
→ Leads
→ Admin Case
→ Investigator / Active Surveillance
→ Activity
→ Report
→ Evidence
→ Case Build
→ Invoice / Payment
→ Completed Case

The portal should feel less busy as functionality grows, not more busy.

---

# SECTION 2 — ADDENDUM: REPO FACTS THAT OVERRIDE THE DOCS

Verified against master `aa107b4` by direct inspection, 2026-08-15.

**CLAUDE.md is STALE in at least two places.** Where this addendum and any
`.md` disagree, the CODE wins. Correct CLAUDE.md as part of this pass.

### 1. robots.txt — do NOT add the portal to it

Phase 9 says "audit robots." `case-portal/verify.sh`, run by
`harden-check.yml` against the LIVE site weekly, fails if robots.txt
advertises the portal. `/portal/` and `/watch/` are kept out of search by
`noindex` plus `X-Robots-Tag` in `_headers`, **not** by robots.txt. Adding
`Disallow: /portal/` both announces the thing it hides and breaks the weekly
check. robots.txt must not contain the word "portal" at all, comments
included.

Current robots.txt is four lines: `User-agent: *`, `Allow: /`, blank, and the
sitemap line. That is correct. Leave it.

### 2. No prices in `intake/index.html`

CLAUDE.md's "The rate card" section describes `PACKAGES` and `HOURLY`
constants (4hr $400 / 8hr $800 / 16hr $1,500 / 24hr $2,200). **Those constants
no longer exist** — they were removed with the payment step. A test fails if
any dollar figure appears anywhere in that file. `FIRM` carries a comment
saying so explicitly. Do not restore them. Delete that section of CLAUDE.md.

### 3. Phase 2 is greenfield — there are no existing payment handles

Cash App and Venmo appear nowhere in the code. `FIRM` in `intake/index.html`
carries none; the only hits repo-wide are prose in CLAUDE.md and one demo row
in `portal/index.html` (`payment_method: "venmo"` in the worked example). So:

- Nothing to reuse, nothing to "swap."
- Do NOT seed defaults, do NOT recover handles from git history — the old ones
  were the owner's **personal** accounts — and do NOT invent payment URLs.
- Handles must arrive from the owner into the new admin-only Settings. Build
  the config UI and leave it **empty**. Ship the send flow disabled until
  handles exist, and **stop and ask the owner** for business-account handles.
- A send flow that emails a personal Cash App handle to a client is precisely
  the failure to avoid.

### 4. Phase 4 is an audit, not a rebuild

**"Ready to close" and "Outstanding" cards already ship** —
`portal/index.html` ~1150, ~1203, ~1061. CLAUDE.md's claim that closure cards
are "deliberately absent" is stale. Audit hierarchy and busy-ness; do not
rebuild working cards. Keep the no-fake-zeros rule: a card whose data does not
exist yet stays absent rather than showing 0.

### 5. Schema: side tables, never ALTER TABLE or a widened CHECK

`schema.sql` is re-applied on every `portal-setup` run, so
`ALTER TABLE ADD COLUMN` and a widened CHECK constraint are **not
idempotent**. Editing a CHECK in place leaves a **fresh** database accepting a
value the **live** one refuses — passes every test, fails only in production.
Phase 2's payment-method recording and any new status go in a companion table.
Follow the existing pattern: `build_custom`, `activity_removed`,
`invoice_retainer`.

After any push that changes `schema.sql`, dispatch `portal-setup.yml` or the
live D1 will not have the new tables.

### 6. Serialize writes on the big three

`case-portal/worker.js`, `portal/index.html` and the two suites are enormous.
Fan out on **reading** and auditing; **one agent at a time on writing**. A
parallel edit that loses fails **silently** — a `str.replace` matching nothing
still writes the file. Never run two Playwright suites at once; they bind the
same port.

### 7. Generated files — Phase 9 touches these

`private-investigator/**` and `sitemap.xml` are generated by
`build-locations.py`. Edit `PLACES` in the script, run
`python3 build-locations.py`, confirm `git status` is clean. Never hand-edit
the generated HTML or the sitemap.

### 8. Already fixed — do not re-fix

Both invoicing retainer findings — the retainer invoice consuming the retainer
it bills, and create-from-retainer ignoring the case's own amount — were fixed
by **PR #69 (`c60a584`)** and re-verified against `worker.js` ~2214-2229 and
~2357-2373. `RECONCILIATION.md` marks them FIXED with that evidence.
Everything else in OPEN FINDINGS is still an unverified reviewer claim.

### 9. Phase 7 (Dropbox) is blocked on the owner

Needs `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` as
repository secrets; `portal-setup` pushes them all-or-nothing. Build it, but
do not report it VERIFIED without them. List it as DEFERRED — OWNER DECISION.

### 10. Expect a stop in Phase 9

"Serving ALL of Virginia since 2014" versus location pages deliberately scoped
to about an hour's drive. Phase 9 forbids fake coverage claims. That is an
owner decision already flagged in `NEXT.md` — surface it, do not resolve it.

### 11. Never call an unnarrowed Actions listing

`list_workflow_runs` returns ~460 KB for one page and ends the session. Use
`pull_request_read` with `get_status` or `get_check_runs` instead. See
CLAUDE.md's "Read this before querying GitHub Actions."
