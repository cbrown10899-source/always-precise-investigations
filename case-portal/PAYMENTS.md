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

Progress ledger:

| Step | Status |
| --- | --- |
| 1. Central admin-only payment-method configuration | not started |
| 2. Private rate sheet PAYMENT OPTIONS section | not started |
| 3. Private send wizard "Include Private Payment Instructions" | not started |
| 4. Email preview shows sheet / intake / payment instructions | not started |
| 5. Retainer status + record-a-payment fields | not started |
| 6. Case history events | not started |
| 7. The seven boundary regression tests | not started |
| 8. Codex independent review of the boundary | not started |

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
