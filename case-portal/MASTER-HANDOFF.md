<!-- RECORDED VERBATIM from the owner's upload on 2026-08-13
     (ALWAYS_PRECISE_MASTER_CLAUDE_HANDOFF_2026-08-13.md, uploaded twice —
     the two copies were byte-identical). Lives in case-portal/ because that
     directory is excluded from the Pages deploy. Do not prune or edit the
     body: mark progress in NEXT.md and in the per-feature ledgers instead.

     The upload also carried nine reference PNGs (~10 MB). Their FILENAMES are
     preserved in section 40 below; the binaries are deliberately NOT committed
     — a marketing repo does not need 10 MB of mockups in its history, and the
     owner can re-upload any one of them when the phase that needs it starts.
     06_active_surveillance_mobile_large_reference.png is the one to ask for
     when SURVEILLANCE.md work begins. -->

# ALWAYS PRECISE INVESTIGATIONS
## MASTER CLAUDE CODE HANDOFF — AUGUST 13, 2026
### Audit what is already shipped, then continue every remaining handoff without losing the queue

---

# 0. READ THIS FIRST

This file consolidates the owner’s handoffs from today into ONE source of truth.

The current codebase is already substantially ahead of the earliest handoffs. Do **not** blindly rebuild features just because they appear later in this document.

## First actions in a fresh Claude Code session

1. Read `NEXT.md`.
2. Read `INTAKE-NA.md`.
3. Read `SURVEILLANCE.md`.
4. Inspect current `master`.
5. Inspect current routes, data model, permissions, Workers/server actions, report/evidence storage, rate-sheet flow, invoices, Case Build, and tests.
6. Compare what exists against this master handoff.
7. Mark each item:
   - **DONE**
   - **PARTIAL**
   - **MISSING**
   - **NEEDS UX CLEANUP**
8. Continue only from the missing/partial items.
9. Preserve the green code already shipped.
10. Keep the same disciplined build → test → PR → merge → rebase workflow.

Do not create parallel implementations of already-shipped features.

---

# 1. CURRENT SHIPPED BASELINE — DO NOT REBUILD

Claude Code reported that the complete UIBUILD handoff shipped through PRs #42–#49 and the deploy is green.

## PR #42
- Sidebar rail
- Mobile drawer
- Dashboard landing
- Case Package cards
- Progress rings
- One computed “Next Step”

## PR #43
- Case header
- Four-section navigation
- `WS_TAB`-derived tab logic
- Admin case overview

## PR #44
- Timeline-first activity panel
- Add Activity sheet
- Search
- Categories
- Favorites
- One-tap “No change”
- Arrival sentence generator

## PR #45
- Branded report preview
- `report_versions`
- Submitted-version preservation
- Evidence gallery
- Real thumbnails

## PR #46
- Case Build six-step rail
- Live package contents
- Video-delivery state
- Completed artifact view

## PR #47
- Leads & Intakes desk
- Existing submissions reused
- Manual in-portal intake
- Three-step rate-sheet send wizard
- Strict Worker-paired intake links so Insurance and Private cannot mix

## PR #48
- Field case home
- Shared helper scope that hides Admin-only Build/Invoice from field view
- Mobile bottom navigation

## PR #49
- Test controls moved to Settings → Developer & Testing
- UIBUILD handoff closed

## Current testing state reported by Claude
- Worker tests: 624
- Portal e2e: 481
- Intake: 130
- Alerts: 41
- Green deploy
- Green Worker
- Schema dispatch completed

### Important debugging lesson already fixed
Do not reintroduce “landing vs click” loading bugs. Any page that renders directly on sign-in must load the same data that a later tab click would load.

---

# 2. MASTER PRODUCT MODEL

Always Precise has one underlying operations system with multiple views.

## PUBLIC WEBSITE
Client acquisition and assignment entry.

## ADMIN PORTAL
Operations center.

## INVESTIGATOR PORTAL
Restricted field/case view.

## ACTIVE SURVEILLANCE MODE
Mobile field tool connected to the same case.

## CASE BUILD
Admin client-deliverable assembler.

## INVOICING / BILL HANDOFF
Commercial payment workflow.

These should share the same underlying case/client/evidence/report data whenever appropriate.

Do not create silos.

---

# 3. TWO RATE SHEETS — KEEP STRICTLY SEPARATE

There are exactly TWO core rate-sheet models.

## A. INSURANCE ASSIGNMENT RATES

For:
- Insurance carriers
- TPAs
- Self-insured employers
- SIU
- Defense counsel
- Approved commercial insurance clients

### Client-facing pricing

**One Day — 8 Hours**
- $1,200

**Two Days — 16 Hours**
- $2,300

**Three Days — 24 Hours**
- $3,300
- Recommended Initial Authorization

**Additional Authorized Hours**
- $150/hr
- Requires prior authorization

### Client-facing wording

Use a simple package structure.

Do NOT show:
- “$100 below standard”
- “$300 below standard”
- “preferred-volume band”
- rack-rate math
- margin
- competitor pricing
- investigator compensation

### Included in the Flat Rate

Use concise language similar to:

> Standard local travel, routine case expenses, investigative reporting, video review, photographs and delivery of case materials are included in the authorized package price.

Then:

**No routine add-on fees.**

Do not show:

> Additional Fees — None

That wording is confusing and unnecessarily invites concern.

### Outside Normal Service Area

Use:

**Quoted in Advance**

and explain significant travel is agreed before acceptance.

---

## B. PRIVATE CLIENT — $1,500 RETAINER

For:
- Private surveillance
- Infidelity / adultery
- Child custody
- Domestic / cohabitation
- Other private cases

### Client-facing pricing

**Retainer**
- $1,500

**Investigative Rate**
- $100/hr

**Minimum Engagement**
- 4 hours

The retainer is applied to authorized investigative services. It is not a separate surcharge.

### Clear wording

Use:

> A $1,500 retainer is required to begin. The retainer is applied directly to authorized investigative services billed at $100 per hour.

### Straightforward Billing

Do not show:

> Additional Fees — None

Instead use language similar to:

> Standard local operating costs are included. There are no routine mileage, toll, parking, report or case-delivery surcharges within our normal service area.

### Additional time

Use:

**If Additional Time Is Needed**

> We contact you before exceeding the authorized retainer. Additional investigative time is never incurred without your approval.

### Important billing distinction

Do not promise unlimited free report-writing/video review.

Field work, necessary video review, documentation and report preparation may consume legitimate investigator time at the same investigative rate while avoiding separate “report fee” or “video review fee” surcharges.

---

# 4. RATE SHEET → CORRECT INTAKE PAIRING

This must remain strict and centralized.

## Insurance Rate Sheet
→ **Insurance Assignment Intake**

## Private $1,500 Retainer Rate Sheet
→ **Private Client Intake**

On the send screen use context-specific checkboxes:

### Insurance
`☐ Include Insurance Assignment Intake Form`

### Private
`☐ Include Private Client Intake Form`

Do not use one ambiguous generic checkbox if the selected rate-sheet type already determines the correct intake.

Before send, preview:

- recipient
- selected rate sheet
- whether intake is included
- exact intake type

Returned intake should remember the rate-sheet send event when possible using a secure token/reference.

---

# 5. MANUAL ADMIN INTAKE / LEADS

Cases must not enter only through public forms.

Admin needs:

# + INTAKE A CLIENT

First branch:

- Insurance / Commercial
- Private Client

Support:
- Save Lead
- Send Rate Sheet
- Send Intake
- Convert to Case
- Create Case directly when enough information is known

## Lead statuses

- Lead
- Rate Sheet Sent
- Intake Sent
- Intake Received
- Contacted
- More Info Requested
- Converted to Case
- Declined
- Closed Lead

Do not confuse lead status with active-case status.

---

# 6. INTAKE-NA — NEXT IMMEDIATE WORK

This is the current next task in `NEXT.md`.

Public intake forms should allow rapid submission even when the client does not know every field.

## Core rule

# SEND US WHAT YOU KNOW NOW.

Do not force fake information.

Avoid fake values such as:
- N/A inside real data fields
- 0000
- fake phone
- placeholder DOB
- 01/01/1900
- “unknown” typed just to bypass validation

## Structured field availability state

Where practical store:

- `provided`
- `not_available`
- `not_applicable`

Example concept:

```text
employer_value = null
employer_status = "not_available"
```

Do not just write “N/A” into the employer value.

## User-facing language

- **I don't have this information right now**
- **Not applicable**

Keep the UI compact; do not add a visually noisy checkbox beside every single line if a cleaner inline pattern works.

---

## Insurance public intake — truly required fields should be minimal

Generally:
- Organization / Carrier
- Contact Name
- At least one reliable contact method
- Assignment Type
- Subject/Claimant when necessary to identify the assignment
- Short Investigation Objective

Most other fields should be allowed to be unknown initially.

Examples:
- Claim #
- DOB
- Date of loss
- Employer
- Exact address
- Secondary address
- Phone
- Attorney
- Vehicle
- Plate
- Schedule
- Restrictions
- Appointments
- Court dates
- Prior surveillance
- Billing contact
- Vendor #
- PO #
- authorization #

### Requested start choices
- Specific date
- As Soon As Available
- Flexible
- To Be Determined

### Authorization choices
- 8 hours / 1 day
- 16 hours / 2 days
- 24 hours / 3 days
- Custom
- **Authorization Pending**

An intake can be submitted with Authorization Pending.

Do not display a confirmed dollar amount until Admin confirms.

---

## Private public intake — required fields should be minimal

Generally:
- Client Name
- Email or Phone
- Case Type
- Basic Objective

Allow unknown/unavailable for:
- Subject DOB
- Employer
- Work schedule
- Exact residence
- Vehicle
- Plate
- Suspected companion
- Court dates
- Attorney
- Custody details
- Upcoming schedule

---

## Intake final review

Show two concise sections:

### PROVIDED

### NOT AVAILABLE YET

Do not treat legitimately unknown optional fields as validation failures.

---

# 7. RETURNED INTAKES ON ADMIN DASHBOARD

Returned intake should immediately be actionable.

Add/keep:

# INTAKES TO REVIEW

Dashboard/queue should remain compact.

Do not dump the full intake on the dashboard.

## Insurance intake summary example

- Carrier
- Adjuster / Contact
- Claim #
- Subject
- Assignment Type
- Requested Start
- Requested Authorization

Before Admin acceptance:

**REQUESTED — 3 Days / 24 Hours**

After Admin confirmation:

**CONFIRMED — 3 Days / 24 Hours / $3,300**

### Important distinction

Do not label a selected intake package “Approved” just because the client selected it.

Use:
- Requested Authorization
- Confirmed Authorization

---

## Private intake summary example

- Client
- Case Type
- Subject
- Requested Start
- Retainer Requirement
- Retainer Status

Example:

**$1,500 RETAINER REQUIRED**

then:
- Retainer Pending
- Retainer Received
- Active

---

## Intake review actions

- Accept Assignment
- Request More Information
- Decline
- Save as Lead
- Create Case

When accepted, reuse the intake data.

Do not make Admin retype:
- client
- subject
- claim #
- vehicles
- addresses
- objective
- uploads
- authorization

Preserve the original intake submission separately from later case edits.

---

# 8. STREAMLINED PORTAL UX — CURRENT BASELINE + GAP AUDIT

The streamlined look is now the baseline.

Use the supplied mockups as reference, but do not rebuild what #42–#49 already shipped.

## Desktop main navigation target

Left sidebar:
- Dashboard
- Cases
- Calendar
- Rate Sheets
- Invoices
- Leads & Intakes
- Clients
- Reports
- Evidence
- Expenses
- Tasks
- Staff
- Settings

Bottom:
- `+ Intake a Client`

Mobile:
- sidebar collapses to drawer/hamburger

---

## Dashboard priorities

Top should stay limited to the most useful operational metrics, for example:
- Open Cases
- Needs Assignment
- Reports Due
- Ready to Close
- Outstanding

Below:

# CASE PACKAGES

At-a-glance active case progress.

Each card should show applicable progress such as:
- Activity
- Report
- Photos
- Video
- Build
- Invoice

and one computed:

# NEXT STEP

with:

# CONTINUE CASE →

The next step should route directly to the most important unfinished task.

---

# 9. CASE DETAIL — KEEP SIMPLE

Preferred top-level Admin case sections:

- Overview
- Fieldwork
- Report & Evidence
- Admin

Investigator view should be even simpler:
- Assignment
- Activity
- Evidence
- Report

Avoid returning to the old ten-equal-tabs layout.

Every deep screen should have a visible contextual back action:
- ← Back to Cases
- ← Back to Case
- ← Back to Intakes
- ← Back to Invoices

Do not rely only on browser Back.

---

# 10. FIELD ACTIVITY — FAST, TIMELINE FIRST

The investigator should feel like they are documenting the investigation, not filling out a large administrative form.

## Main entry

`+ ADD ACTIVITY`

Quick / Custom

Search:
**Search or pick an action...**

Categories:
- Favorites
- Arrival
- No Activity
- Subject
- Vehicle
- Location
- Surveillance
- End Day

Show only:
- Time
- Details
- Subject documented
- Photo taken
- Video acquired

Put secondary fields under:

**More Details**

including:
- location
- vehicle
- internal note
- linked evidence

---

## Useful quick lines/actions

### Arrival
- Arrived in vicinity of subject residence
- Established surveillance position
- Subject arrived at residence
- Subject arrived at location

### No Activity
- No change noted
- No subject activity observed
- Residence remained quiet
- Vehicles remained at residence

### Subject
- Exited residence
- Entered residence
- Departed
- Returned
- Entered vehicle
- Exited vehicle
- Walking
- Standing
- Sitting
- Bending
- Stooping
- Reaching
- Carrying
- Lifting
- Pushing
- Pulling
- Loading
- Unloading
- Climbing stairs
- Shopping
- Yard work
- Recreational activity
- Entered business
- Exited business
- Met another individual
- Other

### Vehicle
- Subject vehicle observed
- Vehicle departed
- Vehicle arrived
- Subject entered vehicle
- Subject exited vehicle
- Mobile surveillance initiated
- Vehicle stopped
- Vehicle parked

### Surveillance
- Lost visual
- Re-established visual
- Changed surveillance position
- Unable to safely maintain visual
- Surveillance discontinued

---

## Arrival sentence generator

Allow details such as:
- vehicles present
- direct/indirect view
- primary route of departure

Example generated editable narrative:

> The Investigator arrived in the vicinity of the subject's residence on file. Two vehicles were observed at the residence. The Investigator established an indirect surveillance position along the primary route of departure.

Templates are writing accelerators only.

Never fabricate facts.

---

# 11. REPORT BUILDING

Activity entries should automatically build a report draft.

The investigator should not copy timeline data manually into another report.

Report UI:
- Draft Preview
- Chronology
- Summary
- Attachments
- Versions

On:

# SUBMIT REPORT

1. Preserve exact submitted version.
2. Timestamp submission.
3. Record submitting investigator.
4. Generate Submitted Report PDF.
5. Change status to Report Submitted.
6. Add to Admin review queue.

Admin edits should create/maintain a final version without silently overwriting the investigator-submitted snapshot.

Admins who performed their own investigation may have:
- Submit & Finalize
if permissioned.

---

# 12. EVIDENCE

Evidence should be visual.

Tabs:
- Photos
- Video
- Documents
- All

Photo cards:
- thumbnail
- time
- caption
- linked activity
- status

Video cards:
- thumbnail when available
- duration
- time
- caption
- storage status

Classifications:
- Client Eligible
- Internal Only
- Needs Review
- Needs Redaction
- Do Not Use

Do not make classification controls dominate the screen.

---

# 13. CASE BUILD — ADMIN CLIENT PACKAGE

After report submission, Admin owns the final client package.

Workflow:

1. Review Report
2. Select Evidence
3. Select Video / Attachments
4. Package Options
5. Preview
6. Finalize

Dashboard/queue:

# CASES READY TO BUILD

## Package types

### Report Only
Final report PDF.

### Report + Selected Photos
Combined professional PDF.

### Full Client Package
- Final Investigative Report.pdf
- Evidence Index.pdf
- selected original photos
- selected video
- selected attachments
- delivery link when applicable

### Custom Package
Admin controls exact contents.

---

## Report + photos PDF

Should look like a real investigative report.

Include:
- branding
- case information
- assignment objective
- summary
- chronology
- selected photographic evidence
- captions
- evidence index where appropriate

Do not simply append huge unlabeled images.

Original evidence must never be overwritten by report copies or thumbnails.

---

## Multi-day cases

Support one final report containing:

- Investigation — Day 1
- Investigation — Day 2
- Investigation — Day 3
- Combined Summary
- Photographic Evidence
- Video Evidence Index

Do not assume one case = one day.

---

# 14. DROPBOX VIDEO DELIVERY

Use Dropbox as an optional external delivery/storage provider for large video.

Do not make Dropbox the brain of the case system.

Portal remains source of:
- case
- activity
- evidence metadata
- report
- Case Build configuration
- audit history

Dropbox may hold/deliver:
- large client video copies
- optional large client package copies

## Provider-neutral architecture

Conceptual fields:
- storage_provider
- external_file_id
- external_folder_id
- external_path
- external_share_id
- external_share_url
- share_created_at
- share_expires_at
- share_revoked_at

Initial provider:
- Dropbox

Future providers could be:
- Drive
- OneDrive
- S3
- other

---

## Case Build video flow

Admin selects video.

Then:

# ADD VIDEO TO PACKAGE

→ Upload Selected Video to Dropbox

→ Create Video Delivery Link

→ Copy Link

→ Reference selected videos in report/evidence index/package

Do not embed large playable video inside normal PDF.

## Security

Where current Dropbox API/plan actually supports:
- expiration
- password
- revoke
- regenerate

Do not claim capabilities that are not truly configured.

## Original evidence

Do not delete or move away the only original evidentiary copy merely because a Dropbox delivery copy was created.

---

# 15. ACTIVE SURVEILLANCE MODE — NEXT MAJOR WORKSTREAM

After `INTAKE-NA.md`, this is the major feature to build/finish.

## Product principle

# ACTIVE SURVEILLANCE MODE IS A MOBILE-FIRST VIEW OF THE EXISTING CASE.

It is not a separate database and not a second login.

Everything should write directly to:
- same case
- same investigation day
- same activity log
- same evidence
- same report
- same investigator assignment

Suggested route concept:

`/portal/cases/:caseId/surveillance`

Follow current router conventions if better.

---

# 16. ACTIVE SURVEILLANCE MODE — MOBILE HOME

Use the supplied large mobile mockup as visual guidance.

Dark navy field UI.

Header:
- Case #
- Case type badge
- menu

Then:

# DAY 1

Large elapsed timer:
**02:47:32**

Then:

# END INVESTIGATION DAY

Quick Add:
- Activity
- Photo
- Video
- Note

Then:
- Last Activity
- View Timeline

Then:

# 🎤 TAP TO SPEAK

Bottom navigation:
- Home
- Activity
- Evidence
- Report
- More

This must be usable one-handed and with minimal scrolling.

---

# 17. START / RESUME INVESTIGATION DAY

Start Day captures:
- case
- investigator
- server-side start time
- optional beginning mileage
- optional location
- assignment

Timer must derive from persisted server time.

Phone sleep, refresh, browser suspension, or route changes must not reset the timer.

If an active day exists:

# RESUME ACTIVE SURVEILLANCE

Do not create overlapping days accidentally.

---

# 18. ACTIVE SURVEILLANCE — QUICK ACTIVITY

Use the same underlying Activity data as normal portal.

Tap:
# ACTIVITY

Open:
- Quick
- Custom

Search:
**Search or pick an action...**

Use Favorites and the realistic quick actions listed earlier.

After selection show only:
- Time
- Details
- Subject documented
- Photo taken
- Video acquired
- More Details

Primary:
# SAVE ACTIVITY

After save:
- Activity Saved
- Add Another
- View Timeline

---

# 19. SPEECH TO TEXT

## Level 1 — device dictation
Make normal text fields work naturally with iPhone/Android keyboard dictation.

## Level 2 — optional app voice entry

Button:
# TAP TO SPEAK

Flow:
1. Listening...
2. Transcript appears.
3. Investigator reviews.
4. Use Text
5. Discard

Never auto-submit speech directly into the official log.

Example speech:

> Arrived in the vicinity of the subject's residence at 12:34 PM. Two vehicles are in the driveway. Took two photos.

The transcript should still be reviewed before Save.

Do not make unsupported claims that audio is never stored unless technically verified.

---

# 20. OPTIONAL VOICE NAVIGATION

Future/experimental commands may include:
- Add Activity
- Open Timeline
- Open Evidence
- Open Report
- Add Note

Never allow voice alone to:
- End Investigation Day
- Submit Report
- Finalize Case
- Delete Evidence

without explicit confirmation.

Touch navigation remains primary.

---

# 21. PHOTO / VIDEO FROM ACTIVE MODE

## Photo

Tap Photo:
- select/capture through supported phone workflow
- preview
- describe what it documents
- link to current/most recent/specific activity
- default classification Needs Review

Field investigator does not decide final client-package inclusion.

## Video

Tap Video:
- select/upload
- activity link
- timestamp
- description
- evidence metadata

Large video later feeds Dropbox delivery workflow.

---

# 22. ACTIVE TIMELINE

Example:

12:34 PM  
Arrived in vicinity of residence.  
📷 2   🎥 1

1:02 PM  
No change noted.

1:58 PM  
Subject exited residence and entered vehicle.  
📷 1

Persistent:
# + ADD ACTIVITY

---

# 23. ACTIVE MODE — CASE INFO DRAWER

Keep field-relevant info available without opening the full Admin portal:

- Subject
- Subject photo
- Known residence
- Vehicles
- Assignment objective
- Known schedule
- Relevant restrictions/allegations
- Remaining authorized hours
- Investigator instructions

Do not expose:
- client billing
- margin
- invoices
- private Admin notes
- other investigator compensation

---

# 24. END INVESTIGATION DAY

Tap:
# END INVESTIGATION DAY

Review:
- Start Time
- End Time
- Total Hours
- Beginning Mileage
- Ending Mileage
- Total Mileage
- Activity Entries
- Photos
- Videos

Then:
# END DAY & REVIEW

Require confirmation.

Never let one voice command end a day.

---

# 25. ACTIVE MODE → REPORT → ADMIN

Flow:

Active Surveillance
→ Activity Timeline
→ Report Draft
→ Investigator Review
→ Submit Report
→ Submitted PDF/version
→ Admin Reports Awaiting Review
→ Case Build
→ Client Package

No manual sync/import.

---

# 26. PWA / HOME-SCREEN READINESS

Structure Active Surveillance Mode so it can be PWA-ready if current stack supports it.

Possible home-screen label:
- API Surveillance
- Active Surveillance

If launched with no active case:
# MY SURVEILLANCE ASSIGNMENTS

If active:
# RESUME ACTIVE SURVEILLANCE

Do not create a separate App Store app in this phase.

---

# 27. ADMIN LIVE STATUS

While someone is in Active Surveillance Mode, Admin may show:

# OUT NOW

Example:
- Investigator
- Case #
- Started
- Elapsed
- Last Activity

Do not add continuous GPS tracking in this phase.

---

# 28. INVOICES / BILL HANDOFF

Portal should create and track invoices, while BILL may handle actual commercial payment.

Core workflow:

# CASE → CREATE INVOICE → REVIEW → PDF → MOVE TO BILL → TRACK PAYMENT

Do not make case functionality depend on BILL.

## Invoice fields

General:
- Invoice #
- Case #
- Client
- issue date
- due date
- terms
- line items
- total
- paid
- balance
- status

Insurance additional:
- Carrier / TPA
- Adjuster
- Claim #
- Policy # when needed
- Date of Loss
- Authorization #
- PO #
- Vendor #
- Service Dates
- Billing Email
- Special Instructions

Private:
- Client
- Case
- Retainer
- Amount Applied
- Additional Authorization
- Balance

---

## Invoice statuses

- Draft
- Ready
- Sent to BILL
- Sent to Client
- Partially Paid
- Paid
- Overdue
- Void
- Write-Off if needed later

Do not mark Paid just because it was sent to BILL.

---

## BILL handoff — Version 1

1. Create invoice in Portal.
2. Review.
3. Generate PDF.
4. Enter/send in BILL manually.
5. Record BILL reference in Portal.
6. Track payment status manually.

Provider-neutral fields:
- billing_provider
- external_customer_id
- external_invoice_id
- external_payment_id
- external_status
- last_synced_at

Do not hard-code BILL across the entire data model.

---

# 29. PUBLIC WEBSITE / SEO

After the critical Portal + Active Surveillance workflow is stable, audit and update the public website.

## Homepage goal

The top of the public site should clearly communicate:

# SURVEILLANCE & INVESTIGATION SERVICES FOR INSURANCE, LEGAL AND PRIVATE CLIENTS

Insurance should be prominent because the insurance portal is now a major capability.

But do not bury:
- Infidelity / Adultery
- Child Custody
- Domestic
- General Surveillance

## Primary paths

# SUBMIT AN INSURANCE ASSIGNMENT

# REQUEST A PRIVATE INVESTIGATION

Portal login should be secondary.

---

## Homepage suggested order

1. Hero
2. Two Client Paths
3. Core Surveillance Services
4. Insurance Investigations
5. Private Investigations
6. Why Always Precise
7. How an Assignment Works
8. Final CTA

Do not make the homepage bloated.

---

## SEO pages / topic structure

Audit/create strong useful pages where appropriate:
- Surveillance Investigations
- Insurance Investigations
- Infidelity / Adultery Investigations
- Child Custody Investigations
- Private Investigations

Avoid thin duplicate SEO pages.

Audit:
- title
- meta description
- H1/H2
- canonicals
- internal links
- sitemap
- Open Graph
- structured data
- mobile performance

Do not invent:
- nationwide coverage
- offices
- 24/7
- certifications
- response times
unless verified.

---

# 30. REMOVE SOCIAL MEDIA SEARCH SERVICE

The owner wants Social Media Search / Social Media Research removed from the current public offering.

Audit/remove from:
- homepage
- navigation
- footer
- service cards
- service pages
- rate sheets
- public intake selectors
- SEO titles/descriptions
- structured data
- sitemap
- FAQs
- marketing copy
- current service lists

If Background Investigation remains offered, keep that separately.

Do not delete historical cases that used the old service category.

---

# 31. COMPLETED CASES

Admin must have an obvious Completed Cases path.

Each completed case should make artifacts easy to find.

Actions:
- Open Case
- View Final Report
- Download Final Report PDF
- View Evidence
- Download Evidence Index
- Download Client Package
- Copy Video Delivery Link
- View Invoice

Do not bury completed cases in a difficult archive.

---

# 32. CASE PACKAGE PROGRESS

The visual Case Package card should show meaningful applicable states.

Examples:
- Activity ✓
- Report ◐
- Photos ✓
- Video ✓
- Build ○
- Invoice ○

Also:
# NEXT STEP

Examples:
- Start Investigation
- Continue Activity
- Review Report
- Select Evidence
- Build Package
- Create Invoice
- Ready to Close

Every block should be clickable to the correct module.

Do not show irrelevant optional modules.

---

# 33. CLIENT / INVESTIGATOR INFORMATION REDACTION

Admin sees full client/commercial information.

Outside investigator should generally see only operational information needed to conduct the assignment.

Default hidden from standard investigator:
- insurance carrier/client identity if not operationally required
- adjuster contact
- client billing rate
- contract terms
- margin
- invoices
- Admin strategy notes
- other investigator compensation

Optional Admin permission:
**Allow Investigator to View Client Identity**
Default: No.

Do not enforce this only by hiding UI; secure it server-side.

---

# 34. INVESTIGATOR COMPENSATION VS CLIENT RATE

Keep separate.

Admin may see:
- Client Rate
- Investigator Rate
- Client Mileage
- Investigator Mileage

Standard investigator should see only their compensation terms when appropriate.

Never expose client rate/margin by default.

---

# 35. EXPENSES / MILEAGE

Case expenses should support:
- mileage
- tolls
- parking
- hotel
- airfare
- rental vehicle
- records
- database
- equipment
- meals if authorized
- other

Each expense should distinguish:
- Reimbursable to Investigator
- Billable to Client
- Internal Company Expense

These are separate concepts.

---

# 36. COMMUNICATIONS / TASKS

Communication log can include:
- email
- phone
- text
- client update
- investigator communication
- authorization request
- internal communication

Tasks:
- Call adjuster
- Request authorization
- Review report
- Confirm date
- Upload video
- Send invoice
- Follow up

Overdue tasks should surface on Admin dashboard without overcrowding it.

---

# 37. STATUS / WORKFLOW MODEL

Keep statuses useful rather than excessive.

A reasonable case flow:

- New
- Unassigned
- Assigned
- Scheduled
- In Progress
- Report Submitted
- Admin Review
- Finalized
- Awaiting Billing / Payment
- Completed
- Closed
- On Hold
- Cancelled

Do not confuse:
- Report Submitted
with
- Case Completed

---

# 38. FULL END-TO-END INSURANCE TEST

Run the system as a real carrier workflow:

Insurance Rate Sheet
→ include correct Insurance Intake
→ client submits partial intake with unknown fields
→ Admin sees Intake to Review
→ Admin confirms 24 hours / $3,300
→ Create Case
→ Assign Investigator
→ Active Surveillance Mode
→ Start Day
→ Quick Activity
→ Voice Entry
→ Photos
→ Video
→ End Day
→ Report Draft
→ Submit Report
→ Admin Review
→ Case Build
→ Report + Selected Photos
→ Dropbox Video Link
→ Final Package
→ Create Invoice
→ Move to BILL
→ Track Payment
→ Completed Case

Fix any dead ends.

---

# 39. FULL END-TO-END PRIVATE TEST

Private Rate Sheet
→ include correct Private Intake
→ partial info allowed
→ Admin reviews
→ $1,500 retainer workflow
→ Create Case
→ Active Surveillance Mode when appropriate
→ Activity
→ Evidence
→ Report
→ Case Build
→ Retainer/Invoice tracking
→ Completed Case

Keep insurance and private billing logic separate.

---

# 40. REFERENCE IMAGES TO ATTACH WITH THIS HANDOFF

Upload these image files to Claude along with this markdown.

## 01_portal_dashboard_case_packages_reference.png
Desktop dashboard, sidebar, Case Package cards, case overview, evidence gallery, rate-sheet send flow.

## 02_full_portal_mobile_workflow_reference.png
Dashboard + case detail + mobile activity + report + Case Build + leads/intakes.

## 03_streamlined_portal_reference.png
Clean sidebar, dashboard, activity modal, report, evidence gallery and workflow.

## 04_ui_build_step_by_step_reference.png
Numbered step-by-step UI reference for Dashboard, Case Detail, Quick Activity, Report Preview, Case Build, Mobile, Intakes.

## 05_active_surveillance_invoicing_reference.png
Desktop dashboard, invoices, report preview and Active Surveillance mobile workflow including speech-to-text.

## 06_active_surveillance_mobile_large_reference.png
LARGE mobile app reference:
1. Active Surveillance Home
2. Add Activity — Quick
3. Add Activity — Details
4. Activity Timeline
5. Voice Entry
6. Photo Evidence
7. Evidence Gallery
8. Report Preview
9. Case Build
10. End Investigation Day
11. Mobile Navigation
12. PWA Home Screen

This is the most important visual reference for `SURVEILLANCE.md`.

## 07_current_private_rate_sheet.png
Current Private $1,500 Retainer sheet for before/after comparison.

## 08_current_insurance_rate_sheet.png
Current Insurance Assignment Rates sheet for before/after comparison.

## 09_current_portal_example.png
Current portal screenshot available in this package for context.

---

# 41. DESIGN PRINCIPLES FROM THE MOCKUPS

Use the images as guidance, not literal static screens.

Preserve:
- navy sidebar
- white desktop cards
- gold accent
- teal/green completion cues
- clean spacing
- compact information hierarchy
- large mobile tap targets
- dark Active Surveillance field interface
- obvious Next Step
- contextual Back
- visual evidence
- progress rings/bars where useful
- mobile bottom nav

Do not blindly copy:
- fake client data
- fake dates
- mockup typos
- decorative buttons with no destination

All shown buttons in the actual implementation must work.

---

# 42. MASTER REMAINING BUILD ORDER

Update `NEXT.md` so this queue cannot be lost.

## NOW
1. `INTAKE-NA.md`
   - public Insurance form
   - public Private form
   - server validation
   - Admin missing-info view

## NEXT MAJOR WORKSTREAM
2. `SURVEILLANCE.md`
   - launch/resume
   - investigation timer
   - quick activity
   - favorites/templates
   - voice entry
   - photo/video
   - activity timeline
   - mobile report
   - end-day review
   - PWA readiness
   - Admin Out Now

## AFTER SURVEILLANCE
3. Dropbox video delivery
4. Case Build gap audit
5. Invoice/BILL gap audit
6. Public website / SEO / remove Social Media Search
7. Full Insurance workflow audit
8. Full Private workflow audit
9. Final responsive/accessibility/security pass

---

# 43. FINAL INSTRUCTION TO CLAUDE CODE

Do not finish one small queued file and forget the rest of this master handoff.

After each PR:

1. Re-read `NEXT.md`.
2. Mark completed items.
3. Keep the remaining queue intact.
4. Preserve the reference filenames.
5. Continue from the current green master.

The owner’s intended finished system is:

# PUBLIC WEBSITE
gets the client in.

# RATE SHEET + CORRECT INTAKE
starts onboarding.

# ADMIN PORTAL
reviews and runs the business.

# ACTIVE SURVEILLANCE MODE
lets the investigator document the field work quickly from a phone.

# REPORT
builds automatically from the activity timeline.

# CASE BUILD
assembles the professional client deliverable.

# DROPBOX
optionally carries large video delivery copies.

# INVOICES / BILL
handles commercial billing/payment handoff.

# COMPLETED CASES
keeps the final report, evidence package and billing history easy to retrieve.

All of it should behave as one connected Always Precise Investigations system.
