# Project Status — Blue Ridge Martial Arts Kids App

Last updated: 2026-09-05

A checkpoint is marked complete only when it has actually been verified, and
each one records **how** it was verified rather than asserting it.

| Checkpoint | State | Evidence |
| --- | --- | --- |
| DESIGN SYSTEM | ✅ Complete | Token layer in `src/styles/tokens.css`; four-file cascade; every colour named once. |
| CODED | ✅ Complete | 15 screens, 12 components, 8 lessons, 2 practice routines, 8 badges. No placeholder screens. |
| TESTED | ✅ Complete | 101 checks across 5 suites, all passing. Typecheck and lint clean. |
| MOBILE CHECKED | ✅ Complete | `scripts/audit-ui.mjs`: 0 problems across 5 widths × 14 routes. Screenshots reviewed at 390px. |
| PWA CHECKED | ✅ Complete | Manifest + 4 icons verified loading in a real browser from a Pages-style sub-path. |
| GITHUB READY | ✅ Complete | Two workflows, `npm ci`-based, base path derived from the repo name. Sub-path build verified. |
| DEPLOYED | ⬜ Blocked | Needs a repository. See **Deployment** below. |
| LIVE VERIFIED | ⬜ Blocked | Follows deployment. |

---

## DESIGN SYSTEM — complete

Read off the supplied mockups: navy structure, medium blue action, sky-blue
ground, white cards, with green / gold / orange used only for meaning.

- `src/styles/tokens.css` — every colour, radius, spacing step and font stack.
- `src/styles/base.css` — reset, shell, layout helpers, reduced motion.
- `src/styles/components.css` — cards, buttons, chips, bars, fields, tickboxes.
- `src/styles/features.css` — masthead, nav, belt journey, badges, week strip,
  the guided-practice player.

Semantic accents are token **pairs** (a tint plus an ink that is legible on
it), each measured: green 6.35:1, gold 5.72:1, orange 6.02:1.

Two things were fixed after looking at rendered screenshots rather than at
code:

- The masthead tagline was drawn **over** the mountain ridge, so the peaks read
  straight through the letters. The ridge now lives in its own `.masthead__sky`
  and the tagline sits on a solid navy band beneath it.
- The belt journey used a fixed `flex-basis`, so the fifth rung was cut off at
  390px. The rungs share the width (`flex: 1 1 0; min-width: 0`) and all five
  fit, with horizontal scroll kept only as a fallback below ~300px.

## CODED — complete

Every screen in the brief is built and functional; none is a stub.

**Screens (15):** Home · Lessons · Lesson Detail · Practice · Guided Practice ·
Progress · More · Profile · Parent Mode · Instructor Demo · Schedule · Dojo
Information · Safety · Settings · Not Found.

**Content:** 8 lessons × 6 sections each (warm-up, demo, learn, reps, check,
complete) with 19 comprehension questions; 2 guided routines (10-minute and
5-minute); 7 checklist items; 8 badges; 5 belt rungs; 9 skills; 6 avatars.

**Working interactions:** timers that survive a backgrounded phone (derived
from timestamps, never a tick count); rep counters; a quiz that marks only the
option the student chose; step-by-step lesson progress that resumes where it
was left; a full-screen practice player; a checklist that persists; badge
unlocking with a live-region announcement; a PIN gate; an instructor editor
whose changes appear in the child's app immediately; reset-to-demo.

**Data model:** every type in the brief — Student, Belt, Skill, Lesson,
LessonStep, PracticeSession, WeeklyPlan, ClassSession, Badge, Attendance,
ParentInsight, InstructorSettings — plus LessonProgress, PracticeRoutine,
PracticeStep, ChecklistItem, DojoInfo, AppState and AppSettings.

## TESTED — complete

```
Test Files  5 passed (5)
     Tests  101 passed (101)
```

`npm run typecheck` — clean (TypeScript strict, `noUnusedLocals`,
`noUnusedParameters`).
`npm run lint` — clean, zero warnings.
`npm run build` — 307 KB / 91 KB gzipped.

The four areas the brief named are covered: practice completion, progress
calculations, badge unlocking, and localStorage persistence and reset. The
safety suite carries **control tests** that plant a violation and assert the
matcher catches it — without those, a broken regex set would leave the suite
green while testing nothing.

**Three real defects were found by testing and fixed, not documented as known
issues:**

1. The Instructor Demo's weekly-goal field clamped on every keystroke, so
   clearing it snapped to the minimum and the next digit appended to that —
   typing `7` produced `14`. It now holds a draft and commits a clamped value
   on blur.
2. The practice player's progress ticks were an `<ol>`, and the default list
   markers drew "1. 2. 3. 4. 5. 6." across the bar. Markers are off by default
   now, with a `.numbered` class where numbering is the content.
3. `ShellIcons` was an unused export that also tripped the Fast Refresh rule;
   the avatar catalogue was exported from a component file. Both moved or
   removed rather than suppressed with a lint disable.

## MOBILE CHECKED — complete

`scripts/audit-ui.mjs` drives real Chromium over 14 routes at 320 / 390 / 430 /
768 / 1200 px and checks horizontal overflow, tap targets, accessible names,
input font size and page errors.

```
CLEAN: no problems found
0 problem(s) across 5 widths x 14 routes
```

The first run reported **115 problems** — every one a control under the 44px
floor, mostly from inline `minHeight: 40` overriding the stylesheet. Fixed at
the source (real classes plus a floor rule at the end of the cascade), not by
loosening the audit.

Screens were also reviewed as rendered screenshots at 390px, which is how the
two design defects above were caught — neither was visible in the code.

## PWA CHECKED — complete

Manifest, four generated PNG icons (192, 512, maskable 512, apple-touch 180)
plus an SVG, standalone display, portrait orientation, theme colour, iOS
status-bar and title meta, and three app shortcuts.

Verified in a real browser against a **GitHub-Pages-shaped sub-path**
(`/blue-ridge-martial-arts-kids-app/`): the app boots, the manifest parses, all
four icons resolve, and a deep link survives a hard reload — which is the case
HashRouter exists for.

The service worker is cache-first for content-hashed assets and network-first
for everything else, so a new deploy is picked up on the next online load
instead of leaving an installed app stuck on an old build. It is not registered
in development, and any worker left from a previous production visit on the
same origin is unregistered.

## GITHUB READY — complete

- `.github/workflows/deploy.yml` — typecheck → lint → test → build → deploy, on
  pushes to `main`/`master`. Deploys only if all four pass.
- `.github/workflows/ci.yml` — the same checks on pull requests, no deploy.
- `npm ci` rather than `npm install`, so CI cannot pass against a dependency
  tree the lockfile does not describe.
- `BASE_PATH` is derived from `github.event.repository.name`, so a repository
  rename cannot silently break every asset path.
- Minimal permissions: `contents: read`, `pages: write`, `id-token: write`.

## DEPLOYED — blocked, and why

**The blocker is a repository, not the code.** This session's GitHub
integration is scoped to one unrelated repository and is not permitted to
create a new one:

```
POST /user/repos: 403 Resource not accessible by integration
```

The project is therefore committed as a **fully self-contained directory** —
its own `package.json`, build, tests, workflows and lockfile, sharing no code
with anything around it.

**To deploy it, three steps:**

1. Create an empty **public** repository named
   `blue-ridge-martial-arts-kids-app` (public is what GitHub Pages needs on a
   free plan).
2. Push this directory's contents to it as the repository root:
   ```bash
   cd blue-ridge-martial-arts-kids-app
   git init && git add -A
   git commit -m "Blue Ridge Martial Arts Kids App"
   git branch -M main
   git remote add origin https://github.com/<you>/blue-ridge-martial-arts-kids-app.git
   git push -u origin main
   ```
3. **Settings → Pages → Build and deployment → Source: GitHub Actions.**

The workflow does the rest. The site lands at
`https://<you>.github.io/blue-ridge-martial-arts-kids-app/`.

## LIVE VERIFIED — blocked

Follows deployment. What to check once it is live, on a real phone:

- Install to the home screen and confirm it opens without browser chrome.
- Complete a guided practice and watch the streak, weekly count and a badge
  move together.
- Tick the whole Get Ready checklist and confirm the Ready for Dojo badge.
- Open Parent Mode with `1234`.
- Change the belt in Instructor Demo and confirm the masthead and Progress
  screen both follow.
- Reload on a deep link (`.../#/progress`) and confirm it stays put.

## Known limitations

These are deliberate scope decisions, not defects:

- **No backend.** Everything is on the device; clearing site data clears it.
- **No video.** The Watch the Demo step says so rather than showing a dead
  play button.
- **The PIN is not security**, and the app says so on the screen.
- **One student per device.** Multi-child support needs a profile switcher and
  keyed storage.
- **The belt ladder and class schedule are demo data**, labelled as such.
- **The audit is not in `npm test`** because it needs a built app and a
  browser; it is a separate command documented in the README.
