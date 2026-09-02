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

## Unit ledger (update as units move)

| Unit | Scope | State |
| --- | --- | --- |
| 1 | Shell: sidebar item, case-level door, mobile pill+sheet, dock panel, Beta banner, server-side gate + tool registry + provider adapter (not ready) | NOT STARTED |
| 2 | Navigation: registry, "take me to…", current-page context, "Where am I?", "Explain this page" | NOT STARTED |
| 3 | Live status: "anything new?", "what needs attention?", "what should I do?", find client/case/intake with disambiguation | NOT STARTED |
| 4 | Intake preparation + preview + SIMULATE + `assistant_log` (schema: one additive table → portal-setup dispatch) | NOT STARTED |
| 5 | Rate-sheet preparation + preview + simulation (pricing via the real resolvers) | NOT STARTED |
| 6 | Invoice/billing read + preparation + simulation | NOT STARTED |
| 7 | Case health / summaries / report drafting from recorded facts | NOT STARTED |
| 8 | Watch mode (internal read-only monitoring) | NOT STARTED |
| 9 | Visual QA / workflow advisor | NOT STARTED |

**Checkpoint (2026-09-02):** the pause instruction arrived before any
Assistant code existed — NOT STARTED across the board, nothing lost. Resume
after the pre-Assistant units are green (they are being shipped in PR #260).
