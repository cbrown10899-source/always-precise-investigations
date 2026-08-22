# MASTER RECONCILIATION — 2026-08-21, master `2f96b23` (INTERNAL)

Ordered by the owner after Unit 17 shipped: *"Run a MASTER REQUIREMENTS
RECONCILIATION before creating Unit 18… Do not assume the numbered unit list
contains every requirement."* Read-only: no code, no branches, no deploys.

**Sources read in full:** CLAUDE.md, NEXT.md, this file, MASTER-HANDOFF.md
(§1–§43), WORK-ORDER.md, HANDOFF.md, PAYMENTS.md, INVOICING.md, INTAKE-OPS.md,
SURVEILLANCE-VOICE.md, PORTAL-OPS.md, UXSIMPLIFY.md, WORKFLOW-SIMPLIFICATION.md,
LEGAL-INTAKE.md, RATESHEETS.md, PROFILES.md, plus every 📌 unit report.

**How a verdict was reached:** every load-bearing claim was traced to a route,
a table, a test or a workflow run — the standard this file was written to
enforce. Four parallel readers produced the claims; the ones that decide the
queue were then re-verified by hand and are marked *(verified directly)*.

## The 2026-08-14 findings tables below are STALE in four rows

Re-verified against today's code. `A backward status transition reopens a paid
invoice` and `That same revert erases a live receivable` are marked OPEN in the
INVOICING table while **this same file records both FIXED at HIGH #3**;
`setInvoiceStatus` refuses `draft` and `ready` once any payment exists
(`worker.js` ~6897-6904, pinned by *"An invoice with money against it cannot be
put back to draft"*). The two SURVEILLANCE HIGH rows are stale the same way —
recorded FIXED and VERIFIED above, still marked OPEN below. When the PACKAGING
HIGH rows were updated to ✅, these four were missed. **They are corrected in
place below.** A findings table nobody reconciles is the same failure mode as a
red workflow nobody reads.

## What is genuinely still open from those tables

Nine findings survive verification. Ranked by whether a person actually hits
them:

| Finding | Reaches | Evidence |
| --- | --- | --- |
| An overpayment is accepted and **cannot be reversed** | the client's document | No ceiling (`worker.js:6957` checks only `> 0`); `invoice_payments` has INSERT and SELECT **only** — no void, no reversal route exists (verified directly); `#invdoc` prints `usd(i.balance_due)` raw at `portal/index.html:14487`, so an overpaid invoice reads **"Balance due $-500"** while the retainer block one row below handles negatives with `Math.abs` |
| Unsent **drafts** draw down the retainer | the client's document | `worker.js:6584-6586` sums siblings `WHERE status != 'void'`, including drafts, while `outstanding` excludes them (`:6766`). **This is what CLAUDE.md documents** ("every live invoice") and E2E-39 asserts it deliberately — so it is an owner decision, not a defect (verified directly) |
| Chronology shows **removed** entries unmarked | the office | `portal/index.html:10292` lacks the `!e.removed_at` filter the timeline (`:9571`), field view (`:13857`) and summary builder (`:10016`) all have |
| A day approved **after finalize** is invisible, while `/completed` counts it | the office | `daysPanel()` only runs for a draft build (`:11741`); the Worker already sends `available_reports` for a finalized one (`worker.js:8916-8919`) and it is never drawn. `/completed` counts approved reports, `/delivery-center` counts `build_reports` — the two desks disagree |
| **Video exhibit numbers** contradict each other in one document | the client | Section prints `Video ${i2+1}` (`:12071`), index prints `Video ${r.n}` from a global sequence (`:12079`); photos use `r.n`, so only video diverges |
| **Documents always reads 0** | the office | Page filters `role === "document"`, the Worker writes `'attachment'` (`worker.js:11722`) |
| Void invoices report cash in **Paid this month** | the office | `worker.js:6771` reduces over `full`, not `live` |
| Removed days come back at finalize | API only | `worker.js:11753-11766` re-seeds when zero are attached; the page cannot remove the last day |
| `nextInvoiceNo` wedges past 9999 | 10,000 invoices/year | Lexicographic TEXT ordering on a `NOT NULL UNIQUE` column |

`case_builds.report_id` pointing outside `build_reports` is **FIXED** — the
remove route repoints it (`worker.js:11613-11621`, pinned by *"and the primary
report moves to one still in the package"*).

## Requirements the numbered queue does not contain

Found by reading the handoffs rather than the queue, as instructed:

- **Real Intake Alerts** (INTAKE-OPS §1) — PARTIAL. Wired at both intakes,
  `TEST-` guarded, email delivering. Two requirements unmet and not deferred:
  the alert never says **Private or Insurance** (`alertText(event, caseNo,
  channel)` takes no category — verified directly), and a **failed send is
  invisible** (`notifyAdmins`'s catch returns `{sent:0,reason:'error'}` and all
  eight callers discard it — verified directly). SMS and the queued/sent/failed
  status log are **owner-deferred** by name.
- **Invoice payment idempotency** — MISSING, and undeferred. `recordInvoicePayment`
  takes no token and `invoice_payments` carries no unique index, while the
  retainer path has both a token table and a void route (verified directly).
- **A deduplicated retainer payment still alerts twice** — `worker.js:12244-12248`
  notifies on `'duplicate'` as well as `'recorded'` (verified directly). Money
  is idempotent; the notification about it is not.
- **`include_intake` sends a law firm the PRIVATE door** — `emailSheet` builds
  the bundled link from `SHEET_INTAKE[sheet.id]`, and a legal case's sheet id
  IS `private_retainer` (`worker.js:1350`, `:1451`, `:2584` — verified
  directly). `intakeForContext()` exists three lines above and the other two
  intake routes use it; the comment at `worker.js:855-858` states the very rule
  being broken. Untested: no test pairs `include_intake:true` with a legal case.
- **PORTAL-OPS phases never built**: cross-case Tasks view (4), Quick Actions
  +NEW (6), Saved Views (9), Case Templates (12), Document Templates (13),
  Audit Trail screen (14). Phase 11's Case Health flag is **owner-deferred**;
  Phase 10's notification bell is **superseded by design** (Unit 8 refuses a
  dismissal mechanic on principle). PORTAL-OPS item 10 (Permissions) is
  **corrupted and never re-sent — blocked on the owner.**
- **File Queue layout** — recorded, explicitly unbuilt, never queued.
- **Accessibility** — no dedicated pass has ever run. Real coverage exists
  (WCAG contrast on 15 token pairs, focus-visible, colour-never-alone, 37
  `aria-` attributes) but no keyboard-path or screen-reader walk.
- **Voice §9 audible confirmation tone** — the only unbuilt line of
  SURVEILLANCE-VOICE; on-screen confirmation ships.

## OUTCOME — the queue this reconciliation produced (owner, 2026-08-21)

The owner approved this reconciliation and recorded a durable master unit
queue. **The queue itself lives in `NEXT.md` under "DURABLE MASTER UNIT
QUEUE"** — that is the file a fresh session reads, and it is the copy to keep
current. Recorded here so the findings below can be traced to what was decided
about them:

| Finding in this report | Where it went |
| --- | --- |
| `include_intake` sends a law firm the private door | **HOTFIX 17A**, ahead of Unit 18 |
| Invoice payment idempotency; overpayment accepted and irreversible; `Balance due $-500`; void invoices in Paid this month | **Unit 18 — Invoice Payment Integrity** |
| Removed entries unmarked in Chronology; day approved after finalize; video exhibit numbering; Documents reads 0 | **Unit 19 — Package + Report Accuracy** |
| Alert never says Private/Insurance/Legal; failed sends invisible; deduplicated retainer payment alerts twice | **Unit 20 — Intake Alert Completeness** |
| No accessibility pass has ever run; Voice §9 audible tone unbuilt | **Unit 21** |
| Six PORTAL-OPS phases never built | **Unit 22** |
| Everything IMPLEMENTED BUT NOT LIVE VERIFIED | **Unit 23 — one consolidated sweep**, never reopened as development units |
| File Queue layout, recorded and unbuilt | **Unit 24 — REQUIRED**, explicitly not droppable as optional polish |
| The role-boundary and authorization surface | **Unit 25** |
| This document's own successor | **Unit 26 — final reconciliation and closeout ledger** |

**Findings deliberately NOT queued**, because the owner keeps them deferred:
`nextInvoiceNo` past 9999 and the API-only "removed days come back at
finalize" remain recorded but unscheduled; SMS, the alert-status log, Intake
Archive Part 2, invoice Write-Off, the Case Health flag, physical destruction,
retention clocks, Dropbox byte deletion, the legacy R2 export and two-person
hold approval all stay on the parked list in `NEXT.md`. **A deferred item is
never converted to "completed" and never deleted from the record.**

**Unit 17's LIVE VERIFIED is DEFERRED**, not open: the owner will verify it on
a suitable real case, and *no production case is to be manufactured for the
test.*

**Fully answered as of 2026-08-21: `ready` is unsent too** — *"Ready/Reviewed
but not yet sent still counts as UNSENT and must NOT reduce the client-facing
retainer."* Shipped with the excluded set `('void','draft','ready')`.

**The unsent-draft retainer question is now ANSWERED** (owner, 2026-08-21, after
this report classified it as a decision rather than a defect): *"UNSENT or DRAFT
invoices MUST NOT reduce the client-facing retainer balance. Only
finalized/issued billable work may affect the client-facing retainer figure."*
So the finding above changes category — from "owner decision, not a defect" to
**a defect with a decided answer**, owned by Unit 18. Three things move
together, because all three currently state the old behaviour: the sibling sum
in `worker.js`, the paragraph in CLAUDE.md, and the E2E-39 assertion.

**Reassigned-investigator visibility is also answered** and recorded as a
durable authorization rule in CLAUDE.md: a reassigned investigator must not
automatically see the prior investigator's hours, compensation or billing
detail through any surface — case-scoped reads, API responses, UI payloads,
exports, reports or hidden fields. Admin sees all; an investigator sees only
their own. **No permission toggle is to be invented for it**, since the
PORTAL-OPS Permissions specification that might call for one has never
arrived. Enforced when the permissions/security work is reached, or sooner if
an audit proves an active leak.


## 🔒 OWNER DECISIONS — 2026-08-21, public site (Unit 34)

1. **Public Legal / Law Firm page — APPROVED and BUILT.**
   `/legal-investigations/`, in the established navy/white/gold/teal system,
   aimed at attorneys, paralegals and legal departments. CTAs: *Submit an
   Assignment* → `/intake/?assignment=legal`, and *Contact Investigations*.
   **A legal visitor is never routed through the private-client intake.**
2. **NO PRICING PUBLIC — decision CHANGED.** Private, Insurance and Legal:
   no rate sheets, retainers or dollar figures anywhere public, including
   navigation, sitemap, structured data and View Source pointers. The internal
   Rate Sheets system and the admin private-send flows are untouched.
3. **Canvassing, interviewing and recorded statements removed** from all public
   copy, metadata and structured data, Insurance FAQ included. Replaced with
   activity documentation and factual investigative reporting — services the
   firm already provides. **Nothing internal was deleted:** case notes,
   evidence and reports keep those words where the work legitimately uses them.

Asserted against the staged bytes in `.github/test-deploy.mjs` (81 checks).

## PRODUCTION TRUTH AUDIT AND CORRECTIONS — 2026-08-21, Units 28–33

**The owner opened the portal and the Legal Rate Sheet was not there.** That
one observation invalidated the method every reconciliation in this file had
used: a feature was being called complete on the strength of code, routes,
tables and earlier notes. A route is not a door.

The audit re-checked every claimed feature across five layers — code exists,
API works, UI visible, normal navigation reaches it, the action works — and
found nine discrepancies. All are now closed or classified; the full table is
in `FINAL-LEDGER.md` PART 6B.

**Shipped:** Unit 28 Legal pre-case access (#221) · Unit 29 invoice defaults
(#222) · Unit 30 case types (#223) · Unit 31 internal-route classification
(#223).

**Nothing was removed in Unit 31, and that corrects the audit that ordered it.**
`/pricing`, `/external-storage` and `/profiles/match` all turned out to be
TESTED AUTHORIZATION BOUNDARIES. I had classified `/external-storage` as a dead
route on the strength of "no page reference" — the same error as "a route
exists so the feature is done", pointing the other way. Neither the presence
nor the absence of a UI link is evidence on its own.

**Still open by the owner's instruction:** a public Legal / Law Firm website
page and CTA. Recorded, not built.

## FINAL OWNER DECISIONS — LOCKED 2026-08-21, at project closeout

**This report's own successor was Unit 26, and these five answers close the
questions it raised.** Verbatim, and durable — none of them is a pending
question any more. The full block, with what each means operationally, is in
`NEXT.md` under **FINAL OWNER DECISIONS**; the classification is in
`FINAL-LEDGER.md`.

1. *"PORTAL-OPS Permissions remains missing and must not be invented. Rebuild
   later from owner direction."* → **MISSING — SKIPPED by owner direction, not
   a closeout blocker.** This closes the line above ("blocked on the owner")
   and the OWNER-DECISIONS row: it stays marked missing, and **must not be
   inferred, reconstructed or approximated** from the corrupted text. The
   no-invented-permission-toggle rule beside it is unaffected and still holds.
2. *"Saved Views remains a future optional operational improvement; do not
   block closeout."* → **DEFERRED BY OWNER.** Its heading is still `[inferred]`
   and its Billing item still corrupted; neither is to be guessed at.
3. *"Case Templates / Document Templates may use a reusable mechanism later,
   but owner supplies the actual firm content. Do not invent templates."* →
   **DEFERRED BY OWNER.** The mechanism may come later; the content is the
   firm's own and is never authored here.
4. *"If Admin or another authorized user ends someone else's surveillance day,
   the UI/history must clearly say Ended by Admin or Ended by [name]. Never
   make it appear the original investigator ended it."* → ✅ **BUILT — Unit 27.**
   This answers the 2026-08-16 non-blocking finding *"whether the ended day
   should be marked somewhere as 'ended by the office'"* — the answer is yes,
   and that finding is now CLOSED. The gap was real and was verified on master
   `5e1d063` before it was closed: `case_days` had no `ended_by` column and
   `endDay` wrote none, so an office-ended day was stored identically to a
   self-ended one. `case_day_end` is the additive companion table that records
   who ended each day and their role at that moment; `dayEndLabel()` is the one
   writer of the wording; a day with no record reads *"Ending actor not
   recorded"* and never as self-ended, so every day ended before it shipped
   stays readable. Authorization was not touched — `openDayForAction` already
   required `caseFor` and the admin role, and a test pins that an investigator
   still cannot end another's day. **The `portal-setup.yml` dispatch has RUN** —
   run 32508101361 at `74629fe`, ✅ success, including the admin-bootstrap step
   that failed at `46a06ad9`. `case_day_end` is on the live database and no
   schema is owed.
5. *"Keep current Cash App $TreverB and Venmo @Trever-Brown-9 for now.
   Business-account migration remains a future owner decision."* → **DEFERRED
   BY OWNER.** Supersedes the earlier "answered for now" wording; the handles
   are unchanged and the migration stays a future decision.

**Unit 17 and Unit 23 remain LIVE VERIFICATION DEFERRED** until suitable real
case data exists — reaffirmed at closeout, with the standing instruction that
no production case or data is manufactured for either.

**The deferred list is unchanged and nothing on it was converted.** A deferred
item is never turned into a completed one and never deleted from this record.

## Corrections to the record

- **§38 / §39 are NOT stale.** The tracker says the full Insurance and Private
  walkthroughs were "done 2026-08-14" and never re-run. They are living tests —
  `End to end: a carrier assignment, sheet to completed` and `End to end: a
  private client, sheet to completed` — 24 tagged assertions running on every
  suite invocation, green at 2544/0 (verified directly).
- **RECONCILIATION §Q ("Dropbox NOT IMPLEMENTED") is stale** — true on
  2026-08-14, superseded by #172/#174/#189. The delivered shape is
  device-first by the owner's 2026-08-17 decision, so §14's "create share link"
  was deliberately never built; a test asserts no sharing call exists.
- **UXSIMPLIFY.md's ledger says "not started" for all five phases** — stale;
  UIBUILD.md superseded it the same day and reports all eight phases done.
- **INTAKE-OPS.md's header says "Neither is coded"** — stale for §1 (alerts are
  substantially built), still true for §2 (archive).

---

# MASTER RECONCILIATION REPORT — 2026-08-14 (INTERNAL)

Ordered by the owner via the ChatGPT audit prompt, after screenshots suggested
the rate-sheet intake checkbox was "not visible in the live Portal." This
report answers that item at every layer first, then reconciles the master
handoff requirement by requirement — **against code, routes, tests and the
deploy pipeline, never against PR titles.**

**How "Live?" is judged:** this build environment's proxy cannot reach the
live domain, so live state is established by: the deploy workflows for the
exact merged SHAs finishing green (verified per merge, all green through
`538e128`), `deploy.yml` rsyncing the repo root byte-identical (the portal is
a single static HTML file with **`Cache-Control: no-store`** — a stale cached
portal is impossible), and the Worker deploying from the same tested source.
Where that chain is the evidence, Live? says **pipeline✓**. The owner's
30-second confirmation paths are given inline.

---


## Session close, 2026-08-15 — state at master `4e053c2`

Recorded on the owner's stop-at-clean-handoff instruction. **NEXT.md carries
the live queue; this is the evidence line for what closed today.**

| Claim | Evidence |
| --- | --- |
| Retainer payment cannot be recorded twice, lost, or falsely acknowledged | #107/#108/#110/#112/#114/#116/#118 — payment and token in one `batch()`; "already recorded" proven by a payment row on **this case**, never by the claim alone; a legacy claim answers `payment_indeterminate` with a pressed recovery rather than a guess. Worker 997 |
| A blank amount cannot mark a case received | #114 — control prints the false success verbatim: *"Payment recorded. The retainer now reads as received."* |
| Page state does not cross a case or a session | #116/#118/#120/#122 — `retainerEnter` clears on a **different** case only; `sessionForget()` on sign-out **and** on 401. Before #120 the next sign-in landed in the previous user's case, drawn from their data |
| A private client is sent the retainer their case agreed | #123 — control prints the bug: subject `$1,500 Retainer — … (case API-RET3K)` on a $3,000 case. **Worker half not live-verified** (auth precedes routing) |
| The mobile menu button is reachable | #123 — **50x50 measured on the production page**, from **38x35** |
| Virginia coverage wording | **RESOLVED by the owner.** Was open in three files; struck from all three |

**What is NOT closed:** the custom retainer **selector** (nothing on screen
sets $2,000 or $3,000), the live-Worker proof of the $3,000 sheet, and
everything below it in the queue. See NEXT.md → NEXT UNFINISHED ITEM.

## 0. THE HEADLINE ITEM — rate sheet → correct intake, all layers

ChatGPT's hypothesis was "backend pairing built, control never surfaced."
**That is not what happened.** The control existed, was labeled by name, and
was E2E-tested — but it lived on a second wizard step called *Options*. To
see it you had to open the sheet, start the send, type a recipient, and click
Next. **A control you must click Next to discover is not a visible option.**
The owner's report was correct in substance; classification: 🟡 visibility —
**fixed today**.

| Layer | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| UI | Admin can SEE and select "Include Insurance Assignment Intake Form" | ✅ (was 🟡 buried) | `#wiz_inc` now renders on the wizard's FIRST screen with the label "Include the **Insurance Assignment Intake** form link"; the sheet page itself says the option exists before the wizard opens. E2E: "the intake checkbox is on the FIRST screen, visible before any click" |
| UI | Same for "Include Private Client Intake Form" | ✅ (was 🟡 buried) | same control; label from `intakeLabel` ternary; leads-desk path asserts the private sheet wizard |
| Logic | Sheet maps to the correct intake type | ✅ | `SHEET_INTAKE` in `worker.js`, keyed by sheet id **server-side** — the page sends only a boolean, so cross-pairing is impossible by construction |
| Email | Outgoing message contains the correct link | ✅ | worker tests assert the URL in **both** MIME parts: insurance → every `/intake/` occurrence carries `?assignment=insurance`; private → `?assignment=private`, never the carrier door; unticked → no link at all |
| E2E | Both paths exercised | ✅ | portal e2e walks open → checkbox → preview names the intake → send; worker tests send both sheets through the mocked provider and inspect the actual payload |
| Live | Visible in production | pipeline✓ | deploy green on merge; `/portal/*` is `no-store` so no cached old UI. **Owner check (30s): Rate sheets → open either sheet → "Send this sheet →" — the checkbox is on the first screen of the send panel** |
| Strict pairing | No cross-path possible | ✅ | the carrier can never receive the picker (tested); the private client can never be offered the carrier path — `?assignment=private` drops it and `pickSvc('claims')` is refused even called directly (tested) |

One genuinely missing piece found by this audit's own list: **Send history —
🔴 → ✅ fixed 2026-08-14.** `send_log` records every rate-sheet and intake
send: recipient, which sheet, **which door actually rode with it**, who sent
it, when — and failures are kept and shown as failures, because a send that
vanished silently is how "I sent that last week" becomes wrong. Shown in the
case's Comm log under *Sent from the portal*, counted on the lead card.
Admin-only; an investigator is never told who the client was emailed.

---

## A. Rate sheets — figures and wording

| Exact requirement | Status | Evidence |
| --- | --- | --- |
| Insurance 8/16/24 h = $1,200 / $2,300 / $3,300 | ✅ | `RATES.packages`; floor guard test fails below $125/h, floor written twice on purpose |
| Additional authorized hours $150/hr | ✅ | `RATES.surveillance.standard`; overage wording "never without written approval" |
| Recommended 24-hour authorization | ✅ | badge on the 24 h line (`badge` field) |
| No preferred-band / rack-rate / discount math / margin on client copy | ✅ | client sheet built from client lines only; internal strategy lives in `PRICING.md`, excluded from deploy |
| No "Additional Fees — None" presentation | ✅ | inclusive prose ("mileage, travel time… are included"), not a nil line item |
| Private $1,500 retainer, $100/hr, 4-hour minimum, applied-to-work, approval for more | ✅ | `PERSONAL` in `worker.js`; sheet copy carries each |
| Send workflow: recipient / options / preview | ✅ | one-screen ask + preview (today's change) |
| **Send history** | ✅ **done 2026-08-14** | `send_log`; Comm log panel + lead-card count; failed attempts kept and marked |

## B. Public intake forms

| Requirement | Status | Evidence |
| --- | --- | --- |
| Insurance intake | ✅ | `/intake/?assignment=insurance`, picker dropped, 8-step claims path |
| Private intake | ✅ | `/intake/?assignment=private` (built 2026-08-14): picker keeps the two consumer services, carrier path not offered, `pickSvc('claims')` refused directly |
| Not-available states | ✅ | `naBox()` / `applyNaStates()` / `<field>_status` beside **empty** values; test scans every value field for "N/A"/"unknown"/0000/placeholder dates |
| Not-applicable | ✅ deliberate non-build | exists in the model, offered nowhere — nothing on either form is meaningfully N/A rather than unknown (`INTAKE-NA.md`) |
| Server validation accepts the states | ✅ | ingest stores statuses; worker tests |
| Forward/back persistence | ✅ | `val` map + `capture()`/`restore()`; the switching-service e2e depends on it |
| Final review PROVIDED vs NOT AVAILABLE YET | ✅ | `naSummary()`; e2e |
| Mobile behavior | ✅/🧪 | headless mobile viewports tested; **real iPhone/Android remains the owner's pass** |

## C. Returned intake review

| Requirement | Status | Evidence |
| --- | --- | --- |
| New intake visible, compact summary, full view | ✅ | leads desk cards + case workspace |
| INFORMATION STILL NEEDED / Provided vs Not available | ✅ | intake detail panel renders statuses |
| Request more information | ✅ deliberate shape | opens the Comm log (the record that IS the request) rather than sending an automated email — recorded in `INTAKE-NA.md` |
| Accept / decline / save lead / create case | ✅ | leads desk + `nlSave` + assign flow |
| **Requested vs Confirmed authorization** | ✅ | both labels rendered and tested; only *Confirmed* is ever paired with money (24 h → $3,300 admin-side) |

## D. Manual admin intake

All present: kind choice, save lead, create case, and — since PR #61 — **Send
Rate Sheet and Send Intake on the lead card itself**, sheet chosen by the
lead's kind server-side, sends auto-stamping the lead. Same `submissions`
table as public intakes (no parallel store). ✅

## E. Lead / client history

| Requirement | Status | Evidence |
| --- | --- | --- |
| Lead statuses (the nine) | ✅ | `lead_status` table + card select; system stamps only what it did; decided leads never quietly moved |
| **Event timeline** (created → sheet sent → intake sent → received → accepted → case) | ✅ mostly (2026-08-14) | `send_log` is the per-event trail for everything the system sends, with `created_at` and the status stamps either side of it. What remains unlogged is purely manual status changes (contacted, declined) — those show current state, not a history of hand edits |

## F/G. Case package cards and completion

Every block routes (`pkgJump` → real `MOD_TAB` target), Continue Case is the
computed next step, **no dead controls** (tested). The ring **already
excludes video when a case has none** — `if(p.videos > 0)` is the only way
video joins the denominator. ✅

## H/I. Quick reporting and activity → report

Vocabulary now carries the full §10 physical-observation set, a Surveillance
category, favorites, search, one-tap No Change, free-text custom entry, and
every generated line is editable before save (nothing auto-submits). ✅
Activity → report is a **data relationship, tested**: `generateReport()`
builds the draft from `activity_log` rows (the §38 walkthrough asserts the
field's own words appear in the draft) and removed entries are skipped.
**Remaining 🟡: the arrival sentence generator** (vehicles present / view /
route composing a narrative) — deliberately left for the owner's wording.

## J/K. Report submission and review

Submit preserves an immutable snapshot in `report_versions` (test: a later
admin edit never touches a submitted version); status changes queue it for
review; admin can approve / return for revision / edit the working copy;
Versions tab shows submitted snapshots; print-to-PDF via `repPrint`. ✅
(One shape note: "download submitted PDF" = open the version and print —
there is no separate stored PDF file, here or anywhere; see M.)

## L/M/N/O. Case Build, the PDF, the index, multi-day

| Requirement | Status | Evidence |
| --- | --- | --- |
| Six steps actually act | ✅ | §38 walkthrough drives create → items → package → finalize; gates tested by name |
| **Report + photos as ONE professional document** | ⚠️ by-design | the package document is real — masthead, case information, objective, per-day chronology, embedded photos with captions, video listing, evidence index — and becomes a PDF via the print stylesheet (browser Print → Save as PDF). **No server-side PDF file is generated anywhere in the system.** This is deliberate (no dependencies, no stored copies of evidence); if the owner wants downloadable .pdf files without the print dialog, that is a new feature to order, not a bug |
| Evidence index | ✅ | Exhibit / Time / Type / Description / Delivery table in the document |
| Multi-day | ✅ | `build_reports` set, Day 1..n sections oldest-first, derived Combined Summary facts + admin's own paragraph, later-approved day offered never dropped (PR #56, tested) |

## P. Completed cases

Built 2026-08-14 (PR #60): All/Open/Completed lens; the desk lists every case
whose stage is complete/closed **or whose package is finalized**; cards offer
Open case / Final report (day count) / Evidence (count) / Client package /
Invoice (number) / Copy video link — each only where the artifact exists.
Downloads live one tap in, on the tab that holds the print. ✅

## Q. Dropbox — the item the prompt was most suspicious of

**🔴 NOT IMPLEMENTED, and — important — never misrepresented.** The screen
does NOT say "Dropbox — Active"; it says *"Dropbox is not connected"* and
names the three Worker secrets. Upload/share routes return 503/501 with the
reason. Provider abstraction (`external_files`, generic fields) is real;
auth, upload, share-link create/revoke are not built. **Blocked on the
owner's `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN`.**

## R/S. Invoices and BILL

Everything on the prompt's list is real and tested: create from case and
from authorization, sequential server-side numbers, both field sets,
lines/terms/due date, print document, draft→ready gate with named problems,
sent-to-BILL ≠ paid, partial payments, **overdue computed against today**,
void locks and releases the retainer, balance always derived, audit trail,
duplicate warning with explicit confirm. BILL fields all present:
`external_invoice_id` / customer / status / `sent_to_bill_at` / payment
reference on payments; **Copy billing details exists** (`invCopy`).
Write-Off deliberately absent (owner's "if needed later"). ✅

## T. Active Surveillance Mode — audited subfeature by subfeature

Launch from case ✅ · top-level nav door (both roles) ✅ · same auth/case/DB,
no parallel tables ✅ · start/resume day ✅ · **server-derived timer** that a
reload, sleeping phone or wrong clock cannot move ✅ · **pause/resume with
server-recorded spans, frozen display surviving reload, breaks off the
billable hours** ✅ · quick add (activity/photo/video/note) ✅ · templates,
favorites, search, one-tap No Change ✅ · timeline with edit/remove/restore
(stamped, never erased) ✅ · speech: tap-to-speak, listening state,
transcript review, Use Text / Discard, **never auto-submitted**, honest
wording ✅ · photo `capture=environment`, video upload, auto-linked to the
latest entry ✅ · report draft from the day + handoff to submit ✅ (🟡 a
dedicated in-mode draft *reader* remains a nice-to-have) · bottom nav ✅ ·
case info drawer with remaining hours, never money ✅ · PWA manifest, icons,
`?surveillance=1` resume ✅ · admin Out Now with elapsed + last activity,
**no location** (payload asserted) ✅ · exit back to the portal ✅.
🧪 Real iPhone Safari / Android Chrome remain the owner's pass (camera
picker and device dictation cannot be exercised headlessly).

## U/V/W. Public website, social media removal, SEO

Hero names all three audiences; Submit an Insurance Assignment / Request a
Private Investigation are the primary paths through their own doors (guard
tests); How an Assignment Works added; claims card leads the grid with every
consumer service kept; portal login secondary. ✅ (🟡 the literal §29 section
order — dedicated Insurance/Private sections — is the owner's call, on the
morning list.) Social Media Search: **zero occurrences across every public
page, nav, footer, sitemap, FAQ and JSON-LD**, with a guard test. ✅ Titles,
descriptions, canonicals, OG and structured data present on the homepage and
all three service pages; `/intake/` gained description/canonical/OG
2026-08-14 (noindex deliberate — the link is *sent*, and OG is for the
preview). ✅ the "Serving ALL of Virginia" wording was RESOLVED by the
owner on 2026-08-15: both rate sheets say travel outside the normal service
area is quoted and agreed before the work is scheduled.

## X. Role security — server-side, tested by attempting it

An investigator, by direct URL/API: another investigator's case → 404; rates,
`/pricing`, `/sheets` → 403; invoices → 403; build surface → 403; completed
desk → 403; leads desk → 403; admin notes withheld; client identity absent
from every payload unless `show_client_identity` (default off, admin-only
route); money fields never in `FIELD_KEEP`; list rows redacted (proven on a
row they CAN see). The hostile-case-number XSS row is planted in the DB and
tested. ✅ — **770 worker checks, none of this by hidden buttons.**

### Addendum, 2026-08-14 — independent Codex review of this section

An independent reviewer (Codex, given the boundary as written and no sight of
this report) re-derived §X against master `f330105`. It **confirmed** the
controls above: `/submissions` is SQL-scoped at `worker.js:963` rather than
page-filtered; `FIELD_KEEP` is still a true allow-list with no intake field
bypassing it; the Worker and portal copies match at 23 fields in the same
order; `redactRow` drops all five denormalised client columns; `send_log`
never appears in an investigator payload; and no boundary anywhere depends on
hiding a UI element.

Two of its flagged items were checked and **rejected as findings**, recorded
here so they are not re-raised each audit:

- *"`show_client_identity` reveals carrier / claim number / client name."* That
  is §33 as specified — the toggle exists to do exactly that, is default off,
  and its route is admin-only. `CLIENT_IDENTITY_FIELDS` (`worker.js:954`) is
  deliberately narrow: who the case is for, never how to bill or reach them.
- *"Investigators receive money fields."* `/my/comp` (`worker.js:4681`) returns
  the caller's OWN hourly and mileage from `user_rates`, which §34 requires,
  and `/my/expenses` returns their own claims, which §35 requires. The money
  that must not reach them — client rate, margin, package price, invoices —
  does not.

One item **stands and is now an owner decision**, recorded in full in
`NEXT.md`: the `/my/*` and `/calendar` routes scope by who created a record
rather than by current assignment, so a reassigned investigator keeps seeing
that case's number (and `subject_name` on `/my/active`). No client identity
crosses; the question is whether the case should vanish entirely on
reassignment. **Behaviour deliberately unchanged pending the owner.**

One structural note, not a leak: case detail and workspace fetch the row and
then enforce assignment in Worker JavaScript (`worker.js:990`, `1159`) rather
than putting `assigned_to` in the SQL predicate. It fails closed, but it is not
the SQL-only shape this document claims elsewhere.

## Y. iPad / mobile

Headless coverage at 1112×834 and 390×844: burger + drawer, the surveillance
door, the case bottom bar measured numerically (53px targets, 14px edge
clearance), field mode end to end. ✅ 🧪 Real devices: owner's pass.

---

## The prompt's summary sections

**DEFINITELY COMPLETE** — rate-sheet pairing at all layers (checkbox now on
screen one); both intake doors; INTAKE-NA; leads desk with statuses and both
sends; case detail/activity/report/versions; Case Build incl. multi-day and
Custom; evidence + index; completed desk; invoices + BILL fields incl. copy;
Active Surveillance Mode per the subfeature table incl. pause; role security;
social-media removal; §29 hero/paths/how-it-works; §38+§39 as living tests.

**PARTIALLY COMPLETE** — lead event *timeline* (state exists, log does not);
§10 arrival sentence generator; in-mode draft reader; literal §29 section
order (owner's call).

**MISSING** — sheet **send history**; Dropbox integration (blocked on owner
secrets).

**PRESENT IN CODE BUT NOT LIVE** — nothing found. Every merge's deploys are
green and the portal is served `no-store`.

**PRESENT IN UI BUT NOT FUNCTIONAL** — nothing found. The two candidates the
prompt named (Dropbox badge, package PDF) are honest on screen: Dropbox says
*not connected*; the document really prints.

**NOT ADEQUATELY TESTED** — real-device behaviors only (camera picker,
device dictation, Face ID on /watch/).

## TOP FIXES, priority order (real ones — there are ten, not fifteen)

1. **Sheet send history** — one table recording sheet/intake sends (to, when,
   by whom, which door), shown on the sheet page and the lead. Also closes
   most of the lead-timeline gap. *(code, unblocked)*
2. **Lead event timeline** — render the same log on the lead card. *(with 1)*
3. **Arrival sentence generator** (§10) — needs the owner's wording taste.
4. **In-mode draft reader** — small reading surface, not a data path.
5. **Literal §29 homepage order** — owner decision, then trivial.
6. **Coverage wording** — owner decision, then trivial.
7. **Dropbox** — owner provides three secrets, then the real build.
8. **Real-device pass** — owner, with the current build.
9. **Stored PDF files** instead of print-to-PDF — only if the owner wants it;
   it is a product decision, not a defect.
10. **Write-Off** — when the owner says "needed now", as a side table.

*(1 is started next per the audit's own instruction that the rate-sheet area
be fixed first — the checkbox fix shipped with this report.)*

---

## OPEN FINDINGS from the five independent audits (2026-08-14)

Five reviewers were run in parallel, 2026-08-14, one per area: permission
boundaries, intake routing, report/evidence packaging, invoicing, and Active
Surveillance Mode. All five came back NOT CLEAN. The findings below are the
ones not yet fixed. Each was reported by its reviewer with a file:line
citation, but **none of these has been independently verified by the
orchestrator** — a reviewer's report is a claim, not a fact. Every item must
be verified against the actual code before any fix is written.

### THE HIGH QUEUE — work these in this order (owner's order, 2026-08-14)

Implementation of these is happening in the owner's **local Claude Code
session with Codex**, not from a remote session. Nothing below has been
started here.

**Every one is still a REVIEWER CLAIM.** Verify each against the actual code
before writing a fix — the reviewers were right four times today and wrong
about mutation coverage once, and one of today's confirmed bugs survived
precisely because two tests had encoded it as the rule.

| # | Finding | Severity | Where the reviewer put it | Why it leads |
| --- | --- | --- | --- | --- |
| **1** | ✅ **FIXED and VERIFIED 2026-08-14 (local session).** The claim was true — reproduced first, as a failing test, before a line was changed: a real four-hour day recorded **0 hours**. The reproduction is `test-worker.mjs` → *"A break cannot eat the day it was taken inside of"* (11 checks), which backdates `case_days.created_at` and the pause's `started_at` to real server instants and then files the day honestly. **The fix:** an open pause is closed at the instant the DAY ended — `created_at + span`, the same server timestamp the field timer already trusts — clamped so it can never close before it opened nor after now, instead of at `nowIso()`. A break beginning at or after the day's claimed end contributes nothing, which is the honest reading: they stopped working when the break began. `pausedMins` is now **clamped to the span** rather than the difference being floored by `Math.max(0, …)`, so `paused_hours` always equals what actually came off and the day-end screen can never name a subtraction that did not happen. A break genuinely inside the day still comes off it — asserted, so the fix cannot become a licence to stop subtracting breaks. Worker suite 809 → 820. **Note for whoever reads the old response shape:** on the buggy code the payload still *added up* (span 4 − paused 4 = 0), which is why nothing caught it. ~~**A running or open pause can record a real surveillance day as 0 hours.**~~ `span` is wall-clock minutes between the *typed* `start_time` and `end_time`; an open pause is closed at `nowIso()` and its **real** elapsed subtracted. The two are measured on different clocks. Pause at noon, end the day at 20:00 with an honest 12:00 end time → `worked = Math.max(0, 240 - 480)` = **0**. `Math.max` floors it silently. | HIGH | `case-portal/worker.js` ~1747-1766 (`endDay`); day-end screen pre-fills its end time at render, `portal/index.html` ~3972 | It destroys billable time silently, and `hours` is what authorization and invoices draw against. A wrong invoice is recoverable; a day recorded as zero is gone unless someone remembers |
| **2** | ✅ **FIXED and VERIFIED 2026-08-14 (local session).** True as reported, reproduced before it was fixed. `openDayForAction()` replaces the `caseFor()` + `investigator_id = user.id` pair on `pause` / `resume` / `end`: **your own running day stays yours** whether or not the case still is, and **an admin can close a day nobody else can reach**. A different investigator still cannot touch someone else's clock (409), a caller with no claim on the case still gets 404 — so nothing leaks whether a day runs on a case they cannot see — and hours stay credited to whoever worked them rather than whoever closed it. `test-worker.mjs` → *"A reassignment cannot strand a running day"* (11 checks). Worker 820 → 831. **This is also the KEEP decision applied to the one route where it matters most**, and it is why the two were worked together. ~~**Reassigning a case can strand a running investigation day.**~~ `pause`/`resume`/`end` are scoped to BOTH `caseFor()` and `investigator_id = user.id`, so after a reassign nobody — not even an admin — can close the day. It stays `end_time IS NULL` forever, permanently in Out Now, `hours` never written. `myActiveDay` has no `assigned_to` filter, so the old investigator is still offered it and lands in a permanently-loading screen. | HIGH | `case-portal/worker.js` ~1693-1734 (scoping), ~1020 (assign has no open-day check), ~3081 (`myActiveDay`) | No recovery path exists in the product at all. The only fix today is a hand-edit of D1 |
| **3** | ✅ **FIXED and VERIFIED 2026-08-14 (local session).** True as reported. `setInvoiceStatus` now refuses **both** unlocking statuses once any payment exists — `ready` as well as `draft`, because `ready` unlocks the same edits and the reviewer named only one of them. The way back from a paid invoice is Void, which is deliberate, recorded, and already releases the retainer it consumed; the refusal says so rather than just failing. Back-to-draft with nothing received still works, asserted, so this is not a blanket freeze. `test-worker.mjs` → *"An invoice with money against it cannot be put back to draft"* (12 checks). Worker 831 → 843. ~~**A backward invoice status transition can reopen a paid invoice and remove it from Outstanding.**~~ `setInvoiceStatus` guards `sent_to_bill` and `sent_to_client`, but `draft` has **no guard**, and `ready` validates content rather than current status. A paid invoice can be set back to draft, its lines rewritten and adjustments applied, bypassing the `locked` check. Then `outstanding`, `drafts` and the dashboard SQL all filter on the **stored** status, so the receivable vanishes while `balance_due` stays honest. | HIGH | `case-portal/worker.js` ~2454-2489 (`setInvoiceStatus`), ~2349 / ~2357 / ~3063 (the aggregates) | Money that is owed stops being visible. API-level only — the page offers Back-to-draft only from `ready` — but the Worker is the stated enforcement point |
| **4** | ✅ **FIXED and VERIFIED 2026-08-14 (local session).** True as reported and reproduced first — and **understated**: an independent Codex review, given the finding and no sight of the fix, found the same material shipping through a **second door**. The reproduction also caught a **worthless test**: the check guarding the outcome that matters passed on the broken code, because it looked for the FILENAME, which the document renders only when an item has no note. It counts exhibit rows in the printed index now, which cannot pass vacuously. **The fix:** the gates are no longer hidden on a finalized build (only the wording changes); the document prints only what is still cleared to ship and NAMES what it withheld, distinguishing material **held back** from material **deleted**, since `buildState` drops deleted rows and calling a deleted file "no longer client-deliverable" sends the admin to the wrong problem. **Reclassifying after finalize stays allowed** — a guard refusing it would preserve the unsafe classification at the exact moment someone is withdrawing it — so instead every exit re-reads current state: printing re-reads the package first and abandons rather than falling back on stale data, and **the delivery link is filtered too**. That was the second door: the document refused to print a held-back video while a Copy button beside it handed over the same file. The link is offered only while the evidence is IN the package and still cleared to ship, on the package panel and on `/completed` — which had not even honoured `deleted_at` though the evidence count beside it did. Membership is what makes that desk agree with the package panel, which always required it. Worker 843 → 849, portal 678 → 696; every new worker assertion fails with the guard removed, bar one positive control proving this is a filter and not a one-way door. **Left undone deliberately:** provider-side share revocation (needs a Dropbox client that does not exist, blocked on the owner's secrets), and the pre-existing LOW where video and index exhibit numbers contradict each other. ~~**The Case Build finalize gate strip can be hidden when the package is actually ready to finalize.**~~ The gate strip renders only while `b.status !== "finalized"`, so reclassifying evidence to `do_not_use` *after* finalize leaves the warning invisible while Download still works. `pkgDocHtml` renders every `build_items` row with no classification check. | HIGH | `portal/index.html` ~2976 (the suppression), ~3160-3245 (`pkgDocHtml`), ~3069 (Download on the finalized view); `case-portal/worker.js` ~2678-2697 (`editEvidence` does not check finalized builds) | Held-back material can reach a client with the warning suppressed — the one outcome the classification system exists to prevent |

**Queued behind them — TWO owner work orders, not defects:** private-client
**Cash App + Venmo payment options**, recorded verbatim in `PAYMENTS.md`. It is
deliberately *fifth*, on the owner's own instruction not to abandon HIGH bug
work for it. Its boundary is the same shape as the rate-sheet pairing already
enforced in §0 and §A: **private client only**, never in an insurance sheet,
insurance intake, carrier email, insurance send wizard or investigator view;
admin-only configuration; **no credentials stored**; and sending the
instructions must never mark the retainer paid. Seven named boundary regression
tests and a Codex review ride with it.

**The MEDIUM that rides with them:** every surveillance **date** is UTC while
every surveillance **time** is local — `toISOString().slice(0,10)` against
`toTimeString().slice(0,5)`. After 20:00 EDT the date is tomorrow's, so
evening surveillance is filed a day late. It reaches `case_days.day_date`,
`case_reports.report_date` (derived from it) and the timeline's
`ORDER BY at_date DESC, at_time DESC`. `portal/index.html` ~3690-3691, ~5006,
~5009, and the same pattern repo-wide (~2253, ~2305, ~2368, ~4863). Worth
fixing alongside #1 and #2 since it is the same file and the same subject.

Everything else stays in the table below. **Do not discard the unverified
items** — they are labelled as claims, which is what they are, not as noise.


| Area | Finding | Severity | Reviewer's evidence | Status |
| --- | --- | --- | --- | --- |
| INVOICING | The retainer invoice consumes the retainer it bills. | HIGH | `retainerBlock` sums every line on every non-void invoice as applied, and `createInvoice` puts the retainer itself on an invoice as a line, so the deposit counts as work. A second invoice then prints "Beyond the retainer" to the client when money remains. `worker.js` `retainerBlock` ~2186; `createInvoice` ~2322. | **FIXED — PR #69 (`c60a584`), re-verified on master.** `retainerBlock` skips any invoice carrying an `invoice_retainer` row (`worker.js` ~2214-2229), so the deposit is never counted as work against itself |
| INVOICING | A backward status transition reopens a paid invoice. | HIGH | `setInvoiceStatus` guards `sent_to_bill` and `sent_to_client` but `draft` has no guard, so a paid invoice can be set back to draft, its lines rewritten and adjustments applied, bypassing the locked check. `worker.js` ~2454-2489. | **FIXED — see HIGH #3 above; re-verified 2026-08-21.** `setInvoiceStatus` refuses `draft` and `ready` once any payment exists (`worker.js` ~6897-6904), pinned by *"An invoice with money against it cannot be put back to draft"* |
| INVOICING | That same revert erases a live receivable. | HIGH | `outstanding`, `drafts` and the dashboard Outstanding SQL all filter on the STORED status, so one write hides real money while `balance_due` stays honest. `worker.js` ~2349, ~2357, ~3063. | **FIXED as worded — see HIGH #3; re-verified 2026-08-21.** The revert it names is refused. An *unpaid* sent invoice can still be returned to draft, which is the intended meaning of un-issuing one |
| INVOICING | Create from retainer ignores the case's own retainer amount. | MEDIUM | Binds the hard-coded `PERSONAL.retainer` while `retainerBlock` reads `case_retainer.retainer_amount`; a $2,500 case retainer bills $1,500. `worker.js` ~2326 vs ~2185. | **FIXED — PR #69 (`c60a584`), re-verified on master.** `createInvoice` reads `case_retainer.retainer_amount` and falls back to `PERSONAL.retainer` only when the case has none (`worker.js` ~2357-2373) |
| INVOICING | Unsent drafts draw down the retainer on a client's document. | MEDIUM | `retainerBlock` filters only `status != void`; drafts are excluded from outstanding everywhere else. `worker.js` ~2187. | OPEN |
| INVOICING | An overpayment is accepted and cannot be reversed. | MEDIUM | No ceiling on payment amount, no negative correcting entry allowed, document prints a negative balance without `Math.abs`. `worker.js` ~2516; `portal/index.html` ~4478. | OPEN |
| INVOICING | Void invoices still report their cash in Paid this month. | LOW | Reduces over `full` rather than `live`. `worker.js` ~2354. | OPEN |
| INVOICING | `nextInvoiceNo` is read-then-write with no atomicity and wedges permanently past 9999. | LOW | Lexicographic TEXT ordering means `'…-9999' > '…-10000'`, so the max never advances again. `worker.js` ~2146-2154. | OPEN |
| PACKAGING | The finalize gate strip is hidden exactly when the package is shippable. | HIGH | `portal/index.html` ~2976 renders the gates only while status is draft, so reclassifying evidence to `do_not_use` after finalize leaves the warning invisible while Download still works. | ✅ FIXED 2026-08-14 — see HIGH #4 above. The document, the print action and the delivery link all re-read current state; the Codex review found the delivery link as a second door and it was closed with it. |
| PACKAGING | A delivery link outlived the material it delivers. | HIGH | Found by the Codex review of the HIGH #4 fix, 2026-08-14, not by the original five audits. `shares` (`portal/index.html` ~3112) filtered on the link alone, and `/completed` (`worker.js` ~3132) did not filter `deleted_at` or classification at all — so "Copy video link" kept handing over a video the package document had already stopped printing. | ✅ FIXED 2026-08-14 with HIGH #4 |
| PACKAGING | Deliberately removed days come back at finalize. | MEDIUM | Finalize reads zero attached reports as "this build predates `build_reports`" and re-seeds every approved report. `worker.js` ~4227-4240. | OPEN |
| PACKAGING | `case_builds.report_id` can point at a report not in `build_reports` and not approved. | MEDIUM | The repair is guarded by `if (!b.report_id)`. `worker.js` ~4231. | OPEN |
| PACKAGING | The report screen's Chronology shows removed entries unmarked. | MEDIUM | `portal/index.html` ~2453 lacks the `!e.removed_at` filter the timeline and surveillance views both have. | OPEN |
| PACKAGING | An entry removed after the draft was generated stays in the report body forever. | MEDIUM | Regeneration is refused with 409; nothing re-derives and nothing warns. `worker.js` ~3352. | OPEN — note this may be intended, since the body is author-owned, but CLAUDE.md states flatly that the report skips removed entries. |
| PACKAGING | Video exhibit numbers contradict each other inside one document. | LOW | Section numbers `i2+1`, index numbers `r.n`. `portal/index.html` ~3229 vs ~3237. | OPEN |
| PACKAGING | Documents always reads 0. | LOW | Page filters `role === 'document'`; the Worker writes `'attachment'`. `portal/index.html` ~3002. | OPEN |
| PACKAGING | A day approved after finalize is invisible, while `/completed` counts it. | LOW | `completedView` renders neither `daysPanel` nor the gate strip. | OPEN |
| SURVEILLANCE | An open pause is closed at server now, not at the day's recorded end time, so a day can be recorded as 0 hours. | HIGH | `span` is wall-clock minutes between typed start and end; the open pause closes at `nowIso()` and its real elapsed is subtracted. Pause at noon, end the day at 20:00 with an honest 12:00 end time, and `Math.max(0, …)` floors a real 4-hour day to zero. `worker.js` ~1747-1766. | **FIXED — recorded above and re-verified 2026-08-21.** The stale OPEN here was a bookkeeping miss |
| SURVEILLANCE | Reassigning a case strands a running day and its open pause permanently. | HIGH | `pause`/`resume`/`end` are scoped to both `caseFor` and `investigator_id = user.id`, so after a reassign nobody — not even an admin — can close the day. It stays in Out Now forever. `myActiveDay` also has no `assigned_to` filter, so the old investigator keeps being offered it and lands in a permanently loading screen. `worker.js` ~1693-1734, ~1020, ~3081. | **FIXED — recorded above (the `end-other` recovery route) and re-verified 2026-08-21** |
| SURVEILLANCE | Two of the three clock screens ignore the pause the server sends them. | MEDIUM | `svLauncher` (the PWA start URL) shows unpaused elapsed and says "Day running" while paused; the admin Out Now board shows raw wall-clock. `portal/index.html` ~3652-3659, ~1118-1133. | OPEN |
| SURVEILLANCE | Every SV date is UTC while every SV time is local, so evening work is filed a day late. | MEDIUM | `toISOString().slice(0,10)` vs `toTimeString().slice(0,5)`. After 20:00 EDT the date is tomorrow. Affects `case_days.day_date`, `case_reports.report_date` and timeline ordering. `portal/index.html` ~3690-3691, ~5006, ~5009 and repo-wide. | ✅ FIXED 2026-08-14 — true at all eleven page sites, all of them a date a human means by "today". `ymdLocal()` beside `fmtDay()`, which already guarded the return trip. Tested in two real timezones (UTC+14 / UTC-11) that bracket the clock, with a counter asserting at least one genuinely drifted so a green run cannot mean "nothing was tested". Portal 699 → 713. The Worker's date arithmetic, the visitor-alerts day buckets and intake's case NUMBER were examined and deliberately left on UTC. |
| SURVEILLANCE | `start_time` and `end_time` are never sanity-checked against the server's own clock. | MEDIUM | A day created seconds ago can be closed with an end time giving 23.98 h, flowing into authorization and invoicing. Mileage has a monotonicity check; time has none. | OPEN |
| SURVEILLANCE | The skew is measured once; a device clock that changes AFTER load moves the display. | LOW | No `visibilitychange` or focus re-sync. Display-only, never reaches hours. | OPEN |
| SURVEILLANCE | The pause race returns 500 rather than 409. | LOW | The partial unique index correctly rejects the loser but the constraint error escapes to the generic handler. | OPEN |
| SURVEILLANCE | `case_day_pauses.day_id` has no `REFERENCES case_days(id)`. | LOW | Unlike every sibling table, this foreign key is not declared. | OPEN |
| SURVEILLANCE | DST makes the subtraction unsound in a way the comment denies. | LOW | A local span across spring-forward is 240 wall minutes but 180 real; a day over 24h wraps to a tiny span while `paused_ms` stays real. | OPEN |
| PERMISSIONS | `adminBuild` ignores its `user` argument. | LOW | Not exploitable today because of the blanket `/build/` gate, but the name promises a check that is not there. `worker.js` ~2959. | OPEN |
| PERMISSIONS | The workspace scopes expenses, days and reports by case rather than by investigator. | LOW | A reassigned case shows the new investigator the previous one's money and hours. `worker.js` ~1445, ~1466, ~1470. | OPEN — may be intended. |
| PERMISSIONS | `redactRow` is a delete-list applied over `SELECT s.*`. | STRUCTURAL | Safe today only because `submissions` has no money columns; a future denormalised column would leak by default — the exact failure mode `FIELD_KEEP` was made an allow-list to prevent. Suggested: a guard test asserting the non-admin response keys are a subset of a known list. | OPEN |
| DOC | CLAUDE.md's "The rate card" section still describes `PACKAGES` and `HOURLY` in `intake/index.html` as live. | — | They were removed; the intake now sets no price at all. | OPEN — doc only. |

The five reviewers also independently confirmed a long list of items as
sound: the `FIELD_KEEP` allow-list and money gate, cross-case access blocked
by `caseFor` at all 110 route dispatch points, no location data anywhere, no
surveillance table, no hard delete of an activity entry, immutable submitted
report versions, no evidence overwritten during build or print, Custom unable
to ship held-back material, and no internal pricing on any client-facing
surface. The findings already fixed are recorded in the git history at
commit 4d53dc2.


## Unit 36 — the optional-field label audit (2026-08-21)

Requiredness was read from the validators, not from the forms. Three findings,
all fixed and all asserted:

| Where | Finding | Severity | State |
| --- | --- | --- | --- |
| INTAKE | The objective — the one field an otherwise empty form is refused over — carried no requiredness marker on any of the three paths. | MEDIUM | ✅ FIXED — `${REQ}`, asserted from the error path on all three doors |
| INTAKE | `<span class="opt">optional</span>` inherited the service-picker CARD styling: `display:block`, 1.5px border, 14px padding, `cursor:pointer`. **Measured 602×53 on the Legal step** — a clickable-looking box in the middle of a field label. The fourth source-order/class-name contest on record after `.qgrid`, `.dlg` and the burger base rule. | MEDIUM | ✅ FIXED — renamed `.optn`; the suite asserts inline text with zero border and a non-pointer cursor at 1200/768/390/320 |
| PORTAL | The Admin private-lead **Service** picker had no empty option, so a lead nobody was asked the service about was filed as *Surveillance* — the record asserting something the office was never told — under a label that already read "optional". | LOW | ✅ FIXED — opens on *Not decided yet*; reported to the owner as a storage-behaviour change |

Nothing else was found: every field on the five validators resolved to exactly
one of required / optional / one-of-two, so no field is reported as ambiguous.


## Queue state at 2026-08-22, before Units 37–38 were added

Checked under the owner's queue-safety instruction, against master `f8ae853`:

| Question | Answer |
| --- | --- |
| What is complete? | Locked order 1–17, hotfix 17A, Units 18–22, 24–36 |
| What is in progress? | Nothing — Unit 36 shipped at `b34ccda` and is recorded |
| What is queued ahead of the new work? | Nothing. Unit 23 is open but is live-verification only |
| What is deferred by owner? | The deferred list in `NEXT.md`, unchanged |
| What needs live verification only? | Unit 23's sweep and every LIVE VERIFY OPEN row |

So the two new units are the highest-priority unfinished work, and they were
**added** to the durable queue rather than replacing anything. Nothing was
skipped, renumbered, overwritten or silently dropped; the only edit to an
existing row was a stale "owes a portal-setup dispatch" note on Unit 27, whose
dispatch had already run (32508101361) and which the session header had
already recorded correctly.
