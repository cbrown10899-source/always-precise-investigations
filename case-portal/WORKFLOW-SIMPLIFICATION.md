# OWNER WORKFLOW SIMPLIFICATION (INTERNAL)

**Recorded 2026-08-15, on arrival, before any of it was built** — the standing
rule in this repo is that a handoff is written down in `case-portal/` first.

**Queue position, in the owner's own words:** *"Queue this after the current
unit."* and *"[Queue after hig]her-priority work already running."* So this sits
behind the pre-case sends unit (queue items 2/3 + the PRE-CASE SENDS defect) and
behind anything already in flight. **Nothing below has been started.**

> **⚠️ THIS TRANSCRIPT ARRIVED TRUNCATED.** Many lines lost their leading
> characters in transmission — the same failure `PORTAL-OPS.md` records. Text in
> `[brackets]` is a **reconstruction**, not the owner's words. Everything else is
> verbatim. **Confirm every bracketed item before building it.** Where a
> reconstruction would change behaviour, it is flagged inline.

---

## THE ORDER, AS RECEIVED

```
OWNER WORKFLOW SIMPLIFICATION

Queue this after the current unit.

1. MANUAL PAYMENTS

Cash App/Venmo payments can be entered manually on a case.
Make Record Payment easy to reach.

Fields:
- Amount
- [Meth]od EXACTLY:
  - [Cash A]pp
  - Venmo
  - Check
  - [Cas]h
  - ACH / BILL
- Date/time
- [N]ote/reference

[Allo]w Admin correction/void with audit history.
Sending payment instructions NEVER marks payment received.

2. CASE MANAGEMENT

Archive easy to reach.
[Archi]ve preserves everything and is restorable.
Add Admin-only Delete Permanently under a confirmed More action.

3. CLAIM / ASSIGNMENT

[Clai]m/reference is OPTIONAL.
Do not require assigning a case.
[Emp]hasize Assign Investigator for now.

4. BOTH ADMINS

[Bo]th Admin accounts see the same cases, intakes, payments, reports and activity.
[D]o not scope Admin data by assigned_to.

[5.] CONCURRENT SURVEILLANCE

Admins may use Active Surveillance on the same case simultaneously.
No silent overwrites or one Admin ending the other's session.

[U]pdate NEXT.md.
[Queue after hig]her-priority work already running.
```

---

## ✅ OWNER ANSWERS, 2026-08-15 — recorded on arrival

**These answer the four questions raised in the reader's notes below, and they
GOVERN where they differ from anything reconstructed above.** Same truncation in
transmission; `[brackets]` are reconstruction, everything else verbatim.

```
OWNER ANSWERS

1. RECORD PAYMENT

Make Record Payment easy to reach from:
- the case header/summary
- the Retainer/Payment card
- the More menu

[Do not] make Admin hunt through another screen.

2. DELETE

[Do not phys]ically destroy evidence, reports, invoices, payment history or send/audit logs.
"Delete Case" should be an Admin-only soft-delete/tombstone that removes it from
normal views but preserves records.
A true irreversible data purge is NOT needed now.

3. ARCHIVE

[Add a] real ARCHIVED state separate from Completed/Cancelled.

Archived cases:
- leave active views
- [rea]chable under Archived
- preserve everything
- can be restored

4. TWO-ADMIN SURVEILLANCE

[Eac]h Admin gets an independent surveillance session/timer on the same case.
Keep the safety rule that an Admin can only stop/edit THEIR OWN active timer/session.
Both sessions may run simultaneously and append to the SAME case activity log.
Change uniqueness constraints only as needed so the lock is per Admin/session,
not one global timer for the whole case.
Never let one Admin silently stop or overwrite the other Admin's work.
```

### What these settle

| Question raised below | Answer |
| --- | --- |
| Where should Record Payment be reachable from? | **Three places**: case header/summary, the Retainer/Payment card, and the More menu. Not another screen |
| Does Delete Permanently destroy records? | **No.** Soft-delete/tombstone only. Evidence, reports, invoices, payment history and send/audit logs all survive. **A true purge is explicitly not wanted now** — so the most dangerous item in the order is off the table |
| Is Archive the existing lens or a new state? | **A new state**, separate from Completed and Cancelled: leaves active views, reachable under Archived, preserves everything, restorable |
| How do two admins share Active Surveillance? | **An independent session per admin**, both running at once, both appending to the **same** case activity log. The safety rule is KEPT — you can only stop or edit your own. Uniqueness constraints change **only as needed** so the lock is per admin/session rather than one global timer per case |

### Notes on the answers — reader's, not owner instruction

- **§2 is now much smaller and much safer than it read.** "Delete Permanently"
  in the original order is answered as a tombstone, which is the pattern this
  system already uses everywhere (`activity_removed`, evidence `deleted_at`,
  invoice void, retainer payment void). The blast-radius question is closed:
  nothing is destroyed.
- **§4 is the one that still needs design before code, and the answer says so
  precisely.** "Change uniqueness constraints only as needed so the lock is per
  Admin/session" is exactly the partial unique index on `case_day_pauses`
  (one open pause per day) and the `investigator_id` scoping in
  `openDayForAction()`. The safety rule the owner insists on keeping is the one
  that rule already implements — so the change is to the *granularity* of the
  lock, not to the rule. `case_days` currently has no notion of two concurrent
  days on one case; that is the real work.
- **§3's ARCHIVED state touches a CHECK constraint.** `submissions.status` and
  the `STAGES` list both constrain what a case may be, and a CHECK cannot be
  widened from `schema.sql` idempotently — see CLAUDE.md. A companion table is
  the precedent (`activity_removed`, `build_custom`, `build_reports`), and the
  same applies to the Delete tombstone in §2.

---

## Reader's notes — NOT owner instructions

Flagged as such so a later session does not mistake them for the handoff. **Each
is a claim to verify against the code, not a fact.**

> **All four questions below were ANSWERED by the owner on 2026-08-15** — see
> the answers section above, which governs. The notes are kept because they are
> the audit that produced the questions, and because the "already built" findings
> still stand and still mean *do not rebuild it*.

### §1 Manual payments — largely built already

This looks close to done, and the standing instruction is *"do not rebuild
already-completed UI."* Audit before building:

- **The five methods are already exactly these.** `RETAINER_METHODS` in
  `worker.js` is `['cash_app', 'venmo', 'check', 'cash', 'ach_bill']`, with a
  test asserting each is accepted and that `card` and `other` are refused. That
  matches the owner's EXACTLY list — the reconstruction of the truncated entries
  as Cash App and Cash is consistent with it, and with the 2026-08-15 correction
  already recorded in `PAYMENTS.md`.
- **Amount, method, date and reference already exist** on
  `POST /cases/:no/retainer/payment`, and **void with audit history** is already
  built (`/retainer/payment/:id/void`, keeping the row, stamping who and why).
- **"Sending payment instructions NEVER marks payment received"** is enforced
  and tested in three places, most recently on the standalone send, whose answer
  carries an explicit `retainer_marked_paid: false`.

**So the genuinely new part of §1 is probably only "make Record Payment easy to
reach"** — a reachability question, not a data one. It is currently on the case
Overview panel. Confirm with the owner where they expect to reach it from.

**One real gap:** the field list says **Date/time**; the stored field is
`paid_on`, a calendar **date** with no time. Adding a time is a schema question,
and `ALTER TABLE ADD COLUMN` is not idempotent here — a companion table is the
precedent. Confirm whether a time is genuinely wanted before building it.

### §2 Case management — Archive is the unclear one

`STAGES` carries `closed` and `cancelled`, and there is a closing checklist, but
**there is no `archived` state and no restore-from-archive path.** Whether
"Archive" means the existing closed/completed lens or a genuinely new state is
the question to settle first — they behave differently and only one of them
needs schema.

**Delete Permanently is new, and it is the most dangerous thing in this order.**
Everything else in this system is soft-delete on purpose (`activity_removed`,
evidence `deleted_at`, invoice void, retainer payment void). A hard delete needs
its blast radius decided explicitly: does it destroy evidence rows, R2 objects,
report versions, invoices, the send log? MASTER §9's exceptions list already says
ordinary users may not destroy audit-critical records.

### §3 Claim / assignment

*"Do not require assigning a case"* needs disambiguating: it may mean the case
number is optional (already true after the PRE-CASE SENDS work), or that a case
need not be assigned to an investigator before other actions. Different work.

### §4 Both admins — likely already true, and worth proving rather than assuming

Admin routes are not scoped by `assigned_to`; that scoping is the
**investigator** boundary. `caseFor` and the case-detail path enforce assignment
for investigators only. **This is probably already satisfied**, but the owner
raised it, which usually means something looked wrong on screen — so the useful
work is a regression test proving two separate admin accounts see identical
cases, intakes, payments, reports and activity, plus a look at anything that
filters by the CURRENT user rather than by role.

Note the tension to respect: `/my/reports`, `/my/expenses`, `/my/active` and
`/calendar` scope by **who created the record**, which is deliberate and settled
(the KEEP decision, 2026-08-14). "Do not scope Admin data by `assigned_to`" must
not be read as flattening those.

### §5 Concurrent surveillance — the one with a real design problem

This conflicts with a shipped invariant. `openDayForAction()` deliberately
enforces that **you can only stop your own clock**, and `case_day_pauses` has a
**partial unique index allowing one open pause per day**. Two admins running
Active Surveillance on the same case simultaneously means either two concurrent
`case_days` rows for one case, or one shared day with two people writing to it.

*"No silent overwrites or one Admin ending the other's session"* is the owner
naming the failure mode precisely, and it is the same shape as HIGH #2 (the
stranded running day). **This needs a design decision before code**, and it is
the item most likely to need a companion table rather than a changed one.
