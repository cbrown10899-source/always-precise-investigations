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

**Known failing state + the debug lead (instrumented 2026-08-13):**
`/packages` responds 200 in the e2e, and the FIRST row is the stored-XSS
regression's hostile case (`case_no: x'); window.__pwned = true; ('`,
client `<img src=x onerror=…>`). The dashboard e2e still times out on
`.pcard` — the likeliest cause is one card's template throwing mid-map
(one bad row kills the whole innerHTML paint). Next move: run the e2e and
grep the output for `no page errors (` — the page-error listener records
the actual JS exception as a FAIL line naming it. Check `pkgCard` against
that row (everything user-sourced must pass through esc(); verify no
null-call like `.toLocaleString()` on a field the hostile row leaves
odd). Also consider excluding nothing — the hostile row is a legitimate
test of exactly this surface, so the fix belongs in `pkgCard`, never in
filtering the row out. Everything else in both suites passed. Ship Phase
1 as one PR when green (no schema change — no portal-setup dispatch).

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
- The owner may hold FURTHER ChatGPT handoffs not yet pasted into any
  session. Everything pasted so far IS recorded here (RATESHEETS,
  INVOICING, CASEBUILD, INTAKE-NA, UXSIMPLIFY, UIBUILD, SURVEILLANCE).
  Anything still only in ChatGPT: ask the owner to paste it, record it to
  case-portal/ first, then build in their stated order.
