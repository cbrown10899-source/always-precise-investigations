# The financial closeout — owner brief 2026-09-06

The owner's rules, verbatim, and what each one became in code. This file is the
durable record; `CLAUDE.md` carries the summary.

## The owner's rules

> - never alter historical payment records
> - refunds must be separate ledger events
> - non-refundable retained amount and refund amount must reconcile against
>   actual received funds
> - closeout must preserve the original payment transaction
> - final balance must come from the real ledger
> - case closure and client email must remain separate explicit confirmations
> - email must never happen automatically when the case is closed
> - "The Assistant may never record, post, void, or alter a payment directly"
> - the Assistant "must never execute the refund, case closure, or email
>   directly from natural language"
> - "Do NOT modify the original payment to pretend less money was received"

## The architecture, in one sentence

A refund is a row in `case_refund`; `retainer_payment` is never touched; every
total is arithmetic over the two, computed on read.

There is no stored total anywhere. A stored one would be a second answer to a
question the ledger already answers, and the two would disagree the first time
a payment was voided — the shape this project has already paid for with
`send_log.case_no` and the sibling-invoice retainer sum.

## The four figures

| figure | what it is |
| --- | --- |
| `retainer_received` | SUM of live retainer payments. Voided ones do not count — a voided payment is money that never stayed. Read, never typed. |
| `retained` | the non-refundable portion the office EARNED. Typed at closeout; the one genuinely new decision. |
| `refunded` | SUM of the refund ledger. |
| `final_balance` | `received - retained - refunded`. Zero means settled. Positive means the office is still holding money that is neither earned nor returned, which is a real state and is shown as one. |

## D1 — TWO BALANCES ARE NOT ONE QUESTION

`final_balance` is the LEDGER'S, per the owner's rule. Before a confirm no
refund has been issued, so on a $1,000 case with $400 earned it reads **$600** —
exactly right, the office really is still holding $600.

`projected_balance` is what the AGREED figures WOULD settle to, and it is what
the review screen shows beside Confirm. Naming them apart is the point: **a
projection drawn under the word FINAL is the portal asserting something that has
not happened.** They converge the moment the refund is written, and the client's
statement prints only the ledger's.

`refund_pending` carries what a confirm would still write, so no caller has to
work out whether the agreed refund has already been issued.

## D2 — RECONCILIATION IS A REFUSAL, NOT A WARNING

`closeoutCheck` refuses over-allocation **by name** with the arithmetic in the
message:

> $600 retained plus $600 refunded is $1,200, and only $1,000 was actually
> received. A closeout cannot allocate money the case never took in.

An impossible financial state that was merely flagged is one somebody clicks
past. The exact boundary is ALLOWED — spending every dollar is the ordinary
case, and a `>=` comparison would have refused it.

Cents are compared as cents (`centsEqual`). Two sums of REAL columns can miss
equality by 1e-13, and refusing correct arithmetic over that would be the portal
being wrong about the one thing it exists to get right.

`refunded` passed to the check is the WHOLE refunding — anything already on the
ledger plus what this closeout would add. Only `closeoutConfirm` writes a refund
row and it refuses a second closeout, so the first term is always zero today;
passing the total anyway means a manual refund entry added later cannot open a
hole under a guard that was only ever checking the new figure.

## D3 — PREPARE AND CONFIRM ARE TWO ACTS

`closeout/prepare` writes the office's decision and **moves no money**. It can
be edited, re-run and abandoned. `closeout/confirm` is the only writer of a
refund row, and it re-checks the reconciliation **at the moment of writing** —
the prepare validated against the ledger as it stood then, and a payment could
have been voided since.

## D4 — THE CHECKLIST IS STILL THE ONLY DOOR

Confirming records the money and then calls the **existing** `closeCase`. That
call can legitimately refuse — the eight attestations are the owner's own gate
and this unit does not touch them. On such a case the refund is real and the
case is OPEN, and the response says so (`case_closed: false` plus
`checklist_open`). **A fact is not hidden because a tick is missing.**

## D5 — THE STATEMENT PRINTS "CASE STATUS: CLOSED", SO THE CASE HAS TO BE CLOSED

Found by the suite. Because of D4 a case can have a confirmed closeout and an
open case, and the email route originally read `case_closeout.closed_at` as
"the case is closed". It would have told a client their case was closed when it
was open. `closeout/email` now requires `submissions.status === 'closed'` and
refuses `case_not_closed`, **naming what is still open**.

## D6 — EMAILING IS ITS OWN ACT, ALWAYS

The route does not close anything, is not called by the confirm, and refuses on
a case whose closeout has not been confirmed. A second send is refused **by
name** (`already_emailed`) rather than silently deduplicated — a second tap, a
retry after a dropped response and a deliberate resend all look the same from
here, and the first two must not send twice while the third is still possible.
`resend: true` is the office saying it meant it.

The page asks a second time in a `confirm()` naming the recipient. **Closing
emails nobody**, asserted at the transport in both suites, not at the route.

## D7 — NOT WRITTEN TO `send_log`, AND THAT IS A SCHEMA FACT

`send_log.kind` carries `CHECK (kind IN ('rate_sheet','intake'))`. Widening a
CHECK in SQLite means rebuilding the table, which `schema.sql` — re-applied on
every portal-setup run — cannot do idempotently: a fresh database would accept
`'closeout'` while the LIVE one refused it. Green in every test, broken only in
production, which is the `client_token` shape exactly.

The statement's own send record is `case_closeout.emailed_at` / `emailed_to`,
which is where a reader would look for it anyway. A send that did not happen
stamps nothing.

## D8 — THE ASSISTANT PREPARES AND NEVER EXECUTES

This is the **Daily Summary** shape, not the payment prefill's. It answers FROM
THE RECORD — what was received, what has been refunded, whether a closeout is
already recorded, what the checklist still has open — and opens the panel. It
proposes **no split**.

> What the firm EARNED is the one genuinely new decision a closeout makes. It is
> not derivable from anything the portal holds, and a suggested split would be
> the Assistant deciding how much of a client's money the firm keeps.

The carve-out sits above `ASSISTANT_BLOCKED` like the intake, rate-sheet and
payment rehearsals, and is narrower than all three: it matches only wording that
is ABOUT a closeout and **stands down the moment the sentence also carries an
executing verb**. "Close out this case and email the client" names a send, so it
goes to the refusal — the carve-out must never become the way round the thing it
sits above. Four phrasings are pinned as reaching the refusal.

`refund` and `closeout` were ADDED to the blocked list. Nothing could ever have
refunded anything — nothing executes without a registry row — but
"refund the client $600" fell through to the ordinary help answer, and **a shrug
is not a refusal.**

## D9 — THE INTAKE SCREEN CARRIES THE INTAKE'S OWN ACTIONS

The owner's live iPhone report was the DISTANCE: reading a submitted intake and
then acting on it meant going back to the Intakes desk for every action. Every
button on the details screen is an EXISTING one — same `data-act`, same handler,
same route — so this is one flow with two doors and never a second
implementation.

`lead_status` now rides the workspace (admin-only, one indexed lookup) so the
screen can offer *Create case* or *Open case* and **be right about which**.
Deriving it from a stage or an assignment would be inference about the one fact
that row exists to hold.

## D10 — THE DRAFT IS CAPTURED AT RENDER, NOT AT EACH ACTION

Found by the e2e. `fcCollect()` was called by each `fc*` handler, which is what
`edCollect` does — and it was not enough. The closeout form is open while two
late reads can still land (`loadCloseout`, the checklist facts, and
`loadFinalCloseout` itself), and each of them repaints. A repaint rebuilds these
inputs from `FC_DRAFT`, so a figure typed and not yet previewed was silently
reverted to blank, **on a form about a refund**.

The capture now happens at the top of `finalCloseoutPanel()`. That is the
`focusCapture()` shape and the reason it works: `paint()` composes the whole
string first, so the OLD inputs are still on the page while the panel renders.
**The fix belongs where every repaint passes, not at the handlers that happen to
be remembered.**

## What this unit does NOT do

- **No destructive schema change.** Two additive tables, no CHECK constraints,
  guarded through `missingTables()`, in `EXPECTED_TABLES`, swept by
  `DEMO_SWEEP`, refused by the intake hard-delete's blocker list.
- **No parallel billing system.** Invoices, `retainer_payment`,
  `agreedRetainer()` and the rate sheets are untouched.
- **No new payment instrument.** A refund's method is validated against the same
  `RETAINER_METHODS` the recorder already offers.
- **No automatic anything.** Nothing closes, refunds or emails on its own.
- **No claim-assignment closeout.** A claim is authorized in hour blocks and
  billed on its invoice; the panel says so in words rather than showing an empty
  form.

## Adding these tables means a manual `portal-setup.yml` dispatch after merge.

Until it runs: the read answers and NAMES what is missing (never "no refunds" as
a fact), the writes refuse 503 naming the workflow, and the panel says so.
