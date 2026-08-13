# Streamlined Portal UI From Mockups — Implementation Handoff (INTERNAL)

**Recorded in substance from the owner's handoff on 2026-08-13.** This is the
implementing spec for UXSIMPLIFY.md — same direction, now with the owner's
three detailed mockups as the visual reference. Not a rebuild: simplify the
experience, reduce clutter, make the next action obvious, make every button
functional, make back navigation consistent, make mobile field work fast.

Progress ledger (handoff phases):

| Phase | Status |
| --- | --- |
| 1. Navigation + dashboard (sidebar; mobile drawer; simplified metrics; Case Package cards; Continue Case routing) | **done** — 2026-08-13 (left rail + burger drawer; admin lands on Dashboard; Outstanding card; per-case package cards with ring, module states and one computed next step via `pkgProgress`/`pkgNextStep` (P24); Continue Case routes to the computed step; Worker `GET /packages` admin-only. The landing bug — `render()` never fetched `/packages`, so the first sign-in showed "Loading…" forever — fixed by loading on the dashboard landing, not only on the tab click) |
| 2. Case detail (Back to Cases; four-section tabs; new Overview; package progress; Next Step card; recent activity; evidence overview) | **done** — 2026-08-13 (P5 header: type badge + case # + client · claim + subject on the left, stage chip / Assigned / Edit case on the right — status stays a single control on Assignment, the header routes there; investigator header is subject-only. P6: four sections as a bar above the sub-tabs — admin Overview · Fieldwork · Report & Evidence · Admin, investigator Assignment · Activity · Evidence · Report — WS_TAB stays the only routing state, the section is derived. P7 admin overview: Case summary / progress ring + clickable module lines / one Next Step with GO, then Recent activity + Evidence overview (counts; thumbnails wait for Phase 4). The old overview's invoice buttons + closure checklist moved to Admin → Billing & closing; the full intake sits behind Overview → Intake details. Worker: workspace carries build_status/invoice_status for admins only. Back label reads "← Back to Cases".) |
| 3. Field activity (Add Activity modal; Quick/Custom; searchable actions; favorites; structured templates; More Details fold; clean timeline; sticky mobile add) | not started |
| 4. Report + evidence (report preview screen; submission workflow; evidence gallery; filters; activity links) | not started |
| 5. Case Build (summary steps; contents; Dropbox delivery status/link; preview; finalize; completed view) | not started |
| 6. Leads/intakes/rate sheets (sidebar section; intake cards; manual intake; distinct workflows; send wizard; intake pairing) | not started |
| 7. Mobile (case home; bottom nav; activity/evidence/report/back flows) | not started |
| 8. Cleanup (remove duplicate legacy UI; move test controls; wire every button; routes; roles; desktop+mobile test) | not started |

---

The handoff, in substance (25 priorities):

**P1 — left sidebar.** Desktop: brand, then Dashboard · Cases · Calendar ·
Rate Sheets · Invoices · Leads & Intakes · Clients · Reports · Evidence ·
Expenses · Tasks · Staff · Settings; prominent **+ INTAKE A CLIENT** at the
bottom. Visible at desktop widths, active item highlighted, simple icons,
navy brand, modest width, no horizontal scroll. Mobile: ☰ opens a drawer
with the same sections; the desktop sidebar never stays fixed on small
screens. (Nav items only ship when they have a real destination — no
decorative entries, per P22.)

**P2 — dashboard.** "Dashboard / Welcome back, [First Name]." Summary
cards: Open Cases · Needs Assignment · Reports Due · Ready to Close ·
**Outstanding** ($ unpaid invoices → clicking opens invoices filtered
outstanding). Never 10+ metrics up top; lesser metrics live lower or in
detail views.

**P3 — Case Package cards on the dashboard.** "CASE PACKAGES — At-a-glance
progress for active cases." Per active case: type badge, client, subject,
case #, authorization (insurance: hours/$ + used) or retainer/balance
(private), **progress ring %**, then module states — Activity (count) ·
Report · Photos · Video · Build · Invoice with ✓ ◐ ○ — then NEXT STEP and
a primary **CONTINUE CASE →**. Completion counts only applicable modules
(no video penalty when none is expected).

**P4 — Continue Case routing.** No day yet → Start Investigation; day
running → Activity Log; work done + draft → Review Report; approved + no
build → Case Build; built + no invoice → Create Invoice; all done →
Completed summary. One of the most important improvements; never make the
user pick a tab.

**P5 — case detail header.** "← BACK TO CASES" upper-left, case # + type
badge, client · claim, subject; upper-right status dropdown, Assigned To,
EDIT CASE, MORE ACTIONS. **Back-button rule:** every deep page has a clear
back path ("← Back to Cases / Case / Evidence / Invoices / Intakes"),
upper-left, never dependent on the browser.

**P6 — four-section case navigation.** OVERVIEW (summary, subject,
authorization/retainer, investigator, start, priority, status, recent
activity, package progress, next step) · FIELDWORK (start/end day,
activity log, mileage, locations, vehicles — not separate top-level tabs)
· REPORT & EVIDENCE (report, photos, videos, documents, classification,
Case Build) · ADMIN (expenses, notes, communications, tasks, billing,
authorization management). Investigator: ASSIGNMENT · ACTIVITY · EVIDENCE
· REPORT, nothing administrative.

**P7 — case overview screen.** Three columns on desktop: CASE SUMMARY
(authorization, used, remaining, requested start, investigator, priority)
· CASE PACKAGE PROGRESS (ring + clickable module lines) · NEXT STEP card
("REVIEW REPORT — Your activity is building the investigative report —
GO TO REPORT"). Below: RECENT ACTIVITY (4–6 entries + VIEW FULL TIMELINE)
and EVIDENCE OVERVIEW (thumbnails + counts + VIEW ALL EVIDENCE).

**P8 — quick activity entry.** "+ ADD ACTIVITY" opens a modal/side panel
(desktop) or bottom sheet (mobile). Tabs QUICK / CUSTOM. "What happened?"
search + categories: ⭐ Favorites · Arrival · No Activity · Subject ·
Vehicle · Location · More — with the stock lines grouped under each.
Favorites are starrable and appear first (per account if practical).

**P9 — quick entry form.** After picking an action: time (auto), editable
details, quick flags (subject documented / photo / video), "More details"
fold (location, vehicle, internal note, linked evidence), ADD TO LOG.
Selecting an action populates editable narrative ("The Investigator
arrived in the vicinity of the subject's residence on file."). Arrival
template optionally asks vehicles present + surveillance position and
generates the sentence. NO CHANGE is one tap → "No change was noted
during this period."

**P10 — timeline first.** Fieldwork emphasizes the timeline (time, line,
📷/🎥 counts, unobtrusive Edit), not the form. Mobile keeps a persistent
bottom + ADD ACTIVITY.

**P11 — report preview screen.** Panel nav: Draft Preview · Chronology ·
Summary · Attachments · Versions. Branded document (INVESTIGATIVE REPORT,
case #, date, chronology). Bottom: EDIT REPORT · DOWNLOAD DRAFT · SUBMIT
REPORT. Submitting preserves the submitted version, timestamps it,
generates the submitted document, sets Report Submitted, joins the admin
review queue — a submitted report is never overwritten later.

**P12 — evidence gallery.** Tabs Photos / Video / Documents / All +
UPLOAD. Photo cards: thumbnail, time, caption, linked activity, status.
Video cards: thumbnail, duration, time, caption, storage status
(Dropbox/Portal). Document cards: icon, filename, description,
classification. Classifications stay (Client Eligible · Internal Only ·
Needs Review · Needs Redaction · Do Not Use) as compact badges, never
dominating dropdowns.

**P13 — Case Build summary.** Steps: Review · Evidence · Video · Package ·
Preview · Finalize with states. PACKAGE CONTENTS (final report + pages,
photos, videos, index, attachments). VIDEO DELIVERY (Dropbox status,
COPY VIDEO LINK, expiration if configured, created). PREVIEW PACKAGE →
then FINALIZE.

**P14 — completed package view.** Final Report ✓ Download · Photos ✓ View
· Video ✓ Copy Delivery Link · Evidence Index ✓ Download · Invoice status
+ View · Client Package ✓ Download.

**P15 — mobile case home.** Case header + ring + vertical module states +
NEXT STEP + GO + recent activity; bottom navigation Home · Activity ·
Evidence · Report · More. Optimized for field use.

**P16 — Leads & Intakes.** Sidebar section; card view per intake
(INSURANCE/PRIVATE badge, client, subject, claim, received, status
NEW / MORE INFO REQUESTED / ACCEPTED) with REVIEW · ACCEPT · VIEW ·
MESSAGE · CREATE CASE as applicable.

**P17 — manual intake.** "+ INTAKE A CLIENT" opens NEW CLIENT / LEAD:
first choice Insurance/Commercial vs Private Client, then only relevant
fields; SAVE LEAD or CREATE CASE; supports "I don't have this information
right now" / "Not applicable" (pairs with INTAKE-NA.md).

**P18 — rate sheets.** Two distinct product cards with OPEN AND SEND; a
3-step send wizard (Recipient · Options · Preview) whose Options step
pairs the matching intake — ☑ Include Insurance Assignment Intake Form /
☑ Include Private Client Intake Form. The correct intake is automatic;
never mixed.

**P19 — button rules.** Primary dark/gold (Continue Case, Add to Log,
Submit Report, Preview Package, Finalize); secondary outlined (Edit,
Back, Cancel, View). Back upper-left as "← Back to [context]"; Cancel
beside primary; primary right-most.

**P20 — remove clutter.** Show example / Add test case / Remove test
cases move to Settings → Developer/Testing (authorized admins only).
Consolidate duplicate navigation — old and new interfaces never both
live for the same task.

**P21 — responsive.** Desktop: sidebar, card grids, multi-column
overview, gallery. Mobile: drawer, stacked summary, sticky add, bottom
nav, simplified forms, large targets. Test phone/tablet/laptop/wide.

**P22 — functional navigation map.** Every element shown must have a real
destination (Continue Case → computed step; Photos → filtered gallery;
Copy Video Link → the link; Intake a Client → manual intake; Open and
Send → wizard; etc.). **No decorative dead buttons.**

**P23 — accessibility.** Clear labels, contrast, tap sizes, focus states,
text + icon for status (✓ ◐ ○ !), never color alone.

**P24 — centralized progress logic.** One set of helpers —
getCaseNextStep / getCasePackageProgress / getCaseModuleStatus over
modules (activity, report, photos, video, case_build, invoice), optional
modules excluded when irrelevant. Never duplicated across components.

**P25 — preserve existing data.** No unnecessary table rebuilds; adapt
existing cases, subjects, activity, reports, evidence, tasks, invoices,
intakes, staff. Historical cases keep working.

BUILD ORDER: the 8 phases in the ledger, items 1–50 in the handoff's
sequence. FINAL EXPERIENCE: see everything at a glance · one click to
continue · faster field entry · visual evidence · build & deliver ·
secure & organized. Dashboard answers "what needs attention next?"; the
case page answers "what do I do right now?"; Case Build answers "what is
ready to send?" — and every screen has an obvious BACK or NEXT STEP.
