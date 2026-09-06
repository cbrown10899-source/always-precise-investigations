# The CEO Bot — owner brief 2026-09-06 (22 sections)

READ-ONLY / RECOMMENDATION-FIRST. The AI Assistant is CASE OPERATIONS; the CEO
Bot is PORTAL / WORKFLOW IMPROVEMENT — separate entry, separate identity
(navy/GOLD vs the Assistant's navy/teal), separate panel, and **no way to act
on a case from inside it**: the strongest verb on any card is a NAVIGATION into
the ordinary portal, or a write to the caller's own preference row.

## Derived decisions

**B1 — It rides the personalization layer, adding none of its own.** Suggestion
states (`new/reviewed/accepted/not_now/dismissed/implemented`, the brief's §15)
live in `user_pref.prefs.suggestion_state`; metrics are the `/me/prefs/use`
counters; Preview/Apply goes through the SAME `/me/prefs` write Settings → My
Portal uses. One writer of a personal layout.

**B2 — Evidence-based or silent.** An unused-feature suggestion fires only when
THIS user has 20+ counted taps and the control took none of them, and its "Why?"
states exactly that arithmetic. A user with no counted usage gets no nagging —
asserted.

**B3 — NOT NOW sleeps 14 days; DISMISSED sleeps until the evidence version
changes; ACCEPTED/IMPLEMENTED stay done.** Per user, bounded at 200 decisions
with the oldest falling out.

**B4 — The gate detects, the Bot displays** (§7). `CEO_GATE_SUMMARY` in
`worker.js` is the last release-gate totals, and `portal/test-ceo-gate.mjs`
asserts the literal matches its fresh results — the Health tab's number is a
gated fact, not a hope. When the gate drifts, it fails naming the update.

**B5 — The closeout watch recommends review, never closure.** Paid-no-work
detection is arithmetic over records that exist (live retainer sum > 0, no
`case_days` row, open, 7+ days old, not hidden); the card's own copy says the
Bot closes nothing and Review opens the ordinary Close Case flow.

**B6 — The Workflow tab shows MEASURED flows of the shipped build** — tap
counts the gate and suites measured — beside the user's own usage counts. It
does not replay a client narrative; the brief's §16 privacy floor (no intake
text, no signatures, no evidence content) is upheld by only ever storing
action IDS and counts.

**B7 — Telemetry is the §16 minimum**: authenticated user id, action id, count,
last-used timestamp. No route history v1, no device category v1 — listed as
future, not silently collected. No external analytics provider.

**B8 — The brief numbers are role-scoped like the dashboard**: an
investigator's CEO read carries no business totals and no closeout watch.

**B9 — The mockup images did not reach the session.** The panel is built to the
owner's written spec (drawer, tabs, Portal Health, card hierarchy,
Preview/Not Now/Why?, mobile panel with owned scroll). Flagged for the owner's
visual pass — a later Fable 5 polish is the routing instruction's own fallback.

## The safety line (§17), structurally

The CEO block's only INSERT target is `user_pref`; it calls `sendMail` never,
`closeCase` never, touches no case table with a write, and the panel renders no
operational verb — all asserted by tests that parse the block and walk the
panel's buttons.
