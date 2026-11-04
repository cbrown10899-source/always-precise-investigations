# Private client intake links — Prepare & Send Client Intake

Owner brief 2026-11-04 (with a scope restriction the same day: the API portal's
private-client intake workflow only; nothing else changed). Internal note — this
directory is never deployed.

## What it does

1. **Office (phone or desk):** Home → **Prepare & Send Client Intake** (or the rail's
   **Client Intakes**, or the private Rate Sheet card's *Prepare client intake with
   retainer*). Enter name, mobile number, optional email; choose a retainer
   ($1,600 … $4,000, or Custom); the non-refundable 50% shows immediately; tick the
   confirmation; **Create Secure Client Link**.
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

- **D1 — Integer cents; the half rounds down.** `clientIntakeRetainer` is the one place
  the 50% rule is written: presets `d*50`, custom `Math.floor(cents/2)`. A retainer with
  an odd number of cents has no exact half in cents; rounding down favours the client by
  at most half a cent. Parsed as strings; no float multiplies money.
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

## Schema

`client_intake_link`, `client_intake_event` — additive, no CHECKs, guarded through
`missingTables()`, in `EXPECTED_TABLES`, swept by `DEMO_SWEEP`. **Adding them means a
manual `portal-setup.yml` dispatch after merge**; until then the office route and the
public route answer 503 naming the workflow, and nothing else changes.
