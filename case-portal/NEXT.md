# NEXT — session continuation state (INTERNAL)

**Purpose:** a fresh Claude Code session starts here. CLAUDE.md loads
automatically and carries the standing procedures (rebase dance after every
squash merge, portal-setup dispatch after schema changes, Actions-listing
overflow pattern, guard tests). This file is the live queue and in-flight
state. Update it when the queue moves; keep it short.

**`MASTER-HANDOFF.md` next to this file is the owner's consolidated source of
truth** (recorded verbatim 2026-08-13). It supersedes nothing already shipped —
its section 1 lists the shipped baseline and says explicitly: do not rebuild it.
Read it for anything this file summarises.

Snapshot date: 2026-08-14. Branch: `claude/app-crashes-lockups-debug-psf6zd`.
Master is green through PR #55 (`13432f8` — deploy, portal Worker, save-point
and the portal-setup schema apply all came back success). Suites at last
green: worker 699, portal e2e 607, intake 186, alerts 41.

## The queue, in the owner's order (MASTER-HANDOFF §42)

1. ~~**INTAKE-NA.md**~~ — **COMPLETE**, all twelve steps (ledger in that
   file). Two deliberate non-builds recorded there: "request more
   information" opens the Comm log rather than sending an automated email
   (no email infrastructure yet, and the Comm log already IS that record),
   and `not_applicable` exists in the model but no field offers it,
   because nothing on either form is meaningfully N/A rather than unknown.
2. ~~**SURVEILLANCE.md**~~ — **phases 1–8 done**, 9 partly (ledger in that
   file). Two things are genuinely outstanding and both need a human or an
   asset, not code: **real iPhone Safari / Android Chrome testing** (the
   camera picker and the phone's own dictation cannot be covered headlessly),
   (the icon arrived 2026-08-14 and is in; the owner's first real phone
   session on 2026-08-14 found and fixed four things — the phone had no
   navigation at all, the first home-screen launch missed the field, the
   timer was too big, and there was no way back inside the mode). A mobile
   draft-preview *reader* inside the mode is the one nice-to-have left; the
   submit path already works through the full report screen.
3. Dropbox video delivery — **BLOCKED on the owner**: needs DROPBOX_APP_KEY /
   DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN as Worker secrets, plus a fresh
   read of the API docs. Nothing in the codebase waits on it; the provider
   reports not-configured and blocks nothing.
4. ~~**Case Build gap audit**~~ — **COMPLETE** (ledger in `CASEBUILD.md`,
   rules in CLAUDE.md under "The client package"). All of §13 closed:
   multi-day packages via `build_reports` (a three-day case used to ship its
   third day alone), the derived-plus-written Combined Summary, the Custom
   package type as a marker rather than a CHECK-constraint change, and a
   document that opens with case information and the assignment objective.
5. ~~**Invoice / BILL gap audit**~~ — **COMPLETE** (ledger in `INVOICING.md`,
   rules in CLAUDE.md under "Invoices"). Phases 1–4 held up under §28: every
   general field, the whole provider-neutral set (`external_payment_id` lives
   on `invoice_payments`, where a payment id belongs), and `overdue` already
   derived rather than stored. Two gaps closed — Special Instructions on the
   carrier side, and the private Retainer / Applied / Additional Authorization
   / Balance block. **Write-Off was left alone on purpose**: §28 says "if
   needed later", and it needs a CHECK change on `invoices.status`.
6. Public website / SEO. **Social Media Search is already removed** (§30):
   it existed only on the insurance page — a service card, the FAQ, and,
   more quietly, the JSON-LD offer catalogue and FAQPage — and is now
   "Background & Public-Record Research" in all four, with a guard test
   over every public page and the sitemap so it cannot creep back.
   Background research stays, as the owner asked. The rest of §29 (hero,
   two client paths, homepage order, meta/canonical audit) is untouched.
7. Full insurance workflow audit, end to end (MASTER §38).
8. Full private workflow audit, end to end (MASTER §39).
9. Final responsive / accessibility / security pass.

## Gaps the master handoff surfaced that no per-feature ledger holds yet

Record these here so they cannot be lost between phases:

- ~~**Requested vs Confirmed authorization**~~ — **done.** The intake's own
  hours read "Requested authorization"; the office's figure on the
  Authorization panel reads "Confirmed authorization", and only that one is
  ever paired with money. Tests hold both labels.
- **Lead statuses are not case statuses** (MASTER §5): Lead · Rate Sheet Sent ·
  Intake Sent · Intake Received · Contacted · More Info Requested · Converted
  to Case · Declined · Closed Lead. The Phase-6 leads desk currently reuses
  case stages.
- **Completed Cases path** (MASTER §31) — an obvious route to the final report,
  evidence index, client package, video link and invoice.
- **"Allow investigator to view client identity"** as an explicit admin
  permission, default No, enforced server-side (MASTER §33).
- Sidebar targets not yet built: Clients, Reports, Evidence, Expenses, Tasks
  as top-level nav (MASTER §8). Only build one when it has a real destination.
- More quick-activity lines + Surveillance/End Day categories (MASTER §10).

## In flight right now

Nothing. Item 3 (Dropbox) stays **blocked on the owner's Worker secrets**, so
the first unblocked work is item 6, the rest of the public website / SEO work
in MASTER §29 — hero, the two client paths, homepage order, and a meta and
canonical audit. (Social Media Search, §30, is already removed and guarded.)
`node portal/screenshots.mjs` photographs 37 screens against the real stack
whenever a visual check is wanted.

One rule learned in item 4 and worth not re-learning: **a CHECK constraint
cannot be widened from `schema.sql`.** SQLite needs a table rebuild for that,
`schema.sql` is re-applied on every portal-setup run, and editing the
constraint in place would leave fresh databases accepting a value the live one
refuses — green tests, broken production. Use a side table, the way
`build_custom` and `activity_removed` do.

Two owner decisions from 2026-08-14 that changed earlier rules, recorded in
CLAUDE.md and worth not re-litigating:

- **Evidence is client-deliverable on upload.** The firm shoots its own
  footage and writes its own reports; nothing waits behind a review it would
  only give itself. Holding something back is now the deliberate act
  (Needs redaction / Internal only / Do not use), and the Case Build gate
  still refuses those.
- **An entry can be removed, but never erased.** `activity_removed` stamps
  who and when; the row survives, the report skips it, and it can be put
  back. The old "no delete route" rule survives in substance.

## How to resume in a fresh session

1. `git fetch origin && git checkout claude/app-crashes-lockups-debug-jcy6kf`
2. Read this file, then `MASTER-HANDOFF.md`, then the ledger of whichever
   handoff is at the head of the queue.
3. Run the suites first: `node case-portal/test-worker.mjs`,
   `node portal/test-portal.mjs`, `node intake/test-intake.mjs`,
   `node visitor-alerts/test-worker.mjs`.
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
- Everything the owner has pasted so far IS recorded here: RATESHEETS,
  INVOICING, CASEBUILD, INTAKE-NA, UXSIMPLIFY, UIBUILD, SURVEILLANCE, and
  now MASTER-HANDOFF. Anything still only in ChatGPT: ask them to paste it,
  record it to case-portal/ first, then build in their stated order.
- Do not reintroduce a "landing vs click" load bug: any view that can be
  landed on directly must fetch what a later tab click would have fetched.
  That class of bug cost this session three fixes (MASTER §1).
