# Intake "Not Available / N/A" Update — Handoff (INTERNAL)

**Recorded in substance from the owner's handoff on 2026-08-13.** Lives in
`case-portal/` because this directory never deploys. Queued by the owner
AFTER the Case Build + Dropbox work ("after finishing the already long list
of tasks this is next"). Do not prune — mark the ledger instead.

Progress ledger (handoff build order):

| Step | Status |
| --- | --- |
| 1. Review required fields on both intake paths | **done** — 2026-08-13 (audited: the gates were name + a contact method, then carrier AND claim number on the claims path, then the authorization preset) |
| 2. Reduce required fields to truly essential information | **done** — 2026-08-13 (what remains: contact name, one contact method, service, carrier on the claims path, a claimant name OR a claim number so the file is identifiable, and a one-line objective — the owner's firm line. The claim number, date of loss, address, vehicle, start date, billing contact and authorization are all droppable now) |
| 3. Structured Not Available / N/A states (value + status, never literal "N/A" text) | **done** — 2026-08-13 (`naBox()` renders a compact "I don't have this information right now" under the field; ticking it disables the input, keeps whatever was typed, and survives back/forward. The payload carries `<field>_status` beside an EMPTY value — `not_available` / `unknown` / `approximate` / `asap` / `flexible` / `tbd` / `pending`. A test scans every value field for "N/A", "Unknown", 0000 and 01/01/1900 and fails on any of them, while allowing the status fields to say so) |
| 4. Flexible / Unknown options for dates | **done** — 2026-08-13 (date of loss: Exact / Approximate / Unknown, and Unknown removes the date box rather than asking for a fake one; requested start: Specific date / As soon as available / Flexible / To be determined) |
| 5. Authorization Pending for insurance | **done** — 2026-08-13 (fifth preset beside 8/16/24/custom; submission proceeds; the portal's Authorization panel says "Authorization pending" with a warning line that the hours must be confirmed before billable field work, and never invents a figure) |
| 6. Final Review screen shows PROVIDED vs NOT AVAILABLE YET | **done** — 2026-08-13 (the agreement step leads with a "Not available yet — and that's fine" box listing each gap in the submitter's own terms, above the terms they sign, plus the line "you can submit with the information currently available") |
| 7. Server-side validation updated | **done** — 2026-08-13 (nothing to loosen — `/ingest` only ever required a well-formed `case_no`. A test now proves a claims intake with no claim number, no date of loss, no address and no billing contact is accepted rather than refused) |
| 8. Data model updated (field statuses ride the payload) | **done** — 2026-08-13 (statuses ride the JSON payload; no schema change. `FIELD_KEEP` gained the five FIELD-SIDE statuses — subject address, description, date of loss, start date, authorized hours — and deliberately NOT `claim_number_status` or `billing_email_status`: whether the carrier's own reference exists is the office's business, and the allow-list keeps new statuses admin-only by default) |
| 9. Admin intake review updated | **done** — 2026-08-13 (a marked field reads "Not available at submission" / "Unknown at submission" / "(approximate)" instead of going silently blank; the same rows in the field's Subject panel) |
| 10. Missing Information summary (intentional vs accidental blanks) | **done** — 2026-08-13 (an "Information still needed" box above the intake detail, worded "marked unavailable at submission on purpose, never an error", with a button through to the Comm log to ask for the rest. Completeness reads as words — Ready for review / Additional information helpful / Missing critical information — never a percentage) |
| 11. Convert-to-case verified with partial intake | **done** — 2026-08-13 (the partial intake opens, assigns and works as an ordinary case; an investigator on it is told the address and vehicle are not known yet and is never told whether a claim number exists) |
| 12. Mobile test both forms | **done** — 2026-08-13 (the NA control is a full-width tap target in the existing design system; both paths walk end to end in the e2e) |

**Not built, and deliberately:** "Request more information" is a button that
opens the Comm log, not an automated email — the handoff asked for the data
model now and no automation until email infrastructure is ready, and the
Comm log already IS that record. The `not_applicable` status exists in the
model but no field offers it yet: nothing on either form is meaningfully
"not applicable" rather than "not known", and inventing a control for it
would be the checkbox forest the handoff warns against.

---

The handoff, in substance:

## CORE GOAL

**Do not block a client from submitting an assignment just because they do
not have every detail available yet.** Adjusters and private clients may
need to submit quickly and provide missing information later. The form
should say: *"Send us what you know now. We can fill in the rest as the
case develops."* A client should never abandon an assignment because the
form demands information they simply do not have.

## CORE RULE

Only truly require: (1) who is submitting, (2) how Admin can contact them,
(3) what general type of investigation they need — plus subject/claimant
where the assignment cannot reasonably be identified without it, and at
least a short objective. Everything else gets a structured "I don't have
this information right now" / "Not applicable" option.

**Never force fake information** — no typed "Unknown", "N/A", "0000", fake
phones, fake addresses, placeholder dates to pass validation.

## STATUS MODEL

Value and availability stored separately — e.g. `employer_value = null`,
`employer_status = "not_available"` (statuses: provided / not_available /
not_applicable). Never store literal "N/A" text in data fields. This keeps
later updates clean.

## FIELD PATTERN (compact, not a checkbox forest)

Important optional fields get a small "Don't have this yet" control that
disables the input, records the status, and can be toggled back (restoring
input). State persists across back/forward steps. Natural language only —
"I don't have this information right now", "Not applicable" — never
database terminology. Easy to tap on mobile; existing design system.

## INSURANCE — minimum required

Organization/Carrier · Contact name · Email OR direct phone (at least one
reliable method) · Assignment type · Subject/Claimant (when needed to
identify the assignment) · short Objective. MAY BE UNKNOWN: claim number,
DOB, date of loss, employer/insured, addresses, phone, attorney, vehicle,
work schedule, restrictions, hobbies, medical/court/travel dates, prior
surveillance, exact requested dates, billing contact, vendor info,
PO/authorization number.

## PRIVATE — minimum required

Client name · contact method (email or phone) · case type · basic
objective ("Tell us briefly what you would like documented"). MAY BE
UNKNOWN: subject DOB, employer, schedule, exact residence, vehicle/plate,
suspected companion, upcoming dates, travel, social info, exact custody
exchange details, attorney, court dates, secondary addresses.

## DATES

Never require a fake date. Offer Exact / Approximate / Unknown where
appropriate; "Flexible / not sure yet" for requested start; "Unknown" for
DOB. Requested start supports: specific date · As soon as available ·
Flexible · To be determined.

## VEHICLES / ADDRESSES

Partial vehicle info is welcome ("White SUV" without year/model/plate) plus
"Vehicle information not available yet." Addresses allow full, partial, or
general location ("Forest, Virginia area") plus "Exact address not
available" — never fabricate a street address.

## CLAIM NUMBER / AUTHORIZATION

Claim number: "Not available at this time" — never stops an urgent
assignment; Admin adds it later. Authorization presets keep 8/16/24/custom
and add **AUTHORIZATION PENDING** — submission proceeds, the dashboard
shows "Authorization pending" rather than inventing a figure, and Admin
must confirm authorization before billable field work starts.

## ADMIN SIDE

Intake review clearly separates *intentionally unavailable* from
*accidental blanks*: an "INFORMATION STILL NEEDED" summary (e.g. "Claim
Number — Not available at submission · Vehicle — Not available · Requested
Start — Flexible"), never treated as validation errors. ADD/UPDATE
INFORMATION completes details **without editing or destroying the original
submission** (original intake preserved; the working record is separate —
the case_details/subjects layer already is that). REQUEST MORE INFORMATION:
admin selects missing fields; a future message says the assignment has not
been lost or cancelled — at minimum prepare the data model now; no
automation required until email infrastructure is ready.

Completeness reads as words, not scores: "Ready for review" · "Additional
information helpful" · "Missing critical information" — never "62%
complete."

Internal field categories: REQUIRED TO SUBMIT (few) · HELPFUL ·
CONDITIONAL (per case type — custody questions for custody, authorization
questions for insurance; both still submit with their unknowns).

## ACCEPTING AN INCOMPLETE INTAKE

Admin can ACCEPT & CREATE CASE with non-critical gaps. Warn only when
something genuinely operationally necessary is missing (e.g. no usable
subject location): allow CREATE CASE ANYWAY, but prevent START
INVESTIGATION when the assignment is truly impossible to conduct. No
arbitrary required-field rules.

## REVIEW SCREEN + LANGUAGE

Final review shows PROVIDED vs NOT AVAILABLE YET so the user sees the form
accepted those answers on purpose. Near the start or the review step:
"You can submit the assignment with the information currently available.
Additional details can be provided later if needed."

## RATE SHEET PAIRING UNCHANGED

Insurance rate sheet ↔ insurance intake; private rate sheet ↔ private
intake. Both intakes support the unknown states.

## OWNER'S FIRM LINE

The one exception kept firm: **contact + basic case purpose**. An
essentially empty form must not submit; claim numbers, DOBs, plates,
employers, dates and schedules may all arrive later.
