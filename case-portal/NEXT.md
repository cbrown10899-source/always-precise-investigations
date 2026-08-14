# NEXT — session continuation state (INTERNAL)

**Purpose:** a fresh Claude Code session starts here. CLAUDE.md loads
automatically and carries the standing procedures (rebase dance after every
squash merge, portal-setup dispatch after schema changes, Actions-listing
overflow pattern, guard tests). This file is the live queue and in-flight
state. Update it when the queue moves; keep it short.

**`MASTER-HANDOFF.md` next to this file is the owner's consolidated source of
truth** (recorded verbatim 2026-08-13).

## ⏰ START HERE — handoff to the local session, 2026-08-14

**Implementation moved to the owner's local Claude Code + Codex.** This
remote session stopped deliberately after recording the findings below; it
did not begin any of the outstanding fixes. Nothing is half-done in the tree.

**The local session has since picked it up (2026-08-14).** What it has done so
far, before touching the HIGH queue: discharged the WIP note left on the arrival
generator commit (its e2e run had been in flight and its assertions unverified —
they now run, 678/678), and settled the open OWNER DECISION on what a reassigned
investigator keeps. See both below.

**Read `RECONCILIATION.md` first.** It carries the full reconciliation
against the master handoff — every lettered section, granular rows, evidence
per item — and at the top of its OPEN FINDINGS section, **the HIGH queue in
the owner's stated order**. That order is the work list.

### The HIGH queue, in the owner's order

1. **A running or open pause can record a real surveillance day as 0 hours.**
   `worker.js` ~1747-1766. Highest because it destroys billable time silently
   and `hours` is what authorization and invoices draw against.
2. **Reassigning a case can strand a running investigation day** — nobody,
   not even an admin, can close it afterwards. `worker.js` ~1693-1734, ~1020,
   ~3081. No in-product recovery path exists.
3. **A backward invoice status transition can reopen a paid invoice and
   remove it from Outstanding.** `worker.js` ~2454-2489, ~2349, ~2357, ~3063.
4. **The Case Build finalize gate strip can be hidden when the package is
   actually ready to finalize**, so held-back material can ship with the
   warning suppressed. `portal/index.html` ~2976, ~3160-3245, ~3069;
   `worker.js` ~2678-2697.

Plus the MEDIUM that belongs with 1 and 2: **every surveillance date is UTC
while every surveillance time is local**, so evening work files a day late.

### The rule that applies to every one of them

**These are REVIEWER CLAIMS, not verified facts.** Each came from an
independent audit with a file:line citation; none was independently
re-verified before this session stopped. Verify against the actual code
before writing a fix.

That caution is not ceremonial. Today a confirmed bug — the retainer
consuming itself — survived precisely because **two tests had encoded it as
the rule**, asserting `applied === 1500 && balance === 0`. Expect the same
shape: when a fix makes a test fail, decide which one is wrong before
changing either.

### What this session DID ship (all merged, all green)

PRs #60–#69. The Completed Cases desk; lead statuses with both send actions
on the lead card; the private intake door and intake link previews; §38/§39
end-to-end walkthroughs as tests; the §29 homepage; the §10 field
vocabulary; the send-history log; the visible intake checkbox on the send
wizard's first screen; two beacon bugs that silently lost real visits; and
from the audits — two boundary leaks (an office note reaching the field by
default, and an offer disclosing on decline what it withheld while pending),
a rate sheet sendable against a lead of the opposite kind, a removed entry's
text printing as an exhibit caption, two intake placeholders, a `/health`
check that reported clean on a broken schema, and the retainer double-count.

**Suites at last green (2026-08-14, master `c60a584`):**

| Suite | Checks |
| --- | --- |
| `case-portal/test-worker.mjs` | **794** |
| `portal/test-portal.mjs` | **670** |
| `intake/test-intake.mjs` | **205** |
| `visitor-alerts/test-worker.mjs` | **47** |

### Still the owner's, not code's

- **"Serving ALL of Virginia since 2014"** vs. location pages scoped to about
  an hour's drive. §29 says do not state coverage unless verified.
- **The literal §29 homepage section order** (dedicated Insurance and Private
  sections) — the two-path hero shipped instead, deliberately.
- **Dropbox** — needs `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`,
  `DROPBOX_REFRESH_TOKEN` as repository secrets; `portal-setup` pushes them
  all-or-nothing, and `case-portal/README.md` has the app-console steps.
- **Real iPhone Safari / Android Chrome**, including the camera picker and
  device dictation — nothing headless can cover those.

---

Snapshot date: 2026-08-14. Branch: `claude/arrival-sentence-generator`, rebased
onto master `aa107b4` (**PR #71**). The counts are in the START HERE header
above — worker 794, portal 670, intake 205, alerts 47. (This line used to repeat
an older, lower set and contradict the header; one snapshot, in one place.)

> **Running the two browser suites on Windows needs a NODE_PATH.** Their loader
> only falls back to Linux global paths, so a global Playwright install is
> invisible to it: `NODE_PATH=$(npm root -g) node portal/test-portal.mjs`. Do
> **not** fix this by installing into a local `node_modules` — `deploy.yml`
> rsyncs the repo root to Cloudflare Pages and would publish it.

---

## FULL RE-AUDIT, 2026-08-14 — read this before trusting anything below

The owner ordered a reconciliation of the **entire** master handoff against
the **actual code on master**, explicitly because a PR touching an area is not
evidence the requirement in that area is met. That audit was done. It changed
this file's contents in both directions: it found work recorded here as
outstanding that is in fact **shipped and enforced**, and it found
requirements no ledger had ever recorded at all.

**Two entries in the previous version of this file were simply wrong:**

- **"Allow investigator to view client identity" (§33) was listed as a gap.
  It is built and enforced server-side** — `case_settings.show_client_identity`
  gates `CLIENT_IDENTITY_FIELDS` in `worker.js`, default off, and the setting
  route is admin-only. It was never a gap; the note was inherited and never
  checked.
- **"Requested vs Confirmed authorization" was already marked done, and is.**
  Verified: both labels exist in the page and are tested.

**The audit's method, for whoever repeats it:** grep the actual identifiers in
`worker.js`, `portal/index.html`, `schema.sql` and both test suites. A feature
name appearing in a ledger, a PR title or a comment proves nothing. A route,
a table, a rendered control and a test that fails without it are the evidence.

---

## SECOND AUDIT, 2026-08-14 (master `f330105`, after #65–#68)

The re-audit above was written against master through **#64**. Four PRs landed
after it, and this pass re-checked the whole master handoff against `f330105`
with all four suites run on that SHA. **It supersedes the rows it names and
nothing else.** Everything already shipped was left untouched.

**Three ledger entries were stale or wrong, in the direction of understating
what is built:**

| Entry | Said | Actually |
| --- | --- | --- |
| Sheet send history | 🔴 "next code item"; `RECONCILIATION.md` TOP FIX #1 | ✅ **shipped #67** — `send_log`, `schema.sql:804`, 9 refs in `worker.js` |
| Lead event timeline | 🟡 TOP FIX #2 | ✅ closed by the same table; only hand-edited status changes stay unlogged |
| Arrival sentence generator | "the one §10 piece left" — reads as absent | 🟡 **it exists** — `amArrival` (`portal/index.html:5761`), inputs at 2266/2268, e2e at `test-portal.mjs:1381` |

`RECONCILIATION.md` is a dated report and was deliberately **not** rewritten;
its TOP FIXES list contradicts its own §A, and §A is the correct half. Read
this section for the live queue.

**Requirements NO ledger row had ever recorded — all found substantially
built.** These were audited because the master handoff has sections the
reconciliation checklist simply has no row for:

| Master § | State | Evidence |
| --- | --- | --- |
| §34 investigator compensation vs client rate | ✅ | `user_rates` (hourly + mileage); admin writes `worker.js:4573`, investigator reads only their own at 4682 |
| §35 expenses / mileage | ✅ | `case_expenses` CRUD `worker.js:1925–1978`, `/my/expenses` 4688; the three §35 concepts are real columns — `reimbursable` / `billable` / `internal` |
| §36 communications & tasks | ✅ | `case_comms` 2041, `case_tasks` 2072–2093, surfaced on the dashboard at 788 |
| §9 contextual back on deep screens | ✅ | Back to Cases 1897, All invoices 4511, Change type 1498, plus every surveillance back |

The existing 🟡 on "Clients / Reports / Evidence / Expenses / Tasks as top-level
nav" is accurate but misleading on its own: the **features** exist as case tabs
(`expensesPanel` / `commsPanel` / `tasksPanel`, `portal/index.html:3358–3363`).
Only their promotion to top-level nav is deferred, and deliberately.

**The genuinely unfinished item, and it is larger than the ledger implied:**
the §10 arrival sentence generator has **two** gaps, not one.

1. **The position options do not exist.** MASTER §10 asks for vehicles present /
   direct-or-indirect view / primary route of departure, and `SURVEILLANCE.md`
   P6 names five — direct · indirect · primary-route · secondary · mobile. The
   code has two free-text boxes (`qa_vp`, `qa_pos`).
2. **It is desk-only.** `svEntryScreen` (`portal/index.html:3855–3879`) carries
   no arrival extras at all, so the generator is missing from the field mode —
   the one place an investigator actually logs an arrival, from a parked car.
   P6 puts arrival templates in the field quick-activity explicitly.

### ⚖️ OWNER DECISION — what a reassigned investigator keeps

Raised by an independent Codex review of the permission boundary, 2026-08-14.
**No behaviour was changed. Nothing here is a leak of client identity** — this
is a scope question the owner has to answer, not a bug to fix quietly.

**What is true today.** `/my/reports`, `/my/expenses`, `/my/active`, `/calendar`
and resolved `/my/offers` scope by **who created the record**
(`investigator_id = ?`), never by the case's current `submissions.assigned_to`.
So when an admin reassigns a case, the previous investigator loses the
workspace but these routes still return that case's **case number**, and
`/my/active` also returns `subject_name` (`worker.js:3081–3087`). Their own
expense amounts and their own submitted reports keep coming back, which §34 and
§35 positively require for an investigator's OWN records.

**The question:** should a reassigned investigator continue to see their own
previously submitted reports, expense claims, calendar history and active-day
records for a case that is no longer theirs?

- *Keep* — they worked those days and are owed the record of their own pay and
  their own filed work; removing it deletes their evidence of what they did.
- *Scope to current assignment* — a case that is no longer theirs should
  disappear entirely, case number and subject included.
- *Split* — keep the money and the filed report, drop the case number, the
  subject and anything about the case's continuing life.

**The firm line, whichever way that goes:** a reassigned investigator must
**never** regain client identity, carrier, claim number, billing details, or
any access to the current state of that case unless an admin explicitly
permits it. That part is not a decision — it is the boundary, and it holds
today (`redactRow` drops all five denormalised client columns regardless of
which route answered).

Two things verified while raising this, so they are not re-litigated: the
`show_client_identity` toggle revealing carrier / claim number / client name is
**§33 working as specified**, default off and admin-only; and `/my/comp`
returning the investigator's own hourly and mileage is **§34 working as
specified**. Neither is a defect.

---

## Reconciliation checklist

Legend: ✅ done and verified · 🟡 partial · 🔴 not implemented ·
⚠️ implemented but does not match the handoff · 🧪 built but under-tested

### Rate sheets and intake pairing (§3, §4)

| Requirement | State | Evidence |
| --- | --- | --- |
| Two sheets, strictly separate | ✅ | `rateSheets()`; `RATESHEETS.md`; investigator gets 403 from `/sheets` and `/pricing` |
| Insurance sheet → "Include Insurance Assignment Intake" | ✅ | `sheetWizardHtml()` step 2 label; portal e2e asserts it by name |
| Private sheet → "Include Private Client Intake" | ✅ | same, `intakeLabel` ternary |
| The pairing is decided **server-side**, not by the caller | ✅ | `SHEET_INTAKE` keyed by sheet id in `worker.js`; the page sends only `include_intake` boolean |
| Insurance → insurance intake ONLY, no crossing | ✅ | worker test asserts every `/intake/` occurrence in both HTML and text parts carries `?assignment=insurance` |
| Private → private intake ONLY | ✅ **done 2026-08-14** | `?assignment=private` — the picker without the carrier path, refused even when `pickSvc('claims')` is called directly. The private sheet and the lead send both email this door now |
| Unticked = no intake link at all | ✅ | worker test |
| Client-facing insurance figures $1,200 / $2,300 / $3,300 / $150 hr | ✅ | `RATES.packages` + floor guard test |
| Client-facing sheet hides band, rack rate, discount math, margin, compensation | ✅ | `RATESHEETS.md` separation; investigator 403s |
| No awkward "Additional Fees — None" presentation | ✅ | copy reads as inclusive prose, not a nil line item |

### Intake and INTAKE-NA (§6, §7)

| Requirement | State | Evidence |
| --- | --- | --- |
| Public insurance intake exists | ✅ | `/intake/?assignment=insurance` |
| Public private intake exists | ✅ | `?assignment=private` (2026-08-14); bare `/intake/` still offers all three for anyone arriving on their own |
| Structured provided / not_available states | ✅ | `naBox()`, `applyNaStates()`, `<field>_status` |
| `not_applicable` exists in the model, offered nowhere | ✅ | deliberate, recorded in `INTAKE-NA.md` |
| Never forced to invent information | ✅ | test scans every value field for "N/A", "unknown", 0000, placeholder dates |
| Final review shows PROVIDED vs NOT AVAILABLE YET | ✅ | `naSummary()` |
| Worker and portal status allow-lists synchronised | ✅ | exact sorted-set assertion over `FIELD_KEEP` statuses |
| Admin can create a case from a partial intake | ✅ | only contact + service + one identifier required |
| Original submission preserved | ✅ | `submissions.payload` never rewritten |
| Requested vs Confirmed authorization | ✅ | both labels in the page, tested; only Confirmed is ever paired with money |

### Manual intake and leads (§5)

| Requirement | State | Evidence |
| --- | --- | --- |
| "+ Intake a Client" | ✅ | sidebar and leads bar, `data-tab="newlead"` |
| Choose Insurance / Commercial vs Private Client | ✅ | `nlKind` |
| Save Lead | ✅ | `nlSave` → "Save lead" |
| Create Case | ✅ | "Create case →" |
| **Send Rate Sheet from the lead** | ✅ **done 2026-08-14** | the card opens the SAME send wizard, prefilled — sheet picked by the lead's kind server-side, address and case number riding along. A successful send auto-stamps the lead |
| **Send Intake from the lead** | ✅ **done 2026-08-14** | inline on the card; `/leads/:no/send-intake` pairs the door by the lead's kind (a carrier lead can only ever get the carrier door) and stamps Intake Sent |
| **Lead statuses distinct from case statuses** | ✅ **done 2026-08-14** | `lead_status` side table, the nine §5 statuses, shown and set on the lead card. The system stamps only what IT did (sheet sent → Rate Sheet Sent; with intake → Intake Sent); a lead the office has DECIDED (converted / declined / closed) is never quietly moved by a re-send. `intake_received` is manual on purpose — a public intake carries no lead id, and guessing a match would be invented data |

### Case detail, activity, report, evidence (§8–§12)

| Requirement | State | Evidence |
| --- | --- | --- |
| Activity log feeds the report draft | ✅ | `generateReport()` builds from `activity_log`, skipping removed entries |
| Submit Report preserves a version | ✅ | `report_versions`; test asserts a later admin edit never touches a submitted version |
| Admin reaches submitted / final report and a print-to-PDF | ✅ | `repPrint` |
| Evidence gallery, classifications, soft delete | ✅ | |
| Entry edit + delete (stamped, restorable) | ✅ | `activity_removed`, shipped #55 |
| Sidebar targets Clients / Reports / Evidence / Expenses / Tasks as top-level nav | 🟡 | deliberate: only built when a target is real. Current nav is Dashboard · Cases · Leads & intakes · Calendar · Rate sheets · Invoices · Staff · Settings |
| More quick-activity lines, Surveillance/End-Day categories (§10) | ✅ **done 2026-08-14** | the physical-observation set (walking · standing · sitting · bending · stooping · reaching · carrying · lifting · pushing · pulling · loading · unloading · climbing stairs · shopping · yard work · recreational activity), business and meeting lines, the fuller no-activity and vehicle sets, and a Surveillance category of its own. Every line is a complete sentence, existing strings kept exactly (favorites are stored by text). The §10 **arrival sentence generator** is the one §10 piece left — see the second audit above: it EXISTS on the desk sheet but has free-text position instead of P6's five options, and is absent from the field mode entirely |

### Case Build (§13) and Case Package (§32)

| Requirement | State | Evidence |
| --- | --- | --- |
| Report → review → photos → video → package → preview → finalize | ✅ | |
| Report Only / Report + Photos / Full / **Custom** | ✅ | `build_custom` marker, PR #56 |
| Multi-day: one report carrying Day 1..n + combined summary | ✅ | `build_reports`, PR #56 |
| Report + photos document reads like a real report | ✅ | case information, assignment objective, per-day sections, captions, evidence index |
| Original evidence never overwritten by a copy or thumbnail | ✅ | document references the original evidence route only |
| Package card blocks each route to their module | ✅ | every block is a `pkgJump` with a real `MOD_TAB` target; no dead controls |
| **Combined PDF is a real document, not just UI** | 🧪 | it is a real print stylesheet over real data and is asserted in e2e, but nothing verifies the *printed* artifact — only the rendered DOM |

### Completed cases (§31)

| Requirement | State | Evidence |
| --- | --- | --- |
| An obvious Completed Cases path | ✅ **done 2026-08-14** | the Cases tab carries an All / Open / Completed lens (admin only). Completed = stage `complete` or `closed`, **or a finalized client package** — finished work is findable before the case is administratively closed. Cancelled is deliberately excluded: nothing to find |
| Per-case artifact actions from there | ✅ **done 2026-08-14** | `/completed` (admin-only) carries per-case artifact state in one payload; each desk card offers Open case · Final report (with day count) · Evidence (with count) · Client package · Invoice (by number) · Copy video link — and **a button only where the artifact exists** (P22, no dead controls). Deep links land on the tab that holds the download |

### Video / Dropbox (§14)

| Requirement | State | Evidence |
| --- | --- | --- |
| Add Video to Package | ✅ | role `video` items, gated by package type |
| Provider architecture, generic fields | ✅ | `external_files`, `EXTERNAL_PROVIDERS` |
| Video upload to Dropbox | 🔴 | route returns 501; no API client exists |
| External file association | 🟡 | schema and reads exist; nothing writes them from a real upload |
| Create share link / revoke link | 🔴 | not implemented |
| Case Build + evidence index video reference | ✅ | document lists video and states delivery separately |

**Dropbox is NOT done.** The Case Build screen naming Dropbox is a
not-configured status message, not an integration. Blocked on the owner's
`DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN`.

### Invoices (§28)

Audited in full 2026-08-14 (PR #57). Create-from-case, number, client, claim
refs, service dates, line items, due date, terms, balance, status, print-to-PDF,
BILL reference, manual and partial payments, duplicate warning and audit trail
are all real and tested. `overdue` is derived against today, never stored.
Special Instructions and the private Retainer / Applied / Additional
Authorization / Balance block were the two gaps and are now closed.
**Write-Off remains deliberately absent** — the owner's own "if needed later".

### Active Surveillance Mode (§15–§27)

Audited subfeature by subfeature rather than as one name.

| Subfeature | State |
| --- | --- |
| Same authentication, same case, same database, no parallel tables | ✅ |
| Start / resume investigation day | ✅ |
| Persistent server-derived timer (survives reload, sleep, wrong clock) | ✅ |
| Quick activity, searchable templates, favorites, one-tap No Change | ✅ |
| Timeline | ✅ |
| Photo capture (`capture="environment"`) and video upload | ✅ |
| Evidence linking to the latest entry | ✅ |
| Voice entry, transcript review, Use Text / Discard, never auto-submit | ✅ |
| Report preview inside the mode | 🟡 hands off to the full report screen; a mobile draft reader is still the nice-to-have |
| End day and review, with totals | ✅ |
| Mileage | ✅ |
| Bottom navigation | ✅ |
| Case info drawer | ✅ `svCaseDrawer()` |
| Remaining authorization (hours, never money) | ✅ |
| Back inside the mode / Exit active mode | ✅ shipped #55 |
| PWA manifest, icons, home-screen launch | ✅ |
| Admin "Out now", no location of any kind | ✅ |
| **A top-level way IN, without the home-screen icon** | ✅ **done 2026-08-14** — an "Active surveillance" item in the navigation, both roles, opening the same launcher `?surveillance=1` opens. Tested at iPad (1112×834) and phone (390×844) widths |
| **Pause / resume the day timer** | ✅ **done 2026-08-14** — `case_day_pauses` spans, server-recorded. Elapsed is `(now - started) - closed spans`; an open pause freezes the display on `paused_at`. Breaks come off the billable total |

**✅ FIXED 2026-08-14 — was: the launch button has no top-level door.** `svLaunchButton()` renders in
exactly two places, `overviewPanel()` and `fieldHomeHtml()` — both of which are
a *case's Overview tab*. There is no header button, no nav tab and nothing on
the dashboard. So from Safari on an iPad you must sign in → Cases → open a
case → Overview before the button exists. The only other door is
`?surveillance=1`, which is the PWA start URL and therefore assumes the icon
is already on the home screen. Owner reported this on 2026-08-14; fixed the same day. The
case-level button stays as the shortcut — the nav item is the door.

**✅ FIXED 2026-08-14 — was: pause does not exist.** No `pause` concept in `portal/index.html`,
`worker.js` or `schema.sql`. When it is built the timer rule holds: the day's
elapsed time derives from server timestamps and never from counted ticks, so
paused spans must be **recorded server-side and subtracted**, not tracked in
the browser. It was built that way: `case_day_pauses` holds the spans, a
partial unique index allows only one open pause per day (so two taps on a
flaky connection cannot open two), and `hours` at day end is the WORKED
figure with the break subtracted — because `hours` is what authorization and
invoices draw against. The day-end message names the break rather than
quietly returning a shorter day.

### Public website / SEO (§29, §30)

| Requirement | State | Evidence |
| --- | --- | --- |
| Social Media Search removed everywhere | ✅ | zero occurrences across every public page; guard test |
| Hero states surveillance for insurance, legal and private clients | ✅ **done 2026-08-14** | "Surveillance & Investigation Services for Insurance, Legal and Private Clients" |
| Two client paths (Submit an Insurance Assignment / Request a Private Investigation) | ✅ **done 2026-08-14** | the hero's primary row, each through its own intake door; Contact and Call remain one row down. Guard tests hold both doors and refuse a bare `/intake/` link |
| Portal login secondary | ✅ | already not prominent |
| Homepage section order per §29 | 🟡 | hero → paths → services (claims card now leads the grid, every consumer service still on it) → **How an Assignment Works (new, four steps, quotes nothing)** → reviews → about → CTA → locations. A literal full reorder (dedicated Insurance and Private sections) was deliberately NOT done blind — §29 also says "do not make the homepage bloated", and the two-path hero already gives each audience its door. **Owner: eyeball the live homepage and say if you want the literal §29 order** |
| Title / description / canonical / OG / JSON-LD on service pages | ✅ | all present on the homepage and the three service pages |
| Same on `/intake/` | ✅ **done 2026-08-14** | description, canonical and OG added. `noindex` stays — the form is reached by being sent the link; the OG tags are for the preview a mail client draws when that link is shared |
| Do not invent coverage claims | ⚠️ | the homepage says **"Serving ALL of Virginia since 2014"** while the location pages are deliberately scoped to about an hour's drive (Roanoke, Lynchburg, Charlottesville, Danville, Bedford, Farmville). Those two claims disagree; §29 says not to state coverage unless verified. **Owner decision, not a code fix** |

### Permissions (§33) and end-to-end (§38, §39)

| Requirement | State | Evidence |
| --- | --- | --- |
| Admin vs investigator enforced server-side, not by hidden buttons | ✅ | 707 worker checks, including URL/API attempts at another investigator's case, billing, margin, invoices, rates |
| `FIELD_KEEP` allow-list, page copy kept in sync | ✅ | drift test |
| "Allow investigator to view client identity", default off | ✅ | `show_client_identity`, admin-only route — **this file previously said otherwise and was wrong** |
| Full end-to-end insurance walk-through (§38) | ✅ **done 2026-08-14** | one section, one case: sheet (carrier door stamped on the lead) → partial intake with unknowns → confirm 24 h/$3,300 (admin-only price) → assign → field day with photo+video (client-deliverable on upload) → report from the timeline → build finalized (Dropbox honestly unconfigured) → flat $3,300 invoice → BILL ref → paid by arithmetic → on the completed desk with every artifact. **Finding: no dead ends existed** |
| Full end-to-end private walk-through (§39) | ✅ **done 2026-08-14** | same shape, retainer model throughout: private door on the sheet, $1,500 received, work, build, retainer-typed invoice with the §28 block, paid, completed. The two billing models never blur |

### Mobile / iPad (§41)

| Requirement | State | Evidence |
| --- | --- | --- |
| Phone can reach the navigation | ✅ | burger fixed #54; e2e at 390×844 |
| Field mode at phone width | ✅ | e2e |
| iPad landscape | 🧪 | screenshots are taken at 834 but nothing asserts iPad-specific behaviour |
| Real iPhone Safari / Android Chrome | 🔴 | needs the owner — camera picker and device dictation cannot be covered headlessly |

---

## TOP 10 REMAINING ITEMS, in priority order

1. ~~**A top-level door into Active Surveillance Mode**~~ — ✅ done 2026-08-14.
2. ~~**Pause / resume the day timer**~~ — ✅ done 2026-08-14.
3. ~~**Completed Cases path** (§31)~~ — ✅ done 2026-08-14 (lens + desk, above).
4. ~~**Lead statuses** (§5)~~ — ✅ done 2026-08-14.
5. ~~**Send Rate Sheet / Send Intake from a lead** (§5)~~ — ✅ done 2026-08-14.
6. ~~**Public website §29**~~ — ✅ substantively done 2026-08-14 (hero, two
   paths, How an Assignment Works, claims card leads the grid). 🟡 remains
   only on the literal section reorder — owner's call, see the table.
7. ~~**A private-only intake door**~~ — ✅ done 2026-08-14.
8. ~~**`/intake/` metadata**~~ — ✅ done 2026-08-14.
9. ~~**Two end-to-end walk-through tests** (§38, §39)~~ — ✅ done 2026-08-14.
10. **Dropbox video delivery** (§14) — 🔴, and **blocked on the owner's three
    Worker secrets**. Everything above it is unblocked.

Added by the second audit (2026-08-14, master `f330105`), now the top of the
queue because 1–9 are done and 10 is blocked:

11. ~~**Sheet send history**~~ / ~~**lead event timeline**~~ — ✅ shipped #67;
    they were still listed as TOP FIXES #1 and #2 in `RECONCILIATION.md`.
12. **The §10 arrival sentence generator, finished** — 🟡 **IN PROGRESS.** Give
    the position the five P6 options (direct · indirect · primary route ·
    secondary · mobile) instead of a free-text box, and carry the generator
    into the field mode, which does not have it. The generated line stays
    editable and stops regenerating the moment it is hand-edited — that is what
    keeps a template from becoming a fabricated fact.

Still needing the owner rather than code: real iPhone Safari and Android
Chrome testing, the Dropbox credentials, and the Virginia coverage wording.

---

## How to resume in a fresh session

1. `git fetch origin && git checkout claude/app-crashes-lockups-debug-psf6zd`
2. Read this file, then `MASTER-HANDOFF.md`.
3. Run the suites first: `node case-portal/test-worker.mjs`,
   `node portal/test-portal.mjs`, `node intake/test-intake.mjs`,
   `node visitor-alerts/test-worker.mjs`.
4. Per-feature rhythm: build → tests green → ledger + CLAUDE.md counts →
   commit/push → PR → squash-merge → rebase dance → portal-setup dispatch
   only when schema.sql changed.
5. **Verify, do not assume.** The 2026-08-14 audit exists because a ledger
   entry is not evidence. Grep the identifier, find the route, find the test.

## Owner context worth carrying

- Free-plan failsafe is live and non-negotiable. Do not raise caps.
- Two rate sheets are separate products; carrier pricing never public; no
  dollar figure in portal or intake HTML (guard tests enforce).
- Investigator boundary: `FIELD_KEEP` allow-list; money and client identity
  never reach investigators unless an admin turns `show_client_identity` on.
- The owner works from phone, iPad and desktop, sends handoffs mid-build, and
  wants every handoff RECORDED VERBATIM in `case-portal/` before building.
- Do not reintroduce a "landing vs click" load bug: any view that can be
  landed on directly must fetch what a later tab click would have fetched.
- A CHECK constraint cannot be widened from `schema.sql`, and
  `ALTER TABLE ADD COLUMN` is not idempotent. Use a companion table —
  `activity_removed`, `build_custom` and `build_reports` are the precedents.
