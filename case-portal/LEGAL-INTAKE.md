# LEGAL / LAW FIRM intake — the owner's brief, verbatim (INTERNAL)

Queued by the owner on **2026-08-19**, mid-unit, with the instruction:

> AFTER YOU FINISH THE CURRENT CODING UNIT IN FULL, build the next queued intake
> addition below. Do not interrupt or abandon work already in progress.

**Reordered by the owner the same day**, before any code was written for it:

> Update the queue so UI work comes before the new Legal intake.

> After Dropbox UI: 1) Admin report/mobile workflow fix, 2) full portal
> mobile/aesthetic UI cleanup, 3) Legal/Law Firm intake. Finish, test, merge and
> deploy each unit before starting the next.

So this is **item 6**, behind both UI units, and each of those ships on its own
merge and its own deploy before the next one starts.

**Nothing in this file is designed by me.** It is the brief as written, kept so
that the unit is built from the owner's words rather than from a paraphrase that
has already lost the decisions. Read it before writing any code for item 7.
Anything I derive during the build goes in a separate DERIVED section at the
bottom, listed one decision at a time so each can be overturned on its own —
the same shape `PHOTO-TIMESTAMP.md` uses.

---

## ADD THIRD INTAKE TYPE: LEGAL / LAW FIRM

Create a third intake path beside Private Client and Insurance.

Public/admin label:
LEGAL / LAW FIRM

Form title:
Legal Investigation Assignment

Purpose:
This is for attorneys, paralegals, legal assistants and law-firm staff assigning
investigative work. It should feel like a professional case-assignment form, not
a consumer intake questionnaire.

### PRICING

Legal/Law Firm must use the SAME pricing and retainer source as the existing
Private Client intake.

Do not create duplicate Legal pricing values or a separate Legal pricing
configuration.

If Private pricing changes later, Legal must automatically reflect the same
pricing.

Current expected private pricing/retainer structure includes:
- Standard retainer: $1,500
- Additional selector choices already used by Private: $2,000, $3,000 and Custom
  Amount
- Existing Private investigative hourly/rate language should be reused exactly
  from the live Private form rather than hard-coded again.

Do NOT copy Private Client payment methods.

### LEGAL PAYMENT OPTIONS

Legal/Law Firm payment choices should be:

1. BILL.com Invoice / ACH
2. Retainer Check - Pick Up at Firm
3. Retainer Check - Mail
4. Existing Billing Arrangement

Do not show Cash App or Venmo on Legal/Law Firm intake.

### BILL.COM

Design the Legal flow so BILL.com invoicing can be connected/implemented cleanly.

Capture:
- Billing contact name
- Billing email
- Billing phone if available
- Law firm/company
- Optional matter/reference number
- Retainer amount
- Invoice notes if needed

Do not falsely mark anything paid merely because an invoice was requested or
sent.

### CHECK PICKUP

If "Retainer Check - Pick Up at Firm" is selected:
- Create payment/retainer status as Awaiting Pickup
- Never mark it Paid automatically
- Allow firm office/address and pickup instructions
- Allow preferred pickup date/time or note if provided
- Admin records the actual payment only after the check is physically received
- Preserve the existing manual payment recording/audit behavior

Suggested client-facing wording:
"Please let us know when the retainer check is ready and we will arrange pickup
at your office."

### CHECK BY MAIL

If "Retainer Check - Mail" is selected:
- Status should remain Awaiting Payment / Awaiting Check
- Do not mark paid until Admin records receipt
- Show the appropriate company mailing instructions from existing portal/company
  data if available; do not invent an address

### EXISTING BILLING ARRANGEMENT

For repeat firms:
- Allow "Existing Billing Arrangement"
- Do not require a new payment method when this is selected
- Make the status obvious to Admin
- Do not assume paid status

### LEGAL INVESTIGATION ASSIGNMENT FORM

Keep the form fast enough for a paralegal/legal assistant to complete in roughly
2-4 minutes when they already know the case.

Only genuinely essential fields should be required.

Include:

**FIRM / CONTACT**
- Law firm name
- Assigning attorney
- Primary contact
- Contact role: Attorney / Paralegal / Legal Assistant / Office Staff / Other
- Primary email
- Primary phone
- Billing contact name
- Billing email
- Billing phone if available
- Optional matter/reference number

**CASE**
- Client name
- Opposing party / subject
- Case number if applicable
- Court
- Jurisdiction
- Case type / investigation type
- Assignment requested / what needs to be accomplished
- Important deadline
- Hearing date
- Trial date
- Other important date

**SUBJECT / INVESTIGATIVE DETAILS**
- Subject full name
- Aliases / nicknames
- Date of birth if known
- Phone numbers if known
- Email if known
- Known addresses
- Employer/workplace if known
- Vehicle year/make/model/color
- License plate/state if known
- Other identifying information
- Known schedule / routine
- Relevant locations
- Special instructions
- Safety concerns or restrictions if applicable

**CONFLICT CHECK**
- Client name
- Opposing party
- Subject
- Other names/entities the firm wants checked
- Keep this easy to copy into whatever conflict-check workflow already exists

**DOCUMENTS**
Allow supporting documents to be uploaded with the assignment, such as:
- Pleadings
- Complaint/petition
- Court orders
- Photos
- Prior reports
- Addresses
- Vehicle information
- Discovery
- Other case documents

Also include:
"I will provide additional documents separately."

Do not force document upload to submit the intake.

### ADMIN ENTER INTAKE

Legal/Law Firm must support Admin entering the intake internally while speaking
with an attorney/paralegal.

Admin should be able to create the Legal intake without sending a public link
first.

Preserve the same case/intake audit expectations used elsewhere in the portal.

### QUICK LEGAL ASSIGNMENT

Add a streamlined Admin-only path for law firms that simply call or ask us to
come by and pick up the file/check.

Call it:
Quick Legal Assignment

Keep this intentionally short.

Minimum useful workflow:
- Law firm
- Attorney / primary contact
- Client
- Subject / opposing party
- Assignment requested
- Retainer amount
- Payment arrangement
- Notes
- Create intake/case

Documents and additional details can be added afterward.

Do not make a longtime attorney relationship harder just because the portal
exists.

### LEGAL WORKFLOW / UX

The three top-level intake choices should now clearly be:

Private Client
Insurance
Legal / Law Firm

Legal should look professional and appropriate for a law office.

Use "Legal Investigation Assignment" as the form title rather than
consumer-style wording.

The public Legal form should be easy for an attorney to forward directly to a
paralegal/legal assistant.

Where useful, allow the user to save/reuse existing firm/contact information for
repeat assignments using the project's existing data patterns. Do not invent a
large CRM subsystem just for this feature.

### CASE CREATION / DATA

Reuse existing case, intake, contact, payment and document architecture wherever
possible.

Do not duplicate data unnecessarily.

Do not break:
- Private intake
- Insurance intake
- Existing private pricing
- Existing payment history
- Existing cases
- Existing manual payment recording
- Existing phone/contact storage
- Existing Dropbox work
- Existing Active Surveillance features

Do not perform destructive migrations.

If a schema addition is genuinely necessary:
- Make it additive
- Preserve all existing data
- Follow the project's established schema/portal-setup workflow
- Test migration/idempotency
- Report exactly what changed

### PAYMENT STATE RULES

Sending payment instructions is never payment.

Selecting a payment method is never payment.

Creating a BILL.com invoice is never payment.

Selecting Pick Up at Firm is never payment.

Selecting Mail is never payment.

Only the existing Admin payment-recording workflow or a confirmed integrated
payment event may mark money received.

Retainer statuses should clearly distinguish states such as:
- Not requested
- Awaiting invoice
- Invoice sent
- Awaiting pickup
- Awaiting mailed check
- Existing billing arrangement
- Partial payment
- Paid

Use existing project terminology where equivalent states already exist rather
than creating redundant status systems.

### MOBILE

Legal intake must work cleanly on phone, tablet and desktop.

Paralegal-facing form:
- Large touch targets
- No horizontal overflow
- Logical sections
- Avoid giant walls of fields
- Allow optional sections to remain compact/collapsible where appropriate
- Preserve entered information if the user moves between sections

### ADMIN

Legal Intakes should appear with the existing Intakes system, not under a
separate disconnected lead system.

Clearly badge/type them as:
LEGAL

Admin should be able to:
- View assignment
- Edit information
- Add missing details
- Upload/add documents
- Record retainer/payment status
- Convert/create the case using existing workflow
- See attorney/paralegal/billing contacts distinctly

### TESTING / DELIVERY

Build this as a focused unit after the current queued work ahead of it is
complete.

Test:
- Legal public intake
- Admin-entered Legal intake
- Quick Legal Assignment
- Private pricing changes flow through to Legal automatically
- Legal does not display Cash App/Venmo
- BILL.com/ACH selection does not mark paid
- Pick Up at Firm creates Awaiting Pickup and does not mark paid
- Mail does not mark paid
- Existing Billing Arrangement does not mark paid
- Custom retainer amount carries through correctly
- Documents remain optional
- Mobile layout does not overflow
- Existing Private and Insurance flows remain unchanged

Run focused tests first.
Run the full relevant suite once after focused tests are green.
Do not chase unrelated old failures unless this change caused them.
If clean, push, PR, merge and deploy using the project's normal workflow.
Leave any truly real-device-only verification OPEN for me rather than claiming
it passed.

Update NEXT.md / roadmap so the Legal/Law Firm intake and its implementation
state are recorded accurately.

Stop after deployment and give me a concise report of:
- what was built
- pricing source reused
- payment behavior
- any schema change
- tests
- PR/merge/deploy
- anything requiring my live verification

---

## Where this brief meets what already exists

Notes taken when the brief was recorded, **not decisions**. They name the parts
of the codebase the unit will have to reckon with, so the design work starts
from what is there rather than from a blank page.

- **`SEND_CONTEXT` / `SHEET_CONTEXT` / `KIND_CONTEXT` are two-way today** —
  PRIVATE or INSURANCE — and `CONTEXT_TAKES_PAYMENT` is the whole payment
  boundary, gating Cash App and Venmo to private. Legal needs private *pricing*
  and non-private *payment methods*, so it is the first case that separates
  those two. That is the central design question of this unit and it is not
  answered here.
- **`submissions.kind` carries a CHECK constraint.** `schema.sql` is re-applied
  on every portal-setup run and SQLite cannot widen a CHECK idempotently, so a
  third kind is the `build_custom` / `case_archive` problem again. Whatever the
  answer is, it is not an `ALTER TABLE`.
- **Pricing already has one reader.** `PERSONAL` sets the standard figure,
  `case_retainer.retainer_amount` holds what a client actually agreed, and
  `agreedRetainer()` is the single read feeding the sheet, the subject line, the
  payment block and the preview. "Legal reflects private pricing automatically"
  means going through that reader, not past it.
- **The asked/arrived split already exists.** `payment_send` records that the
  firm asked; `retainer_payment` records arrival; they are separate tables so no
  later edit can confuse them. Every "X is never payment" rule in the brief is
  that split, extended.
- **The intake form is one file with a service step** (`steps()`, `pickSvc`),
  and the carrier door already proves a third path is possible. `/intake/` has
  three paths today: surveillance, process serving, carrier.
- **No price may appear on the public site.** A test fails if a dollar figure
  appears anywhere in `intake/index.html`. A retainer selector on a public legal
  form runs straight into that test, and the answer is not to weaken it.
- **Documents.** New bytes go to Dropbox or nowhere, and the ordinary upload
  refuses `video/*`. A public intake that accepts pleadings is the first
  unauthenticated writer of case files; that needs deciding, not assuming.

## DERIVED — decisions I made that the owner did not state

*(empty — nothing is derived until the unit begins)*
