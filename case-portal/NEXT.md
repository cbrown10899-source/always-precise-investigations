# NEXT — session continuation state (INTERNAL)

**Purpose:** a fresh Claude Code session starts here. CLAUDE.md loads
automatically and carries the standing procedures (rebase dance after every
squash merge, portal-setup dispatch after schema changes, Actions-listing
overflow pattern, guard tests). This file is the live queue and in-flight
state. Update it when the queue moves; keep it short.

**`MASTER-HANDOFF.md` next to this file is the owner's consolidated source of
truth** (recorded verbatim 2026-08-13).

## ✅ LIVE VERIFIED CHECKPOINT — owner, 2026-09-02 (end of the mobile window)

**Master at `8355dec` (PR #272) is the owner-verified working state**, confirmed
on the owner's actual iPhone in the closeout brief of 2026-09-02. Verified there:
Full Portal on ONE tap with the dashboard shell painting immediately; the gold
drawer close handle visible with hamburger/✕ intact; compact Quick Tools,
Search and empty Today / next actions; the phone header; Assistant Back /
Assistant Home; the Active Surveillance launcher cleanup; the iPhone Assistant
composer safe area; intake-deletion safeguards; immutable audit behavior; and
the Private / Legal / Insurance payment boundaries. The point of return is
this checkpoint's `save/` tag (cut by `save-point.yml`) plus D1 Time Travel —
see CLAUDE.md "Save points and rollback". Hardening work after this point
starts from here and must not move any of the behaviors listed above.

## 🔒 LOCKED ORDER — owner, 2026-08-18

The queue, in the owner's own words. **Nothing below jumps ahead of anything
above it**, and nothing after the item in progress is to be started until that
item is finished.

| # | Work | State |
| --- | --- | --- |
| 1 | Finish current Active Surveillance mobile and voice polish | **DONE — DEPLOYED** at `c333d3f` (#182). §13 photo/video commands, §8 retry/offline and server-side duplicate protection, §1/§16.1 compact status. Two device-only checks OPEN, below. |
| 2 | Build Timestamp Photo | ✅ **DONE — LIVE VERIFIED** by the owner on 2026-08-19 at `b0304cb` (#188), portrait layout and Save to Dropbox included. Shipped over #183–#188. |
| 3 | Visible Dropbox portal UI for Admin | ✅ **DONE — DEPLOYED** at `5baabd3` (#189). LIVE VERIFY **OPEN** for the owner |
| 4 | Admin report workflow and mobile report fix | ✅ **DONE — DEPLOYED** at `94b1f5b` (#190). LIVE VERIFY **OPEN** for the owner |
| 5 | Full portal UI/mobile/dashboard modernization | ✅ **DONE — DEPLOYED** at `6446e3c` (#191). LIVE VERIFY **OPEN** for the owner |
| 6 | **Legal / Law Firm intake** (third intake type) | ✅ **DONE — DEPLOYED** at `1b24467` (#192). LIVE VERIFY **OPEN** for the owner |
| 7 | Repeat Client / Firm Profiles | ✅ **DONE — DEPLOYED** at `860f8fb` (#193). LIVE VERIFY **OPEN** for the owner |
| 8 | Global Case Search + advanced Needs Attention | ✅ **DONE — DEPLOYED** at `8d28196` (#194). LIVE VERIFY **OPEN** for the owner |
| 9 | Multiple Report Templates | ✅ **DONE — DEPLOYED** at `9979fca` (#195). LIVE VERIFY **OPEN** for the owner |
| 10 | Case Timeline | ✅ **DONE — DEPLOYED** at `8d93a9e` (#196). LIVE VERIFY **OPEN** for the owner |
| 11 | Evidence Integrity | ✅ **DONE — DEPLOYED** at `0c0c134` (#197). LIVE VERIFY **OPEN** for the owner |
| 12 | Report Daily Summary Builder | ✅ **DONE — DEPLOYED** at `46ccad6` (#198). LIVE VERIFY **OPEN** for the owner |
| 13 | Portal palette normalization | ✅ **DONE — LIVE VERIFIED** by the owner 2026-08-21, at `fcd3d38` (#199) |
| 14 | Storage Health | ✅ **DONE — LIVE VERIFIED** by the owner 2026-08-21, at `96e994d` (#202) |
| 15 | Case Closeout | ✅ **DONE — LIVE VERIFIED** by the owner 2026-08-21, at `2494716` (#203) |
| 16 | Client Delivery Center | ✅ **DONE — DEPLOYED** at `883fd6d` (#204). LIVE VERIFY **OPEN** for the owner |
| 17 | Retention Controls | ✅ **DONE — DEPLOYED** at `943d0f3` (#205). LIVE VERIFY **DEFERRED — requires a real case** (owner, 2026-08-21) |

---

# ✅ READY FOR HUMAN LIVE TEST — Assistant Units 1–10 + intake delete

Sign in to the live portal as an Admin and walk these in order. Every one
should behave exactly as written; anything else is a finding worth reporting.

1. **Open the Assistant** — click **✨ Assistant BETA** in the left sidebar
   (or the ✨ pill bottom-right on a phone). The dock opens on the right with
   the banner *ASSISTANT BETA — DRY RUN MODE…* and the portal stays visible.
2. Type **`intakes`** — expect an INTAKES status with real counts and
   situation-dependent buttons (REVIEW NEW INTAKES first if any are waiting).
3. Type **`old intakes`** — each older undecided intake is classified
   (ELIGIBLE FOR CLEANUP REVIEW / PROTECTED / POSSIBLE DUPLICATE / NEEDS
   REVIEW) with its reason, and the answer says Beta never deletes.
4. Type **`invoices`** — live counts and the real outstanding total; click
   **SHOW OVERDUE** if offered and watch the follow-up answer arrive.
5. Type **`Take me to billing`** — the screen actually changes to Billing.
6. Type **`What is outstanding?`** — the live figure, with an Open Billing
   button.
7. Open any case → click **✨ Ask Assistant** → type **`invoice preview`** —
   expect *DRY RUN — INVOICE PREVIEW · SIMULATED — NOT CREATED* and the
   would-be invoice; then check **Billing**: no new invoice exists.
8. Still on the case: **`Check this case`**, then **`Is this ready to
   close?`**, then **`Summarize today's activity`** (verbatim entries only),
   then **`Why can't I delete this?`** — the answer names exactly what the
   delete would refuse over.
9. Type **`prepare an intake`** → fill a TEST email (yours) → **Preview the
   dry run** → **Simulate — record only** — expect *SIMULATED — NOT SENT*,
   and confirm no email arrived and Rate Sheets → send history is unchanged.
10. Type **`prepare a rate sheet`** → Legal → Process Service → custom fee →
    Preview — the exact document with the fee you typed; Simulate; nothing
    sends.
11. Toggle **Explain & Guide Me** ON and ask **`billing status`** — the
    answer now LEADS with the screen's plain-language paragraph; toggle OFF
    and ask again — compact.
12. Type **`What needs attention?`** — the Watch list, saying INTERNAL ONLY.
13. On a phone (or narrow window): the ✨ pill opens a full-width bottom
    sheet; **`take me to my assignments`** navigates and the pill returns.
14. **Intake delete (previously fixed live-500):** on the Dashboard's Leads &
    Intakes, click the red trash on a FRESH test intake — the confirmation
    names the person, the delete succeeds, the card is gone. On a developed
    case's intake the delete refuses and points at Archive / Delete case.
15. Sign in as an investigator (if available): the Assistant offers no admin
    doors, `intakes`/`invoices` answer "admin desk", and `cases`/`tasks`
    answer with their own scoped counts.

# 🌙 OVERNIGHT FINAL REPORT — 2026-09-02 (owner-ordered format)

**Branch:** `claude/app-crashes-lockups-debug-psf6zd`, reset to master after
each merge. **Master at this report:** `099b817` (#263), site + Worker deploys both `success` on `099b8174`. **Open PRs:** none.
**Tests at the final ship tree:** worker **3117/0** · portal e2e **2849/0** ·
intake **558/0** · deploy guard **86/0** · visitor-alerts **47/0** — all five
suites, run this window. **Failures/blockers:** none; the open items below
are owner decisions, not defects.

## SECTION 1 — PRE-ASSISTANT PORTAL WORK

| Item | Furthest truthful stage |
| --- | --- |
| Intake delete (dashboard trash, hard delete with dependency guard) | ✅ **DEPLOYED** — #256/#258 (`86fd715`, `14ba2d2`); live `?1`-bind 500 fixed in #258. LIVE VERIFY (a real click on the live portal) is the owner's — this container cannot reach the domain |
| Recent Activity delete-hide (`feed_hidden` marker, never a touch on records) | ✅ **DEPLOYED** — #256 + `portal-setup` run 33570951001 applied the table |
| Mail Check — Legal | ✅ **DEPLOYED** — #257 `ede24f6` + tickable send option #258. Remittance address VALUE still owner-owed (Settings → Invoice defaults) |
| Mail Check — Insurance | ✅ **DEPLOYED** — same PRs, same wording rule (`MAIL_CHECK_LINE`, no address on any sheet) |
| BILL.com preparation | ✅ **DEPLOYED SAFE/DISABLED** — #259 `a2ce137`. `billcomConfig` answers not-ready until the owner types the enable word + https link; **stays dark until the owner says the account is ready** |
| Legal service-aware pricing (five services, three models) | ✅ **DEPLOYED** — #260 `6770609`, both workflows `success` on `67706099` |
| Person Locate / Skip Trace ($250 fixed, from `LEGAL_FLAT`) | ✅ **DEPLOYED** — #260 |
| Process Service standard/custom flat fee (acceptance snapshots the fee) | ✅ **DEPLOYED** — #260; default configurable at Settings → Invoice defaults (`process_fee_default`) |
| Other prior outstanding | Intake Archive **Part 2 brief never arrived — not inferred**; SMS alerting blocked on a provider choice; PORTAL-OPS Permissions spec corrupted — not invented; Bill.com A-list owner-owed |

## SECTION 2 — API ASSISTANT (Beta / dry-run, server-enforced)

| Unit | Furthest truthful stage |
| --- | --- |
| 1 — shell, Beta enforcement, provider adapter (not ready) | ✅ **DEPLOYED** — #261 `b379990`, both workflows `success` on `b3799902` |
| 2 — navigation, context, explain | ✅ **DEPLOYED** — #261. The §11 guide toggle shipped INERT there — found by audit this window, **fixed in #263** with ON/OFF-difference tests |
| 3 — live status, find with disambiguation | ✅ **DEPLOYED** — #261 |
| 4 — intake preparation + preview + SIMULATE + `assistant_log` | ✅ **DEPLOYED + SCHEMA APPLIED** — #262 `85806e6`; site, Worker AND `portal-setup` all `success` on `85806e68`, so the log table is live. Every simulation records `SIMULATED — NOT SENT`; the real send history, lead ladder and transport are untouched (source-pinned: exactly one INSERT in the block) |
| 5 — rate-sheet preparation + preview + SIMULATE | ✅ **DEPLOYED** — #263 `099b817`, site + Worker both `success` on `099b8174` at 09:37Z. Pinned mirror of the real sender: same inputs → same subject and body byte for byte, same refusals by code |
| 6 — invoice/billing | **READ HALF DEPLOYED** in #263 (live outstanding/balance, drafts excluded per the locked rule). **Preparation/simulation half DEFERRED — owner decision needed (`ASSISTANT.md` A12):** the portal has no invoice-send route to rehearse, and creating drafts is a real write the Beta one-INSERT pin forbids. Options put to the owner: widen the pin explicitly for `createInvoice`, wait for Live Mode, or a record-free preview |
| 7–9 — case health / watch mode / visual QA advisor | NOT STARTED — next tier when sanctioned |

**Beta safety state, verified by source pins in the suite:** ASSISTANT BETA =
ON · LIVE CLIENT SEND = OFF · LIVE AI EMAIL = OFF · LIVE AI PAYMENT = OFF ·
AI DELETE = OFF · AI ARCHIVE = OFF · AI CLOSE CASE = OFF. No credential
exists anywhere; `assistantProvider` answers `not_configured`.

**Exact next recommended step:** answer `ASSISTANT.md` A12 (what invoice
"preparation" may do), then Unit 7 per the spec. Owner live-verify checklist
when convenient: the ✨ Assistant sidebar door, "prepare an intake" →
Preview → Simulate (recorded, nothing sent), "prepare a rate sheet",
"What is outstanding?", and the Explain & Guide Me toggle.

# 👋 START HERE — session handoff, 2026-09-02

## 🤖 API ASSISTANT: RESUMED — Units 1–3 SHIPPED (#261), Unit 4 in flight

**Status 2026-09-02, overnight window:** the Phase 2 gate was satisfied (every
pre-Assistant unit deployed, all suites green) and Phase 3 resumed per the
owner's overnight order. **Units 1–3 are DEPLOYED** — PR #261 `b379990`,
`ASSISTANT.md` is the architecture record. Unit 4 (intake preparation +
preview + SIMULATE + `assistant_log`, the first Assistant schema change) is
the current work. The paragraph below is the historical checkpoint record
from before the resume, kept as written.

**State at the pause: NOT STARTED — and that was the whole checkpoint.** The owner's master
specification for the API Assistant (internal operations copilot, Beta/dry-run
only) arrived 2026-09-02, and the pause instruction arrived before any
Assistant code was written. Verified by inspection: no Assistant branch, no
Assistant commits, no Assistant files, no uncommitted Assistant work — the
only "assistant" strings in the codebase are the *Legal Assistant* profile
role and the paralegal/legal-assistant field labels, which predate the spec.
Nothing was preserved because nothing existed; nothing was lost.

**RESUME AFTER PRIOR PORTAL UNITS ARE GREEN** (the owner's Phase 2 gate).
When resuming: the full master spec is in the owner's messages of 2026-09-02
(sections 1–38 plus the resume message's Unit 1–9 plan). Version 1 is BETA /
DRY RUN ONLY — no client email, no consequential actions, server-side
enforcement, provider-agnostic adapter with NO credentials until the owner
approves a provider. Final required state: ASSISTANT BETA = ON, LIVE CLIENT
ACTIONS = OFF, DESTRUCTIVE AI ACTIONS = OFF, LIVE AI PAYMENT ACTIONS = OFF.

**Current window (2026-09-01 → 02), newest first — each shipped through the
full chain (CODED → TESTED → PUSHED → MERGED → DEPLOYED), suites green at
every merge:**

| Unit | PR / SHA | State |
| --- | --- | --- |
| **MOBILE WEB APP — Units A–F** (owner brief 2026-09-04, five approved mockups as the visual target). A phone bottom nav from `shell()` — which the case page and the field view do not use, so it cannot collide with their bars structurally. Then Home: **`QT` is ONE TABLE OF DOORS and `QT_DESK`/`QT_PHONE` are two orderings named beside it**, so the phone gets the owner's order (Rate Sheet first and the only card with the accent, then New/Private/Insurance/Law Firm Intake, then Reports & Packages) while the desktop row stays byte-identical — `dlabel` exists only so the desktop keeps saying *Intake a Client*, the drift the first build shipped silently. Both strips render and one is `display:none`, so exactly one is in the accessibility tree. Then an audit at 390px rather than a redesign: the rate sheet's fee lines were leaving the label **90px of a 312px panel** and now stack; **`Back to Cases` was drawn underneath the hamburger** at 390 and 768 (`.close` is the dialog X's rule and the class came with its position) — measured with `elementFromPoint`, desktop was never broken and is untouched, fixed at the 899px the burger already uses; and eleven controls computed under the 44px floor across a sweep of **all sixteen top-level screens**. The field view needed nothing. **`.pkg-b` was measured at 56px and its rule taken back out.** Page-only, no schema change | #284 `5adc64f` | ✅ **DEPLOYED** — `deploy.yml` run #358 `success` on `5adc64fe`. Page-only, so no Worker deploy applies and **no schema change, so no `portal-setup` was owed**. Suites at merge: worker **3333/0** · e2e **3080/0** · intake **566/0** · deploy guard **92/0** · visitor **49/0**. The e2e took four rounds and every failure was traced rather than waived (10+crash → 4 → 1 → 0); one was a REAL defect the suite found — the Overview thumbnail button collapses to a 16px control when its image fails to load — and the rest were assertions written for the single-strip world, each repointed at the property it actually protects. LIVE VERIFY **OPEN** for the owner: the Home quick-actions strip with Rate Sheet first, *Back to Cases* no longer under the hamburger, and the Assistant's Prepare a Rate Sheet form |
| **CASE COMMAND CENTER V1 — Units B + C** (search over invoices and tasks; the phrasing layer and the case-context chip). `globalSearch` gained two bounded arms: INVOICES, admin-only by NOT RUNNING the arm, landing on the case's Billing tab; and TASKS for both roles scoped like the case arms, with the OWNER'S NAME an admin-only key because a colleague's name is one of the things Unit 8 already refuses an investigator. Neither is seekable and both say so. Then the words people actually type: a leading presentational verb (`show`/`list`/`view`/`see`) is stripped so "show new intakes" reaches the desk that was always there, while CONTENT words are left alone — "unpaid cases" and "cases" stay different questions. 18 of the owner's 19 listed phrases now resolve; "cases ready to build" needs the package read and arrives with Unit I. The panel names the case it is talking about in one line and it MOVES with the case | #281 | see below |
| **The Assistant answers as a case operations console** (owner visual reference 2026-09-04; `ASSISTANT.md` A20). One builder per shape — case card, facts, Case Ready checklist, draft, records — so every later unit renders into the same console. READ and WRITE look different STRUCTURALLY: a white `.asst-op` card whose controls only navigate, versus a gold-edged `.asst-cmd` panel that is the only place a primary button commits. Density measured at 390px in the real panel, not eyeballed. The mockup's light theme and bottom nav bar were deliberately NOT taken. Page-only | #280 `457c58a` | ✅ **DEPLOYED** — `deploy.yml` `success` on `457c58ab` (page-only; no Worker deploy applies). Suites at merge: worker 3290/0 · e2e 2983/0 · intake 566/0 · deploy guard 92/0 · visitor 49/0 |
| **CASE COMMAND CENTER V1 — Unit A (registry, resolver, confirm protocol) + Unit F (Start/End Day)** (owner brief 2026-09-04; `ASSISTANT.md` A19). `ASSISTANT_COMMANDS` is the entire executable surface — action, level, roles, and the ORDINARY route each uses; `assistantPlan` is the one resolver (registry, role, `caseFor`, `caseSendRefusal`) and it EXECUTES NOTHING. The page holds the offer in `ASST.pending` and dispatches through `ASST_CMD`, a page-side allow-list, to the route the button already uses — so no command has a private endpoint. The Beta pin was RESTATED rather than kept: "read-only" would now be a lie, and what is pinned instead is no SQL beyond `assistant_log`, `sendMail` never, and every runnable verb a registry row. External sends unchanged and still dry-run. No schema change | #279 `cdb3306` | ✅ **DEPLOYED** — site AND Worker both `success` on `cdb33066`. Suites at merge: worker 3290/0 · e2e 2983/0 · intake 566/0 · deploy guard 92/0 · visitor 49/0. No schema change |
| **FINAL CLOSEOUT + REVOLUTION AUDIT** (owner brief 2026-09-04). Five-agent read of the whole product against the owner's defect list. **Route wiring came back CLEAN** — every path the page fetches is handled, every admin route gated in the Worker, `redactRow` covers every sensitive column the case list selects. **21 confirmed LOW-risk defects fixed**, headed by two the record depended on: the sitemap had drifted from its generator so the next `PLACES` edit would have dropped the Legal page and **frozen the site deploy** on the guard's own assertion; and a field photo was filed against the case's FIRST activity entry (oldest-first since Unit 38) while the screen said "with the last entry". Five stale CLAUDE.md claims corrected. Six items left as PROPOSALS in the new `case-portal/FUTURE.md`, which also ranks the five highest-impact future units and records that the auto Daily Summary draft and the "Case Ready?" checklist are **substantially already built** | #277 `44f47e7` | ✅ **DEPLOYED** — site AND Worker both `success` on `44f47e7e`. Suites at merge: worker 3261/0 · e2e 2969/0 · intake 566/0 · deploy guard 92/0 · visitor 49/0. **No schema change, so no `portal-setup` was owed.** LIVE VERIFY **OPEN** for the owner |
| **`case_days` open-day uniqueness** (owner, 2026-09-03 — the last of the three closeout deferrals, released after the owner read production: `open_days_total` 0, no duplicate `(case_no, investigator_id)` pairs). `idx_days_open_one`, partial unique on the running days only; `startDay` answers a real collision with the same 409 it gives a second tap, naming the day that won. **Schema change → `portal-setup.yml` dispatched after merge.** Two people on one case, one person on two cases, and start-after-end are all pinned unchanged | #275 `3896be0` | ✅ **DEPLOYED + SCHEMA APPLIED** — site, Worker AND `portal-setup` all `success` on `3896be0e`, so `idx_days_open_one` is live on production. Suites at merge: worker 3248/0 · e2e 2949/0 · intake 566/0 · deploy guard 86/0 · visitor 49/0. LIVE VERIFY **OPEN** for the owner |
| **SAVE-ALL CHECKPOINT + DEBUG/HARDEN closeout** (owner brief 2026-09-03). Checkpoint `9678e3b` — tree clean, tagged `save/2026-09-02-2351-9678e3b`, `harden-check.yml` (live security check) `success` on `8355dec`. Then a five-agent read of the whole application: Worker auth/authz/IDOR/CSRF, Worker data integrity/SQL/deletes/uploads, page XSS/crashes/races, page perf/mobile/PWA/a11y/cache, public intake + alerts Worker + deploy surface. **Boundaries held** — role scoping is in the SQL, redaction is an allow-list, the deleted/archived chokepoint has no constructible bypass, CSRF is closed twice (Origin check + SameSite=Strict), no SQL injection in 644 prepared statements, no unescaped interpolation in 2,246 page templates, no secret returned anywhere. **Fixed: 11 Worker + 8 page defects** — see the CLAUDE.md "closeout hardening rules" section for each and why | #274 `178d273` | ✅ **DEPLOYED** — site AND Worker both `success` on `178d2733`. Suites at merge: worker 3229/0 · e2e 2949/0 · intake 566/0 · deploy guard 86/0 · visitor 49/0. No schema change |
| **One tap to the full portal + instant shell; gold drawer handle; slim empty queue; phone header** (owner live-iPhone briefs 2026-09-02) — `render()` paints the shell first and runs its eight fetches concurrently (measured tap→shell 2072→9ms @250ms/call, 4473→12ms @550ms/call; fresh data by ~1–2 RTT) — also the two-tap cause; cases list gains a Loading state; launcher early-leave guarded. Gold handle (luminance separation ≥25 asserted). Empty queue card slim + owner's one-liner on phones; identity moves to the drawer foot. Page-only | #272 `8355dec` | ✅ **DEPLOYED** — `deploy.yml` `success` on `8355deca` at 23:33Z. Suites at merge: worker 3218/0 · e2e 2935/0 · intake 558/0 · deploy guard 86/0 · visitor 47/0. LIVE VERIFIED pending the owner's iPhone check |
| **Nav/dashboard refinement** (owner brief 2026-09-02) — drawer `‹` retract handle (sibling of `.tabs`, keyframe slide both ways, reduced-motion instant); Quick Tools = one-row swipe strip on phones (was a one-column 336px stack) and one tightened desktop row at ≥1280; Search card 245→114px phone / 194→142px desktop; "Today / next actions" begins ~286px instead of 682px at 390px. Order, acts, search behavior unchanged. Page-only | #271 `7e2b4a1` | ✅ **DEPLOYED** — `deploy.yml` `success` on `7e2b4a14` at 20:56Z. Suites at merge: worker 3218/0 · e2e 2920/0 · intake 558/0 · deploy guard 86/0 · visitor 47/0 |
| **Assistant Back / Assistant Home** (`ASSISTANT.md` A18, unit 11) — the home menu is a VIEW; the level derives from existing state (home / chat / workbench form / preview); Back walks one level on the panel's own transitions, Assistant Home jumps; no Back on home; X untouched; conversation kept with a Return row; nothing outside the panel moves. Page-only | #270 `1f41310` | ✅ **DEPLOYED** — `deploy.yml` `success` on `1f413100` at 19:43Z (page-only; no Worker deploy applies). Suites at merge: worker 3218/0 · e2e 2892/0 · intake 558/0 · deploy guard 86/0 · visitor 47/0 |
| **Surveillance launcher hides removed cases; display safety; local prune** (owner live issue) — `/my/active` assignments arm gained the tombstone/archive exclusion in the SQL before the LIMIT (guarded; resume arm deliberately unfiltered — a running day blocks every hide route); subject-less cards say "No subject recorded" instead of wearing the number as a name; a successful complete case-list load prunes dead sessionStorage ids. No cache was involved: no service worker, launcher fetches live each open, index.html no-cache | #269 `590e6c5` | ✅ **DEPLOYED** — site AND Worker both `success` on `590e6c5e` at 19:15Z. Suites at merge: worker 3218/0 · e2e 2874/0 · intake 558/0 · deploy guard 86/0 · visitor 47/0. No schema change |
| **Assistant composer clears the phone's bottom edge** — `.asst-ask` phone padding `max(26px, env(safe-area-inset-bottom)+6px)` (real floor because `env()` is 0 in browser Safari; the env arm serves the installed shortcut), dvh sheet, Ask button level and unwrappable. Measured 26px pad / 36px clearance at 390 and 820, 12px/22px desktop. No Worker change | #268 `3a6d9ea` | ✅ **DEPLOYED** — `deploy.yml` `success` on `3a6d9eac` at 18:22Z (site-only change; no Worker deploy applies). Suites at merge: worker 3194/0 · e2e 2864/0 · intake 558/0 · deploy guard 86/0 · visitor 47/0 |
| **API Assistant Unit 10 — topic commands** (`ASSISTANT.md` A17) — bare-word live-status desks with situational actions (navigate/say/seed only), dormant cleanup intelligence on the delete's own probe. No schema change | #266 `9dd7f64` | ✅ **DEPLOYED** — both workflows `success` on `9dd7f643` at 14:51Z. Suites at merge: worker 3194/0 · e2e 2856/0 · intake 558/0 · deploy guard 86/0 · visitor 47/0 |
| **API Assistant Units 6 (completed) + 7 + 8 + 9** — zero-write invoice preview (A13); case health with verbatim chronology (A14); internal Watch (A15); UX Advisor with 51 stored findings (A16). No schema change | #265 `3f1f640` | ✅ **DEPLOYED** — both workflows `success` on `3f1f640f` at 14:02Z. Suites at merge: worker 3152/0 · e2e 2852/0 · intake 558/0 · deploy guard 86/0 · visitor 47/0 |
| **API Assistant Unit 5 + Unit 6 read half + §11 guide fix** — rate-sheet preparation + preview + SIMULATE (`ASSISTANT.md` A11; pinned mirror of `emailSheet`, byte-equality + refusal-mirror tests); live billing answers (A12; drafts excluded from outstanding; Unit 6's preparation half DEFERRED — owner question in A12); and the inert Explain & Guide Me toggle made real (found gap, `guide_intro`). No schema change | #263 `099b817` | ✅ **DEPLOYED** — both workflows `success` on `099b8174` at 09:37Z. Suites at merge: worker 3117/0 · e2e 2849/0 · deploy guard 86/0 · intake 558/0 · visitor 47/0 |
| **API Assistant Unit 4** — intake preparation + preview + SIMULATE + `assistant_log` (`ASSISTANT.md` A6–A10) | #262 `85806e6` | ✅ **DEPLOYED + SCHEMA APPLIED** — site, Worker AND `portal-setup` all `success` on `85806e68` at 08:39Z, so `assistant_log` is live. Suites at merge: worker 3080/0 · e2e 2837/0 · intake 558/0 · deploy guard 86/0 · visitor 47/0 |
| **API Assistant Units 1–3** — shell + Beta enforcement, navigation, live status (`ASSISTANT.md`) | #261 `b379990` | ✅ **DEPLOYED** — site + Worker both `success` on `b3799902` at 06:24Z. Suites at merge: worker 3045/0 · e2e 2826/0 · intake 558/0 · deploy guard 86/0 · visitor 47/0. No schema change, no portal-setup owed |
| **Service-aware Legal + Process Service standard/custom flat fee** (`LEGAL-SERVICES.md` D1–D14) | #260 `6770609` | ✅ **DEPLOYED** — site + Worker both `success` on `67706099` at 05:28Z. Suites at merge: worker 3009/0 · e2e 2813/0 · intake 558/0 · deploy guard 86/0 · visitor 47/0 |
| **Bill.com prepared, gated, connected to nothing** (`BILLCOM.md`) | #259 `a2ce137` | ✅ DEPLOYED — both workflows green at `a2ce137a`. **Stays dark until the owner says the account is ready** |
| **Three jobs**: live intake-delete 500 fix (API-20260901-3207, the `?1` UNION-bind class), Mail Check tickable send option, queue reconciliation | #258 `14ba2d2` | ✅ DEPLOYED |
| **Mail Check** for Legal + Insurance (`MAIL-CHECK.md`) | #257 `ede24f6` | ✅ DEPLOYED. Remittance address still **owner-owed** at Settings → Invoice defaults |
| **Dashboard delete controls** (`DASH-DELETE.md`, `feed_hidden`) | #256 `86fd715` | ✅ DEPLOYED + portal-setup run 33570951001 applied the table |
| **MTS decoder lifecycle fix** (owner's real 0000.MTS) | #255 `eaf66d6` | ✅ DEPLOYED — owner's device test passed |
| **MTS/M2TS Video Timestamp** | #254 `d8a6924` | ✅ DEPLOYED |

**Owner-owed inputs (nothing buildable is blocked on the builder):** the
remittance mailing address (Settings → Invoice defaults); the Bill.com A-list
when the account exists (enable word, https payment link, org id,
environment); the Intake Archive / Sample Cleanup **Part 2 brief** (never
arrived — do not infer it); an SMS provider choice if SMS alerting is wanted;
the PORTAL-OPS Permissions spec re-send (arrived corrupted — do not invent).

# 👋 Previous handoff — 2026-08-21

**A fresh session begins at this block.** Everything below it is the durable
queue; everything here is where the work actually stands. **Verify repository
and deployment state before trusting any line of it** — never guess what
completed.

| | |
| --- | --- |
| **Master** | **`371d335`** (closeout record, #252) |
| **Working tree** | clean; nothing unpushed; no branch in flight |
| **Background work** | none running |
| **Suites at that SHA** | worker **2870/0** · portal **2707/0** · deploy guard **86/0** · intake **548/0** · visitor-alerts **47/0**. All five run this session. The deploy guard was re-run at `371d335` itself; intake was run at `5819540` and `index.html`/`intake/**` are unchanged since; worker, portal and visitor were run during Unit 40 and `portal/**`, `case-portal/worker.js`, `case-portal/schema.sql` and `visitor-alerts/**` are byte-identical between `001d354` and `371d335` — each checked with `git diff`, not assumed |
| **Schema owed** | **NONE.** `case_day_end` was applied by `portal-setup` run **32508101361** at `74629fe` — ✅ success, **including the admin-bootstrap step that failed at `46a06ad9`**, so the token race did not recur |
| **Deployed** | **Site:** `Deploy site to Cloudflare Pages` ✅ **run 32606081807** at `371d335` — the closeout SHA itself. **Worker:** `Deploy case-portal Worker` ✅ **run 32583656010** at `79da2b8`, and **that build is current**: `git diff 79da2b8..371d335 -- case-portal/worker.js case-portal/schema.sql` is EMPTY, so no later commit needed a Worker deploy. Schema confirmed present on production by `harden-check` run **32584685117**. A LIVE byte-check is not possible from this container — the network policy refuses the domain with a 403 on CONNECT, re-confirmed at closeout — which is why `verify.sh` runs from a GitHub runner |
| **Closeout** | ✅ **ALWAYS PRECISE FUNCTIONAL BUILD COMPLETE** — see `case-portal/FINAL-LEDGER.md` |
| **Owner decisions** | ✅ five LOCKED at closeout, 2026-08-21 — see **FINAL OWNER DECISIONS** below. Four are deferrals or standing refusals; **decision 4 (Ended by Admin) is BUILT — Unit 27** |
| **Next unit** | **NONE — the durable queue is empty of required work.** Units 17A–39, 21A, **40 and 40A–40F** are shipped; 38, 39, **40 and the whole 40A–40F homepage card series** are LIVE VERIFIED by the owner (2026-08-22), **21A has LIVE VERIFY open**. **The homepage and its three card images are FINAL — do not change them.** What remains is Unit 23's live-verification sweep (deferred — needs a real case) and the deferred-by-owner list. **Do not start anything without the owner.** |
| **Nothing open for the owner** | The one question Unit 40 raised was answered the same day and is LOCKED below: the global teal stays unchanged and the card-button treatment is approved as implemented. Units **40A–40F** shipped the same day on owner direction — icons off, three photographs, a neutral overlay, the insurance setting, the mirrored van, the centred button and the cache fix. ✅ **LIVE VERIFIED by the owner, 2026-08-22** |

## 🔄 RESUME POINT — Production Truth Correction Queue (Units 28–33)

**Written per the owner's guardrail so an interrupted session can resume
exactly.** Update it as the queue moves.

| | |
| --- | --- |
| **Current unit** | ✅ **NONE — 28 through 33 are complete.** |
| **Branch** | `claude/new-session-p6fktf` |
| **Master** | `730141e` (Units 30–31) |
| **Unit 28 — Legal pre-case access** | ✅ **SHIPPED** #221 at `9beb0e8`, both deploys green. LIVE VERIFY open |
| **Unit 29 — Billing settings UI** | ✅ **SHIPPED** #222 at `3df2037` |
| **Unit 30 — Case types UI** | ✅ **SHIPPED** #223 at `730141e` |
| **Unit 31 — Route cleanup** | ✅ **SHIPPED** #223. DOCUMENTATION ONLY: `/pricing`, `/external-storage`, `/profiles/match` classified **INTERNAL / NO UI EXPECTED** and kept — the audit found all three are tested authorization boundaries, so **nothing was removed**. Boundary tests added |
| **Unit 32 — Reachability re-audit** | ✅ **DONE.** No new BLOCKER/HIGH gap |
| **Unit 33 — Final reconciliation** | ✅ **DONE** — every discrepancy reconciled in `FINAL-LEDGER.md` PART 6B |
| **Exact next action** | none — the queue is complete. Owner visual verification of the Legal card, Invoice defaults and Case types remains open |

**Unit 32's interim result:** every rate-sheet and intake door is reachable
including Legal; all six Settings panels are reachable; and the only routes
without a page caller are the three now documented as internal on purpose.

**Owner decision recorded and NOT implemented:** a public Legal / Law Firm
website page and CTA. Not built in this run, by instruction.


## 📋 UNIT 36 — optional-field labelling (owner rule, 2026-08-21)

*"Every field that is genuinely optional must visibly say (optional) in its
field label. Audit requiredness from the actual server-side validation/schema
first. Do not guess from the current UI."*

**The audit came first and it changed the design.** `handleIngest` validates
exactly one thing — `case_no`, which the page mints — because the portal write
is fire-and-forget so a Worker outage cannot cost the firm a client. So on the
public form `validate()` IS the firm's requiredness rule, and the labels are
checked against it BEHAVIOURALLY: fill only the non-optional fields, submit,
assert it goes through. On the Admin side `createManualIntake`, `editCase`,
`setLegalDetail`, `createProfile` and `addProfileContact` are the authorities
and the suite POSTs against them.

**Three markers, because requiredness has three shapes** — required, optional,
and *one of these two* (six pairs across the two surfaces). A select with no
empty option is none of the three and carries no marker.

Three defects the audit surfaced, all fixed:

1. **The objective** — the one field an empty form is refused over — carried no
   marker on any path.
2. **`<span class="opt">optional</span>` on the public form** inherited the
   service-picker CARD styling: a 602×53 bordered box with `cursor:pointer` in
   the middle of a field label, measured on the Legal step. Renamed `.optn`.
3. **The Admin private lead's Service picker had no empty option**, so a lead
   filed as *Surveillance* without anyone being asked — under a label that
   already said optional. It opens on *Not decided yet* now.

**Shipped:** #228 at **`b34ccda`**, `Deploy site to Cloudflare Pages` run
32540154210 ✅. Suites: intake **445/0** (was 236) · portal **2558/0** (was
2455) · worker **2755/0** · deploy guard **81/0** · visitor **47/0**.
No schema, **no portal-setup dispatch**. Visual LIVE VERIFY open for the owner.

**Reported to the owner rather than decided:** the Service-picker change alters
what a private quick-intake lead stores when nobody touches the dropdown (a
service, previously; nothing, now). One line reverts it.


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
Shipped as **Unit 34**, #225 at `405462f`, deploy green. **Live path:
`/legal-investigations/`.** Visual LIVE VERIFY open for the owner.

**Post-deploy sweep of the 40 published files** found four matches, all in
`portal/index.html` — the signed-in staff app, `noindex` by meta AND by
`X-Robots-Tag`, absent from robots.txt and the sitemap. They are internal
case-type vocabulary (`/canvass|field/` in a label helper, and "Witness locate
/ interview" twice in the ADMIN manual-intake category list), not public
service copy. **Left alone deliberately** — those strings categorise existing
cases, and the owner's instruction was explicit that internal case data is not
to be edited to tidy a website. **One judgement call for the owner:** the
PUBLIC intake's matching option is now "Witness locate", so the admin form
offers a category the public site no longer advertises. Changing it would
touch how existing cases are categorised, so it is recorded rather than done.

## Shipped and deployed (do not rebuild)

| Unit | PR | Master | Live verified |
| --- | --- | --- | --- |
| **17A** Legal intake link routing | #206 | `61a00f0` | open |
| **18** Invoice Payment Integrity | #207 | `c184a50` | open |
| **19** Package + Report Accuracy | #208 | `1a047a8` | open |
| **20** Intake Alert Completeness | #209 | `46a06ad` | open |
| **21** Accessibility + Voice §9 | #210 | `27243af` | open |
| **22** PORTAL-OPS gaps | #211 | `a7bfe6e` | open |
| **Ready-is-unsent retainer rule** | #212 | `59d00c8` | open |
| **24** File Queue (REQUIRED unit) | #213 | `8988b29` | ✅ **owner visual check PASSED** |
| **24** page-level rendering tests | #214 | `5835cdf` | tests only |
| **25** Security / authorization / regression pass | #215 | `73b7f5b` | open — see below |

## ✅ SHIPPED (pending merge SHA) — MTS/M2TS support for Video Timestamp (owner, 2026-08-24)

**State: coded, tested, rebased onto master `4a1c964`, merging via this
branch's PR. Suites on the rebased tree: portal e2e green (pre-rebase run
2458/0; rebased run is the merge gate), worker 2870/0, deploy guard 86/0.
LIVE VERIFY waits on exactly one thing: the owner's real `00000.MTS` on their
own hardware.** No further MTS changes unless that test fails (owner,
2026-08-24). The parser was cross-validated in-container against real
ffmpeg-written streams (188/192-byte, 1080i interlaced, AC-3) — field-for-field
agreement with ffprobe; ffprobe commands for the owner's PC are in the session
log, and a pasted `mts-report.txt` or a 16 MB head slice of the file is the
diagnosis channel if the device test fails.

Owner brief verbatim: *"Add local MTS/M2TS support to Video Timestamp. Do not
rely on browser playback to decide compatibility. Decode/process locally, burn
the timestamp, output MP4, keep original untouched, and never upload the
source."* Interleaved between Unit 24 and Unit 25 at the owner's request.

Page-only change (no Worker, no schema, no portal-setup dispatch): the
container is sniffed off the 0x47 packet grid, PAT/PMT/PES demuxed in bounded
`file.slice` chunks, the H.264 SPS parsed for dimensions/profile/interlace,
and `vstTranscodeTs` feeds the existing WebCodecs→mp4-muxer pipeline in
Annex-B form (no invented `description`). For a TS the media element is never
consulted and the legacy route does not exist. Design record and the
device-evidence boundary: `VIDEO-TIMESTAMP.md` §MTS. **The decode→burn→encode
of a real .MTS on real hardware is the owner's device check.** (The earlier
"no WebCodecs in this container" claim was an insecure-context artifact —
corrected same day; the suite records presence instead of asserting absence.)

## ✅ SHIPPED — Dashboard delete controls (owner brief 2026-08-24, DASH-DELETE.md)

Red outlined trash on fresh intake cards and Recent Activity rows. Intake side
is the portal's one HARD delete, admissible only while the intake owns nothing
but its own paperwork (`INTAKE_OWNED`); anything dependent → 409 naming it,
toward the recoverable workflow; hold/deleted/archived refuse through existing
gates. Feed side is a `feed_hidden` marker — the feed is derived from
non-deletable records, so removal can only mean "stop drawing it", stated in
the dialog. Classification completeness is a derived test over `DEMO_SWEEP`.
**One manual `portal-setup.yml` dispatch owed after merge (feed_hidden).**
Also fixed in passing: the invoice suite's hardcoded August `paid_date`s
became `MDAY(n)` — they failed on the 1st of September with no code changed.

## ✅ SHIPPED — Mail Check for Legal and Insurance (owner brief 2026-09-01, MAIL-CHECK.md)

The owner's wording on the insurance sheet and the legal card (one writer,
no address can reach a sheet); `remit_address` as empty-by-default billing
configuration; invoices print "Remit checks to" only for legal/insurance
context and only once the owner types the address into Settings → Billing;
private sheet, private invoices and the Cash App/Venmo boundary untouched.
`mail_check` is a real retainer method (legal recorder only); on invoices
Mail Check is a label storing the CHECK-constrained `check` instrument.
**Owed by the owner: the actual remittance address, typed into Settings →
Billing — until then invoices deliberately print no remittance section.**

## ✅ SHIPPED — Live intake-delete fix + Mail Check as a send option (owner jobs, 2026-09-02)

**Job 1:** the first real quick-delete (API-20260901-3207) 500'd — the blocker
probe reused `?1` across UNION arms, node:sqlite green, live D1 red (the Unit 7
parameter class; builder now one-`?`-per-arm, shape pinned by test). Owner
rules folded in: sends/payment-instructions no longer block (they SURVIVE —
non-deletable history), comms + lead status are intake paperwork (deleted with
it), Closed Lead / Awaiting Mailed Check delete like any fresh duplicate;
protected records still refuse, naming Archive and Delete case as the roads.
**Job 2 (MAIL-CHECK.md D5):** legal + insurance send wizards carry the one
tickable payment option [ ] Mail Check (unticked default); ticked, the email
gains its own PAYMENT block (never the private retainer-sentence block);
Worker takes methods ['mail_check'] on non-private and nothing else —
cash_app/venmo beside it refuse, private+mail_check refuses by name;
payment_send records mail_check. No schema change either job.

## ✅ SHIPPED — Bill.com prepared, not connected (owner brief 2026-09-02, BILLCOM.md)

The adapter (`billcomConfig`) gates everything on an enable word + valid
https payment link, both empty until the owner types them into Settings →
Invoice defaults. Ready: sheet line, wizard checkbox, send method, invoice
link — everywhere at once. Not ready: refused by name, drawn as "Not
configured", mentioned nowhere. No credential anywhere; no schema; private
untouched; Cash App/Venmo boundaries unmoved. **Enabling later is typing two
Settings values — no code, no deploy. Do not enable until the owner says
the account is ready.**

## What is left

- **23 — Consolidated Live Verification Sweep.** ⏸️ **LIVE VERIFICATION
  DEFERRED — REQUIRES REAL CASE/DATA** (owner, 2026-08-21). The owner does not
  have suitable real case data now, and **no production data is to be
  manufactured for it.** Carried forward, never converted to complete.
  **Unit 25 added two items to it, both machine-verified and neither
  live-checked:** an investigator opening a case they were reassigned should
  see their own days and expenses and none of the previous investigator's, and
  the field view's "Day N" should still be the CASE's day number.
- **25 — Final security / authorization / regression pass.** ✅ **DONE.** The
  route table was walked mechanically and three defects were verified and
  fixed: a prior investigator's worked hours and expense claims reaching the
  current one through `caseWorkspace` and `caseTimeline` (the owner's locked
  decision of 2026-08-21, which CLAUDE.md said would be enforced when this work
  was reached), and evidence being served back inline as whatever content type
  the uploader declared. `case-portal/SECURITY-PASS.md` is the record — what
  was walked, what was found sound and on what evidence, and eight derived
  decisions. No schema, no migration, no `portal-setup` dispatch.
- **37 — Final Production Truth Audit, Round 2.** ✅ **DONE — and it did NOT
  pass.** One HIGH finding, two lesser ones, full result and the exact
  correction queue in `case-portal/PRODUCTION-TRUTH-2.md`. Nothing in the
  repository was changed to run it.
- **37A — HOTFIX: all three Round 2 findings.** ✅ **DONE.** Was 🔴 REQUIRED and
  came before Unit 38 — the owner's queue rule allows a verified HIGH to
  jump the order. `GET /search`'s subject arm reads the `case_subjects`
  companion table; the public intake writes `submissions.subject_name` and
  creates no companion row. So a case that arrived the ordinary way is not
  findable by the subject's or claimant's name, and the miss draws as "no such
  case". Reproduced end to end. Every suite is green over it because the search
  test adds a structured subject row before searching — no test crossed the
  boundary between what the intake writes and what the search reads. **Fixed**
  with an intake fallback the structured table still outranks, plus the legal
  door's own accessible page name and the legal page's cache-rule parity. The
  regression tests are written from that boundary and control-checked: with the
  fallback disabled the suite reports ten failures.
- **39 — Case content Delete / Restore controls.** ✅ **DONE — LIVE VERIFIED**
  by the owner on 2026-08-22. Deployed at
  `79da2b8` (#234), site run 32583655929 and Worker run 32583656010 both ✅,
  **Schema ✅ CONFIRMED PRESENT ON PRODUCTION** by `harden-check` run
  **32584685117** (22 passed, 0 failed): *"every table this build expects is on
  the database"*. The Worker computing `missing_tables` is the Unit 39 Worker,
  so an empty list with the key present means `case_content_removed` and
  `case_content_event` are both there.
  `portal-setup.yml` run **32583766475** is recorded as **SCHEMA APPLIED /
  BOOTSTRAP-ONLY FAILURE**: step 8 *Apply the schema* succeeded and the run
  fails only on step 13 *Create the first admin* (`401 not authorised`), the
  bootstrap-token race in item 3 below. The bootstrap token was destroyed.
  **Not rerun, and no credential handling touched** — owner decision 3. Visual **LIVE VERIFY OPEN**,
  and the owner's instruction is to stop here for it. Record in
  `FINAL-LEDGER.md` PART 14. Detail below as it was written in flight (started
  2026-08-22 on the owner's go-ahead after Unit 38's visual review passed).
  **The audit found the brief resting on something untrue**, which reshaped the
  unit: `deleteEvidence` was not a tombstone — it called `dropboxDelete`, or
  `EVIDENCE.delete` for legacy R2, and only then wrote `deleted_at`. The row
  survived and the file did not, which is also why no evidence Restore had ever
  been written. So removal destroys nothing now, and the storage meter learned
  to tell a pre-Unit-39 removal (bytes really gone) from a post-Unit-39 one
  (file still there) so the free-plan failsafe cannot under-report. **Deleting
  evidence no longer frees storage** — recorded as an accepted cost.
  Two additive tables (`case_content_removed` state, `case_content_event`
  trail), **so a manual `portal-setup.yml` dispatch is owed after merge.**
  Activity, Remove-from-Package and phone removal were already built and got
  tests rather than code. Detail and derived decisions A1–A7 in
  `CASE-CONTENT-DELETE.md`; findings in `RECONCILIATION.md`.
  The original queue entry follows.
- **39 (as queued) — the original brief text, kept for its detail.** ✅ Shipped and LIVE VERIFIED; this entry is history, not a queue item.
  Owner brief verbatim in `case-portal/CASE-CONTENT-DELETE.md`. **This is a
  PRODUCTION unit and the owner says so in the first line** — Admin must be
  able to remove incorrectly entered or no-longer-needed information from
  **real** cases, not only from `TEST-` ones. Today too much can only be
  edited and then sits in the working case for ever.
  Six areas, at minimum: **activity entries** (delete, restore, gone from the
  Activity view, the Daily Summary source and the report chronology, restored
  to its true chronological position); **investigation days**, with a
  confirmation that names the date, the entry count, the evidence count,
  whether a summary exists and whether the day is already in a report or
  package; **daily summaries**, where Delete Summary is not Delete Day
  Activity; **evidence**, through the existing tombstone model; **package
  contents**, where *Remove from Package* and *Delete from Case* are never the
  same action; and **an audit of other user-entered records** to find what can
  be created but not removed — adding Delete only where it is safe.
  Hard limits from the owner: **no physical Dropbox deletion, no evidence
  overwrite, no silent hard deletion, no billing or history destruction**,
  actor and timestamp preserved, reason preserved where consequential, and a
  finalized report whose source changed must say **SOURCE DATA CHANGED —
  REBUILD REQUIRED** rather than quietly looking current.
- **38 — Case Workspace Simplification.** ✅ **DONE — LIVE VERIFIED** by the
  owner on 2026-08-22. Deployed at `f2f49d4`
  (#232), site run 32557961911 and Worker run 32557961914 both ✅. No schema,
  **no `portal-setup` dispatch owed.** Visual **LIVE VERIFY OPEN** for the
  owner, and the owner's instruction is to stop here for it. All twenty named
  tests pass, plus a phone section at 375/390/430px and a focus section at
  390/820/1200px carrying a control that puts the old behaviour back and shows
  the assertion failing on it. Full record in `FINAL-LEDGER.md` PART 13; the
  five defects rebuilding the screen surfaced, and the one deferred to the
  owner, are in `RECONCILIATION.md`. Owner brief verbatim
  in `case-portal/CASE-WORKSPACE.md`. Three things are durable required work
  inside it and must not be dropped or split out:
  **(a)** the simplified desktop and mobile case workspace,
  **(b)** **Activity oldest-to-newest ordering** across the Activity tab, the
  Active Surveillance timeline, the Daily Summary source, the report chronology
  and any selected-day list — the dashboard's Recent Activity widget stays
  newest-first by the owner's own carve-out, and
  **(c)** **simplified Activity / Daily Summary access**, which on mobile means
  neither may ever sit under **More**.
  The owner's own numbering says "Unit 34"; that number belongs to the shipped
  public-site unit, so this is 38 and the alias is recorded in the brief file.
  **The goal is NOT to remove functionality** — the brief carries a DO NOT
  REMOVE FUNCTIONALITY list and twenty numbered tests.
  **(d)** the owner's mobile/tablet UX addendum of 2026-08-22, added to this
  unit by their own instruction (*"Ship with the current UI/UX unit if safe"*)
  and recorded verbatim at the end of `CASE-WORKSPACE.md`: **navigating to a
  section must not automatically focus a text field or open the on-screen
  keyboard**, across Search, Cases, Intakes, Clients & Firms, File Queue,
  Reports & Packages, Rate Sheets, Billing, Settings and the Case Workspace;
  dialogs may still focus after the user explicitly opens them; plus a
  **contained desktop Search field**, full width on mobile, presentation only.
  The audit found **no `autofocus` attribute anywhere in the page** — the
  keyboard was raised by `paint()` restoring the caret unconditionally on every
  repaint.
- **26 — Final master reconciliation + project closeout.** ✅ **DONE.** Every
  durable owner requirement was compared against master and live state and
  classified in **`case-portal/FINAL-LEDGER.md`**: MASTER-HANDOFF §0–§43, the
  nine findings RECONCILIATION.md carried, the requirements the numbered queue
  did not contain, the three business workflows, and the full unit ledger with
  CODED / TESTED / PUSHED / MERGED / DEPLOYED / LIVE VERIFIED per unit. Nothing
  deferred was converted to complete. **No non-deferred approved requirement is
  missing.**

# 🏁 SESSION CLOSEOUT — 2026-08-22

**Read this first. It is the resume point for a fresh session.**

| | |
| --- | --- |
| **Master** | **`c8b52a8`** |
| **Working tree** | clean, in sync with `origin/master`, no branch in flight, no background work |
| **Site** | ✅ deployed at the closeout SHA — run **32595545919** |
| **Worker** | ✅ run **32583656010** at `79da2b8`, and **current** — `worker.js` and `schema.sql` unchanged since |
| **Schema** | ✅ present on production, confirmed by `harden-check` run **32584685117** |
| **Suites** | worker **2870/0** · portal **2707/0** · deploy guard **86/0** · intake **467/0** · visitor-alerts **47/0** |
| **REQUIRED BUILD QUEUE** | ✅ **EMPTY** |

## The three units this session shipped

| Unit | PR | SHA | State |
| --- | --- | --- | --- |
| **38** Case Workspace Simplification | #232 | `f2f49d4` | ✅ DONE — **LIVE VERIFIED** by the owner |
| **39** Case content Delete / Restore | #234 | `79da2b8` | ✅ DONE — **LIVE VERIFIED** by the owner |
| **21A** Case-page live region | #239 | `d0b98b1` | ✅ DONE — deployed; **LIVE VERIFY OPEN** (owner visual check, not real-case-gated) |

## What a fresh session must NOT do

**Do not rebuild any completed unit.** Locked order 1–17, hotfix 17A, and
Units 18–22, 24–39 and 21A are complete. Everything marked complete in this
file, in `FINAL-LEDGER.md` and in `RECONCILIATION.md` **stays complete**. If a
status line anywhere appears to contradict that, the DURABLE MASTER UNIT QUEUE
and `FINAL-LEDGER.md` are the authority — and note the archaeology banner
further down: roughly nine hundred lines below it are pre-queue handoffs whose
status markers are stale by design and are **not** a queue.

**Real-case-only LIVE VERIFY items are OPEN, not failed.** Unit 23's
consolidated sweep, Unit 17 Retention's live check, and everything in the
IMPLEMENTED BUT NOT LIVE VERIFIED block are waiting on the owner having a
suitable real case. They are machine-verified and deployed. **No production
data is to be manufactured for any of them**, and none of them is a defect.

**Deferred-by-owner items are DEFERRED, not queued.** SMS provider and the
alert status log · Intake Archive / Sample Cleanup Part 2 · invoice Write-Off ·
PORTAL-OPS Permissions (arrived corrupted, must not be invented) · Saved Views ·
Case and Document Templates (the firm's own content) · PORTAL-OPS Case Health
flag · physical destruction · retention clocks · automatic purge · Dropbox byte
deletion · the legacy R2 export decision · two-person legal-hold approval ·
the business-account payment migration. **None of these is work to pick up.**

**Owner decisions stay locked.** The five from the 2026-08-21 closeout and the
three from Unit 39 (preserved evidence keeps counting toward storage; the legal
hold keeps its full reach; credentials and bootstrap handling are not to be
touched over a red `portal-setup`). Do not re-litigate them.

**One open question belongs to the owner, not to the queue:** whether the
private lead card should carry more than *Send intake* and *Send payment
options*. Recorded during the final reconcile as a question rather than
claimed complete against a spec nobody has restated.

---

## ✅ RECONCILE, 2026-08-22 — the required queue is empty

Run on the owner's instruction after Unit 39's visual review passed. Every
open-state marker in this file was scanned, not just the queue table, and each
was checked against the code rather than against memory.

**Units 17A–39 are all shipped**, and so are the two that arrived after this
reconcile ran — **21A** (case-page live region) and **40** (homepage CTA
redesign), both on new owner instructions rather than off the queue. 38 and 39
are LIVE VERIFIED by the owner (2026-08-22); the rest are deployed with owner
visual verification open, which is the owner's to close and not development
work. **The required queue is still empty:** 21A and 40 were owner-initiated
briefs, delivered and closed, not items this file was carrying.

**Three stale states were corrected rather than left to mislead a later
session:**

1. The master-queue rows still read **38 IN FLIGHT** and **39 REQUIRED**.
2. **OWNER WORKFLOW SIMPLIFICATION was headed QUEUED and is entirely
   shipped** — all five parts, absorbed into later units, and never referenced
   in `FINAL-LEDGER.md`, so nothing had ever closed it. Each part was verified
   against the code; §1 is even annotated in `portal/index.html` with the
   requirement it satisfies. **This is the one that mattered:** a block reading
   QUEUED is how a later session rebuilds something that already exists.
3. The Codex send-context findings 2 and 3 were headed **🔴 OPEN** while their
   own summary said the owner *"chose this knowingly after four rounds"*. They
   are decided and accepted, not pending. The optional way back — a typed
   `recipient_kind` — remains unstarted and owner-gated.

**Nothing was found that is required, approved and unbuilt.**

## ✅ SHIPPED — Unit 40, the homepage CTA redesign (owner-approved, 2026-08-22)

**A public-site unit, not a portal one.** The hero carried two links —
insurance and private. Legal has had a public page since Unit 37A and had **no
door on the front page at all**, so a law firm arriving at the homepage had to
find the nav.

Three equal cards now, each an anchor onto its own intake door, asserted by
CLICKING each one and reading the page it lands on rather than by matching an
href:

| Card | Door | Lands on |
| --- | --- | --- |
| Submit an Insurance Assignment | `/intake/?assignment=insurance` | Secure Assignment Intake |
| Submit a Legal Assignment | `/intake/?assignment=legal` | Legal Investigation Assignment |
| Request a Private Investigation | `/intake/?assignment=private` | Client Intake |

**Shipped:** #242 at **`e7b9117`**, site deploy run **32598263366** ✅. No
schema, no `portal-setup` dispatch. The Worker was untouched, so
`deploy-portal.yml` correctly did not fire. Suites: intake **537/0** · deploy
**86/0** · worker **2870/0** · portal **2707/0** · visitor **47/0**.
✅ **LIVE VERIFIED by the owner, 2026-08-22.**

Design detail is in `CLAUDE.md` under *The homepage offers three doors, as
cards*. What is worth carrying here is what measuring found that reading would
not have:

1. **The insurance icon was a blob.** A filled car body with two filled circles
   for wheels; at the 34px it draws at, the body swallowed the wheels. Stroked
   now, like the other two. Found by screenshotting the page.
2. **The 320px overflow was HALVED, not left alone.** Both trees were served and
   rendered side by side: master overflowed 15px and its widest element was the
   old hero *Submit an Insurance Assignment* button — the one these cards
   replaced. The branch overflows 5px, from a *Call for a Free Consultation*
   `tel:` link elsewhere, byte-identical on both trees. The first draft of the
   note had this backwards and said the cards merely tolerated a pre-existing
   defect.
3. **The Get Started label failed WCAG AA.** White on `--teal` is 3.37:1; AA
   wants 4.5:1 for normal text and 3:1 for large, where large starts at 18.66px
   for bold. The label was 15.2px — just under the line that makes 3.37:1
   acceptable. It is 18.88px now, so the rule that applies is the one it
   passes, **without inventing a teal the site does not use**.
4. **A measurement destroyed what it measured.** Sampling the painted backdrop
   behind the titles hides the text with `visibility:hidden`, which also removes
   those elements from the **accessibility tree** — so on the shared page every
   later accessible-name assertion read `""`. It runs on its own page now.

**Raised for the owner, and ANSWERED — see the locked decision below.** The
finding was that `--teal` with white text is 3.37:1 **site-wide**: the nav call
button, the section CTA, the buttons these cards replaced. It was put to the
owner with measured alternatives rather than fixed by making one control differ
from the rest, and they chose to keep the palette. **The sizing is therefore
the approved mechanism, not a stopgap.**

## ✅ SHIPPED — Units 40A and 40B, the cards get photographs (2026-08-22)

Both on owner direction during the Unit 40 visual review, not off the queue.

**40A — no icons.** *"Take the blue scale off, it's not needed."* The legal
photograph has brass scales in it and the teal icon sat on top of them.
Removing one left the other two pushing their titles down, so all three came
off; the dead `.cta-icon` rule went too. **#245 at `9756e59`**, deploy run
32604481612 ✅. intake 539/0.

**40B — three photographs and a neutral overlay. #246 at `7d1f7e4`**, deploy
run 32604959775 ✅. intake **542/0**, deploy **86/0**.

**40C** #248 `154f98f` — insurance gets a commercial yard, so it stops being a
second suburban street. **40D** #249 `fe464f6` — the van mirrored, because it
sat in the left third behind the headline and the owner reported the card as
"not the van image" when it was. **40E** #250 `3bc855f` — Get Started centred
and still low. **40F** #251 `5819540` — `?v=` on the art, because
`/assets/*` is cached for seven days and the files were replaced in place.

✅ **LIVE VERIFIED by the owner, 2026-08-22** — *"They are live i have
verified."*

| Card | File | Size |
| --- | --- | --- |
| Insurance | `card-insurance.webp` | 74 KB |
| Legal | `card-legal.webp` | 52 KB |
| Private | `card-private.webp` | 74 KB |

**Unit 40's central claim was tested and held.** It was built so photographs
could replace the placeholder motifs *without the layout moving*, and that is
exactly what the swap cost: three `url()`s and three manifest lines. Heights
stayed 236/236/236, titles 645/645/645.

**The blue was the OVERLAY, not the images** — owner: the cards should *"not
be so blue hued"*. Neutral black at the same alpha is darker than navy, so
going neutral removed the cast and bought headroom, which paid for lightening
it as well. `.50/.82` measures 5.16 and 5.25 against a 4.5 bar; `.46/.80` was
rejected because it clears by 0.03 and one brighter photograph later it would
not. Table and reasoning in `CLAUDE.md`.

**Three test defects this unit found, all the same shape — an assertion that
had stopped asserting:**

1. The icon check was `[].every()`, TRUE on an empty list, so it passed while
   testing nothing — and would equally have passed on a card that lost its art.
2. The contrast check read the FIRST `.cta-title` only. Fine with one shared
   motif; worthless with three different photographs, since the brightest card
   is the one that decides and was not necessarily the one measured.
3. The art-path check required `\.svg`, which would have failed on a WebP the
   architecture was explicitly designed to accept.

**Two owner images were rejected and re-generated rather than accepted**: the
first private image put its subject in the bottom third, which is both cropped
on a phone and where the overlay is heaviest, so the card drew an empty sky.
A replacement image needs its subject in the **central 60%** of the frame.

## 🔒 OWNER DECISION — 2026-08-22, Unit 40 (LOCKED)

*"Keep the current global teal unchanged. The Unit 40 card-button
accessibility treatment is approved as implemented."*

**One decision, two halves, and the second half is the part a later session
needs.** The measurement stands on the record: white on `--teal` is **3.37:1**,
and that is every button the public site has. The owner was given the measured
alternatives — `#33808f` 4.54:1, `#2f7788` 5.10:1, `--navy` text on the
existing teal 4.67:1 with no new colour at all — and kept the palette.

So **sizing at or above 18.66px bold IS the approved mechanism** for white text
on `--teal`, not a temporary accommodation. `.cta-go` is 18.88px for that
reason and the phone override says so in its own comment.

**Do not darken `--teal` in a later unit.** It was offered and declined. A
control that genuinely needs white-on-teal *below* 18.66px bold is a new
question for the owner, not licence to reopen this one.

## 🔒 OWNER DECISIONS — 2026-08-22, Unit 39 (LOCKED)

Verbatim in `case-portal/CASE-CONTENT-DELETE.md`. Three, and all three are
standing rules rather than one-off answers:

1. **Preserved deleted evidence keeps counting toward storage.** *"If the
   Dropbox/file bytes still exist, storage reporting must remain truthful. Do
   not pretend Delete from Case frees storage."* The marker-aware sum in
   `evidenceUsage` is the rule now, not an accommodation.
2. **The legal hold keeps its full reach.** *"While a Legal Hold is active,
   refuse all case-content removals covered by Unit 39. Restore remains
   allowed. Do not narrow this protection."* Unit 39's widening of Unit 17
   decision 5 is confirmed rather than overturned.
3. **Credentials and bootstrap/admin-token handling are not to be changed**
   merely because `portal-setup` went red after the schema applied. Item 3
   further down still describes that race; it remains a stop condition.

**And the verification it prompted — DONE, and it passed.** The live domain is
unreachable from the build container (the network policy refuses `CONNECT`
with 403), so the schema was verified from a GitHub runner instead.
`case-portal/verify.sh` already fetched `/portal-api/health` and read only
`configured` — it reports `missing_tables` now, from the response it was
already holding, and treats an ABSENT key as *unknown* rather than clean.
`harden-check.yml` dispatches it; run **32584685117** confirmed the two Unit 39
tables are on the production database.

## ✅ CLOSED — Unit 21A, the case-page live region (owner decision, 2026-08-22)

The item below was reported by Unit 38 and left to the owner. **They decided
it: fix it.** Shipped as Unit 21A — `srScreen()` plus `SR_ACTED` in
`portal/index.html`, so the case page announces what the user caused and stays
silent on arrival. Detail in `CLAUDE.md` (*Accessibility was measured, then
fixed* → Unit 21A) and `RECONCILIATION.md`.

**Shipped:** #239 at **`d0b98b1`**, site deploy run 32595336098 ✅. No schema.
The Worker was untouched, so `deploy-portal.yml` correctly did not fire.
Suites: worker 2870/0 · portal **2707/0** · deploy 86/0 · intake 467/0 ·
visitor 47/0. LIVE VERIFY **OPEN**.

**The first version was wrong and the suite caught it** — Tasks, Audit and File
queue each paint twice, so the screen check alone read their explanatory
paragraphs aloud. "The user did something" is the test, not "the same screen".
A second round found that re-pressing the tab you are already on is arrival
too, which `invoices` and `calendar` exposed by reloading on that press.

The original report follows, kept for its reasoning.

## 🔵 WAS QUEUED — reported by Unit 38, now fixed as Unit 21A

**`announceRendered()` never runs on the case page.** Unit 21's chokepoint is
the whole design — *"reading what was rendered catches every one of them and
any added later"* — and `paint()`'s case branch returns before that call, so
every confirmation and refusal inside a case is drawn silently for a
screen-reader user, on the most-opened screen in the portal.

**Pre-existing, not a Unit 38 regression** — the same early return is on
`master` from when the workspace became a full page — so the owner's test 20
("accessibility *remains* sound") is satisfied either way. It is one line and
it was deliberately not taken: `.note` on this codebase is often **static
explanatory prose** rather than a message, so switching it on would read
paragraphs aloud on arrival at a case tab. Whether that is an improvement is a
judgement about how the office actually works, not a mechanical fix. Detail in
`RECONCILIATION.md`.

## Still needing the owner — carry these forward

**Items 1 and 2 were ANSWERED AND LOCKED by the owner on 2026-08-21 at
closeout** — full wording in **FINAL OWNER DECISIONS** below and in
`FINAL-LEDGER.md`. They are kept here so the shape of each stays visible.

1. **PORTAL-OPS Permissions** — arrived corrupted, never re-sent. ✅ **ANSWERED:
   it remains missing and must not be invented; rebuild later from owner
   direction.** Not a closeout blocker.
2. **Saved Views / Case Templates / Document Templates** — Saved Views' own
   heading is `[inferred]`; the two template phases are the firm's own content
   (case-setup defaults, communication and report language). ✅ **ANSWERED:
   Saved Views is a future optional improvement and does not block closeout; the
   template phases may reuse a mechanism later, but the owner supplies the
   content — do not invent templates.**
3. **`portal-setup` bootstrap-token race.** Run 32456667718 shows RED while the
   schema applied correctly — that run's own health probe returned
   `missing_tables: []`. The failure is the final admin-bootstrap step
   (`401 not authorised`, a token propagation race after the redeploy).
   **Untouched deliberately: credential handling is a stop condition.**

## Deferred and preserved — never silently deleted

SMS delivery and provider · the queued/sent/failed/retried alert status log ·
Intake Archive / Sample Cleanup Part 2 · invoice Write-Off · PORTAL-OPS Case
Health flag · physical evidence destruction · automatic retention clocks ·
automatic purge · Dropbox byte deletion · the legacy R2 export decision ·
two-person legal-hold approval.

## Owner decisions now locked (do not re-litigate)

- **Draft AND ready invoices do not reduce the client-facing retainer.**
  Excluded set `('void','draft','ready')`, written once.
- **A reassigned investigator never sees a prior investigator's hours or
  money.** Admin-only, enforced in the Worker, no permission toggle invented.
- Cash App `$TreverB` / Venmo `@Trever-Brown-9` kept for now.
- Homepage section order unchanged.

---

# 🔒 DURABLE MASTER UNIT QUEUE — owner, 2026-08-21

**Recorded so it cannot be lost between sessions.** Items 1–17 above are
history and stay as they are. Everything below is the remaining project, in
order. **Nothing here jumps ahead of anything above it.** The owner's
instruction with this queue was documentation only: *"DO NOT CODE. DO NOT
CREATE A BRANCH. DO NOT DEPLOY. DO NOT START THE NEXT UNIT."*

## Active order

| # | Unit | State |
| --- | --- | --- |
| **17A** | **HOTFIX — Legal intake link routing** | ✅ **DONE — DEPLOYED** at `61a00f0` (#206). LIVE VERIFY **OPEN** |
| 18 | Invoice Payment Integrity | ✅ **DONE — DEPLOYED** at `c184a50` (#207); schema applied. LIVE VERIFY **OPEN** |
| 19 | Package + Report Accuracy | ✅ **DONE — DEPLOYED** at `1a047a8` (#208). LIVE VERIFY **OPEN** |
| 20 | Intake Alert Completeness | ✅ **DONE — DEPLOYED** at `46a06ad` (#209); schema applied. LIVE VERIFY **OPEN** |
| 21 | Accessibility + Voice audible-tone completion | ✅ **DONE — DEPLOYED** at `27243af` (#210). LIVE VERIFY **OPEN** |
| 22 | PORTAL-OPS remaining gaps | ✅ **DONE — DEPLOYED** at `a7bfe6e` (#211). Saved Views / Case Templates / Document Templates **NOT built — owner input**. LIVE VERIFY **OPEN** |
| 23 | Consolidated Live Verification Sweep | ⏸️ **LIVE VERIFICATION DEFERRED — REQUIRES REAL CASE/DATA** (owner, 2026-08-21). *Do not manufacture production data.* |
| 24 | **Required** File Queue + portal aesthetic redesign | ✅ **DONE — DEPLOYED** at `8988b29` (#213), **visual check passed by the owner 2026-08-21**; page-level rendering tests followed |
| 25 | Final security / authorization / regression pass | ✅ **DONE** — audit, three verified fixes, record in `case-portal/SECURITY-PASS.md`. No schema, no portal-setup dispatch |
| 29–31 | Billing settings UI · Case types UI · Internal-route classification | ✅ **DONE — DEPLOYED** at `3df2037` (#222) and `730141e` (#223). Nothing was removed in 31: all three routes are tested boundaries |
| 32–33 | Reachability re-audit · final correction reconciliation | ✅ **DONE.** No new BLOCKER/HIGH; `FINAL-LEDGER.md` PART 6B is the record |
| 28 | **Legal pre-case access** (Production Truth BLOCKER) | ✅ **DONE — DEPLOYED** at `9beb0e8` (#221). Legal / Law Firm card on Rate Sheets, Send legal intake on Send to someone new, explicit send context. No third pricing source. LIVE VERIFY **OPEN** |
| 27 | **Ended by Admin / Ended by [name]** (owner decision 4) | ✅ **DONE** — `case_day_end`, additive; authorization untouched; legacy days stay readable. **The dispatch it owed was run**: `portal-setup` 32508101361 at `74629fe`, ✅ including the admin-bootstrap step. The header table is the authority; this line said "owes" until 2026-08-22 |
| 26 | Final master reconciliation + project closeout | ✅ **DONE** — every durable requirement classified in `case-portal/FINAL-LEDGER.md`. No non-deferred approved requirement is missing |
| 34 | Public Legal page · no public pricing · three service claims removed | ✅ **DONE — DEPLOYED** at `405462f` (#225). LIVE VERIFY **OPEN** |
| 35 | Retired terminology leaves the Admin UI | ✅ **DONE — DEPLOYED** at `c691518` (#227). No stored value changed |
| 36 | Optional-field labelling, audited off the validators | ✅ **DONE — DEPLOYED** at `b34ccda` (#228), Pages run 32540154210. LIVE VERIFY **OPEN** |
| **37** | **Final Production Truth Audit — Round 2** | ✅ **DONE — NOT PASSED.** One HIGH, two lesser. Result and correction queue in `case-portal/PRODUCTION-TRUTH-2.md`. No repository file was changed to run it |
| **37A** | **HOTFIX — all three Round 2 findings** | ✅ **DONE.** HIGH: the search gained an intake fallback over `submissions.subject_name` and the payload address, scoped like the structured arms, with `case_subjects` kept as the preferred source so a curated case returns once. MEDIUM: `pageName()`/`pageKind()` give each door its own accessible name. LOW: `/legal-investigations/*` gained its siblings' cache rule, security untouched. **No schema.** Detail in `PRODUCTION-TRUTH-2.md` |
| **38** | **Case Workspace Simplification** (the owner's message calls it "Unit 34" — that number is taken; see below) | ✅ **DONE — LIVE VERIFIED** by the owner 2026-08-22, at `f2f49d4` (#232). Owner brief verbatim in `case-portal/CASE-WORKSPACE.md`. Carried **Activity oldest-to-newest ordering** and **simplified Activity / Daily Summary access** inside it, by the owner's instruction — not separate units |
| **39** | **Case content Delete / Restore controls** | ✅ **DONE — LIVE VERIFIED** by the owner 2026-08-22, at `79da2b8` (#234); schema confirmed on production by `harden-check` run 32584685117. Owner brief verbatim in `case-portal/CASE-CONTENT-DELETE.md`. **A PRODUCTION unit, not test-cleanup**: Admin needs an obvious way to remove wrongly entered information from REAL cases. Six areas — activity, investigation days, daily summaries, evidence, package contents, and an audit of other user-entered records. **No Dropbox byte deletion, no evidence overwrite, no silent hard delete**; Remove from Package is never Delete from Case; a report whose source changed says so rather than looking current |

## CONFIRMED COMPLETE — DO NOT REOPEN

Owner-confirmed or reconciliation-confirmed. **Do not reopen unless current
master directly contradicts the completed status.**

- Timestamp Photo · Portal Palette Normalization · Storage Health · Case Closeout
- Private retainer-payment idempotency
- **Private custom-retainer carry-through** — $1,500 / $2,000 / $3,000 / Custom,
  the agreed retainer preserved through intake and payment, RECEIVED /
  OUTSTANDING, additive partial payments
- **Active Surveillance final completeness** — mobile workflow, voice workflow,
  activity timeline, daily/end-day workflow, reporting integration
- **Unit 17 Retention Controls — CODED, TESTED, PUSHED, MERGED, DEPLOYED.**
  **LIVE VERIFIED is DEFERRED until the owner has a suitable real case.**
  *Do not manufacture a production case solely for this test.*

## IMPLEMENTED BUT NOT LIVE VERIFIED

Machine-verified and deployed. **Do not rebuild any of these unless a
regression is found.** They are swept together in **Unit 23**, never reopened
as development units:

Dropbox Portal UI · Admin Report Workflow · Portal UI Modernization · Legal /
Law Firm Intake · Legal Rate Sheet · Legal firm profiles · Legal billing
workflow · Global Search · Needs Attention · Report Templates · Case Timeline ·
Evidence Integrity · Daily Summary · Client Delivery Center · Retention Controls

## HOTFIX 17A — Legal intake link routing

A Legal/Law Firm send using **Include Intake Link** could bundle the **Private**
intake door, which that picker refuses for Legal. Required: Private sends
Private, Insurance sends Insurance, Legal sends Legal, **never cross-routed**.
**Test all three intake types separately.** Do not rebuild the already-shipped
Legal intake/rate-sheet architecture. **This comes before Unit 18.**

## UNIT 18 — Invoice Payment Integrity

Every verified invoice-payment finding, together: idempotency so a
double-submit never records money twice · reversible payment
correction/void · **immutable, auditable payment history** — a prior payment
stays visible as voided/corrected, never silently erased · accurate balances
after correction · safe overpayment handling · a client-facing balance that is
never misleading · accurate invoice print/output, including the known overlap
where an overpaid balance prints as `Balance due $-500` · **void invoices must
stop counting their money as Paid This Month** · reuse the existing
retainer-payment idempotency pattern where it fits · **no destructive deletion
of financial history.**

**OWNER DECISION PENDING — does an UNSENT/DRAFT invoice draw down the
client-facing retainer?** See the decisions section below: the owner answered
this on 2026-08-21 and then asked for it to be held pending. **Do not invent
the policy; confirm before implementing.**

## UNIT 19 — Package + Report Accuracy

Removed activity entries represented correctly in the Report Chronology ·
entries restored with **Put It Back** rendering correctly · a day approved after
finalization must not be invisible while the Completed desk counts it · video
exhibit numbering internally consistent within one document · the Documents
count reflecting real documents rather than always reading 0 · package/report
counts agreeing with the artifacts actually included · **Evidence Integrity,
report version history and final package behaviour all preserved** · verify
Print Preview / Save PDF · verify mobile report readability, no horizontal
overflow, and no screen chrome inside printable documents.

## UNIT 20 — Intake Alert Completeness

Alerts identify the intake type — **Private / Insurance / Legal** where
applicable · one real intake = one notification · a deduplicated or retried
intake raises no duplicate alert · **the retainer-payment dedup must stop
alerting twice** · failed delivery becomes visible to an admin **without
exposing client information** · test/sample/demo/fixture records raise no
production alert · alerts fire only after the production commit ·
configurable admin destinations · email capability preserved.

**SMS stays DEFERRED** — do not choose or wire a provider. If the alert-status
log is still owner-deferred, keep it deferred and keep it **distinct** from the
minimum admin-visible failure state this unit does require.

## UNIT 21 — Accessibility + Interaction Pass

Keyboard navigation · logical focus order · visible focus states ·
screen-reader labels and announcements for meaningful state changes · semantic
headings and form controls · accessible error and status messaging · no
colour-only status meaning · sufficient contrast · mobile tap-target sizing ·
accessible dialogs and modals · responsive layouts with no horizontal
overflow · the critical admin and investigator workflows · final desktop and
phone verification.

Also reconciles **SURVEILLANCE-VOICE.md §9**: the audible-tone requirement is
the one unbuilt line of the voice spec. **Implement it only to the existing
approved spec — invent no new voice behaviour.**

## UNIT 22 — PORTAL-OPS Remaining Gaps

Never built: **cross-case Tasks view · Quick Actions + NEW · Saved Views ·
Case Templates · Document Templates · Audit Trail screen.**

**Audit master immediately before implementing** so existing equivalents are
reused rather than duplicated. **Do not build a wall of equal KPI cards.**
Preserve the operating model: clear Needs Attention, an obvious Next Step,
useful global search, compact operational hierarchy.

**OWNER INPUT REQUIRED — PORTAL-OPS PERMISSIONS.** That requirement arrived
corrupted and was never re-sent. **Do not invent it.**

## UNIT 23 — Consolidated Live Verification Sweep

After 18–22 deploy, produce **one owner-friendly checklist** covering every
implemented-but-unverified item: the fifteen listed above plus Invoice Payment
Integrity, Package + Report Accuracy, Intake Alert Completeness,
Accessibility, the PORTAL-OPS additions, and the full Insurance and Private
workflows.

**Do not ask the owner to create fake production cases.** Mark each check
**LIVE VERIFIED** or **LIVE VERIFICATION DEFERRED — REQUIRES REAL CASE/DATA**.

## UNIT 24 — File Queue + Portal Aesthetic Redesign — **REQUIRED**

**THIS IS A REQUIRED FUTURE UNIT. IT MUST NOT BE DROPPED AS "OPTIONAL
POLISH."** The owner explicitly approved the File Queue visual direction, and
**the project may not be declared aesthetically complete until it is
addressed.**

*Design direction:* permanent dark/navy sidebar · clean white working canvas ·
restrained gold accents · teal/green completion cues · compact professional
hierarchy · consistent typography and spacing · no overlapping navigation
labels · multi-line sidebar labels auto-fitting cleanly · responsive iPhone
layout · large mobile tap targets · no horizontal overflow · consistent buttons
and status chips · breadcrumbs/contextual navigation · one obvious Next Step
where useful.

*The File Queue* represents **existing real data** — photos, timestamped
photos, videos, timestamped videos, reports/PDFs, documents, supporting
evidence — with queue concepts such as Awaiting Processing / Awaiting Review /
Awaiting Verification / Ready to File / Completed. **Use existing real workflow
states where equivalent; do not invent duplicate states to copy the mockup.**
Fields: file name, type, case/reference, uploaded date and time, status,
actions, size, case association, uploader, integrity/checksum data.

*The selected-file workspace* shows file information, metadata, a preview where
safe, activity/queue history, current status, next step, notes, case
assignment and evidence-integrity information — **from real portal data, never
mockup data.** Prefer an **aggregation/read model over duplicate storage**; do
not rebuild backend workflows unnecessarily.

The pass also normalizes spacing across sidebar navigation, the Daily
Summary/report builder, cards, tables, labels, inputs, checkboxes and help
text, on desktop and mobile.

**Visual principles to preserve:** navy sidebar, white cards and work areas,
gold highlight, teal completion cues, clean spacing, compact hierarchy, large
mobile controls, the dark field-friendly Active Surveillance interface, visual
evidence where helpful, useful progress indicators, mobile navigation where
appropriate. **Never copy from a mockup:** fake names, cases, dates or file
counts, mockup typos, or decorative buttons that do nothing. **Every production
button must have a real function.**

## UNIT 25 — Final Security / Authorization / Regression Pass

Admin and investigator authorization · client/commercial-data redaction · case,
report and evidence access · retention controls · payment controls · legal
hold · archive/restore · public intake routes · storage health · Dropbox
integration · secret and token exposure · destructive endpoints · responsive
behaviour · accessibility regressions · printable documents · mobile
workflows. **No destructive production migration merely for this pass.**

## UNIT 26 — Final Master Reconciliation + Project Closeout

Compare **every durable owner requirement** against master and live state
again, classifying each as COMPLETE + LIVE VERIFIED / IMPLEMENTED BUT LIVE
VERIFICATION DEFERRED / DEFERRED BY OWNER / MISSING — SKIPPED / OWNER DECISION
REQUIRED. Produce the final ledger showing CODED · TESTED · PUSHED · MERGED ·
DEPLOYED · LIVE VERIFIED or DEFERRED for every meaningful unit.

**The project is not complete while any non-deferred approved requirement is
still missing.**

## The two end-to-end workflow verifications (inside Unit 23)

**Insurance** — public site → insurance rate sheet → insurance intake → admin
review → case creation/assignment → Active Surveillance if applicable →
activity/report → evidence → package → invoice/BILL handoff → delivery →
closeout → retention.

**Private** — public site → private rate sheet → agreed retainer → private
intake → payment instructions → Record Payment → partial payments → case →
fieldwork → report/evidence → package → billing → delivery → closeout →
retention.

**Do not rebuild working functionality merely to satisfy a verification.**
Private payment methods stay exactly as approved: **Cash App, Venmo, Check,
Cash, ACH/BILL.** Credit Card and Other remain removed. **Sending payment
instructions never marks payment received.**

## Legal / Law Firm workflow — do not lose, do not rebuild

The architecture exists. The finished project must preserve and live-verify:
the third intake type **LEGAL / LAW FIRM** · the Legal rate sheet ·
firm/attorney/paralegal profile support · Clients & Firms reuse for repeat
firms · repeat case history · preferred retainer and billing details where
implemented · case objective · deadline and court-date information where
supported · supporting document upload · **correct Legal intake link routing**
(Hotfix 17A) · the Legal billing workflow · BILL/manual invoice handoff where
approved · retainer check pick-up at the firm's office where approved. **Do not
show the private Cash App/Venmo presentation in Legal unless explicitly
approved.**

## DEFERRED / PARKED — preserve, never silently delete

Not part of the active build unless the owner reactivates them. **A deferred
item is never converted to "completed" and never removed from this record:**

physical evidence destruction · automatic retention clocks · automatic purge ·
Dropbox byte deletion · the legacy R2 export/migration decision · two-person
legal-hold approval · SMS delivery and provider · Intake Archive / Sample
Cleanup Part 2 · invoice Write-Off · the PORTAL-OPS Case Health flag · any
separate alert-status-log work marked deferred · any deferred
multiple-provider/storage work · any destructive evidence cleanup.

## OWNER DECISIONS — still required

**Decisions 1 and 4 were LOCKED by the owner on 2026-08-21**, resolving the
conflict this table previously recorded. Their wording is kept verbatim below
and is now durable policy rather than a pending question.

| # | Decision | State |
| --- | --- | --- |
| 1 | Does an **unsent/draft invoice** draw down the client-facing retainer? | ✅ **LOCKED — NO, AND `ready` IS UNSENT TOO** (owner, 2026-08-21). *"UNSENT or DRAFT invoices MUST NOT reduce the client-facing retainer balance. Only finalized/issued billable work may affect the client-facing retainer figure."* Client-facing figures stay **Agreed retainer · Received · Applied/Earned · Outstanding/available**; a separate internal view of draft work is allowed, but the client-facing display must never imply draft work consumed the deposit. *"Do not silently change historical payment records. Do not treat creating a draft invoice as money earned. Do not mark anything paid merely because an invoice exists."* **Implemented in Unit 18.** Today's behaviour is the opposite — the sibling sum filters only `status != 'void'`, CLAUDE.md described it, and E2E-39 asserts it — so all three move together |
| 2 | Are **Cash App `$TreverB`** and **Venmo `@Trever-Brown-9`** the long-term accounts? | ✅ **FINAL — KEEP CURRENT** (owner, 2026-08-21, closeout). *"Keep current Cash App $TreverB and Venmo @Trever-Brown-9 for now. Business-account migration remains a future owner decision."* See FINAL OWNER DECISIONS below |
| 3 | The corrupted **PORTAL-OPS Permissions** requirement | ✅ **FINAL — REMAINS MISSING, MUST NOT BE INVENTED** (owner, 2026-08-21, closeout). *"PORTAL-OPS Permissions remains missing and must not be invented. Rebuild later from owner direction."* Not a closeout blocker. See FINAL OWNER DECISIONS below |
| 4 | **Reassigned-investigator visibility** into a prior investigator's hours | ✅ **LOCKED — ADMIN-ONLY.** A reassigned investigator must not automatically see the previous investigator's *"worked hours, compensation details, billing detail, or other investigator-specific financial information"* — not through *"case-scoped reads, API responses, UI payloads, exports, reports, or hidden fields."* Admin sees all; the current investigator sees only their own where already authorized; **prior-investigator hours stay admin-only.** *"Do not create a new permission toggle unless the approved PORTAL-OPS Permissions specification later explicitly calls for one."* Recorded now as a durable authorization rule (CLAUDE.md, under the case portal); enforced when the permissions/security work is reached — **or immediately if an audit proves an active leak that can be fixed without disrupting Hotfix 17A** |
| 5 | **Homepage section/order** | **Answered and closed:** *"Keep the current homepage section order. Do not reopen homepage structure now."* |

## 🔒 FINAL OWNER DECISIONS — LOCKED 2026-08-21, at closeout

**Recorded verbatim. These answer the five open questions Unit 26's ledger
raised and are durable policy, not pending questions.** Documentation only —
nothing was built, deployed or started for them.

| # | Decision, in the owner's words | What it means here |
| --- | --- | --- |
| 1 | *"PORTAL-OPS Permissions remains missing and must not be invented. Rebuild later from owner direction."* | **MISSING — SKIPPED, by owner direction.** Stays marked missing. **Do not infer, reconstruct or approximate it** from the corrupted text or from any other phase. It is **not a closeout blocker**. The standing rule that no permission toggle may be invented for the reassigned-investigator rule (CLAUDE.md) continues to hold, and is unaffected by this |
| 2 | *"Saved Views remains a future optional operational improvement; do not block closeout."* | **DEFERRED BY OWNER.** Optional, future, non-blocking. Its own heading is still `[inferred]` and its Billing item still corrupted; neither is to be guessed at |
| 3 | *"Case Templates / Document Templates may use a reusable mechanism later, but owner supplies the actual firm content. Do not invent templates."* | **DEFERRED BY OWNER.** The mechanism may be built later; **the content is the firm's own** — case-setup defaults, communication and report language — and is never to be authored here. A mechanism without owner content does not ship |
| 4 | *"If Admin or another authorized user ends someone else's surveillance day, the UI/history must clearly say Ended by Admin or Ended by [name]. Never make it appear the original investigator ended it."* | ✅ **BUILT — Unit 27.** `case_day_end`, one additive companion table. **Owes a manual `portal-setup.yml` dispatch after merge** |
| 5 | *"Keep current Cash App $TreverB and Venmo @Trever-Brown-9 for now. Business-account migration remains a future owner decision."* | **DEFERRED BY OWNER.** Handles unchanged. The `FIRM` source comment still flags them as personal accounts to be swapped before client use; that note stays, because the migration is a future decision rather than a closed one |

**Unit 17 (Retention) and Unit 23 (the consolidated sweep) stay LIVE
VERIFICATION DEFERRED until suitable real case data exists.** Reaffirmed by the
owner at closeout. *No production case or data is to be manufactured for
either.*

### Decision 4 — BUILT as Unit 27, the final closeout unit

**What it was:** `case_days` recorded `end_time`, `end_mileage`, `hours`,
`miles`, `summary` and `ended_at` — and nothing about **who pressed End**. A day
the office ended through `/cases/:no/day/end-other` was stored **identically** to
one the investigator ended themselves, which is exactly what the decision
forbids.

**What was built.** `case_day_end` — one additive companion table, because
`case_days` cannot gain a column while `schema.sql` is re-applied on every
portal-setup run (`activity_removed`, `build_custom`, `build_template`,
`case_day_summary`). It carries the day, the case, **who** ended it, **their
role at that moment**, and **when**.

- **The actor is the caller**, written at the single `UPDATE case_days` that
  ends a day. `user` is the account that passed authorization to reach it;
  `day.investigator_id` is whose day it is; the two differing IS the case.
- **Authorization is unchanged.** `openDayForAction` already required `caseFor`
  and the admin role before it would resolve anyone else's session. Unit 27
  re-decides nothing — it records who did it. Pinned by a test: an investigator
  still cannot end another's day, and the day stays running when they try.
- **`ended_role` is stored, never re-derived** — a demotion next month must not
  rewrite what a day's history says. Pinned by a test that demotes the admin
  and re-reads the day.
- **Self-ended is NOT stored**: it is exactly `ended_by = investigator_id`, and
  a second copy of a derivable fact is a second thing to drift.
- **`dayEndLabel()` is the one writer of the wording** — the Days table, the
  timeline and the day-end response all read it. *Nothing* for a self-ended day;
  *Ended by Admin — Name* / *Ended by Name* for anyone else; **"Ending actor not
  recorded"** where there is no record.
- **A legacy day stays readable** and never reads as self-ended. Every day
  ended before this shipped is in that third state.
- **The record never costs the day.** A missing table or a failed write still
  ends the day, and says so (`ended_by_recorded: false` with a reason) — because
  a silently missing record is the forbidden appearance itself.
- **The client never sees it.** A test asserts *"Ended by"* appears nowhere
  inside `#pkgdoc`. The investigator DOES see it on their own day.

**Adding this table means a manual `portal-setup.yml` dispatch after merge.**
Until it runs, days end exactly as before and read as *not recorded* — which is
honest, and is asserted by its own section.


**Item 12 — REPORT DAILY SUMMARY BUILDER — was inserted by the owner on
2026-08-20**, while Unit 11 was in flight, with the instruction *"Do not start
this while the current major unit is in flight… Record it in NEXT.md in the
correct roadmap position and continue the current unit unchanged."* Their
placement rule was *"immediately after the current active unit and before later
report-dependent delivery/closeout work"*, so it takes 12 and everything from
Storage Health down moves one place. It is **recorded, not designed** — the same
way items 3, 5 and 6 were — and the owner's brief is kept verbatim in
**`case-portal/DAILY-SUMMARY.md`**, which must be read before any code is
written for it.

The parts most easily lost, in their words: it *"must use the existing report
engine and templates. Do not create a second report system"*; the selected Unit
9 template decides where the daily summaries appear; wording comes from
**deterministic sentence templates, never a generated fact** — *"Do not send
case facts to an LLM merely to generate the paragraph"*, and any later AI
polishing *"must be a separate explicit owner decision"*; a missing value is
**omitted rather than filled** (*"omit that clause rather than writing
'registered to unknown'"*); the Activity Log stays authoritative and is
**never altered by editing the narrative**; and a regeneration must **never
silently overwrite a manually edited paragraph** — which is this project's
`EDIT_DRAFT` rule arriving in a fourth place, so it will need collecting typed
values before any repaint.

**Item 13 — PORTAL PALETTE NORMALIZATION — was queued by the owner on
2026-08-20**, also mid-Unit-11, with *"Do not interrupt the active coding
unit."* The brief is verbatim in **`case-portal/PALETTE.md`**. No explicit
position was given; it sits at 13 because the brief's own component list names
*"future File Queue, future Storage Health, future Case Closeout, future
Client Delivery"* as inheritors of the palette, which only works if it lands
before them — if the owner meant a different slot, moving the row is the whole
change. The locked direction in one line: the CURRENT dashboard colors become
tokens (navy primary, teal accent, sparing gold, light surfaces, muted status
colors), values read from the live page rather than invented, applied as a
visual-system normalization that changes no business logic, storage,
permissions or behavior.

**Items 7–15 were locked by the owner on 2026-08-20**, replacing the old
"Remaining Portal Ops" catch-all. Unit 5's brief deliberately fences off two of
them: the dashboard's Needs Attention panel is the **lightweight version using
data that already exists** (the rules/search engine is item 8), and surfacing
an existing case-search entry point is fine but **the Global Search engine is
item 8**. Report template selection is item 9.

**Queue cadence changed by the owner, 2026-08-21** (with the Unit 14 start):
*"Audit first, then continue the approved queue unless a stop condition is
hit."* From item 14 on, units proceed serially WITHOUT waiting for a fresh
per-unit brief — same ship chain per unit (branch → tests → PR → merge →
deploy → save point → NEXT.md), same LIVE VERIFY left open. **Stop conditions
that pause the queue for the owner:** a destructive or non-idempotent
migration; a commercial, legal or pricing decision; anything that would
contradict a recorded owner decision; a defect suggesting live-data damage;
or a brief-level ambiguity two readings genuinely survive.

**Save-point policy changed by the owner, 2026-08-20** (supersedes the
two-per-unit rule): no save points for routine edits or ordinary commits; one
save point after a unit is fully merged + deployed + machine-verified (the
merge push's automatic `save-point.yml` firing satisfies this); one extra only
before a genuinely risky schema/storage migration. **No redundant pre-unit
tags.**

**The order after the Dropbox UI is the owner's own, 2026-08-19**: *"After
Dropbox UI: 1) Admin report/mobile workflow fix, 2) full portal mobile/aesthetic
UI cleanup, 3) Legal/Law Firm intake."* Legal was queued earlier the same day
ahead of a reorder — *"Update the queue so UI work comes before the new Legal
intake"* — so it moved from 7 to 6 and **both UI items run first**.

**And each one ships before the next begins**, in their words: *"Finish, test,
merge and deploy each unit before starting the next."* That is the serial chain
this project already runs — clean master, branch, CODED, focused tests, full
suites once, TESTED, push, PR, MERGED, deploy, DEPLOYED, live verify — applied
per unit rather than batching two units into one merge.

**Item 6 — LEGAL / LAW FIRM intake.** Queued by the owner on 2026-08-19 with the
instruction *"AFTER YOU FINISH THE CURRENT CODING UNIT IN FULL, build the next
queued intake addition below. Do not interrupt or abandon work already in
progress."* Recorded here **mid-unit and not designed**, the same way items 3
and 5 were. The owner's brief is long and specific; the whole of it is kept
verbatim in **`case-portal/LEGAL-INTAKE.md`**, which is the working record for
that unit and must be read before any code is written for it.

The parts that are decisions rather than description, and so are easiest to get
wrong by paraphrase:

- **Pricing is the PRIVATE source, reused — never a second Legal copy.** *"If
  Private pricing changes later, Legal must automatically reflect the same
  pricing."* That means `PERSONAL` / `agreedRetainer()` and the existing private
  retainer selector ($1,500 standard, $2,000, $3,000, Custom), not new constants.
- **But NOT private payment methods.** *"Do not show Cash App or Venmo on Legal /
  Law Firm intake."* Legal's four are BILL.com Invoice / ACH, Retainer Check —
  Pick Up at Firm, Retainer Check — Mail, and Existing Billing Arrangement. This
  splits `CONTEXT_TAKES_PAYMENT`'s current two-way private/insurance model, so
  that is where the design work is.
- **Nothing about choosing or requesting payment is payment.** *"Sending payment
  instructions is never payment. Selecting a payment method is never payment.
  Creating a BILL.com invoice is never payment."* The portal already draws this
  line — `payment_send` records that the firm asked, `retainer_payment` records
  arrival, and they are separate tables so no later edit can confuse them. Legal
  extends that shape rather than inventing one.
- **Use existing status terminology where an equivalent state exists**, rather
  than a redundant parallel status system.
- **Legal intakes belong in the existing Intakes system**, badged LEGAL — not a
  separate disconnected lead system.
- **Quick Legal Assignment** is a deliberately short admin-only path, because
  *"Do not make a longtime attorney relationship harder just because the portal
  exists."*
- **Any schema addition must be additive** and follow the portal-setup workflow
  — which in this repo means a companion table rather than widening a CHECK, and
  a `missingTables()` guard on every read.

**Real-device verification stays OPEN for the owner**, on their instruction.

**Item 5 carries a specific brief, in the owner's own words** (2026-08-18):

> For the portal aesthetic/mobile cleanup, fix the mobile header navigation. The
> hamburger is too small, oddly positioned, and does not look clickable. Use a
> clear 44-48px tap target, stronger menu icon, conventional header placement,
> clean alignment with the logo, and obvious open/pressed state. Remove the
> awkward oversized box around the tiny icon.

Recorded verbatim, **not started**, and not designed here. Two things to carry
into it when it comes up: this project already has a measured tap-target rule
(the field bars use `max(14px, env(safe-area-inset-bottom))` and 50/52px
minimums, asserted rather than eyeballed), and it already has an assertion that
a control's surface must differ from the page behind it by at least 8 luminance
points — written after a "fix" that differed by 3. *"Does not look clickable"*
is exactly what that assertion exists to catch, so the fix should be measured
the same way rather than judged by eye.

**Item 3, in the owner's own words** (2026-08-18): *"add visible Dropbox portal
UI for Admin: connection status, account, Open Dropbox Folder, and case links
for Photos Reports Video."* Plus, on starting it: *"Use existing Dropbox
backend; do not build a file manager."*

**What that first job actually found.** The backend was complete and the window
was the only missing piece. `/dropbox/status` already returned the connection,
the account, when and by whom; `connect`, `callback` and `disconnect` all
existed; `DBX_FOLDERS` already named Photos / Reports / Video. **Nothing in
`portal/index.html` called any of it** — the page did not contain the string
`/dropbox/status`. So no storage behaviour changed, and none needed to.

**The one thing genuinely missing was a name.** This app has App-folder access,
so every path the API returns is app-relative — `/API-1234/Photos`, never
`/Apps/<name>/API-1234/Photos` — and Dropbox does not tell an app-folder app
what its own folder was called. The web URL needs it. It is therefore **asked
for once** and stored in `app_config` (an existing table, so **no schema change
and no portal-setup dispatch**), and until it is answered there is **no per-case
link at all**: `case_url_template` is null rather than a guess and Open Dropbox
falls back to `/home/Apps`, which is correct plus one click.

**A Dropbox web link is not a shared link**, and that is what makes this safe to
put on a case screen: it opens the firm's own Dropbox and shows nothing to
anyone signed in elsewhere. `create_shared_link_with_settings` would hand the
files to any URL holder; a test asserts no `api.dropboxapi.com/2/sharing` call
exists at all. Full reasoning in `DROPBOX.md` → *The visible half*.

Both queue updates were recorded **mid-unit on the owner's instruction** —
*"Do not interrupt the current coding unit. Record this queue only"*, and
*"Queue update only. Do not interrupt Timestamp Photo."* They therefore travel
with whatever branch is in flight rather than as a separate merge.

## 📌 Unit 17 — what shipped (#205, `943d0f3`)

**Retention Controls — records and state; the hold outranks; nothing destroys
anything.** The owner's seven decisions are verbatim in
`case-portal/RETENTION.md` with derived decisions D1–D9; detail in CLAUDE.md
under *"Retention is records and state; the hold outranks; nothing destroys
anything"*. The audit ran first and the owner answered its seven stop items.

**Five states, all DERIVED** (`retentionState()`): Active / Retain Until /
Archived / Scheduled for Deletion / Deleted — Destruction Recorded, precedence
Deleted > Scheduled > Archived > Retain Until > Active. Active is the absence
of markers; Archived and Deleted are the tables that already existed. The page
never re-derives the ladder.

**Nothing here deletes a byte.** "Deleted / Destruction Recorded" is an audit
state only — the panel says in those words that it does not mean a file was
destroyed and does not authorize destroying one. Scheduling deletion is a
record of INTENT: no file removed here or in Dropbox, no clock, nothing runs on
its own, reversible with one Cancel, and the explanation is permanent beside
the button rather than a confirmation that vanishes. **No retention clock
exists**: Retain Until is set and cleared by hand, and a passed date becomes
RETENTION REVIEW DUE — computed against today per read, wording only.

**The hold is enforced AT THE WRITERS**: `/cases/:no/delete`,
`/cases/:no/retention/schedule` and `deleteEvidence` each refuse 409 naming it.
Archive, restore, undelete, billing, reporting and every read stay open
(decision 5's own line). Reason REQUIRED to place and to release (decision 7
audits both), optional on retain-until and scheduling where the trail still
records who/when/prior/new. `retention_event` is append-only and written
best-effort — a failed audit row can never break the action it describes.

**Three additive tables** (`case_retention`, `legal_hold`, `retention_event`),
no CHECKs, `missingTables()`-guarded, in `EXPECTED_TABLES`, swept by
`DEMO_SWEEP`. The archived write-gate passes the retention family (D9); the
deleted gate is untouched and restore-first is asserted from both suites. The
panel sits beside the closing checklist and reuses the existing archive/
restore/delete controls — no second writer.

**Schema changed → `portal-setup.yml` dispatched after merge.**

**Suites at merge:** worker **2544/0**, portal **2369/0**, deploy guard
**68/0**, intake **205/0** (untouched).

**Deferred by name, with the owner:** any physical destruction, retention
clocks and policies, Dropbox byte deletion, the legacy R2 export, two-person
hold approval.

**LIVE VERIFY (owner):** Billing & closing on a real case — place a hold and
confirm Delete case refuses it by name; set a past retain-until and confirm it
reads RETENTION REVIEW DUE without anything happening; schedule deletion, read
the explanation beside it, and cancel.

## 📌 Unit 16 — what shipped (#204, `883fd6d`)

**Client Delivery Center — what is ready to go out, and nothing sends.** The
owner's spec is CASEBUILD.md's own "COMPLETED CASE / DELIVERY CENTER"
paragraph; audit and derived decisions D1–D6 in
`case-portal/DELIVERY-CENTER.md`; detail in CLAUDE.md under *"The delivery
center says what went out, and sends nothing"*.

`GET /delivery-center` (admin-only) leads the Reports & Packages desk with one
row per package-bearing case: the newest build with stamps and names, contents
by role, the filed-PDF fact, the video-link fact through the SAME
classification-gated statement `/completed` uses, the invoice summary and the
send count — bounded at 60, children via parent subqueries, nothing written.
**Delivery status is derived, never stored** (Delivered / Ready to deliver /
In preparation). **Copy delivery message** is client-safe composed text a
person pastes into their own email — link line only when a link is actually
offerable, invoice line only when one was sent, no rate, no internal wording
(asserted). **No send button of any kind** — "Never auto-email evidence" is
the owner's line, the desk says it, a test asserts it, and POST is 404.

**No schema, no portal-setup dispatch.** Deploys green: site `32440542351`,
portal Worker `32440542377`.

**Suites at merge:** worker **2508/0**, portal **2332/0**, intake **236/0**
(untouched), deploy guard **68/0**. Two suite-only hardenings rode along (a
word-bounded client-safe filter; the preview section asserts its synchronous
paint instead of racing the fixture's own error handler).

**LIVE VERIFY (owner):** Reports & Packages on your devices — does the
delivery row for a real case say what that client is actually owed, and does
the copied message read the way you'd send it?

## 📌 Unit 15 — what shipped (#203, `2494716`)

**Case Closeout — the record speaks beside each attestation.** Audit and
derived decisions D1–D6 in `case-portal/CLOSEOUT.md` (no verbatim owner brief
exists for this row; closeout was substantially built already). Detail in
CLAUDE.md under *"The closeout checklist shows what the record can see, and
still obeys the person"*.

`GET /cases/:no/closeout` (admin-only) derives per-item facts from existing
tables — running days, finished days without reports, reports not signed off,
Needs-review files, a started-never-finalized package, unreviewed expenses,
the computed invoice balance, an agreed-unreceived retainer — and the closing
panel draws each beside its tick. **Facts inform, the attestation decides:**
`closeCase` untouched, nothing blocks, facts worded as facts (asserted free of
conclusion words), a clean case says nothing, a failed read says "could not be
read" while the boxes keep working, fetched only when the panel is on screen.
The read writes nothing (row-count asserted). Investigator 403, public 401.

**No schema, no portal-setup dispatch.** Deploys green: site `32437272320`,
portal Worker `32437272383`.

**Suites at merge:** worker **2495/0**, portal **2322/0** (green on the first
full run), intake **236/0** (untouched), deploy guard **68/0**.

**LIVE VERIFIED by the owner, 2026-08-21** — marked complete in their own
words.

## 📌 Unit 14 — what shipped (#202, `96e994d`)

**Storage Health — a screen that answers, never a hand that acts.** The
owner's brief arrived mid-unit and is verbatim, with the audit and derived
decisions D1–D12, in `case-portal/STORAGE-HEALTH.md`; detail in CLAUDE.md
under *"Storage health is a screen that answers, never a hand that acts"*.

`GET /storage-health` (admin) + a Settings panel answer from METADATA ONLY:
safe-to-store readiness (the upload doors' own three conditions, passively,
code named when no); last successful upload (derived); **failed uploads as
the record the owner commissioned** — `storage_failure`, written best-effort
at the four refusal sites, where a failed log write never changes the
caller's answer, a success (autorename included) logs nothing, and with the
table absent every refusal answers byte-identically; bytes split Dropbox vs
legacy R2, live vs removed; the open legacy-video decision's inventory,
named in words as a decision the screen informs and does not perform; the
firm's Dropbox quota (`users/get_space_usage` — the ONE external call, only
in this route, null with a reason on failure); integrity coverage where
unknown is not zero; heaviest cases in one bounded GROUP BY. No credential
in the payload (asserted); the panel offers no sweep, export or delete.

**Also folded in transit:** the two mid-unit live patches (#200 nav rows,
#201 content-sized time input) and the Daily Summary spacing rhythm.

**Schema: `storage_failure` — `portal-setup.yml` WAS dispatched after merge
and succeeded** (run `32435478065`, against `96e994d`). Deploys green: site
`32435467906`, portal Worker `32435467857`.

**Suites at merge:** worker **2481/0**, portal **2316/0**, intake **236/0**
(untouched), deploy guard **68/0**.

**Accepted risk (D12):** re-filing a report PDF creates `…v1-1.pdf` beside
`…v1.pdf` — deferred rather than adding an overwrite mode to the helper that
also writes evidence.

**LIVE VERIFIED by the owner, 2026-08-21** — marked complete in their own
words.

## 📌 Unit 13 — what shipped (#199, `fcd3d38`)

**Portal palette normalization — one token layer, read off the page it was
drawing.** The `:root` block in `portal/index.html` is THE palette now; 237
drifted literal occurrences (205 distinct colors) swept into it. Detail in
CLAUDE.md under *"One palette, read off the page it was already drawing"*;
owner brief verbatim and derived decisions D1–D8 in `case-portal/PALETTE.md`.

**The rules that outlive the unit:** `--field-*` is the dark field family and
stays apart on purpose; semantic chips are token PAIRS changed together or not
at all; and the anti-drift budget is a test — no non-white color more than
twice outside `:root`. Two measured contrast fixes at the token (`--warn` →
`#96600f`, `--disabled` off the 2.2:1 value) and one sanctioned drift repair:
`.btn` is navy (`--navy-2`) per the owner's "Primary: dark navy", with
`.btn.accent` keeping the teal fill.

**No schema, no Worker change, no portal-setup owed** — `deploy-portal.yml`
correctly did not fire (no Worker diff; its deployed `46ccad6` build is
current). Site deploy green: `32431299910`.

**Suites at merge:** portal **2266/0** (green on the first full run), deploy
guard **68/0**, worker and intake untouched.

**LIVE VERIFIED by the owner, 2026-08-21** — marked complete in their own
words; the navy primary, the chips and the field view passed on their devices.

## 📌 Unit 12 — what shipped (#198, `46ccad6`)

**Report Daily Summary Builder — deterministic sentences over the day's own
facts.** A sixth view on the report screen (a report IS one day) assembles
each worked day's professional paragraph live from the day's recorded facts
and the writer's explicit picks, then hands the words over. Detail in
CLAUDE.md under *"The day writes its paragraph, and only a person writes the
log"*; owner brief verbatim and derived decisions D1–D11 in
`case-portal/DAILY-SUMMARY.md`.

**No LLM, no inference, no case fact leaving the portal.** The `ds*` engine is
deterministic templates; a missing value SHAPES the sentence (no year prints
no year, "registered to unknown" cannot be produced); the weekday is computed
at UTC from the date itself. The vehicle grammar, count words, owner clauses
and every opening/closing variant are pinned to exact words in the suite.

**`case_day_summary`** — one additive companion table, `day_id` PRIMARY KEY,
narrative and selections in separate columns. The paragraph is a snapshot:
later activity edits rewrite nothing, Rebuild asks first, typing claims the
box and controls stop rewriting it through repaints and tab switches. Save
follows the `/meta` rule. Write authority mirrors `saveReport` exactly, so the
handoff boundary is inherited — a submitted day is 409 for its writer, and the
paragraph reaches a package only inside a day section that passed the existing
shippable gate. Prints prose-before-chronology in `#repdoc` and `#pkgdoc`
under all six templates; both documents asserted clean of chips, brackets and
form controls. The activity log is measured byte-identical across the
builder's whole workflow.

**Schema: `case_day_summary` — `portal-setup.yml` WAS dispatched after merge
and succeeded** (run `32429215344`, against `46ccad6`). Both deploys green:
site `32429203873`, portal Worker `32429203869`.

**Suites at merge:** worker **2453/0**, portal **2190/0**, intake **236/0**
(untouched), deploy guard **68/0**.

**LIVE VERIFY (owner):** write a real day's paragraph on the phone — the
builder at 390px, a vehicle sentence against a real vehicle record, the
protected-wording flow, and how the paragraph reads on the printed package.

## 📌 Unit 11 — what shipped (#197, `0c0c134`)

**Evidence Integrity — the hash is taken where the bytes already pass.** One
additive table, `evidence_integrity`, answers the owner's nine questions per
artifact; detail in CLAUDE.md under *"The hash is taken where the bytes
already pass"*, owner brief and derived decisions in
`case-portal/EVIDENCE-INTEGRITY.md`.

**The design in one line:** every filing path hashes the buffer it was already
holding (upload, timestamp photo, filed report PDF — `hash_origin: worker`),
the timestamped video is hashed by the generating device, the only place it
exists whole (`hash_origin: device`), and NOTHING is ever downloaded, swept or
backfilled to produce a hash — historical files read *Not yet recorded* until
an admin presses **Record integrity hash**, one file at a time. **Verify
integrity** recomputes and compares, writes nothing, and answers match /
mismatch / unavailable — an unreadable file is never a pass. A re-record
supersedes and keeps history; deleted evidence keeps every record; a metadata
edit moves nothing. Original/derivative comes only from explicit relationships
(`photo_stamp`, the build, the video record) — no filename inference exists.
The manifest is metadata in two statements, credential-free, printed through
`#mandoc`; the page still has exactly one `%PDF-1.` writer. Hash routes scope
the id to the case in one statement, so they cannot probe other cases;
`storage_ref` is admin-only; the field sees hash/role/provenance on its own
cases with no levers.

**Also in #197, ledger-only:** the two owner queue inserts of 2026-08-20 —
item 12 Report Daily Summary Builder (`DAILY-SUMMARY.md`) and item 13 Portal
palette normalization (`PALETTE.md`), both briefs verbatim.

**Schema: `evidence_integrity` — `portal-setup.yml` WAS dispatched after merge
and succeeded** (run `32422210710`, against `0c0c134`). Both deploys green:
site `32422192326`, portal Worker `32422192291`.

**Suites at merge:** worker **2436/0**, portal **2137/0** (one re-run: the
first full run failed 2 checks in the Unit-8-era video-render section — its own
fixture self-check under parallel-Chromium load, a path this unit has zero diff
against; three isolated runs and the confirming full run all green), intake
**236/0**, deploy guard **68/0**.

**LIVE VERIFY (owner):** upload a photo and read its Integrity block; Verify on
a real file; Record hash on a pre-Unit-11 file; the manifest on paper; the full
hash wrapping on a phone.

## 📌 Unit 10 — what shipped (#196, `8d93a9e`)

**Case Timeline — a VIEW over existing case records.** `GET /cases/:no/timeline`
composes a case's chronology at read time from fourteen tables that already
existed: the submission, the status, the days, the activity log with its removed
and voice companions, the evidence, both stamp tables, the reports, the retainer
and invoice payments, the invoice and build events, the legal dates and the
archive and delete markers. Detail in CLAUDE.md under *"The timeline is a view,
and it needed no table"*; the owner's brief verbatim and eighteen derived
decisions are in `case-portal/TIMELINE.md`.

**No schema, and NO INDEX — checked rather than assumed.** Every arm is an
equality lookup on a column that already leads an index (`idx_activity_case`,
`idx_days_case`, `idx_reports_case`, `idx_evidence_case`, `idx_retpay_case`,
`idx_invoices_case`, `idx_invpay`, `idx_invevents`, `idx_builds_case`,
`idx_bevents`, `idx_pstamp_case`, `idx_vstamp_case`, `idx_offers_case`,
`idx_legal_case`, and the four markers keyed by `case_no`). **So this is the
first unit in five that owed no `portal-setup` dispatch**, and none was run.

**The clock is the hard part.** UTC instants and local wall clock both live in
this database, and comparing them unconverted is how an 8:15 PM observation
sorts ahead of a 9:00 PM one recorded an hour earlier. Wall-clock values are
read AS America/New_York, both kinds land on one UTC axis for the sort, and that
axis is never shown — what IS displayed is composed in the Worker so a laptop in
another zone cannot disagree with the report beside it. **Nothing stored is
rewritten.** EST or EDT comes from the date in two passes. A date-only record
sorts at the start of its day and SAYS it has no time; event time and record
time are carried separately when they fall on different days.

**The role boundary is applied by NOT RUNNING the arm** — payments, invoices,
packages, offers, the archive and delete markers and the legal dates are read
only for an admin, and an investigator's header carries no `client` key at all.
The evidence relationship is `entry_id`, never the clock. Every arm is bounded;
invoice and build children go through ONE statement each via a subquery on their
parent; `capped_sources` and `missing_sources` name what could not be reached.

**Three of the brief's candidate events are deliberately absent** because no
record of them exists: PDF generated, intake converted, and Dropbox storage
actions. Adding any would have meant inventing an audit system for the timeline.

**Export is the printable view** (`#tldoc`, beside `#invdoc`/`#pkgdoc`/`#repdoc`)
— there is still exactly one `%PDF-1.` writer in the page, and the generated-PDF
follow-up is bounded and written up rather than half-built (`TIMELINE.md` D15).

**Suites at merge:** worker **2363/0**, portal **2112/0**, intake **236/0**
(untouched), deploy guard **68/0**.

**LIVE VERIFY (owner):** the timeline on a real phone — one column, the filter
chips, the date range, the print — and whether the chronology of a real case
reads the way the office would tell it.

## 📌 Unit 9 — what shipped (#195, `9979fca`)

**Multiple Report Templates — six styles, ONE report engine.** Surveillance,
Domestic / Custody, Insurance, Legal, Process / Locate and General, as
configurations over the single document renderer. Detail in CLAUDE.md under
*"Six report styles, one report engine"*.

**Why it stays one engine:** the PDF is written from the rendered `#pkgdoc`
(Unit 4's decision), so a template that changes the document changes the
preview, the print view, the download and the Dropbox copy together. A test
asserts there is exactly one `%PDF-1.` writer in the page and that the template
definitions contain no logic at all.

A template supplies the title, the section headings, their order and which
optional sections appear — **labels, never narrative**. No template asserts
service was effected, custody was breached or a claim was fraudulent. A section
with nothing in it is skipped whichever template asked for it.

`build_template` is a marker table (the `build_custom` reasoning), the id
carries no CHECK, and **absent means general** — every report that exists today
keeps printing exactly as it did, which is also what stops a later change to the
definitions from rewriting history. A finalized package refuses to be restyled
and says to reopen; finalize records which style it went out in.

**Schema: `build_template` — `portal-setup.yml` WAS dispatched after merge and
succeeded** (run `32406425630`, against `9979fca`). Both deploys green: site
`32406372476`, portal Worker `32406372478`.

**Suites at merge:** worker **2258/0**, portal **2019/0**, intake **236/0**
(untouched), deploy guard **68/0**.

**LIVE VERIFY (owner):** how each of the six actually reads on paper and on
screen, and whether the headings are the words the firm wants in front of a
carrier, a law firm and a private client.

## 📌 Unit 8 — what shipped (#194, `8d28196`)

**Global Case Search + Advanced Needs Attention. No schema change** — both
halves run on structured data the portal already held, so **no portal-setup
dispatch was owed** and none was run.

`GET /search`: case/claim/matter numbers, client and carrier, subject name,
alias, address and phone, vehicle make/model/colour/plate, the firm and its
people, the saved directory, the investigator by name. A phone typed four ways
and a plate typed three all match (punctuation stripped in SQL by nested
REPLACE, written once). **The role boundary is in the SQL**: case-scoped arms
apply `s.assigned_to`, and the arms reading the paying side do not run for an
investigator at all — asserted as a walk over seventeen fields against a case
they are not on. A result says what matched and opens the case at the panel
that matched. Search has a door for both roles.

`GET /attention`: what, which case, why, where to go — intakes, reports owed,
retainers and invoices, legal dates, packages, long-running days, quiet cases,
authorization, storage. **No dismissal** (a row leaves because the thing was
done), severity as a word, windows in one `ATTN` block (14 legal / 21 quiet /
14h day).

**The lesson worth keeping:** moving the queue's derivation from the browser to
the Worker silently deleted the Unit 5 rule that a source which did not answer
must never be drawn as a clear desk. `needsAttention` now returns
`missing_sources` and the page draws a partial view naming them; the two old
tests are re-pointed at the mechanism that can fail now rather than deleted.

**Suites at merge:** worker **2221/0**, portal **1981/0**, intake **236/0**
(untouched), deploy guard **68/0**.

**LIVE VERIFY (owner):** the search box and results on a phone, the queue's
filters and actions under a thumb, whether the alert wording reads right
against a real desk, and Enter/arrows/Escape on a desktop keyboard.

## 📌 Unit 7 — what shipped (#193, `860f8fb`)

**Repeat Client / Firm Profiles.** Saved Clients & Firms — law firm, insurance
organization, private client — so a repeat assignment starts prefilled instead
of retyped. Owner brief verbatim plus every derived decision in
`case-portal/PROFILES.md`; the summary is in CLAUDE.md under *"A profile is a
default; a case is a snapshot"*.

**The architecture in one sentence:** prefill copies profile values into the
assignment FORM, `createManualIntake` writes the case from that BODY exactly as
it always did, and no case read joins a profile — so "editing a firm cannot
rewrite prior cases" is structural. The suite proves it by creating a case from
a firm, renaming the firm, and reading both stored copies of the case back byte
for byte.

**Four additive tables** — `profile`, `profile_contact`, `profile_phone`,
`case_profile` — guarded on every read, with only the case-scoped link in
`DEMO_SWEEP`. No CHECK on `kind`. No merge routine exists anywhere: a possible
match refuses the write and names what it matched. No figure lives on a
profile. Admin-only at every door; the public ingest reads no profile table.

**Two independent reviews audited the diff** (one adversarial against the
boundary claims, one line-by-line against the brief), neither shown the
other's work. The boundaries held; twelve defects elsewhere were fixed, each
with a test. The two worth remembering are in CLAUDE.md: the case workspace was
running the whole duplicate check on **every** admin open, and one search
statement could bind more parameters than D1 allows — green in every test,
broken only in production.

**Schema: four tables — `portal-setup.yml` WAS dispatched after merge and
succeeded** (run `32392845750`, against `860f8fb`). Both deploys green: site
`32392794525`, portal Worker `32392794416`.

**Suites at merge:** worker **2128/0**, portal **1938/0**, intake **236/0**
(the public form is untouched by this unit), deploy guard **68/0**.

**LIVE VERIFY (owner):** the Clients & Firms directory and the picker on a
phone; starting a repeat assignment from a saved firm end to end; the duplicate
warning's wording in front of a real near-duplicate; and `/portal-api/health`
reporting no missing tables. The container has no outbound route, so the health
check is a device check as always.

### (superseded) HOLD — item 7 waited for the owner's Unit 6 review

The owner's instruction closing the Unit 6 brief: *"Do NOT begin Repeat
Client / Firm Profiles until Unit 6 is merged, deployed and reviewed."* The
owner started item 7 explicitly on 2026-08-20, which superseded it.

## 📌 Unit 6 — what shipped (#192, `1b24467`)

The Legal / Law Firm intake, on two structural choices (LEGAL-INTAKE.md, brief
verbatim + derived decisions D1–D8): a legal case IS `kind='consumer'`, so
Private pricing is the legal pricing **structurally** — one source, nothing to
synchronise; and `SEND_CONTEXT.LEGAL` with `CONTEXT_TAKES_PAYMENT === PRIVATE`
means Cash App/Venmo reach a law firm through **no code path**. The four
arrangements (BILL.com/ACH, check pickup, check mail, existing billing) are
requests, never payments — `check_pickup` reads *Awaiting pickup* until the
office records money on Billing. `?assignment=legal` is the public door
("Legal Investigation Assignment"); Quick Legal Assignment is the phone-call
path (firm OR attorney is enough; the agreed retainer goes through the
existing retainer writer). The firm is who is paying: `WS.legal` and the
`legal_*` list columns never reach an investigator, while the LEGAL badge (a
category fact) and the subject do.

**Schema: `legal_intake` (additive) — `portal-setup.yml` was dispatched at
merge**; run id in the deployment table. Until/unless it applied, legal
intakes still land safely in the payload and the panel says so.

**LIVE VERIFY (owner):** the public legal form on a phone end-to-end
(alwayspreciseinvestigations.net/intake/?assignment=legal), Quick Legal
Assignment on the real portal, the LEGAL card and Legal panel, and that
choosing an arrangement never marks anything paid.

## ⏸ superseded — the item-6 hold this replaced

### (was) HOLD — item 6 waits for the owner's Unit 5 review

The owner's instruction closing the Unit 5 brief: *"Do NOT begin Legal Intake
Item 6 until the owner reviews the Unit 5 result."* So there is deliberately no
RESUME-into-item-6 block yet. When the review comes back, the Legal brief is
verbatim in `LEGAL-INTAKE.md`, the queue is items 6–15 in the table above, and
master carries everything below.

## 📌 Unit 5 — what shipped (#191, `6446e3c`)

The shell, measured at 320/390/768/1200 and asserted as numbers: the burger in
the conventional corner on a real surface with a real open state; the drawer's
dim is a real backdrop (taps no longer pass through to live controls, and the
burger is no longer buried under the open drawer); Intake Accept at ≥208×44
(was 42–60px wide × up to 119px tall); the cases list and Out now as stacked
records under 560px with the `.hide` columns restored; Quick Tools as the
day's six doors; 16px inputs + 44px floors + `:focus-visible` portal-wide on
phones. Dashboard: `GET /recent-activity` (existing tables, filenames never
bytes, hidden cases excluded, admin-only) and a Dropbox needs-attention card
that exists only in the broken states, from local state. **No schema change,
no portal-setup dispatch, no new storage, no Dropbox calls from the
dashboard.**

**LIVE VERIFY (owner):** the header/drawer on the actual iPhone, the six-door
launcher, stacked case records, Recent activity, and daily feel.

## ⏸ superseded — the item-5 resume block this replaced

### (was) ▶️ RESUME HERE — item 5, full portal mobile / aesthetic UI cleanup

**Nothing is in flight.** Items 1–4 are merged and deployed; no branch is
half-done. A new session starts a new branch off master.

| | |
| --- | --- |
| Master | **`94b1f5b`** (#190) — site deploy `32329926270` success, Worker deploy `32329926249` success |
| Baselines | worker **1896/0**, portal **1826/0**, deploy guard **68/0** |
| Queue position | item **5 of 7** — the hamburger brief below is part of it |
| Then | item 6, Legal / Law Firm intake — brief verbatim in `LEGAL-INTAKE.md` |

Item 5 already has measured ground to stand on from item 4: the case screen's
phone padding block now lives at the END of the stylesheet (source order was
how the last phone fix died), the 44px tap floor and the 16px input rule are
asserted in the suite, and the portal-wide sweep — main/card padding, the
hamburger brief, everything outside the report screen — is exactly what was
deliberately left for this item.

### Two save points per unit (owner, 2026-08-19)

One when the unit deploys (the merge push fires `save-point.yml` on its own),
and one **manual dispatch immediately before the next unit's first commit**.

### Running the portal suite in this environment

Results are only written at the end — a SIGKILL loses the whole run, and
`nohup` does not survive the shell session. Use the harness-managed background
task, budget ~20 minutes, never two Playwright runs at once (same port). The
VST "playable copy still offers the preview" check is a known once-in-a-while
flake in this container (media decode): if it fails ONCE alongside your own
failures, rerun before believing it; twice in a row is real.

## 📌 Item 4 — what shipped (#190, `94b1f5b`)

The rule, written once (`latestShippableReport`/`shippableReports`): a report
may ride in a package when approved/delivered **or its author holds the admin
role** — review exists for the investigator→office handoff, and an admin's own
report has none. **Finalize is the sign-off, recorded as one**: it stamps the
admin's still-draft reports approved (`status_by` = the finalizing admin,
`reports_approved` build event). The boundary did not move: investigators'
reports still wait, investigators still cannot approve, mixed cases seed only
the admin's own days. Page: **Approve report** directly on an admin's draft,
"Submit report" is the investigator's; the mini-row says **Ready**, never
"Approved", about a shippable draft; finalize reloads the workspace (stale-tab
rule). Mobile: the dead `.dlg` phone rule is alive and asserted on COMPUTED
padding; editor 223→267px and 13.76→16px; sub-tabs wrap; 44px floor.

**LIVE VERIFY (owner):** the report chain end-to-end on the real portal, and
the report screen on the actual iPhone — editor width, no zoom-on-focus, all
five sub-tabs visible.

## ⏸ superseded — the item-4 resume block this replaced

**Nothing is in flight.** Master is clean, the Dropbox unit is merged and
deployed, and no branch is half-done. A new session starts a new branch.

| | |
| --- | --- |
| Master | **`5baabd3`** — deployed, `deploy.yml` run `32218652523` success |
| Save point | **`save/2026-08-19-0514-5baabd3`** |
| Branch to cut | anything; `dropbox-ui` is merged and can be deleted |
| Queue position | item **4 of 7** |

```bash
git fetch origin && git checkout master && git pull origin master   # expect 5baabd3
git checkout -b report-workflow
node case-portal/test-worker.mjs    # baseline 1879 / 0
node portal/test-portal.mjs         # baseline 1808 / 0   (~20 min)
node .github/test-deploy.mjs        # baseline 68 / 0
```

**Then the serial chain, per unit** (owner: *"Finish, test, merge and deploy
each unit before starting the next"*): CODED → focused tests → full suites once
→ TESTED → push → PR → MERGED → pull master → deploy → DEPLOYED → live verify →
**save point** → next unit.

**Two save points per unit** (owner, 2026-08-19): one when the unit deploys —
`save-point.yml` fires automatically on a human push to master, so a merge
creates it without a dispatch — and one **manual dispatch immediately before
the next unit's first commit**. A dispatch is idempotent, so a duplicate costs
nothing and a missing one costs a resume.

**Item 4 has no written brief from the owner yet** beyond its queue line,
*"Admin report workflow and mobile report fix"*. Establish what is genuinely
broken before designing anything — the same first job that turned out to be the
whole of item 3. Item 5's hamburger brief is written out below and is a
different unit; do not merge the two.

### Running the portal suite in this environment

It was killed three times in the session that built item 3. What matters:
**results are only written at the end**, by the normal path or the crash
handler, so a SIGKILL loses the entire run. Use the harness-managed background
task, not `nohup` — `nohup` did not survive the shell session and produced a
log containing nothing at all. Budget ~20 minutes and do not interleave a
second Playwright run; they bind the same port.

## 💾 SAVE POINT — 2026-08-19, branch `dropbox-ui`

Taken on the owner's instruction, **mid-unit and without interrupting it**:
*"Create a safe save point now without interrupting the current Dropbox unit."*

| | |
| --- | --- |
| Branch | `dropbox-ui` (pushed to origin) |
| Master | `21fb3cc` — unchanged; the Dropbox unit is **not merged** |
| Roadmap item | 3 of 7, **IN FLIGHT** |
| Tag / Release | `save-point.yml` dispatched against the branch |

**Standing rule from the owner, 2026-08-19:** *"From now on create another save
point after every completed merge/deploy and before starting the next major
queued unit, so a session timeout can be resumed exactly."* So the workflow is
dispatched **twice per unit** from here on — once when the unit is deployed, and
once again immediately before the next unit's first commit. A dispatch is
idempotent (it exits if the tag already exists), so a duplicate costs nothing
and a missing one costs a resume.

### What is proven at this save point, and what is not

| | State |
| --- | --- |
| `case-portal/test-worker.mjs` | **1879 / 0** — run against this tree |
| `.github/test-deploy.mjs` | **68 / 0** |
| `portal/test-portal.mjs` | **NOT green.** 1791 passed, 0 failed, **then the run crashed** — in my own new section. Fixed on this branch; a rerun is in flight |
| Merge / deploy | **NOT DONE.** Nothing of this unit is on master or live |

The crash is worth recording rather than smoothing over: `1791 passed, 0 failed`
reads like success and is not. The case workspace is a **full page**
(`VIEW = "case"`), so the top-level `.tabs` nav is not on screen inside it, and
my test clicked Settings from within an open case and timed out after every one
of its own assertions had passed. The two existing tests that make this trip
already leave through `[data-act="backToCases"]` first; mine now does too.

### To resume from here

```bash
git fetch origin && git checkout dropbox-ui     # 5 commits ahead of master
node case-portal/test-worker.mjs                # expect 1879 / 0
node portal/test-portal.mjs                     # the one still to prove
node .github/test-deploy.mjs                    # expect 68 / 0
```

Then the ordinary chain: PR → merge if green → pull master → deploy → live
verify → **save point** → next unit (item 4, Admin report/mobile workflow fix).

## 🚦 DEPLOYMENT — 2026-08-21, master `61a00f0` (#206) — Hotfix 17A, Legal intake link routing

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/intake/` + `/portal/` | `61a00f0` | `61a00f0` | **DEPLOYED** — `deploy.yml` 32448892731 success |
| `api-case-portal` | `61a00f0` | `61a00f0` | **DEPLOYED** — `deploy-portal.yml` 32448892724 success |
| Schema | — | — | **No change.** Nothing owed; portal-setup deliberately NOT run |
| Save point | — | — | `save/2026-08-21-0459-61a00f0`, the merge push's automatic firing |

Tests at merge: worker **2557/0**, portal **2371/0**, deploy guard **68/0**.

**What it fixed:** a Legal/Law Firm send with Include Intake Link emailed the
firm `?assignment=private` — the door whose own `pickSvc` refuses `legal`.
`emailSheet` keyed the bundled link off `SHEET_INTAKE[sheet.id]`, and a legal
case's sheet id IS `private_retainer` because Legal shares the private sheet by
design. The door now comes from the send CONTEXT, resolved once and passed
down; `SHEET_INTAKE` has exactly one reader and a test fails if a second
appears. The page names the door the same way. **Verified against a reverted
worker: the two LEGAL assertions fail and the label reads "Private Client
Intake."** Private and Insurance pass either way.

## 🚦 DEPLOYMENT — 2026-08-21, master `943d0f3` (#205) — Unit 17, Retention Controls

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/intake/` + `/portal/` | `943d0f3` | `943d0f3` | **DEPLOYED** — `deploy.yml` 32446446629 success |
| `api-case-portal` | `943d0f3` | `943d0f3` | **DEPLOYED** — `deploy-portal.yml` 32446446602 success |
| Schema | `943d0f3` | `943d0f3` | **APPLIED** — `portal-setup.yml` 32446454208 success; `case_retention`, `legal_hold`, `retention_event` are on the live database |
| Save point | — | — | `save/2026-08-21-0418-943d0f3`, the merge push's automatic firing |

Tests at merge: worker **2544/0**, portal **2369/0**, intake **205/0**, deploy
guard **68/0**.

## 🚦 DEPLOYMENT — 2026-08-21, master `883fd6d` (#204) — Unit 16, Client Delivery Center

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/intake/` + `/portal/` | `883fd6d` | `883fd6d` | **DEPLOYED** — `deploy.yml` 32440542351 success |
| `api-case-portal` | `883fd6d` | `883fd6d` | **DEPLOYED** — `deploy-portal.yml` 32440542377 success |
| Schema | — | — | **No change.** Nothing owed; portal-setup deliberately NOT run |
| Save point | — | — | `save/2026-08-21-0238-883fd6d`, the merge push's automatic firing |

Tests at merge: worker **2508/0**, portal **2332/0**, intake **236/0**, deploy
guard **68/0**.

## 🚦 DEPLOYMENT — 2026-08-21, master `2494716` (#203) — Unit 15, Case Closeout

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/intake/` + `/portal/` | `2494716` | `2494716` | **DEPLOYED** — `deploy.yml` 32437272320 success |
| `api-case-portal` | `2494716` | `2494716` | **DEPLOYED** — `deploy-portal.yml` 32437272383 success |
| Schema | — | — | **No change.** Nothing owed; portal-setup deliberately NOT run |
| Save point | — | — | `save/2026-08-21-0142-2494716`, the merge push's automatic firing |

Tests at merge: worker **2495/0**, portal **2322/0**, intake **236/0**, deploy
guard **68/0**.

## 🚦 DEPLOYMENT — 2026-08-21, master `96e994d` (#202) — Unit 14, Storage Health

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/intake/` + `/portal/` | `96e994d` | `96e994d` | **DEPLOYED** — `deploy.yml` 32435467906 success |
| `api-case-portal` | `96e994d` | `96e994d` | **DEPLOYED** — `deploy-portal.yml` 32435467857 success |
| Schema (`storage_failure`) | `96e994d` | applied | **`portal-setup.yml` 32435478065 success** — dispatched at merge, nothing else owed |
| Save point | — | — | `save/2026-08-21-0112-96e994d`, the merge push's automatic firing |

Mid-unit master patches, each deployed on merge: #200 (nav rows, save
`save/2026-08-21-0034-23cc727`) and #201 (time input, deploy `32434273264`).

Tests at merge: worker **2481/0**, portal **2316/0**, intake **236/0**, deploy
guard **68/0**. The container has no outbound route to the live domain, so
"applied" is the workflow's success against the merge SHA plus the deployed
Worker whose `EXPECTED_TABLES` names the table — `/portal-api/health` on the
owner's device is the final confirmation, the standing standard.

## 🚦 DEPLOYMENT — 2026-08-21, master `fcd3d38` (#199) — Unit 13, Portal Palette Normalization

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/intake/` + `/portal/` | `fcd3d38` | `fcd3d38` | **DEPLOYED** — `deploy.yml` 32431299910 success |
| `api-case-portal` | `fcd3d38` | `46ccad6` | **No Worker diff** — `deploy-portal.yml` correctly did not fire; the deployed build is current |
| Schema | — | — | **No change.** Nothing owed; portal-setup deliberately NOT run |
| Save point | — | — | `save/2026-08-21-0005-fcd3d38`, the merge push's automatic firing |

Tests at merge: portal **2266/0**, deploy guard **68/0**; worker and intake
untouched by the diff.

## 🚦 DEPLOYMENT — 2026-08-20, master `46ccad6` (#198) — Unit 12, Report Daily Summary Builder

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/intake/` + `/portal/` | `46ccad6` | `46ccad6` | **DEPLOYED** — `deploy.yml` 32429203873 success |
| `api-case-portal` | `46ccad6` | `46ccad6` | **DEPLOYED** — `deploy-portal.yml` 32429203869 success |
| Schema (`case_day_summary`) | `46ccad6` | applied | **`portal-setup.yml` 32429215344 success** — dispatched at merge, nothing else owed |
| Save point | — | — | `save/2026-08-20-2334-46ccad6`, the merge push's automatic firing |

Tests at merge: worker **2453/0**, portal **2190/0**, intake **236/0**, deploy
guard **68/0**. The container has no outbound route to the live domain, so
"applied" is the workflow's success against the merge SHA plus the deployed
Worker whose `EXPECTED_TABLES` names the table — `/portal-api/health` on the
owner's device is the final confirmation, the standing standard.

## 🚦 DEPLOYMENT — 2026-08-20, master `0c0c134` (#197) — Unit 11, Evidence Integrity

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/intake/` + `/portal/` | `0c0c134` | `0c0c134` | **DEPLOYED** — `deploy.yml` 32422192326 success |
| `api-case-portal` | `0c0c134` | `0c0c134` | **DEPLOYED** — `deploy-portal.yml` 32422192291 success |
| Schema (`evidence_integrity`) | `0c0c134` | applied | **`portal-setup.yml` 32422210710 success** — dispatched at merge, nothing else owed |
| Save point | — | — | `save/2026-08-20-2200-0c0c134`, the merge push's automatic firing |

Tests at merge: worker **2436/0**, portal **2137/0**, intake **236/0**, deploy
guard **68/0**. The container has no outbound route to the live domain, so
"applied" is the workflow's success against the merge SHA plus the deployed
Worker whose `EXPECTED_TABLES` names the table — `/portal-api/health` on the
owner's device is the final confirmation, the standing standard.

## 🚦 DEPLOYMENT — 2026-08-20, master `8d93a9e` (#196) — Unit 10, Case Timeline

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/intake/` + `/portal/` | `8d93a9e` | `8d93a9e` | **DEPLOYED** — `deploy.yml` 32415586935 success |
| `api-case-portal` | `8d93a9e` | `8d93a9e` | **DEPLOYED** — `deploy-portal.yml` 32415587080 success |
| Schema | — | — | **No change.** Nothing owed; portal-setup deliberately NOT run |
| Save point | — | — | `save/2026-08-20-2043-8d93a9e`, the merge push's automatic firing (`save-point.yml` 32415586976 success) |

Tests at merge: worker **2363/0**, portal **2112/0**, intake **236/0**, deploy
guard **68/0**. The container has no outbound route to the live domain (the
environment's network policy answers 403 at the gateway), so "DEPLOYED" here is
each workflow's success against the merge SHA — `/.well-known/build.txt` and
`/portal-api/health` on the owner's device are the final confirmation, the
standing standard.

## 🚦 DEPLOYMENT — 2026-08-20, master `9979fca` (#195) — Unit 9, Multiple Report Templates

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/intake/` + `/portal/` | `9979fca` | `9979fca` | **DEPLOYED** — `deploy.yml` 32406372476 success |
| `api-case-portal` | `9979fca` | `9979fca` | **DEPLOYED** — `deploy-portal.yml` 32406372478 success |
| Schema (`build_template`) | `9979fca` | applied | **`portal-setup.yml` 32406425630 success** — dispatched at merge, nothing else owed |
| Save point | — | — | `save/2026-08-20-1901-9979fca`, the merge push's automatic firing |

Tests at merge: worker **2258/0**, portal **2019/0**, intake **236/0**, deploy
guard **68/0**. The container has no outbound route, so "applied" is the
workflow's success against the merge SHA plus the deployed Worker whose
`EXPECTED_TABLES` names the table — `/portal-api/health` on the owner's device
is the final confirmation, the standing standard.

## 🚦 DEPLOYMENT — 2026-08-20, master `8d28196` (#194) — Unit 8, Global Search + Needs Attention

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/intake/` + `/portal/` | `8d28196` | `8d28196` | **DEPLOYED** — `deploy.yml` 32402715911 success |
| `api-case-portal` | `8d28196` | `8d28196` | **DEPLOYED** — `deploy-portal.yml` 32402715876 success |
| Schema | — | — | **No change.** Nothing owed; portal-setup deliberately NOT run |
| Save point | — | — | `save/2026-08-20-1821-8d28196`, the merge push's automatic firing |

Tests at merge: worker **2221/0**, portal **1981/0**, intake **236/0**, deploy
guard **68/0**.

## 🚦 DEPLOYMENT — 2026-08-20, master `860f8fb` (#193) — Unit 7, Repeat Client / Firm Profiles

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/intake/` + `/portal/` | `860f8fb` | `860f8fb` | **DEPLOYED** — `deploy.yml` 32392794525 success |
| `api-case-portal` | `860f8fb` | `860f8fb` | **DEPLOYED** — `deploy-portal.yml` 32392794416 success |
| Schema (4 profile tables) | `860f8fb` | applied | **`portal-setup.yml` 32392845750 success** — dispatched at merge, nothing else owed |
| Save point | — | — | `save/2026-08-20-1635-860f8fb`, the merge push's automatic firing |

Tests at merge: worker **2128/0**, portal **1938/0**, intake **236/0** (the
public form is untouched by this unit), deploy guard **68/0**. This container
has no outbound route to the live site (curl returns 000), so "applied" is the
workflow's success against the merge SHA plus the deployed Worker whose
`EXPECTED_TABLES` names the four tables — `/portal-api/health` reporting
`missing_tables: []` on the owner's device is the final confirmation, the same
standard `legal_intake` and `photo_stamp` set.

## 🚦 DEPLOYMENT — 2026-08-20, master `1b24467` (#192) — Unit 6, the Legal / Law Firm intake

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/intake/` + `/portal/` | `1b24467` | `1b24467` | **DEPLOYED** — `deploy.yml` 32345854743 success |
| `api-case-portal` | `1b24467` | `1b24467` | **DEPLOYED** — `deploy-portal.yml` 32345854625 success |
| Schema (`legal_intake`) | `1b24467` | applied | **`portal-setup.yml` 32345885993 success** — dispatched at merge, nothing else owed |
| Save point | — | — | the merge push's automatic firing; tag below |

Tests at merge: worker **1940/0**, intake **236/0**, portal **1868/0**, deploy
guard **68/0**. This container has no outbound route to the live site, so
"applied" is the workflow's success plus the deployed Worker whose
`EXPECTED_TABLES` names the table — `/portal-api/health` reporting
`missing_tables: []` on the owner's device is the final confirmation, the same
standard `photo_stamp` set.

## 🚦 DEPLOYMENT — 2026-08-20, master `6446e3c` (#191) — Unit 5, portal shell modernization

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `6446e3c` | `6446e3c` | **DEPLOYED** — `deploy.yml` 32333635650 success |
| `api-case-portal` | `6446e3c` | `6446e3c` | **DEPLOYED** — `deploy-portal.yml` 32333635594 success |
| Save point | — | — | `save/2026-08-20-0455-6446e3c` (the merge push's automatic firing — the new one-per-unit policy) |
| Schema | — | — | **none.** No portal-setup dispatch owed |

Tests at merge: portal **1849/0**, worker **1907/0**, deploy guard **68/0**.

## 🚦 DEPLOYMENT — 2026-08-20, master `94b1f5b` (#190) — admin report workflow, mobile report fix

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `94b1f5b` | `94b1f5b` | **DEPLOYED** — `deploy.yml` 32329926270 success |
| `api-case-portal` | `94b1f5b` | `94b1f5b` | **DEPLOYED** — `deploy-portal.yml` 32329926249 success |
| Save point | — | — | the merge push fires `save-point.yml`; tag listed below |
| Schema | — | — | **none.** No portal-setup dispatch owed |

Tests at merge: portal **1826/0**, worker **1896/0**, deploy guard **68/0**.

**LIVE VERIFY is OPEN and is the owner's**: the report chain end-to-end on the
real portal (draft → finalize with no approve click → PDF → Dropbox → print),
and the report screen on the actual iPhone — editor width, no zoom-on-focus,
all five sub-tabs visible.

## 🚦 DEPLOYMENT — 2026-08-19, master `5baabd3` (#189) — visible Dropbox Admin UI

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `5baabd3` | `5baabd3` | **DEPLOYED** — `deploy.yml` 32218652523 success |
| `api-case-portal` | `5baabd3` | unchanged | Worker changed, `deploy-portal.yml` runs on `case-portal/worker.js` |
| Save point | — | — | `save/2026-08-19-0514-5baabd3` |
| Schema | — | — | **none.** `app_config` already existed; **no portal-setup dispatch owed** |

**LIVE VERIFY is OPEN and is the owner's**, on their standing instruction. This
container has no outbound route to the site — `curl` to
`/.well-known/build.txt` returned HTTP 000 — so "deployed" here means the
workflow succeeded, not that the page was seen. What needs a human:

1. **Settings → Dropbox card** — does it name the connected account, and does
   **Open Dropbox** land in the right place?
2. **Record the real App Folder name** in that card. No test can know it, and
   until it is entered there are deliberately **no per-case links** — Open
   Dropbox goes to `/home/Apps` instead.
3. **A case → Case media → In Dropbox** — do Photos / Reports / Video open the
   right three folders?

Tests at merge: portal **1808 / 0**, worker **1879 / 0**, deploy guard **68 / 0**.

## 🚦 DEPLOYMENT — 2026-08-19, master `b0304cb` (#188) — portrait geometry, Save to Dropbox

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `b0304cb` | `b0304cb` | **DEPLOYED** — `deploy.yml` 32212125408 success |
| Worker / API | `ad77b2e` | `ad77b2e` | unchanged — **untouched** |
| D1 schema | `ad77b2e` | applied | unchanged — **no dispatch owed** |

Save point `save/2026-08-19-0326-b0304cb`. Portal **1778/0**, guard **68/0**.

✅ **LIVE VERIFIED** — owner, 2026-08-19: *"Timestamp Photo is LIVE VERIFIED
including portrait layout and Save to Dropbox."*

**This closes every device check carried forward since #183.** The entries below
still read "OPEN" because that is what was true when each was written; none of
them is outstanding. The one path the owner's own files never exercised is the
REFUSAL — theirs all decoded — and that is not a gap so much as an untested
edge: it now reports the file's magic number and each decoder's own words, so
the first time it fires it explains itself.

**Timestamp Photo works on the iPhone** (owner, this session) — the CSP was it.

### The overlay took two goes, and the second is the lesson

`vstDraw` sized the face from `H * 0.05` — the **height** — while the stamp runs
along the **width**. Left gap with that code: `3024x4032 → 11px`,
`1080x1920 → 7px`, `750x1334 → 2px`. Edge to edge, no margin.

Sizing from the **short side** fixed the margin and **not the proportion**, and
the owner came back with *"landscape is correct; portrait is still oversized"*.
They were right:

| | share of image width |
| --- | --- |
| landscape 4032×3024 | 52% — reads correctly |
| portrait 3024×4032 | **70%** — the same face on a narrower picture |

The face is now solved from the **width**: measure the text once at a known size
to learn how wide that face draws this string, then compute the size for the
target share. `H * 0.08` caps a wide short picture, and a bounded loop guarantees
the whole stamp lands inside the margins. After: portrait **51.4%**, landscape
**51.7%**, and the same across 1080×1920, 750×1334 and square.

**The assertion is AGREEMENT, not fit.** Every geometry fitted inside its margins
under the rejected version too — *"it fits"* was true of the thing the owner
rejected. What was wrong was that portrait carried a bigger stamp than landscape,
so that is what the test measures.

`vstDraw` is the one writer for photographs **and** video, so the same portrait
defect is fixed in the video renderer.

### Save to Dropbox

Beside **Save to this device**, never instead of it — the device save is
untouched and stays first. Dropbox is organised **per case**, so the case picker
appears only when the door did not already name one, and the case step says *why*
it is asking. Skipping it keeps the copy on the device with nothing uploaded and
no record in the portal. A file placed in Dropbox with no record would be one
nobody can find again, which is the orphan shape `DEMO_SWEEP` exists to prevent.

## 🚦 DEPLOYMENT — 2026-08-19, master `4ca9480` (#187) — the CSP blocked every photograph

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` + `_headers` | `4ca9480` | `4ca9480` | **DEPLOYED** — `deploy.yml` 32208855261 success |
| Worker / API | `ad77b2e` | `ad77b2e` | unchanged — **untouched** |
| D1 schema | `ad77b2e` | applied | unchanged — **no dispatch owed** |

Save point `save/2026-08-19-0231-4ca9480`. Portal **1732/0** — the first fully
green run, and the first ever under the real policy. Guard **68/0**.

**LIVE VERIFIED — OPEN**: the owner's iPhone retest.

### 🚨 THE CSP BLOCKED EVERY PHOTOGRAPH — and the file was never the problem

```
img-src 'self' data:;      ← no blob:
media-src 'self' blob:;    ← video had it all along
```

Timestamp Photo loads the operator's own picture into an `<img>` from a **blob
URL** made in the tab. Without `blob:` the browser **blocked it** and fired
`onerror`, and the page faithfully reported *"cannot decode"*. Every photograph
failed on every device. **Timestamp Video was fine** because `<video>` falls
under `media-src` — which is exactly why the two behaved differently, and the
answer was sitting in `_headers` through two wrong fixes.

`img-src` now allows `blob:`, the same permission `media-src` already had. No
remote origin is added and an assertion guards against one appearing.

### 🧪 WHY NO TEST COULD SEE IT — the part worth keeping

**`_headers` is applied by Cloudflare Pages, and the suite served the page with
no Content-Security-Policy at all.** Every test for months ran against a page
that exists nowhere but in the harness.

The harness now reads the real policy out of `_headers` and serves it on every
`/portal/` response. **Anything that depends on the deployed headers is now
testable**, and the first run under it found nothing else broken.

The assertion that would have caught this is in with it: **a blocked `<img>` is
`complete` with a natural size of ZERO** — it draws as nothing and reads as a
working page — so the test asserts the preview's real pixel dimensions rather
than that an element exists.

### What else went in

- **`createImageBitmap` before the `<img>`.** It takes the Blob directly, with no
  object URL and therefore no `img-src` to satisfy, so the feature no longer
  depends on the policy being right.
- **The refusal reports what it saw**: the magic number from the file's own
  header, what the file claimed to be, its size, and what each decoder did — and
  it names a blocked blob URL where the `<img>` error is reported, because a
  browser reports a policy block exactly like a corrupt file. That
  indistinguishability is what sent two rounds of work at the wrong thing.

## 🚦 DEPLOYMENT — 2026-08-19, master `0b97f27` (#186) — decode the file itself

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `0b97f27` | `0b97f27` | **DEPLOYED** — `deploy.yml` 32206882408 success |
| Worker / API | `ad77b2e` | `ad77b2e` | unchanged — **untouched** |
| D1 schema | `ad77b2e` | applied | unchanged — **no dispatch owed** |

Save point `save/2026-08-19-0159-0b97f27`. Portal **1724/1**, guard **68/0**.
The one portal failure is the pre-existing preview fixture.

**LIVE VERIFIED — OPEN**: the owner's retest of the **same `IMG_3576.jpeg`** on
the same iPhone.

### The defect

The owner's iPhone refused `IMG_3576.jpeg`. `pstFromBytes` rebuilt the picture as
`new Blob([buf], {type: file.type || "image/jpeg"})` — rewrapping the operator's
own file under a type **this page chose**. A `File` is already a `Blob` and
already knows what it is. The local path now hands over the File; the in-case
path has only bytes off the evidence route, so it still builds a Blob, from the
content type the case recorded.

### ⚠️ WHAT THIS DOES NOT PROVE — read before assuming it is fixed

**Chromium decodes a mislabelled blob anyway.** Measured with the OLD code
restored: a JPEG declared `image/heic` still reached the "when" step. So this is
**not evidence** that the rewrap was what the iPhone hit, and Safari's
strictness cannot be reproduced in this container.

If `IMG_3576.jpeg` still fails, the cause is elsewhere and the next step is
putting the file's own magic number and the decoder's error **on the screen**, so
a screenshot answers it instead of raising another round of speculation. That was
built and then deliberately reverted — along with a second decoder
(`createImageBitmap` before `<img>`) — because shipping three changes at once
would leave the retest unable to say which one mattered.

The assertion with teeth here is **structural**: the local path hands over the
File and never rebuilds a Blob. The behavioural one guards the outcome, not the
regression, and says so in its own words.

## 🚦 DEPLOYMENT — 2026-08-19, master `c77dd11` (#185) — picture first, case last

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `c77dd11` | `c77dd11` | **DEPLOYED** — `deploy.yml` 32204378491 success |
| Worker / API | `ad77b2e` | `ad77b2e` | unchanged — **`worker.js` and `schema.sql` untouched** |
| D1 schema | `ad77b2e` | applied | unchanged — **no dispatch owed** |

Save point `save/2026-08-19-0117-c77dd11`. Portal **1718/1**, guard **68/0**,
worker **1849/0** at `ad77b2e`. The one portal failure is the pre-existing
preview fixture, untouched on the owner's standing instruction.

**LIVE VERIFIED — OPEN**, for the owner's device test: that the door opens the
photo picker rather than a case picker, that the copy can be kept without
choosing a case at all, and the two checks carried from #183 (real camera EXIF,
and an HEIC refusal reading correctly).

### The workflow error

Owner, after a live test: *"Remove the required case picker at entry"*, then
*"Match Timestamp Video: choose a local photo first on iOS Android Mac or
Windows, timestamp it locally, then optionally choose a case only for Dropbox or
case filing."*

The door now opens the picture picker. **Nothing is uploaded and the portal
holds no record unless a case is deliberately chosen** — asserted against counts
taken before the picture was even chosen. Filing a picture off a device sends
the **original first** and the copy against it, because the original is
preserved untouched as case evidence and the pair is meaningless without it.

**Two of my decisions were overruled by the field, in order**, and both are
recorded as superseded in `PHOTO-TIMESTAMP.md` with their original reasoning
kept: D1 put the door only on a photograph already in the case, and its fix led
with a required case picker.

### 🕒 THE SUITE ONLY PASSED AFTER 10:05 IN THE MORNING

Worth reading before the next red run is blamed on the change in front of it.

Two fixtures typed **fixed times** into the form (`09:41`, `10:05`) while every
later section stamps with the real clock through `stampNow()`. The timeline
orders by `at_time`, so those fixtures sat on top of anything filed earlier in
the day. Nine voice assertions and a crash appeared, and **reproduced identically
on master** — the same commit that scored 1704/1 the previous evening scored
1057/9 at 01:00.

```
id  6  10:05  Trever Brown   "Subject returned to residence and entered…"
id 11  01:00  Dana Field     "No change observed at the residence."  (voice)
```

**Nothing about the product was wrong.** 10:05 IS later in the day than 01:00;
the ordering, the field home's `acts[0]` and the *"belongs to another
investigator"* refusal were all correct. Fixtures are now stamped **relative to
the run** and clamped at `00:00`, so a run a minute past midnight cannot roll
into yesterday.

Three hypotheses were wrong first — the run crossing midnight, a function lost
in a rewrite, the form defaulting to a fixed time — and each was killed by
evidence rather than argued down. The fourth attempt was a **diagnostic instead
of a guess** and answered it in one run.

## 🚦 DEPLOYMENT — 2026-08-19, master `2067755` (#184) — Timestamp Photo, findable

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `2067755` | `2067755` | **DEPLOYED** — `deploy.yml` 32199484685 success |
| Worker / API | `ad77b2e` | `ad77b2e` | unchanged — **`worker.js` and `schema.sql` untouched** |
| D1 schema | `ad77b2e` | applied | unchanged — **no dispatch owed** |

Save point `save/2026-08-19-0000-2067755`. Portal **1704/1**, guard **68/0**,
worker **1849/0** at `ad77b2e`. The one portal failure is the pre-existing
preview fixture, untouched on the owner's standing instruction and
timing-dependent — it passed on the two runs before this one.

**LIVE VERIFIED — OPEN**, for the owner's iPhone: that the tool is now findable,
plus the two checks carried from #183 (a photograph with real camera EXIF, and
an HEIC file whose refusal has to read correctly where the browser cannot decode
it).

### The defect

Owner, live: *"Timestamp Photo is deployed but not visible anywhere in the live
portal."* `pstOpen` was rendered in **exactly one place** — inside `pstButton()`,
which draws only on an evidence card for a photograph that already exists —
while `vstOpen` had three call sites. With nothing uploaded there was no card,
and with no card there was no entry point anywhere.

That was **D1** in `PHOTO-TIMESTAMP.md`, now marked superseded with its original
reasoning kept. Four doors: the navigation foot (both roles, every screen), the
dashboard quick-tools row, its own card on Case media, and the field view's
media screen. The top-level copies carry an empty `data-case`, so the utility
asks which case rather than adopting whichever one is open behind it.

### The bigger thing found on the way

**The phone navigation drawer wrapped into a second column**, and adding one
door tipped it over. `.tabs` is a wrapping ROW at the top of the stylesheet; the
rail and the drawer change its direction and inherit the wrap. Measured when it
broke: drawer **296px wide, 460px of content, every child 224px or less** — no
item was too wide, there were two columns of them.

Both column layouts are now `flex-wrap:nowrap`. **The drawer had been one item
away from splitting for as long as that rule existed**, so any door added to the
navigation would have triggered it. Worth knowing before item 5 starts.

## 🚦 DEPLOYMENT — 2026-08-18, master `ad77b2e` (#183) — Timestamp Photo

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `ad77b2e` | `ad77b2e` | **DEPLOYED** — `deploy.yml` 32193706447 success |
| Worker / API | `ad77b2e` | `ad77b2e` | **DEPLOYED** — `deploy-portal.yml` 32193706374 success |
| D1 schema | `ad77b2e` | applied | **DISPATCH RUN** — `portal-setup.yml` 32196546101 success |

Save point `save/2026-08-18-2239-ad77b2e`. Worker **1849/0**, portal **1687/0**,
guard **68/0**.

**`photo_stamp` is live.** The deployed Worker answered
`{"ok":true,"configured":true,"email":true,"missing_tables":[],"storage_pct":0}`
— an empty list from the build whose own `EXPECTED_TABLES` names the new table,
which is the proof rather than the schema step's exit code. The dispatch also
reported *"An account already exists — nothing to do"* and destroyed the
bootstrap token: nothing about accounts changed.

**LIVE VERIFIED — OPEN**, and specifically these two, because neither can be
observed anywhere but a phone:

1. An iPhone photograph carrying real camera EXIF — confirm the fields are
   seeded from the camera and the zone wording matches what the phone actually
   wrote.
2. An HEIC file — confirm the refusal reads the way it should where the browser
   cannot decode it, and that no Generate button is offered under it.

### What shipped

- **The pair.** A photograph already in the case gains a **second**
  `case_evidence` row in the case's own Dropbox `Photos` folder. The original is
  never modified — asserted at the bytes, not at the row. `photo_stamp` names
  which is which.
- **The burn is `vstDraw`, worded by `vstLabel`** — the video renderer's own
  functions, not copies. The strongest test in the suite is a **pixel read**:
  the copy's bottom-right corner has bright pixels, its top-left has none, and
  the original has none in either place.
- **Nothing is guessed about when the picture was taken.** EXIF
  `DateTimeOriginal` seeds it and the screen says the camera is where it came
  from; with no EXIF the form is empty and says so. `file.lastModified` and
  today's date are never used, and a test asserts the current year never appears
  as a seed.
- **Two refusals**: the copy inherits the original's classification, so
  stamping cannot promote held-back material past the package gate; and a
  timestamped copy cannot itself be stamped.
- **The package rule** (owner, mid-build): an *Include timestamped copy in
  client package* checkbox, default ON, decides the classification the copy is
  born with. No second flag — package eligibility already IS the classification.
  The original is never reclassified, and the picker offers it as an explicit
  **Add anyway** while its copy is the one going.

## 🚦 DEPLOYMENT — 2026-08-18, master `c333d3f` (#182) — the mobile/voice unit closes

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `c333d3f` | `c333d3f` | **DEPLOYED** — `deploy.yml` success |
| Worker / API | `c333d3f` | `c333d3f` | **DEPLOYED** — `deploy-portal.yml` success |
| D1 schema | `c333d3f` | applied | **DISPATCH RUN** — `portal-setup.yml` 32186595371 success |

Save point `save/2026-08-18-2112-c333d3f`. Portal **1641/0**, worker **1789/0**,
guard **68/0** — including the 21 new portal assertions and the 10 new worker
ones. The preview fixture that failed on the #181 run passed on this one; it was
never touched, on the owner's instruction, so treat it as timing-dependent
rather than fixed.

**`activity_voice_event` is live.** `portal-setup.yml` ran against the merged
tree and the deployed Worker answered
`{"ok":true,"configured":true,"email":true,"missing_tables":[],"storage_pct":0}`
— an empty list from the Worker whose own `EXPECTED_TABLES` names the new table
is the proof, not the schema step's exit code.

**LIVE VERIFIED — OPEN**, and specifically these two, because neither can be
observed anywhere but a phone:

1. Say *"Mobile, take photo"* and confirm the camera is genuinely **one tap**
   away and that **nothing appears in the log** until the picture lands.
2. Put the phone in airplane mode, speak an observation, and confirm it is
   **held** and then **sends itself** when signal returns — as one entry, not two.

### What shipped

- **§13 — the capture is prepared, never claimed.** A spoken word cannot open a
  camera; the browser wants a gesture and iOS means it. So the command puts the
  capture one tap away and says so, and nothing is written until a file actually
  arrives. An activity entry announcing a photograph that does not exist is
  exactly the fabricated record this project refuses everywhere else. The loop
  keeps listening while the card waits.
- **§8 — no signal must not lose the observation.** A surveillance position is
  precisely where there is no bar of service. A failed send is queued on the
  phone, the count is **shown** rather than hidden in a variable, and it flushes
  itself when the network returns. A 4xx is a refusal and is not retried; only a
  dropped connection is.
- **§8's other half is server-side, because it has to be.** A POST that landed
  and whose response was lost is indistinguishable from one that never arrived,
  so the client names each utterance and keeps that name across every retry, and
  the Worker answers a repeat with the entry that already exists. Same words
  under a new name are a new entry — the investigator may genuinely have said it
  twice. `activity_voice_event` is a companion table for the usual reason, and
  its read is guarded, so the Worker works before the dispatch has run.
- **§1/§16.1 — the status is two lines, not five.** Everything the old block
  said is still there. The measurement is in the test rather than the eye: the
  block is ≤78px and the quick controls start in the top third of the phone.

## 🚦 DEPLOYMENT — 2026-08-18, master `bae2c26` (#181) — unmatched speech is kept

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `bae2c26` | `bae2c26` | **DEPLOYED** — `deploy.yml` success |
| Worker / API | `bae2c26` | `1ca9a97` | **DEPLOYED** — `worker.js` untouched |
| D1 schema | `bae2c26` | applied | unchanged — **no dispatch owed** |

Save point `save/2026-08-18-2028-bae2c26`. Portal **1619/1**, worker **1779/0**, guard **68/0** — the one
failure is the pre-existing preview fixture, untouched on the owner's
instruction.

**LIVE VERIFIED — OPEN.**

## 🔄 §7 OVERRIDDEN BY THE OWNER (#181) — and why the override is right

Owner, after using it: *"Voice commands are too strict. After Mobile, use a
known command if confident; otherwise save the spoken words as an editable
VOICE activity entry. Do not reject unmatched useful speech or pause the loop."*

**§7 was written to stop a misheard phrase filing itself, and the first build
honoured it by PAUSING the loop.** At the wheel that is the worse failure: the
investigator narrates on to a microphone that stopped listening, and the hole
in the day's log is found when the report is written. A surveillance log with
gaps is the evidence problem. An unpolished but accurate sentence is not.

**The part of §7 that still holds is the part that mattered:** an uncertain
phrase never gets a canonical command id. *"Mobile change"* fits both
`NO_CHANGE` and `CHANGE_POSITION` — opposite facts about the same minute — and
guessing puts a claim in the log nobody made. The spoken words assert nothing
false: `source = voice`, `command_id` **null**, editable, transcript beside it.

Two outcomes after the wake word and no third — a confident match files the
standardized sentence with its id; anything else files the spoken words. Both
confirm briefly and return to listening.

**What stays strict:** the wake word, or the log fills with the passenger's
half of a phone call. **What is not rewritten:** the operator's words, beyond
stripping the wake word and a leading "note".

**Not dead code:** Tap to speak still goes through transcript review and an
ambiguous transcript there still gets the chooser. Only the LOOP changed, which
is where pausing was costing the log.

## 🚦 DEPLOYMENT — 2026-08-18, master `8adfc6d` (#180) — the iPhone voice bug

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `8adfc6d` | `8adfc6d` | **DEPLOYED** — `deploy.yml` success |
| Worker / API | `8adfc6d` | `1ca9a97` | **DEPLOYED** — `worker.js` untouched |
| D1 schema | `8adfc6d` | applied | unchanged — **no dispatch owed** |

Save point `save/2026-08-18-2004-8adfc6d`. Portal **1615/1**, worker **1779/0**, guard **68/0** — the one
failure is the pre-existing preview fixture, left untouched on the owner's
instruction.

**LIVE VERIFIED — OPEN, and only the iPhone can close it.**

## 🐞 "ON, MICROPHONE LIT, NOTHING HAPPENS" (#180)

Owner on the device: voice mode ON, iOS indicator active, *"saying Mobile
produces no result and Tap to speak does nothing."*

**Two symptoms. One needed no Safari knowledge to find:** the page had **two
recognisers** — the loop's and Tap to speak's — and a browser gives a page
**one** speech session. With the loop holding it, the manual button started a
second engine on top of the first and the browser ignored it. That is exactly
what a button that does nothing looks like. Tap to speak now TAKES the session
and the loop stands down.

**The other is `continuous`,** which iOS Safari does not honour: the session
starts, the indicator lights, and no result is ever delivered — the report word
for word. The loop is now **one-shot restarted on `end`**, the portable shape,
one code path, no device sniffing. A start that throws no longer leaves the
panel claiming ON, which is the shape of the whole complaint.

**THE DEVICE NOW SAYS WHAT IT DID.** Every `SpeechRecognition` event with a
timestamp, **alongside the calls this page makes itself** (`start() called`,
`restarting`, `start() threw`). That distinction is the diagnostic: *"we called
start and the engine never said start"* is a different fault from *"start,
audiostart, speechstart, end, no result"*. Shown ON THE PHONE and open by
default — a console nobody can open on an iPhone in a car is not a diagnostic.
Errors are logged even when they stop nothing; silence about `no-speech` is
what made this invisible.

**What is NOT proven:** this container has no speech engine, so only the
session-collision fix is demonstrated. The `continuous` fix is reasoned from
the reported behaviour and Safari's known treatment of it. **The log is the
instrument for the next device test** — if it shows `start() called` and
nothing after, that is a different finding from a full
`start → audiostart → speechstart → end` with no `result`.

**A test-quality note, now explained rather than guessed at.** The
"a playable copy still offers the preview" assertion is not flaky: the fixture
builds `<video src="">`, the media error fires, and the page CORRECTLY flips to
"this device will not play it back". The assertion was racing that event. Left
untouched on the owner's instruction; the fix is to count the preview in the
same evaluate as the paint.

## 🚦 DEPLOYMENT — 2026-08-18, master `b73e02d` (#179) — voice §2 wake-word loop

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `b73e02d` | `b73e02d` | **DEPLOYED** — `deploy.yml` success |
| Worker / API | `b73e02d` | `1ca9a97` | **DEPLOYED** — `worker.js` untouched, so `deploy-portal.yml` correctly did not run |
| D1 schema | `b73e02d` | applied | unchanged — **no dispatch owed** |

Save point `save/2026-08-18-1912-b73e02d`. Suites: portal **1598/0**, worker **1779/0**, guard **68/0**.

**LIVE VERIFIED — OPEN, and only a real phone can close it.** Speech recognition
does not exist in headless Chromium. What closes it: the permission prompt on
first ON; *"Mobile, no change at residence"* filing ONE entry and returning to
listening; two commands in a row without touching the screen; and locking the
phone to confirm it SAYS it stopped rather than pretending to listen.

## 🎙 VOICE COMMAND MODE — THE LOOP (#179)

§2, §9, §14, §16, and the half of §8 the loop itself creates.

**§14 is asserted as calls, not wording.** Opening Active Surveillance
constructs **no recogniser at all** — a test asserts zero. "The microphone is
inactive when off" is the kind of claim that is easy to write on a screen and
easy to get wrong underneath.

**§2's loop, in the shape people actually speak.** "Mobile" and the command in
one breath works; "Mobile" alone arms it and waits, which is the two-step form
the spec describes. A confidently matched command files a real entry through
the existing activity API and returns to listening with no tap between
commands.

**Only a confidently matched command files itself.** Ambiguous phrases,
dictated prose and unmatched phrases all STOP the loop and hand to the review
that already existed — the operator is then looking at a question, and a
microphone still listening would file over the top of it. **Speech without the
wake word is ignored entirely**, or a car radio fills the screen with prompts.

**§16 is enforced, not merely written.** The loop stops on `visibilitychange`
and says why. An investigator who believes the phone is listening in their
pocket stops narrating, and the hole in the log is found when the report is
written.

**§8 is HALF done, and it is the half this work created.** Engines re-emit
final results, and an auto-filing loop turns that into duplicates in the
evidence log: an in-flight lock plus a six-second same-command window, with a
failed POST clearing the guard so a genuine retry is not mistaken for a
duplicate. **The offline/retry half is NOT built** and needs a server-side
event key.

> **SUPERSEDED — corrected by Unit 26's reconciliation, 2026-08-21.** The
> sentence above was true of #177/#178 and is now stale: **#182 (`c333d3f`)
> finished both halves.** `activity_voice_event` is in `schema.sql`, guarded
> through `missingTables()`, named in `EXPECTED_TABLES` and swept by
> `DEMO_SWEEP`; the page holds an in-memory queue and says *"No connection —
> held on this phone and it will send itself"*; `event_id` is named once and
> kept across every retry, so a second arrival returns the entry that already
> exists. `SURVEILLANCE-VOICE.md:452` records it complete. The one stated limit
> is that the held queue does not survive the page being closed — a
> data-boundary decision nobody has taken, recorded rather than discovered.
> Left in place with this note rather than rewritten: a unit report is a record
> of what was true when it was written.

**How it is tested without a microphone:** the ENGINE is stubbed and everything
else is real — the real registry, the real activity API, the real database. The
stub supplies only what a machine in a data centre cannot: what was heard.

## 🚦 DEPLOYMENT — 2026-08-18, master `8461897` (#177, #178)

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `8461897` | `8461897` | **DEPLOYED** — `deploy.yml` success |
| Worker / API | `8461897` | `1ca9a97` | **DEPLOYED** — `worker.js` untouched by #178, so `deploy-portal.yml` correctly did not run |
| D1 schema | `8461897` | applied | unchanged — **no dispatch owed** |

Save point `save/2026-08-18-1825-8461897`. Suites: portal **1568/0**, worker **1779/0**, deploy guard **68/0**.

**LIVE VERIFIED — OPEN**, two device checks: on the phone, log something and
correct it from the field home (§10); on the desktop, open Timestamp Video,
switch the picker to All Files, choose a PDF and expect *"Video files only"* —
then choose a real `.mov` and expect it to go through.

## 🎙 VOICE §10 SHIPPED (#177) — and two defects it uncovered

Edit and Remove on the field home's Last activity card, correcting the newest
entry **in place**. A removed one is struck through with Put it back. Voice
entries carry a 🎙 VOICE tag — §3's marker finally visible where the work is.

**Two defects fell out of building it. Both are the interesting part:**

1. **`editActivity` was REPLACE-ALL.** It had been since it was written, and
   nothing noticed because the timeline's Edit form was its only caller and
   always posts all four fields. A screen that corrects *only the wording*
   would have written NULL over the location, vehicle and internal note the
   investigator recorded — and returned success. It now follows the rule
   `/cases/:no/meta` already states: **absent means unchanged, blank still
   clears**, resolved INSIDE the UPDATE from the row so two people correcting
   different fields cannot lose each other's work.
2. **`svDeleteEntry` forced `SV.tab = "timeline"`.** Harmless while Delete
   existed only ON the timeline; from the Last activity card it navigated the
   investigator away from the one screen §10 requires them to stay on.

**A lesson worth keeping:** the first removal assertion **passed while standing
on the timeline**, because the timeline shows the same *"not in the report"*
wording — which is exactly how the unwanted jump hid. "Without navigating away"
has to be asserted as a SCREEN, not as a message.

## 🎬 VIDEO TIMESTAMP — a non-video file is refused where it is chosen (#178)

Owner: desktop must reject a non-video file immediately with *"Video files
only"*. It does, before an object URL is made.

**The restraint is the design.** `VIDEO-TIMESTAMP.md` records that identical
decodable `.mov` bytes arrive as `video/quicktime`, as
`application/octet-stream`, or **with no type at all** — so a rule refusing an
empty or octet-stream type would reject the exact iPhone file the feature
exists for. Only a type that positively says image, audio, text or document is
turned away; everything undecided reaches the **decode probe**, which is the
real arbiter. The picker still asks for `video/*` first, and there is a test
for both halves.

**A test-quality note, not a page defect.** Adding that section made an existing
preview assertion fail every run. A DOM diagnostic at the same instant showed
the element present and correct — `count=1`, `previewFailed=false`,
`<video class="vst-prev">` in the DOM. The page was never wrong; the assertion
read its locator count at a moment it could not rely on, and the new section
shifted the timing enough to expose it. It now samples once and prints what it
saw. **No root cause is claimed beyond that.**

## 🚦 DEPLOYMENT — 2026-08-18, master `1ca9a97` (#176) — voice §3, source on the activity

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `1ca9a97` | `1ca9a97` | **DEPLOYED** — `deploy.yml` success |
| Worker / API | `1ca9a97` | `1ca9a97` | **DEPLOYED** — `deploy-portal.yml` success |
| D1 schema | `1ca9a97` | **applied** | ✅ `portal-setup.yml` run 32159377362, live `/health` returned `missing_tables: []` |

Save point `save/2026-08-18-1615-1ca9a97`. Suites: worker **1770/0**, portal **1544/0**, deploy guard **68/0**.

**LIVE VERIFIED — OPEN.** Speech recognition only exists in a real browser.
What closes it: saying *"Mobile, vehicle observed"* into Active Surveillance on
the phone, seeing the standard sentence offered, pressing Use, and the entry
landing in the timeline like any other.

## 🎙 VOICE §3 SHIPPED 2026-08-18 (#176) — and the aliases the owner supplied

**`VEHICLE_OBSERVED` was answered:** *"vehicle observed"* and *"vehicle
sighting"*, and **bare "observed" is deliberately still mapped to nothing** —
which is exactly why it had no alias before, since it would file *"subject
observed"* as a vehicle sighting. Both halves are asserted.

**`activity_source` is a companion table**, on the owner's instruction —
*"an idempotent companion metadata table instead of altering the existing
activity_log table"* — and because `schema.sql` is re-applied on every
portal-setup run, which `ALTER TABLE ADD COLUMN` cannot survive.

Four things hold it:

- **The entry is written FIRST, the marker second.** A database without the
  dispatch, or any failure recording the marker, costs the marker and never the
  investigator's words.
- **The workspace join is guarded** through `missingTables()` — between a merge
  and the manual dispatch the table does not exist, and the workspace is the
  most-used screen in the portal.
- **`source` is a closed list matching the column's CHECK**, so an unknown value
  is dropped rather than stored. It marks how an entry was CAPTURED, survives an
  edit, and grants no privilege: §11/§12 hold, and edit and remove are identical.
- **`heard` is diagnostic only.** §5 permits keeping the transcript; it never
  replaces the standard text and is deliberately **out of the workspace
  payload** — a test fails if it appears there.

**Next:** §1 the compact mobile status header (mobile-first, testable at phone
widths) and §10 LAST ACTIVITY, then §2's wake-word loop — which needs a real
microphone and will land LIVE VERIFIED OPEN.

## 🚦 DEPLOYMENT — 2026-08-18, master `896e6d5` (#175) — voice command registry

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `896e6d5` | `896e6d5` | **DEPLOYED** — `deploy.yml` success |
| Worker / API | `896e6d5` | `bfa426c` | **DEPLOYED** — `worker.js` untouched, so `deploy-portal.yml` correctly did not run |
| D1 schema | `896e6d5` | unchanged | **no dispatch owed** |

Save point `save/2026-08-18-0733-896e6d5`. Suites: portal **1542/0**, worker
**1752/0**, deploy guard **68/0**.

**LIVE VERIFIED — OPEN.** Speech recognition only exists in a real browser, so
what closes it is saying *"Mobile, no change at residence"* into Active
Surveillance on the phone and seeing the standardized sentence offered for
review.

## 🎙 VOICE COMMAND MODE — FIRST SLICE SHIPPED 2026-08-18 (#175)

`SURVEILLANCE-VOICE.md` was a full spec with **nothing built** — what existed
was the dictation half (speech → transcript → review → Use / Discard). This is
§4 the centralized registry, §5 standardized activity text, §7 never guess: the
slice everything else stands on.

**One table and one matcher**, and a test fails if a second one appears. A
recognized phrase offers the standard sentence with what was heard above it; an
ambiguous one lists candidates and asks; an unrecognized one behaves exactly as
before. Longest alias wins, so *"no change at residence"* is not filed as the
shorter *"no change"*, and a true tie is reported rather than settled by table
order.

**Nothing auto-submits — unchanged, and worth keeping that way.** §6B and §7
both require a human to confirm, and the existing review IS that confirmation.

**The truncated aliases were not inferred.** `VEHICLE_OBSERVED` is a canonical
command with **no alias at all**, because its only fragment is the bare word
"observed" and registering that would file "subject observed" as a vehicle
sighting. Nineteen of the twenty-one standard sentences are the
implementation's wording, all in one table, all trivially rewordable — the
owner's to change.

**Next slice, and the decision it needs first:** §3 `source = voice`.
`activity_log` has no `source` column and `ALTER TABLE ADD COLUMN` is not
idempotent here, so it wants a **companion table** and a `portal-setup`
dispatch. Then §2's wake-word loop and §1's compact header. The full order is in
`SURVEILLANCE-VOICE.md` under BUILD STATUS.

## 🚦 DEPLOYMENT — 2026-08-18, master `bfa426c` (#174) — Dropbox storage, report PDF, video save

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `bfa426c` | `bfa426c` | **DEPLOYED** — `deploy.yml` success |
| Worker / API | `bfa426c` | `bfa426c` | **DEPLOYED** — `deploy-portal.yml` success |
| D1 schema | `bfa426c` | unchanged | **no dispatch owed** — neither part adds a table or a column |

Save point `save/2026-08-18-0716-bfa426c`. Suites: worker **1752/0**, portal
**1526/0**, deploy guard **68/0**.

**LIVE VERIFIED — OPEN.** The proxy denies the live domain from this container,
and the PDF writer and the video upload session both only ever run in a real
browser against a real Dropbox. What closes it, on the device: a photo appears
under `Photos/`, **Download PDF** opens in a reader, **Save PDF to Dropbox**
lands in `Reports/`, and a timestamped copy lands in `Video/`.

## 📦 NEW CASE FILES LIVE IN DROPBOX — SHIPPED 2026-08-18 (#174)

Owner: *"Use connected Dropbox App Folder as storage for NEW case photos and
generated reports/PDFs"*, with `Photos` / `Reports` / `Video` per case; do not
migrate or delete old R2 files; keep D1 for structured case data; refuse rather
than fall back if Dropbox is unavailable.

Two owner decisions were taken by question before building, and both narrowed
the work: **`Video/` is created but the ordinary upload still refuses video**
(the device-first decision of 2026-08-17 stands), and **an unreachable Dropbox
refuses the upload** rather than falling back to R2 or double-writing.

The detail is in `DROPBOX.md`. The parts that will bite whoever touches this
next:

- **No companion table.** `case_evidence.r2_key` already means "where the bytes
  are", so a Dropbox row records `dropbox:<path>` and the prefix is the whole
  discriminator. A table would have needed a `portal-setup` dispatch standing
  between the merge and a working upload.
- **The stored filename carries a random token.** Delete a photo and upload one
  of the same name and Dropbox has no conflict to autorename around — the path
  would repeat and `r2_key`'s UNIQUE constraint would reject the row.
- **The R2 meter counts only Cloudflare now.** Otherwise photographs that never
  touched Cloudflare would drive the storage card toward a cap they cannot
  reach and eventually refuse uploads for space nothing was using.
- **`serveEvidence` is still the only place bytes leave**, and it proxies. Do
  not add a Dropbox share link: it would work for anyone holding it with none
  of the case's permission checks in front.

**The final report is a real PDF** (#174 too), written by the page from the
rendered `#pkgdoc` with no library — base-14 fonts and JPEG images need no
embedding and no compression. Built from the RENDERED document rather than the
data behind it, because that document is already the one place deciding what a
client may see; a second renderer would disagree eventually and the wrong one
would be the one posted. Filed by `POST /build/:id/report-pdf` into `Reports/`,
**not** as case evidence, audited as a `build_events` row.

**A generated timestamped copy can optionally go to `Video/`**, in parts through
a Dropbox upload session. Nothing uploads by itself, the original is never
touched or sent, and the ordinary evidence upload still refuses video by name.
Cancel needs nothing torn down — nothing exists at the destination until
`finish` is called. `video_stamp.dropbox_path` was reserved when that table was
written and had never been filled.

## 🚦 DEPLOYMENT — 2026-08-18, master `c00be24` (#173) — Dropbox callback fix

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `c00be24` | `c00be24` | **DEPLOYED** — `deploy.yml` success |
| Worker / API `api-case-portal` | `c00be24` | `c00be24` | **DEPLOYED** — `deploy-portal.yml` success, tests ran in CI first |
| D1 schema | `c00be24` | applied | unchanged — **no dispatch owed** |

Save point `save/2026-08-18-0600-c00be24`. Suites: worker **1681/0**, deploy
guard **68/0**.

**LIVE VERIFIED — OPEN**, on the owner's own instruction: *"Stop for my live
connect test."* It closes when a real browser completes the round trip.

## 🐞 "NOT SIGNED IN" ON THE DROPBOX RETURN — fixed 2026-08-18 (#173)

Owner, live: *"Live Dropbox callback reaches the site but returns 'Not signed
in' while admin is signed into Case Portal in the same browser."*

**`sessionCookie` is `SameSite=Strict`, and a browser does not attach a Strict
cookie to a request that ANOTHER site navigated to.** Dropbox sending the
operator back is exactly that, so `currentUser` saw no cookie and the signed-in
gate refused the request before the route ran. `/dropbox/connect` worked
throughout because an address-bar navigation has no initiating site — the
outbound leg was fine and only the return leg could not carry the session.

The other two suspects were clean and are worth recording as ruled out: the
state cookie was already `SameSite=Lax`, `Secure`, `HttpOnly`, scoped to
`/portal-api/dropbox`, and `originAllowed` passes because a cross-site GET
navigation sends no `Origin` header at all.

**The fix is NOT Lax on the session cookie.** That cookie is the portal's CSRF
defence for every route in the Worker — `originAllowed` calls itself defence in
depth *behind* it — and trading it site-wide for one OAuth return is a bad deal.
A test now asserts it is still Strict, so a later "simplification" fails.

**The callback carries its own credential instead.** The state cookie holds
`randomState . adminUserId . expiry . HMAC-SHA256` keyed on
`DROPBOX_APP_SECRET`; `/dropbox/connect` is the only minter and is still
admin-only, so the id in there is an admin's by construction. Dropbox is handed
the **random field alone**, so no staff id reaches its logs or the browser
history. The admin is **re-read from `users`** on the way through — demoted or
deactivated in between gets `unauthorised`, never a connection.

**The signature is what makes the id trustworthy.** HttpOnly stops a page
writing the cookie, but a sibling subdomain can set a `Domain=` cookie this
Worker cannot distinguish from its own. `DROPBOX_APP_SECRET` is the key because
HMAC never exposes its key, the flow cannot run without that secret anyway, and
it means no new secret to set and no "key is missing" branch to get wrong.

**The wrong reasoning is corrected in `DROPBOX.md`, not deleted.** It claimed a
state cookie without a session *"would let anyone holding the URL complete a
connection"*. That is false — the cookie is the half you cannot obtain — and it
is what put the gate there.

**Still not built, deliberately** (owner: *"Do not add Dropbox UI yet"*): there
is no Dropbox control anywhere in `portal/index.html`. A successful return lands
on `/portal/?dropbox=connected` and the page says nothing; the state is read
from `GET /portal-api/dropbox/status`. **If the Lax state cookie does not arrive
in a real browser the symptom is now `?dropbox=state`**, which is diagnostic
rather than the old wall.

## 🚦 DEPLOYMENT — 2026-08-18, master `8301f8c` (#172) — Dropbox OAuth

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` | `8301f8c` | `8301f8c` | **DEPLOYED** — `deploy.yml` success |
| Worker / API `api-case-portal` | `8301f8c` | `8301f8c` | **DEPLOYED** — `deploy-portal.yml` success |
| D1 schema | `8301f8c` | applied | ✅ **DONE** — `portal-setup.yml` run 32103267542, live `/health` returned `missing_tables: []` |

Save point `save/2026-08-18-0513-8301f8c`. Suites at merge: worker **1663/0**,
deploy guard **68/0**.

**LIVE VERIFIED — OPEN, and it cannot be closed from a container.** The agent
proxy denies `alwayspreciseinvestigations.net:443` outright (CONNECT → 403), so
nothing here can reach the live domain; DEPLOYED rests on both workflows being
green at `8301f8c`, which is a different claim and is stated as one.

## 🔗 DROPBOX OAUTH — SHIPPED 2026-08-18 (#172), CONNECT AND CALLBACK ONLY

**No file migration, deliberately.** There is no upload, download, list, move or
delete route against Dropbox in this unit, and nothing reads or writes a file
there. The owner's instruction was explicit — *"Do not migrate files yet"* — and
a test asserts the absence rather than a comment claiming it.

### The two things the owner has to do

1. **Set the secrets on the Worker `api-case-portal`** (see `DROPBOX.md`):
   ```
   npx wrangler secret put DROPBOX_APP_KEY   --name api-case-portal
   npx wrangler secret put DROPBOX_APP_SECRET --name api-case-portal
   ```
   or dashboard → Workers & Pages → **api-case-portal** → Settings → Variables
   and Secrets → **Add**, type **Secret**.
2. **Dispatch `portal-setup.yml`** so `dropbox_auth` exists. Until then the
   write returns 503 naming that workflow and every read degrades — it does not
   crash, which is the `missingTables()` rule this repo already runs on.

### Live Redirect URI — paste this into the Dropbox App Console verbatim

```
https://alwayspreciseinvestigations.net/portal-api/dropbox/callback
```

It is not written down twice: `dropboxRedirectUri()` composes it from
`SITE_ORIGIN` + `API_PREFIX`, and `GET /dropbox/status` returns it, so the
value the office pastes is the value the route serves.

### What is stored, and what is refused

`dropbox_auth` is one row (`CHECK (id = 1)`) holding the **refresh token** and
the account identity that proved it. **The access token is never stored** — it
is minted per call from the refresh token and returns `null` rather than
throwing when it cannot be. `DROPBOX_REFRESH_TOKEN` in the environment wins
over the row, so the connection can be pinned by secret instead.

The callback **proves the token before storing it**: it calls
`/2/users/get_current_account`, and an exchange that yields a token which
cannot be used stores nothing and returns `dropbox=unverified`. Disconnect
**revokes at Dropbox first**, then deletes, and reports `revoked` honestly
rather than claiming a revocation that failed — the same rule as `sendMail`
reporting a failed send.

All four routes are **admin-only**; an investigator gets 403 from every one.
CSRF state is HttpOnly, Secure, `SameSite=Lax` (Lax because Dropbox returns via
a top-level GET), scoped to `Path=/portal-api/dropbox`, 10-minute `Max-Age`.

**The state cookie is read by splitting the header, not by a regex.** The first
version used one, an escape survived a heredoc as a literal backslash, and
*every* callback failed with `dropbox=state` while the suite stayed green —
found by a 30-second targeted probe, not by the tests. Splitting has nothing to
escape.

## 🚦 RECONCILED 2026-08-17 — master `dff3f82`, and what the ledger had missed

**This file recorded none of #139–#143 and its matrix was stale at `f5a4155`
while master had moved eight merges past it.** That is the failure this file
exists to prevent, in the direction that reads as "nothing has happened".
Corrected below, measured rather than inherited.

### Shipped since the matrix was last written

| PR | Merge SHA | What |
| --- | --- | --- |
| #139 | `719097a` | No fabricated cases in the portal; the `TEST-` sweep leaves nothing behind |
| #140 | `37ba300` | The navigation rail is grouped, and Reports & Packages has a door |
| #141 | `419a6ff` | The dashboard leads with two named bands; a card can no longer widen the page |
| #142 | `c60542b` | Today / next actions, and Recently completed, both off reads that already existed |
| #143 | `dff3f82` | The rate-sheet send area names what the email can carry (PAYMENTS.md §2, §14) |

### Deployment matrix — 2026-08-17

| Component | Master SHA | Deployed SHA | Status | How |
| --- | --- | --- | --- | --- |
| Public site + `/portal/` page | `dff3f82` | `dff3f82` | **DEPLOYED** | `Deploy site to Cloudflare Pages` **success at `dff3f826`** (run 31998260840, 2026-08-17T05:32:38Z) — the merge commit itself, not an ancestor |
| Worker / API | `dff3f82` | unchanged | **DEPLOYED** | `worker.js` untouched since `c8c2e9e`; #143 is page-only |
| D1 schema | `dff3f82` | applied | unchanged | `schema.sql` untouched by #139–#143. **No portal-setup dispatch is owed** |

**⚠️ LIVE VERIFIED IS NOT REACHABLE FROM THIS CONTAINER, and that is new.**
The remote execution environment's egress proxy **blocks
`alwayspreciseinvestigations.net`** — `curl` gets `CONNECT tunnel failed,
response 403` and WebFetch gets `EGRESS_BLOCKED`. Earlier sessions in this
ledger reached `/.well-known/build.txt` directly; this one cannot. So the last
state honestly claimable from here is **DEPLOYED** (workflow green at the exact
SHA), and every LIVE VERIFIED row above this line was written when the network
allowed it. **Do not upgrade a row to LIVE VERIFIED from a green workflow** —
that is provenance, and the four-day site freeze happened with every workflow
green. Live verification needs a browser on the owner's side, or an
environment whose policy permits the domain.

### Suites at `dff3f82` — run here, not inherited

| Suite | Result | Ledger previously said |
| --- | --- | --- |
| `portal/test-portal.mjs` | **1110 passed, 0 failed** | 806 |
| `case-portal/test-worker.mjs` | **1538 passed, 0 failed** | 1033 |
| `.github/test-deploy.mjs` | **68 passed, 0 failed** | 68 |
| `intake/test-intake.mjs` | 205 (unchanged; not re-run — no file it covers moved) | 205 |
| `visitor-alerts/test-worker.mjs` | 47 (unchanged; not re-run — same reason) | 47 |

## 🔍 FIVE-ITEM AUDIT, 2026-08-17 — the owner's queue against master `c60542b`

Audited **before** building, because the ledger has been wrong in both
directions. Two of the five were already shipped and would have been rebuilt.

| # | Item | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Lead-card **Send Payment Options** | **SHIPPED** | `data-act="leadPayOpen"` `portal/index.html:2056-2058`, gated `${claim ? "" : …}` so an insurance card never shows it. Route `POST /payment-options/email`. E2E `test-portal.mjs:1550-1566` asserts a private and an insurance card **side by side on one desk**: one offers it, the other does not |
| 2 | **Standalone Payment Options dialog** | **SHIPPED** | `PAY_SEND` `:790`, rendered `:1228`, `paySendHtml()` `:2461`. Two screens, ask then preview. `test-portal.mjs:1751` proves it opens with no case number |
| 3 | **NEXT STEP helper block** | **was MISSING → SHIPPED #143** | see above |
| 4 | **Retainer Pending intake/card actions** | **PARTIAL** — the ledger was right | §10 wants it on the **Leads & Intakes card**; `Retainer pending` and `Record payment` exist only on the case Overview panel (`:3724`, `:3779`) |
| 5 | **Real intake alerts / archive** | **PARTIAL, and one half is worse than the ledger said** | see the two findings below |

### Item 4 — what it needs, and what it does NOT need

The condition §10 names is already expressible: **`intake_received` is one of
the nine `LEAD_STATUSES`** (`worker.js:1978`), so "the private intake has been
returned" needs no new column and no schema change.

What is missing is data on the **case-list row**, which is what the card draws
from. `listSubmissions` (`worker.js:1902-1913`) already carries `send_count`
and `last_sent_at` as subqueries; the same shape gives it `case_retainer.received`
and the latest `payment_send`. **`redactRow` (`:1842-1846`) already destructures
`send_count`/`last_sent_at` out for investigators — any new field must join
them there**, because retainer state is the client's commercial position.

`[Resend]` needs no new route: it is `leadPayOpen` again. **Record payment must
not become a second writer** — `openCase()` + `RET_FORM` reaches the one that
exists (`retOpen` / `retainerFormHtml` / `RET_*`), the way `ovRecordPaymentHtml`
already did for Overview.

## ✅ OVERNIGHT RUN, 2026-08-17 — queue items A, B, C and part of D

| PR | Merge SHA | Item | State |
| --- | --- | --- | --- |
| #143 | `dff3f82` | **A.** NEXT STEP helper block (PAYMENTS.md §2, §14) | **DEPLOYED** |
| #144 | `610783a` | Ledger reconciliation + the five-item audit | **DEPLOYED** |
| #145 | `2e73511` | **C.** Retainer pending on the lead card (§10) | **DEPLOYED** |
| #146 | see below | **D (part).** A `TEST-` case can never alert | **DEPLOYED** |

**B — LEAD/INTAKE PAYMENT OPTIONS SURFACES: audited, already SHIPPED, no code
written.** Both surfaces exist and were verified against every approved rule the
owner restated: private-client only (`leadPayOpen` is gated on the card and
`CONTEXT_TAKES_PAYMENT` is the server-side boundary); the Cash App and Venmo
handles and URLs in `PAY_METHODS` (`worker.js:602-609`) match what the owner
listed **exactly**, are stored as separate display/URL values with no derivation
anywhere, and are overridable from Settings by a `payment_methods` row; sending
instructions never marks the retainer received (`payment_send` and
`retainer_payment` are separate tables); insurance is refused payment by name at
`worker.js:1131`; and `RETAINER_METHOD_OPTIONS` is already **exactly** the five
approved methods — Cash App, Venmo, Check, Cash, ACH / BILL — with no Credit
Card and no Other, so "remain" was accurate and nothing needed changing.

**D is only PARTLY done and the rest is genuinely blocked** — see the audit
findings below, which are unchanged except for the `TEST-` defect now fixed.

## 🔴 DEFECTS FOUND BY THE AUDIT

### 1. A `TEST-` intake sends a REAL email — ✅ **FIXED, PR #146**

**Fixed 2026-08-17.** One guard at the single chokepoint in `notifyAdmins`,
matched case-insensitively so its reach equals SQLite's LIKE in `DEMO_LIKE` —
nothing `/demo-case/clear` would sweep can have emailed the office first. Eleven
assertions, run with a real provider key and a real subscribed recipient, with
**a control at each end** so a silent run cannot be mistaken for a working one.
The description of the defect is kept below because the reasoning still governs.

### The defect as it was found

`INTAKE-OPS.md:26-27` says in terms: *"A test intake producing a real email or
SMS is the failure this feature is most likely to have, so it is what the tests
must prove cannot happen."* It happens. Proven by probe against the real Worker
and real SQLite: `POST /ingest` with `case_no: TEST-20260817-9999` returned 200
**and sent**; a high-priority task on a `/demo-case` row sent too.

`notifyAdmins` (`worker.js:2395-2425`) has **no prefix or origin check at all**.
`createDemoCase` happens not to call it — that is an omission, not a guard, and
it does not survive the demo case being *worked*. The browser suites are safe
only by harness accident: `intake/test-intake.mjs:105` intercepts the ingest
route, and `portal/test-portal.mjs` sets no `RESEND_API_KEY` so `worker.js:2398`
short-circuits. **No test asserts a test intake produces no send**, and the
`/demo-case` tests never stub Resend.

**This was the smallest genuinely-missing unblocked sub-unit in item 5**: one
guard at the single chokepoint, using `TEST-` — the prefix this codebase already
treats as its safety mechanism (`DEMO_LIKE`). No schema, no CHECK, no provider,
no owner decision, no missing spec. **Done in #146.**

### 2. The Rate sheets view overflows a 390px screen by 23px

`SPAN.rs-v` in the fee box, `scrollWidth: 413`. **Proven pre-existing** on
unmodified master at `c60542b` by stashing #143's page change and re-measuring,
so #143 neither caused it nor hid it — #143's own 390px assertion is scoped to
the send area for exactly that reason. `.rs-row` is a flex row with
`.rs-l{flex:1}` (so `min-width:auto`) beside `.rs-v{white-space:nowrap}`; a
`@media(max-width:640px)` hook for this component already exists at
`portal/index.html:228`. Its own small unit.

## ✅ PORTAL CORRECTNESS QUEUE, 2026-08-17 — Units 1–3, all merged and deployed

| PR | Merge SHA | Unit | State |
| --- | --- | --- | --- |
| #147 | `f9841ed` | The owner's three alert/archive decisions | **DEPLOYED** |
| #148 | `117bd59` | **1.** The Cases lens belongs to the Cases table | **DEPLOYED** |
| #149 | `175a92c` | **2.** The fee box fits a 390px phone | **DEPLOYED** |
| #150 | `99121a2` | **3.** Edit case is a 44px target | **DEPLOYED** (attempt 2) |

**Every one of the three carries a test proven against the old code** — stashed
the fix, re-ran, watched the new assertions fail with the reported symptom, then
restored. Unit 1 failed 4, Unit 2 failed reporting `{"sw":413,"wide":["SPAN.rs-v"]}`
verbatim, Unit 3 failed reporting 37px. A test that passes both ways proves
nothing, and this file has been burned by one before.

**Suites at `99121a2`:** portal **1158/0** (1130 at the start of the cycle),
worker **1556/0**, deploy **68/0**. No schema changed, so **no `portal-setup`
dispatch is owed**.

**#150's first deploy attempt failed and it was not the code.** GitHub returned
**429 Too Many Requests** downloading `cloudflare/wrangler-action` from codeload,
three times, before the job ever reached the repository. Re-running the failed
job succeeded at the same SHA. Worth knowing: a red `deploy.yml` is not always a
red tree — read the log before assuming a revert, and `rerun_failed_jobs` is the
first thing to try when the error is in the action-download step.

**LIVE VERIFIED is still open on all three**, for the reason recorded above: this
container's egress proxy blocks the live domain outright.

## ✅ FIXED — `/packages` now hides archived and deleted cases (#152, `9d92133`)

**DEPLOYED 2026-08-17.** Site, Worker and Save point all green at `9d92133d` on
the first attempt. Suites: worker **1567/0** (1556 before), portal **1158/0**,
deploy **68/0**. No schema change, so no `portal-setup` dispatch was owed.

One `hiddenCases()` call and one filter in `casePackages`, placed **above** the
per-case loop so a hidden case also stops costing the seven queries below it. No
`NOT IN` written into the query — that would be the second copy of the rule.
Archive semantics, package business logic and the reads that already had the
boundary are all untouched.

**Proven against the old code:** three assertions fail with the change stashed,
reporting all three cases still present. The test carries a live case beside the
hidden ones at every step, so a filter that removed everything could not satisfy
the negative half, and it ends by writing an activity entry on the restored case
to show that what archiving MEANS did not move.

### The finding, as it was recorded

Uncovered by the Unit 1 test: on the dashboard, the **Case packages** band listed
an archived case, with its retainer and balance on it.

It is **not** the Cases lens. That band reads `/packages` from the Worker, which
does not filter through `hiddenCases()` the way `caseSummary`, `outNow` and the
calendar do — so an archived case shows there whatever the lens has ever been.
`nextActionRows` also reads `PKGS` for its `retainer` and `build` sets, so the
same route can push an archived case into Today / next actions by a second path
that has nothing to do with which tab anyone was on.

The Unit 1 assertions are scoped to Today / next actions and Needs attention for
exactly this reason, with the scope written into the test as a comment rather
than left as a silent gap.

**Audited 2026-08-17 and it is fully specified by rules already in force** — no
owner decision is needed. `GET /packages` → `casePackages(env)` (`worker.js:6242`)
is the only case-scoped read in that family that does **not** filter through
`hiddenCases()`; `caseSummary` (`:1576`), the completed desk (`:5116`) and the
calendar (`:7315`) all do. The rule those three implement is this file's own —
*"Out of the views and out of the work go together"* — so making the fourth
match is consistency, not a new decision.

Reports & Packages reads the same route, and that is the point rather than a
complication: an archived case should leave that desk too, exactly as it leaves
Out now, the alerts and the calendar. It comes back under the Archived lens,
which is where an archived case is supposed to be found.

**Done in #152.** One correction the audit produced and the ledger should keep:
the dashboard's *package* read was never already filtered — the dashboard's
**alerts** were. The band reads `/packages`, which was exactly the unfiltered
route, and that is why #148's dashboard assertions were scoped to Today / next
actions and Needs attention rather than to the whole page.

### ✅ DONE — the case header's status chip is a 44px target (#154, `a8dd297`)

**DEPLOYED 2026-08-17**, site and Save point green at `a8dd297b` first attempt.
Suites: portal **1168/0** (1158 before), worker **1567/0**, deploy **68/0**.

Measured on master: **56×24** — the width was already fine and only the height
was short, by 20px. The judgement this unit was held back for went this way:
**the target and the pill are separated.** `.ch-status` is a transparent box
that owns the 44px and carries the `data-act`; the `.tag` inside is pixel-
identical to before. Padding the chip out would have painted a pill nearly twice
its proper depth in the corner of the screen meant to be scanned rather than
pressed.

**An overlay was considered and rejected on inspection.** `.ch-right` is a
column with a 6px gap, so a `::after` stretched 10px each way would have reached
into the Edit case button's own target and stolen its taps — a fix that quietly
breaks the control directly below it. Worth remembering the next time a small
control needs a bigger target in a tight column: check the neighbours first.

Also moved `cursor:pointer` from `.ch-right .tag` to `.ch-status`. An
investigator's header renders the same chip with **no `data-act`**, and the old
rule gave that one a pointer too — an affordance on something that is not a
control.

The test asserts both halves and would catch either regression: the target is
≥44 in both directions at 390px and 1200px, **and** the painted pill is still
24px inside it, with type size and radius compared against a live `.tag` rather
than a hard-coded number.

### ✅ DONE — one evidence viewer (#156, `e42fec0`)

**DEPLOYED 2026-08-17**, site and Save point green at `e42fec0f`. Suites: portal
**1190/0** (1168 before), worker **1567/0**, deploy **68/0**.

Six surfaces, one root cause, one viewer. `evViewerHtml()` draws into `#evview`,
a **sibling of the app root** — which is what makes "close and you are back
exactly where you were" structural rather than something the close handler
rebuilds: the screen underneath is never re-rendered. `paintEvView()` runs at the
top of `paint()`, **before its early returns**, so the office screens, the case
workspace and the field view all reach it.

**Nothing is copied.** The `<img src>` IS the original evidence route, so the
Worker's permission check is the one it always was — asserted from both ends.

Three decisions worth keeping, because each is a trap the next person can walk
into:

- **`object-fit:contain` with max width AND height.** `cover` crops; a bare
  `max-width` lets a tall photo run off the bottom.
- **NOT a click-to-dismiss backdrop.** The delegated listener matches the nearest
  ancestor carrying `data-act`, so tapping the photo would have closed the viewer
  the user had just opened.
- **The structural assertions read the SOURCE and search for the route**, rather
  than listing six line numbers — that is the only shape that catches a seventh
  call site written later.

**The `3ca5d13` save-point failure resolved itself.** GitHub's Releases API was
returning 503; three attempts failed and were recorded rather than looped on, and
the next merge's save point (`save/2026-08-17-1807-e42fec0`) went through
normally and covers that commit too. Nothing was lost. Worth remembering: a
failed save point is not an emergency while master is pushed — GitHub IS the
off-site copy, and the tag is a convenience on top of it.

### ✅ DONE — PORTAL-OPS Phase 8, recently viewed + pinned (#158, `f8b510e`)

**DEPLOYED 2026-08-17**, site and Save point green at `f8b510ea`. Suites: portal
**1213/0** (1190 before), worker **1567/0**, deploy **68/0**.

**⚠️ THE NAME COLLISION, because it will catch the next reader too.** `favLines`
and `favToggle` in the page are commented **"(P8)"** but are NOT this feature:
they star the canned **activity phrases** in the field entry sheet, hold no case
data, and are keyed per username in localStorage. They were left exactly as they
are. The case lists are `apiRecentCases` / `apiFavCases` and are separate; a test
asserts both stores still exist independently, so nobody "unifies" them.

**Owner decision, 2026-08-17, and it governs:** recently viewed AND pinned both
clear on sign-out. *"This is a shared-office portal… do not leave the previous
user's favorited cases visible to the next signed-in person."* If per-user
server-side preferences are built later, favourites may persist **for that
user** — that is a different feature and was explicitly not to be built now.

**The access model is the part worth keeping.** The strip renders only from
`CASES`, the authorized list the Worker already returned, so **a stored
identifier is not a key**: a case the signed-in user cannot see, one that does
not exist, an archived one and a deleted one all draw nothing. There is no
lookup to refuse because there is no lookup — the stored list can only ever
narrow what is already on screen, never widen it. All four are tested by
planting identifiers straight into storage.

`sessionStorage` with **no username in the key**, deliberately: a username-keyed
localStorage entry is a promise to restore that person's list later, which is
the thing the decision rules out.

Recently viewed is written in `openCase` **after both reads return**, so it means
a case the user was actually allowed to open; a refusal leaves no trace. Pinning
is explicit and the star is its only writer.

**One existing assertion was tightened rather than worked around.** An
investigator's header was asserted to hold *no buttons at all*, as a proxy for
"no Edit case" written when Edit case was the only one. The pin belongs to both
roles, so the assertion now tests Edit case **by name** and adds a second check
that no route to the edit panel exists either — stronger than the count it
replaced. Worth remembering as a pattern: when a proxy assertion blocks a
legitimate change, sharpen the assertion to its stated intent rather than
weakening it or routing around it.

## 🎨 VISUAL PHASE 1 — SHIPPED (#160, `605d6de`)

**DEPLOYED 2026-08-17**, site and Save point green at `605d6dee`. Suites: portal
**1227/0** (1213 before), worker **1567/0**, intake **205/0**, deploy **68/0**.

**Audited by screenshotting the real page** against the real Worker at 1280 and
390 before editing — that is the method this phase should keep using, because
none of what it found is visible from the source.

What it found and what changed:

| Found | Changed |
| --- | --- |
| Eight identical bordered boxes, **six of them zero**, all the same weight | a zero is drawn grey against navy — still shown, just no longer competing |
| Needs attention and Current work visually indistinguishable | Current work is one hairline-divided read-out with smaller figures |
| **Two filled teal buttons** competing down the page | the read-out band's action is an outline; the alert strip keeps the filled one |
| The work queue was the quietest thing on the page | `queuecard` gives it the one emphatic surface; `quietcard` makes Recently completed reference |
| Phone header taking **~290px of 844** across three rows | **64px**, one row, Sign out still a 44px target |

**The rule this phase must not break, and there is a test for it:** a zero
recedes but is **never removed**, and nothing is hidden with `display:none` to
make a section look smaller. Shrinking a section by deleting its words is not
shrinking it, and an absent zero is a different claim from a zero.

## 🚦 DEPLOYMENT — 2026-08-18, master `7aa9111` (#169)

| Component | Master SHA | Deployed SHA | Status |
| --- | --- | --- | --- |
| Public site + `/portal/` page | `7aa9111` | `7aa9111` | **DEPLOYED** — success at `7aa9111e` |
| Worker / API | `7aa9111` | `8a48d7d` | **DEPLOYED** — `worker.js` untouched since #166 |
| D1 schema | `7aa9111` | applied | unchanged — no dispatch owed |

**LIVE VERIFIED is the owner's iPhone for this unit.** Open Timestamp Video,
choose `IMG_0440.mov`, press **What can this device do?** — the read-out now
answers whether the decoder accepts that file's real configuration, which is the
gate on the whole pipeline.

## ⏸️ WAITING ON: the iPhone read-out, then two CSP decisions

Nothing further should be built until the device says whether
`VideoDecoder.isConfigSupported()` accepts `IMG_0440.mov`'s configuration. If it
declines, that is the owner's own STOP condition and no muxer would have helped.
If it accepts, the CSP questions above are decided before anything is installed.

## 🚦 DEPLOYMENT — 2026-08-18, master `ccd3ba5` (#171)

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` + `/portal/vendor/` | `ccd3ba5` | `ccd3ba5` | **DEPLOYED** — success at `ccd3ba50` |
| Worker / API | `ccd3ba5` | `8a48d7d` | **DEPLOYED** — `worker.js` untouched since #166 |
| D1 schema | `ccd3ba5` | applied | unchanged — no dispatch owed |

**iOS LIVE VERIFIED — OPEN.** This container has no WebCodecs, so the pipeline
has still never executed here. It closes when the owner's device selects
`IMG_0440.mov`, generates, and **plays the result back**.

## 🐞 THE GATE ASKED THE WRONG QUESTION — fixed 2026-08-18

**Also: the preview is optional, never a gate** (owner: *"Do not require
preview. Generate MP4, then offer Share or Save."*). The copy is finished before
the player element exists, so a device that will not play it back inside the page
gets a sentence instead — *"The copy is made… which says nothing about the
file"* — and the Save and Share actions are untouched. Where the copy does play,
checking the clock is offered and stated as **not required**. The action names
what the platform will do: *Share or save to this device* where the share sheet
exists.

The `onerror` is wired in `paintVStamp()` rather than as an inline attribute,
the way everything else on this page is wired.


**Owner:** *"WebCodecs pipeline says YES but old media-element compatibility gate
still blocks generation."*

**One condition.** The screen gated on `readable` — whether a `<video>` element
could decode the file — a check that predates the pipeline. On the owner's iPhone
the media element says NO and WebCodecs says YES, so **the one device the
pipeline was built for was the one it refused.**

`vstPath()` is the single decider now — `pipeline` / `legacy` / `checking` /
`none` — and the Generate button, `vstGenerate` and the Compatibility line all
read it. **Three consumers, one answer**, which is what stops the screen and the
generator disagreeing again. An outstanding check disables the action rather than
removing it; only "no route at all" blocks.

**The media element's verdict is informational now**, exactly as the owner asked:
it still appears, saying the ordinary player could not open the file but the
codec can, so generation is unaffected. A genuine refusal names WHICH route
failed — no WebCodecs, or a decoder that declined this file's configuration.

## 🎬 THE WEBCODECS PIPELINE — SHIPPED 2026-08-18 (#170, `463b6c5`)

**The device passed the gate on the real file:** H.264 `avc1.640028`,
1920x1080, ~48.12 s, AAC mono 44100 — WebCodecs decode **accepts that exact
configuration**, H.264 encode available, while the media element will not decode
the file at all. So the pipeline was built.

```
local file -> demux (this repo) -> VideoDecoder -> frame
           -> canvas draw + burn -> VideoEncoder (H.264)
           -> MP4 mux (vendored) -> Blob -> share / save
```

**No MediaRecorder on this path.** It stays only for the legacy formats
`vstProveMime` has proven by round trip.

### The stamp is anchored to the RECORDING — a defect the owner caught before push

The default came from `file.lastModified` — when the file was **written**, which
on a Photos export is long after the shot — and fell back to **the current
clock**, the processing time itself. Both look plausible on screen.

It reads the video's own capture metadata now, in priority order:
**`com.apple.quicktime.creationdate`** (carries its own UTC offset — trusted),
then **`udta/©day`**, then **`mvhd` creation_time** (no zone, Apple writes local
time — read but marked untrusted), then the modified date (labelled *not* the
recording). **Nothing is invented**: a file with no date gets a form that asks.
The Apple-key fixture resolves to exactly `05/03/2025 11:27:58 AM EDT`.

**An operator's correction outranks the file** — metadata applies only while the
fields are untouched. The form names which of four sources it used.

**Two parser bugs found by a 30-second probe rather than a 12-minute suite run:**
the box-type check admitted only printable ASCII, so QuickTime's **©-prefixed
atoms — `©day`, exactly where Apple writes the capture date — were discarded as
corrupt**; and `ilst` children are indexed by a **binary number**, not a
four-character code, so `vstBox` refused them. That probe habit is worth keeping.

### Audio: STRIPPED BY DESIGN

Owner requirement change mid-build. The muxer is never given an audio track —
asserted against the pipeline's own source. **The AAC passthrough already written
was removed rather than left dormant**: dead code that once muxed audio is what
someone re-enables by accident. Nothing claims preservation; the screen says the
copy is picture only and names the original's audio as still on the original.

### One dependency, not the two approved

The **demuxer is written here** because that half **is** testable in this
container — 200 lines against mp4box's 2.26 MB. The **muxer is vendored** because
a standards-compliant MP4 is the one thing that must be right and **cannot** be
tested here: `portal/vendor/mp4-muxer.js`, **MIT, 69 KB**, no runtime deps, and
no network/wasm/eval — asserted every run, scanning past the provenance note
because that note names those APIs to promise their absence.

**`.js`, not `.mjs`**, so the "no `.mjs` is ever published" deploy invariant
survives. The manifest names the **file**, not the directory.

### CSP — one directive

`/portal/*` gained **`script-src 'self'`** for that single same-origin import,
plus `media-src 'self' blob:` to preview the result. **`worker-src` was NOT
added** — the pipeline is main-thread, so nothing needs it yet. If a worker is
added later for UI smoothness that is its own decision.

### Deployment

| Component | Master | Deployed | Status |
| --- | --- | --- | --- |
| Site + `/portal/` + `/portal/vendor/` | `463b6c5` | `463b6c5` | **DEPLOYED** — success at `463b6c5e` |
| Worker / API | `463b6c5` | `8a48d7d` | **DEPLOYED** — `worker.js` untouched since #166 |
| D1 schema | `463b6c5` | applied | unchanged — no dispatch owed |

### ⚠️ iOS LIVE VERIFIED IS OPEN

**This container has no WebCodecs, so the pipeline has never executed** — only
its demuxer, its refusals and its wiring are tested. It stays open until the
owner's device selects `IMG_0440.mov`, generates, and **plays the result back**.

## 📱 THE iPHONE ANSWERED, AND IT NAMED THE BUG — 2026-08-18

**Owner ran the read-out on the real device with `IMG_0440.mov`.** Two answers
overturn earlier conclusions and one is the bug.

### The end-to-end failure: found and fixed

`vstMime()` returned **WebM because WebM was first in its list**. iOS records
WebM and does not play it, so the test wrote a file and could not open it. The
device was truthful on every row; the code asked the wrong question.

- **MP4/H.264 is first now** — what an iPhone plays and what the owner asked the
  derivative to be.
- **`isTypeSupported` decides nothing any more.** `vstProveMime()` writes a
  four-frame clip in each candidate and **reads it back on that device**; the
  first that survives wins, and `vstGenerate` awaits it before recording. The
  file's name follows the container actually written.

**This project has now been bitten by `isTypeSupported` in both directions** — a
desktop claiming `video/mp4` while `avc1` reports unsupported, and an iPhone
recording WebM it cannot open. Measured after the change: on this container mp4
**does** round-trip, so the old "never mp4" assertion was itself wrong. **The
round trip is the rule; the string is not evidence.** One of my own assertions
encoded the old conclusion and was corrected.

### Canvas capture works on iOS — the published sources were wrong

The previous audit said WebKit iOS did not implement `canvas.captureStream()`.
**The device says YES.** So the existing renderer may work unchanged on iOS for
any file it can decode.

### What is still blocked, and it is one thing

**`Media-element decode of IMG_0440.mov: NO`** — the iPhone would not decode its
own footage through `<video>`. For this file WebCodecs is the only route, and
**"WebCodecs decode: YES" proves only that the API exists.**

So the read-out now **parses the file properly** — `tkhd`/`mdhd`/`stsd`, the
`avcC`/`hvcC` configuration record, dimensions, timescale, duration, audio track
and codec, and the **rotation matrix iOS uses instead of turning pixels** —
builds the real codec string from the configuration bytes, and asks
**`VideoDecoder.isConfigSupported()` about that configuration**, plus
`VideoEncoder` for H.264. Bounded reads: a 6 MB fixture is parsed from under a
tenth of itself, asserted.

### ⚠️ TWO CONSTRAINTS FOUND BEFORE INSTALLING ANYTHING

Both need an owner decision because both touch what `verify.sh` and
`harden-check.yml` police:

1. **`/portal/*` sets `script-src 'unsafe-inline'` with NO `'self'`** — no
   external script can load on the portal at all. A demuxer and muxer must be
   **inlined into `portal/index.html`** (already 570 KB) or the CSP must gain
   `'self'`.
2. **`default-src 'none'` with no `worker-src` blocks Web Workers**, so a
   transcode could not leave the main thread without a second CSP change.

### Dependency audit — NOTHING INSTALLED

| Package | Version | Licence | Unpacked | Role |
| --- | --- | --- | --- | --- |
| `mp4box` | 2.4.1 | BSD-3-Clause | 2.26 MB | demux MOV/MP4 |
| `mp4-muxer` | 5.2.2 | MIT | 156 KB | standards-compliant MP4 out, AVC + AAC passthrough |

Pure JS, no WASM, no server, no upload, compatible licences, a fraction of
`@ffmpeg/core`'s 64.7 MB. The CSP decides *how* they would ship, not whether.

### Next, in order

1. **Re-run the read-out on the iPhone with `IMG_0440.mov`** — it reports the
   owner's §11 matrix now, including whether the decoder accepts the file's real
   configuration and which output format the device proved readable.
2. **If it accepts** — build the pipeline, CSP decision first.
3. **If it declines** — that is the STOP, and no muxer would have helped.

## 🚦 DEPLOYMENT — 2026-08-18, master `3b95e7f` (#168)

| Component | Master SHA | Deployed SHA | Status |
| --- | --- | --- | --- |
| Public site + `/portal/` page | `3b95e7f` | `3b95e7f` | **DEPLOYED** — `Deploy site to Cloudflare Pages` success at `3b95e7f7` |
| Worker / API | `3b95e7f` | `8a48d7d` | **DEPLOYED** — `worker.js` untouched by #167 and #168 |
| D1 schema | `3b95e7f` | applied | unchanged — **no dispatch owed** |

**LIVE VERIFIED remains OPEN** (egress proxy blocks the domain from this
container). **And for this unit the live check is specifically the owner's iPhone:
open Timestamp Video, choose `IMG_0440.mov`, and press "What can this device
do?" — that read-out is the measurement that decides the iOS architecture.**

## ⏸️ AWAITING OWNER DECISION — the WebCodecs route

**Nothing installed. The audit stopped here on purpose.** Making iOS HEVC
first-class needs demux → `VideoDecoder` → burn → `VideoEncoder` → mux, and that
needs an MP4 demuxer and an MP4 muxer — two small permissive pure-JS libraries,
~230 KB together, nothing like ffmpeg.wasm's 64.7 MB. It is the only route that
is streaming rather than whole-file, hardware rather than software, and free of
GPL — **and it would also fix the desktop, which today cannot emit H.264 and
writes WebM.**

Do not start it without the owner saying yes.

## 📱 iOS VIDEO IS PRIMARY INPUT — audit + safe fixes, 2026-08-18

**Owner requirement, and it overturns the previous unit's advice:** iPhone and
iPad video are **primary input, not an edge case**. "Change the camera to Most
Compatible" is at best a tip for future recordings, and **"a laptop running
Chrome or Edge will usually decode it" is rejected outright — it was untested
and it was wrong in the owner's own test.** Existing Apple footage must work.

**The audit is in `VIDEO-TIMESTAMP.md` and separates MEASURED from PUBLISHED
from UNKNOWN by name**, because iOS Safari cannot be run in this container and
guessing about it has already cost the owner a wasted test.

### The finding that reframes everything

**The renderer has two halves that fail independently, and iOS is exactly where
one works and the other does not.**

- **Decode:** iOS Safari has native hardware **HEVC**. It very likely reads
  `IMG_0440.mov` fine — where Chrome on Windows cannot.
- **Encode:** the current path needs `canvas.captureStream()`, which WebKit has
  historically not implemented usably on iOS.

So an iPhone is probably a device that can **play** the file and cannot **write
the copy** — which is a different sentence from "unsupported video", and the UI
now says the right one.

Two more published facts that matter: iOS `MediaRecorder` supports
**`video/mp4;codecs=avc1`** (the broadly playable output this project cannot
produce on desktop), and **`isTypeSupported` has historically returned true where
`start()` then fails on iOS** — so a capability string is not evidence.

### The route that would make iOS first-class: WebCodecs, NOT ffmpeg

Safari 16.4+ has `VideoDecoder`/`VideoEncoder`, hardware-backed. demux →
decode → burn → encode → mux → share sheet. It beats ffmpeg.wasm on every axis
that disqualified ffmpeg.wasm: **~230 KB of pure JS instead of 64.7 MB**, no
`SharedArrayBuffer`, **a few frames of memory instead of the whole file**,
hardware speed, and no GPL. **It would also fix the desktop**, which currently
cannot emit H.264 and writes WebM.

**It needs two small dependencies (an MP4 demuxer and muxer). Nothing was
installed. This is the decision the owner has to make, and the audit stops
there.**

### Safe fixes shipped now

- **Every browser recommendation removed from the page.** Nothing names a
  browser it has not proven.
- **Container and codec are separate named lines** — container described as the
  label it is, codec read from the file's boxes or reported as undetermined,
  never invented.
- **Compatibility tells "cannot decode" apart from "can play but cannot write
  the copy here."**
- **iOS is detected and named**, so the screen never suggests another browser on
  a platform where every browser is Safari.
- **`navigator.share({files})` is the save path where it exists** — the system
  share sheet is how a file reaches Photos or Files on iOS, and it resolves only
  after the operator completes it, so it may honestly be called saved.
- **A device read-out** that runs a REAL end-to-end render attempt rather than
  trusting capability strings. **This is the instrument that fills the iOS
  matrix**: the owner runs it on the iPhone that shot the file.

**Four of my own assertions from the previous unit encoded the old WORDING** and
were sharpened to the rule instead — the owner rewrote the copy, and a test that
pins a sentence fails when the sentence was supposed to change.

## 🚦 DEPLOYMENT — 2026-08-18, master `32dbb98` (#167)

| Component | Master SHA | Deployed SHA | Status | How |
| --- | --- | --- | --- | --- |
| Public site + `/portal/` page | `32dbb98` | `32dbb98` | **DEPLOYED** | `Deploy site to Cloudflare Pages` **success at `32dbb983`** — the merge commit itself |
| Worker / API | `32dbb98` | `8a48d7d` | **DEPLOYED** | `worker.js` untouched by #167; still the build from `8a48d7d0` |
| D1 schema | `32dbb98` | applied | unchanged | **no schema change in #167 — no portal-setup dispatch is owed** |

**LIVE VERIFIED remains OPEN.** The egress proxy still blocks
`alwayspreciseinvestigations.net` from this container (`CONNECT tunnel failed,
response 403`). Every row is a green workflow at the exact SHA, which is
provenance, not live confirmation.

**The owner is the live check for this one specifically** — the whole unit exists
because a green workflow and a passing suite both said a control was there while
the person looking at the screen could not see it. Suites now assert the
control's surface stands off the page behind it, but only a person can confirm
they can see it.

## 🔧 TWO OWNER-REPORTED FAULTS, 2026-08-18 — both real, both fixed

### 1. "The live dashboard does not visibly show the Timestamp Video quick tool"

**It was rendering. The owner was still right.** Measured against the real page:
the control was at y=106 on the first screenful at both 1280px and 390px — and it
was a **white pill on a near-white page**. Present, and practically invisible.

Two genuine conditions were hiding it as well, and both are the kind this file
warns about:

- **It was drawn only by `dashView()`.** An **investigator has no Dashboard at
  all**, so their only copy was the navigation rail — and under 900px that rail
  is behind the burger (measured: `.tabs` computes to `display:none`). So on a
  phone, on any screen but the Dashboard, the only door was **inside a menu**,
  which the owner ruled out by name.
- **Two spellings of one control.** The dashboard said *Timestamp video*, the
  navigation said *Timestamp Video* — so a find-in-page for what the menu says did
  not match what the screen shows. That is exactly how someone concludes a thing
  is not there.

Fixed by moving `quickToolsHtml()` into `shell()` — **one row, one writer, every
top-level screen, both roles**. The case workspace and the field view do not go
through `shell()` and are deliberately untouched; each already has its own door.

**The styling took three attempts and a test caught the second one.** White on
`#f4f5f7` was invisible; the tint that replaced it measured **3 luminance points**
from the page behind it, which is no separation at all. It is filled navy now, and
there is an assertion that fails below 8 — the fix that does not work has to fail
like a fix that does not work.

### 2. "IMG_0440.mov — this browser could not read that video file"

The tool read the filename and start time, failed, and **left the large Generate
button active underneath the error**.

**The cause is a real bitstream decode failure, not the container label** — and
the first hypothesis was wrong and was measured rather than argued. Identical
decodable bytes load whether the blob claims `video/quicktime`,
`application/octet-stream`, `video/mp4` or nothing at all: the browser sniffs
content and ignores the declared type. **Re-wrapping the container fixes nothing.**

`vstBoxCodec()` now names the codec from the file's own `stsd` box with no
decoder — and iPhone QuickTime writes `moov` **last**, so it walks to the end.
Measured on a 5 MB fixture in that layout: **182 bytes read, 0.003% of the file**.
When the boxes cannot be read it returns null and the screen says the codec could
not be determined, rather than naming one.

The check runs when the file is **chosen**: an undecodable file shows a
compatibility stop **where the action was**, the button is disabled (not absent)
while the check runs, and Edit timestamp and Cancel stay in every state.

**Browser-side FFmpeg/WASM was audited and is NOT recommended** — measured, not
argued: no `SharedArrayBuffer` (so no threads), `@ffmpeg/core` is **64.7 MB**
against Cloudflare Pages' **25 MiB** per-file cap, `file.arrayBuffer()` throws
above **1 GB** on this platform, and a transcode cannot stream. It would work on
demo clips and fail on the files this exists for. **The recommendation is the
iPhone camera setting** — *Most Compatible* writes H.264, which the existing
renderer already handles. Full audit in `VIDEO-TIMESTAMP.md`.

**No dependency was installed and none is proposed.** Video is still device-first;
nothing about storage, photos or legacy R2 video changed.

## 🚦 DEPLOYMENT — 2026-08-18, master `8a48d7d`

| Component | Master SHA | Deployed SHA | Status | How |
| --- | --- | --- | --- | --- |
| Public site + `/portal/` page | `8a48d7d` | `8a48d7d` | **DEPLOYED** | `Deploy site to Cloudflare Pages` **success at `8a48d7d0`** (run 32083870194) — the merge commit itself |
| Worker / API | `8a48d7d` | `8a48d7d` | **DEPLOYED** | `Deploy case-portal Worker` **success at `8a48d7d0`** (run 32083870220) |
| D1 schema | `8a48d7d` | applied | **APPLIED** | `Set up the case portal` **success at `8a48d7d0`** (run 32083932807) — dispatched because `video_stamp` is new |
| Save point | `8a48d7d` | tagged | **SAVED** | `Save point` success at `8a48d7d0` (runs 32083870210, 32083937920) |

**LIVE VERIFIED remains OPEN.** The egress proxy still blocks
`alwayspreciseinvestigations.net` from this container — `curl` gets
`CONNECT tunnel failed, response 403`. Every row above is a green workflow at
the exact SHA, which is provenance, not live confirmation. **Do not upgrade any
of them from a green workflow.** Live verification needs a browser on the
owner's side.

## ✅ VIDEO TIMESTAMP — SHIPPED 2026-08-18 (#166, `8a48d7d`), device-first

**Owner decision, in two parts, that changed the architecture before a line was
written: VIDEO IS DEVICE-FIRST.** New video bytes do not become Cloudflare
storage at all. The original stays on the device that shot it, the timestamped
copy is rendered in that device's own browser, and it is saved back to that
device. The portal keeps the **record** and no video.

That is why the audit's original "derivative is another `case_evidence` row"
plan is **not** what shipped: it would have doubled every clip against a 10 GB
free tier the whole failsafe exists to protect.

### The capability proof came first, and it corrected the audit

Run in the real browser this project tests with, before any feature code
(`scratchpad/probe.mjs`, not in the repo):

| Capability | Result |
| --- | --- |
| `VideoEncoder` / `VideoDecoder` (WebCodecs) | **absent** — the audit's first recommendation cannot be used or proven here |
| `MediaRecorder` `video/webm;codecs=vp9` | supported |
| `MediaRecorder` `video/mp4` | **reports supported while `avc1.42E01E` reports NOT** — a trap; recording to it makes a file nothing plays |
| decode → canvas → burn → encode → **re-decode** | full round trip succeeded |
| burned marker present in the re-decoded output | **yes**, and a control pixel elsewhere was not |

**So the renderer is canvas + `MediaRecorder` (VP9/WebM)**, dependency-free, no
service, no credential, no cost. `vstMime()` refuses mp4 by construction and
says why in a comment.

### What shipped

- **`uploadEvidence` refuses `video/*`** with `code: 'video_device_first'`,
  **before** the size and cap tests — a refused video must not first be told to
  split itself into parts. In the Worker, not by a page hiding a button.
- **`video_stamp`** — metadata and audit only. **No blob column, and there must
  never be one** (a test reads the schema, not a comment about it). Routes:
  `POST /cases/:no/video-stamp`, `POST /cases/:no/video-stamp/:id/saved`,
  `GET /cases/:no/video-stamps`. All under `/cases/:no/`, so the deleted and
  archived chokepoint already covers the writes.
- **A correction inserts a row and stamps the earlier one `superseded_at`** —
  matched on the original's own name, so a caller cannot supersede another
  original by naming its id.
- **`saved_at` is the operator's word.** `showSaveFilePicker` resolving is the
  only path that claims "saved" by itself; everything else says the download has
  *started* and the operator confirms. Written once — a second tap does not move
  the moment the file arrived.
- **The page:** `VST` + `#vstamp`, a sibling root like the evidence viewer,
  because a render runs as long as the clip does and nothing underneath may be
  rebuilt while it goes. `vstToUtc`/`vstLabel` resolve EST/EDT **from the date**
  via `Intl`; the label for a frame is the chosen start plus that frame's
  presentation time and **never this machine's clock**.

### The legacy R2 video question — SETTLED FOR NOW, AND OPEN FOR LATER

**The owner's instruction was explicit: do not delete, migrate, move or modify
existing stored video in this PR.** Nothing did. The refusal blocks new writes
only; every existing row still reads, still serves, still counts on the storage
meter, and still passes through the package video gate. The gallery badges such
a row **"stored earlier"** so the office is not left guessing why one clip is in
the portal and the rest are not.

**What is deliberately left for a later, separate decision:** whether legacy
video should be exported to the device and removed, kept until its case closes,
or kept indefinitely. It is real free-tier weight and nobody has decided. **Do
not sweep it as a side effect of anything.** The tests now plant a legacy video
row directly (`plantLegacyVideo` in the worker suite, and one `db.prepare`
insert in the portal suite) because that is the ONLY way such a row can exist
now — which also means the legacy path stays exercised rather than rotting.

### Known limits, stated rather than papered over

- **The copy is picture only — no audio.** `HTMLMediaElement.captureStream` is
  not dependable across the browsers this has to run on, and half-working audio
  on an evidence file is worse than none. The original, with its audio, is on
  the device and untouched. If audio is wanted it is its own unit.
- **The output is WebM.** Not mp4, for the codec reason in the proof table.
- **Rendering is real time** — a four-minute clip takes about four minutes,
  because the clip is played through once. Desktop is the comfortable place for
  a long one; the phone works and says to keep the screen open.
- **`crypto.subtle.digest` needs the whole file in memory**, so the SHA-256 of
  the original is taken only up to 128 MB and is recorded as **absent** above
  that — never as a placeholder that would read as a check that was done.

### Suites, run here

| Suite | Before | After |
| --- | --- | --- |
| `portal/test-portal.mjs` | 1265 | **1345 passed, 0 failed** |
| `case-portal/test-worker.mjs` | 1567 | **1609 passed, 0 failed** |
| `.github/test-deploy.mjs` | 68 | 68 passed, 0 failed |
| `intake/test-intake.mjs` | 205 | 205 passed, 0 failed |
| `visitor-alerts/test-worker.mjs` | 47 | 47 passed, 0 failed |

**The burn-in assertion was mutation-tested**, because it is the claim this whole
unit rests on. With `vstDraw` neutered and everything else identical, the
bottom-right band of the re-decoded output reads **22** — the same as the dark
control band — against **255** as written. It discriminates.

Four Worker rules were mutation-tested the same way and each failed the
assertion named for it: the video refusal (7 checks), the supersede write, the
write-once `saved_at`, and the two `missingTables` guards.

**Four existing assertions were sharpened to their stated intent** rather than
weakened or routed around — the fourth, fifth, sixth and seventh time this has
been needed in this session:

| Assertion | Encoded | Now |
| --- | --- | --- |
| *"no destination is in there with them"* | `.navfoot button` count === 2 | every button in the block carries a door class — the rule, not the number |
| *"the viewer offers no download…"* | a slice from the viewer to `paint()`, then to the next function | the viewer's own body, ending at its closing brace |
| *"the office classifies it"* | selected the classification the row already had | moves it to one the default is not, then puts it back |
| the section bar's names | `Report & Evidence` | `Report & Media` |

### Schema change — the portal-setup dispatch has been RUN

`video_stamp` is new. `schema.sql` arrives by a **manual `portal-setup.yml`
dispatch** while the Worker deploys on push, so between the two the table does
not exist on the live database. **That dispatch was run and is green at
`8a48d7d0`** (run 32083932807), so the table is on the live database now. Every read is guarded through `missingTables()`:
the list degrades to `{stamps: [], not_set_up: true}`, the workspace carries an
empty array, and the write returns 503 naming the workflow. Tested by dropping
the table.

---

# ⛔ EVERYTHING BELOW THIS LINE IS SESSION ARCHAEOLOGY, NOT A QUEUE

**Marked on the 2026-08-22 reconcile.** These blocks are handoffs, audits and
recommendation tables from sessions that predate the DURABLE MASTER UNIT QUEUE
above. They are kept for their reasoning — several record *why* a decision went
the way it did, which is worth more than the status line beside it.

**They are not the queue and their status markers are stale.** Any row reading
`NOT CODED`, `QUEUED`, `NOT started` or `🔴` below has since shipped or is on
the deferred-by-owner list. The DURABLE MASTER UNIT QUEUE and
`FINAL-LEDGER.md` are the authority.

This banner exists because the same trap was live one reconcile ago: OWNER
WORKFLOW SIMPLIFICATION read `QUEUED` while all five parts had shipped, and
nothing had ever closed it. **A block reading QUEUED is how a later session
rebuilds something that already works.**

Checked against the code on 2026-08-22, the specific rows most likely to
mislead:

| Row, as it reads below | Where it actually landed |
| --- | --- |
| Surveillance video timestamp / burn-in — *queued by the owner* | Shipped — Timestamp Video, locked order item 1; `VIDEO-TIMESTAMP.md` |
| Lead-card Send Payment Options — *NOT CODED* | Shipped — `leadPayOpen` on the private lead card |
| Standalone Payment Options dialog — *NOT CODED* | Shipped — `POST /payment-options/email` |
| NEXT STEP helper block — *NOT CODED* | Shipped — Unit 38's Overview leads with NEXT STEP |
| Real intake alerts — *NOT CODED* | Shipped — Unit 20 |
| Intake archive / sample cleanup part 2 — *has never arrived* | **Deferred by owner**, and still is |
| Portal Ops Phase 1 onward — *NOT CODED* | Shipped — Unit 22; three phases deliberately not built, owner content |
| Active Surveillance voice-command mode — *NOT CODED* | Shipped — locked order item 1 |
| Custom private retainer selector — *NOT CODED* | Shipped — `RETAINER_PRESETS` ($1,500 / $2,000 / $3,000 / Custom) on the private send wizard |
| Recommended mobile PRs — *NOT started* | Superseded — the Active Surveillance mobile polish shipped as locked order item 1 |
| Retainer Pending lead/intake actions — *PARTIAL* | The lead card now carries **Send intake** and **Send payment options**; whether the owner wants more there is a question for them, not an unbuilt approved requirement |

---

## 🖥️ OWNER UI ADDENDUM, 2026-08-17 — Timestamp Video is a first-class door

Arrived mid-build and was folded in.

- **Timestamp Video is in the navigation foot for BOTH roles, on every screen**,
  and as one compact `.qtools` row on the Dashboard — not another card. An
  investigator has no Dashboard at all, which is why the nav door is the real
  answer and the dashboard row is the shortcut.
- **Opened from outside a case it ASKS**, against the caller's own
  `/submissions` list, and the record still goes through `caseFor`. Its
  `data-case` is empty **on purpose** so it cannot silently adopt whichever case
  is open behind it. Local processing may also go first: the copy can be made
  with no case, and the screen then says plainly that **the portal holds no
  record of it** until it is attached.
- **Wording:** *Upload video / picture* names the entry point for ADDING;
  *Case media* names what is already there (the tab, the field bar's `Media`
  item, the case card's jump link). **Keys, routes, tables and variables are
  untouched** — `evidence` is still the tab key, the route and the table.
- **One conflict, resolved and flagged:** a control labelled "upload video" would
  promise something the Worker refuses. So *Upload video / picture* is the
  **section** heading and the button under it reads **Upload picture or
  document**, with the video half being Timestamp video. The section carries the
  owner's word; no individual control states an untruth.
- **The four field actions are untouched** — Activity / Photo / Video / Note,
  asserted by name and count. The Video one opens the timestamp screen, which is
  the only thing video does now.
- The package builder's step rail still reads **Evidence**. Deliberately not
  renamed: it is package-composition vocabulary, not the media entry point or the
  existing-media view.

## 📹 QUEUED BY THE OWNER — SURVEILLANCE VIDEO TIMESTAMP / BURN-IN

**Recorded on arrival, 2026-08-17, before any of it was built.** Queued behind
Active Surveillance Mobile PR 1, on the owner's instruction. **The full brief is
in `VIDEO-TIMESTAMP.md` next to this file** — read that, not this summary.

The shape, so nothing is lost if only this file is read:

- **The original uploaded video is NEVER modified.** A separate *timestamped
  derivative* is generated for viewing and package delivery; the original stays
  untouched as evidence, and the two must be told apart on screen.
- The burn-in is a **running clock**, not a static label: it starts at the
  operator's chosen second and advances with the footage.
- **`America/New_York`, resolving EST/EDT by date.** Hard-coding EST would make
  every summer timestamp an hour wrong.
- Bottom-right, encoded into the derivative — **a CSS overlay is explicitly not
  sufficient**, because the stamp has to survive download and packaging.
- Existing evidence permissions, storage and audit trail are reused, not
  duplicated; the derivative inherits the original's access boundary.

**⚠️ AUDIT FIRST, AND THE OWNER HAS PRE-AUTHORISED STOPPING.** The instruction is
explicit: if real transcoding needs infrastructure or dependencies this project
does not have, or would materially change deployment cost, **stop after the
audit and report** — what exists, the exact missing capability, the recommended
rendering approach, the storage/compute implications and the smallest path.
**Do not silently introduce a paid external video service, and do not fake the
burn-in with CSS.** That is a likely outcome here: the portal's compute is a
Cloudflare Worker, which is not a transcoding environment.

Also from the owner, for whenever the package work next moves: the **timestamped
derivative should become the client-facing delivery video**, with the untouched
original retained as evidence.

## ✅ MOBILE PR 1 — SHIPPED (#162, `24582c7`)

**DEPLOYED 2026-08-17**, site and Save point green at `24582c7d`. Suites: portal
**1245/0** (1227 before), worker **1567/0**, deploy **68/0**.

**Measured before coding**, at 390×844 with a day running — the numbers are the
finding:

| | y (before) | |
| --- | --- | --- |
| header ends | 83 | |
| status block | 123 | Day line, a 2rem clock, the date — four stacked lines |
| **End day** | **215** | pressed **once a shift**, gold, the loudest thing |
| Pause | 283 | |
| Activity / Photo / Video / Note | 358 | pressed **all day** |
| Tap to speak | 602 | off the first screen |

**275px of an 844px screen before the first field control**, in the exact
reverse of the order of use. **After: 187px**, with the four field actions and
the microphone all above Pause and End day.

**Nothing functional moved** — `svElapsed`, `svClock`, `svPaused`, the `#svTimer`
id the tick updater writes into, and every control's `data-act` are untouched.
The subject line comes from a field already in the payload and already
authorised for the role.

**Two existing assertions were updated rather than worked around**, and the
pattern is the one worth keeping: *"ending the day is the gold action"* encoded
a design the owner has since reversed by name, and two functional end-the-day
clicks were addressing the button by its **styling class** — a test that ends a
day should find that control by what it IS, not by how it is painted.

**An earlier draft shortened "Exit active mode" and a test caught it.** That was
out of scope and was reverted; the guard did its job.

## ✅ MOBILE PR 2 — SHIPPED (#164, `182f9b8`)

**DEPLOYED 2026-08-17**, site and Save point green at `182f9b84`. Suites: portal
**1265/0** (1245 before), worker **1567/0**, deploy **68/0**.

Exit active mode moved out of the sticky header — where it sat at roughly y30–70
of an 844px screen, the furthest point from a right thumb — into the **Case
drawer**, the `⋮` item the bottom bar already has. **Not** a sixth top-level
item: six targets across 390px narrows every one of them, and the bar is still
five (asserted). Behind one deliberate tap, and absent from the field home
screen where the all-day actions live.

`svExit` is untouched. It is not gold, and it says what it does and does not do —
*"It does not end your investigation day"* — because End investigation day stops
the billable clock and leaving a screen does not.

The date folded into the status row: one less line, same words. The paused
sentence keeps its own line, and only appears while paused.

**Three existing assertions were updated to their INTENT** rather than worked
around: two pinned the exit to `.sv-head` (and "obvious" always meant
*reachable* — the header was the worst place on the phone to be pinned to), and
one clicked `svExit` directly instead of navigating the way a person would. This
is now the third time this session that an assertion encoded a *placement* or a
*style* rather than the rule it was named for. **When that happens, sharpen the
assertion to its stated intent — never weaken it and never route around it.**

## 🔎 MOBILE PR 2 AUDIT — the finding, as it was recorded

Measured on the shipped screen at 390×844 with a day running.

**1. Exit active mode is in the worst reachable place on the phone.** It sits in
the sticky header at roughly **y 30–70** of an 844px screen — the top-right
corner, the furthest point from a right thumb, and the one control you reach for
when you are done or need the full portal. Everything else in the mode is
already thumb-reachable. It also still **wraps to two lines** at 390px.
*(An earlier draft of Mobile PR 1 shortened its label and a test caught it — the
label is not the fix, the position is, and that is this PR.)*

**2. The bottom navigation is right and should be left alone structurally.**
Fixed to the bottom, five items, `min-height:50px` with
`padding-bottom:max(12px, env(safe-area-inset-bottom))` — already correct on a
notched phone, already in the thumb zone. **The natural home for Exit is here**,
most likely behind the existing `⋮ Case` overflow item rather than as a sixth
top-level item, because six items at 390px narrows every target.

**3. Evidence and case access are one tap and fine.** `Evidence` and `Case` are
both in the bottom bar; the evidence viewer shipped in #156 keeps a tap inside
the app. No change needed — record it as checked rather than as work.

**4. Remaining reducible chrome, in order of what it costs:**

| | Roughly | Note |
| --- | --- | --- |
| sticky header | 83px | tag + case number + Exit |
| subject line | ~40px | **earns its place** — the owner asked for it and it is the only thing naming who is watched |
| date / mileage line | ~30px | a whole line for "Mon, Aug 17, 2026"; folds into the status row |
| transient banner | ~90px when present | "Day started." — already transient, not worth touching |

So there is **roughly one line of honest saving left** (the date), plus whatever
moving Exit out of the header returns. The big win was PR 1's 275px → 187px;
this is diminishing returns, and the audit should say so rather than manufacture
a reason to keep cutting.

### ▶ RECOMMENDED MOBILE PR 2 — NOT started

**Move Exit active mode into the thumb zone, and fold the date into the status
row.** Specifically: Exit moves out of the sticky header into the bottom bar's
existing overflow, the header keeps the tag and the case number only, and the
date/mileage line merges into the compact status row.

Presentation and placement only. **The exit FLOW is unchanged** — `svExit` stays
exactly what it is, including whatever it does about a running day; this PR moves
where the control lives, not what it does. There is a test asserting the header
contains "Exit active mode" today; it should be **updated to assert the control
exists and is reachable**, not deleted.

## 🔎 ACTIVE SURVEILLANCE MOBILE AUDIT — 2026-08-17, the original finding

Audited on the real field view at **390×844 with a day running**. Ordered by how
much it costs the investigator, not by how easy it is to fix.

1. **The timer block is the biggest thing on the screen and the least acted
   on.** "Day started." banner, then `DAY 1 · RUNNING SINCE 8:08 PM`, then the
   clock at roughly 64px, then the full date — four stacked lines. With the
   header above it, **about a third of the screen is gone before the first
   control**. The investigator does not act on the clock; they act on Activity
   and Photo. This was raised once before ("smaller timer") and is still the
   dominant element.

2. **Field-action priority is inverted, and this is the real finding.** The
   loudest, highest control is **End investigation day** — gold, full width,
   pressed **once a shift** — with Pause under it. The four controls actually
   used all day (Activity · Photo · Video · Note) sit **below both**, and
   *Tap to speak* is below those, at the fold. The order on screen is the
   reverse of the order of use.

3. **Nothing on screen says who is being watched.** The case number is top-left
   in small type and **wraps across two lines**. There is no subject, address or
   scope reminder anywhere in the field view — the things an investigator
   actually re-reads in a car. Evidence is only reachable through the bottom bar.

4. **Two navigation systems, one out of thumb reach.** The bottom bar
   (Home · Activity · Evidence · Report · Case) is right and reachable. But
   **← Exit active mode** sits in the top-right — the hardest corner to reach
   one-handed — and wraps to two lines.

5. **One-handed usability follows from 1, 2 and 4:** the top third is a clock,
   the most-used actions are pushed toward the middle, and one navigation
   control is in the far corner.

### ▶ RECOMMENDED FIRST MOBILE PR — NOT started

**Re-rank the field screen by frequency of use, and shrink the clock to fit.**

- the clock becomes a compact single line (time + "Day 1", still server-derived —
  **do not touch how it is computed**, that is the tick-free design)
- **Activity · Photo · Video · Note rise to the top**, directly under it
- **End investigation day and Pause move down** to the end of the screen, out of
  the accidental-tap zone, keeping their 44px targets
- one line naming **the subject** under the case number, so the screen says who
  is being watched

Presentation and ordering only. **No change to `day/start`, `day/end`, pause
spans, evidence upload, the timer's derivation or any route** — all five are
existing behaviour the owner has ruled out redesigning for now, and this PR must
not touch them.

## ⚖️ OWNER DECISION, 2026-08-17 — Phase 11 DEFERRED, and a feature-creep freeze

**PHASE 11's health flag is DEFERRED pending a future owner decision.** The two
open questions below — the mapping from lifecycle position to ON TRACK /
WAITING / ACTION NEEDED, and where the flag appears — are **not to be invented**.
Do not build it, and do not answer them by guessing a sensible default.

**Non-critical correctness feature creep is FROZEN.** The work moved to a
dedicated **visual / mobile phase**. Phase 8 is complete. Global Search, voice
mode, an Active Surveillance behaviour redesign and any CRM/contact model all
stay unbuilt, and the schema, backend business rules, permissions, payment
rules, lifecycle rules and case-visibility boundaries are all unchanged by that
phase — it is presentation only.

### ⏸ DEFERRED — `PORTAL-OPS.md` PHASE 11, the CASE HEALTH half

Kept because the audit is still accurate and saves repeating it. Phase 11 is
**PARTIAL**, and the missing half is the smaller one.

**Already built:** the recommended NEXT STEP. `pkgNextStep()` computes it and
`.ov-next` draws it on the admin case Overview *and* the investigator's case
home — both roles already get "one obvious next thing".

**Genuinely missing:** the three-state health flag. Verified on master
`f8b510e` — **"ON TRACK" and "ACTION NEEDED" appear nowhere in the page**, so
this is not a rename of something that exists.

Fully specified: *"Health state per case: **ON TRACK · WAITING · ACTION
NEEDED**"*, against the lifecycle the same section enumerates (INTAKE →
ASSIGNMENT → FIELDWORK → REPORT → EVIDENCE → PACKAGE → BILLING → COMPLETE). No
`[inferred]` marker on the states themselves — the only one in the section is
`[Add] Activity`, on the next-step list that is already built.

**Why it is small:** it is a **derivation, not a record.** Everything it needs —
stage, assignment, open day, report status, build status, authorization, retainer
— is already on the payloads the case screen and `/summary` load. Computed on
read like totals, `overdue` and the field timer already are, so nothing can go
stale and there is no schema, no route and no migration.

**The two open questions, now formally deferred by the owner:** which of the
three states each lifecycle position maps to, and whether the flag appears on the
case list as well as the case screen. The spec names the states and the lifecycle
but does not draw the mapping between them. **Do not invent either one.**

### The audit, as it was recorded

**`PORTAL-OPS.md` PHASE 8 — Recently viewed + favourites.** Audited against the
whole of PORTAL-OPS, and it is the smallest phase that is **completely
specified**: *"Recently viewed, and allow pinning/favouriting frequently used
cases. Store only safe identifiers client-side; load real records through
authorized server routes."* No `[inferred]` markers, no corrupted region, and
the one rule that matters — identifiers only, records through the authorized
route — is stated outright.

**Why the others are not the recommendation**, so this audit does not have to be
repeated:

| Phase | Why not |
| --- | --- |
| 2, 4, 5, 9 | listed by name in *"WHAT WAS CORRUPTED AND NEEDS RE-SENDING"* — **not fully specified** |
| 6 Quick actions | three of its items are `[inferred]` reconstructions |
| 7 Clients & contacts | a new contact model, and the owner's own DO-NOT list says no enterprise CRM |
| 15 Mobile / PWA polish | already true — the manifest and `?surveillance=1` ship today |
| §10 permissions, and everything after it | corrupted; the owner has been asked and it has not arrived |

**Shape, if it is taken:** a client-side list of case numbers only, rendered as a
strip that loads through `/submissions` exactly as every other view does — no
schema, no new route, no cached record. Two rules should carry over from what is
already here rather than being invented: it must be **cleared on sign-out**, the
same rule that already clears `CASES`, `CASES_Q` and the read-success flags so
one person's session cannot vouch for another's; and a case number that no longer
resolves must simply **drop off the strip** rather than draw a dead row.

**One thing to settle before building, and it is small:** whether a favourite
survives sign-out. Recently-viewed clearly should not. A *favourite* is a
deliberate pin and arguably should persist — but on a shared office desktop it
would tell the next person which cases someone cares about. The spec does not
say. **Ask rather than choose.**

### The finding, as it was recorded

**The evidence photo viewer has no way back** — the owner reported this
personally on 2026-08-16 and it is still open. Verified on master `a8dd297`:
the evidence gallery renders an image as
`<a href="${fileUrl(e)}" target="_blank" rel="noopener">` at
`portal/index.html:4952`, and `manifest.webmanifest` is `display: standalone`
with `scope: "/portal/"` — so the file route is **outside the scope** and the
tap leaves the installed app entirely: no browser chrome, no back button, no
bottom bar. The owner's words were *"when you view some photos in evidence
theres no back button — each viewed page should have a back button or display
the bottom bar."*

**It is more than one link, which is what sizes the unit.** The same pattern is
at `:6182` (the field view's gallery) and `:6529` (the package document's
images), with filename links at `:3989`, `:4308` and `:4955`. The gallery
thumbnails are the ones the owner actually hit; the filename links are the same
escape by a different route. A viewer built once and used by all of them is the
fix — six separate patches would be six chances to miss one.

Fully specified by that report and needs no new decision. It is the older half
of a two-part piece of feedback whose first half — the burger tap target —
shipped in #123, so the remaining half has been outstanding the longest of
anything recorded here.

The shape: keep the evidence bytes where they are and stop the navigation
leaving the app — an in-page viewer that draws the image with a back control, or
at minimum a route that stays inside the PWA scope. **Do not** copy the original
into a second store; original evidence must never be duplicated or overwritten
(the package rules already say so).

## ⚖️ OWNER DECISIONS, 2026-08-17 — the three blocked alert/archive questions

**Answered by the owner, verbatim in substance, in reply to the overnight
report. These govern; do not reopen them or infer around them.**

1. **Private / Insurance goes in the EMAIL alert wording ONLY, for now.** SMS
   wording stays **generic**, and the existing validated SMS behaviour is
   preserved — which means the `sms` branch of `alertText` still does not read
   `caseNo` at all, and the property test asserting the SMS wording is identical
   on two different databases (`test-worker.mjs`, the two-database check) must
   keep passing untouched. The email half is a safe unit: `kind` is already in
   scope at both call sites (`worker.js:291`, `:1397`) and simply not passed.
2. **Do NOT invent a retry system or retry policy.** "Retried" is not to be
   implemented **until a real retry workflow, attempt model and policy exist**.
   The queued/sent/failed/retried status log therefore stays unbuilt — building
   it today would mean inventing three of its four states.
3. **Do NOT build the intake archive UI yet.** `INTAKE-OPS.md §2` is still
   *"part 1 of 2"* and part 2 has not arrived. **Do not guess archive / restore /
   Active / Archived / All semantics.**

**Still open and untouched, for the record:** delivery-exactly-once is specified
(`INTAKE-OPS.md:52-57`, with the `retainer_payment_token` precedent named) and is
buildable, but it needs a table and therefore a `portal-setup` dispatch, so it is
not a drop-in unit. The owner has not asked for it yet.

### Also found, recorded not fixed — the rest of item 5

- **Alerts do not say Private vs Insurance**, which `INTAKE-OPS.md:46` requires.
  A consumer and a claims intake produce byte-identical text. `kind` is already
  in scope at both call sites (`worker.js:291`, `:1397`) and simply not passed.
  **Email only** — whether the category word also goes over SMS is an owner call
  and would break the deliberate "SMS wording is identical on two databases"
  property at `test-worker.mjs:7322-7338`.
- **No delivery-once guarantee.** `INTAKE-OPS.md:52-57` asks for claim-and-act in
  one transaction, the `retainer_payment_token` precedent. The alert does not ride
  it: `worker.js:6776-6778` notifies unconditionally, including on `'duplicate'`.
  Probed: same `client_token` twice → **1 ledger row, 2 alert emails**.
- **No status log** (queued/sent/failed/retried). No such table among the 52 in
  `schema.sql`; `notifyAdmins` returns `{sent, of}` and **all six callers discard
  it**. **"Retried" is not specified** — nothing in the repo retries and the doc
  names no attempt count, backoff or queue. Do not invent it.
- **An admin cannot see that a send failed.** `sendMail` failures go to
  `console.error` and nowhere the office can read.
- **The archive half is the right table at the wrong altitude.** `case_archive`,
  the write gate and the count suppression are all done properly and tested, and
  both "where these two meet" rules hold. But §2 describes an **intake record**
  feature: a `•••` menu (**there is no `•••` menu anywhere in the page**), an
  ARCHIVED badge on the card (`archived_at` is shipped to the page and never
  read), and Restore outside the workspace. The filter triad is
  `All/Open/Completed/Archived/Deleted`, not `Active/Archived/All`, and **"All"
  excludes archived** — which may be a labelling mismatch or a real one; §2 lists
  the three filters without defining them. **§2 is "part 1 of 2" and part 2 has
  still not arrived.** Do not extrapolate it.
- **One live defect in the existing behaviour:** the Cases lens is module state
  and `act === "tab"` repaints without refetching, so leaving the lens on
  **Archived** and clicking **Intakes** draws archived intakes as live cards with
  Accept and Send buttons — and into Today / Next actions, where they then
  disagree with the "New intakes" count beside them, which is the Worker's and
  correctly excludes them.

## 📝 NON-BLOCKING FINDINGS, 2026-08-16 — from Edit Case

- **The case header's own "Edit case" button is under 44px on a phone.** The
  Edit Case panel's controls are floored at 44px and asserted; the header button
  that opens it is a header control and was left alone rather than widened as a
  side effect. Worth a pass over the case header's tap targets as its own unit.

- **Phase 1 items still not built, deliberately:** the More menu (item 4) was
  not started — with Record Payment already on Overview and Edit Case reachable
  from the header, a menu risks a second path to the same things rather than
  reachability, and Export does not exist to put in it. Item 3's "last activity"
  is served by the existing Recent activity card rather than a new single line.

## 📝 NON-BLOCKING FINDINGS, 2026-08-16 — from the two-admin surveillance work

Recorded, not fixed. None blocks the merge of the branch that carries them; each
is a judgement call or a small edge worth someone's decision rather than a
defect.

- **Ending someone else's session stamps the moment of the press.** An admin
  ending another's day has no End form in front of them — that form belongs to
  their own day, which is exactly the day they do not have — so `end-other`
  sends the current local time and no mileage or summary. That is deliberate:
  mileage and a day's summary are the field admin's to know, not the desk's to
  invent. **Open question for the owner:** whether the ended day should be
  marked somewhere as "ended by the office" rather than reading like an ordinary
  close. Today only the hours distinguish it.

  > ✅ **ANSWERED AND CLOSED — owner, 2026-08-21; built as Unit 27.** The answer
  > is yes. `case_day_end` records who ended each day and their role at that
  > moment, and the office's Days table, the timeline and the day-end
  > confirmation all read one label from `dayEndLabel()`. It is no longer true
  > that "only the hours distinguish it".

- **The ordinary End's refusal names only one other session.** When an admin
  presses End on a case where several others are running, the refusal names the
  newest (`LIMIT 1`). The *explicit* route is fully bound to a session id and
  refuses to guess, so nothing acts on the wrong day — this is wording only, and
  the panel above it lists every running session by name.

- **SMS alert delivery is deferred indefinitely** (owner, 2026-08-16). Email
  alerts are sufficient. The recipient settings already store numbers with
  per-event toggles and `alertText(..., 'sms')` already produces wording that
  carries no case number; `alertDelivery()` reports `blocked_on_provider` and
  the Settings card says "not sent yet". **That is the intended resting state,
  not a gap.** Do not build or propose it until the owner asks. If it is ever
  wanted, the open items are: which provider, who buys the number, a per-day
  message cap in the Worker before any sender is wired, and US A2P 10DLC
  registration — and it would be the first deliberate recurring charge in a
  system whose whole failsafe exists to make a bill impossible.

- **Shell-escaped patches corrupted source twice in one session.** A `node -e`
  edit produced `/^d{1,12}$/` instead of `/^\d{1,12}$/` — matching the letter d,
  not digits — which would have made a fix inert while every test still passed,
  and backticked terms were eaten out of CLAUDE.md prose the same way. Both were
  caught by reading the generated code, not by the suites. **Prefer a real file
  edit over shell string surgery on source**, and read back anything patched
  that way.

## 🔍 LEDGER AUDIT, 2026-08-15 — this file and `PAYMENTS.md` were both behind the code

A status pass at master `cd37d28` re-derived the queue **from the identifiers in
`worker.js`, `portal/index.html` and `test-worker.mjs`**, not from these ledgers.
Both files were wrong, and **both were wrong in the same direction: they
understated what is built.** That is the third time this repo has recorded that
exact drift (see the 2026-08-14 re-audit and second audit below), so it is a
pattern rather than an accident — a ledger row is written when work is *queued*
and nobody goes back to it when the work *lands*.

What was corrected:

| Where | Said | Actually |
| --- | --- | --- |
| `PAYMENTS.md` steps 1–8 | all "not started" | **seven of eight are shipped** — admin config, sheet block, wizard section, preview, record-payment, the boundary tests. Only case-history surfacing is genuinely partial |
| `PAYMENTS.md` steps 9–18 | all "not started" | **five of ten are shipped** — independent toggles, one-email assembly, never-invent-a-URL, the sent confirmation, and half of the insurance boundary |
| This file, custom retainer selector | "nothing on screen sets it" | a free-text box does set it; the **presets in the send flow** are what is missing |
| This file, lead-card payment row | one row, "NOT CODED" | four items in **four different states**, one of them LIVE VERIFIED |

**The cost of leaving this uncorrected was concrete:** the owner's standing
instruction is *"do not rebuild already-completed UI"*, and a session starting
from the old ledgers would have rebuilt an admin settings screen, a wizard
section, an email builder and a Record Payment flow that already work — the
Record Payment one having been verified live across eight PRs.

**Method, for whoever repeats it:** grep the identifier, find the route, find
the control, find the test. A row in this file is not evidence of anything.

## 🚦 DEPLOYMENT MATRIX — 2026-08-15 · **SUPERSEDED, see 2026-08-17 above**

**Kept for its reasoning, not its numbers.** Every SHA and suite count below is
eight merges stale — it says `f5a4155` while master is `dff3f82`, and 1033/806
where the suites now stand at 1538/1110. The 2026-08-17 matrix at the top of
this file is the current one. The paragraphs on *why* the Worker is DEPLOYED
and not LIVE VERIFIED, and on the cached `/.gitignore`, are still true and are
why this section was not simply deleted.

**Nothing is complete until it is LIVE VERIFIED.** The states are CODED →
TESTED → PUSHED → MERGED → DEPLOYED → LIVE VERIFIED, and the words DONE,
SHIPPED and IMPLEMENTED mean the last of those, never the first.

This matrix exists because the two halves of the system drifted apart for four
days without anything saying so: `deploy-portal.yml` kept shipping the Worker
while `deploy.yml` failed, so the portal followed master and the public site
did not. Every suite passed the whole time.

| Component | Master SHA | Deployed SHA | Status | Verified at | How |
| --- | --- | --- | --- | --- | --- |
| Public site | `f5a4155` | **`f5a4155`** | **LIVE VERIFIED** | 2026-08-15, after #125 | `/.well-known/build.txt` reports `commit: f5a4155`, `built: 2026-08-15T23:20:20Z` — **exactly master**. `Deploy site to Cloudflare Pages` green at that SHA |
| `/portal/` page | `f5a4155` | `f5a4155` | **LIVE VERIFIED** | 2026-08-15, after #125 | served page fetched cache-busted: 200, **384 KB** (up from 376 KB, consistent with the selector), `no-store`, `noindex, nofollow, noarchive`. Positive identifier check on the served bytes — all twelve of item 1's: `wizRetainerHtml` `wizRetainerSave` `wizRetainerInit` `wizRetainerWanted` `RETAINER_PRESETS` `wiz_ret` `wiz_retc` `wizRetPick` `wizRetDirty` `retainerTouched` `Agreed retainer` `Custom amount`. Negative guard re-run on the LIVE bytes: **zero dollar figures** in the served portal HTML |
| Worker / API (`api-case-portal`) | `f5a4155` | `f5a4155` | **DEPLOYED**, provenance-verified | 2026-08-15 | `Deploy case-portal Worker` **succeeded at `f5a4155` itself**, and `f5a4155` IS the last commit touching `worker.js` and IS `origin/master`. Stronger than the previous rows, which established the same thing by diffing back to an older green SHA — but still provenance, not behaviour |
| D1 schema (incl. `retainer_payment`, `retainer_payment_token`) | `f5a4155` | applied | **LIVE VERIFIED** | 2026-08-15 | `schema.sql` unchanged by #125 (last touched `35607d5`); `/portal-api/health` → `{"ok":true,"configured":true,"email":true,"missing_tables":[],"storage_pct":0}` |

**All five suites run at `f5a4155`, not inherited from the ledger:**

| Suite | Result |
| --- | --- |
| `case-portal/test-worker.mjs` | **1033 passed, 0 failed** (997 before #125) |
| `portal/test-portal.mjs` | **806 passed, 0 failed** (789 before #125) |
| `intake/test-intake.mjs` | **205 passed, 0 failed** |
| `visitor-alerts/test-worker.mjs` | **47 passed, 0 failed** |
| `.github/test-deploy.mjs` | **68 passed, 0 failed** |

**Why the Worker is DEPLOYED and not LIVE VERIFIED.** Its build is not
externally observable: authentication runs before routing, so a route that
exists and one that does not both return 401, and `/health` answers "a Worker is
up", never "this Worker is up". The chain above is provenance — workflow green
at a SHA whose `worker.js` is byte-identical to master's, with nothing touching
it since. That is strong, and it is still not the same as exercising the code.
Behavioural confirmation needs an authenticated admin session. Do not upgrade
this row on the strength of `/health`.

**⚠️ ONE THING IS FIXED AT ORIGIN BUT STILL PUBLIC FROM CACHE.** `/.gitignore`
was being served (it was in the old deny-list artifact and is not in the
allow-list one). A cache-busted request now 404s, so it is genuinely gone from
the deployment — but the edge still answers 200 from a cached copy.
**Re-measured 2026-08-15 at session start: still 200, `Age: 68139`** (~19 hours
into a `s-maxage=604800` week), so it has **not** aged out and will not for
several days yet. It names only
an internal tooling script, so the severity is low, but the general lesson is
not: *removing a file from the artifact does not unpublish it.* **Owner action:
purge that path in the Cloudflare dashboard** (or accept the week). Anything
sensitive ever removed this way needs a purge, not just a deploy.

## ▶ NEXT UNFINISHED ITEM (stopped here, 2026-08-15)

**Stopped at a clean handoff on the owner's instruction.** Master is
`4e053c2`; the site and the Worker are both deployed at it and build.txt
agrees. Nothing is half-done in the tree and no branch is open.

**The next unfinished item is the CUSTOM PRIVATE RETAINER SELECTOR.** The stored
figure is honoured everywhere it is read — sheet, subject line, email body,
payment block and preview.

**Correction, 2026-08-15:** this section previously said *"nothing on screen
sets it"*, and that was wrong. A free-text **Retainer amount** box exists —
`m_ret`, `portal/index.html:3993` — on the private case's settings panel,
posting to `POST /cases/:no/retainer`. What is missing is narrower and more
specific than "a control": the **`$1,500 / $2,000 / $3,000 / Custom` presets, in
the private send flow**, which is where the owner's order puts the choice —
*"Before sending a private rate sheet or intake."* A $3,000 agreement can be
recorded today; it just cannot be **chosen at the moment of sending**, and the
presets do not exist anywhere. Do not rebuild the storage, the route or the
carry-through; all three are live.

Two things needing an authenticated admin session rather than code, both
carried forward: proving the $3,000 sheet end-to-end against the live Worker,
and the private payment configuration rows below.

## ✅ OWNER QUEUE — CONFIRMED 2026-08-15

The owner confirmed this order explicitly. It supersedes any ordering implied
elsewhere in this file. **Do not rebuild anything already LIVE VERIFIED.**

| # | Item | State |
| --- | --- | --- |
| 1 | Custom Private Retainer Selector | **LIVE VERIFIED** (page) · **DEPLOYED** (Worker) — #125 at `f5a4155` |
| 2 | Lead-card Send Payment Options | 🔴 NOT CODED — `PAYMENTS.md` step 9 |
| 3 | Standalone Payment Options dialog | 🔴 NOT CODED — step 12; `payment_send.with_sheet` is the seam |
| 4 | NEXT STEP helper block | 🔴 NOT CODED — steps 10 and 17 |
| 5 | Retainer Pending lead/intake actions | 🟡 PARTIAL — built on the case panel, absent from the leads card (step 15) |
| 6 | Real intake alerts / archive | 🔴 NOT CODED — `INTAKE-OPS.md` §1 and §2; **archive part 2 has never arrived** |
| 7 | Portal Ops Phase 1 onward | 🔴 NOT CODED — `PORTAL-OPS.md`, phased |
| 8 | Active Surveillance voice-command mode | 🔴 NOT CODED — **after core Portal Ops is stable**, owner's condition |

### Item 1 — Custom Private Retainer Selector: **LIVE VERIFIED** (page half)

**Merged as #125, squashed to `f5a4155`, 2026-08-15.** Full state walk:

| State | Evidence |
| --- | --- |
| CODED | selector on the private send wizard; three Worker fixes it needed |
| TESTED | worker 997 → **1033**, portal 789 → **806**; five suites green; **four control runs**, each printing its bug |
| PUSHED | `59bc9f5` on `claude/ledger-reconcile-payments` |
| MERGED | PR #125 → `f5a4155` |
| DEPLOYED | `Deploy site to Cloudflare Pages` **and** `Deploy case-portal Worker` both green **at `f5a4155`** |
| LIVE VERIFIED | **page half only.** All twelve identifiers confirmed in the served bytes; the no-dollar-figure guard re-run against the LIVE page returns **zero**. See the matrix above |

**The Worker half is DEPLOYED, not LIVE VERIFIED, and that is not a formality.**
`/sheets` returning `retainer`, the zero refusal and the absent-`received`
preservation all sit behind authentication, which runs before routing — so an
unauthenticated probe cannot tell a route that exists from one that does not.
The provenance here is as strong as it gets (the portal deploy succeeded at
`f5a4155` itself, which is both master and the last commit to touch
`worker.js`), and it is still not the same as exercising the code. **Proving it
needs an authenticated admin session**, alongside the two items already carried
forward for the same reason.

`$1,500 Standard / $2,000 / $3,000 / Custom` on the **private** send wizard,
writing `case_retainer.retainer_amount` through the route that already existed.
The storage, the guards and the carry-through were live already and were **not**
rebuilt; what shipped is the control and three safety fixes it needed.

| Owner's named test | Where |
| --- | --- |
| each preset works | `test-worker.mjs` — each of the three posted and read back |
| custom amount works | the owner's own $2,500, stored exactly, not rounded to a preset |
| rate sheet displays the selected amount | both MIME parts of the **real email**, plus the subject line |
| returned intake preserves the selected amount | the intake row is untouched, and a **second** send carries the same figure |
| partial payments calculate correctly | two instalments against a chosen retainer, not the standard one |
| Record Payment never resets the agreed retainer | asserted, and its mirror below |
| Insurance never sees this selector | claims case refused by the Worker; carrier wizard renders no selector; an adjuster's email carries no retainer wording |

**Three defects were found and fixed while building it**, each with a control run
that prints the bug:

1. **An absent `received` meant "not received".** The selector sends an amount
   and knows nothing about the money, so raising an agreed retainer would have
   **un-received a retainer that had genuinely been paid** — the case reading
   PENDING with the payments still in the log underneath. Absent now means
   unchanged, the same rule the amount already had. Control: *"raising the agreed
   retainer does not un-receive it — false"*.
2. **Zero was storable.** `rateSheets()` falls back to the standard for anything
   not above zero, so a stored 0 put $0 in the record and $1,500 in front of the
   client — the record and the document disagreeing in silence. Refused now.
3. **An untouched selector would have overwritten the case.** Opened from Rate
   sheets there is no case number, so it shows the standard figure; writing that
   on the way to Preview re-cut the client's retainer as a **side effect of
   looking at an email**. Control: the preview came back reading
   *"Private Client — $1,500 Retainer"* on a case that had just agreed $3,000.

**One test of mine was wrong and the code was right**, recorded because that is
the point of the discipline: the flag guard was first written against a case
that already had payments, where `received` is decided by the money and not the
flag at all — it would have passed no matter what the flag did. It is driven on
a payment-free case now. A second one tried to email the carrier sheet against a
private case; the sheet/lead pairing guard correctly refuses that, so the carrier
boundary is asserted where a carrier actually is.

**Suites:** worker 997 → **1033**, portal 789 → **806**. All five green.
**Still DEPLOYED-not-LIVE-VERIFIED once merged**, for the standing reason: the
Worker's email output is not observable without an authenticated admin session.

**Every item is tracked through the owner's six states: CODED → TESTED →
PUSHED → MERGED → DEPLOYED → LIVE VERIFIED.** The words done, shipped and
implemented mean the last of those. Worker-side behaviour that authentication
hides from an unauthenticated probe stops at **DEPLOYED** and says so — see the
caveat above; do not promote such a row on the strength of `/health`.

---

### Feature states, this session's work

| Item | State |
| --- | --- |
| HIGH #1 break/pause 0-hours | LIVE VERIFIED (Worker: DEPLOYED, see caveat) |
| HIGH #2 stranded running day | LIVE VERIFIED (Worker: DEPLOYED, see caveat) |
| HIGH #3 paid invoice back to draft | LIVE VERIFIED (Worker: DEPLOYED, see caveat) |
| HIGH #4 held-back material + delivery link | **LIVE VERIFIED** — page identifiers confirmed served |
| UTC/local surveillance date + midnight pairing | **LIVE VERIFIED** — `ymdLocal`/`stampNow` confirmed served |
| Private payment configuration + sheet boundary | MERGED + DEPLOYED; **not LIVE VERIFIED** — admin-only routes need an authenticated check, and **no handles are configured**, so nothing renders yet |
| Private payment: both methods clickable, real destinations | **LIVE VERIFIED** — #80, worker 903 |
| Private payment: legacy row never dropped in silence | **LIVE VERIFIED** — #81, worker 917 |
| Private payment: admin Settings screen | **LIVE VERIFIED** — #82/#84, portal 730 |
| Private payment: send-wizard toggles, independently selectable | **LIVE VERIFIED** — #85, portal 740 |
| Retainer ledger: AGREED / RECEIVED / OUTSTANDING, instalments, void-not-delete | **LIVE VERIFIED** — worker at master |
| Retainer payment idempotency (payment + token in one transaction) | **LIVE VERIFIED** — #107/#108/#110/#112/#114/#116/#118/#120 at `c4e96c4`; build.txt matches master, both deploys green, served page carries the token-keeping branch and the new-attempt recovery, which keeps the typed amount and refuses a blank one; worker 986, portal 780 |
| Private payment: lead-card Send Payment Options, standalone send, RETAINER PENDING / Record Payment, history | **CORRECTED 2026-08-15 — this row bundled four things in four different states and called them all NOT CODED.** Split: **RETAINER PENDING / Record Payment is LIVE VERIFIED** on the case Overview panel (`portal/index.html:2583`, `:2593`, idempotency proven across #107–#120) and must not be rebuilt — what is missing is the same state on the *leads* card. **History is PARTIAL**: `logPaymentSend()` writes `payment_send` (`worker.js:1431`, called at `:905`/`:928`) and **nothing ever reads it** — zero `FROM payment_send` in the Worker. **Lead-card Send Payment Options and the standalone send are genuinely NOT CODED** — queue items 2 and 3 |
| Private retainer: the agreed figure drives sheet, subject, email, payment block and preview | **DEPLOYED at `4e053c2`; page half LIVE VERIFIED, Worker half NOT** — the served page carries `wizSheetLoad` and `/sheets?case=`, and both deploys are green at master. The Worker's own output is **not externally observable** (auth runs before routing), so proving a real $3,000 case emails $3,000 needs an authenticated admin session — see the caveat above. CODED + TESTED: `agreedRetainer()` reads the case; `rateSheets(retainer)`, `sheetById(id, retainer)`, `paymentBlockText/Html(pay, retainer)` and `GET /sheets?case=` all take it, and the wizard re-reads the sheet for its case. Control run printed the bug verbatim: subject `$1,500 Retainer — … (case API-RET3K)` on a $3,000 case. Worker 997, portal 789 |
| Custom private retainer **selector** ($1,500 / $2,000 / $3,000 / Custom) | **NOT CODED**, but narrower than this row used to claim. It said *"nothing on screen sets it"*; a free-text **Retainer amount** box (`m_ret`, `portal/index.html:3993` → `POST /cases/:no/retainer`) does set it, on the case settings panel. Missing: the **four presets**, and the choice being available **in the private send flow**, which is where the owner's order puts it. Storage, route, guards and carry-through are all live — queue item 1 |
| Mobile menu button hit target | **LIVE VERIFIED** — #123 at `4e053c2`. Measured on the production page at 390px wide: **50x50**, up from the **38x35** the control reproduced (owner reported ~30px). Glyph left at 1.4rem; a test measures it at phone width |
| Real intake alerts | **NOT CODED** — requirements recorded in `INTAKE-OPS.md` §1 |
| Intake archive / sample cleanup | **NOT CODED** — part 1 recorded in `INTAKE-OPS.md` §2; **part 2 has not arrived** |
| Portal ops plan (nav, dashboard, tasks, search, contacts…) | **NOT CODED** — see `PORTAL-OPS.md`, phased |
| Activity edit/delete convention | **PARTIAL** — `activity_removed` shipped #55; audit against the requirement before building |
| Active Surveillance voice command mode | **NOT CODED** — spec recorded in `SURVEILLANCE-VOICE.md` (§1–16, five gaps listed); speech input, one activity API, activity_removed and caseFor already exist — audit before building |
| Page state does not cross a session boundary | **LIVE VERIFIED** — #120 at `c4e96c4`. `sessionForget()` on sign-out and on 401. Before it, the next sign-in on a shared machine landed in the **previous user's open case, drawn from the previous user's workspace data** — an investigator after an admin would see the client name and claim number `redactRow` withholds. The Worker was never wrong; the page kept an answer it had been given |
| Deploy allow-list + artifact test | **LIVE VERIFIED** — merged #75/#77/#78, deploy green at 936414b, build stamp matches, internal files 404 |


**Deployment is answerable in one request now.** `/.well-known/build.txt`
carries the live short SHA; compare it with `git rev-parse --short=7
origin/master`. Every row above marked LIVE VERIFIED was checked that way, or
by diffing the served page against master.

**Two visual findings carried forward from the owner, not yet actioned:**
desktop should read as a consistently dark/navy portal rather than a large
light canvas beside a dark sidebar; and mobile Active Surveillance should not
stack informational blocks before the investigator reaches usable controls —
compact status at the top, Quick Activity and Voice Mode high in thumb reach.

**Needs the owner, not code** (WORK-ORDER §0): the firm's **business** Cash App
and Venmo details — the handles in git history are personal accounts, so do not
recover them, do not seed defaults, do not invent a payment URL; and the three
Dropbox secrets.

**RESOLVED, not open (owner, 2026-08-15): the Virginia coverage wording.** Both
rate sheets already state that significant travel outside the normal service
area is quoted and approved before the work is scheduled, which is the promise
the wording was needed for. It is off the needs-owner list; do not put it back.

---

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

1. ~~**A running or open pause can record a real surveillance day as 0 hours.**~~
   ✅ **FIXED and VERIFIED 2026-08-14.** The claim was true, and was reproduced
   as a failing test *before* anything was changed — a real four-hour day
   recorded **0 hours**. An open pause is now closed at the instant the DAY
   ended (`case_days.created_at + span`, the server timestamp the field timer
   already trusts), clamped so it can close neither before it opened nor after
   now; and the paused total is **clamped to the span** instead of the
   difference being floored by `Math.max(0, …)`. A break inside the day still
   comes off it — asserted, so this cannot become a licence to stop subtracting
   breaks. `test-worker.mjs` → *"A break cannot eat the day it was taken inside
   of"*, 11 checks. Worker 809 → 820.
2. ~~**Reassigning a case can strand a running investigation day**~~ ✅ **FIXED
   and VERIFIED 2026-08-14.** True as reported, and reproduced first: reassign
   a case with a day running and every door shut at once — the old investigator
   failed `caseFor` (404), the new one and the admin failed the
   `investigator_id` match (409). `openDayForAction()` keeps the rule that made
   the scoping right — you can only stop your OWN clock — and adds the two
   doors that were missing: **your own running day stays yours** whether or not
   the case still is (the KEEP decision applied where it matters most — you
   started that clock and know when you stopped), and **an admin can close a day
   nobody else can reach**. A different investigator still cannot touch someone
   else's clock, and a caller with no claim on the case still gets 404, so
   nothing reveals whether a day is running on a case they cannot see. Hours
   stay credited to whoever worked them, not to whoever closed it.
   `test-worker.mjs` → *"A reassignment cannot strand a running day"*, 11
   checks. Worker 820 → 831.
3. ~~**A backward invoice status transition can reopen a paid invoice and
   remove it from Outstanding.**~~ ✅ **FIXED and VERIFIED 2026-08-14.** True:
   `sent_to_bill` and `sent_to_client` were guarded and `ready` validated only
   the CONTENT, but `draft` was guarded by nothing. `setInvoiceStatus` now
   refuses **both** unlocking statuses once any payment is recorded — `ready`
   as well as `draft`, since `ready` unlocks the same edits. The way back from a
   paid invoice is Void, which is deliberate, kept in the record and already
   releases the retainer it consumed; the refusal message says so. Back-to-draft
   with nothing received is untouched and still works. `test-worker.mjs` → *"An
   invoice with money against it cannot be put back to draft"*, 12 checks.
   Worker 831 → 843.
4. ~~**The Case Build finalize gate strip can be hidden when the package is
   actually ready to finalize**, so held-back material can ship with the warning
   suppressed.~~ ✅ **FIXED and VERIFIED 2026-08-14.** True as reported, and
   reproduced first: with the page reverted the gate/document assertions fail.
   The claim was also **understated** — an independent Codex review found the
   same material shipping through a **second door**, and that one mattered more.

   **The reproduction caught a worthless test.** The check guarding the outcome
   that matters — held-back material not printing — passed on the broken code,
   because it looked for the FILENAME, which the document renders only when an
   item has no note. It now counts exhibit rows in the printed index, which
   cannot pass vacuously. Expect this shape; it is the same failure the retainer
   bug had.

   **The fix.** The gates are no longer hidden on a finalized build (only the
   wording changes). The document prints only what is still cleared to ship and
   NAMES what it withheld, distinguishing material **held back** from material
   **deleted** — `buildState` drops deleted rows entirely, so calling a deleted
   file "no longer client-deliverable" sends the admin to the wrong problem.

   **Reclassifying after finalize stays allowed** — a guard refusing it would
   preserve the unsafe classification at the exact moment someone is withdrawing
   it. Instead every exit re-reads current state: printing re-reads the package
   first (and abandons rather than falling back on stale data), and **the
   delivery link is filtered too**. That was the second door: the document
   refused to print a held-back video while a Copy button beside it handed over
   the same file. It is now offered only while the evidence is IN the package and
   still cleared to ship — on the package panel and on `/completed`, which had
   not even honoured `deleted_at` though the evidence count beside it did.
   Membership is what makes the desk agree with the package panel, which always
   required it.

   **The first version of this fix then had a defect of its own**, caught by the
   Codex stop-time review: the withheld notice was rendered **inside `#pkgdoc`**,
   the only region the print stylesheet leaves visible — so the client's document
   was announcing "1 item withheld — no longer marked client-deliverable". A
   count of withheld exhibits discloses that evidence exists which was classified
   internal only, needs redaction or do not use, which is exactly what the
   classification withholds. The office still needs to know it is not shipping
   what it selected, so the notice moved to the package screen beside the gate
   strip; the document prints the deliverable material with contiguous numbers
   and explains no gap. `pkgShipping()` is now the single predicate behind both
   the filter and the count, so screen and document cannot disagree.

   `test-worker.mjs` completed-desk section, 6 new checks; `test-portal.mjs` →
   *"A finalized package still says when something has been held back"*, 21
   checks. Worker 843 → 849, portal 678 → 699. Three of those checks are the
   disclosure guards, and one is **structural** — no gate strip anywhere inside
   `#pkgdoc` — so it survives any rewording.

   **Left undone deliberately, not passed off as complete:** provider-side share
   revocation needs a Dropbox client that does not exist (blocked on the owner's
   three secrets) — this stops the portal OFFERING a link it should not, which is
   the half that can be got wrong today; and the video/index exhibit numbering
   contradicting itself inside one document is a **pre-existing LOW**, already in
   the findings table, untouched here.

**All four HIGH defects are now fixed and verified**, and so is the MEDIUM that
rode with 1 and 2: ~~every surveillance date is UTC while every surveillance time
is local~~ ✅ **FIXED and VERIFIED 2026-08-14.** True at all eleven sites, each
one a date a human means by "today" — the activity composer and its Custom tab,
the day panel, expenses, comms, tasks, the field day-start screen, the invoice
payment date, and the three submit paths posting `at_date` beside a local
`at_time`. `ymdLocal()` reads the local calendar date and sits beside `fmtDay()`,
which already guarded the return trip for the same reason.

Driven in **two real timezones** rather than by calling the helper, because the
bug was never in a helper — it was in what the screens rendered. UTC+14 and
UTC-11 bracket the clock, so whatever the hour a run starts at least one is on a
different calendar date from UTC, and a counter asserts that actually happened —
a green run can never mean "neither zone drifted today, so nothing was tested".
With the composer reverted the test reports the bug verbatim: date `2026-08-15`,
time `14:04`, local `2026-08-14`. Portal 699 → 713.

**Making both halves local was not enough**, and the Codex stop-time review
caught the remainder: in the field the TIME is stamped when an entry is
*started* and the DATE was taken when Save was finally *tapped* — two different
instants. Start an entry at 23:58, finish typing at 00:03, and it filed on the
new day carrying the old day's time, sorting ahead of everything that genuinely
came before it. The date now travels with the time from the moment it is
stamped (`SV.entry.date`, set at all three capture sites). Both day-start paths
were checked and are fine — they read date and time from fields rendered
together. Driven across a real rollover with the page clock held at 23:58 then
00:03; with the fix reverted the test reports `at_date 2026-08-11` beside
`at_time 23:58`.

**And one more, also from the stop-time review:** every pairing read the clock
**twice** — once for the date, once for the time — and two reads can fall either
side of midnight. Sub-millisecond, so it would never reproduce and would look
like a mystery if it fired: tomorrow's date beside last night's time. A fixed
test clock makes both reads identical, so **no behavioural test can reach it**;
`stampNow()` makes the invariant structural instead (one instant, both halves)
and a source-level guard fails if any pairing goes back to two reads. Date-only
and time-only readings are deliberately still allowed — an expense date has no
counterpart to disagree with.

**Three other uses of the pattern were examined and deliberately left:**
`worker.js:2462` is date arithmetic on a `YYYY-MM-DD` string, where UTC is stable
and correct; `visitor-alerts` buckets analytics by day inside a Worker that runs
in UTC; and intake's case **number** is an identifier minted on an arbitrary
client's clock, not a record of when work happened, so UTC is steadier there.

**The queue's next code item is item 5 below — the private-client payment work.**

**5. NEW FEATURE — private-client payment options and the onboarding send flow.**
**Two** owner work orders, 2026-08-14, both recorded verbatim in **`PAYMENTS.md`**
next to this file; the second is a superset of the first and governs where they
differ. Together they cover the payment configuration *and* the onboarding UX
around it: a Send Payment Options action on private lead cards, a readable NEXT
STEP block replacing the tiny gray helper text beside *Send this sheet →*,
independent Cash App / Venmo toggles revealed when Payment Options is ticked, a
standalone payment send that does not resend the sheet, one email carrying only
the sections actually selected, a RETAINER PENDING next-action state on a
returned intake, a sent confirmation listing exactly what went, and the same
clearer send area for Insurance **with no payment options on it at all**. 14
boundary regression tests are named, up from 7.

Two lines in the second order are load-bearing and easy to lose to a helpful
default: **never invent a payment URL from a handle** (a fabricated
`cash.app/$handle` that resolves to a real stranger sends a client's retainer to
the wrong person — the URL is admin-entered or absent), and **sending
instructions never marks the retainer paid**. It sits here, *after* the four HIGH defects, on the owner's own
instruction in the order itself: *"Do not abandon the current HIGH bug work to
rebuild this immediately if a higher-priority verified defect is already in
progress."* Each of 1–4 loses money or data silently; this adds a way to collect
it. In one line: an **admin-only** central configuration for Cash App and Venmo
(enabled · display name · handle · optional URL · optional instructions, and
**no credentials of any kind stored**), a *Include Private Payment Instructions*
option on the **private** send wizard beside the existing intake checkbox, a
PAYMENT OPTIONS block on the private rate sheet, and admin-recorded retainer
receipt. **Sending instructions must never mark the retainer paid** — it stays
RETAINER PENDING until an admin records it. The whole thing is **private-client
only**: never in the insurance sheet, the insurance intake, a carrier email, the
insurance send wizard, or any investigator view. The order names seven boundary
regression tests and a Codex review; both are part of the work, not optional
extras. $1,500 / $100 hr / 4-hour minimum do not change.

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

**Suites at last green (2026-08-14, branch `claude/arrival-sentence-generator`,
all four HIGH defects fixed):**

| Suite | Checks |
| --- | --- |
| `case-portal/test-worker.mjs` | **885** |
| `portal/test-portal.mjs` | **713** |
| `intake/test-intake.mjs` | **205** |
| `visitor-alerts/test-worker.mjs` | **47** |

### Still the owner's, not code's

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
above — worker 885, portal 713, intake 205, alerts 47. (This line used to repeat
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

### ⚖️ ~~OWNER DECISION~~ — SETTLED 2026-08-14: **KEEP**

**The owner chose Keep.** A reassigned investigator continues to see their own
previously submitted reports, expense claims, calendar history and active-day
records for a case that is no longer theirs. They worked those days and are owed
the record of their own pay and their own filed work.

**Keep is what the code already did, so nothing was rebuilt.** What was added is
a guard test, because a decision whose implementation is "no code" is exactly the
kind a later tidy-up silently reverses — someone reading `myReports()` and seeing
it ignore `assigned_to` could reasonably mistake it for a scoping bug and "fix"
it, destroying data the owner explicitly chose to keep.

`test-worker.mjs` → **"A reassigned investigator keeps their own work, never the
client"** (15 checks) asserts both halves, since Keep is only safe while the
second holds:

- **The work survives.** After reassignment the case 404s and leaves their list,
  but their worked day, their expense, a day still running and their calendar
  history all remain on `/my/reports`, `/my/expenses`, `/my/active`, `/calendar`.
- **The client does not.** None of those four payloads carries the carrier, claim
  number, policy number, adjuster name or email, billing email, or defense
  counsel. `subject_name` on a running day stays, because that is fieldwork.
- **A positive control** asserts the admin really is sent all nine of those
  values on the same case — without it the four leak assertions would pass just
  as happily on an empty payload or a renamed field, and prove nothing.

**Two open findings touch this decision and are NOT closed by it**, because Keep
answers what the *departing* investigator keeps, not these:

- **HIGH #2** (stranded running day) is the same routes seen from the other end.
  Keep says the old investigator still sees a day they left running; #2 says
  *nobody can close it*. Fixing #2 must not remove the visibility Keep requires.
- The LOW PERMISSIONS finding — *"the workspace scopes expenses, days and reports
  by case rather than by investigator, so a reassigned case shows the NEW
  investigator the previous one's money and hours"* — is the **mirror image** and
  is still open. Keep is about your own record following you; that finding is
  about someone else's pay being visible, which SURVEILLANCE P19 lists among the
  things to hide. Marked "may be intended" by its reviewer; it now needs an
  explicit owner answer of its own rather than being read as settled by Keep.

The question below is closed; it is kept as the reasoning behind the answer.

### ⚖️ The decision as it was originally put

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
| Do not invent coverage claims | ✅ **RESOLVED by the owner, 2026-08-15** | both rate sheets state that significant travel outside the normal service area is quoted and approved before the work is scheduled, which is the promise §29 wanted. No longer an owner decision; do not reopen it |

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
Chrome testing, and the Dropbox credentials. (The Virginia coverage wording
was RESOLVED by the owner on 2026-08-15 — see the top of this file.)

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

---

## 🆕 PRE-CASE SENDS — fixed 2026-08-15 (owner: blocking workflow defect)

**The portal blocked sending until a valid case number existed.** All five sends
now work with none: Private Intake, Private Rate Sheet, Private Payment Options,
Insurance Intake, Insurance Rate Sheet. **Name and a valid email are enough**;
case number, claim number and internal reference are optional when available.

The API mostly did not require a case — **the doors did.** The intake and the
payment options could only be reached from a lead card, so in practice someone
had to be on the desk before the office could email them anything, and the
intake is what turns a phone call into a lead. `POST /intake-link/email` is the
new pre-case route, `Send to someone new` on Rate sheets is the door, and
`GET /sends` is the history — which had to be added because every existing view
of a send hangs off a case, so a pre-case send was written correctly and then
invisible.

**Nothing is auto-created to have something to send against** (owner requirement
3), asserted by counting `submissions` across all ten sends.

**What did NOT relax:** the carrier sheet still cannot carry payment options at
all, and a reference that *does* resolve to a claim assignment is still refused
the consumer sheet and the payment instructions. The intake door is paired from
an **explicit kind**, never from a case lookup — which is a stronger thing to
rest the separation on than a lookup that may find nothing.

**Recorded honestly:** this reversed a refusal added hours earlier from a Codex
finding. A reference mistyped so badly it matches no row no longer trips the
claims check, because there is nothing to check against. The owner weighed that
against a workflow that could not send at all and chose this.

## ⚖️ CODEX DESIGN REVIEW of the send-context refactor (2026-08-15) — ALL RESOLVED

**Re-headed on the 2026-08-22 reconcile.** Two findings were fixed; findings 2
and 3 were **decided by the owner and accepted**, not left pending — the
summary below has said so in words since it was written, while the state
column still read "OPEN". Nothing in this table is queued work.

Run on the owner's instruction to *"review the DESIGN, not only the patch"*,
against `164fa1c`. **Recorded here rather than fixed, on the owner's
instruction not to open another review round in that unit.** These are Codex's
conclusions; the orchestrator has not independently re-derived them, which is
the standing rule for a reviewer's report.

| # | Finding | Codex's confidence | State |
| --- | --- | --- | --- |
| 1 | `paymentOptionsFor()` accepted no context, so the payment boundary rested on **call-site convention** rather than on the function handing out the methods. No exploit today; a fifth caller would have inherited nothing and looked correct | design weakness, no current exploit | ✅ **FIXED** before the instruction landed — the gate is in the function and fails closed on the `null` an omitted argument supplies. Two source-level guards assert it |
| 2 | **A real protection was lost.** An authenticated admin who omits or mistypes `case_no` can send Cash App/Venmo to an address already stored as a carrier contact. The old `recipientIsCarrier` blocked that; the new pairing refuses only when the reference actually resolves to a claims row | confirmed | ⚖️ **OWNER-DECIDED AND ACCEPTED**, not pending work. The owner chose this knowingly after four rounds; the deliberate consequence of removing recipient inference. Requires admin auth; not externally exploitable. The way back — a typed `recipient_kind` — is **unstarted and not to be started without the owner** |
| 3 | **Separation is weaker operationally, equal structurally.** The formal invariant (an insurance sheet can never contain payment) is unchanged. The broader goal — *a carrier never receives consumer payment instructions* — is weaker, because a route-labelled PRIVATE send with an absent or unresolved reference can now reach a known carrier email | confirmed | ⚖️ **OWNER-DECIDED AND ACCEPTED — same decision.** Not pending work |
| 4 | `/intake-link/email` and `/sheets/:id/email` take the product from the request, so an admin chooses it rather than the server deriving it independently | confirmed, not a payment issue | 🟡 **OPEN, judged acceptable** — neither route can reach a payment method by that choice, both are admin-only, and the alternative is the recipient inference the owner removed |
| 5 | The case-backed intake send bypassed `contextForKind` / `send_context` entirely | confirmed | ✅ **FIXED** — that was the separate stop-gate finding; the route is inside the model and fails closed on an unrecognised kind |

**The honest summary of 2 and 3, for whoever picks this up:** the refactor
removed four defects and one protection. The four defects were real and
recurring; the protection was real too. The owner chose this knowingly after
four rounds, and there is an owner-sanctioned way back to it that does **not**
reintroduce string matching — their own words: *"If durable recipient
classification is needed, use an explicit typed field or companion table per
repo migration rules."* A `recipient_kind` written when a contact is first
recorded would restore the protection as a typed fact rather than a guess.
**Not built, not started, and not to be started without the owner.**

## ✅ SHIPPED — OWNER WORKFLOW SIMPLIFICATION (queued 2026-08-15, closed 2026-08-22)

**This block said QUEUED until the 2026-08-22 reconcile, and every one of its
five parts had already shipped inside later units.** It was never referenced in
`FINAL-LEDGER.md`, so nothing had closed it — and a block reading QUEUED is
exactly how a later session rebuilds something that already exists. Checked
against the code rather than against memory:

| § | Part | Where it shipped |
| --- | --- | --- |
| 1 | Record Payment easy to reach | Four doors in `portal/index.html`, one of which carries the comment *"§1 — Make Record Payment easy to reach"* |
| 2 | Archive, and admin-only delete as a tombstone | `case_archive` and `case_deleted`, both documented in `CLAUDE.md` under *Case lifecycle*; Unit 39 widened the same model to eight more record types |
| 3 | Claim reference optional, assignment not required | Unit 36 audited requiredness off the validators — the claimant name **or** the claim number is the pair, and no route requires `assigned_to` |
| 4 | Both admin accounts see identical data | Admins are unscoped in the SQL; the role boundary is investigator-side only |
| 5 | Two admins in Active Surveillance on one case | `openDayForAction`'s `allowOthers`, `/day/end-other`, and the per-session pause index — `CLAUDE.md` records the design |

**Nothing here is outstanding.** The original text follows unchanged.

### The block as it was queued

Recorded verbatim in **`WORKFLOW-SIMPLIFICATION.md`** next to this file, on
arrival, before any of it was built. **Queued behind the current unit on the
owner's own instruction** — *"Queue this after the current unit."*

Five parts: manual payments and an easier Record Payment · archive plus an
admin-only Delete Permanently · claim reference optional and assignment not
required · both admin accounts seeing identical data · two admins in Active
Surveillance on one case at once.

**That transcript arrived truncated** and the reconstructed fragments are
bracketed in that file.

**All four open questions are now ANSWERED by the owner (2026-08-15)**, recorded
in the same file and governing:

- **Record Payment** reachable from the case header/summary, the Retainer/Payment
  card **and** the More menu — not another screen.
- **Delete is a tombstone, not a purge.** Evidence, reports, invoices, payment
  history and send/audit logs are never physically destroyed, and *"a true
  irreversible data purge is NOT needed now"*. The most dangerous item in the
  order is off the table.
- **ARCHIVED is a real new state**, separate from Completed and Cancelled:
  leaves active views, reachable under Archived, preserves everything,
  restorable.
- **Two-admin surveillance: one independent session per admin**, both running at
  once, both appending to the **same** case activity log. The safety rule stays —
  you can only stop or edit your own — and uniqueness constraints change *only as
  needed* so the lock is per admin/session rather than one global timer per case.

**§1 is largely built already** (the five methods, void-with-audit and the
never-marks-paid rule all exist), so the new part there is reachability.
**§3 and §4 both touch CHECK constraints or unique indexes** — a companion table
is the precedent, not an `ALTER TABLE`.
