# The Client Record Packet

Owner brief 2026-09-08 ("CLIENT RECORD / CHARGEBACK PACKET"). One packet, built
from records the portal already preserved, for a client dispute, a chargeback
file, the office's own records or an accountant.

The brief's own limit is kept: **the packet compiles records. It does not
assert an outcome**, and nothing in it says the firm is owed anything, that a
chargeback will be won, or that a document is legally binding. A test greps the
rendered document for those phrases.

## What it is

`GET /cases/:no/record-packet` — admin-only, one read, **writes nothing and
emails nobody**. Nine tables that already existed. **No schema change, so no
`portal-setup.yml` dispatch.**

The page renders that answer twice: a preview of what is and is not in the
packet, and the document itself in `#crpdoc`, which is what both the PDF and
the browser's print dialog are made from — so paper and file cannot disagree.

## Derived decisions

**D1 — THE SNAPSHOT IS THE PRODUCT.** The rate-sheet section returns
`sent_document.body_text` / `body_html`, which are the bytes the mail provider
was handed. The packet block calls no rate-sheet renderer, and a source pin
enforces it. This is the one rule the unit rests on: a packet that *could* call
the renderer could rebuild yesterday's document from today's figures, and the
output would look perfect.

**D2 — TWO ABSENT STATES, KEPT APART.** "No rate sheet was ever sent" is
ordinary and says so in its own words. An **acceptance that names a document
whose row is gone** is a different fact — the link exists and the snapshot does
not — and only that one prints §12's exact sentence, *"Historical document
snapshot unavailable."* Rounding the second into the first is what §12 forbids.

**D3 — A LINK IS NOT A SIGNATURE.** A submission can carry its own door's token
and never have been signed. `acceptance.linked` is the raw fact; the preview's
Acceptance tick means a **signed** acceptance is linked. The first build ticked
on the link, which would have put a tick over a document nobody signed.

**D4 — THE STATUS KEYS ARE READ FIRST, ON THEIR OWN.** The intake's NOT
AVAILABLE YET list is built from the `<field>_status` keys directly. The first
build walked the value keys and looked sideways for a status, which only ever
finds one whose base key is also present — so a payload carrying
`claim_number_status` with no `claim_number` reported nothing at all, which is
precisely the case `INTAKE-NA.md` exists for.

**D5 — A PRE-CASE SEND HAS NO `send_log.case_no`.** That column is null unless
the office's typed reference resolved to a case, and a client is ordinarily
quoted **before** the case exists. So for the commonest path the **document**
is the send record — it learns its case at acceptance. Both arrays are on the
packet and the preview ticks on either. Asserting only `send_log` would have
demanded the portal misattribute a send.

**D6 — NOTHING IS TOTALLED FROM INCOMPLETE DATA.** `hours_recorded` sums only
the days that carry a number and is **null** when none do; `days_without_hours`
is reported beside it. A total that treated a running day as zero would be the
packet inventing a figure. A case with no work says *"No surveillance/work
activity recorded."* and is not drawn as broken.

**D7 — REQUESTED IS NOT COMPLETED.** The refund section reuses `closeoutMoney`
rather than restating it, so the status word is the ledger's own, *completed*
renders as **"Refund completed outside portal"**, and the document states in
words that the portal records refunds and does not move money.

**D8 — THE VOID IS SHOWN, NEVER APPLIED BY DELETION.** A corrected payment stays
on the packet with its reason, its actor and its instant. Historical records are
not altered to make a document tidier.

**D9 — THE PDF GOES THROUGH THE ONE WRITER.** `pdfFromDoc` gained an **optional**
footer argument (page number, case reference, generated instant). Every existing
caller passes none and emits byte-identical output, so there is still exactly
one PDF writer in the page — which a test counts. Both halves are asserted: the
footer present when passed, absent when not.

**D10 — IT IS NOT EMAILED, AND THERE IS NO CONTROL FOR IT.** §14 makes email a
*may*; a packet carrying a signature and the whole case narrative is not
something to wire into a send path in the unit that invents the packet. The
e2e counts send-shaped verbs over every visible control on the screen and
requires zero. Adding it later is a separate decision with its own
confirmation, and it must never be silent.

**D11 — ADMIN ONLY, AT BOTH DOORS.** The route checks the role and resolves the
case through `caseFor` before composing anything, so a case the caller may not
open answers 404 rather than a packet about it. An investigator gets 403; an
anonymous caller 401. Reads stay open on a tombstoned case deliberately: a
dispute over a deleted case is exactly when this packet is wanted.

**D12 — THE ENTRY POINT IS THE CLIENT RECORD AREA AND NOWHERE ELSE.** Secondary
by weight, one instance, and **not on Home** — the packet is about one case, and
a door on Home would have to ask which. Asserted from both sides.

## The fuller brief (2026-09-08, second pass) — D13–D19

**D13 — EVERY GENERATION IS A ROW, AND A ROW IS NEVER OVERWRITTEN.**
`packet_generation` records the packet, not its contents: filename, the digest
of the file the operator received, the exact rate-sheet document and its own
hash, the submission, the payment/refund/day ids, and what the preview said was
included. A regeneration is a NEW row — the owner's own line. There is no
UPDATE and no DELETE in the route, and a source pin says so.

**D14 — THE DIGEST IS TAKEN IN THE BROWSER, because that is where the PDF
exists.** The Worker never sees the file. A value that is not a SHA-256 is
refused BY SHAPE and the response answers `hash_recorded: false` rather than
storing junk as though it were real — the `evidence_integrity` rule.

**D15 — THE RECORD IS WRITTEN AFTER THE FILE EXISTS.** A row written first
would claim a packet the writer then failed to produce. It also cannot cost the
download: the file is already on disk when the record is attempted, so a failed
record is reported beside the successful download rather than turning it into
an error.

**D16 — THE PACKET REPRODUCES THE ACCEPTED DOCUMENT** (§25F), not the newest
send. A packet showing a later rate sheet while the signature belongs to an
earlier one is the single most misleading thing it could do. The other sends
stay in the delivery record.

**D17 — THE CASE TIMELINE GETS ONE LINE, AND NO IDS** (§22). What, who, when.
The technical ids stay in the packet's own record, which is the brief's own
distinction. A FAILED generation is kept as a row but is not a case event —
"somebody's download did not finish" is not part of the case's story.

**D18 — DOWNLOAD-ONLY, AND SAID SO ON SCREEN** (§17). The brief's *preferred
behavior* is exactly this: generate, hash, the owner saves it, and the
generation metadata plus source ids are retained. The PDF itself is not stored,
because putting a signature-bearing document into Dropbox is a new artifact
class and a decision of its own. The GENERATED PACKETS box states it in words
rather than leaving it to be assumed.

**D19 — EMAIL IS NOT BUILT, AND THE REASON IS A FACT** (§20). `sendMail` takes
`{to, subject, text, html}` and has **no attachment support**. Adding one means
changing the single sender every send route uses, and uploading the
browser-built PDF to the Worker so it has bytes to attach. That is the
disproportionate case §20 anticipates. Building it later is its own unit with
its own confirmation, and it must never be silent.

## Filename

`<case number>-Client-Record-Packet-<YYYY-MM-DD>.pdf`

Case numbers already begin `API-`, so the first cut's own `API-CASE-` prefix
stuttered it twice; the owner's shape is `API-[CASE-NUMBER]-…`, which the case
number itself satisfies. The date is the day the packet was generated, which is
what the cover says too, so the filename and the document agree — and a second
packet the same day gets `-2`, counted from the generation records, so two
downloads never land on one name in a folder.

## Deliberately excluded

- **Email.** D10.
- **The files themselves.** §10 asks for an index; evidence, reports, packages
  and timestamped media are listed by name, label and count. No bytes are
  embedded and no Dropbox call is made.
- **Anything not already recorded.** No derived narrative, no reconstructed
  terms, no inferred acceptance.
