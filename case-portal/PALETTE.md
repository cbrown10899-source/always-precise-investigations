# Portal palette normalization — the owner's brief, verbatim

**Roadmap item 13.** Queued by the owner on **2026-08-20**, mid-Unit-11, with
*"Do not interrupt the active coding unit."* No explicit position was given;
it sits at 13 — after the Daily Summary Builder the owner placed at 12 the same
day, and **before** Storage Health, Case Closeout and Client Delivery — because
the brief's own component list names *"future File Queue, future Storage
Health, future Case Closeout, future Client Delivery"* as things that must
inherit the palette, which only works if this lands first. If the owner meant a
different slot, moving the row is the whole change.

**Nothing below is designed yet.** The brief survives here verbatim, the way
`LEGAL-INTAKE.md`, `PROFILES.md`, `TIMELINE.md` and `DAILY-SUMMARY.md` work.
Derived decisions get listed underneath when the unit is built.

---

## THE BRIEF, AS WRITTEN

> Queue a portal-wide aesthetic system update using the approved current
> dashboard colors as the permanent Always Precise portal palette.
>
> Do not interrupt the active coding unit.
>
> LOCKED VISUAL DIRECTION
>
> Keep and standardize the current color scheme:
>
> PRIMARY NAVY
> Use for:
> - sidebar
> - top header
> - primary action buttons
> - strong section anchors
> - selected/navigation emphasis
>
> TEAL / BLUE-GREEN ACCENT
> Use for:
> - active state
> - selected state
> - links
> - secondary emphasis
> - informational status
> - focus accents
>
> MUTED GOLD / AMBER
> Use selectively for:
> - important actions
> - warnings
> - intake/client CTA
> - attention indicators
> - special operational emphasis
>
> LIGHT SURFACES
> Use:
> - white
> - very light gray
> - subtle cool-gray backgrounds
>
> for:
> - working panels
> - forms
> - cards
> - tables
> - report builder
> - file queue
> - case workspace
>
> STATUS COLORS
> Keep restrained and professional:
> - success = muted green
> - warning = amber
> - error/urgent = muted red
> - informational = teal/blue
> - neutral/inactive = gray
>
> Do not make status colors overly saturated.
>
> ## DESIGN SYSTEM
>
> Apply the palette through shared CSS variables/tokens rather than hard-coded
> colors scattered page by page.
>
> Create/reuse variables for:
>
> --navy-900 / --navy-800 / --navy-700 / --teal-600 / --teal-500 / --gold-500
> --surface-0 / --surface-50 / --surface-100 / --border
> --text-primary / --text-secondary
> --success / --warning / --danger / --info
>
> Use actual values based on the existing live dashboard appearance rather than
> inventing a visibly different palette.
>
> ## COMPONENT CONSISTENCY
>
> Standardize this palette across:
>
> - Dashboard
> - Search
> - Cases
> - Intakes
> - Clients & Firms
> - Calendar
> - Reports & Packages
> - Billing
> - Staff
> - Settings
> - Active Surveillance
> - Timestamp Photo
> - Timestamp Video
> - Legal Intake
> - Case Timeline
> - Evidence Integrity
> - future File Queue
> - future Storage Health
> - future Case Closeout
> - future Client Delivery
>
> ## SIDEBAR / HEADER
>
> Keep the dark navy appearance.
>
> Use teal for selected/active navigation emphasis.
>
> Use gold sparingly for a prominent CTA such as:
> + Intake a Client
>
> Do not turn every button gold.
>
> ## CARDS / TABLES
>
> Keep cards mostly light/white.
>
> Use subtle borders and restrained shadows.
>
> Table headers may use navy where it improves hierarchy.
>
> Status chips use small tinted backgrounds, not large bright blocks.
>
> ## BUTTONS
>
> Primary: dark navy
> Secondary: white/light with navy or teal border
> Accent: teal
> Special CTA: gold/amber only where intentionally important
> Destructive: muted red
>
> Do not mix arbitrary button colors across pages.
>
> ## FILE QUEUE AESTHETIC
>
> When File Queue is built, use the approved mockup direction:
>
> - navy sidebar/header
> - white queue surface
> - summary cards across top
> - teal/blue informational states
> - amber waiting/review states
> - green ready/completed states
> - subtle gray completed/archive state
> - dark navy primary action buttons
> - clean file-detail view
> - lightweight metadata cards
> - professional status timeline
>
> Do not add heavy image assets.
>
> ## MOBILE
>
> Preserve the same palette on phone.
>
> Maintain:
> - readable contrast
> - clear selected state
> - 44px-ish targets
> - no horizontal overflow
> - no tiny colored badges
> - no excessive decorative gradients
>
> ## ACCESSIBILITY
>
> Verify contrast for:
> - navy text/button combinations
> - teal links
> - gold labels/buttons
> - muted status chips
> - disabled states
>
> Do not sacrifice readability just to preserve a shade.
>
> ## IMPLEMENTATION RULE
>
> This is a visual-system normalization.
>
> Do not rewrite business logic.
>
> Do not change storage.
>
> Do not change permissions.
>
> Do not change report, search, timeline, intake, billing or surveillance
> behavior merely to apply the palette.
>
> Record this approved palette in the appropriate design/CLAUDE documentation
> so later units inherit it automatically.

---

## WHAT THIS REPO ALREADY HOLDS FOR IT

Noted at queueing time only; **no design decisions are made here.**

- `portal/index.html` already carries CSS custom properties (`--line`,
  `--muted`, `--panel2` and friends) — the unit RENAMES AND COMPLETES a token
  layer more than it introduces one. The brief's rule that values come from the
  live dashboard means the first step is reading the computed values off the
  deployed page, not picking new ones.
- The measurement discipline is Unit 5's: changes asserted from COMPUTED
  styles, phone overrides at the END of the stylesheet, distinct class-name
  prefixes (`.qtgrid`, `.tl2-`, `.integ` are the precedents), and the ≥8-point
  luminance rule for controls against their background.
- The suite already asserts the 44px floor, the 16px input floor and the
  no-horizontal-overflow probes at four widths — the palette pass inherits
  those as its regression net, plus new contrast checks the brief asks for.
- "A staff screen must not assert something untrue" applies to color too:
  status tones are words as well as colours (Unit 8's severity rule), so no
  status may become colour-only in the normalization.

---

## BUILT — 2026-08-20 (Unit 13). The decisions this build DERIVED

- **D1 — The palette was READ, not chosen.** The live page already carried
  thirteen tokens (`--navy … --warn`); the unit completed that one layer with
  the conceptual roles the brief names — every added value is a color the
  deployed portal was already drawing. 237 literal occurrences (of 205
  distinct colors) were swept into `var()` references; what remains outside
  `:root` is white plus one-and-two-use shades.
- **D2 — The field family is deliberately apart** (`--field-*`): Active
  Surveillance and the timestamp tools run dark and high-contrast for
  one-handed use in the dark, and naming their tokens separately is what stops
  a later "normalization" from quietly restyling a field control to office
  values.
- **D3 — Semantic chips are PAIRS** (`--ok-bg`/`--ok-ink` …): a tint without
  its ink is how a chip drifts illegible, so the tokens ship as pairs and the
  suite asserts the computed pair on a live chip.
- **D4 — Two measured contrast fixes, at the token:** `--warn` deepened
  `#a86a12 → #96600f` (4.43→5.28 on white, 3.98→4.74 on its tint — the only
  text-role pair that failed 4.5), and `--disabled` set to `#6f7d8c` rather
  than the field-muted value that read 2.2:1 on paper. Everything else passed
  as measured, including the gold CTA's navy ink at 6.79:1.
- **D5 — PRIMARY IS NAVY, and the teal fill was the drift.** The live `.btn`
  filled teal; the owner's brief says twice that primary is dark navy with
  teal as accent. `.btn` is now `--navy-2` (hover `--navy`), `.btn.accent`
  keeps the teal fill for deliberate accent actions, and `.btn.ghost` is
  unchanged.
- **D6 — The anti-drift budget is the durable test:** no non-white color may
  be used more than twice outside `:root`. It caught two families the sweep
  missed (the media/voice purple, now `--media-*`, and a duplicate
  selected-card wash consolidated onto `--teal-wash`) and it is what catches
  the next sixteen copies of one navy arriving quietly.
- **D7 — Print and the phone are asserted, not assumed:** the print rules
  still isolate all four document regions and paint no navy over paper; the
  375/390/430 probes still show no overflow, a visible burger, a navy drawer
  and the 16px input floor.
- **D8 — Deferred, named:** the one-and-two-use shades (hover variants,
  calendar chips, SV specials) stay literal — pinning every shade would be the
  brittleness the brief warns against; the budget holds the line at the
  families. The File Queue aesthetic stays recorded above, unbuilt.
