# FINAL PROJECT LEDGER — Unit 26, 2026-08-21, master `a715782`

The closeout reconciliation the durable queue asks for:

> Compare **every durable owner requirement** against master and live state
> again, classifying each as COMPLETE + LIVE VERIFIED / IMPLEMENTED BUT LIVE
> VERIFICATION DEFERRED / DEFERRED BY OWNER / MISSING — SKIPPED / OWNER
> DECISION REQUIRED. **The project is not complete while any non-deferred
> approved requirement is still missing.**

**Sources reconciled:** `MASTER-HANDOFF.md` §0–§43 (the owner's consolidated
source of truth), `RECONCILIATION.md` (2026-08-14 and 2026-08-21 reports),
`NEXT.md` (the durable queue, the locked order, the deferred list, the owner
decision table), `CLAUDE.md`, `WORK-ORDER.md`, and the per-unit briefs —
`PRICING.md`, `RATESHEETS.md`, `PAYMENTS.md`, `INVOICING.md`, `INTAKE-NA.md`,
`INTAKE-OPS.md`, `LEGAL-INTAKE.md`, `PROFILES.md`, `SURVEILLANCE.md`,
`SURVEILLANCE-VOICE.md`, `VIDEO-TIMESTAMP.md`, `PHOTO-TIMESTAMP.md`,
`EVIDENCE-INTEGRITY.md`, `DAILY-SUMMARY.md`, `TIMELINE.md`, `CASEBUILD.md`,
`DELIVERY-CENTER.md`, `CLOSEOUT.md`, `STORAGE-HEALTH.md`, `RETENTION.md`,
`PALETTE.md`, `PORTAL-OPS.md`, `DROPBOX.md`, `SECURITY-PASS.md`.

**The standard applied.** `RECONCILIATION.md` was written at master `2f96b23`,
**before Units 18–25 shipped**, so nothing in it was relayed. Every finding it
records was re-checked against the code on master today, and every unit SHA in
the tables below was confirmed to exist in master's history with a matching
subject line. Where a claim could not be checked from this container, that is
said rather than implied.

---

## PART 1 — the nine open findings `RECONCILIATION.md` carried

Each re-verified against master `a715782`.

| Finding | Owner | Verified today |
| --- | --- | --- |
| Overpayment accepted and **irreversible** | 18 | ✅ CLOSED — `voidInvoicePayment` + route `/invoices/:id/payments/:id/void`; `overpaid` and `credit_due` derived, the document prints *Payments received* / *Beyond the retainer*, never "Balance due $-500" |
| Unsent **drafts** draw down the retainer | 18 + #212 | ✅ CLOSED — the sibling sum excludes `('void', 'draft', 'ready')`, written once |
| Void invoices report cash in **Paid this month** | 18 | ✅ CLOSED — reduces over `live`, not `full` |
| Chronology shows **removed** entries unmarked | 19 | ✅ CLOSED — struck through, dimmed, and *"not in the report or the package"* |
| A day approved **after finalize** is invisible | 19 | ✅ CLOSED — the Worker sends `available_reports` and the page reads `PKG.available_reports` |
| **Video exhibit numbers** contradict each other | 19 | ✅ CLOSED — one global sequence, `String(r.n)` in both places |
| **Documents always reads 0** | 19 | ✅ CLOSED — the page counts `"attachment"` and `"document"`; the Worker writes `'attachment'` |
| Removed days come back at finalize (**API only**) | — | ⏸️ STILL OPEN, and correctly so — `seedBuildReports` still re-seeds at finalize. **DEFERRED BY OWNER**, recorded and unscheduled |
| `nextInvoiceNo` wedges past **9999** | — | ⏸️ STILL OPEN, and correctly so — lexicographic `ORDER BY invoice_no DESC`, 4-digit pad. **DEFERRED BY OWNER** |

**Neither deferred finding was silently fixed, and neither was silently
converted to complete.** Both were re-read on master to confirm they are still
exactly as recorded.

## PART 2 — the requirements the numbered queue did not contain

| Requirement | Owner | Verified today |
| --- | --- | --- |
| Alert never says Private / Insurance / Legal | 20 | ✅ CLOSED — `alertCategory()` at the one `notifyAdmins` chokepoint |
| A failed alert send is invisible | 20 | ✅ CLOSED — `alert_failure` table, written best-effort, surfaced on Settings only in the failing state |
| A deduplicated retainer payment alerts twice | 20 | ✅ CLOSED — both money routes guard (`if (!duplicate)` and `if (outcome !== 'duplicate')`) |
| Invoice payment **idempotency** | 18 | ✅ CLOSED — Unit 18 |
| `include_intake` sends a law firm the **private** door | 17A | ✅ CLOSED — `SHEET_INTAKE` now has exactly one functional reader, `intakeForContext`; the other occurrences are the definition and three comments |
| Accessibility — no pass had ever run | 21 | ✅ CLOSED — skip link, one `h1` in `shell()`, `aria-live` status region, labelled controls |
| Voice §9 **audible confirmation tone** | 21 | ✅ CLOSED — built to the spec and no further; a test asserts no speech synthesis appears |
| Voice §8 **offline/retry** half | item 1 (#182) | ✅ CLOSED — verified directly against the code, not the ledger. `activity_voice_event` in `schema.sql`, guarded by `missingTables`, in `EXPECTED_TABLES` and `DEMO_SWEEP`; the page holds an in-memory queue and says *"No connection — held on this phone and it will send itself"*; `event_id` is named once and kept across retries. **`NEXT.md:1926` still says this half is NOT built — that line is stale and superseded by #182** |
| PORTAL-OPS: cross-case **Tasks** view (phase 4) | 22 | ✅ CLOSED — `GET /tasks` |
| PORTAL-OPS: **Audit Trail** screen (phase 14) | 22 | ✅ CLOSED — `GET /audit`, admin-only, seven arms over existing tables |
| PORTAL-OPS: **Quick Actions + NEW** (phase 6) | 22 | ✅ Already satisfied by `quickToolsHtml()`; adding to the row tripped its own creep guard |
| PORTAL-OPS: **Saved Views** (phase 9) | — | ⛔ **OWNER DECISION REQUIRED** — the phase's own heading is `[inferred]` and its Billing item is corrupted |
| PORTAL-OPS: **Case Templates** (12), **Document Templates** (13) | — | ⛔ **OWNER DECISION REQUIRED** — mechanism buildable, but the templates are the firm's own case-setup defaults and language. Not ours to write |
| PORTAL-OPS: **Permissions** (item 10) | — | ⛔ **OWNER DECISION REQUIRED** — arrived corrupted, never re-sent. Stays marked missing; deliberately not invented |
| PORTAL-OPS: Case Health flag (11) | — | ⏸️ **DEFERRED BY OWNER** |
| PORTAL-OPS: notification bell (10) | — | ✅ Superseded by design — Unit 8 refuses a dismissal mechanic on principle, and says so |
| **File Queue** layout | 24 | ✅ CLOSED — `GET /file-queue`; **owner visual check PASSED** 2026-08-21 |
| Role boundary / authorization surface | 25 | ✅ CLOSED — three defects found and fixed; `SECURITY-PASS.md` |

## PART 3 — `MASTER-HANDOFF.md` §0–§43

Every functional section traced to an implementing route, function or table on
master. **All present.**

| § | Requirement | Evidence on master |
| --- | --- | --- |
| 2 | Master product model — public site, admin portal, investigator portal, Active Surveillance, Case Build, invoicing | all five subsystems present |
| 3 | Two rate sheets, strictly separate | `rateSheets()`, `RATES.packages`, `PERSONAL` |
| 4 | Rate sheet → correct intake pairing | `CONTEXT_INTAKE` / `intakeForContext` |
| 5 | Manual admin intake / leads | `createManualIntake`, `LEAD_STATUSES` |
| 6 | INTAKE-NA field availability | `<field>_status` throughout the intake |
| 7 | Returned intakes on admin dashboard | intake review actions |
| 8 | Streamlined portal UX | Unit 5 shell, measured |
| 9 | Case detail | case workspace |
| 10 | Field activity, timeline first | `activity` routes, `.tl` log |
| 11 | Report building | `generateReport` / `saveReport` / `setReportStatus` |
| 12 | Evidence | `uploadEvidence`, `serveEvidence` |
| 13 | Case Build — admin client package | `/build/:id/finalize` and the gates |
| 14 | Dropbox video delivery | **superseded by the owner's 2026-08-17 device-first decision.** "Create share link" was deliberately never built; a test asserts no sharing call exists |
| 15–26 | Active Surveillance: mobile home, start/resume day, quick activity, speech to text, voice nav, photo/video, timeline, case info drawer, end day, report→admin, PWA | `svHomeScreen`, `startDay`/`endDay`, the four field actions **Activity / Photo / Video / Note**, `SpeechRecognition`, the five-tab field nav ending in **Case**, `manifest.webmanifest` |
| 27 | Admin live status | `outNow` / `GET /active` |
| 28 | Invoices / BILL handoff | `setInvoiceBillRefs`, the invoice family |
| 29 | Public website / SEO | `sitemap.xml`, location pages |
| 30 | Remove social media search service | ✅ **verified absent** — no HTML on the site mentions it |
| 31 | Completed cases | `completedCases()` |
| 32 | Case package progress | `pkgProgress` |
| 33 | Client / investigator redaction | `FIELD_KEEP`, `redactRow` |
| 34 | Investigator compensation vs client rate | `user_rates`, `/my/comp` |
| 35 | Expenses / mileage | `addExpense`, `/my/expenses` |
| 36 | Communications / tasks | `case_comms`, `case_tasks` |
| 37 | Status / workflow model | `STAGES` |
| 38 | Full end-to-end **insurance** test | living suite section — *"End to end: a carrier assignment, sheet to completed"* |
| 39 | Full end-to-end **private** test | living suite section — *"End to end: a private client, sheet to completed"* |
| 41 | Design principles from the mockups | Unit 5 + Unit 13 + Unit 24 |
| 42 | Master remaining build order | this ledger |

## PART 4 — the three business workflows

| Workflow | State |
| --- | --- |
| **Insurance / carrier** | COMPLETE. Public insurance pages → vendor information → `?assignment=insurance` carrier door → claim-details, scheduling and authorization steps → carrier terms → billing, nothing charged at assignment. Carrier rates never published; `/pricing` admin-only. E2E suite section green |
| **Private** | COMPLETE. Private rate sheet → agreed retainer ($1,500 / $2,000 / $3,000 / Custom, `agreedRetainer()` the single read) → `?assignment=private` door → payment instructions that never mark a retainer paid → Record Payment, idempotent, partial payments additive, voidable. Cash App, Venmo, Check, Cash, ACH/BILL only; Credit Card and Other stay removed. E2E suite section green |
| **Legal / law firm** | COMPLETE. Third intake type, `?assignment=legal` door, the private sheet in the LEGAL context (one pricing source), `legal_intake` companion table, firm/attorney/paralegal profiles, Quick Legal Assignment, `POST /cases/:no/legal`, the four legal payment ARRANGEMENTS as a request and never a payment, and **Cash App / Venmo reach a law firm through no code path** (`CONTEXT_TAKES_PAYMENT === PRIVATE`). Hotfix 17A pairs the door to the send context |

## PART 5 — FINAL PROJECT LEDGER

Every SHA below was confirmed present in master's history with a matching
subject. `LIVE VERIFIED` means a person looked at it on the live system.

| # | Unit | PR | Master SHA | CODED | TESTED | PUSHED | MERGED | DEPLOYED | LIVE VERIFIED |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Active Surveillance mobile + voice polish | #182 | `c333d3f` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ two device-only checks open |
| 2 | Timestamp Photo | #188 | `b0304cb` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ **owner, 2026-08-19** |
| 3 | Dropbox portal UI | #189 | `5baabd3` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 4 | Admin report workflow + mobile report fix | #190 | `94b1f5b` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 5 | Portal UI / mobile / dashboard modernization | #191 | `6446e3c` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 6 | Legal / Law Firm intake | #192 | `1b24467` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 7 | Repeat Client / Firm Profiles | #193 | `860f8fb` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 8 | Global Search + Needs Attention | #194 | `8d28196` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 9 | Multiple Report Templates | #195 | `9979fca` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 10 | Case Timeline | #196 | `8d93a9e` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 11 | Evidence Integrity | #197 | `0c0c134` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 12 | Report Daily Summary Builder | #198 | `46ccad6` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 13 | Portal palette normalization | #199 | `fcd3d38` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ **owner, 2026-08-21** |
| 14 | Storage Health | #202 | `96e994d` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ **owner, 2026-08-21** |
| 15 | Case Closeout | #203 | `2494716` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ **owner, 2026-08-21** |
| 16 | Client Delivery Center | #204 | `883fd6d` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 17 | Retention Controls | #205 | `943d0f3` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ **deferred — requires a real case** |
| 17A | HOTFIX — Legal intake link routing | #206 | `61a00f0` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 18 | Invoice Payment Integrity | #207 | `c184a50` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 19 | Package + Report Accuracy | #208 | `1a047a8` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 20 | Intake Alert Completeness | #209 | `46a06ad` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 21 | Accessibility + Voice §9 tone | #210 | `27243af` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 22 | PORTAL-OPS remaining gaps | #211 | `a7bfe6e` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| — | Ready-is-unsent retainer rule | #212 | `59d00c8` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 23 | Consolidated Live Verification Sweep | — | — | n/a | n/a | n/a | n/a | n/a | ⏸️ **DEFERRED — REQUIRES REAL CASE/DATA** (owner, 2026-08-21) |
| 24 | **File Queue** (REQUIRED) + aesthetic redesign | #213 / #214 | `8988b29` / `5835cdf` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ **owner visual check PASSED, 2026-08-21** |
| 25 | Security / authorization / regression pass | #215 | `73b7f5b` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ deferred |
| 26 | Final reconciliation + closeout | #217 | `5e1d063` | ✅ | ✅ | ✅ | ✅ | ✅ | n/a — documentation |
| 27 | **Ended by Admin / Ended by [name]** (owner decision 4) | #219 | `74629fe` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏸️ **deferred — requires a real case with two people on it** |

**Five units carry an owner's own LIVE VERIFIED**: Timestamp Photo, Palette,
Storage Health, Case Closeout, and the File Queue's visual check.

## PART 6 — classification of every remaining item

### COMPLETE + LIVE VERIFIED
Timestamp Photo (2) · Portal palette normalization (13) · Storage Health (14) ·
Case Closeout (15) · File Queue (24, visual check) · the public website itself —
`Daily site health` run #22 probed the live domain on 2026-08-21 and passed
(security headers, TLS, every sitemap URL answering, robots, `security.txt`,
weight budget).

### IMPLEMENTED + LIVE VERIFICATION DEFERRED
Units 1, 3–12, 16, 17, 17A, 18–22, the Ready-is-unsent rule, and 25 — every one
CODED, TESTED, PUSHED, MERGED and DEPLOYED, machine-verified by the suites,
awaiting a person's eyes. **Unit 17 (Retention) and Unit 23's sweep are
explicitly deferred until a suitable real case exists; no production data is to
be manufactured for either.** Unit 25 adds two items to that sweep: what a
reassigned investigator is shown on a case, and the field view's day number.

### DEFERRED BY OWNER — preserved, never converted, never deleted
SMS delivery and provider (*"the intended resting state, not a gap"*) · the
queued/sent/failed/retried alert status log · Intake Archive / Sample Cleanup
Part 2 · invoice **Write-Off** · PORTAL-OPS **Case Health flag** · physical
evidence destruction · automatic retention clocks · automatic purge · Dropbox
byte deletion · the legacy R2 export/migration decision · two-person legal-hold
approval · `nextInvoiceNo` past 9999 · removed days re-seeding at finalize
(API-only).

### MISSING — SKIPPED (recorded, with the reason, not silently dropped)
- **UIBUILD Phase 1 item 4 — the "More" menu.** Not built deliberately: Record
  Payment is already on Overview and Edit Case is reachable from the header, so
  a menu would be a second path to the same things rather than reachability, and
  Export does not exist to put in it. Item 3's "last activity" is served by the
  existing Recent activity card.
- **MASTER §14's "create share link".** Superseded by the owner's device-first
  decision of 2026-08-17; a test asserts no Dropbox sharing call exists.
- **PORTAL-OPS phase 10's notification bell.** Superseded by design — Unit 8
  refuses a dismissal mechanic on principle.

### OWNER DECISION REQUIRED — **ALL FIVE ANSWERED AND LOCKED, 2026-08-21**

The five open questions this ledger raised were answered by the owner at
closeout. Their wording is verbatim; the full block lives in `NEXT.md` under
**FINAL OWNER DECISIONS**. **None remains a pending question**, and four of the
five resolve to a deferral or a standing refusal rather than work.

| # | Decision | New classification |
| --- | --- | --- |
| 1 | *"PORTAL-OPS Permissions remains missing and must not be invented. Rebuild later from owner direction."* | **MISSING — SKIPPED**, by owner direction. Explicitly **not a closeout blocker** |
| 2 | *"Saved Views remains a future optional operational improvement; do not block closeout."* | **DEFERRED BY OWNER** |
| 3 | *"Case Templates / Document Templates may use a reusable mechanism later, but owner supplies the actual firm content. Do not invent templates."* | **DEFERRED BY OWNER** — mechanism later, content always the firm's |
| 4 | *"If Admin or another authorized user ends someone else's surveillance day, the UI/history must clearly say Ended by Admin or Ended by [name]. Never make it appear the original investigator ended it."* | ✅ **BUILT — Unit 27.** See below |
| 5 | *"Keep current Cash App $TreverB and Venmo @Trever-Brown-9 for now. Business-account migration remains a future owner decision."* | **DEFERRED BY OWNER** — handles unchanged |

**Unit 17 and Unit 23 stay LIVE VERIFICATION DEFERRED** until suitable real
case data exists, reaffirmed by the owner at closeout. No production data is to
be manufactured for either.

### The one open build item is now CLOSED — Unit 27

**Decision 4 was the only requirement approved after closeout and not yet
built. It is built.**

**What the record did before**, verified at the time: `case_days` carried
`end_time`, `end_mileage`, `hours`, `miles`, `summary` and `ended_at` — and no
`ended_by`. A day the office ended through `/cases/:no/day/end-other` was stored
**identically** to one the investigator ended themselves.

**What Unit 27 added:** `case_day_end`, one additive companion table (the
`activity_removed` / `build_custom` rule — `case_days` cannot gain a column
while `schema.sql` is re-applied on every portal-setup run). It records the day,
the case, who ended it, **their role at that moment**, and when.

| Requirement | How it is met |
| --- | --- |
| Investigator ends their own day → recorded as the actor | written at the single `UPDATE case_days`, from the authenticated caller |
| Admin ends it → *Ended by Admin* / the Admin name | `dayEndLabel()`, the one writer of the wording |
| Another authorized user → *Ended by [name]* | same label, non-admin branch |
| **Never appear as the investigator when it was not** | a day with no record reads *"Ending actor not recorded"* — never as self-ended. Asserted from both directions: the right name appears **and** the wrong one does not |
| Preserve start/end time, mileage, hours, summary, reports, Active Surveillance | nothing else touched; asserted against the stored row |
| No historical record overwritten | additive table only; `ON CONFLICT DO NOTHING` keeps the first actor |
| Additive schema only | one table, one index |
| Server-side authorization | unchanged — `openDayForAction` already required `caseFor` + admin before resolving anyone else's session. Unit 27 records, it does not re-decide. Pinned: an investigator still cannot end another's day |
| Audit actor and timestamp | `ended_by`, `ended_role`, `at` |
| Shown where the history needs it, not in the client document | office Days table, the timeline, the day-end confirmation. A test asserts *"Ended by"* appears nowhere inside `#pkgdoc` |

**Tested:** self-ended, admin-ended, another-authorized-user-ended, a legacy day
with no record, a demotion after the fact, and the before-dispatch state where
the table does not exist and the day must still end.

**The `portal-setup.yml` dispatch RAN** — run **32508101361** at `74629fe`, ✅
success, **including the admin-bootstrap step that failed at `46a06ad9`**, so
the known token race did not recur. `case_day_end` is on the live database and
no schema is owed.

## PART 6B — PRODUCTION TRUTH CORRECTIONS (Units 28–33, 2026-08-21)

The owner opened the portal and found the Legal Rate Sheet missing. That one
observation invalidated the method this ledger had used until then — a feature
was being called complete on the strength of code, routes, tables and old
reconciliation notes. The Production Truth Audit re-checked every claimed
feature from an Admin's point of view across five layers: **code exists · API
works · UI visible · normal navigation reaches it · the action works.**

**Every original discrepancy, reconciled:**

| # | Finding | Now |
| --- | --- | --- |
| 1 | Legal rate sheet unreachable except from an existing Legal lead | ✅ **FIXED — Unit 28** (#221, `9beb0e8`). Legal / Law Firm card on Rate Sheets; explicit send context; no third pricing source |
| 2 | "Send legal intake" button missing | ✅ **FIXED — Unit 28** |
| 3 | `preIntakeHtml` label knew only two kinds | ✅ **FIXED — Unit 28**, and the handler's kind ternary with it — it collapsed everything not-insurance into private |
| 4 | `/billing-settings` had no UI | ✅ **FIXED — Unit 29** (#222, `3df2037`). Settings → Invoice defaults |
| 5 | `POST /case-types` had no UI | ✅ **FIXED — Unit 30** (#223, `730141e`). Settings → Case types |
| 6 | `/pricing` unreferenced | ✅ **INTENTIONALLY INTERNAL — Unit 31.** Documented at the route; its absence from the UI IS the feature |
| 7 | `/external-storage` — I classified it "MISSING (dead route)" | ✅ **INTENTIONALLY INTERNAL — Unit 31.** **My classification was wrong**: it is a tested authorization boundary. Nothing removed |
| 8 | `/profiles/match` unreferenced | ✅ **INTENTIONALLY INTERNAL — Unit 31.** Part of the admin-only profile boundary walk |
| 9 | No public Legal entry on the website | ⛔ **OWNER DECISION REQUIRED — not implemented**, by instruction |

**The lesson this pass paid for, in both directions.** "A route exists so the
feature is done" put the Legal sheet out of reach for months. "No UI reference
so the route is dead" nearly deleted three passing boundary checks. Neither
absence nor presence of a UI link is evidence on its own; callers, tests and
docs are.

**Unit 32 — reachability re-audit against the corrected code.** Every
rate-sheet and intake door reachable including Legal; all six Settings panels
reachable (payment methods, notifications, Dropbox, storage health, invoice
defaults, case types); every admin sidebar item resolves to a real view; and
the only routes without a page caller are the three documented as internal on
purpose. **No new BLOCKER or HIGH gap found.**

**Suites after the correction queue:** worker **2749/0** (2649 at closeout),
portal **2452/0** (2423), deploy guard **68/0**, intake **236/0**,
visitor-alerts **47/0**.

## PART 7 — master and deployment state

| | |
| --- | --- |
| **Master** | `74629fe` — working tree clean, nothing unpushed |
| **Schema owed** | **NONE.** Unit 27 added `case_day_end` and its dispatch has run (32508101361, ✅ at `74629fe`) |
| **`portal-setup` run 32456667718** | Verified step by step, not relayed: step 8 **"Apply the schema" SUCCESS**, step 11 Worker deploy success, step 12 route answering, step 13 **"Create the first admin" FAILURE** (the known bootstrap-token race), step 14 **"Destroy the bootstrap token" SUCCESS**. The red run is a bootstrap-only failure on a portal that already has its admin, with no credential left live. **Untouched deliberately — credential handling is a stop condition** |
| **`Deploy case-portal Worker`** | ✅ success at `73b7f5b` |
| **`Deploy site to Cloudflare Pages`** | ✅ success at `73b7f5b` and `a715782` |
| **`Daily site health`** | ✅ success, run #22, 2026-08-21 |

**Stated rather than implied:** this container's proxy refuses
`alwayspreciseinvestigations.net`, so no page was fetched from here. Live state
above rests on the workflow runs and on the daily probe, which does reach the
domain.

## PART 8 — the suites at `a715782`

| Suite | Result |
| --- | --- |
| `case-portal/test-worker.mjs` | **2677 / 0** |
| `portal/test-portal.mjs` | **2424 / 0** |
| `.github/test-deploy.mjs` | **68 / 0** |
| `intake/test-intake.mjs` | **236 / 0** |
| `visitor-alerts/test-worker.mjs` | **47 / 0** |

## PART 9 — one documentation correction this reconciliation found

`NEXT.md:1926` still reads *"**The offline/retry half is NOT built** and needs a
server-side event key."* That was true of #177/#178 and was finished by #182
(`c333d3f`); `SURVEILLANCE-VOICE.md:452` records it complete, and the code
carries both halves. The line is a historical unit report that was never
reconciled — the same failure mode this project has now recorded four times
(*"a findings table nobody reconciles is the same as a red workflow nobody
reads"*). It is corrected in place rather than left to mislead the next reader.

## PART 10 — the closeout statement, kept accurate

**At closeout (`5e1d063`), no non-deferred approved requirement was missing**,
and **ALWAYS PRECISE FUNCTIONAL BUILD COMPLETE** stands for the build as
delivered: 26 units CODED · TESTED · PUSHED · MERGED · DEPLOYED, five of them
carrying the owner's own LIVE VERIFIED.

**The one requirement approved after closeout is now built.** The owner's
decision 4 of 2026-08-21 — *Ended by Admin / Ended by [name]* — shipped as
**Unit 27**: CODED · TESTED · PUSHED · MERGED · DEPLOYED. It owes a manual
`portal-setup.yml` dispatch, and its LIVE VERIFIED stays open because seeing it
work means a real case with two people on it.

So the statement holds again without qualification: **no non-deferred approved
requirement is missing.**

Everything else that remains open is open **by the owner's choice**: the
deferred list, the two live-verification sweeps awaiting real case data, and
the four decisions above that resolve to a deferral or a standing refusal.
