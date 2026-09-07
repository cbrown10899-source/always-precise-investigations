# SENT DOCUMENTS — the exact thing a client received, and what they signed

Owner brief 2026-09-07, "FINAL CLIENT RECORD + RATE SHEET HARDENING WORKLOAD".
Derived decisions D1–D14 below, one per entry so any of them can be overturned
on its own.

The primary goal in the owner's words: *"Make the Private Rate Sheet → Intake →
Acceptance → Retainer record chain complete, provable, simple, and low-click."*

---

## The question this exists to answer

> "Which exact rate sheet and terms did this client receive and sign?"

Before this unit the portal could not answer it. `send_log` recorded **that** a
send happened — who, when, which product, whether the provider took it — and
nothing about **what went**. The only way to reconstruct a document was to
re-render today's template with today's figures, which is exactly the thing
that changes: the standard retainer, the non-refundable default, the wording of
the minimum. A client who signed in March agreed to March's document.

---

## D1 — the record stores the BYTES, not a recipe for them

`sent_document.subject`, `.body_text` and `.body_html` are the exact strings
handed to the mail provider. `content_hash` is their SHA-256.

**The sheet's display name was refused as the version.** "Private Client —
$1,500" is worn by two documents whose non-refundable amounts differ, so it
identifies the PRODUCT and never the CONTENT. The owner's brief says so
directly: *"Do not use the display name … The version must identify the actual
content that was sent."*

The hash covers the JSON of the three parts rather than a joined string, so the
encoding is unambiguous by construction. (The first version joined them with a
literal NUL, which worked and put a control byte in `worker.js` — which is how
a source file starts reading as binary to every ordinary tool.)

## D2 — `send_log` is untouched, and that is what makes this safe

No existing row is rewritten, no CHECK is widened, no column is dropped. The
two tables are joinable and neither needs the other to exist. `send_log` stays
the send log; `sent_document` is the document record. The owner's own
constraint: *"Use a safe schema migration. Do not destroy existing send_log
history."*

Four additive tables — `sent_document`, `document_send_attempt`,
`document_acceptance`, `document_record_copy` — and `kind` carries **no CHECK**
(the Unit 7 rule), so a fifth document type is an ordinary Worker edit rather
than the non-idempotent rebuild `schema.sql` cannot perform.

## D3 — `case_no` follows the send_log rule exactly

NULL unless the office's typed reference actually resolved to a case, so a
pre-case send can never be adopted by a later case of the same name.
`case_ref` keeps what was typed.

**Acceptance fills it in, once.** A pre-case send has a null `case_no` — that is
the ordinary path — so linking an acceptance sets it, and only where it is
still null: a document already tied to a case cannot be re-pointed at another
by a later submission quoting its token.

## D4 — one attempt key per send, claimed BEFORE the provider is called

Three answers, and the third is the one that matters:

| state | meaning | what happens |
| --- | --- | --- |
| `fresh` | nobody has used this key | send |
| `done` | this attempt already produced a document | return that record, email nobody |
| `indeterminate` | claimed, and no document followed | refuse **by name**, point at the send history |

The third is the honest answer to a request that died between the claim and the
record: whether the client received the first one is genuinely unknown, and
guessing wrong emails them twice. The failure path records its document too, so
a retry of a *failed* attempt reads back the failure rather than being told it
is indeterminate.

A caller that sends no key behaves exactly as before — the guard is opt-in per
attempt, the `client_token` shape the money routes already use.

## D5 — the intake door carries the document, and exposes nothing

`doc_id` is 128 bits of randomness naming nothing: no client, no case, no
amount. It satisfies the brief's *"Do not expose sensitive data in the URL"*
because there is no data in it, and it grants nothing — the public ingest uses
it to WRITE a link and never to read a document back, and every route that
reads one is admin-gated.

One door object from the id down, so the email body, the stored `intake_door`
and the response label cannot disagree about which URL the client was given.

## D6 — acceptance is LINKED, never inferred

`linkAcceptance` writes only when a submission carries the token its own door
was issued with. **No name matching, no email matching, no nearest-in-time
guess.** `recipientIsCarrier` produced four defects in four review rounds doing
exactly that, and this project does not do it again.

- A submission with no token links to nothing, however alike it looks — pinned
  with a same-name, same-address submission.
- A token resolving to no document writes no link, because that would
  manufacture evidence a client signed something the portal never sent.

**No acknowledgement checkbox was added and none may be.** The owner's decision
stands that the existing signature covers the whole document. What was missing
was never consent; it was the link.

## D7 — the office copy can fail on its own, and now says so

The Worker had always answered `record_copy` and `record_reason`. The page read
**neither**, so the one failure mode of *"Corey should not have to remember to
CC himself"* was invisible.

Three states, kept apart, and the middle one is the point:

- the copy went → a quiet line, because nothing needs doing;
- **client sent, owner copy failed** → said plainly, with the remedy beside it,
  and never worded as though the send failed;
- no business address configured → **not a failure at all**, so it says what to
  do rather than reporting an error that isn't one.

The state is durable, not just a response someone scrolled past:
`sent_document.record_copy` answers "does this document still need its copy?"
in one read, and `document_record_copy` keeps every attempt **including the
failures** — a trail of successes only could not show the state this exists to
make visible.

## D8 — the resend sends the office copy and cannot send the client's

`POST /documents/:id/record-copy` re-composes the internal summary from the
STORED record. There is no parameter by which it could email the client, which
is stronger than a guard. It writes **no second `send_log` row**: the client
received one document, so the history says one document.

A document that never reached the client refuses a copy by name
(`document_not_sent`) — filing a summary headed "sent to the client" about a
refused send would be the office's own paperwork asserting an untruth.

## D9 — a resend states the terms as they were, not as they are now

The route reads `terms_json` back rather than re-deriving from today's figures.
A resend six months later still states the amount the client agreed to. This is
the same property "View rate sheet as sent" has, and it is the whole reason the
bytes are stored.

## D10 — recording a payment copies the office too

The audit found the one act involving the client's money left no paperwork in
the office's inbox, while every send already did. `retainerRecordCopy` runs
after the ledger row is committed, **once per payment and never on a
duplicate** — the alert beside it learned that lesson the hard way.

It documents; it does not move money and it rewrites nothing.
`retainer_payment` is never touched and no rate-sheet term is altered. Where a
document is on file its id, hash and terms are named, read back from the record;
where none is, the line is absent rather than "none".

## D11 — the visible presets are a display decision, not a pricing change

Two presets plus Custom, per the owner. `RETAINER_STANDARD` is unchanged and is
still its own name — a list's ORDER is a display decision, which figure is
STANDARD is a pricing fact, and that separation is exactly what let the smaller
figure go first without moving what the office is told is standard.

**Nothing was removed from the backend.** Custom takes any figure,
`agreedRetainer()` reads what a case actually agreed, and a case carrying a
retired figure keeps it.

## D12 — the type control sets the context; it does not reinterpret one

`wizContext` remains the ONE reader of what a send is. The control rewrites the
same three fields the card does — `sheet`, `context`, `legal` — so every
downstream rule keeps working off the answer it already used.

Switching type **drops** the choices belonging to the old product rather than
carrying them across. A stale legal service on a private send, or a consumer
payment option on a carrier send, is how something nobody chose goes out.

**Withdrawn on a send opened from a lead.** That wizard's type is the case's own
recorded kind; letting the screen override it would let a carrier be emailed a
consumer rate sheet, which `CONTEXT_TAKES_PAYMENT` exists to make impossible.

## D13 — the preserved document renders sandboxed

The stored HTML is composed by our own Worker from escaped values and is safe by
construction — and it is put behind `sandbox` with no `allow-scripts` anyway,
because "safe by construction" is a property of *today's* composer and this is
the portal's own origin, where the session cookie is sent. The same reasoning
`inlineSafeType()` already applies to an uploaded file: decide what may run,
rather than trusting what was stored.

## D14 — the mirror pin was made true, not weakened

The Assistant's rate-sheet rehearsal is pinned byte-for-byte against the real
send. A per-send random reference cannot be reproduced by a rehearsal, and a
preview showing a reference that will never exist would be the portal asserting
something untrue — so the rehearsal carries none, the pin compares with that one
field normalised out, and **two new assertions state what each side carries**:
the real send has a reference, the rehearsal has none, and the reference is the
id the send recorded. A real send that stopped stamping its door fails there, and
so does a rehearsal that starts inventing one.

---

## What this unit deliberately does NOT do

- **No acknowledgement checkbox.** The owner's decision; see D6.
- **No inference of any kind** about which document a submission belongs to.
- **No client email from the resend route**, structurally.
- **No second send-history row** for an office copy.
- **No pricing change.** The visible preset list moved; no figure did.
- **No purge.** Every table here is additive and every row is kept.

---

## Setup

**Adding these four tables means a manual `portal-setup.yml` dispatch after
merge.** Until it runs: sends still work exactly as before (the document record
reports `not_recorded` with its reason, the Unit 11 rule), the attempt guard
degrades to "never block a send", the acceptance link is skipped, and the
document routes answer 503 naming the workflow.
