# NEXT — session continuation state (INTERNAL)

**Purpose:** a fresh Claude Code session starts here. CLAUDE.md loads
automatically and carries the standing procedures (rebase dance after every
squash merge, portal-setup dispatch after schema changes, Actions-listing
overflow pattern, guard tests). This file is the live queue and in-flight
state. Update it when the queue moves; keep it short.

Snapshot date: 2026-08-13. Branch: `claude/app-crashes-lockups-debug-jcy6kf`.
Master is green through PR #44 (UIBUILD Phase 3). Suites at last green:
worker 610, portal e2e 439 (intake 130, alerts 41).

## The queue, in the owner's order

1. **UIBUILD.md — streamlined UI, phases 5–8, in order.** Phases 1–4 are
   DONE (ledger in UIBUILD.md has the details). Phase 5 (Case Build:
   summary steps; contents; Dropbox delivery status/link; preview;
   finalize; completed view — P13/P14 polish over the existing Package
   tab) is next.
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

**Phase 1 shipped as PR #42, Phase 2 as PR #43** (both squash-merged,
deploys green, branch reset onto master each time). The Phase-1 e2e
timeout's recorded lead (pkgCard/hostile row) was wrong — the real bug
was that nothing fetched `/packages` on the dashboard LANDING; the
same landing-vs-click class of bug was then found and fixed twice more
(openCase straight to the package tab, and the e2e harness now prints
its report on an uncaught exception instead of dying silently).

**Phase 3 shipped as PR #44** (deploy green). **Phase 4 is built and
green on the branch** (P11 report preview screen with the submitted-
version snapshot — `report_versions` is a SCHEMA CHANGE, so dispatch
portal-setup after the merge; P12 evidence gallery with type tabs and
thumbnails; overview thumbnails; quick-fold evidence linking via the
new POST /evidence/:id/link). Ship as one PR, dispatch portal-setup,
then start Phase 5.

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
