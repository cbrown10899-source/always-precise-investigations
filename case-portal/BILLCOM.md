# Bill.com — prepared, not connected

## Owner brief (substance, 2026-09-02)

Prepare the Legal and Insurance payment/rate-sheet architecture so Bill.com
can be enabled quickly once the account exists. Do NOT connect, do NOT use
fake credentials, do NOT expose Bill.com as usable without valid
configuration, do NOT invent a payment URL, account ID, vendor ID, API key or
email address, do NOT add it to Private, and do not disturb Mail Check, Cash
App, Venmo, invoices or Record Payment. Report afterwards exactly what
information is needed once the account is created, split into what may be
pasted into chat, what goes into secure configuration, and what to obtain
from the Bill.com dashboard.

## What already existed

Bill.com is already a RECORD-KEEPING concept here: `sent_to_bill` in
`INVOICE_STATUSES`, `billing_provider = 'bill'`, `external_payment_id`, the
BILL reference form on the invoice screen, and the `bill_ach` legal payment
arrangement. None of that calls anything, and none of it moved. Secrets in
this project live in Worker environment variables (`RESEND_API_KEY`,
`DROPBOX_APP_SECRET` — GitHub repository secrets applied by the deploy
workflow); non-secret billing configuration lives in `app_config` under
`billing_%`, edited at Settings → Invoice defaults.

## The architecture

**`billcomConfig(settings)` is the adapter boundary.** Everything Bill.com
passes through it: the sheet line, the send-wizard tick, the send gate, the
invoice link. It reads four non-secret settings — `billcom_enabled`,
`billcom_payment_url`, `billcom_org_id`, `billcom_environment`, all empty by
default — and answers `ready` ONLY when the enable word AND a syntactically
valid https link are both present. Half a configuration is not ready: an
enable word without a link, or an http:// link, offers nothing anywhere. It
calls no external API and holds no credential; a future full API integration
adds its secrets as Worker env vars read INSIDE this adapter and nowhere
else.

**Offered exactly where Mail Check is, one step behind it.** When ready: the
legal and insurance sheet cards gain the line `Bill.com — Electronic payment
instructions provided with invoice.` (`withBillcomLine`, applied at the
consumption points so the approved static sheets are untouched); the send
wizards show a second checkbox; `emailSheet` accepts `methods` containing
`bill_com`; the email's PAYMENT block renders the wording (never the URL —
the link is invoice-only, like the remittance address); `payment_send`
records it; legal/insurance invoices carry `billcom_url` (the typed link,
verbatim) and print a "Pay electronically via Bill.com" section. When not
ready: the wizard shows a disabled "Not configured" row pointing at
Settings, asking for `bill_com` refuses by name (`billcom_not_configured`),
and no sheet, email or invoice mentions Bill.com at all. Switching the
enable word off withdraws it everywhere at once.

**The boundaries did not move.** Cash App/Venmo still reach a firm or
carrier through no code path (a request carrying one beside `bill_com` still
refuses); a PRIVATE send asking for `bill_com` refuses by name; the private
sheet and private invoices never gain the line, the link or the checkbox.

## The final connection path

**Simple invoice/payment-link configuration**, based on this repo's
architecture: the portal is the operational record, BILL collects ("Sent to
BILL is not paid" is a standing rule), nothing here performs server-to-server
billing calls, and the owner's stack deliberately avoids new external
dependencies. Enabling is: type the enable word + the payment link into
Settings → Invoice defaults. A full Bill.com API integration (invoice sync,
payment webhooks) would be a separate future unit through this same adapter,
and only if the owner asks for it — its requirements are NOT specified here,
deliberately, because inventing Bill.com API facts is forbidden by the brief.

## What the owner supplies once the account exists

**A. Safe to paste into chat / type into Settings:** the enable word (ON),
the customer-facing payment link (https://…), the organization/account
identifier if one should print for reference, and "sandbox" or "production".

**B. Secrets — only if a full API integration is later wanted; never pasted
into chat, entered as GitHub repository secrets like RESEND_API_KEY:** any
Bill.com API key / client credentials / signing secrets.

**C. From the Bill.com dashboard:** the payment/receivables link Bill.com
gives customers to pay the firm, and (API-path only, later) whatever
developer keys their console issues.

## Enabling later

No code change, no deploy, no schema: Settings → Invoice defaults → type ON
and the link → every door opens at once. **Do not enable until the owner
says the account is ready** — their own instruction.
