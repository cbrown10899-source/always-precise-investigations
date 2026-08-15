# Private Client Payment Options — Cash App + Venmo (INTERNAL)

**Recorded VERBATIM from the owner's handoff, 2026-08-14.** Lives in
`case-portal/` because this directory never deploys — and doubly so here, since
the whole point of the feature is that payment handles are configured, not
published.

**Queue position (owner's own instruction, in the handoff below):** *"Do not
abandon the current HIGH bug work to rebuild this immediately if a higher-
priority verified defect is already in progress."* So this sits **after the four
HIGH defects** in `RECONCILIATION.md`'s HIGH QUEUE — each of which loses money or
data silently — and before the MEDIUM/LOW backlog.

## ⚠️ OWNER ADDITION, 2026-08-15 — CUSTOM PRIVATE RETAINER (parts 1 and 2)

**Private-client retainers are not always $1,500.**

Before sending a **private** rate sheet or intake, an admin must be able to
choose the retainer:

- **$1,500 Standard**
- **$2,000**
- **$3,000**
- **Custom Amount…**

Choosing Custom Amount shows a **CUSTOM RETAINER [ amount ]** field, validated
as a **positive dollar amount**.

**The selected amount becomes the AGREED RETAINER for that specific private
client/case.**

**Do not change $100/hour or the 4-hour minimum.**
**Do not add this selector to Insurance workflows.**

### Part 2 of 2 — carry the agreed retainer through the whole private flow

The selected retainer travels with everything the private flow sends.

Admin selects **Retainer = $2,000**, then sends the Private Rate Sheet, the
Intake Form and Payment Options. **The client-facing Private Rate Sheet must
show `RETAINER: $2,000`**, and **the intake/send record must preserve that same
agreed amount.**

| Selected | Preserved |
| --- | --- |
| Standard | $1,500 |
| $2,000 | $2,000 |
| $3,000 | $3,000 |
| Custom $2,500 | $2,500 |

**RECORD PAYMENT MUST NEVER RESET THE AGREED RETAINER:**

```
AGREED RETAINER   $3,000
RECEIVED          $2,000
REMAINING         $1,000
```

**Sending Cash App/Venmo instructions does NOT count as payment received.**

Allowed received-payment methods remain exactly: **Cash App · Venmo · Check ·
Cash · ACH / BILL.**

**Tests required:** each preset works · custom amount works · rate sheet
displays the selected amount · returned intake preserves the selected amount ·
**partial payments calculate correctly** · Record Payment never resets the
agreed retainer · Insurance never sees this selector.

### State of this selector, audited 2026-08-15 — reader's note, not owner instruction

**Part 2 is done. Part 1 is not.** The two were recorded together and are easy
to read as one item; they are not.

- **The agreed figure is carried everywhere it is read** — `agreedRetainer()`
  `worker.js:461` reads `case_retainer.retainer_amount` and falls back to
  `PERSONAL.retainer` only when the case has none; `rateSheets(retainer)`,
  `sheetById(id, retainer)`, `paymentBlockText/Html(pay, retainer)` and
  `GET /sheets?case=` all take it, and the send re-reads it for its own case at
  `worker.js:847` **before** building the sheet. **DEPLOYED at `4e053c2`.**
- **What sets it today is one free-text box**, not the preset selector. `m_ret`
  (`portal/index.html:3993`) sits on the private case's settings panel — value
  only, no `$1,500 / $2,000 / $3,000 / Custom` presets, no validation beyond the
  Worker's, and **it is on the case panel rather than in the private send flow**,
  which is where the owner's order puts the choice: *"Before sending a private
  rate sheet or intake, an admin must be able to choose the retainer."*

So this is **not** a from-scratch build and must not be treated as one. The
storage, the route, the guards and the whole carry-through are live. What is
missing is the **control in the send flow** — and `NEXT.md` previously said
"nothing on screen sets it", which overstated the gap and would have sent
someone looking for a route that already exists.

### Two things part 2 settles, and one it creates — reader's note

It settles the open question from part 1: the agreed amount is a property of the
**case**, and it must also ride with the **send**, because the sheet the client
receives has to show it.

It also confirms the fix already shipped in #97/#98 — *Record Payment must never
reset the agreed retainer* is exactly the defect found there, so that work
stands rather than needing redoing.

**What it creates: "REMAINING" now means something new.** Today
`retainer.remaining` is *agreed minus work applied* — how much of the client's
money the recorded hours have not yet consumed. The owner's block means *agreed
minus received* — how much of the retainer the client still owes. **Those are
different numbers and both are wanted:**

| Figure | Means | Exists? |
| --- | --- | --- |
| Agreed | what the client agreed to pay | ✅ `case_retainer.retainer_amount` |
| Received | what has actually arrived | partly — one receipt row |
| Remaining (owed) | agreed − received | ❌ new |
| Applied | work billed against it | ✅ |
| Remaining (unused) | agreed − applied | ✅ — must not be renamed |

Naming both "remaining" on one screen would be a money bug waiting to happen.

**And partial payments imply more than one payment.** `retainer_receipt` is
keyed by `case_no`, so it holds exactly one — a second payment overwrites the
first, and "received" would report the last instalment rather than the total.
Supporting instalments needs a payment **log** keyed by id with
`received = SUM(amount)`. That is a schema decision, and the standing rule
applies: a new table, not an altered one.

### What this touches — reader's note, not owner instruction

`PERSONAL.retainer` (1500) is a **constant** used in three places, and two of
them are client-facing:

1. `rateSheets()` builds the private sheet's name, summary and "Retainer to
   begin" line from it — so a case agreed at $3,000 would email the client a
   sheet saying $1,500.
2. `paymentBlockText`/`paymentBlockHtml` print "A $1,500 retainer is required to
   begin investigative services" in the payment-options block of that same
   email.
3. The retainer route uses it as the default for a case with no retainer row,
   which stays correct and should not change.

So the agreed figure has to reach **the sheet and the payment block at send
time**, not only the case record. The storage already exists —
`case_retainer.retainer_amount` holds a per-case amount and `retainerBlock`
reads it — so what is missing is the selector and the plumbing into those two
builders.

**One thing part 2 should settle rather than have me assume:** the wizard can
send a sheet against a **lead**, which may have no case row yet. Whether
choosing a retainer there writes `case_retainer` immediately, or only rides
along with that one email, decides whether the agreed retainer is a property of
the **case** or of the **send**. The owner's phrasing — *"becomes the AGREED
RETAINER for that specific private client/case"* — reads as the former.

## ⚠️ OWNER CORRECTION, 2026-08-15 — the accepted payment methods

**Credit Card and Other are REMOVED.** The Record Payment methods are exactly:

**Cash App · Venmo · Check · Cash · ACH / BILL**

Both verbatim handoffs below list Credit Card and Other; **this correction is
later and governs.** The handoffs are not edited — they are the record of what
was asked for, and rewriting them would destroy the only copy of that.

The firm does not accept the two that were removed. Offering a method it cannot
take invites a client to try paying by one, and that failure lands on the client
mid-retainer while the office only learns of it when the money never arrives.
"Other" is worse than useless in a payment record: it states that money came in
by a means nobody wrote down, which is the precise thing a payment record exists
to prevent.

Enforced in `RETAINER_METHODS` (`worker.js`), with a test asserting each of the
five is accepted and that `card` and `other` are refused.

## ⚠️ LEDGER CORRECTED 2026-08-15 — it was understating the build by eight steps

**This ledger said steps 1–8 were "not started". Seven of them are shipped and
on master.** It was never updated as #80–#85 landed, so a fresh session reading
it would have rebuilt an admin settings screen, a wizard section and an email
builder that already exist — which is precisely what the owner's *"do not
rebuild already-completed UI"* forbids.

The correction below was made by grepping the identifiers, not by reading PR
titles. Each row carries the route, the function or the table that is the
evidence. **The same audit corrected `NEXT.md` in the same direction**; see the
matching note there.

States are the owner's: **CODED → TESTED → PUSHED → MERGED → DEPLOYED → LIVE
VERIFIED.** Nothing here is called LIVE VERIFIED unless something outside this
repo was observed. Worker-side email content **cannot** reach LIVE VERIFIED by
probing — authentication runs before routing, so the Worker's output is not
externally observable, and those rows stop at DEPLOYED on purpose.

Progress ledger — first handoff, steps 1–8:

| Step | State | Evidence |
| --- | --- | --- |
| 1. Central admin-only payment-method configuration | **LIVE VERIFIED** | `payment_methods` table; `paymentConfig()` `worker.js:608`; admin-only `GET /payment-methods` `:4693` and `PUT /payment-methods/:id` `:4698`; `paymentSettingsHtml()` `portal/index.html:2039`. Verified live #82/#84 |
| 2. Private rate sheet PAYMENT OPTIONS section | **DEPLOYED** | `paymentBlockText()` `worker.js:1137`, `paymentBlockHtml()` `:1158`, both spliced into `sheetEmail()` at `:1196` / `:1221`. Worker-side — not externally observable |
| 3. Private send wizard "Include Private Payment Instructions" | **LIVE VERIFIED** | `wizPaymentHtml()` `portal/index.html:1741`; `include_payment` `worker.js:865`; **refused, not dropped**, on the insurance sheet at `:867` |
| 4. Email preview shows sheet / intake / payment instructions | **DEPLOYED** | preview `<dt>Payment options</dt>` `portal/index.html:1818`, with the standing line that sending does not mark the retainer paid at `:1826` |
| 5. Retainer status + record-a-payment fields | **LIVE VERIFIED** | `recordRetainerPayment()` `portal/index.html:2120`; `RETAINER_METHOD_OPTIONS` `:2608`; `RETAINER_METHODS` `worker.js:442`; `POST /cases/:no/retainer/payment` `:5241` and its void at `:5287`. Idempotency verified live across #107–#120 |
| 6. Case history events | 🟡 **PARTIAL — written, never read** | `logPaymentSend()` `worker.js:1431` writes `payment_send`, called at `:905` (failed send) and `:928` (successful). There is **zero `FROM payment_send`** anywhere in the Worker. The record is being kept correctly and nothing surfaces it in the comm log or case history |
| 7. The seven boundary regression tests | **TESTED** | three named sections in `test-worker.mjs`: *"Both payment methods are clickable, with the firm's own destinations"* `:4166`, *"Private-client payment methods are the office's own configuration"* `:4324`, *"Payment instructions ride with the private client and no one else"* `:4422` |
| 8. Codex independent review of the boundary | **NO EVIDENCE EITHER WAY** | no session record says this was run against the merged boundary. Treated as outstanding rather than assumed done — the wrong assumption here is the expensive one |

## Notes taken while recording, not owner instructions

These are the reader's, flagged as such so a later session does not mistake them
for the handoff:

- **`FIRM` in `intake/index.html` already holds Venmo and Cash App handles**, and
  CLAUDE.md flags them as still being personal accounts to be swapped for
  business accounts before client use. That is the existing hard-coded copy the
  handoff's *"do not hard-code handles in multiple templates"* is aimed at.
  Whether the new admin config supersedes `FIRM`, or the two coexist, is a
  decision to make deliberately at build time — not to drift into.
- **"No dollar figure in the portal or intake HTML" is guarded by tests.** The
  payment section carries the $1,500 retainer, which already appears in the
  Worker's `PERSONAL` rate sheet, so the sheet is the right home for it. Take
  care that nothing lands in `intake/index.html`, where a guard test fails on a
  dollar figure.
- **Escaping**: handles are admin-entered and rendered into both an HTML email
  part and a page. Requirement 7.6 asks for this explicitly.

---

## THE HANDOFF, VERBATIM

ADD THIS TO THE CURRENT ALWAYS PRECISE BUILD QUEUE

PRIVATE CLIENT PAYMENT OPTIONS — CASH APP + VENMO

Integrate this into the existing Private Client rate-sheet / intake / retainer workflow without disrupting current work.

IMPORTANT:
This is PRIVATE CLIENT ONLY.

Do not expose Cash App or Venmo in:
- Insurance Assignment Rate Sheet
- Insurance Intake
- carrier/TPA emails
- Insurance send wizard
- investigator views

==================================================
1. PRIVATE RATE SHEET SEND FLOW
==================================================

When Admin sends:

PRIVATE CLIENT — $1,500 RETAINER

the send wizard should support:

☐ Include Private Client Intake Form
☐ Include Private Payment Instructions

If Private Payment Instructions is selected, the client email/page should include the enabled private payment methods.

Payment methods initially supported:

- Cash App
- Venmo

Do not hard-code handles in multiple templates.

==================================================
2. CENTRAL ADMIN CONFIGURATION
==================================================

Create/reuse an Admin-only settings section:

PRIVATE CLIENT PAYMENT METHODS

Cash App:
- Enabled
- Display Name
- Payment Handle
- Optional Payment URL
- Optional Instructions

Venmo:
- Enabled
- Display Name
- Payment Handle
- Optional Payment URL
- Optional Instructions

The actual payment handles should be entered through Admin configuration rather than duplicated throughout source code.

Do not store passwords, access tokens, login credentials, or payment-account secrets.

==================================================
3. PRIVATE RATE SHEET
==================================================

Add a clean section near the retainer / next-step area:

PAYMENT OPTIONS

Suggested client-facing structure:

$1,500 RETAINER

To begin the investigation, the required retainer may be submitted using one of the approved payment methods below.

CASH APP
[configured identifier]

VENMO
[configured identifier]

Then:

After payment, complete the Private Client Intake Form if it has not already been submitted.

Keep this visually clean and consistent with the current rate sheet.

Do not change:
- $1,500 retainer
- $100/hr rate
- 4-hour minimum

==================================================
4. EMAIL PREVIEW
==================================================

Private send preview should show:

Rate Sheet:
Private Client — $1,500 Retainer

Intake:
Included / Not Included

Payment Instructions:
Cash App + Venmo
or
Not Included

Only enabled payment methods should appear.

==================================================
5. PAYMENT STATUS
==================================================

Sending payment instructions must NEVER automatically mark the retainer as paid.

Keep:

RETAINER PENDING

until Admin confirms payment.

Admin should be able to record:

- Retainer Requested
- Retainer Received
- Amount Received
- Payment Method
- Payment Date
- Reference / Note

Payment Method choices:

- Cash App
- Venmo
- Check
- Cash
- Credit Card
- ACH / BILL
- Other

==================================================
6. CLIENT RECORD / CASE HISTORY
==================================================

Record relevant events such as:

Private Rate Sheet Sent
Private Intake Included
Payment Instructions Included
Retainer Marked Received
Payment Method
Payment Date

Do not expose internal payment notes to investigators.

==================================================
7. STRICT BOUNDARY TESTS
==================================================

Add regression tests proving:

1. Cash App/Venmo can appear in the Private Client rate-sheet send flow.
2. Cash App/Venmo cannot appear in Insurance rate-sheet emails.
3. Cash App/Venmo cannot appear in Insurance Intake.
4. Payment instructions being sent do not mark the retainer paid.
5. Disabled payment methods do not render.
6. Payment handles are safely escaped.
7. Investigator/non-admin routes cannot access Admin payment configuration.

==================================================
8. CODEX REVIEW
==================================================

Have Codex independently review:

- Private vs Insurance payment boundary
- payment-status logic
- Admin permissions
- accidental payment credential exposure
- unsafe HTML/output escaping
- regression-test coverage

Preserve the current project priority queue.

Do not abandon the current HIGH bug work to rebuild this immediately if a higher-priority verified defect is already in progress.

Add this to NEXT.md / RECONCILIATION.md and implement it at the correct point in the existing queue.

Continue automatically after the currently active verified task is green.

---

## SECOND HANDOFF, VERBATIM — recorded 2026-08-14

**A continuation and superset of the order above, sent later the same day.** It
repeats the queue instruction — the four HIGH defects first — and adds the lead
card, the send-CTA wording, a standalone payment send, the one-email onboarding
flow, the client email layout, clickable payment links, the returned-intake next
action, the sent confirmation, and a matched Insurance send-area UX that must
still show no payment options at all. Its test list grows from 7 items to 14.

**Where the two orders differ, this one governs**, being later and more
specific. The first order's ledger tracks steps 1–8; the additions are here:

**Corrected 2026-08-15 by the same audit** — five of these ten were shipped too.

| Step | State | Evidence |
| --- | --- | --- |
| 9. Private lead card: Send Payment Options action | 🔴 **NOT CODED** | the card carries `leadSheet` and `leadIntake` only — `portal/index.html:1613-1614`. **Next in the queue** |
| 10. Private rate-sheet NEXT STEP helper block (not a gray footnote) | 🔴 **NOT CODED** | the three `Next step` strings in the page (`:1267`, `:4137`, `:4692`) are the case-health next step and two panel headings, none of them the send-area block this asks for |
| 11. Wizard: Payment Options reveals independent Cash App / Venmo toggles | **LIVE VERIFIED** | `SHEET_WIZ.payMethods` `portal/index.html:1736`, `wizPaymentSendable()` `:1722`. Verified live #85 |
| 12. Standalone Send Payment Options dialog | 🔴 **NOT CODED** | both `logPaymentSend()` calls pass `with_sheet: 1` (`worker.js:906`, `:929`). No `with_sheet: 0` path exists anywhere — **the column was added in anticipation of this step and is the seam to build against** |
| 13. One email carrying sheet + intake + payment, sections only when selected | **DEPLOYED** | `sheetEmail(sheet, note, includeIntake, payment, retainer)` `worker.js:895`; each section renders only on its own flag |
| 14. Clickable payment links — never an invented URL | **DEPLOYED**, and structurally enforced | `paymentOptionsFor()` offers only a method with an **admin-entered** link, and `worker.js:879-885` **refuses the whole send by name** when an enabled method has none — *"switched on but has no payment link… Add a link in Settings, or switch it off"*. The rule is not a convention here; there is no code path that can derive a URL from a handle |
| 15. Returned-intake card: RETAINER PENDING + next actions | 🟡 **PARTIAL** | Retainer pending (`portal/index.html:2583`) and Record Payment (`:2593`) are built **on the case Overview panel**. The Leads & Intakes card has neither, which is the surface §10 of the second handoff actually names |
| 16. Sent confirmation listing exactly what went | **DEPLOYED** | Worker returns `included{rate_sheet, intake, payment_methods}` `worker.js:934-939`; the page reads it back at `portal/index.html:6087-6094` and appends *"The retainer is still pending until you record it."* Read from the send record, not echoed from the form — as the reader's note below required |
| 17. Insurance send area: same clearer UX, still no payment options | 🟡 **PARTIAL** | the **no-payment half is enforced and loud** (`worker.js:867` refuses rather than drops). The *clearer UX* half is step 10 and is not built |
| 18. The 14 boundary regression tests | 🟡 **PARTIAL** | the three sections at `test-worker.mjs:4166` / `:4324` / `:4422` cover the boundary that exists. The checks for items 9, 10 and 12 cannot exist yet — they ride with those builds |

### Reader's note, not an owner instruction

Item 7 — *"If only a handle/username exists and no safe direct payment URL is
configured: show the handle clearly instead of inventing a URL. Do not create
fake payment links."* — is the sharpest line in this order and the easiest to
lose to a helpful default. A fabricated `cash.app/$handle` that happens to
resolve to a real stranger sends a client's retainer to the wrong person. Treat
the URL as strictly admin-entered, never derived from the handle.

A second one worth flagging before building: item 13's confirmation lists what
was sent, and `send_log` (shipped #67) already records recipient, sheet and
**which door rode with it**. The confirmation should be read back from that
record rather than from the form that was just submitted — otherwise it reports
what was *asked for* rather than what actually went, which is the same class of
mistake as marking a retainer paid because instructions were sent.

---

PRIVATE CLIENT ONBOARDING SEND FLOW — PAYMENT OPTIONS + CLEAR NEXT-STEP UX

Add this to the current Always Precise build queue.

This is a continuation of the previously requested Private Client Cash App / Venmo payment-options work.

Do not disrupt current HIGH-priority verified bug work if it is already in progress. Queue this immediately after those higher-priority defects.

IMPORTANT:
This is PRIVATE CLIENT ONLY.

Do NOT expose Cash App or Venmo in:
- Insurance Assignment Rate Sheet
- Insurance Intake
- carrier/TPA emails
- Insurance send wizard
- investigator views

==================================================
1. PRIVATE LEAD CARD
==================================================

For PRIVATE leads, actions should include:

REVIEW
MESSAGE
SEND RATE SHEET
SEND INTAKE
SEND PAYMENT OPTIONS
ACCEPT

Use the current visual style.

Do not overcrowd the card. If needed, group send actions under a compact SEND menu, but keep:
- Send Rate Sheet
- Send Intake
- Send Payment Options

obvious and easy to reach.

Insurance cards must never show Private Payment Options.

==================================================
2. PRIVATE RATE SHEET SEND CTA — MAKE NEXT STEP OBVIOUS
==================================================

On the Private Client $1,500 Retainer rate-sheet page, improve the bottom send area.

Current problem:
The helper text beside "Send this sheet →" is too small and too vague.

Admin should immediately understand that clicking the button opens a send screen where they can choose what else gets included with the rate sheet.

Keep the primary button:

SEND THIS SHEET →

Beside or directly below it, add a larger, readable "NEXT STEP" helper block.

Preferred wording:

NEXT STEP

Choose what to include with this email:

✓ Private Client Intake Form
✓ Payment Options

Do not make this important message look like a tiny gray footnote.

Use:
- normal body-size text or slightly larger
- strong "NEXT STEP" label
- clear spacing
- good contrast
- mobile-readable line height

Desktop:
button + helper panel

Mobile:
stack vertically

==================================================
3. PRIVATE RATE SHEET SEND WIZARD
==================================================

When Admin clicks:

SEND THIS SHEET

for a Private Client, the next screen should clearly show:

INCLUDE WITH THIS EMAIL

[ ] Private Client Intake Form

[ ] Payment Options

If Payment Options is checked, reveal:

PAYMENT METHODS

[x] Cash App

[x] Venmo

Admin can independently check/uncheck either payment method.

Examples:

Private Intake: ON
Payment Options: ON
Cash App: ON
Venmo: ON

or:

Private Intake: ON
Payment Options: ON
Cash App: OFF
Venmo: ON

or:

Private Intake: OFF
Payment Options: ON
Cash App: ON
Venmo: OFF

The email preview must accurately reflect the selections.

==================================================
4. STANDALONE SEND PAYMENT OPTIONS
==================================================

When Admin clicks:

SEND PAYMENT OPTIONS

from the Private lead card, open a small send dialog.

Fields:

Recipient Email
Recipient Name
Optional Case / Lead Reference
Optional Message

Then:

PAYMENT METHODS

[x] Cash App
[x] Venmo

Allow either or both.

Then:

PREVIEW
SEND

This allows payment instructions to be sent later without resending the rate sheet.

==================================================
5. PRIVATE RATE SHEET + INTAKE + PAYMENT IN ONE EMAIL
==================================================

Preferred onboarding flow:

Admin opens Private Lead

-> SEND RATE SHEET

-> Admin selects:

[x] Private Client Intake Form
[x] Payment Options
[x] Cash App
[x] Venmo

-> Client receives ONE professional email containing:

1. Private Client $1,500 Retainer Rate Sheet
2. Private Client Intake link/button
3. Payment Instructions
4. Cash App information
5. Venmo information

Only include sections selected by Admin.

==================================================
6. CLIENT EMAIL LAYOUT
==================================================

Suggested structure:

ALWAYS PRECISE INVESTIGATIONS

PRIVATE INVESTIGATION NEXT STEPS

Thank you for contacting Always Precise Investigations.

PRIVATE CLIENT RATE INFORMATION

[View Private Client Rate Sheet]

PRIVATE CLIENT INTAKE

[Complete Private Client Intake]

PAYMENT OPTIONS

A $1,500 retainer is required to begin investigative services.

Cash App
[configured Cash App identifier / link]

Venmo
[configured Venmo identifier / link]

If Intake is unchecked:
do not render the Intake section.

If Payment Options is unchecked:
do not render Payment Options.

If only Venmo is checked:
do not show Cash App.

==================================================
7. CLICKABLE PAYMENT OPTIONS
==================================================

Where technically appropriate, make payment options clickable.

Examples:

PAY WITH CASH APP

PAY WITH VENMO

Use Admin-configured URLs/identifiers.

If only a handle/username exists and no safe direct payment URL is configured:
show the handle clearly instead of inventing a URL.

Do not create fake payment links.

==================================================
8. CENTRAL ADMIN PAYMENT SETTINGS
==================================================

Create/reuse an Admin-only settings section:

SETTINGS
-> PRIVATE CLIENT PAYMENT METHODS

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

The send wizard and email templates should read from this centralized configuration.

Do not hard-code payment handles in multiple templates.

Do not store:
- passwords
- payment login credentials
- access tokens
- secrets

==================================================
9. PRIVATE RATE SHEET WORDING
==================================================

Keep current pricing unchanged:

$1,500 retainer
$100/hr
4-hour minimum

Add a clean Payment Options section only when appropriate.

Suggested client-facing wording:

PAYMENT OPTIONS

A $1,500 retainer is required to begin. The retainer may be submitted using one of the approved payment methods below.

CASH APP
[configured identifier]

VENMO
[configured identifier]

Do not clutter the rate sheet.

==================================================
10. RETURNED PRIVATE INTAKE — NEXT ACTION
==================================================

When the Private Intake has been returned and the retainer is not yet marked received, the Leads & Intakes card should make the next action obvious.

Show:

PRIVATE INTAKE RECEIVED (check)

RETAINER PENDING

Then actions such as:

SEND PAYMENT OPTIONS
RECORD PAYMENT
REVIEW INTAKE

If payment instructions were already sent, show:

PAYMENT INSTRUCTIONS SENT
Cash App + Venmo

[ Resend ]

==================================================
11. PAYMENT STATUS
==================================================

Sending payment instructions must NEVER automatically mark the retainer as paid.

Keep:

RETAINER PENDING

until Admin manually confirms payment or a real verified payment integration exists.

Admin can record:

- Retainer Requested
- Retainer Received
- Amount Received
- Payment Method
- Payment Date
- Reference / Note

Payment Method choices:

- Cash App
- Venmo
- Check
- Cash
- Credit Card
- ACH / BILL
- Other

==================================================
12. ACTIVITY HISTORY
==================================================

Record relevant events such as:

Private Rate Sheet Sent
Private Intake Included
Payment Instructions Included
Cash App Included
Venmo Included
Private Intake Received
Payment Instructions Resent
Retainer Received
Payment Method
Payment Date

Do not expose internal payment notes to investigators.

==================================================
13. SENT CONFIRMATION
==================================================

After sending, improve the confirmation message.

Instead of only:

Sent to [email], with the intake link.

show exactly what was sent.

Example:

SENT TO:
marinerecon016@aol.com

Included:
(check) Private Client Rate Sheet
(check) Private Client Intake Form
(check) Payment Options
(check) Cash App
(check) Venmo

Only show items actually selected.

==================================================
14. INSURANCE RATE SHEET — MATCHED UX WITHOUT PRIVATE PAYMENT
==================================================

Use the same clearer send-area design for Insurance, but keep the strict pairing.

For Insurance:

NEXT STEP

Choose what to include with this email:

(check) Insurance Assignment Intake Form

Do NOT show:
- Payment Options
- Cash App
- Venmo

The Insurance send wizard should remain strictly tied to the Insurance Assignment Intake Form.

==================================================
15. STRICT PRIVATE / INSURANCE BOUNDARY
==================================================

Add regression tests proving:

1. Private leads can see Send Payment Options.
2. Insurance leads cannot.
3. Private Rate Sheet wizard can include Private Client Intake Form.
4. Private Rate Sheet wizard can include Payment Options.
5. Cash App can be independently enabled/disabled.
6. Venmo can be independently enabled/disabled.
7. Insurance Rate Sheet wizard cannot render Cash App/Venmo.
8. Insurance Intake email cannot include Cash App/Venmo.
9. Sending payment instructions does not mark Retainer Received.
10. Disabled payment methods do not render.
11. Payment handles/links are escaped safely.
12. Sent confirmation accurately lists selected contents.
13. Private rate-sheet send area clearly explains the next step.
14. Insurance rate-sheet send area clearly explains the correct Insurance intake pairing.

==================================================
16. CODEX REVIEW
==================================================

Use Codex as an independent reviewer for:

- Private vs Insurance payment boundary
- send-flow state
- payment-status logic
- unsafe payment URL handling
- HTML escaping
- Admin-only configuration
- regression-test coverage
- accidental client/payment data exposure
- ensuring the correct intake form is paired with the correct rate sheet

==================================================
17. IMPLEMENTATION PRIORITY
==================================================

Add this to NEXT.md / RECONCILIATION.md.

Do not abandon the current four HIGH verified bug priorities if they are still active.

Finish higher-priority defects first.

Then implement this Private Client onboarding/payment-options flow before lower-priority cosmetic work.

Preserve all current pricing and existing working send functionality.

Do not rebuild already-completed UI.

**Note on the checkbox glyphs:** the owner's original used ☐/☑/✓ and ↓ arrows.
They are transcribed here as `[ ]` / `[x]` / `(check)` / `->` only because the
surrounding tooling mangled them; **no wording was changed**, and the glyphs
carry no meaning beyond ticked and unticked.
