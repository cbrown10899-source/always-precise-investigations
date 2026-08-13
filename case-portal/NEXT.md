# NEXT — session continuation state (INTERNAL)

**Purpose:** a fresh Claude Code session starts here. CLAUDE.md loads
automatically and carries the standing procedures (rebase dance after every
squash merge, portal-setup dispatch after schema changes, Actions-listing
overflow pattern, guard tests). This file is the live queue and in-flight
state. Update it when the queue moves; keep it short.

Snapshot date: 2026-08-13. Branch: `claude/app-crashes-lockups-debug-jcy6kf`.
Master is green through PR #42 (UIBUILD Phase 1). Suites at last green:
worker 601, portal e2e 393 (intake 130, alerts 41).

## The queue, in the owner's order

1. **UIBUILD.md — streamlined UI, phases 3–8, in order.** Phases 1 and 2
   are DONE (ledger in UIBUILD.md has the details). Phase 3 (field
   activity: Add Activity modal; Quick/Custom; searchable actions;
   favorites; structured templates; More Details fold; clean timeline;
   sticky mobile add) is next.
2. **INTAKE-NA.md — intake "not available" states** (owner: after the UI
   work).
3. **SURVEILLANCE.md — Active Surveillance Mode** (owner: after the shared
   model is stable; PWA-ready; a VIEW of the existing case, never a
   separate database).
4. Deliberately later: Dropbox live integration (needs the owner's Dropbox
   app secrets — DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN
   as Worker secrets, plus a fresh read of Dropbox's current API docs);
   BILL live API; Phase-4 futures (client portal, redaction workflow,
   field safety, profitability).

## Just resolved (2026-08-13, this session)

**Phase 1 shipped as PR #42** (squash-merged; branch reset onto master).
The dashboard e2e timeout's recorded lead (pkgCard throwing on the
hostile row) was wrong — the actual bug was that nothing fetched
`/packages` on the admin's dashboard LANDING (`render()`'s BOOTED
branch); only the tab click did. Fixed in `render()`; logout resets
PKGS; the same landing-vs-click bug was then found and fixed for the
dashboard's Build jump (`openCase` straight to the package tab now
loads the build). The e2e harness also prints its report on an
uncaught exception now, instead of dying silently on a Playwright
timeout.

**Phase 2 is built and green on the branch** (case detail: P5 header,
P6 four sections with WS_TAB-derived section state, P7 admin overview
reusing pkgProgress/pkgNextStep, Billing & closing under Admin,
workspace carries build_status/invoice_status admin-only). Ship it as
one PR (no schema change — no portal-setup dispatch), then start
Phase 3.

## How to resume in a fresh session

1. `git fetch origin && git checkout claude/app-crashes-lockups-debug-jcy6kf`
2. Read this file, then the ledger of whichever handoff is at the head of
   the queue.
3. Run the suites first: `node case-portal/test-worker.mjs` and
   `node portal/test-portal.mjs` — then continue down the queue (UIBUILD
   Phase 2 is the head).
4. Per-feature rhythm (unchanged all session): build → tests green → ledger
   + CLAUDE.md counts → commit/push → PR → squash-merge → rebase dance →
   portal-setup dispatch only when schema.sql changed.

## Owner context worth carrying

- Free-plan failsafe is live and non-negotiable (Worker refuses uploads at
  9 GB; site-health opens an issue at 75%; Cloudflare Budget Alert is the
  independent net). Do not raise caps without the owner.
- Two rate sheets are separate products; carrier pricing never public; no
  dollar figure in portal or intake HTML (guard tests enforce).
- Investigator boundary: FIELD_KEEP allow-list; money/client identity
  never reaches investigators; offers stay thin pre-acceptance.
- The owner works from phone + desktop, sends handoffs mid-build, and
  wants every handoff RECORDED VERBATIM in case-portal/ before building —
  that rule already survived two near-losses this session.
- The owner may hold FURTHER ChatGPT handoffs not yet pasted into any
  session. Everything pasted so far IS recorded here (RATESHEETS,
  INVOICING, CASEBUILD, INTAKE-NA, UXSIMPLIFY, UIBUILD, SURVEILLANCE).
  Anything still only in ChatGPT: ask the owner to paste it, record it to
  case-portal/ first, then build in their stated order.
