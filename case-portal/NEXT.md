# NEXT — session continuation state (INTERNAL)

**Purpose:** a fresh Claude Code session starts here. CLAUDE.md loads
automatically and carries the standing procedures (rebase dance after every
squash merge, portal-setup dispatch after schema changes, Actions-listing
overflow pattern, guard tests). This file is the live queue and in-flight
state. Update it when the queue moves; keep it short.

Snapshot date: 2026-08-13. Branch: `claude/app-crashes-lockups-debug-jcy6kf`.
Master is green through PR #41. Suites at last green: worker 598, portal
e2e 357 (intake 130, alerts 41).

## The queue, in the owner's order

1. **UIBUILD.md — streamlined UI, phases 1–8.** Phase 1 is IN FLIGHT on the
   branch (see below). Then phases 2–8 in order.
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

## In flight on the branch (uncommitted → now committed as WIP)

UIBUILD Phase 1: sidebar navigation (the `.tabs` row restyled as a fixed
left rail on desktop, burger drawer on mobile), admin Dashboard tab
(landing view: summary cards + Outstanding + Case Package cards with
progress rings and one computed Next Step), Worker `GET /packages`
(admin-only, per-active-case module states + outstanding total),
`pkgProgress`/`pkgNextStep` as the centralized logic (UIBUILD P24).

**Known failing state:** the new dashboard e2e section times out at
`.pcard` with text `API-20260812-4001` — zero cards rendered, so
`/packages` or `dashView()` fails at runtime in the e2e context (worker
suite passes; the endpoint is unit-green). Debug next: add a temporary
`console.error` of the `/packages` response (or check `LOAD_ERR`) in the
e2e, or curl the mounted server during the run. Everything else in both
suites passed at last run. Fix, then ship as one PR (no schema change in
Phase 1 — no portal-setup dispatch needed).

## How to resume in a fresh session

1. `git fetch origin && git checkout claude/app-crashes-lockups-debug-jcy6kf`
2. Read this file, then the ledger of whichever handoff is at the head of
   the queue.
3. Run the suites first: `node case-portal/test-worker.mjs` and
   `node portal/test-portal.mjs` — fix the dashboard e2e, ship Phase 1,
   continue down the queue.
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
