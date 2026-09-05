# Project Status — Blue Ridge Martial Arts Kids App

Last updated: 2026-09-05

A checkpoint is marked complete only when it has actually been verified, and
each one records **how** it was verified rather than asserting it.

| Checkpoint | State | Evidence |
| --- | --- | --- |
| DESIGN SYSTEM | ✅ Complete | Token layer in `src/styles/tokens.css`; four-file cascade; every colour named once; semantic accents measured as pairs. |
| CODED | ✅ Complete | 15 screens, 13 components, 8 lessons, 2 routines, 9 badges. No placeholder screens. |
| TESTED | ✅ Complete | 145 checks across 6 suites, all passing. Typecheck and lint clean. |
| MOBILE CHECKED | ✅ Complete | `npm run audit:ui`: 0 problems across **6 widths** (320/375/390/430/768/1200) × 14 routes, plus dialogs, the planner panel and the player. Screenshots reviewed at 320 and 390. |
| PWA CHECKED | ✅ Complete | Manifest, 4 icons, service worker and Apple metadata all verified loading in a real browser **from a Pages-shaped sub-path**; deep link survives a hard reload. |
| GITHUB READY | ✅ Complete | Two workflows, `npm ci`, base path derived from the repo name. Sub-path build served and driven. |
| PUSHED | ✅ Complete | `claude/blue-ridge-kids-app-mzor0d`, working tree clean. Working tree clean. |
| DEPLOYED | 🟡 Partial | GitHub Pages blocked on a repository this integration cannot create (403, retried). A single-file build is published and live as a Claude Artifact. |
| LIVE VERIFIED | 🟡 Partial | The single-file build was driven in a real browser — a practice completed end to end and persisted. GitHub Pages itself is unverified because it is undeployed. |

Three audits beyond the unit suite, all running clean — and each of which
found real defects on its first honest run:

| Audit | Result |
| --- | --- |
| `npm run audit:ui` | 0 across 6 widths × 14 routes |
| `npm run audit:a11y` | 0 across 14 routes |
| `npm run audit:runtime` | 0 after 16 driven journeys |

--- | --- | --- |
| DESIGN SYSTEM | ✅ Complete | Token layer in `src/styles/tokens.css`; four-file cascade; every colour named once. |
| CODED | ✅ Complete | 15 screens, 12 components, 8 lessons, 2 practice routines, 8 badges. No placeholder screens. |
| TESTED | ✅ Complete | 101 checks across 5 suites, all passing. Typecheck and lint clean. |
| MOBILE CHECKED | ✅ Complete | `scripts/audit-ui.mjs`: 0 problems across 5 widths × 14 routes. Screenshots reviewed at 390px. |
| PWA CHECKED | ✅ Complete | Manifest + 4 icons verified loading in a real browser from a Pages-style sub-path. |
| GITHUB READY | ✅ Complete | Two workflows, `npm ci`-based, base path derived from the repo name. Sub-path build verified. |
| DEPLOYED | 🟡 Partial | GitHub Pages blocked on a repository (see below). A single-file build is published and live as a Claude Artifact in the meantime. |
| LIVE VERIFIED | 🟡 Partial | The single-file build was driven in a real browser: a practice completed end to end and persisted. GitHub Pages itself is unverified because it is undeployed. |

---

## DESIGN SYSTEM — complete

Read off the supplied mockups: navy structure, medium blue action, sky-blue
ground, white cards, with green / gold / orange used only for meaning.

- `src/styles/tokens.css` — every colour, radius, spacing step and font stack.
- `src/styles/base.css` — reset, shell, layout helpers, reduced motion.
- `src/styles/components.css` — cards, buttons, chips, bars, fields, tickboxes.
- `src/styles/features.css` — masthead, nav, belt journey, badges, week strip,
  the guided-practice player, and every phone override, at the end of the
  cascade so source order cannot silently kill one.

Semantic accents are token **pairs** (a tint plus an ink legible on it), each
measured: green 6.35:1, gold 5.72:1, orange 6.02:1.

Four things were fixed after looking at rendered screenshots rather than at
code — none was visible in the source:

- The masthead tagline was drawn **over** the mountain ridge, so the peaks read
  through the letters. The ridge now sits in its own `.masthead__sky` and the
  tagline on a solid navy band beneath it.
- The belt journey used a fixed `flex-basis`, so the fifth rung was cut off at
  390px. The rungs share the width and all five fit.
- At 320px the decorative script aside took 74px and squeezed the wordmark to
  an 88px box, wrapping BLUE RIDGE onto two lines and MARTIAL ARTS onto two
  more. Decoration yields to identity below 400px: measured 88px → 170px.
- Five strings sat under 11px. "Home Practice" at 9px across a 40px column was
  two cramped lines; the strip draws "Home", the accessible name still says
  "Home Practice", and the icon carries it a third way.

## CODED — complete

Every screen in the brief is built and functional; none is a stub.

**Screens (15):** Home · Lessons · Lesson Detail · Practice · Guided Practice ·
Progress · More · Profile · Parent Mode · Instructor Demo · Schedule · Dojo
Information · Safety · Settings · Not Found.

**Content:** 8 lessons × 6 sections with 19 comprehension questions; 2 guided
routines; 7 checklist items; 9 badges; 5 belt rungs; 9 skills; 6 avatars.

**Working interactions:** timers derived from timestamps (so a backgrounded
phone cannot make them lie); rep counters; a quiz that marks only the option
chosen; lesson progress that resumes where it stopped; a full-screen practice
player; a tappable weekly planner with a per-day detail; a persisted checklist;
badge unlocking with a live-region announcement; a PIN gate; an instructor
editor whose changes reach the child's app immediately; reset-to-demo.

**Data model:** every type the brief names — Student, Belt, Skill, Lesson,
LessonStep, PracticeSession, WeeklyPlan, ClassSession, Badge, Attendance,
ParentInsight, InstructorSettings — plus LessonProgress, PracticeRoutine,
PracticeStep, ChecklistItem, DojoInfo, TodayPlan, AppState and AppSettings.

## TESTED — complete

```
Test Files  6 passed (6)
     Tests  145 passed (145)
```

`npm run typecheck` — clean (strict, `noUnusedLocals`, `noUnusedParameters`).
`npm run lint` — clean, zero warnings.
`npm run build` — 314 KB / 92 KB gzipped.

Every area the brief's item 22 names is covered: practice completion, weekly
progress, readiness, badge unlocking, duplicate badge prevention, localStorage
save/load, Reset Demo Data, and instructor settings propagation (its own
suite, `instructor.test.ts`, plus the same thing through the real screens in
`app.test.tsx`).

The safety suite carries **control tests** that plant a violation and assert
the matcher catches it — without those, a broken regex set would leave the
suite green while testing nothing.

**Nine real defects were found by testing and review, and fixed rather than
documented as known issues:**

1. Badges were never settled on **load**, so the seeded demo drew "0 of 9"
   with First Practice locked while its own requirement was met.
2. Parent Mode and Schedule both read "Thursday, Thursday, September 10".
3. Nine stat labels were fixed plurals: "1 Badges earned".
4. The Instructor Demo goal field clamped on every keystroke, so typing `7`
   produced `14`.
5. The practice player's progress rail drew list markers "1. 2. 3." across
   itself.
6. The planner's start button had its click handler on an inner span.
7. The lesson availability toggles had no accessible name of their own.
8. `skillsPractisedThisWeek` existed and nothing called it, while Parent Mode
   answered "what Alex practised" only from the instructor's note.
9. Dead code: `GrowthCategory`, `skillById`, `formatMinutes`, `IconProps`.

## MOBILE CHECKED — complete

`npm run audit:ui` drives real Chromium over 14 routes at 320 / 375 / 390 /
430 / 768 / 1200 px and checks horizontal overflow, tap targets, accessible
names, input font size, text under 11px, controls buried under the fixed
bottom nav, the confirm dialogs, the planner's detail panel, the guided player
and whether the wordmark wraps.

```
CLEAN: no problems found
0 problem(s) across 6 widths x 14 routes
```

The first run reported **115 problems**, every one a control under the 44px
floor from inline `minHeight: 40` overriding the stylesheet. Fixed at the
source — real classes plus a floor rule at the end of the cascade — not by
loosening the audit. Its own first nav-overlap result was a false positive
from measuring a document still laying out, fixed in the audit.

## ACCESSIBILITY CHECKED — complete

`npm run audit:a11y` tabs every screen and checks reachability, a visible focus
ring, an accessible name, forward focus order, Escape leaving the player, and
reduced motion.

```
0 problem(s) across 14 routes
```

It reported five problems on its first run and **all five were its own**: it
read an input's name from `textContent` rather than its `<label for>`, and it
treated a repeat visit as a wrap — so `<input type="time">`, which legitimately
consumes three Tab presses for hour, minute and AM/PM, cut the Instructor Demo
walk short at 16 of 47 controls. Both fixed in the audit, not by loosening what
it asks of the app.

## RUNTIME CHECKED — complete

`npm run audit:runtime` drives sixteen real journeys and watches for console
errors, React warnings, failed requests and links to routes that do not exist.

```
0 problem(s) after 16 journeys
```

Each journey **asserts the effect it should have had** — the practice was
logged and earned a badge, the checklist stored, the planner drew seven days,
every instructor field persisted, the plan's dojo day followed the class day,
the profile saved, the reset restored Alex — because a sweep that reports
clean while silently doing nothing is the exact failure it exists to catch.

## PWA CHECKED — complete

Manifest, four generated PNG icons (192, 512, maskable 512, apple-touch 180)
plus an SVG, standalone display, portrait orientation, theme colour, iOS
status-bar and title meta, and three app shortcuts.

Verified in a real browser against a **GitHub-Pages-shaped sub-path**
(`/blue-ridge-martial-arts-kids-app/`): the app boots, the manifest parses,
all four icons resolve with the right content types, `sw.js` serves, and a
deep link survives a hard reload — which is the case HashRouter exists for.

The service worker is cache-first for content-hashed assets and network-first
for everything else, so a new deploy is picked up on the next online load
instead of leaving an installed app stuck on an old build.

## GITHUB READY — complete

- `.github/workflows/deploy.yml` — typecheck → lint → test → build → deploy on
  pushes to `main`/`master`. Deploys only if all four pass.
- `.github/workflows/ci.yml` — the same checks on pull requests, no deploy.
- `npm ci`, so CI cannot pass against a tree the lockfile does not describe.
- `BASE_PATH` derived from `github.event.repository.name`.
- Minimal permissions: `contents: read`, `pages: write`, `id-token: write`.

## PUSHED — complete

Branch `claude/blue-ridge-kids-app-mzor0d`, working tree clean, five commits
this run.

## DEPLOYED — partial

### The live preview

A single-file build (`npm run build:single`) is published and openable on a
phone today — the same bundle with CSS and JS inlined. Two things do not carry
over, because they need sibling files: the manifest and the service worker, so
**Add to Home Screen and offline use are not available on the preview**. Both
work on a Pages deploy.

### GitHub Pages — blocked on a repository

Retried this run; still `403 Resource not accessible by integration`.
`list_repos` confirms no Blue Ridge repository exists on the account. The three
remaining steps are in `NEXT.md`, and none of them is a code change.

## LIVE VERIFIED — partial

The single-file build was driven in a real browser: it boots, a guided practice
runs to completion, the record persists, and the console is clean. GitHub Pages
itself is unverified because it is undeployed.

## Known limitations

Deliberate scope decisions, not defects:

- **No backend.** Everything is on the device; clearing site data clears it.
- **No video.** The Watch the Demo step says so rather than showing a dead
  play button.
- **The PIN is not security**, and the app says so on screen.
- **One student per device.**
- **The belt ladder and class schedule are demo data**, labelled as such.
- **The three audits are not in `npm test`** — they need a built app and a
  browser, and are `npm run audit`.
