# NEXT — session continuation state (INTERNAL)

**Purpose:** a fresh Claude Code session starts here. CLAUDE.md loads
automatically and carries the standing procedures (rebase dance after every
squash merge, portal-setup dispatch after schema changes, Actions-listing
overflow pattern, guard tests). This file is the live queue and in-flight
state. Update it when the queue moves; keep it short.

**`MASTER-HANDOFF.md` next to this file is the owner's consolidated source of
truth** (recorded verbatim 2026-08-13).

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

## 🚦 DEPLOYMENT MATRIX — 2026-08-15

**Nothing is complete until it is LIVE VERIFIED.** The states are CODED →
TESTED → PUSHED → MERGED → DEPLOYED → LIVE VERIFIED, and the words DONE,
SHIPPED and IMPLEMENTED mean the last of those, never the first.

This matrix exists because the two halves of the system drifted apart for four
days without anything saying so: `deploy-portal.yml` kept shipping the Worker
while `deploy.yml` failed, so the portal followed master and the public site
did not. Every suite passed the whole time.

| Component | Master SHA | Deployed SHA | Status | Verified at | How |
| --- | --- | --- | --- | --- | --- |
| Public site | `cd37d28` | **`cd37d28`** | **LIVE VERIFIED** | 2026-08-15, re-checked at session start after #124 | `/.well-known/build.txt` reports `commit: cd37d28`, `built: 2026-08-15T22:24:30Z` — **exactly master**. This repo can answer "what is live" without inference |
| `/portal/` page | `cd37d28` | `cd37d28` | **LIVE VERIFIED** | 2026-08-15, re-checked after #124 | served page fetched cache-busted: 200, 376 KB, headers `no-store`, `noindex, nofollow, noarchive`. Positive identifier check on the served bytes: `sessionForget` ✓, `wizSheetLoad` ✓, `retainerEnter` ✓, `m_ret` ✓. (`agreedRetainer` correctly absent — it is Worker-side.) The earlier negative check for `Cash App` / `Venmo` is **now stale and was removed**: the payment UI IS built, so their absence would be a defect, not a pass |
| Worker / API (`api-case-portal`) | `cd37d28` | `4e053c2` source | **DEPLOYED**, provenance-verified | 2026-08-15 | last commit touching `case-portal/worker.js` is `4e053c2`; `cd37d28` touched **only two `.md` files**, so nothing has changed the Worker since its last green deploy. The running source IS master's, established by provenance rather than by probing the instance |
| D1 schema (incl. `retainer_payment`, `retainer_payment_token`) | `cd37d28` | applied | **LIVE VERIFIED** | 2026-08-15 | last commit touching `schema.sql` is `35607d5`, well behind the last green portal deploy; `/portal-api/health` → `{"ok":true,"configured":true,"email":true,"missing_tables":[],"storage_pct":0}` |

**All four suites re-run at `cd37d28` this session, not inherited from the ledger:**

| Suite | Result |
| --- | --- |
| `case-portal/test-worker.mjs` | **997 passed, 0 failed** |
| `portal/test-portal.mjs` | **789 passed, 0 failed** |
| `intake/test-intake.mjs` | **205 passed, 0 failed** |
| `visitor-alerts/test-worker.mjs` | **47 passed, 0 failed** |

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
| 1 | Custom Private Retainer Selector | **CODED + TESTED**, awaiting merge — see below |
| 2 | Lead-card Send Payment Options | 🔴 NOT CODED — `PAYMENTS.md` step 9 |
| 3 | Standalone Payment Options dialog | 🔴 NOT CODED — step 12; `payment_send.with_sheet` is the seam |
| 4 | NEXT STEP helper block | 🔴 NOT CODED — steps 10 and 17 |
| 5 | Retainer Pending lead/intake actions | 🟡 PARTIAL — built on the case panel, absent from the leads card (step 15) |
| 6 | Real intake alerts / archive | 🔴 NOT CODED — `INTAKE-OPS.md` §1 and §2; **archive part 2 has never arrived** |
| 7 | Portal Ops Phase 1 onward | 🔴 NOT CODED — `PORTAL-OPS.md`, phased |
| 8 | Active Surveillance voice-command mode | 🔴 NOT CODED — **after core Portal Ops is stable**, owner's condition |

### Item 1 — Custom Private Retainer Selector: CODED + TESTED

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

## 📥 QUEUED — OWNER WORKFLOW SIMPLIFICATION (2026-08-15)

Recorded verbatim in **`WORKFLOW-SIMPLIFICATION.md`** next to this file, on
arrival, before any of it was built. **Queued behind the current unit on the
owner's own instruction** — *"Queue this after the current unit."*

Five parts: manual payments and an easier Record Payment · archive plus an
admin-only Delete Permanently · claim reference optional and assignment not
required · both admin accounts seeing identical data · two admins in Active
Surveillance on one case at once.

**That transcript arrived truncated** and the reconstructed fragments are
bracketed in that file. Three things to settle before building, all recorded
there: **§1 is largely built already** (the five methods, void-with-audit and
the never-marks-paid rule all exist — the new part may only be reachability);
**§2's Delete Permanently is the most dangerous item in the order** and needs its
blast radius decided, since everything else in this system is soft-delete on
purpose; and **§5 conflicts with a shipped invariant** — `openDayForAction()`
enforces that you can only stop your own clock, and one open pause per day is a
partial unique index, so two admins on one case needs a design decision first.
