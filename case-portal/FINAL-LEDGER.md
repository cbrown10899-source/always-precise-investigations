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


## PART 11 — Unit 36, the optional-field labels

**Owner rule, 2026-08-21:** *"Across every intake form and intake-related Admin
form, every field that is genuinely optional must visibly say (optional) in its
field label. Audit requiredness from the actual server-side validation/schema
first. Do not guess from the current UI."*

| | |
| --- | --- |
| **Scope** | Public intake (Private / Insurance / Legal), Admin Quick intake (three doors), Edit case, the Legal panel, and the saved Clients & Firms forms |
| **State** | CODED · TESTED · PUSHED · MERGED · DEPLOYED — #228 at `b34ccda`, Pages run 32540154210 ✅ |
| **Schema** | none — no `portal-setup` dispatch |
| **LIVE VERIFIED** | **OPEN** — visual, for the owner |

**The audit ran first and it decided the design.** `handleIngest` validates
exactly one field, `case_no`, which the page mints and no person types — the
portal write is fire-and-forget so a Worker outage can never cost the firm a
client. That makes `validate()` in `intake/index.html` the firm's own
requiredness rule, so the tests compare the labels against it by BEHAVIOUR:
fill only the fields whose label does not say "(optional)", submit, assert it
goes through — on each of the three doors. On the Admin side the authorities
are `createManualIntake`, `editCase`, `setLegalDetail`, `createProfile` and
`addProfileContact`, and the suite POSTs against them.

**Three markers, because requiredness has three shapes.** Required; optional;
and *one of these two*, which covers six pairs — phone/email, the firm's client
or its matter number, the claimant's name or the claim number, the carrier or
the assigning contact, the firm or the attorney, a contact's first or last
name. Calling either half of a pair "(optional)" would be untrue and calling
either half required would be untrue the other way. A select with no empty
option is none of the three and carries no marker.

**Three defects found, which is why the audit was asked for:**

1. **The objective carried no marker at all** — the single field an otherwise
   empty form is refused over, on every path.
2. **The public form's optional marker was a class-name contest.** `.opt` there
   is the service-picker CARD, so `<span class="opt">optional</span>` inside a
   label drew as a **602×53 bordered box with `cursor:pointer`** — measured on
   the Legal step. `.optn` now, asserted as inline text at 1200/768/390/320.
3. **The Admin private lead's Service picker had no empty option**, so a lead
   nobody had been asked the service about was stored as *Surveillance*, under
   a label that already said optional. The picker opens on *Not decided yet*.

**Reported, not decided:** defect 3 changes what a private quick-intake lead
stores when the dropdown is untouched — a service before, nothing now. Honest,
but a behaviour change, and one line reverts it.

**Ambiguity found: none.** Every field resolved to exactly one of the three
shapes from the code that validates it.


## PART 12 — the queue is open again, and the closeout statement says so

**Owner instruction, 2026-08-22:** *"Do not call the project complete while any
required queued item remains."*

Two units were added to the durable queue on that date. **They are REQUIRED, not
deferred**, so the closeout statement in PART 10 no longer stands unqualified.
It is not withdrawn — it was true of the build as delivered at `5e1d063`, and
Units 27 and 34–36 were each reconciled into it as they shipped — but the
project is **not complete** while 37 and 38 are open.

| # | Unit | Brief | State |
| --- | --- | --- | --- |
| **37** | Final Production Truth Audit — Round 2 | `PRODUCTION-TRUTH-2.md` (owner verbatim + result) | ✅ **DONE — NOT PASSED.** One HIGH, two lesser. No repository file changed to run it |
| **37A** | HOTFIX — all three Round 2 findings | `PRODUCTION-TRUTH-2.md` | ✅ **DONE.** No schema |
| **38** | Case Workspace Simplification | `CASE-WORKSPACE.md` (owner verbatim) | 🟡 **IN FLIGHT** |
| **39** | Case content Delete / Restore controls | `CASE-CONTENT-DELETE.md` (owner verbatim) | 🔵 **REQUIRED — after 38.** A PRODUCTION unit: real cases, not only `TEST-` ones. No Dropbox byte deletion, no evidence overwrite, no silent hard delete |

**Unit 38 carries three named requirements** and none may be split out, dropped
or quietly satisfied by an existing feature:

1. the simplified desktop and mobile Case Workspace;
2. **Activity oldest-to-newest ordering** — Activity tab, Active Surveillance
   timeline, Daily Summary source, report chronology, any selected-day list.
   The dashboard's Recent Activity widget stays newest-first, by the owner's
   own carve-out;
3. **simplified Activity / Daily Summary access** — on mobile, neither may ever
   sit under **More**.

**On the numbering.** The owner's message labels the workspace unit "Unit 34".
That number is the shipped public-site unit (#225, `405462f`), recorded in PART
6B. Nothing was renumbered — 34 keeps its meaning and the new unit takes the
next free number, 38, with the owner's own label preserved at the top of
`CASE-WORKSPACE.md`.

**What was verified before adding them**, per the owner's queue-safety
instruction:

- **Complete:** locked order 1–17, hotfix 17A, Units 18–22 and 24–36. None
  reopened, none renumbered, none replaced.
- **In progress:** nothing. Unit 36 shipped at `b34ccda` and is recorded.
- **Queued ahead:** nothing. Unit 23 is the only other open Active-order row and
  it is live-verification only.
- **Deferred by owner:** unchanged and untouched — PORTAL-OPS Permissions
  (must not be invented), Saved Views, Case and Document Templates, Case Health
  flag, SMS provider and the alert status log, Intake Archive / Sample Cleanup
  Part 2, invoice Write-Off, physical destruction, retention clocks, automatic
  purge, Dropbox byte deletion, the legacy R2 export decision, two-person
  legal-hold approval, removed-days-at-finalize, `nextInvoiceNo` past 9999, the
  business-account payment migration, and the `portal-setup` bootstrap-token
  race (credential handling is a stop condition).
- **Live verification only:** Unit 23's sweep, and the LIVE VERIFY OPEN rows —
  17A, 18, 19, 20, 21, 22, 27, 28, 34, 36 and the IMPLEMENTED BUT NOT LIVE
  VERIFIED block. Deferred by the owner pending real case data; **no production
  data is to be manufactured for any of it.**

**One stale line corrected rather than left to mislead:** the Active-order row
for Unit 27 said it *"owes a portal-setup dispatch"*. That dispatch was run —
`portal-setup` 32508101361 at `74629fe`, successful including the
admin-bootstrap step — and the session-handoff header has said so since. The
row now agrees with the header. No schema is owed.

---

## PART 13 — Unit 38, the case workspace simplification

**Owner brief verbatim in `case-portal/CASE-WORKSPACE.md`**, including the
mobile/tablet UX addendum the owner attached to this unit on 2026-08-22
(*"Ship with the current UI/UX unit if safe"*). The owner's own label is
"UNIT 34"; that number belongs to the shipped public-site unit, so the alias is
recorded in the brief file and nothing was renumbered.

### The path, before and after

| | Before | After |
| --- | --- | --- |
| Activity | Case → Fieldwork → Activity log | Case → **Activity** |
| Daily Summary | Case → Report & Media → Reports → its sixth sub-view | Case → **Daily Summary** |
| Evidence | Case → Report & Media → Case media | Case → **Evidence** |
| Report | Case → Report & Media → Reports | Case → **Report** |
| Everything else | four sections over seventeen tabs | one row of six, the rest under **More**, every key unchanged |

**No functionality was removed** and no route broke: a tab that existed still
exists under its own key, and the suite walks every pre-Unit-38 key and asserts
each still routes and draws.

### Desktop

One compact tab row under the case header — Overview, Activity, Daily Summary,
Evidence, Report, and Billing for an admin — with **More** carrying the rest.
`wsMore()` is derived from `wsSections()` by subtraction, so a tab added there
arrives in this navigation instead of disappearing from the page. The primary
case actions sit above it: **+ Add activity**, **Daily summary**, **End day /
Start a day**, and **Resume surveillance** when a day is running.

### Mobile

A fixed thumb bar carries **Activity · Summary · + Add · Evidence · More** —
`WS_BAR_TABS` names the three so the bar and the menu cannot drift. Activity
and Summary are never under More, which the suite asserts by name at 375, 390
and 430px, along with the 44px tap floor and the home-indicator clearance.
Overview, Report and Billing render inside More at those widths through
`.more-primary`, which closed a hole where the desktop row is `display:none`
and those three were reachable from nothing at all.

### Investigator

No Billing tab, no Package, no Edit case, no Assignment — asserted across their
whole navigation, and no panel they can open shows a rate, a retainer or an
invoice total. Active Surveillance and the Daily Summary builder are intact for
them. The boundary is the Worker's, unchanged.

### Admin

Billing stays on the row and opens. Everything administrative that was in the
four sections is in More.

### Activity ordering

`caseWorkspace` returns activity **oldest first**, so the log, the Daily Summary
source, the report chronology and the package all read in the order the day
happened. **The cap still takes the newest end** — a DESC-ordered `LIMIT 500`
wrapped in a subquery that re-sorts ascending, because flipping the ORDER BY
alone would have kept the oldest five hundred entries and dropped this
morning's work.

### The mobile/tablet UX addendum

Navigating to a section no longer focuses a text field or raises the on-screen
keyboard. There is **no `autofocus` attribute anywhere in the page** — the
audit looked; `paint()` was restoring the caret unconditionally on every
repaint. `focusCapture()` / `focusRestore()` hand it back only to whoever had
it, `FOCUS_KEEP` is the allow-list, and dialogs are exempt by the owner's own
words. The Search field gained a 640px desktop maximum released below 900px —
a number read off this page, since 900 is already where the nav rail goes
behind the burger.

### Ship record

| | |
| --- | --- |
| PR | **#232** |
| Merge SHA | **`f2f49d4`** |
| Site deploy | `Deploy site to Cloudflare Pages` run **32557961911** ✅ |
| Worker deploy | `Deploy case-portal Worker` run **32557961914** ✅ |
| Schema | **none** — no `portal-setup` dispatch owed |
| Suites | worker **2796/0** · portal **2660/0** · deploy guard **86/0** · intake **467/0** · visitor-alerts **47/0** |
| LIVE VERIFIED | ✅ **YES — the owner's visual review passed, 2026-08-22** |

### One thing this unit reported instead of fixing

`announceRendered()` never runs on the case page, so a confirmation inside a
case is drawn silently for a screen-reader user. **Pre-existing** — the same
early return is on `master` from when the workspace became a full page — so the
brief's test 20 ("accessibility *remains* sound") is satisfied either way. It
is one line, and that is why it was reported: `.note` here is often static
explanatory prose, so switching it on would read paragraphs aloud on arrival at
a case tab. Queued in `NEXT.md`, reasoning in `RECONCILIATION.md`.

---

## PART 14 — Unit 39, removing case content and putting it back

**Owner brief verbatim in `case-portal/CASE-CONTENT-DELETE.md`**, with the
audit and derived decisions A1–A7 appended there. Started on the owner's
go-ahead after Unit 38's visual review passed.

### The audit found the brief resting on something untrue

The brief asks to reuse *"the existing evidence-deletion/tombstone model"* and,
separately, forbids deleting Dropbox bytes. **Both could not be followed:**
`deleteEvidence` destroyed the file — `dropboxDelete`, or `EVIDENCE.delete` for
a legacy R2 row — and only then wrote `deleted_at`. That is also why no
evidence Restore had ever existed: there was nothing left to put back.

**Removal destroys nothing now.** `dropboxDelete` and `EVIDENCE.delete` have
exactly one caller each — the `TEST-` sweep — and a test COUNTS them, because
"no bytes are destroyed" is a confirmation the owner asked for and a comment
cannot give. Control-checked: putting the destruction back fails four tests.

### Which records gained Delete, and who may use it

| Record | Who | Restore |
| --- | --- | --- |
| Activity entry | admin, or its own investigator | already existed |
| Investigation day | admin | ✅ |
| Daily summary | admin, or the day's investigator until the report is with the office | ✅ |
| Evidence / case media | admin | ✅ **new** |
| Note | admin, or its author | ✅ |
| Comm log entry, subject, vehicle, task | admin | ✅ |
| Expense | admin, or its own investigator **while unreviewed** | ✅ |

**Remove from Package stays a different act from Delete from Case**, asserted
apart. **Intentionally non-deletable:** invoices, lines and payments (void is
the instrument), reports, send and alert history, retainer receipts, build
events, and the retention and hold trail.

### Two consequences recorded rather than buried

**Deleting evidence no longer frees storage.** The lever is gone; recovering it
would be a purge, which the owner has said is not wanted.

**A legal hold now refuses every removal in this unit** and allows every
restore — a widening of Unit 17 decision 5, which named only evidence.
Recorded in `CASE-CONTENT-DELETE.md` A7 to overturn if unwanted.

### Five defects found on the way

`buildStaleness` guarded on `'final'` where the CHECK allows `'finalized'`, so
it returned null for every package that has ever existed; `rmGo` called a
function that does not exist; `dayEndedByRow`'s colspan stopped matching its
table; the workspace shipped `content_removed`, which nothing read, to
investigators; and the stale banner was rendered by an early return above its
own `const`. **Four came from reading the diff; the last only from running the
page** — the honest split between what each catches.

### Ship record

| | |
| --- | --- |
| PR | **#234** |
| Merge SHA | **`79da2b8`** |
| Site deploy | `Deploy site to Cloudflare Pages` run **32583655929** ✅ |
| Worker deploy | `Deploy case-portal Worker` run **32583656010** ✅ |
| Schema | ✅ **CONFIRMED PRESENT ON PRODUCTION** — `harden-check` run 32584685117, *"every table this build expects is on the database"*. `portal-setup.yml` run **32583766475** — **RED, and the schema still applied**: step 8 *Apply the schema* ✅, and the run fails only on step 13 *Create the first admin* with `401 not authorised`, the pre-existing bootstrap-token race already recorded in `NEXT.md`. Step 14 destroyed the bootstrap token ✅, so no credential is left behind. It was **not** verifiable from the build container (the network policy refuses the domain), so it was verified from a GitHub runner instead — see the confirmation above |
| Suites | worker **2870/0** · portal **2690/0** · deploy guard **86/0** · intake **467/0** · visitor-alerts **47/0** |
| LIVE VERIFIED | ✅ **YES — the owner's visual review passed, 2026-08-22** |

### ✅ SCHEMA CONFIRMED ON PRODUCTION — 2026-08-22

`harden-check.yml` run **32584685117** at `5dbf3d2`, **22 passed, 0 failed**,
probing the live domain from a GitHub runner:

```
PASS  the Worker answers at /portal-api/ on the site's own domain
PASS  the D1 binding and INGEST_KEY are both set
PASS  every table this build expects is on the database
```

**Why that line settles it, with no inference left over:** the Worker computing
`missing_tables` is the Unit 39 Worker (deploy run 32583656010 at `79da2b8`),
so its `EXPECTED_TABLES` already contains `case_content_removed` and
`case_content_event`. `/health` returns `EXPECTED_TABLES` minus what
`sqlite_master` actually holds. The live probe found that list **empty, with
the key present** — so both Unit 39 tables exist on the production D1.

**`portal-setup` run 32583766475 is therefore recorded as SCHEMA APPLIED /
BOOTSTRAP-ONLY FAILURE.** Per the owner's decision 3 it is **not rerun** and no
credential or bootstrap/admin-token handling is changed.

### The check that made this answerable

`verify.sh` fetched `/portal-api/health` and read only `configured`. Its schema
test was a 401-on-login — which proves `users` exists and says nothing about
any table added since. It reports `missing_tables` now, from the response it
was already holding, at no extra request. **An absent key reports UNKNOWN, not
clean**, because a Worker too old to send the field would otherwise match an
empty-array test and report a healthy schema in the reassuring direction.

### Superseded — what was open before that run

### The one thing for the owner to confirm

`portal-setup` is red for a reason that has nothing to do with this unit — the
admin account already exists and the workflow has no branch for the 401 that
produces, so it exits 1 after the schema is already in. The same run is
recorded red-but-applied for Unit 27.

**A one-line check settles it:** open the portal's Settings, or fetch
`/portal-api/health` and look at `missing_tables`. If
`case_content_removed` or `case_content_event` appears there, the removal
routes will answer **503 naming the workflow** rather than failing quietly, and
re-dispatching `portal-setup.yml` is safe and idempotent — it will go red on
the same step and apply the schema again regardless.

---

## PART 15 — Unit 21A, the case-page live region

**Owner decision, 2026-08-22**, on the finding Unit 39 reported rather than
fixed: *"announce actual user-triggered confirmations/status changes; do not
announce ordinary static .note/help text on page/tab arrival."*

`paint()`'s case branch returned before Unit 21's chokepoint, so every
confirmation and refusal inside a case was silent for a screen-reader user. The
one-line call was the trap: `.note` carries both messages and panel prose, so
adding it would have read *"No saved client or firm is linked to this case"*
aloud on every visit to Edit case.

**No text is classified.** `srScreen()` names the screen and `SR_ACTED` records
whether the user has done anything on it. Arrival adopts the baseline silently
and clears the region; a change after a real action is announced. `SR_ACTED`
is set at the four delegated listeners and cleared on arrival, so a nav press
cannot license its own destination.

**The suite rejected the first version.** `srScreen()` alone let Tasks, the
Audit trail and the File queue announce their explanatory paragraphs, because
each paints twice — once on arrival, once when its data lands. Only a real run
could have shown that.

**Known limit:** an action that both produces a message and lands the user on a
different screen is adopted silently.

| | |
| --- | --- |
| PR | **#239** |
| Merge SHA | **`d0b98b1`** |
| Site deploy | `Deploy site to Cloudflare Pages` run **32595336098** ✅ |
| Worker deploy | correctly did **not** fire — `case-portal/worker.js` was untouched |
| Schema | **none** — no `portal-setup` dispatch |
| Suites | worker **2870/0** · portal **2707/0** · deploy guard **86/0** · intake **467/0** · visitor-alerts **47/0** |
| Visual behaviour | unchanged |
| Unit 38 focus behaviour | unchanged |
| LIVE VERIFIED | **OPEN** — the owner's check |

### Two defects the suite found that reading the diff did not

**A screen does not finish arriving in one paint.** `srScreen()` alone shipped
first, and Tasks, the Audit trail and the File queue each failed — they paint
twice, once while data is in flight and once when it lands and draws their
explanatory paragraph. Same screen, changed text. The premise "same screen ⇒
the user caused it" is false for any asynchronously loading panel, and only a
real run could have shown it. `SR_ACTED` replaced the premise with the owner's
own wording.

**Re-pressing the tab you are already on is arrival at it.** The screen string
does not change there, and `invoices` and `calendar` reload on that press — so
tapping the tab you are already looking at would have read its prose aloud.

### And the control that stopped controlling

The control patched `srScreen()` to a constant. That reproduced the defect
until a second mechanism began holding the same property, after which it went
green **while proving nothing** — a false reassurance in exactly the place the
confidence was coming from. It restores Unit 21's entire pre-fix function now,
verbatim, so it cannot be defeated by a guard added later.

---

## PART 16 — SESSION CLOSEOUT, 2026-08-22

**Documentation only. Nothing was coded, branched or deployed to produce this
part.** Every line below was verified rather than carried forward.

| | Verified how |
| --- | --- |
| **Master `c8b52a8`** | `git log` |
| **Working tree clean, in sync** | `git status`, `git log origin/master..HEAD` empty |
| **Site deployed** | `Deploy site to Cloudflare Pages` run **32595545919** at `c8b52a8` — the closeout SHA itself |
| **Worker deployed and current** | run **32583656010** at `79da2b8`; `git diff 79da2b8..c8b52a8 -- case-portal/worker.js case-portal/schema.sql` is EMPTY, so no later commit needed a Worker deploy |
| **Schema present on production** | `harden-check` run **32584685117** — *"every table this build expects is on the database"* |
| **Suites** | worker **2870/0**, deploy guard **86/0**, visitor-alerts **47/0** re-run at `c8b52a8`; portal **2707/0** and intake **467/0** measured at `d0b98b1`, and still valid because every commit since is markdown that neither suite reads |
| **REQUIRED BUILD QUEUE EMPTY** | every open-state marker in `NEXT.md` scanned twice this session, each candidate checked against the code |

### The three units shipped this session

| Unit | PR | SHA | Deploys | Schema | LIVE VERIFIED |
| --- | --- | --- | --- | --- | --- |
| **38** Case Workspace Simplification | #232 | `f2f49d4` | site 32557961911 · Worker 32557961914 | none | ✅ owner, 2026-08-22 |
| **39** Case content Delete / Restore | #234 | `79da2b8` | site 32583655929 · Worker 32583656010 | two tables, applied and confirmed | ✅ owner, 2026-08-22 |
| **21A** Case-page live region | #239 | `d0b98b1` | site 32595336098 · Worker correctly not fired | none | **OPEN** — owner visual check |

### What must not happen next session

**No completed unit is to be rebuilt.** Locked order 1–17, hotfix 17A, Units
18–22, 24–39 and 21A are complete and stay complete.

**Real-case-only LIVE VERIFY items are OPEN, not failed** — Unit 23's sweep,
Unit 17 Retention, and the IMPLEMENTED BUT NOT LIVE VERIFIED block. Deployed
and machine-verified, waiting only on the owner having a real case. **No
production data is to be manufactured for any of them.**

**Deferred-by-owner items are DEFERRED, not queued.** The list in `NEXT.md` is
unchanged and none of it is work to pick up.

**Owner decisions stay locked** — the five from the 2026-08-21 closeout and the
three from Unit 39.

### The one lesson this session paid for twice

**A stale status marker is not documentation debt — it is an instruction to
rebuild something that already works.** OWNER WORKFLOW SIMPLIFICATION read
`QUEUED` while all five parts had shipped and nothing had ever closed it; the
same shape was then found across roughly nine hundred lines of pre-queue
handoffs. Nothing was deleted — several record *why* a decision went the way it
did — but the region is banner-marked as archaeology and the eleven most
misleading rows are mapped to where each actually landed.

---

## PART 17 — UNIT 40, the homepage CTA redesign, 2026-08-22

**A new owner brief, not a queue item.** Approved direction: replace the hero's
two assignment buttons with three equal image-style cards — Insurance, Legal,
Private — each routed to its own intake door, with the public-pricing rule and
the accessibility requirements intact.

| | Verified how |
| --- | --- |
| **Master `e7b9117`** | `git log`; save point `save/2026-08-22-2059-e7b9117` cut automatically |
| **Shipped** | PR **#242**, squash-merged |
| **Site deployed** | `Deploy site to Cloudflare Pages` run **32598263366** at `e7b9117` — ✅ success, on the Unit 40 SHA itself |
| **Worker** | untouched. `git diff 001d354..e7b9117` names seven files and none is in `case-portal/` or `visitor-alerts/`, so `deploy-portal.yml` and `deploy-worker.yml` correctly did not fire |
| **Schema** | none. No `portal-setup` dispatch owed |
| **Suites** | intake **537/0** · deploy guard **86/0** · worker **2870/0** · portal **2707/0** · visitor-alerts **47/0** |
| **Routing** | asserted by CLICKING each card and reading the page it lands on — Secure Assignment Intake / Legal Investigation Assignment / Client Intake — not by matching an href |
| **LIVE VERIFIED** | ✅ **owner, 2026-08-22** — visual review passed |

### The requirement each half of the brief made, and where it is met

| Brief | Met by |
| --- | --- |
| Three equal cards, consistent height and width | a `repeat(3,1fr)` grid, so equality is the layout's property; equal heights asserted |
| Background visual + dark overlay + icon + large title + teal Get Started | `--cta-art` per card, `.cta-art::after` gradient, three stroked icons, 21.44px serif title, `--teal` fill |
| Insurance → Insurance intake, Legal → `?assignment=legal`, Private → Private intake | three anchors, asserted end to end by click-through |
| **Do not route Legal through Private** | its own assertion, stated as the rule rather than as a heading comparison; `pickSvc` also refuses `legal` on the private door |
| No public pricing | asserted on the homepage **and on every door a card opens** |
| Keep Contact Us / Call / 5-star + DCJS below the cards | asserted present and wired |
| Mobile stacks Insurance/Legal/Private, no horizontal scrolling | one column at 640px in source order; no card crosses the edge at 390/360/320 |
| Real accessible link, proper accessible text, not reliant on the image | `role=link` with `name` equal to the title, read from the **browser's accessibility tree** |
| Visible keyboard focus | one tab stop per card, ring measured as `3px rgb(230, 181, 74)` on the focused element |
| Sufficient contrast | **computed**, with the WCAG bar chosen from the rendered size and weight; the title's backdrop sampled from painted pixels |
| Audit local assets first, no hotlinking, structured for a WebP swap | no reusable photography exists (`banner1.webp` is the hero background; the rest is the logo and three review screenshots), so three local SVG motifs, each named by one `--cta-art` property |

### What measuring found that reading would not have

1. **The insurance icon was a blob** — a filled car body whose two filled wheels
   disappeared into it at the 34px it actually renders at. Stroked now.
2. **The 320px overflow was halved, not tolerated.** Master overflowed 15px and
   its widest element was the old hero button these cards replaced; the branch
   overflows 5px from an untouched `tel:` link. The first draft of this note had
   it backwards.
3. **The Get Started label failed WCAG AA** at 15.2px bold — 3.37:1 against a
   4.5:1 bar. Sized to 18.88px it is large text at a 3:1 bar, which it clears,
   and no new colour was invented.
4. **The accessible-name assertion's own comment was wrong**, caught by a
   control: with `aria-hidden` stripped the name grows but `children` stays 0,
   so name **equality** is the clause that works and an inclusion check would
   have passed through the defect.
5. **A measurement destroyed what it measured** — `visibility:hidden` for pixel
   sampling also removes elements from the accessibility tree, so it left every
   later name assertion reading `""`. It has its own page now.

### The one decision it raised — ANSWERED, and LOCKED

**OWNER, 2026-08-22:** *"Keep the current global teal unchanged. The Unit 40
card-button accessibility treatment is approved as implemented."*

The finding stays on the record because it is true: white on `--teal` is
3.37:1 across the whole public site — the nav call button, the section CTA, the
hero buttons Unit 40 replaced — and below 18.66px bold none of them clears AA.
It was put to the owner with the measured alternatives (`#33808f` 4.54:1,
`#2f7788` 5.10:1, `--navy` on the existing teal 4.67:1) rather than fixed by
making one control differ from the rest, and the owner kept the palette.

**What that makes durable:** sizing at or above 18.66px bold is the APPROVED
mechanism for white text on `--teal`, not a stopgap. Darkening `--teal` was
offered and declined — **a later unit must not do it**. A control needing
white-on-teal below that size is a new question for the owner.

### Standing rules, unchanged by this unit

No completed unit is to be rebuilt. Real-case-only LIVE VERIFY items stay OPEN,
not failed. Deferred-by-owner items stay deferred, not queued. The owner
decisions — five from the 2026-08-21 closeout, three from Unit 39 and **one
from Unit 40** — stay locked.

---

## PART 18 — UNITS 40A–40F, the cards get photographs, 2026-08-22

Both arrived as owner direction during Unit 40's visual review.

| | Verified how |
| --- | --- |
| **40A — no icons** | PR **#245** at `9756e59`, site deploy run **32604481612** ✅. intake 539/0 |
| **40B — three photographs, neutral overlay** | PR **#246** at `7d1f7e4`, site deploy run **32604959775** ✅. intake **542/0**, deploy guard **86/0** |
| **40C — insurance gets its own setting** | PR **#248** at `154f98f`, run **32605298442** ✅. The first insurance photo was a suburban street, and so is the private one — they read as a pair. Replaced with a commercial yard |
| **40D — the van is the subject** | PR **#249** at `fe464f6`, run **32605491582** ✅. Owner reported "not the van image" about an image that WAS the van image: it sat in the left third, behind the headline. Mirrored, like the legal card |
| **40E — Get Started centred and low** | PR **#250** at `3bc855f`, run **32605653071** ✅. `align-self:center`; `margin-top:auto` already held it low. intake **547/0** |
| **40F — the art is cache-busted** | PR **#251** at `5819540`, run **32605892675** ✅. intake **548/0** |
| **Worker** | untouched by both — `portal/`, `case-portal/` and `visitor-alerts/` confirmed absent from the staged diff |
| **Schema** | none. No `portal-setup` dispatch owed |
| **LIVE VERIFIED** | ✅ **owner, 2026-08-22** — *"They are live i have verified"*, confirmed on the live site after the cache fix |

### Unit 40's central claim was tested, and it held

Unit 40 was built so photographs could replace its placeholder motifs *without
the layout moving*. Three owner-supplied images went in and the change was
**three `url()`s and three manifest lines**. Heights 236/236/236, titles
645/645/645, grid untouched. The property is now proven rather than asserted —
and `CLAUDE.md` records what would end it: a per-card `background-position` or
a bespoke height for one card.

### The blue was the overlay, not the photographs

Owner: the cards should *"not be so blue hued."* The cast came from
`rgba(19,35,60,.62)`→`rgba(12,22,38,.88)` laid over all three. **Neutral black
at the same alpha is darker than navy**, so going neutral removed the cast and
bought contrast headroom, which then paid for lightening it. `.50/.82` ships at
5.16 / 5.25 against a 4.5 bar. `.46/.80` was rejected at 4.53 / 4.66 — it
clears by 0.03, and one brighter photograph later it would fail silently.

### Three assertions that had stopped asserting

The unit's real yield, and all the same shape:

| Assertion | Why it was dead |
| --- | --- |
| icons are decorative | `[].every()` is TRUE — passed while testing nothing, and would have passed on a card that lost its **artwork** |
| the title clears 4.5:1 | read the FIRST `.cta-title` only; with three different photographs the brightest card decides, and it was not necessarily the one measured |
| the art is a local path | required `\.svg`, so it would have failed on the WebP the architecture was designed to accept |

All three now assert in both directions, and the overlay's neutrality is pinned
by shape rather than by comment.

### Two images were rejected rather than accepted

The first private image put its subject in the bottom third — cropped on a
phone, and where the overlay is heaviest — so the card drew an empty sky. The
rule that came out of it is recorded in `CLAUDE.md`: **a replacement image
needs its subject in the central 60% of the frame.**

### The defect that took an owner report to find

`_headers` caches `/assets/*` for **seven days**, and Units 40B–40D replaced
the same three filenames **in place at stable URLs** — `card-insurance.webp`
was three different photographs at one URL inside an hour. `index.html` is
`no-cache`, so the markup updated while the browser went on serving the FIRST
image it had cached.

**A stale asset behind fresh markup is indistinguishable from a deploy that
never ran.** Seven green deploys and the owner was still right that the site
had not changed. Every `--cta-art` carries `?v=` now, a test fails if one loses
it, and `CLAUDE.md` says to bump it whenever one of those files changes.

Worth keeping beyond this unit: **"is it deployed" and "is the visitor seeing
it" are different questions**, and every check in this repo answered only the
first.

### Four assertions that had stopped asserting

Counting 40A's and 40B's, this unit found four dead checks — all green, none
testing anything:

| Assertion | Why it was dead |
| --- | --- |
| icons are decorative | `[].every()` is TRUE on an empty list |
| the title clears 4.5:1 | measured only the FIRST of three different photographs |
| the art is a local path | required `\.svg` on an architecture built to accept WebP |
| the art resolves locally | anchored on the extension being LAST — failed on its own `?v=` fix |

The last two are the same mistake: **a regex asserting a SHAPE where a
PROPERTY was meant.** The homepage door checks earlier in Unit 40 were the
first instance; these are the second and third.
