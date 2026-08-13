# NEXT — session continuation state (INTERNAL)

**Purpose:** a fresh Claude Code session starts here. CLAUDE.md loads
automatically and carries the standing procedures (rebase dance after every
squash merge, portal-setup dispatch after schema changes, Actions-listing
overflow pattern, guard tests). This file is the live queue and in-flight
state. Update it when the queue moves; keep it short.

Snapshot date: 2026-08-13. Branch: `claude/app-crashes-lockups-debug-jcy6kf`.
Master is green through PR #41. Suites at last green: worker 598, portal
e2e 367 (intake 130, alerts 41).

## The queue, in the owner's order

1. **UIBUILD.md — streamlined UI, phases 2–8, in order.** Phase 1 is DONE
   and shipping as one PR (see below). Phase 2 (case detail: Back to
   Cases; four-section tabs; new Overview; package progress; Next Step
   card; recent activity; evidence overview) is next.
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

The dashboard e2e timeout is fixed and Phase 1 is green. The recorded
lead (pkgCard throwing on the hostile row) was wrong: `pkgCard` renders
the hostile row fine — everything passes through esc(), and a consumer
case always carries a retainer object (`authorizationFor` defaults to
`PERSONAL.retainer`), so no null-call. The actual bug: `loadPackages()`
was only called from the **tab-click** handler, but an admin **lands** on
the dashboard via `render()` (the BOOTED branch), which never fetched
`/packages` — PKGS stayed null and dashView painted "Loading…" forever.
Fix: `render()` now awaits `loadPackages()` when an admin is on the
dashboard with no PKGS loaded; logout also resets PKGS. Second fix, in
the harness: an uncaught Playwright timeout used to kill the run before
the report printed (which is why the page-error FAIL line was never
seen); test-portal.mjs now prints the accumulated report on
uncaughtException/unhandledRejection, so a future crash still names what
it saw. Suites: worker 598, portal 367 (+10 for Phase 1), intake 130,
alerts 41 — all green. Shipping Phase 1 as one PR (no schema change — no
portal-setup dispatch).

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
