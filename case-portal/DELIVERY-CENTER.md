# Client Delivery Center — designed from the audit, 2026-08-21 (Unit 16)

**The owner's own spec exists** — `CASEBUILD.md` § "COMPLETED CASE / DELIVERY
CENTER": *"CLIENT DELIVERY panel: case, report ready, photos, videos, link
active, invoice sent, delivery status. Future: COPY DELIVERY MESSAGE · MARK
DELIVERED · SEND THROUGH CLIENT PORTAL. Never auto-email evidence."* That
paragraph is the brief; this file records what already satisfies it and what
this unit adds.

## THE AUDIT

| Spec item | State before this unit |
| --- | --- |
| MARK DELIVERED | ✅ built — `POST /build/:id/delivered` on the package panel, stamped + build event |
| Final report / package downloads, video link with the classification gate | ✅ the Completed desk (`/completed`) |
| Reports & Packages desk (ready to build / finalized) | ✅ `deliveryView` |
| **One per-case DELIVERY row** — contents, link, invoice, delivered state together | ❌ scattered across three screens |
| **COPY DELIVERY MESSAGE** | ❌ nothing composes one |
| SEND THROUGH CLIENT PORTAL | deliberately absent — no client accounts exist, and inventing them is not this row |
| Never auto-email evidence | ✅ structural (no route emails evidence) — and this unit adds no send button |

## DERIVED DECISIONS

- **D1 — One read, `GET /delivery-center` (admin-only),** over cases that have
  ever opened a package: the newest build (version, status, finalized/
  delivered stamps with names), its contents by role from `build_items`, the
  filed-PDF fact from `build_events`, the video-link fact through the SAME
  classification-gated shape `/completed` uses (never a second, looser copy of
  that rule), the invoice summary, and the send history count. Children
  resolve through parent subqueries; the list is LIMIT-bounded; nothing is
  written.
- **D2 — Delivery status is DERIVED, never stored**: Delivered (stamp) →
  Ready to deliver (finalized, unstamped) → In preparation (draft build) —
  a second status column would drift against `case_builds`, which already
  holds the truth.
- **D3 — COPY DELIVERY MESSAGE is composed text on the page, copied by hand.**
  Deterministic, client-safe: the case number, the package version and its
  contents in counts, the delivery-link line only when a link is actually
  offerable, the invoice line only when one was sent. **No rate, no internal
  wording, no classification vocabulary** (asserted). It is a clipboard
  action and nothing else — the owner's "Never auto-email evidence" means the
  Center gets NO send button of any kind.
- **D4 — It lives on Reports & Packages**, the screen the owner's spec names,
  as the leading card — not a new nav item. Three states kept apart on its own
  read.
- **D5 — No schema, no portal-setup.**
- **D6 — Deferred, named:** SEND THROUGH CLIENT PORTAL (no client accounts
  exist; a delivery portal is its own owner decision); any delivery-method
  record beyond the existing delivered stamp (a `delivery_method` column is an
  owner vocabulary decision).
