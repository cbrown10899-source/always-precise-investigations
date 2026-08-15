# PORTAL OPERATIONS + POLISH — approved plan (INTERNAL)

**Owner approval received 2026-08-15.** Recorded here before building, per the
standing rule that handoffs are written down in `case-portal/` first.

> **⚠️ THIS TRANSCRIPT IS INCOMPLETE.** The messages carrying this plan arrived
> progressively truncated and the final stretch was corrupted outright. Lines
> below marked **[TRUNCATED]** are recorded exactly as received; lines marked
> **[inferred]** are a reading, not the owner's words. **Nothing marked either
> way should be built without confirming it.** The corrupted portions are
> listed at the end and need re-sending.

## The goal, in the owner's words

Not a CRM. Not clutter. The goal is:

- LESS SEARCHING
- FEWER CLICKS
- ONE OBVIOUS NEXT ACTION
- PROFESSIONAL DESKTOP + MOBILE UX

Implement as **phased work, preserving everything already shipped.** Do not
rebuild working features.

---

## PHASE 1 — NAVIGATION / CORE OPERATIONS

1. Rename user-facing "Leads & Intakes" → **"Intakes"**
2. Reorganise the sidebar into three groups:

   **OPERATIONS** — Dashboard · Cases · Intakes · Calendar · Tasks & Follow-ups
   **DELIVERY & BILLING** — Reports & Packages · Rate Sheets · Billing
   **TEAM & SYSTEM** — Clients & Contacts · Staff · Settings

3. Keep **Active Surveillance visually separated and prominent.**
4. Rename user-facing **Invoices → Billing** *without breaking existing routes
   or data.*

**Already true, do not rebuild:** the Active Surveillance nav item exists and is
visually separate (`.side-surv`), and the sidebar already carries Dashboard,
Cases, Calendar, Rate sheets, Staff, Settings.

## PHASE 2 — DASHBOARD

Clearer structure, three bands:

- **NEEDS ATTENTION** — New Intakes · Needs Assignment [inferred, "ignment"] ·
  Reports Due · Retainers / Authorization Pending [inferred]
- **CURRENT WORK** — Active Today · Ready to Build · Ready [TRUNCATED] ·
  Billing [inferred, "ing"]
- **ACTIONS** [TRUNCATED — a queue, "one button per row"]

Also add compact: Completed [inferred] · Today [inferred].

**Not a wall of 12–15 equal statistic cards.**

**Already true:** `summaryCards()` draws Open / Needs assignment / Out now /
Reports due / Authorization low, each clickable and role-scoped, and
deliberately omits cards whose data does not exist. That is the starting point,
not a blank slate.

## PHASE 3 — REPORTS & PACKAGES

An operational view over **existing data**. Statuses:

- Needs Report
- Needs Evidence Review
- Ready to Build [inferred, "ild"]
- Ready to Finalize
- Completed Packages

Each case shows compact progress — `Report ✓ · Photos ✓ · Video ✓ · Package ○ ·
Invoice ○` — and a **NEXT STEP**.

## PHASE 4 — TASKS & FOLLOW-UPS

Views: **TODAY · UPCOMING · OVERDUE · COMPLETED**

Auto-surface: intake awaiting review · needs assignment · report due ·
authorization low · retainer pending · evidence review · [TRUNCATED] ·
overdue · awaiting client · ready to close.

Manual follow-ups too. Every row carries **one direct next action.**

**Already true:** `case_tasks` and `tasksPanel` exist as a case tab.

## PHASE 5 — GLOBAL SEARCH

Fast search across: case # · subject · client · carrier · claim # · adjuster ·
invoice # · contact. Grouped results: **CASES · INTAKES · CONTACTS · BILLING**.

**Must remain server-side.** Do not [TRUNCATED — "…k records merely because
they match a search"]; read as: **do not unlock records merely because they
match a search.** Role scoping still applies to every result.

## PHASE 6 — QUICK ACTIONS

A compact **+ NEW / QUICK ACTIONS** control. Admin shortcuts: New Client ·
New Case [inferred] · Send Rate Sheet · Send Payment Options · New Intake
[inferred] · Create Invoice · Start Active Surveillance.

Without duplicating giant buttons on every page.

## PHASE 7 — CLIENTS & CONTACTS

A **lightweight directory, not a full CRM.** Private clients · carriers · TPAs ·
adjusters · defense counsel · attorneys · billing contacts. Linked to their
cases and history, **respecting role boundaries.**

## PHASE 8 — RECENTLY VIEWED + FAVORITES

Recently viewed, and allow pinning/favouriting frequently used cases. **Store
only safe identifiers client-side**; load real records through authorized
server routes.

## PHASE 9 — SAVED VIEWS [inferred heading]

My Open Cases · Private Retainers Pending · Insurance Reports Due · Ready to
Build · Outstanding [billing, inferred] · Awaiting Client · [Active]
Surveillance. **Do not over-engineer this.**

## PHASE 10 — NOTIFICATIONS

An attention icon for **meaningful operational items only**: new intake ·
report overdue · authorization low · retainer pending [inferred] · package
ready · invoice overdue · report submitted.

Allow **Open** and **Mark read**. *Do not turn every activity-log event into a
notification.*

## PHASE 11 — CASE HEALTH + STANDARD NEXT STEP

Standard lifecycle: **INTAKE → ASSIGNMENT → FIELDWORK → REPORT → EVIDENCE →
PACKAGE → BILLING → COMPLETE**

Health state per case: **ON TRACK · WAITING · ACTION NEEDED**, with a
recommended NEXT STEP — Assign Investigator · Start Investigation · [Add]
Activity · Review Report · Review Evidence · Build Package · Create Invoice ·
Record Payment · Close Case.

## PHASE 12 — CASE TEMPLATES

Where they genuinely save setup time: Workers Compensation Surveillance ·
Liability Surveillance · Private Surveillance · Child Custody · Infidelity /
Domestic.

**Templates may preselect workflow/tasks/fields but must not fabricate case
facts.**

## PHASE 13 — DOCUMENT / LANGUAGE TEMPLATES

Reusable templates for authorization requests · additional-time requests ·
standard case communication · report language snippets · invoice notes.

**Do not auto-submit official reports or communications without review.**

## PHASE 14 — AUDIT TRAIL

A clean **Admin** audit view for meaningful changes: assignments · status ·
authorization · retainer/payment · invoices · report version · evidence
classification · package finalization · case closure. **Who + what + when.**

**Investigators must not see admin-only audit information.**

## PHASE 15 — MOBILE / PWA POLISH

Portal installable as a PWA, especially the investigator / Active Surveillance
side. Same backend and data — **no separate mobile database or parallel app
state.** Navigation stays focused.

**Already true:** `portal/manifest.webmanifest` and the `?surveillance=1` start
URL ship today.

---

# ACTIVITY / INPUT EDIT + DELETE CONTROLS — owner requirement

Every ordinary user-created activity/input record must have an obvious way to
**EDIT** and **DELETE / REMOVE**, consistently on desktop and mobile wherever
the record is editable: activity timeline entries · voice-created activity ·
free-form notes · arrival / no-change / mobile-check entries · subject, vehicle
and location observations · mileage · expenses · manual follow-ups and tasks ·
draft report text where editing is permitted.

**1. Timeline.** A compact `•••` menu per entry offering EDIT / DELETE; on
mobile, tap the activity → EDIT / DELETE. **Not** large permanent buttons on
every row. Mobile should use a bottom sheet or simple action menu.

**2. Edit activity.** Reopens the existing activity form populated with current
values — time, activity type, details, subject, vehicle, location, note. After
save: update the timeline, update derived report text where appropriate, keep
an audit record of what changed, and show a subtle **ACTIVITY UPDATED**
confirmation. **Do not silently change immutable submitted report snapshots.**

**3. Delete.** Must **not** normally destroy the database record — use the
existing soft-delete architecture (`activity_removed` or equivalent). A removed
entry disappears from the working timeline, is excluded from future reports and
client packages, remains available to authorized admin audit/history, and
records **who removed it and when**.

**4. Confirmation.** Confirm destructive-looking actions, quoting the entry:
*"REMOVE ACTIVITY? … will be removed from the timeline and future reports.
[Cancel] [Remove Activity]"*. **Do not require cumbersome confirmation for
ordinary editing.**

**5. Undo.** Where practical, a short **REMOVED [UNDO]** affordance that
restores the original rather than creating a duplicate.

**6. Voice entries** get the same EDIT / DELETE controls. Spoken entries are
**not privileged or immutable merely because they came from speech
recognition.**

**7. Last activity, in Surveillance Mode.** Show the last entry with EDIT and
UNDO / REMOVE **without leaving the main surveillance screen.** Controls large
enough for field use.

**8. Other inputs.** Same convention for tasks, expenses, mileage, notes and
follow-ups — one consistent menu pattern across the portal.

**9. Exceptions — "every input can be deleted" is NOT permission to destroy
audit-critical records:**

- **Original evidence** — never destroy the sole original file through ordinary
  UI; removal from a package is separate from destroying evidence.
- **Report versions** — preserve the exact submitted snapshot; corrections
  create another version via an admin path; never mutate a historical version.
- **Payments** — accounting integrity; use the reversal/void workflow with an
  audit trail.
- **Finalized packages** — never silently mutate; use controlled rebuild /
  version behaviour.
- **Audit history** — ordinary users may not delete audit records.

**10. Permissions — [CORRUPTED, needs re-sending].** Only the word
"Investigators" arrived intact before the transmission degraded.

**Already true, do not rebuild:** entry edit and remove with `activity_removed`
shipped in #55 — a removed entry still returns from the workspace stamped with
who removed it and when, the page strikes it through and offers to put it back,
and the report and package skip it. Evidence has always worked this way. Much
of §3 and §5 may already be satisfied; **audit before building.**

---

## WHAT WAS CORRUPTED AND NEEDS RE-SENDING

1. **Phase 2** — the ACTIONS band, and the two "also add compact" items.
2. **Phase 4** — one auto-surfaced task type between "evidence review" and
   "overdue".
3. **Phase 5** — the sentence beginning "…k records merely because they match a
   search."
4. **Phase 9** — the heading itself, and the Billing item.
5. **§10 PERMISSIONS** of the edit/delete requirement — everything after the
   word "Investigators".
6. Everything after §10: several messages arrived as scrambled characters.
