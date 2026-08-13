# Simplify Case UX + Visual Case Package Cards — Handoff (INTERNAL)

**Recorded in substance from the owner's handoff on 2026-08-13.** Lives in
`case-portal/` because this directory never deploys. Do not prune — mark the
ledger instead.

Owner's core note: *stop making every feature look equally important.* The
portal should say, very clearly: "Here is this case. Here's what is done.
Here's what you need to do next." The case screen must feel like a
field-investigator workflow, not a software admin panel. Three frictions:
too many tabs, too much form to add one activity entry, and completion
spread everywhere with no "this package is 70% done" summary.

Progress ledger (handoff phases):

| Phase | Status |
| --- | --- |
| 1. Visual navigation (Case Package card component; cards below the case table; Next Step logic; clickable completion blocks; in-case mini-dashboard) | not started |
| 2. Simplify field entry (compact Quick Log; More Details fold; searchable/favorite common actions; structured templates; one-tap No Change; Subject Documented chips; sticky mobile add) | not started |
| 3. Clean report/evidence flow (report status on Activity; View Report Draft; media in timeline; Evidence Gallery; counts; Case Build progress) | not started |
| 4. Completed package (collage view; What's Missing panel; final package view; downloads; Dropbox link where applicable; invoice status) | not started |
| 5. Cleanup (reduce top-level tabs; remove duplicate navigation; hide irrelevant modules; move test controls out of production view; desktop + mobile test) | not started |

---

**Visual reference (owner mock, 2026-08-13):** the owner sent a rendered
mock of the target: dark-navy LEFT SIDEBAR navigation (Dashboard · Cases ·
Calendar · Rate Sheets · Invoices · Leads & Intakes · Clients · Reports ·
Evidence · Expenses · Tasks · Staff · Settings, plus an "Intake a Client"
button), Case Package cards with a PROGRESS RING ("71% Complete") over the
block row, a Next Step button per card, case detail collapsed to
Overview / Fieldwork / Report & Evidence / Admin with a Case Package
Progress panel, an Add Activity sheet (searchable "What happened?" +
favorites chips + time + details + flags + "Add more details" fold), rate
sheets as two product cards with a 3-step SEND WIZARD including an
"Include Insurance Assignment Intake Form" attachment option, and an
Evidence Gallery of thumbnails with Photos/Video/Documents/All tabs.
Build toward that picture with the existing design tokens.

The handoff, in substance (25 priorities):

**P1 — Case Package cards below the case list.** The table stays for
search/filter; cards are the operational shortcut. Each card is a compact
infographic: case #, client, subject, type, status, then blocks —
Activity (count) · Report (state) · Photos · Video · Expenses · Case Build
· Invoice — each with a simple state mark: ✓ complete, ◐ in progress,
○ not started, ! needs attention. Labels/icons as well as color, never
color alone. Not text-heavy.

**P2 — one primary NEXT STEP per case**, computed: Start investigation ·
Continue activity log · End investigation day · Review report · Add
evidence · Build case package · Create invoice · Ready to close. The
primary button goes straight there — no choosing tabs.

**P3 — collapse case navigation.** Ten equal tabs become grouped
navigation. Recommended top level: CASE · FIELDWORK · REPORT & EVIDENCE ·
ADMIN (secondary items inside each). Investigators see even less —
TODAY · ACTIVITY · EVIDENCE · REPORT. Final recommended: admin case =
OVERVIEW / FIELDWORK / CASE PACKAGE / ADMIN; investigator case =
ASSIGNMENT / ACTIVITY / EVIDENCE / REPORT.

**P4 — Quick Log.** Activity entry shows only: time (auto), action
(large searchable dropdown), details (one textarea), quick flags (subject
documented / photo / video), ADD TO LOG. Location, vehicle, internal
note, linked evidence fold under "More details".

**P5 — searchable quick actions.** "What happened?" search over the stock
lines (type `arriv` → arrival lines; `no act` → no-activity lines);
favorites first. Groups: ARRIVAL · NO ACTIVITY · SUBJECT MOVEMENT ·
VEHICLE · LOCATION · SURVEILLANCE POSITION · LOST VISUAL · END DAY ·
CUSTOM. Selecting one reveals only relevant fields.

**P6 — structured activity wizard.** Common actions generate editable
narrative from a few taps (e.g. ARRIVED AT RESIDENCE: time, vehicles
present, position → generated sentence). NO CHANGE is near-one-tap
("Since last entry" / "This hour" → "No change was noted during this
period."). SUBJECT DOCUMENTED offers action chips (walking, driving,
bending, carrying, lifting, entering/exiting vehicle, shopping, yard
work, entering/exiting building, other; multi-select) → narrative.

**P7 — activity feed, not a form page.** Entries render as a clean
vertical timeline (time, line, 📷/🎥 counts, Edit); the input stays
compact and sticky (top or bottom on mobile).

**P8 — sticky mobile + ADD ACTIVITY** with PHOTO / VIDEO / NOTE
shortcuts; opens a compact sheet.

**P9 — Case Package mini-dashboard inside each case**: Activity · Report
· Photos · Video · Case Build · Invoice blocks with states, each
clickable.

**P10 — report destination obvious from Activity**: "Your activity
entries automatically build the daily report" + VIEW REPORT DRAFT /
REVIEW REPORT.

**P11 — evidence destination obvious**: photo/video counts + VIEW
EVIDENCE from Activity; linked media shown inline in the timeline; icons
open the evidence.

**P12 — Evidence Gallery.** Filters ALL / PHOTOS / VIDEO / DOCUMENTS /
CLIENT / INTERNAL; photos as thumbnail cards (time, description, linked
activity, status, View/Include/Classify); video cards show thumbnail,
duration, time, description, storage status.

**P13 — Case Package collage** (in Case Build and on the card): report
icon + state + pages, photo thumbnails + count, video thumbs + count,
evidence index state, package state, BUILD PACKAGE. Clean UI cards, not
a literal image.

**P14 — completion blocks navigate directly** (report → report review;
photos → filtered gallery; video → video evidence; case build → build;
invoice → invoice). No intermediate screens.

**P15 — completion progress**: "5 OF 7 COMPLETE" over meaningful
components only (field work, report, photos/evidence, video if
applicable, admin review, case build, billing). No fake progress; no
video penalty when none is expected.

**P16 — What's Missing panel**: only missing items, each a button
straight to the task.

**P17 — completed package view**: final report (download), photos (view),
videos (Dropbox link where applicable), evidence index (download),
invoice (view), client package (download) — reachable from the card.

**P18 — cards serve both sides**: insurance card shows authorization
(e.g. 24 hrs / $3,300); private card shows retainer + balance. The
package workflow beneath is the same.

**P19 — hide non-applicable modules**: no "VIDEO — 0" when none is
expected, no EXPENSES block with nothing to review, no authorization-low
on private cases.

**P20 — reduce scrolling**: collapsible sections, drawers, modals,
sticky action bars, cards, responsive grids.

**P21 — desktop and mobile presented differently**: desktop wide
cards/horizontal progress/thumb grids; mobile stacked cards, sticky add,
large targets, minimal fields. Never just shrink the desktop form.

**P22 — main cases page layout**: summary cards on top, case table,
then CASE PACKAGES; TABLE VIEW / PACKAGE VIEW toggle, remembered per
user if practical.

**P23 — move test/developer clutter out of production**: "Show an
example", "Add a test case", "Remove test cases" leave the Cases page
for a Settings → Developer/Testing area, visible only to authorized
admins.

**P24 — reduce duplicate functions**: consolidate where the same act
lives twice (Field Work may become simply TODAY; one way to start/end a
day unless a second is an intentional shortcut to the same function).

**P25 — the Case Package becomes the centerpiece**: a case reads as a
package (assignment, activity, report, photos, video, evidence, final
package, billing), with the card showing how complete each component is.

FINAL EXPERIENCE: Admin sees CASES then CASE PACKAGES; each card shows
the states and one NEXT STEP that jumps straight to the task. An
investigator opens a case to TODAY'S ASSIGNMENT + ADD ACTIVITY + a simple
timeline — documenting the investigation as it happens, while the system
organizes report, evidence, package and closure behind the scenes.
