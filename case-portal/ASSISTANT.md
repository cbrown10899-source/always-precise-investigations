# API Assistant — internal operations copilot (BETA / DRY RUN)

Owner master specification: two briefs of 2026-09-02 (the original §1–38 spec,
then the pause-and-resume message with the Unit 1–9 plan and the final master
direction). This file is the repo-mapped architecture the owner's §35/§37
asked for, the derived decisions, and the running unit ledger. The owner's
briefs live in the session record; everything here restates only what this
build depends on.

## The one paragraph that governs everything

**Version 1 is BETA / DRY RUN ONLY, enforced server-side.** The Assistant may
read, search, navigate, explain, summarize, recommend, prepare, preview,
validate and simulate. It may NOT — regardless of conversational wording —
send any client communication, record a payment, change pricing, delete,
archive, close, assign, alter authorization, or touch a payment provider.
Final required state, permanent until the owner changes it OUTSIDE the
Assistant: **ASSISTANT BETA = ON · LIVE CLIENT SEND = OFF · LIVE AI EMAIL =
OFF · LIVE AI PAYMENT = OFF · AI DELETE = OFF · AI ARCHIVE = OFF · AI CLOSE
CASE = OFF.**

## §37 report — the sixteen answers, from the repo as it actually is

**1. Reusable components/routes/services.** Nearly everything the Beta needs
already exists as tested, role-gated Worker routes: `GET /search` (structured
operational search, role boundary in the SQL), `GET /summary` (dashboard
counts + the case numbers behind them), `GET /attention` (the exception list
with reasons), `GET /recent-activity`, `GET /cases/:no/workspace` (the case's
whole context, admin/investigator scoped), `GET /cases/:no/closeout`,
`GET /cases/:no/timeline`, `GET /sends` (send history with SENT/FAILED
already distinguished), `GET /sheets` (pricing catalogue + legal services +
per-case fee), `GET /delivery-center`, `GET /audit`, the invoice reads, and
`intakeDelete`'s blocker probe (the "why can't I delete this?" answer already
computes its named blockers). The Assistant composes over these; it does not
duplicate their logic.

**2. Assistant architecture.** A thin conversation layer over narrow
server-side tools. The page holds panel state and a transcript; every answer
is produced by `POST /portal-api/assistant/command`, which (a) resolves the
utterance with a DETERMINISTIC command grammar first (regex/keyword intents
— navigation, status, find, explain, what-should-I-do), (b) executes only
tools from the registry, all READ-class in Beta, and (c) returns a structured
reply: text, optional cards, optional `navigate` (a registry id, never a
URL), optional quick actions. An AI provider is NOT required for Units 1–3;
when a provider is later configured it augments intent resolution and
drafting, inside the same tool registry — never around it.

**3. Server-side tool architecture.** `ASSISTANT_TOOLS` in `worker.js`: each
tool declares `{ id, class: 'read' | 'draft' | 'consequential', run }`. The
Beta gate refuses `consequential` unconditionally (`assistant_beta` 403 by
name); `draft` tools may prepare and preview but call no send/write route;
`read` tools call the existing route handlers' underlying functions with the
CALLER'S OWN user object, so the role boundary is the same SQL it always was.
No tool receives raw SQL access; no tool composes SQL from model text.

**4. Provider adapter.** `assistantProvider(env)` — the `billcomConfig`
shape: reads `env.ASSISTANT_PROVIDER` ('anthropic' | 'openai') and the
matching key (`ASSISTANT_API_KEY`), answers `{ ready: false, reason:
'not_configured' }` until BOTH exist. Nothing anywhere else reads the key.
Not ready costs nothing: the deterministic grammar answers what it can and
says plainly what it cannot. A consumer ChatGPT/Claude subscription is NOT
API access — connecting a provider is a later, owner-approved act with its
own cost architecture, reported before enabling.

**5. Secure credential location.** Cloudflare Worker environment secrets via
`wrangler secret` / the dashboard — the `RESEND_API_KEY` pattern already in
production. Never in `portal/index.html`, `app_config`, git, logs, or any
response body. The deploy workflow's "preserving bindings" upload keeps them.

**6. Schema changes.** **NONE in Units 1–3.** The Beta audit log
(`assistant_log`, additive, guarded through `missingTables`, in
`EXPECTED_TABLES`, classified for the intake-delete inventory) arrives with
Unit 4 — the first unit that simulates — and needs one manual
`portal-setup.yml` dispatch after its merge. Until the table exists the
routes degrade exactly like every companion table here: reads answer, the
log write is best-effort, nothing 500s.

**7. Beta server-side enforcement.** Three layers, none of them a hidden
button: the tool registry contains no consequential tool in v1; the gate
function refuses the class by name even if one is added; and the Assistant
routes contain no call to `sendMail`, no write to `retainer_payment`,
`invoice_payments`, `case_deleted`, `case_archive`, `case_status`,
`app_config` or any send route — asserted by source test (the
`dropboxDelete`-caller-count pattern). Live Mode: does not exist in v1;
architected as per-capability `app_config` keys the Assistant itself can
never write.

**8. Desktop placement.** Left sidebar: a `✨ Assistant` item with a `BETA`
badge, rendered in `shell()` between the grouped navigation and the
`navfoot` action block (i.e., after Settings, before Active Surveillance /
Timestamp Video / Timestamp Photo / Intake a Client) — both roles. Opens a
right-side docked panel (`.asst-dock`) over the current view; the portal page
stays visible and interactive to its left. Header "API Assistant" with ✕;
persistent banner: *ASSISTANT BETA — DRY RUN MODE. No external client
messages or consequential actions will be sent.* Case pages add a contextual
`✨ Ask Assistant` button beside the existing case actions, opening the same
panel primed with that case's context.

**9. Mobile placement.** The portal has no bottom navigation bar on shell
screens (the fixed bottom bars belong to the case workspace and field view),
so replacing navigation is the risky path the owner allowed us to avoid: the
Assistant uses a **sticky bottom-right pill** (✨, BETA badge, 44px+ target,
`max(14px, env(safe-area-inset-bottom))` clearance — the existing rule) on
shell screens, opening a full-height bottom sheet with the same banner,
transcript, quick actions and command box. It never overlaps the case/field
bottom bars because it does not render on those screens; the case screen's
door is the Ask Assistant action instead.

**10. Client/contact resolution.** `find` intents call the existing
`GET /search` and the profiles directory. Exactly one match → resolve and
offer OPEN; multiple → list concise choices and ask; zero → say so. Emails
only ever come from stored records — never composed, never guessed. (Beta
sends nothing anyway; resolution exists for navigation and preparation.)

**11. Guided / non-technical behavior.** An `Explain & Guide Me` toggle in
the panel. When on, answers lead with one plain-language paragraph about the
record on screen (built from the same workspace/attention facts) and exactly
one RECOMMENDED NEXT STEP with a button — the `pkgNextStep` derivation logic
worn conversationally. Off, answers are compact. Both modes: facts only from
live reads, never from prose memory.

**12–14. Intake / rate-sheet / invoice simulation (Units 4–6).** Each
`prepare_*` tool calls the SAME validation path the real send uses, with the
send step replaced by a `DRY RUN — READY TO SEND` card and a SIMULATE action
that records `SIMULATED — NOT SENT` to `assistant_log`. Rate-sheet previews
render through `sheetForContext`/`legalFixedSheet` with the real pricing
resolution (`legalFlatDefault`, stored case figures); invoice previews
through `invoiceWithMoney`. Nothing touches `send_log`, `payment_send` or
the lead statuses — a simulation must never look like a send, so it is
recorded in its own table and NOWHERE the real history lives.

**15. Visual QA architecture (Unit 9).** The e2e harness (Playwright, real
Worker, 1200/820/390 widths) already measures overlap, overflow, tap floors
and contrast; the UX-advisor tools wrap the same checks into stored
recommendations (page, severity, observation, evidence, recommendation,
status, first/last seen) — findings, never automatic production changes, and
no autonomous code-modify-deploy loop.

**16. Safest implementation order.** Unit 1 shell + enforcement → Unit 2
navigation/context/explain → Unit 3 status/search/what-should-I-do (all
read-only, no schema) → Unit 4 intake simulation (+ `assistant_log`, one
portal-setup dispatch) → Unit 5 rate-sheet simulation → Unit 6
invoice assistance → Units 7–9. Each through the standing chain with the
full gates.

## Derived decisions

**A1 — deterministic first, provider optional.** Units 1–3 ship with NO AI
provider: the grammar resolves the owner's own example commands, and the
panel says plainly when a phrasing is beyond it. This keeps Beta useful,
credential-free, and honest — no model output can invent a fact because no
model runs. The provider adapter exists from day one and answers not-ready.

**A2 — the navigation registry is the TAB map.** `ASSISTANT_NAV` maps ids to
the existing TAB keys per role (dashboard, search, cases, tasks, leads,
profiles, calendar, filequeue, delivery, sheets, invoices, staff, audit,
settings; investigator: search, cases, tasks, filequeue, today, calendar,
myreports, myexpenses) plus the action doors (surveillance, timestamp video,
timestamp photo) and record navigation (open case). The server returns a
registry id; the page executes it through the same `data-act` paths a click
uses. Model text never becomes a route.

**A3 — the Assistant is additive.** It renders from `shell()` and the case
actions; no existing workflow calls it, and removing it would change nothing
else. A failed `/assistant/*` read draws an error inside the panel only.

**A4 — role fidelity.** Every tool runs as the signed-in user. An
investigator's Assistant searches their own cases, sees no money, and is told
"This action requires Admin permission" where an admin door exists.

**A5 — minimum data to any future provider.** When a provider is enabled,
it receives the utterance, the compact context card (route, case number,
role), and tool results the user could already see — never DOBs, evidence
bytes, uploaded documents, or full narratives unless the specific authorized
task requires them.

**A6 — Unit 4's rehearsal is the real thing minus the send, structurally.**
`assistantIntakePlan` runs the SAME validation the two real doors run — the
email regex, the explicit-kind resolution `/intake-link/email` uses, the
`contextForSub` case resolution `/leads/:no/send-intake` uses — and the
deleted/archived gates through the shared `caseSendRefusal`, because a dry
run that answers READY TO SEND about a send the portal would refuse is a
rehearsal of the wrong play. The preview renders through `intakeInviteEmail`
itself; two renderings of one email drift. Both branches produce a CONTEXT
and the door is derived from it exactly once, so the `intakeForContext`
single-reader-per-sender guard counts 4 now (the three real senders plus
this resolver) and its test names the fourth.

**A7 — the simulation log is honest about itself.** The SIMULATE response
always states `outcome: 'SIMULATED — NOT SENT'`, and `logged: true|false`
with the named reason (`not_set_up` until portal-setup applies the table,
`log_write_failed` on a refused row) — the Unit 11 integrity-record rule: a
success that hides an unrecorded rehearsal and a 500 that eats the answer
are both lies. The rehearsal itself never depends on the table.

**A8 — `assistant_log` is Beta audit history, classified as such.** In
`EXPECTED_TABLES`, swept by `DEMO_SWEEP` on its own `case_no` (null for
pre-case rehearsals — the send_log rule: a typed reference never credits a
case that does not exist), and `INTAKE_EXEMPT` for the intake hard-delete —
a rehearsal must not make a disposable duplicate immortal, and audit history
is non-deletable, so the row neither blocks the delete nor dies with it.

**A9 — the source pin narrowed rather than vanished.** The Assistant block's
write-freedom is now: exactly ONE `INSERT INTO`, and only into
`assistant_log`; still no UPDATE, no DELETE, no `sendMail(`, no settings
store, and the literals `send_log` / `payment_send` / `stampLead` /
`logSend` appear nowhere in the block, comments included. A second write
anywhere in the block fails the suite by count.

**A11 — Unit 5's sheet rehearsal is a PINNED MIRROR, not surgery on the real
sender.** `assistantSheetPlan` restates `emailSheet`'s resolution step for
step — context rules, case pairing, legal service and fee, the payment-method
boundary — reusing the same named helpers (`sheetForContext`,
`legalFixedSheet`, `retainerForSend`, `paymentOptionsFor`, `withBillcomLine`,
`sheetEmail`) and containing no way to send. Extracting a shared resolver
out of `emailSheet` was considered and deliberately not done: that function
is the most safety-critical send path in the Worker, and the suite holds the
two together more strongly than code-sharing claims would — the SAME inputs
through both must produce the SAME subject and body byte for byte, and the
SAME refusals by code (asserted across the private/fixed/insurance/case
shapes and six refusal mirrors). A divergence fails loudly instead of
drifting. If a THIRD consumer of this resolution ever appears, extract then
— the third-reader lesson. The workbench's non-private payment tick means
Mail Check only; the full method set stays the send wizard's. The one log
writer (`assistantLogged`) keeps the block at exactly one INSERT, and the
`intakeForContext` single-reader count is 5, each named.

**A12 — Unit 6 is HALF built, and the missing half is an owner decision, not
a gap.** The READ half ships: "What is outstanding?" / "billing status" (with
a case in context) answer from `listInvoices`' own composition — the same
money the Billing screen draws, drafts excluded from outstanding exactly as
the locked invoices rule says, admin-only, navigation to Billing offered.
The PREPARATION + SIMULATION half is deferred because there is nothing
honest for it to rehearse: **the portal has no invoice-send route** —
`sent_to_client` is a status the office sets after sending by its own means,
and no code path emails an invoice — and *creating* a draft invoice is a
REAL write into `invoices`, which the Beta block structurally cannot make
(the one-INSERT source pin is the enforcement the owner asked for). Giving
the Assistant a second write table is exactly the kind of widening §37 says
to stop and ask about. **Owner question on the record:** should invoice
"preparation" (a) create a real draft through the existing `createInvoice`
writer under an explicit owner-approved widening of the Beta pin, (b) wait
for Live Mode, or (c) be a pure preview of a would-be invoice with no
record? Until answered, the Assistant reads money and never touches it.

**A13 — Unit 6's preview is a VIEW-MODEL, and the number proof is the test.**
The owner's zero-write rule made the shape: `assistantInvoicePreview` mirrors
`createInvoice`'s derivations (bill-to, refs, terms, authorization-seeded
lines) over pure reads, prices through `invoiceMoney`/`retainerBlock` (which
read only `invoice_type` + `case_no`, checked), and shows the would-be number
from the same MAX-derived read the real route uses — deriving consumes
nothing, and the suite proves the NEXT real invoice receives exactly the
previewed number. A twin case pins field equality with a real create; a
snapshot pins zero writes across every billing table AND `assistant_log`
(the preview is a read, so it is deliberately not logged — logging it would
itself be the write the rule forbids).

**A14 — Unit 7 quotes, counts, and never composes.** Case health, holding,
ready-to-invoice and ready-to-close (both worn `closeoutFacts`), package
readiness (`shippableReports` + classification counts), and the delete-block
explanation through `intakeBlockersFound` — EXTRACTED from `intakeDelete` so
the explanation and the refusal run the same statement and cannot drift.
"Draft report" and "summarize today" are the recorded chronology VERBATIM
(`assistantChronology`: day headers, `HH:MM — description`, caps named) — no
prose engine, no invented event, vehicle, time or amount; the deterministic
paragraph stays the Daily Summary Builder's job. `assistantCaseNextStep` is
the one writer both the briefing and the health summary read.

**A15 — Unit 8's Watch is a composition, and its safety is an absence.**
`assistantWatch` answers when ASKED: `needsAttention` merged whole (same
admin gate, same severities) plus bounded arms — fresh intakes by business,
overdue/due-soon invoices, finalized-undelivered packages, refused uploads
(`storage_failure`), unassigned accepted cases, and the delivered-and-paid
conjunction worded softly toward the closeout checklist. Nothing is stored,
nothing polls, nothing fires on its own, and there is NO code path from
Watch to email, SMS, a client, a payment or a destructive act — the answer
says "internal only" out loud. Proactivity in Beta is the quick button on
the panel's empty state, not a background process.

**A16 — Unit 9 measures; it never opines, and it cannot deploy.**
`portal/ux-advisor.mjs` renders the seeded, signed-in portal at 1200/820/390
and measures the owner's machine-decidable classes: sideways overflow,
overlap (only when BOTH controls are hittable at their own centers — a fixed
overlay covering the page, or rows scrolled under the ask bar, occlude by
design and are excluded), under-44px tap targets (HIGH at iPhone, MEDIUM at
tablet where desktop density is intentional), genuinely wrapped controls
(a Range over the text, immune to flex centering — the first two heuristics
false-positived on every properly-44px nav button and were replaced),
duplicated action labels, mixed terminology, scroll depth. Findings dedupe
across screens and land in `case-portal/UX-FINDINGS.json` + `.md` with
page/severity/observation/evidence/recommendation/status/seen. Hierarchy,
relevance and click-depth are LISTED as needing a person — not decided by
pattern-matching. The advisor writes those two files and nothing else;
no Assistant surface can modify or deploy source.

**A17 — Unit 10's topics are a menu that talks back, and its buttons are
inert by construction.** A bare word ("intakes", "invoices", "cases"…)
answers TOPIC + LIVE STATUS + the actions that fit the state — counts
counted from the same tables the screens read, the primary action flipping
with the situation (fresh intakes → REVIEW NEW INTAKES; none but dormant →
REVIEW CLEANUP CANDIDATES; neither → the three quiet doors). Only inputs of
up to four stripped words reach the topic table, and it runs LAST, so every
richer phrasing keeps its handler. Three action shapes exist and only
three: NAVIGATE (a registry id), SAY (a phrase fed back through this same
deterministic grammar, exactly as if typed), SEED (text placed in the box) —
no button can send, delete, archive, pay or close, and the suite walks every
topic asserting the shapes and that nothing was sent or written. The
dormant-intake intelligence runs `intakeBlockersFound` PER CANDIDATE — the
delete's own probe — so ELIGIBLE FOR CLEANUP REVIEW means exactly "the
quick delete would not refuse this", PROTECTED names what it carries, and
the answer says in words that Beta never deletes; the manual control on the
intake card stays the only delete. `ATTN.DORMANT_INTAKE_DAYS` (14) is the
one arguable window. The rate-sheets topic READS `send_log` (recent sends),
so the source pin was narrowed with the reason on the record: the writers
stay banned by name, and the block still carries exactly one INSERT.

**A10 — the grammar carve-out opens a workbench, never a send.** An
utterance about sending/preparing an INTAKE resolves to `kind:
'prepare_intake'` with a prefilled form seed (email lifted from the
sentence, door guessed from its words, the case from the screen context) —
the doing is two explicit admin-only routes. Destructive verbs about an
intake still refuse; every other send-shaped verb keeps the flat refusal,
which now names what CAN be rehearsed. The page workbench holds its state
in `ASST.prep` under the EDIT_DRAFT rule, so no repaint can eat what was
typed — the exact bug Unit 1's suite caught in `asstOpen`.

**A18 — Back and Assistant Home are DERIVED from state the panel already
holds, never a stored stack** (owner brief 2026-09-02: a persistent way back
to the original menu without closing the panel). The panel's real depth is
four levels and all four already exist as state: HOME (the quick menu),
CHAT (`ASST.msgs` rendered), the WORKBENCH FORM (`ASST.prep`), and the
WORKBENCH PREVIEW (`ASST.prep.preview`). `asstBack()` walks one level using
exactly the transitions the panel already owned — preview→form is the Edit
button's own write, form→chat is Cancel's, chat→home is the one new pointer
(`ASST.view`) — and `Assistant Home` jumps straight to the menu. A stored
navigation stack would be a second copy of this state and would drift the
first time a flow forgot to push. The menu became a VIEW rather than the
absence of messages (it used to render only while `msgs` was empty, so the
first tap buried it for the life of the session — closing and reopening did
not bring it back, which is the defect behind the owner's report). The
conversation is never destroyed by going Home: `msgs` stays, a "Return to
the conversation" row on the menu (drawn only when one exists) goes back
down, and any new question lands in the same log. Back from the workbench
inherits Cancel's meaning — the draft is discarded exactly as the Cancel
button always discarded it, one behavior, not two. The strip lives under
the head, 44px targets, palette tokens; the X is untouched; on the home
screen no Back control renders, in the owner's own words. Case and page
state (`WS_CASE`, `TAB`, drafts elsewhere) are never touched by any of the
three acts. (This entry is the design record, written before the code — the
PHOTO-TIMESTAMP.md pattern; the ledger row below says how far the build
actually is, and the suite assertions land with the code.)

## Found gap (2026-09-02, overnight audit): the guide toggle was inert

**`Explain & Guide Me` drew, stored its tick, sent `context.guide` on every
command — and NO Worker branch read it.** The §11 behavior it promises
(answers lead with one plain-language paragraph about the record on screen)
did not exist; the toggle changed nothing. The exact defect class this
project keeps on file — the inert profile-contact select, the invisible
quick tool: a control that renders is not a control that works. Found by
grepping the Assistant block for `guide` (zero occurrences) after Units 1–3
had already deployed in #261. **FIXED in the same overnight window**: guide
ON now leads a STATUS answer with the screen's own plain-language paragraph
(`guide_intro`, decorated in a wrapper over the grammar core — the case
workspace's paragraph when a case is in context); refusals, navigation and
the explain answers are untouched, OFF stays compact. Both suites assert the
ON/OFF DIFFERENCE — a test for only "the toggle exists" is exactly how the
gap shipped.

## Unit ledger (update as units move)

| Unit | Scope | State |
| --- | --- | --- |
| 1 | Shell: sidebar item, case-level door, mobile pill+sheet, dock panel, Beta banner, server-side gate + tool registry + provider adapter (not ready) | ✅ **DEPLOYED** — #261 `b379990`, both workflows `success` on `b3799902` |
| 2 | Navigation: registry, "take me to…", current-page context, "Where am I?", "Explain this page" | ✅ **DEPLOYED** — #261, deterministic grammar, registry ids only |
| 3 | Live status: "anything new?", "what needs attention?", "what should I do?", find client/case/intake with disambiguation | ✅ **DEPLOYED** — #261, live reads through the existing role-scoped functions |
| 4 | Intake preparation + preview + SIMULATE + `assistant_log` (schema: one additive table → portal-setup dispatch) | ✅ **DEPLOYED** — #262 `85806e6`; site + Worker + **portal-setup all `success` on `85806e68`** (08:39Z), so `assistant_log` is live. A6–A10 below |
| 5 | Rate-sheet preparation + preview + simulation (pricing via the real resolvers) | ✅ **DEPLOYED** — #263 `099b817`, both workflows `success` on `099b8174` (A11; byte-pins hold the mirror to the real sender; no schema change) |
| 6 | Invoice/billing read + preparation + simulation | ✅ **DEPLOYED (zero-write, complete)** — read half #263; the zero-write preview #265 `3f1f640` (A13): DRY RUN — INVOICE PREVIEW / SIMULATED — NOT CREATED, no row, no number consumed, twin-pinned |
| 7 | Case health / summaries / report drafting from recorded facts | ✅ **DEPLOYED** — #265 `3f1f640` (A14); recorded facts only, verbatim chronology, one next-step writer, the delete-probe extracted and shared |
| 8 | Watch mode (internal read-only monitoring) | ✅ **DEPLOYED** — #265 `3f1f640` (A15); internal only, by absence of any send path |
| 10 | Topic commands / smart shortcuts (owner brief 2026-09-02, second window) | ✅ **DEPLOYED** — #266 `9dd7f64`, both workflows `success` on `9dd7f643` (A17) |
| 9 | Visual QA / workflow advisor | ✅ **DEPLOYED** — #265 `3f1f640` (A16); `portal/ux-advisor.mjs`, 51 findings stored in `UX-FINDINGS.json`/`.md`, judgment classes named for a person |
| 11 | Back / Assistant Home panel navigation (owner brief 2026-09-02, third window) | ✅ **DEPLOYED** — #270 `1f41310`, `deploy.yml` `success` on `1f413100` (A18; page-only, level derived never stored, +18 e2e checks incl. both roles, phone targets, draft/conversation preservation, page-state isolation) |

**Checkpoint (2026-09-02, updated overnight):** the pre-Assistant units went
green first — PR #260 merged as `6770609`, both deploy workflows `success` on
`67706099` — and Units 1–3 were then built as ONE additive change, merged as
PR #261 `b379990` with both deploy workflows `success` on `b3799902`
(06:24Z; suites at merge: worker 3045/0, e2e 2826/0, intake 558/0, deploy
guard 86/0, visitor 47/0):
`/assistant/state` + `/assistant/command` in the Worker (deterministic
grammar, registry-id navigation, live status reads through the existing
role-scoped functions, consequential verbs refused by name as
`assistant_beta`, provider adapter answering `not_configured`), and the page's
dock/pill/case door under the `.asst-` prefix. No schema change. Worker suite
carries 36 Assistant checks (source pins included: no sendMail, no
INSERT/UPDATE/DELETE, no settings-store write inside the Assistant block);
the e2e carries the dock, banner, real navigation, refusal rendering and the
phone pill/sheet. Units 4–6 (intake/rate-sheet/invoice preparation +
SIMULATE) are the next tier and bring `assistant_log` — the first Assistant
schema change, one portal-setup dispatch, reported to the owner before it
lands.
