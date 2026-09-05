# NEXT — Blue Ridge Martial Arts Kids App

Where the project stands, and what to pick up next. Written to be read cold.

Last updated: 2026-09-05

---

## Current state, exactly

A complete, working mobile-first PWA demo. Every screen in the brief is built
and functional; none is a stub. It runs entirely in the browser with no
backend, no accounts and no payments.

| | |
| --- | --- |
| **Branch** | `claude/blue-ridge-kids-app-mzor0d` |
| **Latest commit** | `984710b` — *Self-review as child, parent, instructor and owner — four defects found* |
| **Push status** | Pushed. Working tree clean. |
| **Repository** | See **The one thing blocking deployment** below — this is **not** its own repo yet. |
| **Live preview** | Published as a Claude Artifact (link in the session report). Openable on a phone; **cannot** be installed to a home screen — see PWA note below. |
| **GitHub Pages** | Not deployed. Workflow written and the sub-path build verified. |
| **Tests** | 139 passing, 6 suites |
| **Typecheck / lint** | Clean |
| **Production build** | 312 KB, 92 KB gzipped |
| **UI audit** | 0 problems across 6 widths × 14 routes |
| **Accessibility audit** | 0 problems across 14 routes |
| **Runtime audit** | 0 problems after 16 driven journeys |

## The one thing blocking deployment

**A repository.** This session's GitHub integration is refused repository
creation:

```
POST /user/repos: 403 Resource not accessible by integration
```

It was retried this run and still fails. `list_repos` confirms no Blue Ridge
repository exists on the account — only `always-precise-investigations` and
four unrelated projects, none of which were touched.

So the app lives as a **fully self-contained directory**:
`blue-ridge-martial-arts-kids-app/`. It has its own `package.json`,
lockfile, `.gitignore`, workflows, tests and build. It shares no code, no
config and no dependency with anything around it, and it cannot reach any
other project's deploy — verified by running that project's own build stager
and confirming this directory is not staged.

**Three steps to finish it. No code changes needed.**

1. Create an empty **public** repository named
   `blue-ridge-martial-arts-kids-app`. Public is what GitHub Pages needs on a
   free plan.
2. Push this directory's contents as the repository root:
   ```bash
   cd blue-ridge-martial-arts-kids-app
   git init && git add -A
   git commit -m "Blue Ridge Martial Arts Kids App"
   git branch -M main
   git remote add origin https://github.com/<you>/blue-ridge-martial-arts-kids-app.git
   git push -u origin main
   ```
3. In that repository: **Settings → Pages → Build and deployment → Source:
   GitHub Actions.**

The workflow does the rest. The site lands at
`https://<you>.github.io/blue-ridge-martial-arts-kids-app/`.

## Completed features

**Shell and navigation.** Five-destination bottom nav (Home / Lessons /
Practice / Progress / More), HashRouter so a refresh on any route works on
Pages, a skip link that moves focus, one `<h1>` per screen.

**Home.** Reads the instructor's plan rather than assuming: a dojo day leads
with the checklist, a rest day says rest is part of training and offers
"Practise anyway", a home day offers Start Practice. Weekly tracker, Mon–Sun
strip, streak, badges, Ready-for-Dojo status, four shortcuts, and This Week's
Focus where each chip opens the lesson that teaches it.

**Lessons.** Eight lessons across All / Current Belt / Skills / Character,
each showing title, skills, time, difficulty, belt and completion state. Six
sections each — Warm-Up, Watch Demo, Learn, Practice Reps, Check
Understanding, Complete — with working timers, rep counters, 19 comprehension
questions, a step map, and resume-where-you-stopped.

**Guided practice.** Full-screen dark player: Start, Pause, Resume, Previous,
Next, Skip, Complete, with timers that survive a backgrounded phone (derived
from timestamps, never a tick count), rep counters, a progress rail and a
completion screen. Completing one updates the streak, the weekly count, the
badges and the planner together.

**Weekly plan.** Mon–Sun planner distinguishing Home Practice / Dojo Class /
Rest Day. Tapping a day opens a detail panel; today offers a practice. There
is deliberately **no back-dating** — see Known decisions.

**Ready for Dojo.** Seven-item checklist with a readiness ring, persisted,
earning its badge at 7/7.

**Weekly mission.** Title and detail, both instructor-editable, with live
progress against the goal.

**Progress.** Belt journey (labelled a demo progression), next goal, test
window, totals, weekly bar, four growth readings as words with the activity
each counted stated beside it, attendance, and a nine-badge wall where tapping
a badge explains how it is earned.

**Badges.** Nine, each unlocking on its own stated requirement, never awarded
twice, never taken away, and settled on load as well as on action.

**Parent Mode.** Demo PIN `1234`, labelled DEMO ONLY. Shows practices this
week, lessons completed, streak, readiness, next class, the weekly goal, what
the app **recorded** at home, what the **instructor** noted, what to work on
next, current focus, and every practice logged this week.

**Instructor Demo.** Edits belt, next goal, test window, weekly focus, class
day and time, class focus, weekly goal, mission, lesson availability,
instructor name and note, the two insight lists, and attendance. Every change
appears in the student and parent app immediately — verified in a browser.

**More.** Student Profile, Parent Mode, Instructor Demo, Schedule, Dojo
Information, Safety, App Settings, Reset Demo Data.

**Dojo Information.** Name and city only. Phone, website, email, address and
instructor name are all `null` and the screen prints *"Add school contact
information"* where each belongs.

**PWA.** Manifest, four generated icons (192, 512, maskable 512, apple-touch
180) plus an SVG, standalone, portrait, theme colour, Apple metadata, three
shortcuts, and a service worker that is cache-first for hashed assets and
network-first for everything else.

## Known decisions worth not reversing by accident

**No back-dating a practice.** A logged practice is a record that it happened.
Letting a child tick Tuesday on Thursday would make the streak, the weekly
count and the parent's summary all assert something nobody did. A past day
reports what the record says and offers nothing.

**Growth is a word, never a percentage.** The app does not measure a child's
confidence, so a figure would be a precision claim it cannot support. Each
reading states the activity it counted.

**Badges are settled silently on load.** Awarding is correct; celebrating is
not, because nobody just did anything.

**Nothing about the school is invented.** A test fails if a phone-shaped or
address-shaped string appears anywhere in `src/`.

**`utils/storage.ts` is the only file touching `localStorage`**, with a test
that fails if a second appears. That is what makes the backend swap three
functions rather than every screen.

## Known issues and limitations

None are blocking; all are deliberate scope.

1. **The live preview cannot be installed.** It is a single-file build, and the
   manifest and service worker need sibling files. Add-to-Home-Screen and
   offline use work on a real Pages deploy, not on the preview.
2. **No video.** The Watch the Demo step says a video is coming rather than
   showing a play button that does nothing.
3. **One student per device.** Multi-child support needs a profile switcher and
   keyed storage.
4. **The belt ladder and class schedule are demo data**, labelled as such.
5. **The PIN is not security**, and the app says so on the screen.
6. **The three audits are not in `npm test`** because they need a built app and
   a browser. They are `npm run audit`.
7. **Attendance is entered by hand** in Instructor Demo; there is no roster.

## Recommended next task

**Get it into its own repository and deployed** — the three steps above. That
is the only thing standing between the current state and a link Corey can send
to families, and it needs no code.

After that, in order of value:

1. **Replace the demo belt curriculum with the school's real one**
   (`src/data/belts.ts` and the `beltId` on each lesson). This is the biggest
   gap between "impressive demo" and "usable by the dojo".
2. **Add the school's contact details** to `DEFAULT_DOJO` in
   `src/data/defaultState.ts`. Five nulls, five minutes.
3. **Wire real demo videos** into the Watch the Demo step — the lesson data
   already has a place for it and the UI already says one is coming.
4. **A second student profile**, if the demo is shown to a family with two
   children.

## What Corey still needs to supply

Nothing below has been invented; the app shows a visible gap wherever one is
missing.

1. **Logo artwork** — the wordmark is set in type; the icon is a generated
   Blue Ridge mountain mark.
2. **Phone, website, email and street address.**
3. **Instructor names**, for the Parent Mode note attribution.
4. **The real class schedule** — Thursday 6–7 PM is demo data.
5. **The real belt curriculum and promotion criteria.**
6. **Demonstration videos**, one per lesson.
7. **An instructor's review of the lesson content**, checked against what the
   school actually teaches at each rank.
8. **A photograph policy decision** — the app currently uses generated avatars
   and holds no images of children.

## How to pick this up

```bash
cd blue-ridge-martial-arts-kids-app
npm install
npm run dev            # http://localhost:5173

npm run verify         # typecheck + lint + test + build
npm run build && npm run preview &
npm run audit          # UI, accessibility and runtime sweeps
```

`PROJECT_STATUS.md` tracks the checkpoints. `README.md` explains the
architecture and the reasoning behind it.
