# Always Precise Redesign — Session Checkpoint

Internal working file. `docs/` matches no line of `.github/deploy-manifest.txt`,
so this file is never published (the deploy suite also refuses every `.md`).

Last updated: 2026-10-10
Feature branch: `claude/app-crashes-lockups-debug-psf6zd` (restarted from master at `daa7b54`)
Last commit: see `git log -1` on the branch (the commit carrying this text)
Production deploy trigger verified: YES — see "Production safety" below
Production unchanged (yes/no/unknown): YES — nothing merged, nothing dispatched

## Production safety (verified 2026-10-10, before any edit)

- Every push-triggered workflow is `branches: [master]` only: `deploy.yml`,
  `deploy-worker.yml`, `deploy-portal.yml`, `build-locations.yml`,
  `save-point.yml`. A push to this branch triggers nothing.
- The site deploys by Direct Upload (`wrangler pages deploy _site
  --project-name=always-precise --branch=main`). A Direct Upload Pages project
  has no Git integration, so Cloudflare builds no branch previews either.
- **The one hazard:** `deploy.yml` has `workflow_dispatch`, and dispatching it
  FROM THIS BRANCH would upload this branch as production (`--branch=main`).
  Never dispatch `deploy.yml` (or anything else) from this branch.
- **Release lock:** `deploy.yml` runs `node .github/test-deploy.mjs` before it
  uploads, and `build-locations.yml` deploys only by dispatching `deploy.yml` on
  master. The deploy suite carries a RELEASE GATE that fails while either
  approved photograph is missing or any development placeholder remains in the
  staged site — so even an early merge cannot publish placeholders.
- Never touched: production env vars, D1 data, DNS, Workers, Cloudflare settings.

## Completed
- [x] Repository and deployment inspection
- [x] Isolated feature branch
- [x] Homepage layout (b7e4310)
- [x] Public navigation — one header/footer for all 15 public pages, written by
      build-locations.py (857a57d)
- [x] Existing intake preselection — the owner's three-answer question on the
      existing service field (2c8fd19)
- [ ] Child Custody final photo installed — BLOCKED: not supplied
- [ ] Spouse / Relationship final photo installed — BLOCKED: not supplied
- [x] Secondary Insurance and Legal cards
- [x] Sticky mobile actions (business pages open their own door)
- [x] Analytics integration (beacon + Worker vocabulary; Worker tests)
- [x] Accessibility and responsive checks — automated in the intake suite
      (320/360/390/430/768/1024/1280; 44px targets, tab order, gold focus,
      painted-pixel contrast, no sideways scroll) — PASSING
- [ ] Automated tests — all PASS except the portal suite (not completed) and
      the three RELEASE GATE checks (fail by design) — see "Tests run"
- [ ] Mobile screenshots
- [ ] Desktop screenshots

## Discovery facts (from the repository, not assumed)

- Verified business phone: **(434) 907-0975**, `tel:+14349070975` — the
  homepage's existing links and its structured data both carry it.
- Email: AlwaysPreciseInvestigations@gmail.com (existing).
- Existing intake: `/intake/`, one page, three doors: `?assignment=private`,
  `?assignment=legal`, `?assignment=insurance`; bare `/intake/` offers all.
- Private preselection already exists: `?service=<key>` opens the picker on a
  private service (`PRIVATE_SVC_PARAM`, keys derived from `FEES` minus billed).
- Private service keys in `FEES`: `surveillance`, `custody` ("Child Custody"),
  `process`. **There is no spouse / relationship / infidelity category** in the
  public form or in the portal's own private picker.
- Live Visitors: `beacon.js` classifies an intake link by its address
  (`assignment`, `service`) into a CTA key; the Worker
  (`visitor-alerts/worker.js`, `CTA`, `INTAKE_SERVICE`, `SERVICE_LABEL`) owns
  the vocabulary. Calls are `tel:` links (action `call`).
- Legal-type notice to preserve: the homepage's "We do not take cyber-stalking
  cases …" bar. Footer: DCJS #11-9159, Privacy Policy.

## Decisions taken (each one reversible; owner to confirm at review)

- R1 (SUPERSEDED by the owner's intake clarification, 2026-10-10) The private
  door's service step IS the owner's question, "What type of private
  investigation do you need?": Child Custody / Spouse / Relationship / Other
  Private Investigation, extending the existing `FEES` service field. Two
  judgement calls for the owner: **Surveillance is folded into Other** (an old
  `?service=surveillance` link opens on Other), and **Process Serving is kept as
  a fourth answer** because it is an existing paid private service the form
  already sold. Stored in `submissions.service` as "Spouse / Relationship" /
  "Other Private Investigation"; the portal's Intakes card and intake summary
  show "Investigation type".
- R2 Hero "Fill Out Online Intake" and the sticky "Online Intake" open the
  private door (`/intake/?assignment=private`): the page is private-client-first,
  and Insurance and Legal keep their own doors on their cards.
- R3 The Insurance and Legal cards say "View Services →" to their pages (owner
  copy) and keep a second, smaller "Submit an assignment" link to their own door,
  so the 2026-09-24 decision that the homepage reaches the carrier door directly
  still holds.
- R4 The brief's sections come first, in its order. The existing homepage content
  that carries SEO and trust (other services, reviews, about, service areas,
  contact) is kept below How It Works, restyled — not deleted.

- R5 Logo: the owner's diamond `assets/logo-white.webp`, unchanged (SHA-256
  b6ad9122…159eb, identical to its restore commit bdd4a83), height-only sizing.
  **Discrepancy for the owner:** master's headers currently show the SCALES
  lockup `assets/logo-lockup.svg` (since 2026-08-02), so "unchanged from
  production" and "the diamond logo" cannot both be literally true. The
  redesign follows the owner's explicit instruction (the diamond); the live site
  could not be fetched from this container (proxy 403) to compare.
- R6 One header and footer: `build-locations.py` (`site_header`, `site_footer`)
  is the one writer; generated pages are composed from it and hand-written pages
  carry the same bytes, held by a deploy guard. Header nav is the brief's six;
  Insurance and Legal are reached from "Other Investigation Services", the footer
  and their cards (the 2026-09-24 "Insurance in the homepage nav" pin is re-aimed
  to the footer nav — owner to confirm).
- R7 The phone bar's intake opens each page's own door: Legal → legal door,
  Insurance and Vendor → carrier door, all consumer pages → private door.

## In progress
- Nothing running. Session paused at the owner's request (usage limit),
  2026-10-10, with every change committed and pushed.

## Blockers
- **The two photographs are not in the package** (`assets/ASSETS_REQUIRED.md`
  says so). Needed: `assets/child-custody-photo.webp`,
  `assets/spouse-relationship-photo.webp`, owner-approved, commercially usable.
  Until they are installed the build is NOT READY and the release gate fails.

## Tests run (final, this session)
- `.github/test-deploy.mjs`: **190 passed, 3 failed**. The 3 are the RELEASE
  GATE checks (both photographs missing, placeholders present). They fail by
  design: this is what stops deploy.yml.
- `intake/test-intake.mjs`: **948 passed, 0 failed** (was 934 before).
- `visitor-alerts/test-worker.mjs`: **217 passed, 0 failed** (was 210 before).
- `watch/test-watch.mjs`: **74 passed, 0 failed**.
- `portal/test-portal.mjs`: **NOT COMPLETED — UNVERIFIED.** It was started
  after the last change and was progressing (234 sections reached, about 20
  minutes in). It prints results only at the end, and it was stopped at the
  owner's request, so there is no pass/fail result. `portal/index.html` changed
  (display of "Investigation type"), and a new section tests it. Run it first
  next session.
- Deploy-guard mutations, run in a worktree: **13 of 13 caught by name** (M12
  first walked past; the guard was fixed and M12 then failed by name).

## Files changed
- index.html, assets/site.css, .github/deploy-manifest.txt
- 404.html, privacy.html, child-custody-investigations/, infidelity-investigations/,
  legal-investigations/, insurance-investigations/ (+ vendor-information/)
- build-locations.py and its 7 generated pages (private-investigator/**)
- intake/index.html (private question), portal/index.html (display only),
  beacon.js, visitor-alerts/worker.js (vocabulary)
- tests: .github/test-deploy.mjs, intake/test-intake.mjs,
  visitor-alerts/test-worker.mjs, portal/test-portal.mjs

## Next actions (the next session, in order)
1. `git fetch origin claude/app-crashes-lockups-debug-psf6zd && git checkout
   claude/app-crashes-lockups-debug-psf6zd`. Read this file, then CLAUDE.md
   "The 2026-10-10 public redesign".
2. Run the portal suite ALONE, detached, output to a file:
   `nohup setsid node portal/test-portal.mjs > /tmp/portal.txt 2>&1 &`
   (about 35 minutes). Fix any failure the "Investigation type" line caused.
   Do not weaken assertions.
3. Take the review screenshots (local preview only:
   `python3 -m http.server 8090 --bind 127.0.0.1` from the repo root). Cover
   phone 320/390/430, tablet 768, desktop 1280/1440, plus the intake opened on
   Spouse / Relationship.
4. Give the owner the review report: screenshots, test results, this checklist.
   Readiness stays **NOT READY** until the photographs are installed.
5. When the owner supplies and approves the two photographs:
   add `assets/child-custody-photo.webp` and
   `assets/spouse-relationship-photo.webp` (realistic, gender-neutral; the
   custody one hands-only, the relationship one two empty chairs and two mugs),
   list both in `.github/deploy-manifest.txt`, delete the two
   `<span class="art-dev" data-dev-placeholder …>` badges in index.html, and
   re-run all suites (the painted-pixel contrast checks then measure the real
   photos). The release gate then passes.
6. **Only after the owner writes "GO LIVE":** open a PR, merge, and verify the
   deploy (`/.well-known/build.txt` SHA). Never dispatch deploy.yml from the
   branch.

## Open questions for the owner (decide at review)
- Logo: the redesign uses the diamond `logo-white.webp`, unchanged, as
  instructed. The headers on master (therefore probably on the live site) show
  the SCALES lockup `logo-lockup.svg`. Which one is "the logo on my live
  website"? Switching is one line in `build-locations.py` (`site_header`),
  copied to the pages, plus the deploy guard's pinned tag.
- Process Serving kept as a 4th answer; Surveillance folded into "Other".
- The new H1 replaces the local-SEO headline (title, meta and JSON-LD unchanged).
- Header nav has no Insurance or Legal link (brief's six); they are reached via
  "Other Investigation Services", the cards and the footer.
- Insurance and Legal blocks keep a direct "Submit…" link beside "View Services".

## Owner approval
Final photo approval: NOT YET RECEIVED
Release approval: NOT YET RECEIVED
Production launch: PROHIBITED UNTIL EXPLICIT "GO LIVE"

## Notes
Never mark the build ready while final images or critical tests are missing.
