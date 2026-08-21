# Retention Controls — Unit 17

The audit ran first (2026-08-21, findings delivered in chat: ten sections —
existing capability, automatic-deletion findings A–E, absent hold concept,
state mapping, audit-schema gaps, authorization chokepoints, panel placement,
Dropbox coupling, the additive schema, and seven stop items). The owner
answered the seven stop items the same day. **Their decisions, verbatim:**

> 1. Retention states:
>    Active
>    Retain Until
>    Archived
>    Scheduled for Deletion
>    Deleted / Destruction Recorded
>
> "Deleted / Destruction Recorded" is an audit state only for now. It does NOT
> authorize physical file destruction.
>
> 2. True purge:
>    NO true purge of production case/evidence data in Unit 17. Preserve the
>    existing tombstone/recoverable model. Do not physically delete Dropbox
>    files or evidence bytes.
>
> 3. Retention duration:
>    NO automatic retention period or clock yet. Admin sets or clears Retain
>    Until manually. A passed date becomes RETENTION REVIEW DUE only. Never
>    auto-delete.
>
> 4. Legacy R2 video:
>    Leave the existing legacy R2 question unchanged. Do not migrate, purge,
>    or create new R2 storage in this unit. Dropbox remains the approved
>    permanent file-storage direction.
>
> 5. Legal hold:
>    Add a legal/preservation hold. A hold BLOCKS scheduling deletion,
>    deletion/destruction, purge, or evidence removal. It may still allow
>    archive, restore, billing, reporting, and ordinary read access. Hold
>    outranks retention/deletion state.
>
> 6. Dropbox retention:
>    Retention controls are records/state only for now. Do NOT policy-delete
>    Dropbox bytes. No automatic Dropbox deletion.
>
> 7. Hold permissions:
>    Admin-only may place or release a hold. No two-person approval
>    requirement in this version. Every place/release action must be audited
>    with actor, timestamp, reason, and prior/new state.

## DERIVED DECISIONS

- **D1 — The five states are DERIVED, never stored as one value.** Active is
  the absence of markers; Retain Until is `case_retention.retain_until`;
  Archived is the existing `case_archive`; Scheduled for Deletion is
  `case_retention.schedule_state = 'scheduled'`; Deleted / Destruction
  Recorded is the existing `case_deleted` tombstone — the recoverable model,
  untouched, exactly as decision 2 requires. Display precedence: Deleted >
  Scheduled > Archived > Retain Until > Active. The hold is ORTHOGONAL — a
  banner and a gate, not a rung on the ladder — because decision 5 says it
  outranks the state while leaving archive/restore/billing/reads alone.
- **D2 — RETENTION REVIEW DUE is computed against today on every read**, the
  `overdue` rule from invoices: a stored flag would go stale, and decision 3
  says a passed date changes NOTHING but the wording.
- **D3 — Scheduling deletion is a RECORD OF INTENT.** It deletes nothing,
  destroys nothing, starts no clock, and the panel says so in words. The only
  thing it changes is the state the office sees and the audit trail.
- **D4 — The hold is enforced AT THE WRITERS, server-side**: `/cases/:no/delete`
  refuses 409 naming the hold; `/cases/:no/retention/schedule` refuses;
  `deleteEvidence` refuses (decision 5's "evidence removal"). Archive,
  restore, undelete, billing, reports and every read are untouched. A page
  hiding a button is not enforcement.
- **D5 — Three additive tables, the audited design**: `case_retention`
  (current retention facts, one row per case), `legal_hold` (the CURRENT
  hold; one active per case), `retention_event` (append-only audit —
  action, prior_value, new_value, reason, actor, at — the prior/new/actor/
  reason record the audit found missing). Companion tables, no CHECKs,
  guarded through `missingTables`, in `EXPECTED_TABLES`, swept by
  `DEMO_SWEEP`. **One manual `portal-setup.yml` dispatch after merge.**
- **D6 — Reason is REQUIRED on hold place AND release** (decision 7 audits
  both), optional on retain-until and scheduling (the audit trail still
  records who/when/prior/new; requiring prose for a date change would train
  people to type "x").
- **D7 — The panel lives beside the closing checklist** (Billing & closing),
  the audit's recommendation: retention is the step after closing, and the
  archive/delete controls it surfaces already live in the Admin area. It
  reuses the EXISTING archive/restore/delete writers — no second writer for
  any action that already has one.
- **D8 — Deferred, named:** any physical destruction (decision 2), retention
  clocks/policies (decision 3), Dropbox byte deletion (decision 6), the
  legacy R2 export (decision 4), two-person hold approval (decision 7).
- **D9 — The archived write-gate passes the retention family** (`archive|
  restore|retention|retention/schedule|retention/unschedule|hold|hold/release`),
  because these are lifecycle bookkeeping of the same class as archive/restore
  themselves: a hold must be placeable on a FINISHED case without un-finishing
  it, and scheduling deletion on an archived case is the ordinary sequence.
  **The deleted gate is untouched** — a deleted case refuses retention writes
  and restore-first is the intended answer, both asserted.
