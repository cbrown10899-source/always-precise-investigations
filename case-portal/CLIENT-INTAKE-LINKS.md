# Private client intake links — Prepare & Send Client Intake

Owner brief 2026-11-04 (with a scope restriction the same day: the API portal's
private-client intake workflow only; nothing else changed). Internal note — this
directory is never deployed.

## What it does

1. **Office (phone or desk):** Home → **Prepare & Send Client Intake** (or the rail's
   **Client Intakes**, or the private Rate Sheet card's *Prepare client intake with
   retainer*). Enter name, mobile number, optional email; choose a retainer
   ($1,600 … $4,000, or Custom); **type the non-refundable amount for this client**;
   both show in the summary as typed; tick the confirmation of both amounts;
   **Create Secure Client Link**.
2. **Send:** **Text Client** opens the phone's messages app (`sms:` link) with the
   number and the owner's message; **Copy Link**; **Email Client** (Resend, when an
   address was given and email is configured). The portal records that the composer
   was *opened* — never that a text was delivered.
3. **Client:** opens `/intake/client/#k=<token>` on their phone, eight steps, the
   terms on step 7 (read-only, acknowledged), and step 8 shows every figure again
   **above** the authorization and the drawn signature.
4. **Back in the portal:** Client Intakes lists Drafts / Sent / Viewed / Submitted /
   Reviewed / Expired-revoked, searchable by name or phone. *Open submission* shows the
   completed document; *Download completed PDF* writes it through the portal's one PDF
   writer. The intake is also an ordinary signed private intake on the Intakes desk.

## Decisions

- **D1 — The non-refundable amount is the office's own figure** (owner's final
  revision, 2026-11-04, which overrides an earlier 50% rule). A separate required
  field, never calculated: `clientIntakeNonRefundable` accepts a dollar/cents amount,
  zero or more, no more than the retainer, and refuses anything else by name
  (`non_refundable_required`, `bad_non_refundable`, `non_refundable_over_retainer`).
  A draft may leave it blank (stored NULL, and the draft then shows no terms rather
  than an invented figure); a link cannot be made without it. Integer cents, parsed
  from strings; a test fails if the money rules derive it from the retainer.
- **D2 — The terms have one writer** (`clientIntakeTerms`), composed from the link ROW.
  The page renders it, the submit route recomputes it and refuses a submission whose
  SHA-256 differs (`terms_changed`), and the stored `accepted_terms` is that same JSON.
  Nothing reads an amount from the client. Wording follows the private rate sheet's;
  unused balances, additional charges and refunds are left to the services agreement and
  applicable law, in so many words — no new financial policy.
- **D3 — Terms lock when the link exists.** Drafts are editable; once a token is minted,
  changing figures means revoking and preparing a new one (`terms_locked`). The UPDATE
  that mints a token carries `token IS NULL`, so two taps cannot mint two.
- **D4 — Token: 256 bits, in the URL fragment.** A fragment never reaches a server, a
  Referer or a link-preview fetch, so a preview bot cannot read the terms or mark the
  link "viewed". The link names no client, case or amount. Links last 30 days; Resend
  renews the same link; Revoke ends it.
- **D5 — One link, one case, structurally.** The submit is one D1 batch where every
  write is conditional on this attempt owning the claim (`submitted_at IS NULL`,
  `submit_attempt`). A retry with the same attempt key answers with the same case; a
  different attempt is refused `already_submitted`.
- **D6 — The submission is an ordinary private intake.** `submissions` row,
  `kind='consumer'`, `assignment:'private'`, the fieldwork mapped to the keys the
  existing screens and `FIELD_KEEP` read (subject, objective, schedule, notes), the
  client's full answers under `client_intake` (admin-only by the allow-list default), the
  signature under `signature`. The office is alerted through `notifyAdmins` (no client
  detail in the alert).
- **D7 — The case's agreed retainer is the signed one.** A `case_retainer` row is
  written for the fresh case, inside the same transaction, so invoices and Record
  Payment draw against what the client signed rather than the standard figure.
- **D8 — The signed-terms record is evidence.** `client_intake_link` is
  `INTAKE_EXEMPT` (neither blocks nor dies with a quick delete), like
  `document_acceptance`.
- **D9 — The PDF is the portal's one writer.** `#cidoc` is the document; a canvas-drawn
  navy banner and a signature set on a wide white line are images, the footer is the
  writer's optional hook. The signature block restates the accepted figures, so a page
  break can never separate the pen from the terms. A blank printable intake uses the
  same renderer.
- **D10 — Home grows no taller.** The card is the eighth in a grid that had one empty
  cell; deep bronze ground `#6b3f1d` (white 8.92:1, closest other ground 40.5 dE). No
  photograph yet — a ground-only card, which the art system allows.

- **D11 — Rate-sheet carry-over (2026-11-04).** The private send wizard offers
  *Prepare a signed client intake with this retainer instead*: it carries the client's
  name, phone and email and the retainer chosen there (a preset when it matches one),
  and the non-refundable amount only if one was typed there. It creates nothing.

## Send Payment Options (owner brief 2026-11-05)

- **P1 — The accounts are the configured ones, read live.** `paymentOptionsFor` in the
  private context is the one reader: `$TreverB` → `https://cash.app/$TreverB`,
  `@Trever-Brown-9` → `https://venmo.com/u/Trever-Brown-9` (the `PAY_METHODS` defaults,
  overridable in Settings → Private client payment methods). Nothing stores a handle or
  a link; a method switched off is refused `payment_method_off`, one switched on with no
  valid link `payment_method_unusable` — never guessed.
- **P2 — Include Payment Options With Intake** is `client_intake_payopt` (link id →
  method list), written by `cilSavePay` with the link and fixed with its terms. The
  client is shown PAYMENT OPTIONS — agreed retainer, non-refundable portion, a Pay with
  … button per method — on the confirmation screen and again if they reopen a submitted
  link; the terms step says they come after signing. The buttons are ordinary links.
- **P3 — The message has one writer**, `paymentMessageText`, the owner's wording.
  `POST /payment-options/message` composes it and writes nothing: with a prepared intake
  the retainer is that intake's agreed figure (a typed one is ignored), with none it is
  typed or left out. A revoked intake's figure is not quoted.
- **P4 — Text is the phone's composer.** `sms:` with the number and body;
  `POST /payment-options/shared` records `payment_text_opened` / `payment_copied` on the
  intake's trail when there is one, and nothing otherwise. It does not touch the link's
  own shared status and is never written to `payment_send`, whose `ok=1` rows draw as
  "Payment instructions sent" — a composer opened is not that.
- **P5 — Nothing is paid by offering payment.** No route here reads or writes
  `retainer_payment`, `case_retainer` or `invoice_payments` (asserted by row counts).
  The submitted intake's record has *Record payment received*, the existing
  `leadRecordPay` door to the case's Record Payment form.
- **P6 — Doors:** a plain *Send Payment Options* card under Quick Tools → More (no art,
  by data), the Client Intakes header, the link-ready panel and a prepared intake's
  record.

## Schema

`client_intake_link`, `client_intake_event`, `client_intake_payopt` — additive, no CHECKs, guarded through
`missingTables()`, in `EXPECTED_TABLES`, swept by `DEMO_SWEEP`. **Adding them means a
manual `portal-setup.yml` dispatch after merge**; until then the office route and the
public route answer 503 naming the workflow, and nothing else changes.

`client_intake_payopt` arrived after the first two (2026-11-05) and needs its own
dispatch. Until it runs, intakes work exactly as before, the stand-alone message works,
and only *Include Payment Options With Intake* answers 503 naming the workflow.
