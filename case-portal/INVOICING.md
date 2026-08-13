# Invoice System + BILL Handoff — Build Handoff (INTERNAL)

**Recorded verbatim in substance from the owner's handoff on 2026-08-13.**
Lives in `case-portal/` because this directory never deploys. Do not prune —
mark the ledger instead. Build AFTER the rate-sheet update (its handoff says
so).

Progress ledger:

| Phase | Status |
| --- | --- |
| 1. Core invoice system (db, numbers, create-from-case, line items, insurance + private fields) | not started |
| 2. Admin experience (review/edit, printable invoice document, dashboard, search/filter/statuses) | not started |
| 3. BILL handoff (Mark ready, BILL reference fields, Copy billing details, Mark sent, manual payment entry) | not started |
| 4. Financial controls (partial payments, adjustments, duplicate warnings, audit trail, closure) | not started |
| 5. LATER — verify BILL API, provider adapter, automated create/sync, client invoice portal | not started — do NOT build until core works |

---

## CORE OBJECTIVE

Add a professional invoicing system to the Admin Portal: create invoices
from cases, generate polished invoice documents, track status, support
insurance/commercial billing fields, let Admin move the invoice into BILL,
preserve the BILL invoice/reference number, track payment status, and be
structured so a future BILL API integration plugs in without a rebuild. The
portal does **not** process payments. Workflow:

CASE → CREATE INVOICE → REVIEW → GENERATE PDF → MOVE TO BILL → TRACK PAYMENT

BILL collects payment. The portal remains the operational record.

## BUILD ORDER

1 invoice database · 2 create-from-case · 3 review/edit · 4 professional
PDF · 5 dashboard + statuses · 6 BILL handoff fields · 7 payment tracking ·
8 future API-ready provider architecture. No live BILL API until the core
works.

## PRIORITY 1 — DATA MODEL

invoice_id, invoice_number, case, client, organization/billing contact where
applicable, invoice_type, issue_date, due_date, payment_terms, currency,
status, subtotal, adjustments, total, amount_paid, balance_due,
internal_notes, client_notes, created_by/at, updated_at.

INVOICE NUMBER — clean sequential, server-side, unique, e.g.
`API-INV-2026-0001`. Never the database id.

## PRIORITY 2 — CREATE INVOICE FROM CASE

A CREATE INVOICE button inside the case pre-pulls case info (case #, client,
claim #, service, authorization, amount). Admin reviews before creating.
Nothing auto-sends.

INSURANCE INVOICE FIELDS (support, don't require): carrier/TPA, adjuster
name/email, billing email, claim #, policy #, insured/employer, claimant,
date of loss, case #, client reference, PO #, authorization #, vendor #,
service dates, assignment type, billing terms, special billing instructions.

PRIVATE INVOICE FIELDS (simpler): client name, case #, service type, service
dates, retainer amount, amount applied, additional authorized time,
legitimate additional charges, balance due, payment terms. Do not force
insurance fields into private invoices.

## PRIORITY 3 — LINE ITEMS

Editable lines: description, quantity, rate, amount. A flat package bills as
one line ("24-Hour Surveillance Authorization — $3,300") — do NOT
auto-display internal per-hour math like 24 × $137.50. Additional authorized
hours are their own line (e.g. 4 × $150 = $600), clearly distinct from the
original authorization. A private retainer request is one line
("Investigation Retainer — $1,500") with the note "Retainer is applied
toward authorized investigative services" — never presented as a surcharge.

## PRIORITY 4 — STATUSES

Draft · Ready · Sent to BILL · Sent to Client (only if confirmed) ·
Partially Paid · Paid · Overdue · Void · (Write-Off later). RULE: "Sent to
BILL" never implies PAID — payment status is entered explicitly or synced
later.

## PRIORITY 5 — DASHBOARD

INVOICES joins Admin navigation. Cards: Outstanding (unpaid balance), Due
Soon (configurable days), Overdue, Paid This Month, Drafts. Table: invoice
#, client, case #, claim #, issue date, due date, amount, balance, status,
BILL ref, actions. Filters: draft/outstanding/paid/overdue,
insurance/private, client, date range.

## PRIORITY 6 — PROFESSIONAL INVOICE DOCUMENT

Branded (ALWAYS PRECISE INVESTIGATIONS + contact), INVOICE with number,
date, due date, terms prominent. BILL TO with carrier/TPA + adjuster/billing
department and the references that HAVE values (claim/case/authorization/PO/
vendor) — no blank labels. Service description, dates, qty, rate where
appropriate, amount. TOTAL DUE and BALANCE DUE prominent; partially paid
shows total / payments received / balance. Payment instructions are
configurable text, never hard-coded bank details ("Please remit payment
according to the electronic payment instructions provided with this
invoice."). Footer: "Thank you for choosing Always Precise Investigations."
+ "Please reference the invoice number and claim number with payment."
Requirements: mobile readable, professional, printable, no internal pricing,
no investigator compensation, no profitability, no internal notes.

## PRIORITY 7 — BILL HANDOFF

BILL HANDOFF admin section: MARK READY FOR BILL; record BILL invoice ID,
BILL customer ID, reference number, date sent, terms, due date, BILL status,
notes; MARK SENT TO BILL updates portal status without claiming
client-sent. VERSION 1 IS MANUAL: create → review → document → Admin enters
into BILL → records the reference → marks Sent to BILL → payment updated
manually. COPY BILLING DETAILS button formats the key fields for paste into
BILL (reduces double-entry). Optional generic CSV export later.

## PRIORITY 8 — PAYMENT TRACKING

Record payments: amount, date, method (ACH/card/check/wire/other),
reference, provider, notes. Multiple partial payments per invoice; balance
math sets Partially Paid / Paid. BILL payments store provider=BILL +
external payment id.

## PROVIDER ARCHITECTURE

Provider-independent fields: billing_provider (manual/bill/stripe/
quickbooks/other), external_customer_id, external_invoice_id,
external_payment_id, external_status, last_synced_at. Do not spread
BILL-specific names through the app. Do NOT assume API access, webhooks,
auth method, payment types, or pricing — verify against BILL's current
official docs before any live integration. Future phase: create BILL
customer/invoice from portal, receive status + payments, reconcile —
never overwrite local records because external data changed; keep the audit
trail.

## PORTAL IS THE CASE SYSTEM

The portal stays the source of truth (case, client, assignment,
authorization, services, reports, evidence, billing record). BILL is the
payment system. Case work, invoice creation, documents and tracking must all
work if BILL is unavailable.

## WORKFLOWS

INSURANCE: assignment received → rate/authorization confirmed (e.g. 24 hrs
$3,300) → work completed → admin reviews billing → create invoice → document
→ enter/send through BILL → record reference → payment received → portal
marks paid → case financially closed.

PRIVATE: retainer required $1,500 → payment request → received → retainer
balance $1,500 → investigative time applied → admin monitors balance →
additional authorization if needed. Do not force private retainers through
the insurance/BILL invoicing workflow; architecture allows a future direct
online payment provider.

## DO NOT MIX THE TWO RATE SHEETS

Insurance packages: 8h $1,200 · 16h $2,300 · 24h $3,300 · additional $150/hr.
Private: $1,500 retainer · $100/hr · 4-hour minimum · retainer applied ·
additional time only with approval. Invoices respect the case's rate sheet;
never convert one model into the other.

CREATE INVOICE FROM AUTHORIZATION — an insurance case with a 24-hour $3,300
authorization gets a one-click pre-populated invoice; Admin reviews before
saving.

## VALIDATION

Before Ready: client, invoice number, issue date, ≥1 line item, total,
billing destination, due date or terms. For insurance, warn (not
necessarily block) if claim #, PO, authorization #, adjuster, vendor # are
missing.

DUPLICATE PROTECTION — warn on same case/authorization/service period
("Possible Duplicate Invoice", admin confirms); never auto-block legitimate
supplemental invoices.

CREDITS/ADJUSTMENTS — support adjustment, credit memo, partial credit, void.
Never delete a finalized invoice; preserve the audit trail.

AUDIT TRAIL — created, edited, finalized, document generated, sent to BILL,
reference added, payment recorded, marked paid, voided, adjusted — with
user + timestamp.

## SECURITY

Admin: full access. INVESTIGATOR: **no access to client invoices** — no
billing rates, amounts, BILL references, payment status, revenue,
profitability. Future client portal (invoice list + document + payment link,
org-scoped) waits for tenant isolation.

## SETTINGS

Admin billing settings: company legal name, address, phone, email, invoice
prefix, default terms (insurance/private), payment instruction text, BILL
enabled/reference, invoice footer, tax/late-fee language if ever adopted. No
hard-coded company billing info scattered through the code.

## DESIGN / MOBILE

Existing portal look (navy header, gold accents, white cards, typography,
buttons, spacing). Admin can open a case, create an invoice, review the
amount and see payment status from a phone; complex editing may prefer
desktop but must function on mobile.

## FINAL INSTRUCTION

Build a strong internal invoice system FIRST. Do not make the firm dependent
on BILL. Version 1: CREATE → REVIEW → PDF → MOVE TO BILL → TRACK → MARK
PAID. Once proven, a live BILL integration automates the handoff without
changing the architecture.
