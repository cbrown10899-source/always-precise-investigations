# Intake operations — alerts and archiving

Two owner additions, recorded verbatim in substance on 2026-08-14/15 while the
retainer payment unit was finishing. **Neither is coded.** This file is the
durable record so nothing is reconstructed from memory later.

The intake form is in production and **real people are using it.** Everything
below is written with that as the governing fact.

---

## 1. Real intake alerts

The office must be told when a real intake arrives, on a channel that reaches a
phone.

### What counts as real

Alerts fire for **genuine client submissions only**. They must never fire for:

- test intakes
- developer or test fixtures
- synthetic browser-test submissions
- seeded or demo records (the portal's built-in worked example included)

**A test intake producing a real email or SMS is the failure this feature is
most likely to have, so it is what the tests must prove cannot happen.**

### When it fires

Only **after the intake has successfully committed to the production
database**. An alert about a record that does not exist is worse than no alert:
it sends the office looking for a case nobody can open.

### Channels

- **Email** — required.
- **One dependable phone alert** — required. SMS where a provider is
  configured. PWA/web push may be added as an *additional* channel; it is not
  allowed to be the only dependable phone alert, because a push that depends on
  an installed PWA and a granted permission is not dependable.

### What an alert may say

**No sensitive client or claimant detail on a lock screen.** The alert says
that an intake arrived, whether it is **Private** or **Insurance**, and enough
to find it — not who, not what happened to them, not a claim number.

It must also **not expose investigator-restricted information**. `FIELD_KEEP`
is the existing boundary; an alert is not an exemption from it.

### Delivery, exactly once

- One intake = **one notification event**. Retries must not send duplicates —
  the retainer payment token in `worker.js` is the precedent for how that is
  enforced: claim and act in **one transaction**, and prove "already sent"
  rather than inferring it from an error.
- A status log per event: **queued / sent / failed / retried**.
- **A failed alert must never lose the intake.** The intake is the record; the
  alert is a notification about it. Alerting is fire-and-forget with respect to
  ingest, the same rule the Web3Forms/portal split already follows.
- An admin can **see that delivery failed**. A silent failure is the same as no
  alerting at all, only more expensive.

### Configuration

Destinations live in an **Admin Settings area**, not scattered through code as
literals. No credentials, tokens or provider secrets are stored by this work.

**Coding does not require the owner's secrets.** Build the safe configuration
boundary; stop only at the point where an actual provider account or secret is
needed to activate production sending.

---

## 2. Intake archive / sample cleanup — part 1 of 2

**Part 2 has not arrived.** Do not infer it.

### The rule

**Do not hard-delete intake records through the normal Admin UI.** Real
submissions are now in the table beside the early samples, and a delete control
that removes a row cannot tell them apart at the moment it is clicked.

### Archive Intake

Offered from the record's `•••` menu, in keeping with the compact edit/remove
convention. After archiving, the intake is removed from:

- dashboard lists
- New Intakes counts
- Needs Attention counts
- the active Intakes view

### What archiving preserves

The complete record and its audit/history, plus `archived_by` and
`archived_at`. This is the `activity_removed` shape again — a companion table,
not columns and not a delete. `schema.sql` is re-applied on every
`portal-setup` run, so `ALTER TABLE ADD COLUMN` is not available.

### Filters and restore

Filters: **Active / Archived / All**. An archived card is labelled **ARCHIVED**
and offers **Restore Intake**, which returns **the same record** — it does not
create a copy.

---

## Where these two meet

They interact, and the interaction is easy to get wrong in either order:

- **An archived intake must not raise an alert.** Archiving is how the office
  disposes of something; alerting about it afterwards undoes that.
- **Alerting must not resurrect an archived record into a count.** If the alert
  path touches the same counts the archive filter suppresses, a notification
  can put a disposed intake back on the dashboard.
- Whichever is built first must leave the seam explicit rather than assume the
  other's shape.
