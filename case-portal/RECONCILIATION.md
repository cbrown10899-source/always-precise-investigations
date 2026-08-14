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
preview). ⚠️ open owner decision: "Serving ALL of Virginia" vs the
hour's-drive location pages.

## X. Role security — server-side, tested by attempting it

An investigator, by direct URL/API: another investigator's case → 404; rates,
`/pricing`, `/sheets` → 403; invoices → 403; build surface → 403; completed
desk → 403; leads desk → 403; admin notes withheld; client identity absent
from every payload unless `show_client_identity` (default off, admin-only
route); money fields never in `FIELD_KEEP`; list rows redacted (proven on a
row they CAN see). The hostile-case-number XSS row is planted in the DB and
tested. ✅ — **770 worker checks, none of this by hidden buttons.**

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
