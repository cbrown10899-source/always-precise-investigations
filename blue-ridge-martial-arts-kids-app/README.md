# Blue Ridge Martial Arts — Kids App

A mobile-first practice companion for young martial artists at **Blue Ridge
Martial Arts, Forest, VA**. It helps a child practise safely at home during the
week and arrive at their next class prepared.

> **Discipline Today. Confidence Tomorrow.**

This is a **working demo**. It runs entirely in the browser, stores everything
on the device, and has no backend, no accounts and no payments.

---

## What it does

| Screen | What it is for |
| --- | --- |
| **Home** | The dashboard — today's practice, this week's progress, streak, badges, class-ready status and the week's focus. |
| **Lessons** | Eight lessons across Current Belt / Skills / Character, each a six-section player with a timer, a rep counter and a comprehension check. |
| **Practice** | The weekly plan (home / dojo / rest), the Get Ready for Class checklist with a readiness meter, and this week's mission. |
| **Guided Practice** | A full-screen, one-step-at-a-time session with timers, rep counters and Start / Pause / Next / Previous / Complete. |
| **Progress** | Belt journey, next goal, growth readings, attendance and the badge wall. |
| **More** | Profile, Parent Mode, Instructor Demo, schedule, dojo information, safety and settings. |

Completing a practice updates the streak, the weekly count, the growth
readings and any badges it unlocks — all derived from the record, never from a
stored counter.

## Stack

- **React 18** + **TypeScript** (strict)
- **Vite 5** — no framework beyond the router
- **react-router-dom** with **HashRouter** (so GitHub Pages refreshes work)
- **lucide-react** for icons
- **Vitest** + **Testing Library** for tests
- **Playwright** for the UI audit
- Plain CSS with a token layer — no UI framework, no CSS-in-JS runtime

Total production bundle: **~307 KB (~91 KB gzipped)**.

## Running it locally

```bash
npm install
npm run dev          # http://localhost:5173
```

Other scripts:

```bash
npm run typecheck    # tsc, strict, no emit
npm run lint         # eslint, zero warnings
npm test             # vitest, 101 checks
npm run build        # production build into dist/
npm run preview      # serve the production build
npm run verify       # typecheck + lint + test + build, in that order
```

### The UI audit

`scripts/audit-ui.mjs` drives a real Chromium over **every route at five
widths** (320 / 390 / 430 / 768 / 1200) and reports horizontal overflow, tap
targets under 44px, controls with no accessible name, inputs under 16px (which
make iOS zoom on focus) and any page error.

```bash
npm run build
npm run preview &          # must be on :4183
node scripts/audit-ui.mjs
```

It currently reports **0 problems across 5 widths × 14 routes**. It is not part
of `npm test` because it needs a built app and a browser; run it after any
layout change.

### Regenerating the app icons

```bash
node scripts/gen-icons.mjs
```

Draws the four PWA PNGs from the same shapes as `public/icons/icon.svg`, using
a dependency-free rasteriser and PNG encoder, so the SVG and the PNGs cannot
drift apart.

## Demo PIN

Parent Mode is behind a demo PIN:

```
1234
```

**This is DEMO ONLY.** The PIN is written into the source and displayed on the
unlock screen. It keeps a curious child out of the weekly summary and that is
all — it is not security, it protects no real data, and the app says so on the
screen. Instructor Demo has no gate at all and says that too.

## Tests

101 checks across five suites:

| Suite | Covers |
| --- | --- |
| `progress.test.ts` | Week boundaries, streaks (including a streak that is still alive and one that has broken), the weekly goal, readiness, lesson completion fractions, growth labels, session building. |
| `badges.test.ts` | Every badge's own stated requirement, that the catalogue and the rules agree in both directions, that nothing is earned by doing nothing, that a badge is never awarded twice and never taken away. |
| `storage.test.ts` | Round trips, unparseable JSON, a stored `null`, an array, a mismatched schema version, a blob missing a branch a later build added, a browser that refuses to write, reset, and that `utils/storage.ts` is the only file in `src/` touching `localStorage`. |
| `safety.test.ts` | Greps the whole lesson and practice library for sparring, chokes, joint locks, weapons, striking objects, full-force instructions and vulnerable targets — with **control tests** that plant a violation and prove the matcher catches it. Also that nothing about the school is invented. |
| `app.test.tsx` | The real journeys: completing a practice end to end and seeing the streak, badges and weekly count move; abandoning one and logging nothing; the checklist persisting and earning its badge; completing a lesson and resuming a half-finished one; Parent Mode's PIN; four separate Instructor Demo changes reaching the child's app; reset; the school card refusing to invent a detail; an unknown route. |

```bash
npm test
```

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` runs on every push to `main`/`master`:
typecheck → lint → test → build → deploy. It only deploys if all four pass.

The Vite `base` comes from the `BASE_PATH` environment variable, which the
workflow sets from the repository name — so a repository rename cannot silently
break every asset path.

**One manual step after the first push:** in the repository, go to
**Settings → Pages → Build and deployment** and set **Source** to
**GitHub Actions**. Until that is set, the workflow builds and the deploy step
has nowhere to publish to.

`.github/workflows/ci.yml` runs the same checks on pull requests without
deploying.

## Installing it as an app

The app is a PWA: web manifest, four generated icons (including a maskable
one), standalone display, theme colour, iOS status-bar configuration and a
service worker.

- **iPhone / iPad:** open in Safari → Share → **Add to Home Screen**
- **Android:** open in Chrome → menu → **Install app**
- **Desktop:** the install icon in the address bar

The service worker is deliberately conservative: **hashed build assets are
cache-first** (Vite content-hashes them, so a changed file is always a new
URL), and **everything else, the document included, is network-first**. A new
deploy is therefore picked up on the next online load rather than leaving the
installed app stuck on an old build.

## Architecture

```
src/
  app/        StoreProvider (the single write path), context, routing
  components/ Reusable pieces — masthead, nav, cards, belt art, badges, week strip
  screens/    One file per screen
  data/       Belts, skills, lessons, practice routines, badges, avatars, seed state
  hooks/      useApp, useCountdown, useToday
  types/      The whole domain model — no React imports
  utils/      storage, dates, progress, badges, service-worker registration
  styles/     tokens → base → components → features
  test/       Five suites plus shared fixtures
```

Four decisions hold it together:

**Data never imports React.** `src/data/` names an icon by a string key that
`components/Icon.tsx` resolves. That is what would let any of it be replaced by
an API response without touching a component.

**Everything shown is derived.** There is no stored streak, no stored practice
count, no stored badge progress. `utils/progress.ts` computes each figure from
the records, so a number can never drift from what actually happened.

**One write path.** `StoreProvider.update()` takes a recipe, applies it,
persists it, and awards badges — so "completing a practice updates the streak,
the badges and readiness" is true by construction rather than by every caller
remembering.

**`utils/storage.ts` is the only file that touches `localStorage`**, and there
is a test that fails if a second one appears.

### Replacing localStorage with a backend

`loadState()`, `saveState()` and `resetState()` are the whole persistence
surface. Swapping them for Supabase, Firebase or a REST API means making those
three async and adding a loading state to `StoreProvider` — no screen changes.
`AppState.schemaVersion` is already in place for migrations.

## What this demo deliberately does not do

- **No backend, no accounts, no child data leaves the device.** No analytics,
  no third-party requests, no telemetry.
- **No payments, no chat, no social features.**
- **No video.** The Watch the Demo step says a video is coming rather than
  showing a play button that does nothing.
- **No invented school details.** Phone, website, email, address and
  instructor name are all empty, and the app prints *"Add school contact
  information"* where each one belongs. A test fails if any source file grows a
  phone-shaped or address-shaped string.
- **No scores or percentages for a child's qualities.** Growth is reported as
  **Building / Improving / Strong / Excellent**, and each reading states the
  activity it counted. The app does not measure confidence, so it does not
  claim to.
- **No AI assessment of a child.** Parent notes are instructor-written and
  labelled as such.
- **The belt ladder is a demo progression** and says so. Belts are awarded by
  an instructor at the dojo.

## Safety

This is a children's app, so home practice is restricted to **solo, controlled
fundamentals in open space**: stance, guard, balance, controlled punches into
open space, controlled kicks, footwork, flexibility, coordination, etiquette
and focus.

Nothing teaches sparring, partner work, chokes, joint locks, weapons, throws,
striking household objects, or full-force technique. The Safety screen also
lists what belongs in class rather than at home, so a child knows the
difference instead of inferring it.

Four rules appear in the same words on every lesson and practice screen:

> Practise in a clear area. · Move slowly and stay in control. · Stop if
> something hurts. · Practise with a parent or instructor's permission.

`src/test/safety.test.ts` enforces this by grepping the whole library, with
control tests proving the matchers work.

## Accessibility

- 44px minimum on every control (48px design target), verified by the audit
  rather than declared
- 16px minimum on every input, so iOS does not zoom on focus
- One `<h1>` per screen, verified in the test suite
- A skip link that moves focus, not just the viewport
- `aria-current` on the active navigation item — never colour alone
- Completion always carries a tick or a word beside the colour; locked badges
  carry a padlock and say "Locked"
- Live regions for badge announcements and form errors
- Full keyboard operation with a visible focus ring on every control
- Honours `prefers-reduced-motion`, plus an in-app toggle for a child on a
  shared device who cannot change system settings
- A larger-text setting that scales the whole app

## Still needed from Blue Ridge Martial Arts

Nothing below has been invented — the app shows a clear gap wherever one of
these is missing.

1. **Logo artwork** — the wordmark is currently set in type, and the icon is a
   generated Blue Ridge mountain mark.
2. **Phone, website, email and street address** — `src/data/defaultState.ts`,
   `DEFAULT_DOJO`. All null.
3. **Instructor names** — for the note attribution in Parent Mode.
4. **The real class schedule** — the Thursday 6:00–7:00 PM class is demo data.
5. **The real belt curriculum** — the five-rung ladder is a placeholder, and
   the app labels it as one.
6. **Demonstration videos** — one per lesson, for the Watch the Demo step.
7. **Lesson content review by an instructor** — every drill should be checked
   against what the school actually teaches at each rank.
8. **A photograph policy decision** — the app currently uses generated avatars
   and holds no images of children.

## Licence

Private demo built for Blue Ridge Martial Arts. Not for redistribution.
