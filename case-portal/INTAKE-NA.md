# Intake "Not Available / N/A" Update — Handoff (INTERNAL)

**Recorded in substance from the owner's handoff on 2026-08-13.** Lives in
`case-portal/` because this directory never deploys. Queued by the owner
AFTER the Case Build + Dropbox work ("after finishing the already long list
of tasks this is next"). Do not prune — mark the ledger instead.

Progress ledger (handoff build order):

| Step | Status |
| --- | --- |
| 1. Review required fields on both intake paths | not started |
| 2. Reduce required fields to truly essential information | not started |
| 3. Structured Not Available / N/A states (value + status, never literal "N/A" text) | not started |
| 4. Flexible / Unknown options for dates | not started |
| 5. Authorization Pending for insurance | not started |
| 6. Final Review screen shows PROVIDED vs NOT AVAILABLE YET | not started |
| 7. Server-side validation updated | not started |
| 8. Data model updated (field statuses ride the payload) | not started |
| 9. Admin intake review updated | not started |
| 10. Missing Information summary (intentional vs accidental blanks) | not started |
| 11. Convert-to-case verified with partial intake | not started |
| 12. Mobile test both forms | not started |

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
