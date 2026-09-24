# The FULL CUSTOM private agreement

Owner brief 2026-09-23, §1–§24. *"Give Corey an OWNER-ONLY FULL CUSTOM Rate
Sheet mode for unusual private-client agreements without changing the existing
standard Private Rate Sheets."*

The brief's own risk is in §1 and §17: the standard Private sheets must not
move. Everything below is arranged around that.

## The architecture in one sentence

**FULL CUSTOM is a per-send DOCUMENT variant on the private context, which is
the `legalFixedSheet` shape one context over.** A fixed legal service already
swaps a different sheet object into the same send route — same renderer, same
styling, same email, same `sent_document` record — chosen for that one send and
writing nothing back to the product. This is that, for private.

So `rateSheets()` is untouched and remains the only place a standard figure is
set; `PERSONAL`, `RETAINER_PRESETS`, `RETAINER_STANDARD`, `nonRefundableFor`
and `engagementBlock` are exactly as they were. A send that does not carry a
`custom_agreement` is byte-identical to one made before this existed, and that
is control flow rather than a promise.

## Derived decisions

**D1 — It is a document, not a product.** `privateCustomSheet(spec)` returns
`id: 'private_retainer'` exactly as `legalFixedSheet` does: the id is the
PRODUCT the route is addressed by, which is what keeps `sheetTakesPayment`,
`contextForSheet` and the context allow-list answering as they always have.
What is custom is the document, never the door.

**D2 — `customAgreementSpec` is the one validator and the one calculator.** The
`nonRefundableFor` principle: the send, the Assistant's mirror and the office's
record copy all resolve through it, so there is no second place for the
arithmetic or the refusals to differ.

**D3 — The money multiplies in integer cents.** §3 forbids unsafe
floating-point currency math. The project's existing pattern is
`Math.round(x * 100) / 100`; this does the multiply while the rate is an
integer number of cents, which is a strictly stronger thing. `$16.10 × 7` is
`112.70000000000002` as doubles and `11270` cents exactly. A round-at-the-end
that happens to work on the demo figures is not the same as arithmetic that
cannot go wrong.

**D4 — An override is obeyed, marked, and never recalculated.** §4. The spec
carries `total_hours` / `total_due` as sent AND `computed_total_hours` /
`computed_total_due` beside them, with two flags. A record that kept only the
override could not answer later what the arithmetic had said. Typing the figure
the calculation already produced is not an override, and the flags say so.

**D5 — Off means absent.** §5. A term not ticked produces no line, no label and
no placeholder — and nothing standard in its place. A term ticked without its
figure is REFUSED BY NAME rather than defaulted, which is §18's "do not
silently convert blank optional terms into defaults" enforced rather than
remembered.

**D6 — The minimum is the owner's number and `PERSONAL.minHours` is never
read.** §6, twice, "this is critical". A source pin asserts the builder does
not reference it. Forcing four hours onto a custom agreement is exactly what
the mode exists to step around, and a document saying four when the office
agreed six is worse than one saying nothing.

**D7 — `NON_REFUNDABLE_DEFAULT` is never consulted either.** §7. The standard
product's rule is that the amount must never disappear for being left blank;
this product's rule is the opposite — absent unless asked for. Quietly
inserting $500 is the "hidden standard term" §5 names. It is still capped at
the total, the same coherence rule one product over, refused by name rather
than clamped. Zero is honoured, because typing it is a deliberate act.

**D8 — The word "retainer" reaches the document only when chosen.** §8. The
payment description is `total_due` / `retainer` / `custom`, and it decides the
engagement line, the summary sentence, the closing and — the part that was
nearly missed — the PAYMENT BLOCK'S OPENING SENTENCE. `paymentBlockText/Html`
open with *"A $1,500 retainer is required to begin investigative services"*:
the standard product's sentence with the standard product's figure, which on a
custom send would have called an $1,800 total a retainer in the one block the
client pays from, and quoted the wrong number doing it. `customPayLead`
composes the replacement; the `lead` argument is optional and every existing
caller omits it, emitting byte-identical output — the `pdfFromDoc` footer
precedent.

**D9 — The terms read after the figures.** `engagement_last` on the sheet
object, honoured by `sheetEmail` in both MIME parts. Absent on every sheet that
existed before, and the standard documents are pinned byte for byte. Getting
this wrong is a whitespace-only line in the HTML, which is why the pin is on
the bytes and not on the wording.

**D10 — The preview is the Worker's, fetched.** §12. `wizCustomResolve` calls
`POST /assistant/prepare-sheet`, which is a pinned mirror of `emailSheet` held
byte for byte by the suite. So "no standard term may be silently inserted after
Preview" is a property of where the figures come from. A refusal does not
advance — the `wizRetainerSave` rule: previewing a document the sender would
reject is worse than staying on the form with the reason.

**D11 — The page's arithmetic is display only, and pinned.** The builder shows
`2 × 12 = 24 · 24 × $75.00 = $1,800.00` as it is typed, because that is §2's
whole shape. It uses the same integer-cent multiply, and the suite drives the
real form at three rates — including two that break in floating point — and
compares the screen to the Worker's own answer. Two calculators kept in step by
a test is a shape this project distrusts; here the document is only ever the
Worker's, so what the test protects is a screen that agrees with it.

**D12 — `sent_document_custom` is a companion table.** §13. `schema.sql` is
re-applied on every portal-setup run and `ALTER TABLE ADD COLUMN` is not
idempotent — the `build_custom` / `legal_intake` / `activity_removed`
reasoning. `agreement_type` carries no CHECK (the Unit 7 rule).

`sent_document` ALREADY preserves the document: `subject`, `body_text`,
`body_html` and `content_hash` are the bytes the provider was handed, so
"historical documents are never rebuilt from current settings" does not depend
on the new table at all. What it adds is the BUILDER'S INPUTS — what was typed,
what was overridden, which terms were ticked — so the record answers *why the
document says that*, not only *what it says*.

**D13 — A custom send refuses by name until portal-setup runs.** A FULL CUSTOM
document whose figures were never recorded is precisely what §13 exists to
prevent, and a send that quietly lost its record would be discovered by someone
asking months later what was quoted. The STANDARD sheets are untouched at that
seam and send normally, which is the half that matters.

**D14 — Nothing is written to `case_retainer`.** §4's "do not move money", one
layer down. The wizard's retainer selector is WITHDRAWN in this mode and
`wizRetainerSave` stands down, so previewing a custom agreement cannot re-cut a
case's agreed retainer as a side effect. **Open for the owner:** a custom
agreement therefore leaves no agreed figure on the case, so the invoice and
balance blocks have nothing to draw against. Recording the total as a
`case_retainer` row would mislabel it as a retainer — the thing §8 forbids the
document from doing — so it is left for a decision rather than taken.
*Resolved by D23 (owner, 2026-09-24): the case gains an AGREED AMOUNT read from
the agreement itself, and `case_retainer` still receives nothing.*

**D15 — Four refusals by name off the private path.** A custom agreement on a
legal or insurance send; beside a legal service; beside a `retainer_amount`;
beside the standard `non_refundable`. The `flat_fee` precedent: a figure
silently dropped because it arrived on the wrong send is a screen that accepted
something it did not use.

**D16 — The builder is inside the shipped editor.** §15/§16. It renders in
`.rsw-body`, so the background-scroll lock, the visual-viewport height, the
keyboard handling and the scroll restore that shipped on 2026-09-21 cover it
with no new code. Its text fields follow the `dsDirtyCtl` pattern — collect,
rewrite the derived total in place, NO repaint — because rebuilding the box
somebody is typing in is the defect already recorded against the package
Combined Summary and the invoice search.

**D17 — The minimum opens on no figure.** *SUPERSEDED by D18, the owner's own
spec, the same day; the reasoning is kept.* The select's first option was an
empty *Choose the minimum…*, so ticking the term chose nothing and the Worker
refused it by name until a figure was picked. The first build had opened on
four — a select with no empty option asserts a value nobody chose, the private
lead's Service picker defect — and it was found because a refusal test
advanced when it should have stopped.

## The checkbox term builder (owner brief 2026-09-23, "INCLUDE ON CLIENT RATE SHEET")

**D18 — The minimum field shows 4 when its box is ticked, and never at any
other moment.** The owner's spec draws it: *"If checked: show: Minimum Hours
Per Surveillance Day [ 4 ]"*, a free field taking 4, 6, 8, 12 *"or another
valid number"*. It replaces D17's empty select. The distinction D17 protected
survives: 4 is a figure ON SCREEN the moment the owner ticks, which is not the
same as a figure assumed behind their back. It is written only on the
minimum's own tick transition and only into an empty field. A value the owner
typed survives an untick and a re-tick, and **a field they clear stays clear**
— the Worker refuses the ticked term by name rather than anything filling a
four back in. Keyed off the box's own transition because the looser rule, "the
term is on and the field is empty", also fires when a DIFFERENT box is ticked,
and would refill a field the owner had deliberately emptied. Negative-tested
both ways. The figure is written in the page as the field's starting value and
is deliberately not read from the standard product: the custom builder never
consults `PERSONAL.minHours`, and a source pin holds that.

**D19 — Cash App and Venmo are rows in the same box, and they are the same
selection the standard send uses.** Bound to `w.payMethods` through the
`wiz-pm` class `wizCollect` already reads, so the owner's choice is one record
whichever mode drew the boxes and survives switching between them in both
directions (§3: *"preserve the owner's explicit Cash App / Venmo selections"*).
That selection's existing default — every configured method ticked — is the
owner's own onboarding decision and was not re-decided here. *The owner then
decided it for Full Custom explicitly — see D29.* **The standard
payment block is not drawn in FULL CUSTOM**: two sets of boxes for one choice
is the duplicate-door shape, and the negative test showed it concretely — both
sets feed the one collector, so the standard block's still-ticked boxes put
Cash App back into a send the owner had unticked it from. A method with no
payment link is drawn disabled and says so. In this mode the rows ARE the
decision: none ticked means no payment block, with no separate switch that
could still say yes.

**D20 — A ticked term always appears.** §4: *"If ON: the exact value
appears."* The first build let the figure decide: a ticked *Scheduled Days*
with no days typed quietly vanished, so the owner's selection and the document
disagreed with nothing on screen saying why. The Worker now refuses a ticked
schedule term with no figure by name (`custom_days_required`,
`custom_hours_per_day_required`, `custom_total_hours_required`), and the
selection IS the document's term list.

**D21 — The Preview follows the Worker's resolved term list, never the typed
figures.** The first build's summary line tested the typed value, so days
typed and then unticked still read *"2 days"* in a Preview whose document said
nothing about days. The summary line states the ticked SCHEDULE figures; the
money terms appear once, in the client-facing block, exactly as the client
reads them. No term appears twice and an unticked term appears nowhere.

**D22 — "Readable" is measured against the screen's own labels.** A first
assertion invented a 14px bar and failed term labels that are the portal's
standard size: every checkbox label and every field label in this wizard is
0.85rem, 13.6px, weight 600. The defect would be a term label smaller or
lighter than its neighbours, and that is what is asserted.

## Live setup, the agreed amount and the final cleanup (owner brief 2026-09-24)

**Live schema.** `portal-setup.yml` run #60 (id 35939502419, master at
`483eed1`) applied `schema.sql` to the live D1 database; every step green, the
first-admin step skipped by input because the account exists. The only
statement added since the previous run (#59, 2026-09-08) was
`CREATE TABLE IF NOT EXISTS sent_document_custom`. The live health check after
the apply answered `schema_missing: 0`, and `sent_document_custom` is in the
list that count is taken over — so D13's refusal no longer fires on the live
portal.

**D23 — The agreed amount is READ from the agreement, never stored twice.**
`caseAgreement()` reads the most recent successfully sent private rate sheet on
the case (`sent_document`, `ok = 1`, context `private`) joined to its custom
figures; if that sheet was a Full Custom agreement, its total is the case's
agreed amount. An index seek on `idx_sentdoc_case`. What follows from the
shape: the figure cannot drift from the document the client received; the
most recent offer governs (a later custom agreement replaces it, a later
STANDARD sheet returns the case to the retainer model — the rule the office's
own retainer pick follows); a pre-case agreement reaches its case when the
client signs through its door, because acceptance fills `sent_document.case_no`;
and nothing is written, so no historical row is touched and no schema change
or setup run is needed. The owner's words were "add/use a distinct case
financial value": it is its own field (`model: 'agreement'`, `term`,
`agreement`) on the case's money block, not the retainer column.

**D24 — The word is the owner's label on the agreement.** "Agreed amount",
unless the owner chose **Retainer** as the payment description, in which case
the case says Retainer — the brief's "existing retainer behavior may still
apply". The Worker publishes the word (`term`); the page asks only
`agreedMoney(r)` / `agreedRow(c)`, which are false for every retainer case, so
every retainer screen keeps its exact strings.

**D25 — The work arithmetic runs at the agreement's own rate.** A $75/hr
agreement drawn down at the standard $100/hr would read a third faster than
the client was told. `billed_at_rate` is the agreement's hourly rate unless the
case carries an explicit per-case rate, which still outranks it; `applied`,
`remaining` and "≈ hours remaining" follow (24 hours on the real agreement).

**D26 — Every place a private case's money is named was followed, not just the
case screen.** Overview; the Authorization panel (with the agreement it came
from) and its form; Edit case; the case actions button (*Payment received*);
the Client Record strip (which now states the figure, the owner's own request
here); Simple View's status row, money row, list words and intake-desk card;
the intake summary cell and ASSOCIATED RATE SHEET; the invoice document, the
invoice editor, the opening invoice line and the Assistant's invoice preview;
the closeout ledger, closed-case card and **the client's closeout statement**
(*Payment received*, and *Amount retained* rather than "Non-refundable
retained" unless the agreement stated a non-refundable portion); the record
packet; the closeout checklist fact; the attention list; the payment event
labels in recent activity, the audit trail, the case timeline and the office's
payment record copy; and the list columns, stripped for an investigator like
every other money column.

**D27 — Nothing writes the total into `case_retainer`.** The Edit case and
Authorization amount fields become read-only on an agreement case — an input
there would edit a column the agreement outranks, a control that changes
nothing on screen, and the one remaining way to file a Full Custom total as a
retainer. The Authorization form still saves the received tick alone. **One
thing was left as it was, on purpose:** recording a payment on a case with no
retainer row creates one, and that column is `NOT NULL DEFAULT 1500`, so it
holds the standard figure. That is the same as "no agreed retainer" for the
standard product, nothing reads it while an agreement governs, and writing the
custom total there instead would make a later standard sheet quote the custom
total as a retainer.

**D28 — One Send rate sheet on the Simple View intake screen.** The case
actions block (drawn on every case tab) and the Simple View bar both drew one.
`simpleBarShown()` is the one writer of "the bar is on this screen", read by
both; the case actions copy stands down there only. The bar's copy is kept
because it states whether a sheet already went ("Send new rate sheet"). Full
View and every other tab keep the case actions copy.

**D29 — Full Custom opens with Cash App and Venmo ticked.** The owner's
default, every configured method, set on entering the mode unless the owner
already chose in this wizard (`payTouched`, set by a real change on a payment
box) — so D19's preserved choice still stands. **Stated honestly:** the
wizard already ticked every configured method on opening, so today the rule
changes no outcome; it pins the Full Custom default independently of the
standard seed. Negative-tested both ways: with the standard seed removed the
rule alone still opens both ticked; with both removed the default fails.

**D30 — After a send, the case re-reads itself.** Found by the live-path walk,
not assumed: the case's document list was fetched once per session and never
again, so the intake screen went on saying *"none sent from the portal"*
straight after a send; and the open workspace kept drawing the pre-send money
model. The list is dropped for that case and the workspace reloaded (it
already refuses a late answer for a case you have left). The confirmation now
says the *agreed amount* is pending, not the retainer.

**D31 — The case's send history names the product, "Private Client".** It is
read from `send_log`, which holds the sheet id and nothing that tells a custom
send from a standard one; matching it to `sent_document` by time or address
would be inference, which this project refuses. The exact document, custom or
standard, is one tap away in ASSOCIATED RATE SHEET.

## Deferred, by name

- A second custom agreement shape (`agreement_type` is ready for one; no CHECK
  stands in the way).
- Surfacing the agreement's figures on the Client Record Packet as structured
  rows. The packet already reproduces the DOCUMENT from the stored bytes, which
  is what the brief asks of it.
- ~~Recording a custom total as the case's agreed figure — D14.~~ Done as D23,
  without a retainer row.
- ~~**Found and not fixed, outside this brief (the Legal no-regression line):**
  a FIXED legal case still meets the retainer word in three places.~~ The owner
  asked for it the same day: LEGAL-SERVICES.md D15–D22 (*Flat Fee Paid*, *Flat
  Fee Received*, *Legal Services Flat Fee* and every other surface), with the
  opening line's figure deliberately unchanged.
- **Four leftovers of this unit, corrected there (LEGAL-SERVICES.md D22)** —
  found because the flat-fee unit had the same lines open: the Simple View
  card's *Record retainer* on an accepted, unpaid agreement (now *Record
  payment*), the closeout form's *Non-refundable retained* label (now the
  statement's own word, so *Amount retained* where the agreement stated no
  non-refundable portion), the Billing panel's *Create from retainer* (now
  *Create from agreement*), and the Assistant's closeout sentence. The claim
  this file made — that a Full Custom case is never called a retainer — was
  wider than the code until then.
