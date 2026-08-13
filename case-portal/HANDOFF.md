# Portal Expansion — Priority Build Handoff (INTERNAL)

**This file is the build order for the case portal, recorded verbatim from the
owner's handoff on 2026-08-12.** It lives in `case-portal/` because that
directory never deploys to the public site. The first insurance handoff was
lost in a session crash and had to be reconstructed; this one is committed
before any of it is built. Do not prune it — mark phases done instead.

Progress ledger (update as phases land):

| Priority | Status |
| --- | --- |
| 1. Case Workspace | **done** — 2026-08-12 (Overview/Subject/Activity/Field/Auth/Assignment tabs) |
| 2. Case Type System | **done** — 2026-08-12 (17 seeded, admin-addable, DB-driven) |
| 3. Activity Log | **done** — 2026-08-12 (8 quick kinds; media attachment waits on priority 6) |
| 4. Start / End Investigation Day | **done** — 2026-08-12 (hours + mileage totalled) |
| 7. Insurance Authorization Tracking | **done** — 2026-08-12 (hours + budget, configurable thresholds; REQUEST MORE not built) |
| 5. Daily Report Builder | **done** — 2026-08-12 (draft from log, 5 statuses, admin-only approval) |
| 6. Evidence Management | **done** — 2026-08-13 (owner enabled R2; `case-evidence` bucket created; Evidence tab both roles: upload/serve through the Worker's session checks, 5 classifications, audited admin-only delete that keeps the record; FREE-PLAN FAILSAFE: uploads refuse at 9 GB / 75 MB per file, storage card warns at 75%, daily site-health opens an issue at 75%) |
| 8. Dashboard Improvements | **done** — 2026-08-12 (operational cards, click-to-filter; Awaiting Client / Ready to Close / Expenses arrive with priorities 18/20/12) |
| 12. Expenses + Mileage | **done** — 2026-08-12 (three separate classifications; receipt images wait on priority 6 storage) |
| 15. Case Notes + Visibility | **done** — 2026-08-12 (7 types, 3 visibilities, enforced in the Worker's query) |
| 9. Investigator Role | **done** — 2026-08-13 (My assignments · Today · Reports · Expenses; Calendar/Availability join with 14) |
| 10. Investigator Redaction | **done** in substance (FIELD_KEEP, workspace money stripping, note visibility) — per-case "view client identity" toggle shipped with 11 |
| 11. Rate Sheets / pay split | **done** — 2026-08-13 (per-user comp, per-case client rate, identity toggle; client-org rates await a client entity) |
| 13. Assignment acceptance | **done** — 2026-08-13 (offer → accept/decline; thin pre-acceptance view; owner decision: ONE offer at a time, no competing) |
| 14. Calendar | **done** — 2026-08-13 (`/calendar` month view, both roles: worked/running days + pending offers; admin sees everyone, an investigator their own; offer chips stay thin) |
| 16. Private-case intake details | **done** — 2026-08-13 (per-type field sets on the Subject tab: infidelity / custody / general, chosen by case type; Worker allow-lists the keys; observe-and-document framing; admin writes, assigned investigator reads) |
| 17. Subjects + vehicles | **done** — 2026-08-13 (structured records on the Subject tab, several per case, vehicles nested; both roles write on cases they can open, edits stamped, no delete; photographs join with priority 6) |
| 18. Communication log | **done** — 2026-08-13 (Comm log tab: 7 methods, date/time/person/summary/follow-up, notes-style visibility enforced in the Worker; documents only, sends nothing) |
| 19. Follow-up tasks | **done** — 2026-08-13 (Tasks tab: due date/priority/status, admin-created; an investigator sees only tasks assigned to them and can only mark theirs done; overdue = dashboard card, click-to-filter) |
| 20. Case closure | **done** — 2026-08-13 (nine stages in case_status with the coarse column kept in sync; eight-item closing checklist is the only door to closed; Awaiting client / Ready to close dashboard cards; reopen from the status select) |
| Phase 4 (client portal, redaction, safety, profitability) | not started |

---

The handoff, verbatim:

## CORE OBJECTIVE

Expand the existing Always Precise Investigations Case Portal into the
operational system used to run:

* Insurance surveillance cases
* Workers' compensation investigations
* Liability / bodily injury investigations
* Disability cases
* SIU / suspected fraud cases
* Field investigations
* Statements
* Background / social media investigations
* Adultery / infidelity investigations
* Child custody investigations
* Domestic / cohabitation investigations
* Civil investigations
* Asset / business investigations
* Locate / skip trace cases
* Other private investigations

The system currently needs to work primarily for the two owners/admins, who
will also perform investigative work. Later, additional investigators will be
added. Therefore: **BUILD ONE CASE SYSTEM WITH ROLE-BASED ACCESS.** Do not
create two completely separate case-management systems. Admins should be able
to perform both admin functions and investigator functions. Future
investigators should use the same underlying case records but receive a
restricted view.

**IMPORTANT — BUILD IN THIS ORDER.** Do not try to build every feature at
once. Implement the following priorities sequentially.

## PRIORITY 1 — CASE WORKSPACE

This is the most important upgrade. Keep the current overall visual design.
When an admin opens a case, convert it into a complete operational workspace.
Create tabs or sections for:

1. Overview
2. Subject
3. Assignment
4. Activity Log
5. Surveillance / Field Work
6. Evidence
7. Expenses
8. Reports
9. Communications
10. Authorization
11. Billing
12. Internal Notes

Do not require every section for every case. Show relevant sections
dynamically based on case type.

## PRIORITY 2 — CASE TYPE SYSTEM

Every case must have a clear case category.

Insurance: Workers' Compensation Surveillance · Liability / Bodily Injury
Surveillance · Disability Surveillance · SIU / Fraud · Field Investigation /
Canvass · Recorded Statement · Scene Investigation · Background / Social
Media · Asset / Business Investigation

Private: Adultery / Infidelity · Child Custody · Domestic / Cohabitation ·
Background Investigation · Locate / Skip Trace · Civil Investigation · Asset
Investigation · Other / Custom

Allow admins to add future case types from configuration rather than
hard-coding everything throughout the application.

## PRIORITY 3 — ACTIVITY LOG / INVESTIGATOR TIMELINE

One of the highest-value features. Inside every field case, an ACTIVITY LOG
of timestamped entries such as:

    7:03 AM  Arrived in vicinity of subject residence.
    7:14 AM  Subject vehicle observed parked at residence.
    8:02 AM  Subject departed residence.
    8:17 AM  Subject arrived at ABC Fitness.

Each entry supports: date, time, activity description, optional location,
optional photo, optional video, optional internal note.

Quick buttons: Add Activity · Add Photo · Add Video · Add Location · Add
Vehicle · Add Note · Add Mileage · Add Expense.

The interface must work well on a phone. Admins must be able to use this
exact field interface because the owners currently conduct their own
investigations.

## PRIORITY 4 — START / END INVESTIGATION DAY

START INVESTIGATION records: investigator, date, start time, case,
assignment, optional beginning mileage. During the day, activity entries are
recorded. END INVESTIGATION DAY captures: end time, ending mileage, total
hours, total mileage, expense entries, investigator summary.

Do not automatically finalize or send anything to the client. Everything
remains reviewable by Admin.

## PRIORITY 5 — DAILY REPORT BUILDER

Use activity-log entries to help create a draft surveillance chronology.
`8:17 AM — Subject arrived ABC Fitness.` becomes `At approximately 8:17 AM,
the subject arrived at ABC Fitness.` Every generated sentence is editable.
The system NEVER treats automatically generated text as a final report
without human review.

Workflow: Activity Log → Generate Draft Daily Report → Investigator Review →
Submit for Admin Review → Admin Edit / Approve → Final Report.

Statuses: Draft · Submitted · Needs Revision · Approved · Delivered. Admins
can perform all stages themselves.

## PRIORITY 6 — EVIDENCE MANAGEMENT

EVIDENCE per case: photos, videos, documents, screenshots, audio, PDFs.
Every item captures: case, investigation date, investigator, upload time,
original filename, description, related activity-log entry, evidence type.

Admin classifications: Client Deliverable · Internal Only · Do Not Use ·
Needs Review · Needs Redaction.

Never overwrite original evidence. Originals remain preserved.

## PRIORITY 7 — INSURANCE AUTHORIZATION TRACKING

A prominent authorization panel: Authorized 24 hours / Used 13.5 / Remaining
10.5. Also financial: Authorized Budget $3,600 / Billable So Far $2,025 /
Remaining $1,575. Warning indicators at configurable thresholds (75%, 90%,
100%) — not hard-coded throughout the application.

REQUEST ADDITIONAL AUTHORIZATION: initially generates/administers an
internal request only. No automatic client email until communications are
intentionally configured.

## PRIORITY 8 — ADMIN DASHBOARD IMPROVEMENT

Keep the existing dashboard style. Move the top cards over time from
case-type counts to operational alerts: Open Cases · Needs Assignment ·
Active Today · Reports Due · Authorization Low · Awaiting Client · Ready to
Close · Unsubmitted Expenses. The dashboard should answer: WHAT NEEDS MY
ATTENTION TODAY?

## PRIORITY 9 — INVESTIGATOR ROLE

After the case-management tools work for admins: a restricted INVESTIGATOR
ROLE. Not a miniature admin portal. Navigation: My Assignments · Today ·
Calendar · Reports · Expenses · Availability. Investigators only see cases
specifically assigned to them unless an admin grants additional access.

## PRIORITY 10 — INVESTIGATOR INFORMATION REDACTION

Critical before outside investigators are added. Operational information an
investigator may see: subject name, photograph, known addresses, vehicles,
assignment objective, surveillance dates, known schedule, relevant
restrictions/allegations, relevant prior surveillance, relevant associates,
special field instructions.

Client / commercial information hidden by default: carrier/client name when
not operationally necessary, adjuster/client contact info, client email and
phone, client billing rate, client contract, profit margin, negotiated
pricing, administrative communications, other investigator compensation.
Show instead: `Client: Insurance Carrier — C-0042` / `Client Contact: Admin
Managed`. Admin permission "Allow Investigator to View Client Identity",
default NO.

## PRIORITY 11 — RATE SHEETS

Keep the current Admin RATE SHEETS; never expose them to standard
investigators. Admin-configurable: client hourly rate, surveillance minimum,
client mileage rate, investigator rate, investigator mileage reimbursement,
rush multiplier, holiday multiplier, case-specific rate, client-specific
rate, preferred-volume rate. CLIENT RATE and INVESTIGATOR COMPENSATION stay
separate fields (e.g. $150/hr vs $55/hr). An outside investigator never sees
the client billing rate unless specifically authorized.

**Owner decisions recorded 2026-08-13:** mileage is never billed to a client
(all-in pricing covers it) — mileage records exist for investigator
reimbursement and the firm's taxes; and offers never compete — one at a time,
resolved before the next.

## PRIORITY 12 — EXPENSES + MILEAGE

Per-case EXPENSES: mileage, tolls, parking, hotel, airfare, rental vehicle,
records, database, equipment, meals if authorized, other. Each supports
amount, date, investigator, receipt upload, description. Classifications —
Reimbursable to Investigator YES/NO, Billable to Client YES/NO, Internal
Company Expense YES/NO — remain separate concepts.

## PRIORITY 13 — INVESTIGATOR ASSIGNMENT SYSTEM

Assignment: case, investigator, assignment date, investigation date,
expected hours, general location, instructions, compensation, mileage
terms, status. Statuses: Offered · Accepted · Declined · Assigned · In
Progress · Completed. Before acceptance, an outside investigator sees only:
general location, investigation type, date, estimated hours, investigator
compensation. Buttons: ACCEPT / DECLINE.

## PRIORITY 14 — CALENDAR

Shared operational calendar. Admin: all cases + all investigators.
Investigator: my assignments. Labels: SURV · STATEMENT · CANVASS · COURT ·
PRIVATE · CUSTODY · INFIDELITY · OTHER. Clicking an event opens the case or
assignment.

## PRIORITY 15 — CASE NOTES + VISIBILITY

Categorized notes: Investigator Note · Admin Note · Client Communication ·
Case Strategy · Subject Information · Evidence Note · Billing Note. Each
with visibility: ADMIN ONLY · ADMIN + INVESTIGATOR · CLIENT ELIGIBLE. Never
automatically send a Client Eligible note — it only means it may later be
included in a client-facing record.

## PRIORITY 16 — PRIVATE INVESTIGATION INTAKE FIELDS

Conditional fields per private case type.

INFIDELITY / ADULTERY: subject name, photograph, residence, employer,
workplace, vehicles, normal work schedule, known routine, suspected
companion, suspected locations, known social accounts, upcoming events,
travel, client concerns, investigation objectives. Avoid building fields
that encourage illegal or unauthorized monitoring; document lawful
investigative objectives.

CHILD CUSTODY: subject/parent, child names only when operationally
necessary, custody schedule, exchange dates and locations, school/daycare,
known residences, vehicles, court dates, relevant court restrictions
supplied by client, known associates, specific allegations/concerns,
investigation objectives.

Frame objectives around OBSERVE + DOCUMENT. The application makes no legal
conclusions. Good: "Document persons present and observed activity during
the scheduled custody period." Avoid: "Determine whether this parent is
violating the custody order." Investigators document facts; courts and
attorneys interpret legal significance.

## PRIORITY 17 — VEHICLES + SUBJECT INFORMATION

Reusable structured records. SUBJECT: name, alias, DOB if legitimately
supplied, photograph, height, weight, hair, other descriptors, addresses,
employer, phone if legitimately obtained, social accounts, notes. VEHICLE:
year, make, model, color, plate, state, photograph, registered owner if
lawfully obtained, notes. Multiple vehicles per subject.

## PRIORITY 18 — COMMUNICATION LOG

Per-case COMMUNICATIONS: email, phone call, text, client update,
investigator communication, authorization request, internal. Each records
date/time, person, method, summary, follow-up date, visibility. Version 1
documents communication; it does not need to send email.

## PRIORITY 19 — FOLLOW-UP TASKS

Simple case tasks (call adjuster, request additional authorization, review
report, upload final video, confirm surveillance date, send invoice, contact
client, follow up on records). Fields: task, case, assigned person, due
date, priority, status. Overdue tasks show on the Admin Dashboard.

## PRIORITY 20 — CASE CLOSURE

CLOSE CASE with checklist: field work completed, activity logs completed,
evidence uploaded, report completed, admin review completed, client
deliverables prepared, expenses reviewed, billing reviewed. Statuses: Open ·
Assigned · In Progress · Report Review · Awaiting Client · Complete ·
Closed · On Hold · Cancelled.

## NEXT PHASE — DO NOT BUILD UNTIL CORE ABOVE IS WORKING

FUTURE — CLIENT PORTAL: client users see only their organization's cases.
My Cases, Submit Assignment, Case Status, Reports, Media, Secure Messages,
Authorization Requests, Invoices, Request Additional Investigation. Do not
build before proper organization/tenant isolation exists.

FUTURE — REDACTION WORKFLOW: PREPARE CLIENT COPY preserving ORIGINAL and
creating REDACTED CLIENT COPY (minor identities, unrelated third parties,
phone numbers, addresses, plates, faces, account numbers, internal notes).
Never overwrite original evidence.

FUTURE — FIELD SAFETY: CHECK IN / CHECK OUT; dashboard shows Investigator —
ACTIVE, Last Check-In. No invasive continuous location tracking without a
legitimate operational need and appropriate disclosure/consent.

FUTURE — CASE PROFITABILITY: once client rates and investigator costs are
reliably captured — client revenue, investigator labor, mileage, expenses,
gross margin, case profitability. ADMIN ONLY.

## NAVIGATION RECOMMENDATION

ADMIN — current: Cases | Rate Sheets | Staff. Recommended expansion:
Dashboard | Cases | Calendar | Clients | Rate Sheets | Expenses | Reports |
Documents | Staff | Settings. Do not add every tab immediately — add them as
their underlying functionality is completed.

INVESTIGATOR — My Assignments | Today | Calendar | Reports | Expenses. Do
not show rate sheets, clients, client contracts, admin settings, company
financials, other investigators, or profit information unless specifically
authorized.

## ROLE MODEL

At minimum: ADMIN (full access), INVESTIGATOR (restricted to assigned
investigations). Design the database so future roles (CLIENT, OFFICE STAFF)
can be added without rewriting the application.

## SECURITY REQUIREMENTS

Do not weaken the security already implemented. Continue using
authentication, server-side authorization, role-based access, private file
storage, input validation, audit logging where practical, secure sessions,
HTTPS, protected media access. Do not rely only on hiding buttons in the
frontend. Every restricted record must also be protected server-side. An
investigator must not be able to access another investigator's case by
manually changing a URL or ID.

## AUDIT TRAIL

For important records: created by/at, edited by/at. For significant changes,
record: case assignment, report approval, authorization changes, case
closure, evidence upload, evidence deletion, permission changes. Do not
silently overwrite important investigative records.

## DESIGN REQUIREMENT

Keep the current clean professional appearance: existing typography, navy
header, cards, spacing, buttons, table style. Enhance rather than replace.
Field-investigator interfaces must be significantly more mobile-friendly
because they will often be used from a phone.

## IMPLEMENTATION ORDER SUMMARY

PHASE 1 — MAKE IT USEFUL NOW: 1 Case Workspace, 2 Case Types, 3 Activity
Log, 4 Start/End Investigation, 5 Daily Report Builder, 6 Evidence
Management, 7 Insurance Authorization Tracking, 8 Dashboard Improvements.

PHASE 2 — PREPARE FOR OUTSIDE INVESTIGATORS: 9 Investigator Role, 10 Client
Information Redaction, 11 Separate Client Rates / Investigator Pay, 12
Mileage + Expenses, 13 Assignment Acceptance, 14 Calendar, 15 Note
Visibility.

PHASE 3 — EXPAND CASE OPERATIONS: 16 Private-case conditional intake, 17
Subjects + Vehicles, 18 Communications, 19 Follow-Up Tasks, 20 Case Closure.

PHASE 4 — LATER: Client Portal, automated authorization requests, client
report delivery, client invoices, redaction tools, field safety check-ins,
case profitability, advanced analytics.

## FINAL INSTRUCTION TO CLAUDE CODE

Do not attempt a massive rewrite. Before each phase: inspect the existing
implementation; identify the smallest clean architectural change; preserve
existing functionality; reuse existing components; maintain current portal
styling; update database schema carefully; add proper server-side role
checks; test Admin behavior; test Investigator restrictions; test mobile
behavior; do not expose real client or case information during testing; use
clearly labeled test/demo cases.

Finish and test each major feature group before beginning the next one. The
immediate goal is not to build enterprise investigation software overnight.
The immediate goal is to make the existing portal genuinely useful for
Always Precise Investigations while creating the correct architecture for
future investigators and insurance clients.

The field workflow comes first — case workspace, timeline, start/end day,
report builder, evidence and authorization — because those are features the
owners can actually use now. The staff/investigator restrictions come
immediately after, so bringing investigators aboard does not mean rebuilding
the portal.
