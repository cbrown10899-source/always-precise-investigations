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

## Wiring (2026-09-06) — what connecting it actually cost, and found

**Worker:** the block sits beside the `/me/prefs` routes because that is the
only layer it writes. Two routes: `GET /ceo/insights` (both roles; its answers
are role-scoped inside) and `POST /ceo/suggestion` (this user's own suggestion
state). No new table — suggestion state lives in the existing `user_pref` blob
under the same allow-list, so this unit needs **no portal-setup dispatch**.

**Page:** the panel renders beside the Assistant in the same template, never
inside it. Desktop gets its own gold rail button; the phone gets a fab at
bottom-**LEFT**, because the Assistant's pill owns bottom-right and two round
buttons in one corner is two things claiming one thumb. `ceoReset()` runs with
the session beside `asstReset()`.

### THE COUNTER WAS 400-ING IN PRODUCTION, SILENTLY

`noteUse` sends `"qt:" + id` for every Home quick action. `notePrefUse`'s
allow-list was `^[a-z0-9_.-]+$` — **no colon** — so every quick-action tap was
refused with a 400 behind that helper's own empty catch. Nothing on any screen
said so, and the unit that shipped it had nothing reading the counters back.

The consequence was worse than an empty feature. The counters that DID work
(`retainer_paid`, `close_case`, `view_intake` — no colon) would have made the
quick actions look genuinely untouched, and the Unused Feature Watch would then
have recommended hiding controls the owner uses every day, printing *"you have
not used this once"* underneath as the evidence. **A recommendation is only as
honest as the measurement behind it.** Pinned now as a contract: each of the
four shapes the page really emits, plus four hostile names still refused.

### THE GATE CRIED WOLF, TWICE, AND BOTH WERE THE GATE

1. It walked the intake by an invented selector (`objective`; the real key is
   `o_goal`) and timed out.
2. It drew the signature without `scrollIntoViewIfNeeded()` — at a phone
   viewport the canvas is below the fold and a pointer event outside the
   viewport is lost. `intake/test-intake.mjs` already carries that lesson in
   its own helper; the gate did not inherit it. The strokes went nowhere, the
   form said *"Please sign in the box above"*, and the gate reported **the
   product** as failing to deliver the intake.

A gate that cries wolf is worse than no gate: it is the one report the owner is
meant to trust about dead ends, and its first finding would have been a dead end
it caused itself.

### THE SELF-CHECK HAD TO MOVE ABOVE THE DERIVATION

`CEO_GATE_SUMMARY` is a literal in `worker.js` that the Health tab prints, so
the gate asserts its own totals against it and fails on drift. Placed after
`const fails = findings.filter(...)`, its own FAIL landed in `findings` while
the summary counted a snapshot taken **before** it — the run printed `0 FAIL`
and exited 0 with a real failure sitting in the JSON report. It now counts from
`findings` directly, above the derivation, and the drift case is proven by
running it against a wrong literal (fails, names the numbers to paste) and a
right one (passes).

### Measured at render

| | desktop 1440 | phone 390 |
| --- | --- | --- |
| panel width | 430px | 390px (full sheet) |
| tabs | INSIGHTS / SUGGESTIONS / WORKFLOW / HEALTH | same |
| body is the one scroller | yes | yes |
| page scrolls behind it | **yes** (400 → 800) | no — `body.ceoopen` locks it |
| backdrop | yes (modal drawer) | yes |
| controls under the 44px floor | 1 (the close ✕ at 37px, mouse target) | **0** |
| case-write verbs in the panel | **0** | **0** |
| sideways scroll | none | none |

The desktop drawer is modal (backdrop) but leaves the page scrollable, so it
does not repeat the Assistant's "the dim must not swallow the page" trap.
