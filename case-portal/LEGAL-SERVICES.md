# Service-aware Legal intake and rate sheets — owner brief and derived decisions

Unit of 2026-09-02. The owner's brief is verbatim below; everything after it is
what this build DERIVED, one decision per entry, so any of it can be overturned
on its own without re-litigating the rest.

## Owner brief (verbatim, 2026-09-02)

> Redesign the LEGAL intake/rate-sheet flow so pricing and intake content are
> specific to the legal service selected.
>
> The current Legal rate sheet is too generic. A simple fixed-price assignment
> is showing retainer, hourly rate, 4-hour minimum, additional-time language,
> and other billing information that does not apply and will confuse law-firm
> clients.
>
> Do not create several unrelated intake systems. Keep one Legal intake
> architecture, but make it service-aware and dynamically show the correct
> intake fields, rate sheet, email content, authorization, and billing language
> for the selected service.
>
> LEGAL SERVICE SELECTION
>
> At the beginning of the Legal intake/review flow, support clear service
> choices such as:
>
> 1. Person Locate / Skip Trace
> 2. Process Service
> 3. General Investigation
> 4. Surveillance
> 5. Other / Custom Assignment
>
> Use the repo's existing terminology where appropriate and do not duplicate an
> existing service taxonomy unnecessarily.
>
> FIXED-PRICE SERVICES
>
> For now configure:
>
> PERSON LOCATE / SKIP TRACE — Price: $250 flat fee
> PROCESS SERVICE — Price: $250 flat fee
>
> Make these prices come from the existing/configurable pricing architecture if
> possible rather than scattering hard-coded values through templates.
>
> When either fixed-price service is selected, its Legal rate sheet/email must
> NOT show:
>
> - $250 retainer language
> - $100/hr investigative rate
> - 4-hour minimum
> - "additional time" hourly language
> - language implying the $250 is only a deposit against future hourly work
> - unrelated surveillance/general-investigation pricing
>
> Instead use a simple presentation such as:
>
> PERSON LOCATE / SKIP TRACE — $250 Flat Fee
> or
> PROCESS SERVICE — $250 Flat Fee
>
> Then show only a short service-specific explanation, payment information, and
> the Start Assignment action.
>
> The $250 should be presented as the actual price for that selected service,
> not a retainer.
>
> GENERAL INVESTIGATION
>
> Preserve the existing retainer/hourly structure for General Investigation if
> that is the current intended pricing model.
>
> Only General Investigation or another service that actually uses hourly
> billing should display: retainer, hourly rate, minimum engagement if
> applicable, additional-time approval language.
>
> Do not allow those sections to leak into fixed-price services.
>
> SURVEILLANCE
>
> Use the existing Legal surveillance pricing/rules already in the repo.
> Do not invent new surveillance pricing.
> Only show information applicable to surveillance when Surveillance is
> selected.
>
> OTHER / CUSTOM
>
> Other / Custom Assignment should not invent a price.
> Use the existing custom quote/custom retainer workflow where available.
>
> SERVICE-SPECIFIC INTAKE
>
> After the Legal service is selected, adapt the intake fields to the
> assignment.
>
> Person Locate / Skip Trace should prioritize information needed to identify
> and locate the subject.
>
> Process Service should prioritize information needed to perform service,
> including recipient/subject information and documents/instructions already
> supported by the application.
>
> General Investigation should use the broader investigative intake.
>
> Surveillance should use surveillance-relevant fields.
>
> Reuse existing fields/data structures wherever possible. Do not create
> duplicate client/subject records just to achieve conditional forms.
>
> RATE SHEET / EMAIL
>
> The emailed Legal rate sheet must be generated from the selected service.
>
> A law firm buying a $250 Person Locate should receive a concise $250 Person
> Locate rate sheet. A law firm buying a $250 Process Service should receive a
> concise $250 Process Service rate sheet. They should not receive a long
> master Legal pricing sheet containing unrelated options.
>
> Keep the professional styling and current mobile-friendly email design.
>
> Payment options should continue using the payment methods selected in the
> Send Rate Sheet workflow.
>
> Preserve: Mail Check, future BILL.com architecture, existing invoice
> behavior, existing authorization workflow.
>
> Do not expose payment methods that are not enabled/configured.
>
> CASE / BILLING RECORD
>
> Carry the selected Legal service and pricing model into the accepted case so
> the portal knows whether the assignment is: FIXED PRICE or RETAINER / HOURLY
> or CUSTOM.
>
> For a $250 fixed-price assignment, the portal should show the amount due/paid
> as $250 and should not describe it as a retainer.
>
> Do not break existing cases created under the previous Legal pricing model.
> Existing historical cases must remain readable and unchanged.
>
> UX
>
> Keep this simple for a law firm. The mental model should be:
> Choose what you need -> see the price/rate sheet for that service -> provide
> the information needed for that service -> authorize/start assignment.
> Do not make the client read through pricing that does not apply to them.
> Mobile must remain clean and easy to scan.
>
> TEST
>
> 1. Person Locate selected -> only $250 flat-fee content appears
> 2. Process Service selected -> only $250 flat-fee content appears
> 3. neither shows 4-hour minimum
> 4. neither shows $100/hr language
> 5. neither calls $250 a retainer
> 6. General Investigation still shows its proper retainer/hourly terms
> 7. Surveillance retains its existing pricing
> 8. Other/Custom does not invent a price
> 9. correct service carries into accepted case
> 10. fixed-price case billing shows $250 correctly
> 11. Legal rate-sheet email looks correct on phone and desktop
> 12. existing Legal cases are not changed
> 13. Mail Check/payment-selection behavior remains intact
> 14. BILL.com preparation remains intact and disabled until configured
>
> Do not change Insurance or Private pricing during this unit.
>
> Finish: CODED -> TESTED -> PUSHED -> MERGED -> DEPLOYED -> LIVE VERIFIED
>
> Then report exactly which Legal services and pricing models are now
> supported and show me any pricing/service decisions that still require my
> input before adding more fixed-price services.

## Derived decisions

**D1 — `LEGAL_FLAT` beside `PERSONAL` and `RATES` is the only place the two
$250 figures are set.** The catalogue, the fixed sheets, the workspace money
block, the invoice block and the case list all read from it; the fixed-sheet
builder contains no digit literal, and a source test pins that. The brief's
"existing/configurable pricing architecture" is exactly this shape — `PERSONAL`
and `RATES` are code constants an ordinary Worker edit changes, and the flat
fees follow the same rule rather than gaining a settings row nobody asked for.

**D2 — `LEGAL_SERVICES` is the one catalogue, and each entry maps onto the
EXISTING assignment-type vocabulary.** The brief says not to duplicate a
taxonomy: `locate` ↔ "Locate / Skip trace", `process` ↔ "Process / service
support", `general` ↔ "Civil investigation", `surveillance` ↔ "Surveillance",
`custom` ↔ "Other / custom assignment" — the values `LEGAL_ASSIGNMENTS` and the
portal's `ASSIGN_TYPES` already carry. The five services do not replace the
nine assignment types; they are the pricing-level choice, and each defaults the
finer `assignment_type` when the form left it blank.

**D3 — the marker is `payload.legal_service` on the submission's own row, and
the pricing model is DERIVED, never stored.** Same shape as
`payload.assignment === 'legal'` (`isLegalSub`, Unit 6): no schema change, no
portal-setup dispatch, one reader (`legalServiceForSub`). `legalPricingFor`
answers `fixed` / `retainer` / `custom` from the catalogue, and **a legal case
with no marker answers `retainer`** — which is precisely what every historical
legal case shows today, so "existing historical cases remain readable and
unchanged" is the default branch, not a migration.

**D4 — the fixed sheet is a context-and-service-resolved PRESENTATION of the
one send route, exactly as the legal card already is.** `sheetForContext`
already returns a different document (the legal card) under the product id
`private_retainer`; `legalFixedSheet(svc)` is one more resolution step behind
the same `POST /sheets/private_retainer/email` door, selected by
`body.legal_service` (explicit pick first, else the case's own marker). Nothing
about `SHEET_CONTEXTS_ALLOWED`, the case-pairing refusals, `send_log`'s
`sheet_id` vocabulary or the lead stamping moves. The response carries
`legal_service` so the resolution is observable and asserted.

**D5 — the fixed sheet's WORDS are the boundary, and the tests grep for their
absence.** No "retainer", no "$100", no "hour"/"hourly"/"minimum" of any kind,
no "additional time", no "deposit", no consumer figures — the owner's ban is
enforced as vocabulary, not as sections, so a reworded leak still fails. The
price line reads "$250 Flat Fee" with "The complete price for the assignment
described on this sheet"; payment information is the Mail Check line (and the
Bill.com line only when the adapter answers ready); the Start Assignment action
is the legal intake door carrying `&service=<id>` so the form opens on the
service the sheet quoted.

**D6 — no price reaches the public form, and the brief's UX loop is satisfied
by the EMAIL.** The locked owner decision of 2026-08-21 ("NO PRICING IS PUBLIC,
on any of the three sides") stands: the $250 appears on the emailed sheet and
in the portal, never in `intake/index.html` — the existing no-dollar test keeps
enforcing it. "Choose what you need → see the price → provide the information →
start" runs: the firm is sent the service's sheet, and its Start Assignment
button opens the service-specific intake. If the owner ever wants fixed prices
shown publicly, that is a deliberate reversal of the 2026-08-21 rule and needs
their word.

**D7 — the case money block keys its wording off the model, and the figure per
case still outranks the default.** `authorizationFor`'s consumer branch and the
invoice `retainerBlock` both resolve the fee for a fixed case as: the case's
own `case_retainer.retainer_amount` where one was explicitly agreed, else
`LEGAL_FLAT[service]` — the `agreedRetainer` principle applied to a flat fee.
They return `model: 'fixed'` and the service label; the page draws "Flat fee"
rows and no hourly arithmetic (`approx_hours_remaining` is null — a flat fee
has no hourly divisor), and the invoice document prints a one-line flat-fee
statement instead of the deposit drawdown table. Received/receipt recording is
the existing retainer-payment machinery unchanged — the instrument is the same,
the WORD on screen follows the model.

**D8 — the service is editable on the Legal panel under the /meta rules.** A
mis-picked service would otherwise freeze the wrong pricing model into a case
with no way back. `POST /cases/:no/legal` accepts optional `legal_service`
(absent unchanged, blank clears, validated against the catalogue) and writes it
into the payload the same way `/cases/:no/edit` already edits payload fields.
Historical cases are touched only when an admin deliberately sets a service.

**D9 — the public legal door gains one step, `lsvc`, after the shared
info/service prefix, and the service-specific fields are REWORDINGS of the
existing subject/objective steps plus one field.** Locate retitles the subject
step around identifying and locating; Process retitles it around the recipient
and adds "Documents to be served" (`documents_to_serve` in the payload — the
only new field); General and Surveillance keep the broader wording they have.
No duplicate client/subject structures; `?assignment=legal&service=<id>`
preselects the step. The choice is REQUIRED like the main service picker — a
defaulted service would file a record nobody chose (the Unit 36 lesson).

**D10 — found and fixed in passing: the sheet EMAIL path applied the Bill.com
line without a context guard.** `/sheets` excluded the private card
(BILLCOM.md), but `emailSheet` wrapped whatever sheet it sent with
`withBillcomLine(sheet, billcom.ready)` — so a PRIVATE send with Bill.com
configured would have carried the Bill.com line to a private client. The wrap
is now `billcom.ready && !CONTEXT_TAKES_PAYMENT(sendCtx)`, and a test pins the
private email clean with Bill.com fully configured.

## What was deliberately NOT done

- No settings rows for the flat fees (D1) — a code constant, like every price.
- No new tables, no schema change, no portal-setup dispatch.
- No public pricing (D6).
- No change to Insurance or Private pricing, sheets, doors or payment methods —
  the brief's own line, asserted by the suites' existing guards.
- No per-service Worker routes: one send door, one ingest, one intake page.
- Surveillance pricing was NOT invented: legal surveillance remains the
  retainer/hourly product the legal card already presents (the brief:
  "existing Legal surveillance pricing/rules already in the repo").
