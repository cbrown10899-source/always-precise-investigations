# The CEO / Product-Operations Charter — owner briefs 2026-09-06

Four owner messages in one afternoon: the 18-mission charter, the per-user
personalization addendum, the clickable CEO Bot brief (22 sections), and the
model-routing instruction. This file is the durable record of what was DERIVED;
`CLOSEOUT-FINANCIAL.md` holds the closeout's own D-list and `CLAUDE.md` the
summaries.

## The business reality the charter states

Owner-operated; the owner and his brother work cases together; no employees
needing formal assignment; most retainers are flat-fee; the portal's value is
SPEED (link out → signed intake in → rate sheet → retainer documented → close
cleanly). Every screen answers: **"What does Corey actually need to do next?"**
Prefer HIDE / DE-EMPHASIZE / MOVE UNDER ADVANCED over deleting capability.

## Derived decisions

**C1 — The closeout confirm closes the case, without the checklist.** The
charter's own words: "A case must be closable even if [no work of any kind
occurred] … 'Case Ready' must NOT block 'Close Case'." This deliberately
overturns the checklist-as-only-door FOR THIS PATH (the 2026-08-21 decision
stands everywhere else: `setStatus` still refuses `closed`, and the checklist
remains the pre-close review for worked cases). Forcing "Field work completed"
ticks onto a no-work case would make the record assert things that did not
happen. A no-ticks case closes with its ticks honestly absent.

**C2 — The one blocker is a running investigation day** (the charter's own
carve-out), refused 409 naming who holds the clock.

**C3 — Requested is not completed** (Mission 9, verbatim). A `case_refund` row
is the record of a refund COMPLETED outside the portal; everything short of
that is a status word in `case_refund_status` (side table — `case_closeout` is
live and CREATE IF NOT EXISTS cannot widen it). A requested refund keeps the
money on the ledger, truthfully; `/closeout/refund-done` is the owner's
explicit completion and the second-and-last writer of a refund row.

**C4 — The statement wears the status.** "Refund issued" prints only over a
ledger row; "Refund requested" prints as requested; the settlement balance on
the DOCUMENT nets the refund as stated on its own line, so the client's page
adds up, while the API's `final_balance` stays ledger-true.

**C5 — Defaults preserve the shipped morning behavior.** A confirm with no
status and a positive refund defaults to `completed_external` — exactly what
the route recorded before the vocabulary existed, so no historical caller
changes meaning.

**C6 — "Close Michelle's case" prepares** (Mission 13). The close-case phrase
left `ASSISTANT_BLOCKED` for the closeout-preparation carve-out: answers from
the record, resolves a name through the office's own search (exactly-one
match; zero and several are said, never chosen), opens the panel, executes
nothing. A close combined with a send/refund/void still refuses.

**C7 — A closed case is not work** (Mission 11). The Out-now and Reports-due
summary arms had NO status filter for an admin — a case closed through the
no-work closeout stayed in "Reports due". Every alert arm now joins the case
and requires it open. Search, history, Closed lens, audit: untouched.

**C8 — An intake can end without a case** (Mission 12). Close/archive intake
from the intake screen, reason recorded as an admin NOTE (the record type the
case already has for the office's own words), archive is the EXISTING marker:
nothing deleted, restorable, signed submission preserved.

**C9 — Personal state is one row per user, keyed to the authenticated
identity** (the addendum). `user_pref.prefs` is a JSON blob under allow-listed
keys (`qt_order, hidden, dismissed, metrics, ceo, suggestion_state`), merge
rule /meta's (absent unchanged, null clears), capped by name. No path exists
by which one account's choice reaches another's screen — every read and write
binds `user.id`. Shared business data is exactly as shared as it was.

**C10 — The factory view hides what the charter calls noise, per user.**
`DEFAULT_HIDDEN = [needs_assignment, lead_status]` applies when a user has
stored nothing; any user can unhide either FOR THEMSELVES in Settings → My
Portal. The Worker's counts, the assignment panel and the lead-status routes
are untouched — this is presentation, not capability removal.

**C11 — Usage metrics are the user's own,** counted fire-and-forget through
`/me/prefs/use` (one bounded write, 80-key cap with oldest-out), feeding that
user's CEO Bot and nobody else's.

**C12 — Model routing.** The environment cannot switch models mid-session
(MANUAL SWITCH REQUIRED, reported). Everything ships on the primary model;
visual-polish candidates for a later Fable 5 pass are listed in the checkpoint
report.

## What was deliberately NOT done

- No capability deletion: assignment, lead statuses, mileage fields, expenses,
  hourly artifacts all keep their routes, tables and screens.
- Mileage stayed OUT of the v1 hideable set: its input is part of day-end data
  capture in the field view, and hiding a capture field changes what gets
  recorded — an owner decision, listed as deferred.
- No global mutation: accepting any personal preference changes one row.
- The CEO Bot never executes: read/recommend only, per its own brief §17.

## Schema

`case_refund_status` + `user_pref`, both additive, no CHECKs, guarded through
`missingTables()`. **A manual `portal-setup.yml` dispatch is owed after each
merge that adds tables.**
