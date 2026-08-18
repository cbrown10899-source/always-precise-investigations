# NEXT — session continuation state (INTERNAL)

**Purpose:** a fresh Claude Code session starts here. CLAUDE.md loads
automatically and carries the standing procedures (rebase dance after every
squash merge, portal-setup dispatch after schema changes, Actions-listing
overflow pattern, guard tests). This file is the live queue and in-flight
state. Update it when the queue moves; keep it short.

**`MASTER-HANDOFF.md` next to this file is the owner's consolidated source of
truth** (recorded verbatim 2026-08-13).

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

## 🔴 OPEN FINDINGS — Codex DESIGN review of the send-context refactor (2026-08-15)

Run on the owner's instruction to *"review the DESIGN, not only the patch"*,
against `164fa1c`. **Recorded here rather than fixed, on the owner's
instruction not to open another review round in that unit.** These are Codex's
conclusions; the orchestrator has not independently re-derived them, which is
the standing rule for a reviewer's report.

| # | Finding | Codex's confidence | State |
| --- | --- | --- | --- |
| 1 | `paymentOptionsFor()` accepted no context, so the payment boundary rested on **call-site convention** rather than on the function handing out the methods. No exploit today; a fifth caller would have inherited nothing and looked correct | design weakness, no current exploit | ✅ **FIXED** before the instruction landed — the gate is in the function and fails closed on the `null` an omitted argument supplies. Two source-level guards assert it |
| 2 | **A real protection was lost.** An authenticated admin who omits or mistypes `case_no` can send Cash App/Venmo to an address already stored as a carrier contact. The old `recipientIsCarrier` blocked that; the new pairing refuses only when the reference actually resolves to a claims row | confirmed | 🔴 **OPEN — owner decision.** This is the deliberate consequence of removing recipient inference. Requires admin auth; not externally exploitable |
| 3 | **Separation is weaker operationally, equal structurally.** The formal invariant (an insurance sheet can never contain payment) is unchanged. The broader goal — *a carrier never receives consumer payment instructions* — is weaker, because a route-labelled PRIVATE send with an absent or unresolved reference can now reach a known carrier email | confirmed | 🔴 **OPEN — same decision** |
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

## 📥 QUEUED — OWNER WORKFLOW SIMPLIFICATION (2026-08-15)

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
