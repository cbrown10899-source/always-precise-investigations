# Mail Check — Legal and Insurance payment option

## Owner brief (verbatim, 2026-09-01)

> Update Always Precise payment options for LEGAL and INSURANCE only.
>
> Add "Mail Check" anywhere Cash App/Venmo payment choices are shown for the
> Legal and Insurance rate-sheet/payment flow.
>
> Rate sheet wording:
> Mail Check
> Mailing instructions provided with invoice.
>
> Do NOT place the full mailing address on the rate sheet or other
> public-facing pages.
>
> For invoices:
> - When Mail Check is an available/selected payment method, show the proper
>   check remittance section on the invoice.
> - Use an existing configured business/remittance address if the app already
>   has one.
> - Do NOT invent an address or expose a personal address.
> - If no mailing/remittance address exists in the current configuration,
>   leave the rate-sheet option working and report that the address still
>   needs to be supplied before enabling it on invoices.
>
> Also add "Mail Check" to the appropriate Record Payment/payment-method
> dropdown for Legal and Insurance if those methods share the existing
> payment system.
>
> Preserve all existing Cash App, Venmo, invoice, and billing behavior.
> Do not change Private payment settings or unrelated features.

## What the audit established

**Cash App/Venmo choices are never shown on legal or insurance flows** — that
is the standing locked boundary (`CONTEXT_TAKES_PAYMENT === PRIVATE`; "Cash
App and Venmo reach a law firm through no code path", LEGAL-INTAKE.md). So
"anywhere those choices are shown" resolves to: the places the legal and
insurance flows PRESENT payment ways — the sheet documents and the recording
dropdowns — and Mail Check joins THOSE, without the consumer payment block
gaining a path to either context.

**No mailing/remittance address exists in the configuration.**
`BILLING_DEFAULTS` carries the company name and the DCJS/phone line only; no
`app_config` key, no payment_methods row, no page constant holds an address.
The brief's fallback branch therefore governs the invoice half.

**`invoice_payments.method` carries a CHECK constraint**
(`ach|card|check|wire|other`). Widening a CHECK is the non-idempotent rebuild
`schema.sql` cannot do (the `build_custom` rule), so a new stored method value
cannot exist there. `retainer_payment.method` has NO check — the Worker's
`RETAINER_METHODS` list is the validation — so a genuine new value can.

## Derived decisions

**D1 — One line, one writer.** `MAIL_CHECK_LINE` in `worker.js` is the
owner's wording verbatim (label "Mail Check", note "Mailing instructions
provided with invoice.", value "Accepted") and is carried by the insurance
sheet's `lines` and appended to the legal card's copy of the private lines.
The PRIVATE sheet object itself is untouched, and no sheet, email or preview
can carry an address — the line has nowhere to put one.

**D2 — The remittance address is configuration that starts empty.**
`BILLING_DEFAULTS.remit_address = ''` makes it editable through the existing
`/billing-settings` route and the Settings → Billing form (new "Check
remittance address" field). Nothing seeds it, nothing derives it. The
invoice document prints "Remit checks to" ONLY when the Worker attached
`remit_address` — which it does only for a legal- or insurance-context
invoice AND only when the trimmed configured value is non-empty. A private
invoice never carries the field: absent, not blank. Decided in
`invoiceWithMoney` from the case's typed kind and legal marker
(`contextForSub`), never by the page.

**D3 — Recording vocabulary.** The legal retainer recorder gains a real
`mail_check` method (`RETAINER_METHODS` + label), offered in the page only on
a legal case (`WS.legal`); the private recorder's options are unchanged. The
invoice payment dropdown gains a "Mail Check" OPTION on non-private invoices
that stores the existing `check` instrument — the truthful reading of "if
those methods share the existing payment system", and the only one the CHECK
constraint permits without a forbidden rebuild. The stored record says
"check", which a mailed check is.

**D4 — What did not change.** `CONTEXT_TAKES_PAYMENT`, `sheetTakesPayment`,
`/payment-options/email`'s refusals, every Cash App/Venmo path, the private
sheet, private invoices, and all invoice arithmetic. The legal payment
ARRANGEMENTS (which already include check-by-mail as a request) are
untouched — this unit is presentation and recording vocabulary on top of the
same model.

**D5 — The tickable option on a send (owner, 2026-09-02).** The legal and
insurance send wizards offer exactly one payment checkbox — **[ ] Mail
Check** — in the same pattern as the private wizard's method boxes, unticked
by default so an unsent option is never advertised. Ticked, the email gains a
PAYMENT block rendered by `mailCheckBlockText/Html` — deliberately NOT
`paymentBlockText`, whose opening retainer sentence must never reach a firm
or carrier — reading exactly `Mail Check — Mailing instructions provided
with invoice.` The Worker accepts `include_payment` with methods
`['mail_check']` on a non-private context and NOTHING else: Cash App or
Venmo in the same request still refuses (`legal_no_payment_block`), and a
PRIVATE send asking for mail_check refuses by name
(`mail_check_not_private`). The send is recorded in `payment_send` as
`mail_check`, the response names it, and the page's confirmation does not
chase a retainer for it.

## Owed to the owner

The remittance address itself. Until it is typed into Settings → Billing →
"Check remittance address", rate sheets carry the Mail Check line and
invoices print no remittance section — exactly the degrade the brief
prescribes. No schema change anywhere in this unit; no portal-setup dispatch.
