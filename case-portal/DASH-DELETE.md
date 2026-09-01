# Dashboard delete controls — New Intakes and Recent Activity

## Owner brief (verbatim, 2026-08-24)

> Update the Always Precise Investigations portal dashboard.
>
> Add a quick, clearly visible delete control in these 2 places:
>
> 1. NEW INTAKES
> - Add a small red outlined trash icon/Delete button on each individual New
>   Intake entry.
> - Keep it visible without opening another menu.
> - Make it easy to tap on desktop, iPad, and phone.
> - Require confirmation before deleting:
>   "Delete intake for [Client Name]? This cannot be undone."
> - Delete ONLY the selected intake and data that belongs directly to that
>   intake.
> - Never delete unrelated client records, other cases, payments, files, or
>   activity.
> - If the intake has already become a real active case with important
>   dependent records, do not blindly cascade-delete it. Detect that condition
>   and require the safer existing case/archive workflow instead.
>
> 2. RECENT ACTIVITY
> - Add a small red outlined trash icon/Delete button at the far right of each
>   Recent Activity row.
> - Require confirmation naming the activity before removal.
> - Determine how Recent Activity is generated before changing the backend.
> - If these entries are only dashboard/feed records, delete the selected
>   entry normally.
> - If they come from the permanent audit trail, DO NOT destroy immutable
>   audit-history records. Instead add a safe "hide/remove from dashboard
>   feed" mechanism while preserving the underlying audit record.
>
> UI: match the existing portal styling; red only for the destructive control;
> compact but easy to see; no wrapping, overlap, or layout shifts; mobile
> clean. Before coding, inspect the existing routes, database relationships,
> delete/archive behavior, and audit-trail rules so this uses the existing
> architecture rather than creating duplicate systems. Do not change unrelated
> portal features. Stop before any destructive migration or risky schema
> change.

## What the audit established

**Recent Activity is a DERIVED VIEW, not a feed.** `recentActivity()` composes
its twelve rows at read time from six real sources — `submissions`,
`case_days`, `case_reports` (status), `case_evidence`, `retainer_payment`,
`build_events` — merged, sorted, cut. There are no feed rows to delete, and
the sources include money, reports and package events: the owner's own
non-deletables. So the brief's second branch applies: **a hide mechanism that
preserves every underlying record.** The rows carried no per-row identity
before this unit; each arm now also selects its source row's own `id`.

**A "New Intake entry" is a `submissions` row** on the Leads & Intakes desk
(`stage new / awaiting_client`), and the existing delete machinery is the
tombstone (`case_deleted`) — recoverable by design, which the dictated
confirmation wording ("This cannot be undone") cannot honestly describe. The
brief therefore defines a NARROWER, genuinely destructive act with a guard:
hard-delete is permitted ONLY while the intake owns nothing but itself.

## Derived decisions

**D1 — The quick delete is a hard delete, and the dependency guard is what
makes that compatible with the standing "no purge" decision.** The 2026-08-21
owner decision (Delete Case is a tombstone; a true purge is not needed) stands
untouched for CASES. This unit's quick delete refuses — 409, naming what it
found — the moment the intake has ANY dependent record, and points at the
existing case workflow. What it can ever destroy is the intake's own
paperwork: the submission row and its intake-time companions. The dictated
wording "This cannot be undone" is then TRUE, which is the standard every
screen here is held to.

**D2 — Every case-scoped table is classified, and a test enforces
completeness.** `INTAKE_OWNED` (deleted with the intake): `submissions`,
`legal_intake`, `lead_status`, `case_status`, `case_meta`, `case_retainer`,
`case_phone`, `case_profile`, `feed_hidden`. `INTAKE_BLOCKERS` (any row ⇒
409): days, activity, evidence, reports, invoices, builds, external files,
retainer money and receipts, send history, expenses, tasks, notes, comms,
subjects, offers, closure, retention records, content-removal records, case
details and settings, video stamps, storage failures, integrity records.
Children that cannot exist without a blocker parent (build items, invoice
lines, activity media, day pauses…) are blocked through their parents.
`alert_failure` is deliberately LEFT ALONE both ways: alert history is
non-deletable by the owner's own limits, and a failed alert about a duplicate
intake must not make the duplicate immortal. A test derives the case-scoped
list from `DEMO_SWEEP` and fails if any table is unclassified — the sweep
completeness pattern applied a second time.

**D3 — The route is `POST /cases/:no/intake-delete` so the chokepoint gates
apply unmodified.** It matches no carve-out, so a tombstoned case refuses it
(`case_deleted`, restore first) and an archived case refuses it
(`case_archived`) — "require the safer existing workflow" enforced by the
gate that already exists. A legal hold refuses by name before anything else
(Unit 17's rule: the hold outranks). Admin-only. Every DELETE statement is
filtered through `missingTables()` and the batch runs as one D1 transaction.

**D4 — Hiding a feed line writes a marker, never touches a source row.**
`feed_hidden (kind, ref_id, case_no, hidden_by, hidden_at)` — additive table,
no CHECK on `kind` (the Unit 7 rule), PRIMARY KEY (kind, ref_id) so a double
tap is idempotent. `POST /feed/hide` verifies the referenced row exists and
records whose case it was about. Each arm of `recentActivity()` excludes
hidden rows IN ITS SQL with NOT EXISTS — applied before the arm's LIMIT, so
hiding the ten newest lines of one kind surfaces older ones instead of
emptying the arm — and only when the table exists, mirroring the
`case_deleted` guard so a missing table degrades to an unfiltered feed rather
than a silently empty one.

**D5 — The confirmations say what is actually true.** The intake dialog is
the owner's wording verbatim, with the client's name. The feed dialog names
the activity line and says the underlying record is kept — hiding must not
masquerade as destruction any more than destruction may masquerade as hiding.

**D6 — One red outlined control, `.btn-del`, both places.** Outlined
`--bad`, transparent ground, inline SVG trash (stroke `currentColor`, so it
is exactly as red as the border — an emoji glyph carries its own colours and
ignores the palette), ≥44px tap target both axes, `aria-label` naming the
act. The Recent Activity row was ONE `<button>` for the whole row; a button
inside a button is invalid nesting (the Unit 40 lesson), so the row is now a
flex shell holding the original open-the-case button and the trash as
siblings — same painted layout, two tab stops for two actions.

**D7 — The feed's hide door needs `portal-setup` once.** Until the dispatch
runs, `/feed/hide` answers 503 naming the workflow, the feed itself keeps
working unfiltered, and intake-delete (which needs no new table) works
immediately — each statement in its batch already skips absent tables.

## What this unit deliberately does not do

No un-hide UI (the marker table keeps who/when, so support can recover it);
no delete on accepted/developed intakes (the tombstone workflow is the
answer, and the refusal says so); no changes to `/cases/:no/delete`,
archive, retention, or the sweep; no investigator-facing controls of any
kind — both routes are admin-only in the Worker, not merely undrawn.
