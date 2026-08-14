# Active Surveillance Mode — Handoff (INTERNAL)

**Recorded in substance from the owner's handoff on 2026-08-13**, with two
detailed mockups (dark field interface; quick-reporting workflow strip; PWA
home-screen shot). Lives in `case-portal/` because this directory never
deploys. Owner's sequencing: build after the shared Case/Activity/Evidence
model is stable — i.e. after the UIBUILD phases.

**FINAL RULE (the owner's, verbatim in spirit):** Active Surveillance Mode
is a VIEW of the existing case — not a separate app database. Same
authenticated user, same case, same activity log, same evidence, same
investigation day, same report draft. Leave the mode, open the normal
portal, and everything is already there. No duplicate tables (no
mobile_activity_log / mobile_reports / mobile_evidence — ever). PWA-ready
so it can be added to a phone's home screen ("API Surveillance") while
remaining the same secured website.

Progress ledger (handoff phases):

| Phase | Status |
| --- | --- |
| 1. Foundation (route; reuse auth; verify case authorization server-side; shared data; Start button on eligible cases) | **done** — 2026-08-13 (the mode is a full-screen VIEW inside the existing SPA — `SV` state, no new router — reached from a prominent button at the top of the assignment, and from `?surveillance=1`. Every read and write goes through routes that already existed and already check that this caller may open this case; **no new table, and the two new endpoints only answer "am I out?" and "who is out?" over `case_days`**) |
| 2. Active day (start day; persistent server-derived timer; end day with confirmation + totals; case-info drawer; remaining authorization) | **done** — 2026-08-13 (**the timer derives from `case_days.created_at` — the server's own instant — corrected by the skew measured against the Worker's clock, and nothing counts ticks: a reload, a sleeping phone or a wrong device clock cannot move it, and a test reloads mid-day to prove it. The investigator's recorded `start_time` stays what the day's hours are computed from.** End day is a confirmation screen with elapsed, entries, photos, video and mileage, plus "Keep working" — never one tap. The drawer carries subject, address, vehicles, scope, permitted days/times, geography and hours remaining) |
| 3. Rapid reporting (quick activity; search; favorites; structured templates; one-tap No Change; editable narrative; save + Add Another; timeline) | **done** — 2026-08-13 (the SAME `ACTION_GROUPS`, `ALL_LINES` and per-username favorites the desktop sheet uses — one vocabulary, so a line starred in the office is starred in the field. Search, categories, pick → editable narrative with time and the three capture flags, More Details fold, Save → "✓ Activity saved" → Add another / View timeline. One-tap No change. Timeline with 📷/🎥 counts) |
| 4. Voice (device dictation everywhere; optional in-app voice entry with review + Use/Discard; never auto-submit; honest privacy wording; voice nav later/optional) | **done** — 2026-08-13 (Level 1 is every field accepting the keyboard's own dictation. Level 2 is the Web Speech API where the browser has it: Tap to speak → Listening → **the transcript is shown in a light review panel and Use Text is the only way it becomes an entry** — nothing spoken is ever auto-submitted. Where the API is absent the button says so plainly and points at keyboard dictation. **The wording is only what is verifiable**: "dictation is handled by your device or browser; this page keeps no audio" — the mockup's "never stored" claim is exactly what P8 says not to repeat, and it is not repeated. Voice navigation: not built, deliberately — it was optional, and nothing dangerous should be one word away) |
| 5. Evidence (photo/video upload; activity linking; mobile gallery; Dropbox large-video handoff prep) | **done** — 2026-08-13 (Photo/Video quick actions open the phone's own picker — `capture="environment"` on photo so the camera is one tap — and post to the SAME evidence route, riding with the most recent activity entry automatically. Everything lands `needs_review`: the field never decides client delivery, the office does in Case Build, and the screen says so. Mobile gallery of thumbnails, never a table. The free-plan failsafe and the Dropbox handoff are unchanged underneath) |
| 6. Reporting (report builds from activities; mobile preview; submit → preserved version → admin review queue) | **done in first form** — 2026-08-13 (the Report screen shows the draft building from the timeline with a live entry count, the report's status once one exists, and hands off to the full report screen for the submit workflow — which already preserves the exact submitted version and queues it for the office. A dedicated mobile draft-preview/chronology reader is the one piece left, and it is a reading surface, not a data path) |
| 7. Web-app experience (bottom nav; drawer; PWA manifest/readiness; home-screen launch; resume active state) | **done** — 2026-08-13 (bottom navigation Home · Activity · Evidence · Report · Case; `portal/manifest.webmanifest` — "API Surveillance", standalone, portrait, navy — with `start_url` `/portal/?surveillance=1`; that flag opens the launcher: **Resume active surveillance** with the running elapsed time, or **My surveillance assignments** when nothing is running. Same secured site, same login, no app-store build. The owner supplied the **Active Surveillance mark** on 2026-08-14; it is now the home-screen icon at 192/512, the Apple touch icon at 180, and the face of the launch button inside the portal, so the two are visibly one thing. Deliberately NOT declared maskable — an Android mask crops the corners and would take the firm's banner off the top of it) |
| 8. Admin connection (Out Now with elapsed + last activity; reports awaiting review; Case Build handoff; invoice data) | **done** — 2026-08-13 (an Out now strip above the admin dashboard: who, case, subject, recorded start, elapsed, the last thing logged and how long ago, each row opening the case. **No location, no GPS** — the handoff is explicit that this phase tracks nobody's position, and a test asserts the payload carries none. Reports, Case Build and invoicing already consume the same day/activity/evidence records, so there was nothing to wire) |
| 9. Test (iPhone Safari; Android Chrome; desktop; lock/resume; refresh mid-day; uploads; permissions; back buttons; timer accuracy; report transfer) | **partly done** — 2026-08-13 (automated at a real 390×844 viewport: enter, start day, timer survives a reload, quick activity, one-tap No change, drawer withholds carrier and money, end-day confirmation with totals, exit, and **the field's work appearing in the ordinary activity log and day list** — plus the launcher, resume, and Out now. **Left for the owner: real iPhone Safari and Android Chrome**, including the phone's camera picker and its dictation, which no headless run can honestly cover) |

---

The handoff, in substance (25 priorities):

**P1 — launch from the case.** A prominent START ACTIVE SURVEILLANCE MODE
inside eligible cases (assigned, permitted, surveillance-related: WC /
liability / disability / custody / infidelity / domestic / general
surveillance; hidden where irrelevant unless admin enables). Route like
`/portal/cases/:id/surveillance` — inspect existing router conventions
first. Authorization carried server-side; never client-editable fields;
the server verifies THIS investigator may access THIS case.

**P2 — active home.** Darker, dramatically simpler than the admin portal
(vehicle, dawn, dusk use). Header: ☰, case #, type badge, optional subject
identifier — never billing. DAY 1 + large elapsed timer (e.g. 02:47:32)
and a gold END INVESTIGATION DAY. **Timer rule:** elapsed derives from the
server-stored day start; refresh/sleep/reload never resets it.

**P3 — start day.** Compact confirmation: start time (now), starting
mileage (optional), location (optional), note (optional) → START DAY,
recorded server-side; UI switches to active mode.

**P4 — quick add.** Four one-hand actions: ACTIVITY · PHOTO · VIDEO ·
NOTE (note defaults INTERNAL ONLY). Never route through the full portal.

**P5 — quick activity entry.** QUICK/CUSTOM tabs; large search ("Search or
pick an action…"); categories ⭐ Favorites · Arrival · No Activity ·
Subject · Vehicle · Location · More; favorites first (starred, per
account if practical).

**P6 — realistic templates.** ARRIVAL (vicinity of residence; established
position with direct/indirect/primary-route/secondary/mobile options) —
generated editable narrative. NO ACTIVITY (no change; no activity
observed; residence quiet; vehicles remained). SUBJECT (exited/entered
residence or vehicle, walking, standing, sitting, bending, stooping,
reaching, carrying, lifting, pushing, pulling, loading, unloading,
climbing stairs, shopping, yard work, recreation, entered/exited
business, met individual, other). VEHICLE (observed, departed, arrived,
entered/exited, mobile surveillance initiated, stopped, parked).
LOCATION (arrived at business/residence/appointment, entered/exited/
departed). SURVEILLANCE (lost visual, re-established, position changed,
compromised, unable to safely maintain, discontinued). END DAY (time
completed, subject remained, location lost, admin direction, other).

**P7 — entry details.** After the action: TIME (now) · editable generated
DETAILS · flags (subject documented / photo / video) · MORE DETAILS
collapsed (location, vehicle, linked evidence, internal note) → SAVE
ACTIVITY → big "✓ ACTIVITY SAVED" → ADD ANOTHER / VIEW TIMELINE.

**P8 — speech to text.** Progressive: LEVEL 1 — every text area works
with native iPhone/Android keyboard dictation (no special integration).
LEVEL 2 — where the platform supports it, 🎤 TAP TO SPEAK → "Listening…"
→ transcript shown → USE TEXT or DISCARD. **Never auto-submit spoken text
into the official log.** Flags (e.g. photo taken) pre-check only with
explicit review. Voice navigation later, optional, never required, never
for dangerous acts (ending the day, submitting the report) without
explicit confirmation. **Voice privacy honesty:** never claim "voice is
never stored" unless technically verified for the actual implementation;
disclose any external transcription service in settings/privacy notes.

**P9 — timeline.** Home shows LAST ACTIVITY + VIEW TIMELINE; the timeline
screen is chronological with 📷/🎥 counts and a persistent + ADD
ACTIVITY.

**P10 — photo workflow.** Native file/photo selection → preview → "What
does this photo document?" → quick association (current activity / most
recent / select / general) → classification defaults NEEDS REVIEW.
Investigators never decide client delivery — that is Admin Case Build.

**P11 — video workflow.** Upload/select, associate with activity +
description; large files use the Dropbox workflow when available;
original-evidence rules always hold.

**P12 — mobile evidence.** Bottom nav HOME · ACTIVITY · EVIDENCE ·
REPORT · MORE; evidence tabs Photos/Video/Documents/All as thumbnails,
never giant tables.

**P13 — live report.** Every entry feeds the existing draft; show
"Draft building from your activity timeline"; mobile report view (draft
preview, chronology, summary, attachments); REVIEW REPORT at day end;
submit uses the existing workflow (preserved submitted version → admin
review queue → Case Build).

**P14 — end day.** Confirmation with start/end/total hours, mileage in/
out/total, entry + photo + video counts → END DAY & REVIEW. Never ends
accidentally; never from one unconfirmed voice command.

**P15 — return.** ← EXIT ACTIVE MODE back to the normal case page; same
session, no separate login.

**P16 — PWA.** Home-screen shortcut ("API Surveillance"), app-like
presentation, fast launch. `/portal/surveillance` without an active case
shows MY SURVEILLANCE ASSIGNMENTS; with an active day, RESUME ACTIVE
SURVEILLANCE. No app-store build.

**P17 — session resilience.** Submitted work persists server-side
immediately (activity, day, evidence metadata, report). Safe draft
preservation for unsaved text where the architecture allows. Connection
status + offline queueing is a FUTURE enhancement — never an unreliable
offline database now.

**P18 — admin live status.** OUT NOW shows who, case, started, elapsed,
last-activity age. Operational only; no continuous GPS tracking in this
phase.

**P19 — field-only information.** Show what field work needs (subject,
photos, residence, vehicles, objective, restrictions, schedule, prior
notes, authorized hours, instructions). Hide billing rate, redacted
client identity, adjuster contact, profit, invoices, admin notes, other
investigators' pay — existing permissions enforce it.

**P20 — case info drawer.** Compact: subject, photos, address, vehicles,
objective, schedule, remaining authorized time — no jumping to the full
portal.

**P21 — remaining authorization.** "17.5 HOURS REMAINING" for the
investigator (hours, never the client price); AUTHORIZATION LOW warning
at threshold; admin keeps the financial view.

**P22 — private cases.** Same field workflow for infidelity / custody /
domestic / private surveillance; information adapts; no insurance
authorization fields on private cases.

**P23 — invoicing stays admin.** The mode generates time, mileage,
activity, evidence; admin billing consumes them later. Field
documentation never carries client financial decisions.

**P24 — safety design.** Large targets, minimal typing, high contrast,
one primary action per screen, dark surveillance view, fast
confirmations. Nothing that encourages interacting while driving; quick
documentation only when safely stopped.

**P25 — back buttons.** ← Exit Active Mode / ← Back to Active
Surveillance / ← Back everywhere, obvious on mobile, never browser-only.

DESKTOP: allowed (day + quick actions | timeline | case info), mobile
first. ROUTING: match existing conventions — inspect first. SHARED
DATABASE: the existing tables only. API: reuse existing server actions
(start/end day, activity, evidence, report) — security server-side.
AUDIT: started/created/edited/uploaded/linked/submitted/ended with
investigator + timestamp + case.

DESIGN REFERENCE: the two mockups — dark navy field interface, large
elapsed timer, gold End Investigation Day, four Quick Add actions,
prominent microphone, recent activity, bottom navigation, light
speech-review panel, simplified timeline. Guidance, not gospel: build on
real case data and the existing architecture; never copy mock text
blindly. (Note: the mock's "Voice data is processed securely and never
stored" line is exactly the kind of claim P8 says to verify before
displaying.)
