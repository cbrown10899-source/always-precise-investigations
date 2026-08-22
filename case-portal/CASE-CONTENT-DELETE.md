# CASE CONTENT DELETE / RESTORE — the owner's brief, verbatim

**Recorded 2026-08-22, queued as UNIT 39**, immediately after Unit 38 and
ahead of nothing else — it is the last item in the durable queue at the time
it arrived. Added without displacing Unit 38, which was mid-suite when this
came in and was not interrupted.

**This is a PRODUCTION unit, not test-cleanup.** The owner's own words:
*"Admin must have a quick, obvious way to remove incorrectly entered or
no-longer-needed information from BOTH test cases AND REAL PRODUCTION CASES."*

## What this unit must NOT do — the owner's own limits, extracted so they
## cannot be lost in a long brief

- **No physical Dropbox deletion.** *"Do NOT physically delete Dropbox bytes
  in this unit."*
- **No evidence overwrite.** *"Do NOT overwrite originals."*
- **No silent hard deletion**, no billing or history destruction.
- **Remove from Package is not Delete from Case** — *"These must not be the
  same action unless the owner explicitly selects Delete from Case."*
- **Deleting a Daily Summary must not delete the activity underneath it.**
- **Do not silently rewrite a finalized historical report.** A document whose
  source changed says so — *"SOURCE DATA CHANGED — REBUILD REQUIRED"* — rather
  than continuing to look current.
- **Do not blindly add Delete everywhere.** *"Only add it where removing an
  erroneous record is logically safe and authorized."*

## What it inherits from the project's existing rules

The tombstone model already exists and is the shape to reuse — `case_deleted`,
`activity_removed`, `case_archive`, and evidence's own `deleted_at` — and
`CLAUDE.md` records the standing rule those were built to serve: **nothing the
office does in the portal is unrecoverable in the portal.** This unit widens
who can reach that model, not what it does to bytes.

Unit 38's chronology rule holds: within a case or day, Activity reads oldest
to newest, and a restored entry returns to its true timestamp position.

## Ordering

Unit 38 finishes first. This does not start until 38 is DEPLOYED and the owner
has it for visual review.

---

## THE BRIEF, VERBATIM

```
After all caught up. Do this one in last queue :

QUEUE SAFETY — ADD REQUIRED PRODUCTION UNIT AFTER CURRENT WORK.

Do not interrupt Unit 38 if it is actively running.
Read NEXT.md / RECONCILIATION.md first and insert this at the correct next available position without dropping existing queued work.

REQUIRED UNIT — CASE CONTENT DELETE / RESTORE CONTROLS

This is NOT test-cleanup only.

Owner requirement:
Admin must have a quick, obvious way to remove incorrectly entered or no-longer-needed information from BOTH test cases AND REAL PRODUCTION CASES.

Today too much case/package information can only be edited and then sits permanently in the working case.

GOAL

Add a visible Delete action beside appropriate editable case content.

Deletion should immediately remove the item from the active case workflow, report/package calculations and normal views, while remaining recoverable/auditable unless an already-approved hard-delete policy explicitly permits otherwise.

APPLIES TO REAL CASES.

Cover at minimum:

1. ACTIVITY ENTRIES
- Edit
- Delete
- Restore deleted activity where current audit/tombstone system supports it
- deleted activity must disappear from normal Activity view
- deleted activity must disappear from Daily Summary source
- deleted activity must disappear from Report chronology
- restored activity returns to its correct chronological position

2. INVESTIGATION DAYS / ACTIVITY DAYS
Allow Admin to remove an incorrectly created day.

Before deleting a whole day, show a confirmation with:
- date/day number
- number of activity entries
- number of photos/videos/evidence associated with the day
- whether a Daily Summary exists
- whether the day is already represented in a report/package

Do not silently destroy child evidence.

If a day contains linked activity/evidence:
require an explicit choice or safe workflow such as:
- Remove day and its case-work records from active use
- Cancel

Preserve sufficient audit history to restore/reconstruct where supported.

3. DAILY SUMMARIES
Add Delete/Reset where appropriate.

Deleting/resetting a Daily Summary must not delete the underlying Activity entries.

Make the distinction clear:
Delete Summary != Delete Day Activity.

4. EVIDENCE / CASE MEDIA
For photos, videos, documents and other case evidence:
add an obvious Admin Delete / Remove action beside Edit/View actions.

Deleting from the case should:
- remove it from active Evidence views
- remove it from File Queue active workflow where appropriate
- remove it from future package inclusion
- remove it from package/evidence counts
- preserve integrity/audit metadata
- support Restore where existing architecture permits

IMPORTANT:
Do NOT physically delete Dropbox bytes in this unit.
Do NOT overwrite originals.
Use the existing evidence-deletion/tombstone model.

5. PACKAGE CONTENT
Inside Case Build / Reports & Packages, Admin must be able to remove an accidentally included:
- evidence item
- document
- activity/day-derived item where applicable

Package removal must not necessarily delete the source case record.

Make the distinction clear:
REMOVE FROM PACKAGE
versus
DELETE FROM CASE

These must not be the same action unless the owner explicitly selects Delete from Case.

6. OTHER USER-ENTERED CASE CONTENT
Audit editable case areas for records that can be created but cannot reasonably be removed.

Examples may include:
- notes
- expenses
- contacts/phones where safe
- manually attached documents
- timeline entries
- manually added vehicle/subject information

Do not blindly add Delete everywhere.
Only add it where removing an erroneous record is logically safe and authorized.

UX

For normal editable rows/items use clear nearby actions:

Edit
Delete

Do not bury Delete three menus deep.

For destructive-looking actions:
- require confirmation
- name the exact item being removed
- say whether the action is recoverable
- say whether source evidence/file bytes remain preserved

Use stronger confirmation for deleting:
- entire days
- evidence
- finalized/package-linked records

REAL CASE SAFETY

This functionality is explicitly approved for real production cases.

However:
- Admin-only for consequential deletion
- investigators may only delete items they are already authorized to edit/remove under existing role rules
- preserve actor
- preserve timestamp
- preserve reason where consequential
- preserve audit history
- no silent hard deletion
- no evidence overwrite
- no Dropbox physical deletion
- no billing/history destruction

REPORT / PACKAGE INVALIDATION

If deleting something changes an already-generated report/package, do not leave the old document looking current.

Show a clear state such as:
SOURCE DATA CHANGED — REBUILD REQUIRED

or use the existing equivalent mechanism.

Do not silently rewrite a finalized historical report.

Counts/statuses must refresh accurately after deletion/restoration.

CHRONOLOGY

Preserve the approved rule:
within a case/day, Activity is oldest -> newest.

If a deleted activity is restored, return it to its true timestamp position.

TESTS

Test at minimum:

- delete activity
- restore activity
- deleted activity disappears from Daily Summary
- deleted activity disappears from new report chronology
- restored activity returns chronologically
- delete/reset Daily Summary does not delete activity
- delete empty investigation day
- attempt to delete day containing activity/evidence
- confirmation behavior
- remove evidence from case
- restore evidence
- Dropbox bytes remain untouched
- Remove from Package does not Delete from Case
- Delete from Case updates package counts
- generated/finalized report/package becomes clearly stale when source changes
- Admin authorization
- investigator restrictions
- real-case path uses the same controls as test cases
- mobile controls remain usable
- no horizontal overflow
- audit history survives

Run full relevant suites.

If green:
CODED -> TESTED -> PUSHED -> MERGED -> DEPLOYED

Leave LIVE VERIFIED open for owner review.

Report exactly:
- which case records now have Delete
- which have Restore
- which use Remove from Package
- what remains intentionally non-deletable
- confirmation that no Dropbox/evidence bytes are physically destroyed

Do not start another unrelated feature afterward.
```

---

# THE AUDIT, AND WHAT IT CHANGED (Unit 39, 2026-08-22)

The brief says *"Use the existing evidence-deletion/tombstone model"* and
*"Do NOT physically delete Dropbox bytes in this unit."* **Those two
instructions were in conflict, because the existing model was not a
tombstone.**

## A1 — the finding that reshaped the unit

`deleteEvidence` called `dropboxDelete` against `/2/files/delete_v2`, or
`env.EVIDENCE.delete` for a legacy R2 row, and **then** wrote `deleted_at`.
The row survived; the file did not. That is also the reason no evidence
Restore existed anywhere in the portal — there was nothing left to put back,
so the route had never been worth writing.

So the owner's limit could not be met by reusing what was there. It was met by
**changing what removal does**: nothing in the case-content controls destroys
a byte now. `dropboxDelete` and `EVIDENCE.delete` have exactly one caller each
— the `TEST-` sweep — and a test COUNTS them, because "no bytes are destroyed"
is a confirmation the owner asked for and a sentence in a comment cannot give
it.

## A2 — what that cost, stated rather than buried

Deleting evidence used to free space against the free-tier cap, because the
bytes really went. **It does not any more.** The lever is gone, and getting it
back would be a purge — which `CLAUDE.md` already records as a different
feature with a different name that the owner has said is not wanted.

The meter had to learn the difference or it would have lied. It counts
`deleted_at IS NULL` over non-Dropbox rows, so a preserved legacy R2 file would
have stopped counting while its bytes sat in the bucket — **the free-plan
failsafe under-reporting, which is the one direction it must never fail in.**
The `case_content_removed` marker separates the two eras: a row removed BEFORE
this change has none and its bytes really are gone, so counting them would
over-report by exactly as much; a row removed after has one and its file is
still there. Both answers stay true.

Dropbox-backed rows — everything uploaded since 2026-08-18 — are excluded from
the meter either way, so preserving them costs the failsafe nothing.

## A3 — what already existed, and was left alone

| Area | State found |
| --- | --- |
| Activity | **Already complete.** `activity_removed`, restore, and exclusion from the Activity view, the Daily Summary source and the report chronology |
| Package contents | **Already complete.** `/build/:id/items/:id/remove` was already separate from case deletion |
| Phone numbers | **Already removable** through the Edit Case list writer |

Unit 39 added tests to all three rather than code. The owner's list names them,
and a requirement that is already met is met — restating it in new code would
have been the duplicate-feature mistake this project has a rule against.

## A4 — one table, not seven

`case_content_removed` is keyed `(kind, ref_id)` and covers day, day_summary,
note, comm, expense, subject, vehicle, task and evidence. Seven companion
tables in the `activity_removed` shape would have been seven guards to
remember, seven `DEMO_SWEEP` lines and seven places for one rule to drift.
The two that already exist keep their own shape, because rewriting them is a
migration `schema.sql` cannot do idempotently.

**`kind` carries no CHECK**, deliberately — Unit 7's rule, learned from
`submissions.kind`, which could not widen for Legal. The allow-list lives in
the Worker, so a tenth kind is an ordinary edit.

`case_content_event` is the append-only trail beside it. It matters most for
evidence, whose removed state lives in its own columns and is **cleared** by a
restore: without the trail, putting a file back would erase the fact that it
was ever removed.

## A5 — authority mirrors the existing edit rule

The owner's own line: *"investigators may only delete items they are already
authorized to edit/remove under existing role rules"*, with *"Admin-only for
consequential deletion"* as a ceiling above it.

| Kind | Who may remove it | Why |
| --- | --- | --- |
| activity | admin, or the entry's own investigator | unchanged from before this unit |
| note | admin, or its author | `addNote` is open to anyone on the case |
| expense | admin, or its own investigator **while unreviewed** | reviewed money is the office's — "no billing/history destruction" |
| day_summary | admin, or the day's investigator until the report is with the office | inherited from `saveDaySummary`, not restated |
| day, subject, vehicle, comm, task, evidence | **admin only** | consequential |

`contentTarget` resolves the row and the permission in one place, so a new kind
cannot arrive with the check forgotten.

## A6 — staleness is derived, never stored

A finalized package compares `finalized_at` against the trail, evidence
deletions and activity removals. **A restore counts as a change too** — a
package that quietly *gained* an exhibit after being sent is the same defect
wearing the opposite sign.

The notice sits beside the gate strip rather than inside it, because they
answer different questions, and **outside `#pkgdoc`**, so no client document
carries the office's bookkeeping. It is gold rather than red: the package is
out of date, not broken.

**This unit's own bug was here.** `buildStaleness` guarded on
`status !== 'final'` while the CHECK allows `'finalized'`, so the whole
function returned null for every package that has ever existed. The derivation
was right, the plumbing was right, and the one wrong word reads perfectly. The
test that put a real package into the finalized state is what found it.

## A7 — what remains intentionally non-deletable

Invoices, invoice lines and payments (void exists and is the right instrument);
reports (status is the record, and a finalized document is never rewritten);
send and alert history; retainer receipts; build events; the case itself
(`/cases/:no/delete` is its own tombstone and predates this unit); and the
retention and legal-hold trail. Each is either money, a record of something
that was actually sent, or an audit row — and the owner's own limits name all
three.

**A legal hold refuses every removal in this unit** and allows every restore.
Unit 17's decision 5 named evidence removal specifically; this unit is that
same act applied to eight more record types, so the refusal follows the act
rather than stopping at the one route that existed when the decision was
written. That is a widening of a hold's reach and is recorded here for the
owner to overturn if it is not wanted.
