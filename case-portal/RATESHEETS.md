# Rate Sheets — Final Update Handoff (INTERNAL)

**Recorded verbatim from the owner's handoff on 2026-08-13.** Lives in
`case-portal/` because this directory never deploys. Do not prune — mark the
ledger instead.

Progress ledger:

| Priority | Status |
| --- | --- |
| 1. Two separate rate-sheet models (`insurance_assignment` / `private_retainer`) | not started |
| 2. Insurance sheet copy; remove "Additional fees — None" | not started |
| 3. Private retainer sheet copy; remove "Additional fees — None" | not started |
| 4. Mobile hierarchy — prices dominate | not started |
| 5. Send preserves the selected sheet type | not started |
| 6. Independent editing (separate configs) | not started |
| 7. Internal insurance-authorization + private retainer-balance calculations | not started |

---

The handoff, verbatim:

# ALWAYS PRECISE INVESTIGATIONS

## Final Rate Sheet Update — TWO SEPARATE RATE SHEETS

There are currently **two separate rate sheets** in the portal.

They must remain separate products with separate pricing logic and separate
client-facing copy. Do NOT combine them.

# RATE SHEET 1 — INSURANCE ASSIGNMENT RATES

For: insurance carriers, TPAs, self-insured employers, SIU departments,
defense counsel, other approved commercial insurance clients. This is a
**package / authorization-based rate sheet**.

# RATE SHEET 2 — PRIVATE CLIENT — $1,500 RETAINER

For: private surveillance, adultery/infidelity, child custody, domestic,
cohabitation, other private-client investigations. This is a **retainer +
hourly billing rate sheet**.

# CRITICAL ARCHITECTURE REQUIREMENT

Do not create one generic pricing object and merely change the title. These
have different pricing structures. Use separate rate-sheet
types/configuration such as `insurance_assignment` / `private_retainer`.
They may reuse the same UI components and visual styling, but their pricing
logic, explanatory copy, included-service language, authorization language
and package fields must remain independent. An Admin must be able to edit
one without accidentally changing the other.

# RATE SHEET 1 — INSURANCE ASSIGNMENT RATES

CLIENT-FACING TITLE: **Insurance Assignment Rates**
Supporting copy: **For carriers, TPAs, self-insured employers, SIU
departments and defense counsel.** Then: **Surveillance is authorized in
blocks of investigative time. An 8-hour day is the minimum surveillance
assignment, and 24 hours is the typical initial authorization.**

PACKAGE 1 — One Day, 8 Hours, **$1,200** — "8 hours of authorized
surveillance." Do not show internal calculations ($150 × 8, rack rate,
discount amount, profit calculations).

PACKAGE 2 — Two Days, 16 Hours, **$2,300** — "16 hours of authorized
surveillance at a reduced multi-day package rate." Do NOT display "$100
below standard" — internal pricing information.

PACKAGE 3 — Three Days, 24 Hours, **$3,300** — badge: **RECOMMENDED INITIAL
AUTHORIZATION** — "24 hours of authorized surveillance and the preferred
starting authorization for most multi-day surveillance assignments." Do NOT
display "$300 below standard", "preferred-volume band", rack-rate
comparison, internal discount calculations. Those belong only in Admin
pricing information.

ADDITIONAL HOURS — Additional Authorized Hours **$150/hr** — "Additional
investigative time is only incurred with prior authorization from the
assigning client."

REMOVE THE CURRENT "ADDITIONAL FEES — NONE" entirely. Do NOT list mileage,
travel time, tolls, parking, database fees, record fees, video review,
written reports only to then say there is no additional charge.

REPLACE IT WITH: **Included in the Flat Rate** — "Standard local travel,
routine case expenses, investigative reporting, video review, photographs
and delivery of case materials are included in the authorized package
price." Then: **No routine add-on fees.** Do not attach individual dollar
values to those items.

OUTSIDE SERVICE AREA (the one important exception) — **Outside Our Normal
Service Area / Quoted in Advance** — "Assignments requiring significant
travel outside our normal service area are quoted and approved before the
assignment is accepted." Optional: "No unapproved travel charge is added
afterward."

CONFIRMATION BOX (shorten the current large gold box): **Clear pricing. No
surprise billing.** — "Rates and authorization are confirmed in writing
before investigative work begins. Submission of an assignment does not by
itself constitute acceptance." Smaller: "Surveillance deliverables generally
include an investigative activity report supported by available time-stamped
photographs and video."

MOBILE HIERARCHY — the numbers dominate: 8 HOURS $1,200 · 16 HOURS $2,300 ·
24 HOURS $3,300 (Recommended Initial Authorization) · ADDITIONAL AUTHORIZED
HOURS $150/hr.

# RATE SHEET 2 — PRIVATE CLIENT RETAINER

Different pricing structure. Do NOT make it look like an insurance package.

TITLE: **$1,500 Retainer** — "Private surveillance, domestic and family
investigations." Then: **A $1,500 retainer is required to begin. The
retainer is applied directly to authorized investigative services billed at
$100 per hour.** (The client must understand the $1,500 is a deposit against
the work — not $1,500 PLUS hourly from the first hour.)

RETAINER SECTION — **Retainer to Begin $1,500** — "Applied in full toward
authorized investigative services. It is not a separate fee." Optional:
"Your retainer funds the work performed on your case."

HOURLY — **Investigative Rate $100/hr** — "4-hour minimum engagement." Then:
"Investigative time is deducted from the retainer at the same $100 hourly
rate." (Up to 15 billable hours if fully used — internal; the client-facing
wording focuses on the retainer balance, not a guaranteed hour count.)

WHAT COUNTS AS INVESTIGATIVE TIME — distinguish ROUTINE ADD-ON EXPENSES from
BILLABLE INVESTIGATIVE LABOR: "Field investigation, necessary video review,
case documentation and report preparation are handled at the same
investigative rate and are applied against the client's authorized
retainer." No separate video-review fee, report fee, or admin surcharge —
but legitimate investigative labor still consumes retainer time. This avoids
promising unlimited free report-writing labor.

REMOVE PRIVATE "ADDITIONAL FEES — NONE". REPLACE WITH: **Straightforward
Billing** — "Standard local operating costs are included. There are no
routine mileage, toll, parking, report or case-delivery surcharges within
our normal service area." Then: **No routine add-on fees.**

RETAINER BALANCE / ADDITIONAL AUTHORIZATION — replace "Beyond the retainer"
with **If Additional Time Is Needed** — "We contact you before exceeding the
authorized retainer. Additional investigative time is never incurred without
your approval." Price **$100/hr**. Optional: "You remain in control of any
additional authorization."

OUTSIDE SERVICE AREA — **Outside Our Normal Service Area / Quoted in
Advance** — "Significant travel outside our normal service area is discussed
and approved before the work is scheduled."

CONFIRMATION BOX: **Your case. Your authorization. No surprise billing.** —
"Work begins once the retainer and required authorization are received.
Investigative activity is documented and appropriate case deliverables may
include a written report, photographs and video." Then: "An investigator may
provide testimony regarding their own observations when appropriate and
separately arranged." IMPORTANT: do not imply court testimony is included in
the $100/hr rate or the retainer; court/deposition testimony should remain
capable of having its own Admin rate.

MOBILE HIERARCHY: RETAINER $1,500 (Applied to the work — not an extra fee) ·
INVESTIGATIVE RATE $100/hr (4-hour minimum) · ADDITIONAL TIME $100/hr (Only
with your approval) · STANDARD LOCAL CASE COSTS Included · OUTSIDE SERVICE
AREA Quoted in advance. Do not bury those points inside paragraphs.

# ADMIN-SIDE REQUIREMENTS

Admin retains more detail than either client sheet. INSURANCE: standard
hourly, three packages, additional-hour rate, preferred-volume rate,
negotiated client rate, internal mileage cost, investigator compensation,
travel/database/other actual costs, profitability. PRIVATE: required
retainer, hourly rate, minimum engagement, retainer received / used /
balance, additional authorization, investigator compensation, actual
expenses, profitability, testimony/court rate if applicable. None of this
appears on a client-facing sheet automatically.

PRIVATE RETAINER BALANCE FEATURE — architecture so a private case can
internally display: Original Retainer $1,500 / Applied So Far $600 /
Remaining $900; at $100/hr also Authorized Hours Used 6.0 / Approx. Hours
Remaining 9.0. Not exposed to clients yet; later useful for Admin and a
future Client Portal.

INSURANCE AUTHORIZATION FEATURE — Authorized Hours 24.0 / Used 13.5 /
Remaining 10.5, and Authorized Package $3,300. Fundamentally different from
the private-retainer balance. Do not combine the calculations.

RATE SHEET SELECTOR — when Admin creates or sends a sheet, clearly offer
**Insurance Assignment Rates** and **Private Client — $1,500 Retainer**.
Obvious labels; never wonder which model is being sent.

EMAIL / SEND — the send function preserves the selected type. Insurance view
sends insurance content/pricing/terminology; Private view sends
retainer content/pricing/terminology. Never mix.

DESIGN — keep the existing visual system (navy/dark typography, white cards,
border radius, gold accent). Improve spacing, hierarchy, mobile scanability,
price emphasis. Make the pricing numbers much easier to identify.

DO NOT SHOW INTERNAL STRATEGY TO CLIENTS — no rack rate, preferred-volume
band, margin, discount calculation, investigator pay, profitability,
internal cost, competitor comparison. Admin only.

IMPLEMENTATION PRIORITY: 1 separate the two models · 2 insurance copy ·
3 private copy · 4 mobile hierarchy · 5 send sends the right version ·
6 independent editing · 7 internal authorization + retainer-balance
calculations. Do not begin unrelated portal features until these two rate
sheets are working correctly.

FINAL CLIENT-FACING SUMMARY —
INSURANCE: 8 Hours $1,200 · 16 Hours $2,300 · 24 Hours $3,300 · Additional
Authorized Hours $150/hr · Routine local costs included · Outside service
area quoted first.
PRIVATE: Retainer $1,500 · Investigative Rate $100/hr · 4-hour minimum ·
Retainer applied to work performed · Additional time only with client
approval · Routine local costs included · Outside service area quoted first.

These are TWO separate rate sheets. Do not combine their pricing logic or
client-facing copy.

Owner's closing note: the retainer sheet distinguishes **"no extra fees"
from "no billable work"** — investigator time reviewing footage or preparing
the report is charged against the retainer at the same $100/hr without being
a separate fee. That protects against promising unlimited back-office work
for free while keeping the simple pricing.
