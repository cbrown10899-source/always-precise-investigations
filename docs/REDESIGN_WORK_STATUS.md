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
- [x] Child Custody final photo installed — owner-supplied 2026-10-11 (hands only)
- [x] Spouse / Relationship final photo installed — owner-supplied 2026-10-11
      (two empty chairs, two mugs)
- [x] Secondary Insurance and Legal cards
- [x] Sticky mobile actions (business pages open their own door)
- [x] Analytics integration (beacon + Worker vocabulary; Worker tests)
- [x] Accessibility and responsive checks — automated in the intake suite
      (320/360/390/430/768/1024/1280; 44px targets, tab order, gold focus,
      painted-pixel contrast, no sideways scroll) — PASSING
- [x] Automated tests — all PASS, release gate included — see "Tests run"
- [x] Mobile screenshots (with the final photographs)
- [x] Desktop screenshots (with the final photographs)

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
- Nothing running. Every change committed and pushed. Waiting for the owner's
  review.

## Blockers
- None in the build. What remains is the owner's review and, only then, the
  owner's written "GO LIVE".

## Photographs (third session, 2026-10-11)
- Supplied by the owner as one 1536x1024 composite. Split at the white divider
  (columns 762–772), each panel kept whole (760x1024 and 761x1024, ~3:4 — the
  card's own shape, so the cover crop takes about 6px), re-encoded as WebP q84
  with NO metadata (no EXIF, XMP or ICC chunk): child-custody-photo.webp 77 KB,
  spouse-relationship-photo.webp 58 KB. Listed in the deploy manifest; both
  `.art-dev` placeholder badges and their CSS removed.
- **The real photographs exposed a contrast defect the placeholder gradient
  hid.** On a phone the copy fills more of the card and rose to where the
  bottom gradient is thinnest. Measured over the real photographs before the
  fix: titles 2.8:1 (custody) and 2.4:1 (relationship) at 390px — the intake
  suite's own run caught both — and the gold kicker as low as 0.6:1. Fix: the
  copy block carries its own soft navy fade (transparent → 0.78 over 56px, 40px
  on phones). After: the weakest line on either card is 5.2:1 against the
  lightest pixel behind it, at every width 320–1280. 0.84 was also measured and
  passes; 0.78 was chosen because it keeps more of each photograph visible.
- The painted-pixel test now measures EVERY line of card copy (kicker, title,
  line, action) against its own colour, at 1280/1024/768/430/390/360/320, with
  the card centred instantly and the sticky header and phone bar hidden. It was
  title-only at two widths, which is how the kicker went unmeasured.
- Trade-off the owner should look at: on phones the fade covers the lower part
  of each photograph (the clasped hands and the mugs sit under the copy); the
  upper half of each photo stays clear. On desktop both subjects read fully.
- **Rights:** the photographs were supplied by the owner; please confirm at
  review that they are approved and commercially usable on the public site.

## Tests run (latest: third session, 2026-10-11, with the final photographs)
- `.github/test-deploy.mjs`: **194 passed, 0 failed** — the RELEASE GATE now
  passes because the photographs are real and no placeholder remains. The gate
  itself was not edited.
- `intake/test-intake.mjs`: **1,009 passed, 0 failed** (957 before; the 52 new
  checks are the per-line card contrast at seven widths).
- `portal/test-portal.mjs` (second session, `portal/` unchanged since):
  **5,202 passed, 0 failed** — run ALONE, detached,
  finished in ~38 min inside the 45-min limit. (The first run that session
  failed 3: all three were the new "Investigation type" test reading the wrong
  element — the card's first sub-line, and an uppercase label via innerText;
  the probes were fixed, the product was right, and the re-run is clean.)
- `visitor-alerts/test-worker.mjs`: **217 passed, 0 failed**.
- `watch/test-watch.mjs`: 74 passed, 0 failed (first session; nothing it
  covers changed since).
- Mutations: 13/13 deploy-guard mutations caught (first session) + 3/3 logo
  guard mutations caught (diamond back on a page, a changed byte, the badge
  removed).

## Consistency (second session)
All 15 public pages measured at 390 and 1280 (and 5 at 320): one identical
header and footer, the live scales logo at 205x58 on desktop (the live site's
exact size), 162x46 on phones; zero sideways scroll on every page (the vendor
table overflowed 16px at 320 and was fixed); the phone bar opens the legal door
on Legal and the carrier door on Insurance/Vendor; no page has a broken
resource (the two photographs load since 2026-10-11).

## Screenshots (third session: scratchpad `rd/final/`, with the photographs)
Homepage at 320/390/430/768/1280/1440, the phone menu, the cards, the intake on
Spouse / Relationship, and four other public pages. Sent to the owner.

## Screenshots (second session, local preview only)
Scratchpad `rd/out/` and `rd/review/`: homepage at 320/390/430/768/1280/1440,
the phone menu, the cards, the intake opened on Spouse / Relationship, and every
public page at 390 and 1280. Sent to the owner. Re-shoot after the photographs
are installed.

## Files changed
- index.html, assets/site.css, .github/deploy-manifest.txt
- 404.html, privacy.html, child-custody-investigations/, infidelity-investigations/,
  legal-investigations/, insurance-investigations/ (+ vendor-information/)
- build-locations.py and its 7 generated pages (private-investigator/**)
- intake/index.html (private question), portal/index.html (display only),
  beacon.js, visitor-alerts/worker.js (vocabulary)
- tests: .github/test-deploy.mjs, intake/test-intake.mjs,
  visitor-alerts/test-worker.mjs, portal/test-portal.mjs

## Owner decisions received (2026-10-10, after the pause)
- APPROVED: one shared Private Client Intake with Child Custody /
  Spouse / Relationship / Other Private Investigation.
- KEEP the release safeguards. The three RELEASE GATE checks must not be
  weakened, skipped or edited to pass while the photographs are missing.
- LOGO — DECIDED (owner, 2026-10-10, second session, from a side-by-side of
  the live header and the branch's diamond): **the scales-of-justice lockup**,
  `assets/logo-lockup.svg`, exactly as the live header shows it, in its white
  rounded badge (#fff, radius 12px, padding 9px 16px, the live shadow). File
  byte-identical to master `daa7b54`, SHA-256 c1c64244…942ccf, pinned by the
  deploy suite. Height 58px desktop (the live size), 46px phones, 38px at
  ≤360px; proportions always the file's own 240x68. Commit `dfaf2ec`.

## Next actions (remaining)
1. Owner review of the finished site with the photographs (screenshots sent).
   **Note: with the photographs in, the release gate no longer blocks a deploy
   — the only thing standing between this branch and production is that
   nothing is merged to master.** No PR exists; none will be opened before
   "GO LIVE".
2. Only after the owner writes "GO LIVE": open the PR, merge, verify the deploy
   (`/.well-known/build.txt` SHA). Never dispatch deploy.yml from the branch.
3. If a photograph is ever replaced: same filename, bump `?v=` in index.html,
   re-run the intake suite (the contrast checks measure the real pixels).

## Open questions for the owner (decide at review)
- Process Serving kept as a 4th answer; Surveillance folded into "Other".
- The new H1 replaces the local-SEO headline (title, meta and JSON-LD unchanged).
- Header nav has no Insurance or Legal link (brief's six); they are reached via
  "Other Investigation Services", the cards and the footer.
- Insurance and Legal blocks keep a direct "Submit…" link beside "View Services".

## Owner approval
Final photos: SUPPLIED by the owner 2026-10-11 and installed; owner to confirm
at review (including commercial usability)
Release approval: NOT YET RECEIVED
Production launch: PROHIBITED UNTIL EXPLICIT "GO LIVE"

## Notes
Never mark the build ready while final images or critical tests are missing.
