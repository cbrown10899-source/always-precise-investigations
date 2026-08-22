# CASE WORKSPACE — the owner's brief, verbatim

**Recorded 2026-08-22 so it survives the session that received it.** This is
the owner's own message, unedited, from the bundle of three that also carried
the optional-field rule (shipped as Unit 36) and the Round 2 audit
(`PRODUCTION-TRUTH-2.md`).

## Numbering

**The owner's message calls this "UNIT 34". That number is already taken** by
the shipped public-site unit — public Legal page, no public pricing, three
service claims removed — PR #225 at `405462f`, recorded in `FINAL-LEDGER.md`
PART 6B and in the OWNER DECISIONS block of `NEXT.md`. Reusing it would make
the ledger ambiguous about which "Unit 34" a later reader is looking at, and
the ledger is the artifact this project has repeatedly paid to keep accurate.

**So it is queued as UNIT 38** and the owner's own label is preserved here.
Nothing was renumbered: 34 keeps its meaning, and this unit gets the next
free number. The ACTIVITY ORDERING addendum stays inside it, as instructed —
it is not a separate unit.

## Scope recorded as durable required work, by the owner's instruction of
## 2026-08-22

- Case Workspace Simplification
- Activity oldest-to-newest ordering
- Simplified Activity / Daily Summary access

---

## THE BRIEF, VERBATIM

```
UNIT 34 — CASE WORKSPACE SIMPLIFICATION

OWNER UX DECISION:

The portal has become too busy when doing actual case work.

Activity, Daily Summary, Evidence and Report must be much easier to reach.

The goal is NOT to remove functionality.
The goal is to simplify the path once someone opens a case.

AUDIT CURRENT CASE NAVIGATION FIRST.

Do not redesign backend workflows.
Reuse the existing Activity, Daily Summary, Evidence, Report, Active Surveillance and case data.

==================================================
CORE UX RULE
==================================================

Once a user opens a case, case work should happen INSIDE THAT CASE.

Do not make the user return to the main portal navigation to find:
- Activity
- Daily Summary
- Evidence
- Report

These should be obvious and immediately reachable.

==================================================
DESKTOP CASE WORKSPACE
==================================================

Create a clean persistent Case Workspace.

Case header should clearly show:

CASE NUMBER
Client / Subject or useful case label
Case type
Current status
Assigned investigator
Current investigation day where applicable

Example:

PHILLIPS — SURVEILLANCE
API-2026-0815-2012
Active • Day 3 • Assigned to Corey Brown

Directly below, use a simple workspace navigation:

Overview
Activity
Daily Summary
Evidence
Report
Billing

Do not make these look like another giant sidebar.

Use compact tabs or an equivalent clean horizontal workspace control.

==================================================
PRIMARY CASE ACTIONS
==================================================

For an active surveillance case, make these especially obvious:

+ Add Activity
Daily Summary
End Day

If surveillance is active, also show:

Resume Surveillance

The most common field actions should never be buried behind More menus.

==================================================
OVERVIEW
==================================================

Simplify the case Overview.

Prefer:

NEXT STEP
[ obvious current action ]

TODAY
- current day
- current surveillance status
- number of activity entries
- photos/videos added
- Daily Summary status

RECENT ACTIVITY
small chronological list

CASE STATUS
compact progress indicator

Avoid a wall of cards.

Do not duplicate every piece of case information on this page.

==================================================
ACTIVITY TAB
==================================================

Activity should open directly to the selected/current case.

Do not ask the user to select the case again.

Default to TODAY.

Show:
- chronological activity
- time
- activity type
- concise description
- edit/delete controls where already authorized
- + Add Activity prominently

Keep existing activity history and audit behavior.

==================================================
DAILY SUMMARY TAB
==================================================

Daily Summary must be one tap/click from the case.

Default automatically to the CURRENT investigation day.

Do not require the user to choose the case again.

Show current state clearly:

Daily Summary
Day 3 — Friday, Aug 21, 2026

Status:
Not Started / Draft / Complete

If activity exists:
show the count and allow the existing summary builder to use it.

Keep the current paragraph builder functionality.

Improve spacing and reduce visual noise.

Important fields such as:
Opening
Started
Location
Vehicles Observed
Day Moments
Quiet Period
Concluded
Reason
Generated Paragraph

should remain available but grouped cleanly.

Use progressive disclosure where useful.

Do not display every possible optional control at maximum prominence simultaneously.

==================================================
EVIDENCE TAB
==================================================

Evidence should open directly to this case.

Show:
- photos
- videos
- documents
- integrity status
- upload/add evidence action

Keep Timestamp Photo / Timestamp Video available where appropriate.

Do not duplicate File Queue.

File Queue remains the cross-case operational view.
Evidence is the selected-case view.

==================================================
REPORT TAB
==================================================

Report should open directly to this case.

Show a simple progression such as:

Daily Summaries
→ Report Draft
→ Preview
→ Finalize
→ Package

Reuse the existing working report/package system.

Make Preview and Save PDF easy to find.

Do not mix billing controls into the Report area.

==================================================
BILLING TAB
==================================================

Billing stays available to Admin/authorized roles.

Do not expose unnecessary financial data to investigators.

Preserve the reassigned-investigator privacy rule.

==================================================
MOBILE — FIELD-FIRST CASE VIEW
==================================================

On phone widths, simplify more aggressively.

When an investigator opens an active case, prioritize:

CASE NAME
Day # • Active

NEXT STEP

[ + ADD ACTIVITY ]

TODAY'S ACTIVITY

[ DAILY SUMMARY ]

[ EVIDENCE ]

[ END DAY ]

Use a compact mobile case navigation such as:

Activity
Summary
+ Add
Evidence
More

Do not force the desktop six-tab layout onto a narrow phone.

"More" may contain less frequent items such as:
Overview
Report
Case Details
other role-appropriate tools

But Activity and Summary must NEVER be hidden under More.

==================================================
ROLE SIMPLIFICATION
==================================================

Investigators should see primarily what they need to work the case.

Do not clutter an investigator's case workspace with:
- Rate Sheets
- broad Billing administration
- retention administration
- firm management
- system settings

Admin keeps access through the main portal.

Do not create a second separate application.
Use role-aware presentation inside the existing portal.

==================================================
DUPLICATE ENTRY POINT CLEANUP
==================================================

Audit how many different links/buttons currently reach:
- Activity
- Daily Summary
- Evidence
- Report

Keep:
1 obvious primary entry point
plus
1 useful contextual shortcut where appropriate.

Remove confusing duplicate navigation only when it is safe and does not break bookmarked/deep-linked routes.

Existing valid URLs should continue working where practical.

==================================================
CURRENT DAY INTELLIGENCE
==================================================

When opening Activity or Daily Summary from a case:

Prefer the actual current/open investigation day.

If no day is open:
show the latest relevant day with a clear label.

Never silently show the wrong day.

Respect the corrected case day-number logic from Unit 25.

==================================================
VISUAL DIRECTION
==================================================

Use the approved portal design system:

- navy structure
- white work area
- restrained gold
- teal completion cues
- compact professional layout
- strong information hierarchy
- generous spacing
- no overlapping labels
- no excessive boxes/cards
- large phone tap targets

The interface should feel quieter.

Use whitespace and hierarchy instead of adding more borders.

==================================================
DO NOT REMOVE FUNCTIONALITY
==================================================

Preserve:
- Active Surveillance
- voice entry
- activity editing
- Daily Summary builder
- evidence integrity
- report generation
- package creation
- File Queue
- billing
- case closeout
- retention
- audit history

This is a navigation/presentation simplification, not a workflow rewrite.

==================================================
TESTS
==================================================

Add page-level and navigation tests proving:

1. Opening a case exposes Activity directly.
2. Daily Summary is directly reachable from the case.
3. Activity defaults to the correct case.
4. Daily Summary defaults to the correct case.
5. Current/open day is selected correctly.
6. + Add Activity works.
7. Evidence opens the selected case.
8. Report opens the selected case.
9. Admin Billing remains reachable.
10. Investigator financial restrictions remain intact.
11. Desktop workspace tabs work.
12. Mobile field layout works at 375/390/430px.
13. No horizontal overflow.
14. Activity and Summary are not hidden under More on mobile.
15. Existing deep links/routes do not break.
16. Active Surveillance remains functional.
17. Daily Summary builder remains functional.
18. Report/Package workflow remains functional.
19. File Queue remains a separate cross-case tool.
20. Accessibility/focus order remains sound.

Run full relevant suites.

==================================================
SHIP
==================================================

If green:

CODED
→ TESTED
→ PUSHED
→ MERGED
→ DEPLOYED

Leave visual LIVE VERIFIED open for owner review.

After deployment report:

UNIT 34 — CASE WORKSPACE SIMPLIFICATION

- old navigation path
- new navigation path
- desktop behavior
- mobile behavior
- investigator simplification
- Admin behavior
- tests
- PR
- merge SHA
- deployment
- LIVE VERIFIED — OPEN

STOP after Unit 34.

Do not start another feature until owner reviews the simplified case workspace.
Next after all above are done :

ADD TO UNIT 34 — ACTIVITY ORDERING

Owner UX rule:
Within a case/day, Activity must display in chronological order, oldest first and newest last.

Audit current ordering first.

Apply consistently to:
- Case Workspace Activity tab
- Active Surveillance activity timeline
- Daily Summary activity/day-moments source
- Report chronology
- any selected-day activity list

Rules:
- earliest event at top
- latest event at bottom
- new activity appends to bottom
- preserve exact timestamps
- tie-break same-time entries deterministically using existing stable ID/created order
- do not change stored event timestamps
- do not reorder historical evidence incorrectly
- removed/restored entries must return to their proper chronological position
- reports and Daily Summary must agree with Activity ordering

A separate dashboard “Recent Activity” widget may remain newest-first because that is a recent-events view, but case/day workspaces must be chronological.

Add regression tests proving:
1. out-of-order-created events render by activity timestamp
2. same-time events remain deterministic
3. restored activity returns to correct position
4. Activity, Daily Summary and Report chronology agree
5. adding a new later event appears at the bottom

Include this in Unit 34 implementation and do not create a separate unit.
```
