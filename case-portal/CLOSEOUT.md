# Case Closeout — designed from the audit, 2026-08-21 (Unit 15)

**No verbatim owner brief exists for this unit** — the roadmap row says "Case
Closeout" and `MASTER-HANDOFF.md` has no section by that name (its closeout
material is the status vocabulary, the Ready-to-Close dashboard metric and the
next-step chain, all built). Per the standing instruction — audit first — this
file records what exists, the one gap the record proves, and the decisions
derived from it.

## THE AUDIT — closeout as it stands

| Piece | State |
| --- | --- |
| Eight-attestation checklist (`CLOSURE_ITEMS`), stored per case | ✅ `case_closure`, since the workflow-simplification unit |
| `closed` reachable ONLY through the checklist (`closeCase`); `setStatus` refuses it by name | ✅ |
| Reopen on the panel where closure happened; ticks kept as history | ✅ |
| Ready to close on the dashboard (stage = complete), clickable | ✅ |
| Next-step chain ends at "Ready to close" | ✅ |
| Archived / Deleted lifecycle around it, write-gated | ✅ Units of 2026-08-16 |
| Completed desk (MASTER §31) | ✅ |
| **What the record KNOWS beside each attestation** | ❌ nothing — "Billing reviewed" ticks over an outstanding invoice in silence |

The checklist is deliberately attestation-first (the owner's design), and that
is kept. What is missing is the same honesty rule the rest of the portal
follows: a staff screen must not stay silent about something untrue-adjacent
it can already see. The person ticking "Report completed" should be looking at
"1 day has no report" if that is what the database says.

## DERIVED DECISIONS

- **D1 — One read, `GET /cases/:no/closeout`, admin-only,** composing per-item
  FACTS from tables that already exist: open days; days without a report;
  reports not approved/delivered (admin-authored drafts counted as ready, the
  Unit-of-2026-08-19 rule); evidence still `needs_review`; builds never
  finalized; expenses with review undecided; outstanding invoice balance
  (computed, the invoice rule); retainer agreed but not received on consumer
  cases. Every arm bounded, every count derived, nothing stored.
- **D2 — Facts INFORM, the attestation DECIDES.** No fact blocks `closeCase`;
  the checklist stays the only authority, exactly as the owner designed it.
  The panel draws each fact beside its tick as a word + tone (never color
  alone), and a tick over a contrary fact stands — attestation means the human
  looked and decided, and the screen's job is to make sure they saw.
- **D3 — Wording states facts, never conclusions**: "1 invoice shows a
  balance of $450" — not "billing is not done", which is the human's call.
  A case with no invoices says nothing about invoices rather than inventing a
  warning (the attention engine's no-weak-assumptions rule).
- **D4 — No schema, no portal-setup.** Every fact is derived at read time;
  storing "readiness" would be a second status system that drifts (the
  no-dismissal reasoning from Unit 8).
- **D5 — The same facts ride the close ATTEMPT'S refusal** only as the
  checklist wording already does (missing ticks named); `closeCase` itself is
  unchanged.
- **D6 — Deferred, named:** any gate that would block closing on a fact (a
  policy decision the owner has not made); a closeout PDF/statement (the
  panel and `case_closure` already record who closed what and when); investigator
  visibility (closing is office work; the read is admin-only like the
  checklist panel it feeds).
