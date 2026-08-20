# Unit 10 — Case Timeline

The owner's brief is kept **verbatim** below, the way `LEGAL-INTAKE.md`,
`PROFILES.md` and the Unit 9 record keep theirs. Everything under **Derived**
is a decision this build made that the brief did not make for it; each is
listed on its own so it can be overturned on its own.

Read this before changing any of `caseTimeline` in `case-portal/worker.js` or
`timelinePanel` in `portal/index.html`.

---

## The brief, verbatim (owner, 2026-08-20)

> GOAL
>
> Add a professional chronological Case Timeline that lets Admin quickly
> understand everything important that happened in a case without opening
> multiple tabs.
>
> The timeline should be derived from existing structured data.
>
> Do NOT create duplicate evidence or a second activity system.
>
> Do NOT create a permanent timeline PDF automatically.
>
> Primary use:
>
> OPEN CASE -> TIMELINE -> SEE WHAT HAPPENED IN ORDER -> FILTER IF NEEDED ->
> OPEN THE UNDERLYING ITEM
>
> CORE PRINCIPLE
>
> The timeline is a VIEW over existing case records. Source records remain
> authoritative. Do not copy all source data into a new timeline table unless
> there is a proven technical reason that live bounded queries cannot support
> the feature. Prefer composing events at read time from existing tables.
>
> TIMELINE EVENT TYPES
>
> Include meaningful existing case events where the data exists. Candidate
> types: CASE — case created, case status changed, investigator assigned,
> archived/restored where useful. ACTIVITY — investigator activity entry,
> surveillance observation, voice-created activity, Admin-added activity.
> PHOTO / MEDIA — photograph added/filed, timestamped photograph filed, video
> added/filed, timestamped video filed. REPORT — report created, report
> submitted, report approved/finalized, PDF generated/saved where existing
> audit data reliably records it. PAYMENT — payment recorded, partial payment,
> correction/void, invoice created/paid where current data supports it.
> INTAKE / ASSIGNMENT — intake accepted/converted, assignment created where
> relevant. LEGAL — hearing/trial/deadline events when explicitly recorded.
> PACKAGE — package finalized, client-deliverable state where reliably
> recorded. DROPBOX / STORAGE — meaningful failed/successful case storage
> actions only where existing state/audit data supports them.
>
> Do NOT flood the timeline with: every search, every page view, every UI
> click, every successful background refresh, every low-value technical event.
> The timeline should remain useful to an investigator or attorney reading it.
>
> CHRONOLOGY
>
> Sort correctly by real event time. Use: event date, event time, stable
> tie-breaker such as creation ID/order. Do not assume database insertion
> order equals investigation chronology. Events recorded after the fact must
> still appear at their actual event time where that field exists. Clearly
> distinguish EVENT TIME from RECORDED/CREATED TIME if both matter and are
> available. Do not silently rewrite source timestamps.
>
> TIME ZONE
>
> Follow the portal's established America/New_York date/time rules. Display
> EST/EDT correctly based on the actual event date. Do not hard-code EST
> year-round. Reuse established timestamp formatting where practical.
>
> TIMELINE PRESENTATION
>
> Add a Timeline area inside the Case workspace. Use a clean vertical
> timeline/list. Each event should show, where useful: Date, Time, Event type,
> Short title, Concise description, Investigator/user, Relevant status,
> Link/action to underlying source.
>
> Example:
>
> 10:42 AM / SURVEILLANCE / Subject departed residence in white Ford F-150. /
> Trever Brown / Open activity
>
> 11:06 AM / PHOTO / IMG_4021.jpg / Timestamped copy filed. / Open photo
>
> 2:14 PM / PAYMENT / $750 retainer payment recorded. / ACH/BILL / Open billing
>
> Do not dump raw JSON/database fields.
>
> EVENT VISUALS
>
> Use lightweight consistent icons/badges for event types. Possible
> categories: Observation, Photo, Video, Report, Payment, Case, Legal Date,
> Package, Storage. Keep styling professional and restrained. Do not add large
> image assets.
>
> FILTERS
>
> Provide simple useful filters such as: ALL, ACTIVITY, MEDIA, REPORTS,
> PAYMENTS, CASE, IMPORTANT DATES. Do not build a complex query builder.
> Filters should work quickly and on mobile.
>
> DATE RANGE
>
> If useful and inexpensive, support: All Time, Today, Last 7 Days, Custom
> Date Range. Do not make date filtering mandatory. Default should show a
> useful recent/all chronology based on case size. If a case becomes very
> large, paginate or progressively load.
>
> DIRECT LINKS
>
> Timeline entries should open the actual underlying item when practical.
> Examples: activity -> Activity/Surveillance entry, photo -> Media, video ->
> Media, report -> Reports, payment -> Billing, legal date -> Case details,
> package -> Package. Do not create duplicate edit screens inside Timeline.
> Timeline is navigation + chronology.
>
> EVIDENCE RELATIONSHIP
>
> If a photo/video is associated with an activity entry, show that
> relationship where existing data supports it. Do not guess relationships
> from timestamps alone. Only show explicit relationships.
>
> MOBILE
>
> This should be excellent on phone. At narrow iPhone widths: single-column
> vertical layout, no horizontal overflow, date/time readable, descriptions
> wrap, filters usable, actions touch-friendly, no wide tables, 16px
> form/filter inputs, long filenames wrap, badges do not push content
> offscreen. Use approximately 44px touch targets where appropriate.
>
> DESKTOP
>
> Desktop may use a denser layout but keep the same chronology. Do not turn it
> into a spreadsheet unless there is a specific reason. A vertical operational
> timeline is preferred.
>
> PERFORMANCE
>
> Timeline should not load binary media. Do not fetch actual image/video bytes
> just to render the timeline. Use: metadata, filenames, timestamps, IDs,
> activity text, lightweight structured records. Use bounded queries. Avoid
> N+1 queries. For large cases, use LIMIT/pagination or a cursor. Do not load
> tens of thousands of events at once.
>
> PERMISSIONS
>
> Respect existing case permissions. Admin: can view timelines for authorized
> Admin cases. Investigator: can only view timelines for cases they are
> permitted to access. Public users: no timeline access. Do not expose:
> unrelated case activity, other investigators' unauthorized cases, profile
> directory history outside case authorization. Enforce authorization in
> Worker/backend, not browser only.
>
> AUDIT / EDITING
>
> Timeline itself is read-only. Editing happens at the underlying source item.
> If source data is edited/deleted under existing permissions: timeline
> reflects the current authoritative state. Do not create a second editable
> copy. Where existing audit history preserves edits/deletions and showing
> them is appropriate, distinguish them clearly. Do not invent an audit system
> solely for Timeline.
>
> CASE SUMMARY / TOP
>
> At the top of Timeline, optionally show lightweight useful context: Case
> number, Client, Subject, Status, Investigator, Date range represented. Do not
> duplicate the entire Case header.
>
> EXPORT
>
> Add an optional on-demand Timeline Export only if it can reuse existing
> report/PDF/document infrastructure cleanly. Preferred first implementation:
> printable/exportable chronological view, or generate PDF on explicit Admin
> action. Do NOT permanently store a timeline export automatically. If Save to
> Dropbox is added: only save when Admin explicitly requests it. Do not create
> an R2 copy. If export meaningfully increases scope/risk, ship the Timeline
> view first and document export as a bounded follow-up rather than
> destabilizing the unit.
>
> LEGAL USEFULNESS
>
> Make timeline readable enough that Admin or a law-firm client could
> understand chronology. Do not expose internal-only notes in client-facing
> exports unless existing classification/package rules allow them. Timeline
> inside Admin may show authorized internal information. Any future
> client-facing timeline must honor evidence/report classification. Do not
> weaken classifications in this unit.
>
> SCHEMA
>
> Prefer NO new timeline table. Reuse existing structured source records. Only
> add schema/indexes if measurement proves a real performance requirement. If
> indexes are needed: additive, idempotent, documented, portal-setup safe. No
> destructive migration.
>
> STORAGE IMPACT
>
> Timeline view must add essentially zero file storage. No: duplicated media,
> cached media copies, thumbnails, R2 objects, automatic PDFs, permanent
> timeline snapshots. On-demand export only if explicitly requested.

---

## Derived

Decisions this build made. The brief did not make them; each stands or falls
on its own.

### D1 — No table, no index, and that was checked rather than assumed

The brief prefers no timeline table and allows indexes "if measurement proves
a real performance requirement". Neither was needed. Every arm of
`caseTimeline` is an equality lookup on a column that is already the leading
part of an index:

| Table | Index it seeks on |
| --- | --- |
| `activity_log` | `idx_activity_case (case_no, at_date, at_time)` |
| `case_days` | `idx_days_case (case_no, day_date)` |
| `case_reports` | `idx_reports_case (case_no, report_date DESC)` |
| `case_evidence` | `idx_evidence_case (case_no)` |
| `retainer_payment` | `idx_retpay_case (case_no, id)` |
| `invoices` | `idx_invoices_case (case_no)` |
| `invoice_payments` | `idx_invpay (invoice_id)` |
| `invoice_events` | `idx_invevents (invoice_id)` |
| `case_builds` | `idx_builds_case (case_no)` |
| `build_events` | `idx_bevents (build_id)` |
| `photo_stamp` | `idx_pstamp_case (case_no, id DESC)` |
| `video_stamp` | `idx_vstamp_case (case_no, id DESC)` |
| `case_offers` | `idx_offers_case (case_no, status)` |
| `legal_intake` | `idx_legal_case (case_no)` |
| `case_status`, `case_archive`, `case_deleted` | primary key on `case_no` |

**So this unit needs no `portal-setup` dispatch**, which is the first time in
five units that is true and is worth stating plainly rather than leaving
someone to infer it.

### D2 — The sort axis is UTC; what is displayed is Eastern; neither is the stored value

Two kinds of timestamp live in this database. **UTC instants** — `created_at`,
`uploaded_at`, `recorded_at`, `status_at`, `taken_utc`, `start_utc` — and
**local wall clock** — `activity_log.at_date`/`at_time`, `case_days.day_date`
with `start_time`/`end_time`, `retainer_payment.paid_on`,
`invoice_payments.paid_date` and the legal dates. A chronology has to sort
them against each other, and comparing them unconverted is how an 8:15 PM
observation sorts ahead of a 9:00 PM one recorded an hour earlier.

`tlLocal()` reads a wall-clock value **as America/New_York** and `tlAt()`
reads an instant, so both land on one UTC axis for the sort. That axis is
never shown.

What IS shown is composed in the Worker: `date`, `time` and `tz`, as strings.
A laptop set to Pacific must not draw a Virginia surveillance entry three
hours early while the report beside it says otherwise, and one writer is this
project's standing answer to two renderings of one fact.

**Nothing is rewritten.** A wall-clock row keeps the date and time it was
recorded with, verbatim; only the sort key is derived.

### D3 — EST or EDT is resolved from the date, in two passes

`etOffsetMinutes()` asks `Intl.DateTimeFormat` what America/New_York shows for
an instant and derives the offset from the answer — `-240` in EDT, `-300` in
EST. `tlLocal()` runs it twice: once at the naive guess and once at the
corrected instant, which is what makes the changeover weekends come out right
instead of being an hour wrong twice a year. There is a test that walks
15 January, 7 March, 9 March and 15 July through the composer and asserts the
zone label on each.

In the spring-forward gap (02:00–03:00 on the changeover, which does not
exist) the two passes settle on a real instant an hour either side. The
display is unaffected because the date and time shown are the stored ones;
only the sort key shifts by an hour. Stated rather than papered over.

### D4 — A date is not a moment, and no time is invented for one

`paid_on`, `paid_date`, `hearing_date`, `trial_date` and `deadline` carry a
day and no time. Those events sort at the START of their day and are sent with
`time: null`; the page draws a dash and the words "all day". Anchoring them at
noon so they would mix nicely with timed events would be a precision claim the
record does not make.

### D5 — Same-instant ties break on a fixed type rank, then the row id

`TL_RANK` is a fixed integer per event type, so two events sharing a minute
keep a stable, explainable order across runs; below that, the source row id,
which is the real creation order. Newest-first is exactly the ascending list
reversed. Tested three ways: the order, the same order on a second read, and
that the two directions are mirrors.

### D6 — Newest first is the default; oldest first is one chip away

The brief's example reads ascending within a day, and "SEE WHAT HAPPENED IN
ORDER" is a narrative reading. But the first question on opening a case is
"what has happened lately", which is why every other list in this portal — the
case list, the send history, the activity log, recent activity — is newest
first.

So both are offered as **two explicit chips**, not a toggle whose label has to
double as its state. The default is newest first.

### D7 — The status event is one event, because there is no stage history

`case_status` is one row per case: the stage it is in and when it was set. A
timeline claiming to list every status change would be inventing the ones
nobody recorded. Same for the assignment: `submissions.assigned_to` keeps no
history, so the recorded moment is the offer that was **accepted**
(`case_offers.responded_at`), which is a fact rather than a derivation.

### D8 — The candidate list is honoured where the data exists, and named where it does not

| Brief's candidate | What it reads | Notes |
| --- | --- | --- |
| case created | `submissions.created_at` | |
| status changed | `case_status` | one event — D7 |
| investigator assigned | `case_offers` accepted | admin only — D10 |
| archived / restored | `case_archive` | admin only; restore deletes the marker, so only the archiving is an event |
| deleted | `case_deleted` | admin only |
| activity, surveillance, voice, admin-added | `activity_log` + `activity_source` | voice is badged |
| photograph / video added | `case_evidence` split on `content_type` | |
| timestamped photograph / video | `photo_stamp`, `video_stamp` | active derivative only |
| report created / submitted / approved | `case_reports` created_at + status_at | one status event — `status_at` is a single moment, not a history |
| payment, partial payment, void | `retainer_payment`, `retainer_payment_void`, `invoice_payments` | admin only |
| invoice created / paid | `invoices.created_at`, `invoice_events` | admin only |
| package finalized | `build_events` | admin only |
| hearing / trial / deadline | `legal_intake` | admin only — D10 |
| **PDF generated/saved** | — | **not included.** Nothing records it per case: the PDF is written in the browser from `#pkgdoc` and `build_events` has no entry for it. Adding one would be inventing an audit system for the timeline, which the brief forbids. |
| **intake accepted / converted** | — | **not included.** `lead_status` is current-state only, like `case_status`; "converted" has no recorded moment of its own. The case being created is the event that exists. |
| **Dropbox / storage actions** | — | **not included.** There is no per-case Dropbox audit table. A failed upload is refused and never recorded, so there is no state to read. The brief says "only where existing state/audit data supports them"; it does not. |

### D9 — Noise excluded by name

`invoice_events` is filtered to `voided`, `status_paid`, `status_sent_to_bill`,
`status_sent_to_client` and `status_ready`. `edited`, `lines_replaced` and
`bill_ref_added` are bookkeeping; `payment_recorded` would say a second time
what the payment row already says. `build_events` is filtered to `created`,
`finalized`, `delivered` and `reopened` — an item added or a summary edited is
work in progress, not a case event. There is a test that replaces an invoice
line and asserts the timeline is unchanged.

### D10 — The role boundary is applied by not running the arm

Payments, invoices, packages, offers, the archive and delete markers, and the
legal dates are read **only for an admin** — the query does not run at all,
rather than running and having its rows filtered. That is the boundary
`caseWorkspace` already draws field for field, and it is stronger than
filtering: there is no path by which the paying side can reach the field.

The header follows the same rule — an investigator's context carries the case,
the stage, the subject and the investigator, and no `client` or `claim_number`
key at all. The subject reaches both roles because the subject is who is
watched, never who is paying.

Deleted evidence stays on the office timeline, marked, and is simply absent
from the field one — again matching `caseWorkspace`.

### D11 — The evidence relationship is the column, never the clock

`case_evidence.entry_id` is the only thing that says a photograph documents a
moment. Two records sharing a minute say nothing. The attachment list is built
by a pass over evidence rows that were already fetched, so it costs no extra
query and nothing per entry.

### D12 — Bounded reads, and the children go through their parent

Every arm carries a `LIMIT ?` from the `TL` block. Invoice payments, invoice
events and build events are read with **one statement each** through a
subquery on their parent (`WHERE invoice_id IN (SELECT id FROM invoices WHERE
case_no = ?)`), so a case with forty invoices costs the same two reads as a
case with one. That is the brief's "avoid N+1", and it is the same shape
`DEMO_SWEEP` already uses.

The date range is bound, never interpolated: absent bounds become sentinels
that sort outside every real value, so the statements keep one shape and one
bind count. Unit 7's 401-parameter lesson holds — nothing here grows with the
customer's data.

### D13 — Progressive loading is a larger request, not a cursor

The composed list is cut to `limit` (200 by default, 600 maximum) and the
response says the true `total`; **Show more** asks again with a larger limit.
A cursor over a list composed from fourteen differently-shaped sources would
have to be encoded per source and compared against both a UTC axis and a set
of plain date columns — real complexity for a case size nobody has.

**And what is cut is named.** `capped_sources` lists any arm that hit its own
read limit, so a timeline that stops does not read as a case where nothing
else happened. `missing_sources` does the same for a table that has not
arrived yet, the way Unit 8's `/attention` does. There is a test that plants
501 activity entries against a cap of 500 and asserts both.

Narrowing the date range is what makes a large case complete rather than
capped, and that is asserted too.

### D14 — Categories filter in the browser; the range narrows the read

A chip has to answer instantly on a phone, and the payload is already bounded,
so category filtering is client-side. The range genuinely changes which rows
are read, so it goes to the Worker — which is what makes "last 7 days" on a
large case come back complete instead of capped.

Chips are built from the categories actually present, so an investigator sees
no Payments chip and a case with no court dates has no Dates chip. A filter
that is always empty stops being read.

### D15 — Export is the printable view, and the PDF is a documented follow-up

The brief's preferred first implementation is "printable/exportable
chronological view", and that is what shipped: `#tldoc` is a print region
beside the three that already exist (`#invdoc`, `#pkgdoc`, `#repdoc`), and the
browser's own print dialog saves a PDF from it.

**A generated PDF was deliberately not built.** The one PDF writer in this
system writes from the rendered `#pkgdoc` and is coupled to the package
document; reusing it would mean generalising the thing Unit 9 has just
stabilised, and writing a second would break the "exactly one `%PDF-1.`
writer" test that exists to stop precisely that. Nothing is stored, uploaded
to Dropbox or written to R2, and no PDF is produced automatically.

**Bounded follow-up if it is ever wanted:** a `Save timeline to Dropbox`
action on an explicit admin click, reusing the existing case-media upload the
way `report-pdf` does, writing into the case's own `Reports` folder. It needs
a decision about whether a timeline is a client artefact at all — see D16 —
and it is not needed to use the feature.

### D16 — Nothing here is client-facing, and no classification moved

The timeline is a staff screen. It is not attached to a package, not offered
to a client, and not part of the delivery flow, so no evidence or report
classification is consulted or changed by this unit. The printed view is
whatever the signed-in person could already see on screen.

If a client-facing timeline is ever wanted it is a different feature, and it
must honour `classification` the way the package document does — the gate that
already refuses `needs_redaction`, `internal_only` and `do_not_use` at the
point material LEAVES.

### D17 — The panel is navigation; it holds no control that writes

Every row offers the screen its record lives on. `#tldoc` contains no input,
textarea or select, and a test asserts that. Editing happens where it already
worked, which is also what keeps "timeline reflects the current authoritative
state" true without anything having to synchronise.

A removed activity entry is shown struck through and marked removed rather
than dropped — `activity_removed` is the project's standing shape, and the
timeline reflects it rather than keeping a second opinion.

### D18 — `.tl2-` is its own prefix, and the phone rules are last

`.tl` already belongs to the activity log at the other end of the stylesheet.
Three rules in this file have been killed by source order — the dead `.dlg`
phone rule, the buried burger base rule and `.qgrid` — so the timeline's
classes are `.tl2-` and its phone overrides sit at the END of the stylesheet,
after everything they override. A test asserts both.

**The phone layout is one column, measured.** The three-column grid puts a
78px time gutter and a 24px rail beside the description; at 375px that leaves
about 210px of text. Stacked, the description gets the whole panel width —
289px of 289px at 375px, and 304 of 304 at 390 — and the test asserts
**agreement with the panel**, not a share of the viewport, because 86px of the
375 goes to the page shell (`main` 16+16, `.card` 14+14 and its border,
`.dlg` 12+12) that every panel in this portal pays.
