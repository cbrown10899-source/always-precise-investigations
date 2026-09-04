# FUTURE — the five highest-impact things left, ranked (INTERNAL)

Written 2026-09-04, at the end of the closeout + revolution audit. **Nothing in
this file has been built.** It exists so the next unit starts from evidence
rather than from a fresh guess, and so the owner can choose an order.

It lives in `case-portal/` because that directory is excluded from the Pages
deploy — the same rule that keeps `PRICING.md` and every other internal note off
the public site. A root-level `FUTURE.md` would not publish either (the manifest
is an allow-list), but this is where internal planning already lives.

**Every claim below carries a file and a line.** Three of the owner's five
candidate ideas turned out to be *substantially already built*, and saying so is
the most valuable thing in this document — it is the difference between paying
for a feature once and paying for it twice.

---

## What is already there (checked, not assumed)

| The idea | Ground truth |
| --- | --- |
| "Automatic Daily Summary draft from timeline/activity" | **Built.** 26 `ds*` composer functions in `portal/index.html` (`dsCompose` :13069+, `dsActSentence`, `dsVehiclePhrase`, `dsOpening`, `dsClosing`) deterministically compose the paragraph from the day's recorded entries, and `case_day_summary` already stores it per day. What is missing is not the drafting — it is a **command that reaches it**. |
| "'Case Ready?' checklist — what is missing before package/build" | **Mostly built.** `closeoutFacts()` (`worker.js:5065`) derives the outstanding facts, and the Assistant already answers *"is this ready to close?"* (`worker.js:14837`) and *"package readiness"* (`worker.js:14849`) from it. What is missing is a **door on the screen where the packaging actually happens**. |
| "Universal command/search box across cases, clients, plates, phone numbers, invoices and tasks" | **Partly built.** `globalSearch` (`worker.js:2555`) covers cases, claim and matter numbers, client, carrier, subject name/alias/address/phone, vehicle make/model/colour/plate, firms and their people, saved profiles, and investigators. It reads **neither `invoices` nor `case_tasks`** — a mechanical, bounded gap. |
| "Field-mode speed for one-handed iPhone surveillance" | Partly. Tonight closed seven field defects. Two **MEDIUM** ones are named below and are the real remaining work. |
| "Portal performance — load concurrently after shell render" | **The big win is already taken.** `render()` paints the shell first and runs its eight fetches through `Promise.all` (measured 2072ms → 9ms at 250ms/call). What remains is small and is described in §5. |

---

## 1 — Assistant as Case Command Center

**Impact on investigator speed: HIGHEST · Development risk: HIGH · Complexity:
HIGH · Schema change: NO for the verbs, ONE column default for the audit row.**

This is the right next capability and it is also the only item here that
deliberately relaxes a safety property, so it must be built in stages with the
owner's explicit sign-off on each.

### What already works today

- **`open <name>'s case` is shipped.** `assistantCommandCore` (`worker.js:14640`) runs the real
  `globalSearch` as the signed-in caller and returns `{kind:'navigate'}` for one
  hit or `{kind:'choices'}` for several; the page executes it
  through `openCase` under `asstNavigate`. Zero hits says so.
- **The read verbs are shipped** — `unpaid`, `overdue`, `unassigned`,
  `reports due`, `ready to close`, `invoices`, `cases`, `today`, `surveillance`,
  `reports`, `clients`, `tasks` (all in `assistantTopicAnswer`, `worker.js:14311`), each a live read
  under its own role gate.
- **The confirmation shape already exists and is proven in production.** The
  workbench is form → `DRY RUN — READY TO SEND` preview → a second, explicit
  button (`asstPrepPrev` / `asstPrepSim`, `portal/index.html:2921`). A command center **replaces what the
  second button calls**; it does not need a new interaction model.
- **Model text can never become a route.** Navigation answers are registry ids
  (`ASSISTANT_NAV`, `worker.js:13506`) checked against the page's own allow-list
  (`portal/index.html:2842`). Keep this.
- **Deleted/archived gating already runs inside the Assistant** via
  `caseSendRefusal` in the intake, sheet and invoice planners.

### What is genuinely missing

1. **Any write path at all — by construction.** The `/assistant/*` block
   performs exactly ONE `INSERT`, into `assistant_log`, and a source test counts
   it. That pin *is* the Beta guarantee. Widening it is the decision, and it is
   the owner's, not the builder's.
2. **No server-side confirmation protocol.** `prepare-*` and `simulate-*` are
   independent routes; `simulate` re-runs the plan from the request body and
   never verifies the caller saw the preview. A command center needs a **nonce
   that ties "what you confirmed" to "what will run"** — otherwise the
   confirmation is decoration.
3. **No structured intent object for most verbs.** Only `prepare_intake`
   (`worker.js:14662`) and `prepare_sheet` (`:14682`) return machine-readable
   `form`; everything else returns rendered prose.
4. **The refusal list does not cover the new verbs.** Tonight added
   authorization; nothing covers starting or ending a surveillance day.
5. **`assistant_log.recipient` is `NOT NULL`** and `assistantLogged` binds
   `base.to` (`worker.js:13745`). A non-send command (start a day, build a
   package) would fail that insert and answer `logged:false`. **This is a column
   default, not a table rebuild** — but it must be settled before the first
   non-send verb executes, or the audit trail silently has holes.

### The verbs, and what each would cost

Every writer below already exists; the command center calls it rather than
reimplementing it.

| Command | Existing writer | Idempotency today | Schema |
| --- | --- | --- | --- |
| open / show unpaid / overdue / unassigned / reports due / ready to close | — | — | works now |
| start surveillance · end the day | `startDay` (`worker.js:7090`), `/day/end`, `/day/end-other` | `idx_days_open_one` guards a double start at the database | none |
| record payment | `/cases/:no/retainer/payment`, `recordInvoicePayment` (`:8822`) | `client_token` already there | none |
| create the draft invoice | `createInvoice` (`:8528`) | — | none |
| send this intake · send the rate sheet | `emailSheet` (`:1601`), `/leads/:no/send-intake`, `/intake-link/email` | the Assistant's plan already reproduces subject and body **byte for byte** (the A11 pin) | none |
| build / open the case package | `/build/*` | — | none |
| draft today's summary (saved) | `case_day_summary` exists | — | none — see §2 |

### The boundary, stated as a rule

> **READ, NAVIGATE and DRAFT are free within the caller's existing permissions.
> SEND, DELETE, RECORD PAYMENT, CHANGE CASE STATE and START/STOP SURVEILLANCE
> require an explicit confirmation step, server-side, bound to a preview the
> caller actually saw.**

"Server-side" is the load-bearing half. A page that declines to draw a button is
not a boundary — that lesson is written into `FIELD_KEEP`, the role scoping and
the deleted/archived chokepoint, and it applies here unchanged.

### Recommended staging

- **1a — Confirmation protocol first, with NO new verbs.** Add the nonce and
  the structured intent object, and route the two rehearsals that already exist
  (intake, rate sheet) through them. Nothing new can be done; the machinery that
  will do it becomes testable. Fix the `recipient` default here.
- **1b — One verb, chosen because it is reversible and idempotent:** *start /
  end a surveillance day.* The database already refuses a duplicate open day,
  and ending a day is recorded with who did it (`case_day_end`, `dayEndLabel`).
- **1c — The send verbs**, which are the highest value and the least
  reversible. Their plans are already byte-pinned to the real senders.
- **1d — Money.** Last, and only after 1a–1c have run in real use.

---

## 2 — "Draft today's Daily Summary" as a command

**Impact: HIGH · Risk: MEDIUM · Complexity: MEDIUM-LOW · Schema change: NO.**

This is the daily paperwork, and it is the single most repeated writing task in
the business.

**The engine exists and it is in the PAGE, not the Worker.** That is not a
problem — it is the shortcut. The Assistant panel runs *inside* the page, so
the smallest honest build is:

> the Worker recognises the intent and answers with a structured
> `{kind:'draft_day_summary', case_no, day_id}`; the **page** runs the existing
> `dsCompose`, opens the Daily Summary builder pre-filled, and the admin reads
> it and presses Save.

That keeps one composer (`CLAUDE.md`'s standing rule: two renderings of one
thing drift, and the one that drifts is the one nobody is looking at), needs no
server-side duplication of 26 functions, needs no schema change, and **the human
still writes the record** — the paragraph is authored material and the builder
already treats it that way (typing claims it, `manual`).

Duplicating `dsCompose` into the Worker is the alternative, and it is worse for
exactly the reason above. Do not do it unless a non-page consumer appears.

---

## 3 — Search that covers invoices and tasks

**Impact: MEDIUM-HIGH · Risk: LOW · Complexity: LOW · Schema change: NO.**

Two more arms in `globalSearch`, written to the rules the existing eleven
already follow:

- bounded by `SEARCH_ARM_CAP` / `SEARCH_TOTAL_CAP`;
- **no statement grows with the customer's data** (the D1 bound-parameter
  lesson from Unit 7);
- the role boundary applied by **not running the arm** — invoices are the
  paying side and must not run for an investigator, exactly as the client's
  phone and the firm's people do not;
- `invoice_no` matched by prefix (indexed); task title by substring, which no
  index can serve, and `SEARCH-INDEXING` should say so rather than imply
  otherwise.

This is the best value-per-risk item on the list and the natural warm-up if the
owner wants something shipped before starting §1.

---

## 4 — "Case Ready?" where the packaging happens

**Impact: MEDIUM · Risk: LOW · Complexity: LOW · Schema change: NO.**

`closeoutFacts` already derives it and the Assistant already answers it. What is
missing is that an admin assembling a package has to *think to ask*. Put the
same derivation on the Package panel as a short, factual list — *"1 report is
not signed off · 2 files are still Needs review · the invoice shows a balance of
$450.00"* — with each line linking to the screen that fixes it.

Two rules carry over unchanged and are why this is cheap: the facts are worded
as **facts, never conclusions**, and a case with nothing to say **says
nothing**. Do not add a second gate; the finalize gate is the gate.

---

## 5 — Field-mode speed, and the last of the performance work

**Impact: HIGH for the investigator · Risk: LOW-MEDIUM · Complexity: MEDIUM ·
Schema change: NO.**

Tonight fixed seven field defects. **Two MEDIUM ones remain, both found and
both deliberately not fixed tonight because they need a suite run rather than a
one-line edit:**

- **With voice mode ON, anything being typed anywhere in the field view is
  destroyed every few seconds.** Recognition is one-shot and restarts on `end`,
  and every engine event calls `paint()` (`portal/index.html` — every engine event in `svVoice`), so
  the description, time, location, vehicle and note boxes are rebuilt from `SV`
  several times a minute. Nothing collects them first — the `EDIT_DRAFT` rule is
  not applied in the field view. **Fix:** an `svCollect()` before repaint, the
  shape `vstCollect`/`pstCollect`/`edCollect` already use.
- **Every confirmation and refusal in the field view is silent to a screen
  reader.** Both SV branches of `paint()` return before `announceRendered()`
  (`portal/index.html:11412-11413`), which also makes `srScreen()`'s own `if(SV)`
  branch unreachable. This is the Unit 21A defect at a third branch; the page
  already says it meant to cover this.

**Performance:** the shell-first paint took the large win. What is left is
per-panel: `loadPackages`/`loadCompleted`/`loadRecent` are deliberately
fire-and-forget and self-paint, which is correct. There is **no other function
that awaits several independent calls in sequence before painting** — that was
checked mechanically, not assumed. Treat portal performance as done unless a
measurement says otherwise.

---

## Implementation order, if the owner wants one

1. **§3 — search over invoices and tasks.** Small, bounded, immediately useful,
   and it exercises nothing dangerous.
2. **§4 — Case Ready on the package panel.** Reuses a derivation that exists.
3. **§2 — draft today's summary, page-side.** The daily paperwork, with the
   human still authoring.
4. **§5 — the two field MEDIUMs.** Both are correctness, not features.
5. **§1a → 1b → 1c → 1d — the command center**, one stage at a time, each with
   the owner's sign-off, because 1a is where the Beta guarantee is deliberately
   relaxed.

That order front-loads value and puts the only genuinely risky work last, after
the machinery it depends on has been in real use.

---

## What NOT to do

- **Do not enable Bill.com** until the owner says the account is ready.
- **Do not add SMS** — no provider is configured and `alertDelivery()` says so
  honestly. Adding one means a credential and a sender beside `sendMail()`,
  never editing that function to claim yes.
- **Do not make the payment `client_token` mandatory** and **do not add the
  used-case-number tombstone table** — both remain deferred by the owner.
- **Do not build a purge.** Nothing in this portal destroys anything, and that
  is a decision, not an omission.
- **Do not duplicate `dsCompose` server-side** without a second consumer.
- **Do not "simplify" `assistantSheetPlan`** into a shared resolver with
  `emailSheet`. It is a deliberately pinned mirror; the suite holds the two
  together byte for byte.
- **Do not re-expand the location pages.** Six markets is deliberate.
- **The homepage and its three card images are FINAL.**
