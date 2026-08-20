# Repeat Client / Firm Profiles — the owner's brief, and what was derived from it

Unit 7, built 2026-08-20. The owner's brief is quoted verbatim at the end of
this file; everything above it is what this build DERIVED, one decision per
entry so each can be overturned on its own without unwinding the rest.

The one-sentence architecture: **a profile is a reusable default, a case is a
snapshot, and the only thing that ever connects them is one explicit link row.**
Prefill copies profile values into the assignment form; the Worker builds the
case from the form body alone and never reads a profile to do it; no case read
joins profile data into case facts. "Editing a profile must not rewrite prior
cases" is therefore structural — there is no code path by which it could.

## Where this brief meets what already exists

Inspected before any table was designed (the brief's own instruction):

- **There is no client/firm entity table anywhere.** Client identity lives
  only in per-case snapshots: the denormalised columns on `submissions`
  (client_name/email/phone, carrier, claim_number), the intake payload, and
  the per-case `legal_intake` companion row. Nothing to reuse as the profile
  spine — the new tables are genuinely new, and the snapshots stay exactly
  where they are.
- **`case_phone` is the approved phone shape**: one row per number, label,
  number stored as the office typed it, position, wholesale list replace on
  save. `profile_phone` copies it.
- **`notify_recipient` is the one-row-per-person precedent** with per-row
  switches; `profile_contact` follows it.
- **`retainer_payment.method` is the no-CHECK precedent**: an enum the owner's
  business can grow carries no CHECK constraint and is validated in the
  Worker, because a CHECK cannot widen idempotently. `profile.kind` follows it
  (see D2).
- **`case_meta`/`legal_intake` are the write-rule precedent**: absent means
  unchanged, blank clears, resolved per-field inside the UPDATE. The profile
  and contact editors follow it.
- **The sweep-derivation test** reads `schema.sql` for tables carrying a
  `case_no` column and requires each in `DEMO_SWEEP`; it also plants a row in
  every such table, resolving NOT NULL foreign keys against whatever the
  referenced table already holds. `case_profile` is case-scoped (swept, planted)
  and therefore carries **no REFERENCES clause on `profile_id`** — the referenced
  table is empty when the plant runs, and bare cross-boundary id columns
  validated in the Worker are already the house norm (`build_items.evidence_id`,
  `case_phone.subject_id`, `case_evidence.entry_id`).

## Derived decisions

- **D1 — Four tables: `profile`, `profile_contact`, `profile_phone`,
  `case_profile`.** The brief's own suggested vocabulary, checked against the
  repo first as it instructs: nothing existing fits (see above). `profile` is
  the org or the person; `profile_contact` is an organization's people;
  `profile_phone` is every number; `case_profile` is the one explicit link.
  Firm data is stored once — contacts and phones reference the profile, and
  nothing is copied between the four.

- **D2 — `profile.kind` carries NO CHECK constraint** (`law_firm` |
  `insurance_org` | `private_client`, validated in the Worker). The
  `submissions.kind` CHECK is this repo's recorded regret — Legal had to live
  as a payload marker because that CHECK could not widen. A fourth client
  category (a government agency, a TPA distinct from a carrier) must cost an
  ordinary Worker edit, never a table rebuild. `kind` is also **immutable
  after creation**: a firm cannot be re-typed into a private client with
  history attached — deactivate and recreate is the honest correction, and it
  keeps the directory lenses and prefill mappings truthful.

- **D3 — For a private client, the person IS the profile row.** `profile.name`
  is the filing name for all three kinds — firm, carrier, or the person — so
  the directory, the picker and the duplicate check search ONE column.
  A private client needs no contact row: their email lives in `profile.email`
  and their numbers are `profile_phone` rows with `contact_id` NULL (the same
  rows that hold a firm's main line). Organization contacts carry
  `first_name`/`last_name` separately — the owner's no-concatenation rule —
  while the private client's single `name` matches how every existing surface
  (`submissions.client_name`, the quick forms, the public form) already
  stores it. No composed display column exists to drift.

- **D4 — Address is one block, not city/state/ZIP columns.** Every surface a
  profile prefills or is saved from stores one block: `legal_intake.firm_address`,
  the payload's `client_address`/`firm_address`, `invoices.bill_to`. Split
  columns would force "Save as profile" to parse a blob by guesswork and
  prefill to compose one — two places to be wrong about the same string. The
  brief's field list is "such as", and its stronger sentence — "if the
  existing schema already has a safe pattern for this, reuse it" — decides.

- **D5 — Phones are rows; `digits` is a stored search key.** One row per
  number (`case_phone`/`notify_recipient` reasoning), `contact_id` NULL
  meaning the organization's own line, label mobile/work/home/other, number
  kept as typed. Beside it the Worker writes `digits` — the number reduced to
  digits — because phone search must match across formatting and D1 has no
  regex. A stored, deterministic derivation for search is the same move as
  the denormalised search columns on `submissions`; it is never displayed.
  "Secondary phone" is simply a second row.

- **D6a — The link carries the contact's NAME, not just their id.** Reading it
  back through the live contact list meant removing a person from the firm
  blanked a line on a case that had not changed — while the screen said "no
  case changed", which was true of the stored data and false of what the office
  saw. Provenance is a snapshot like the rest of the case.

- **D6 — `case_profile` is the only connection, written on explicit acts
  only:** creating an assignment from a selected profile, **Use this profile**
  on review of a submission, and **Save as profile** from a case. One row per
  case (`case_no` is the primary key). Prefill copies values into the form;
  `createManualIntake` builds the case from the body exactly as before and
  only then records the link — so the body stays authoritative, an edit to a
  prefilled field is naturally an edit to the assignment alone, and Recent
  matters is the reverse read of this table (deleted cases excluded, archived
  shown badged — a firm's history is the point of the list). `linked_by`/
  `linked_at` are the "assignment started from profile" audit entry.

  **The link route is `POST /cases/:no/profile` on purpose.** The router's
  deleted/archived chokepoint matches any non-GET under
  `/(cases|submissions|leads)/:no/`, so naming it this way inherits the gate
  rather than needing a check of its own — a route named
  `/profiles/:id/cases` carrying the case number in its body would be
  invisible to it, which is precisely the `caseSendRefusal()` trap this
  project has already paid for once. And `case_profile` is swept by
  `DEMO_SWEEP` while the other three tables are not: a link is case data, a
  profile is reference data, and clearing a test case must remove the link
  without touching the firm.

- **D7a — A match is computed when an admin asks the question, not when they
  open a case.** The first build computed the suggestion inside the case
  workspace read, so every admin opening any unlinked case ran the whole
  duplicate check — four profile-table reads on the most-opened screen in the
  portal, billed per row read, for a question nobody had asked. **Look for a
  match** is a button now, and `GET /cases/:no/profile-match` is what it calls.
  This is D7's own sentence taken literally.

- **D7 — No inference, anywhere.** The `recipientIsCarrier()` lesson is
  standing policy: never classify by matching stored strings against a case.
  A possible match is computed only when an admin is looking — creating a
  profile, or reviewing a specific unlinked case — and every outcome is an
  explicit button. `POST /profiles` always inserts a new row; there is no
  upsert, no merge routine, no code path that writes submitted values into an
  existing profile. "Never auto-merge" is the absence of the code, not a
  guard in front of it.

- **D8 — Normalization is one Worker function pair, and it is never clever.**
  `normText`: lower-case, punctuation to spaces, collapse whitespace including
  the non-breaking and zero-width characters that produced four defects in
  the send-context work. `normDigits`: digits only, comparing the last ten
  when both sides have at least ten (a leading 1 must not defeat a match).
  `profile.name_norm` is stored and indexed; email, phone and address
  comparisons normalize at compare time. What normalization must NOT do is as
  load-bearing as what it does: no stripping of entity suffixes (LLC, PC,
  Group), no abbreviation expansion, no Gmail-dot or plus-tag removal — every
  one of those is inference dressed as cleaning, and each is exactly how
  "Smith Law" and "Smith Law Group" become one key. Those two are a
  containment SUGGESTION, never an equality — and a suggestion is all it can
  be, per D7.

- **D9 — Delete exists, and refuses a profile with history.** A profile with
  any `case_profile` row is refused deletion (409 naming the count) and
  offered deactivation — so "never cascades to cases" is structural: the only
  deletable profile is one no case has ever linked. An unused profile deletes
  fully (phones, then contacts, then the profile). Removing a CONTACT is
  always allowed — the cases copied what mattered at intake — with deactivate
  offered beside it as the gentler state.

- **D10 — At most one preferred contact per profile, enforced by a partial
  unique index** (the `case_day_pauses` open-pause precedent): two taps on a
  flaky connection cannot crown two. Setting a new preferred clears the old
  one in the same batch.

- **D11 — The only profile default with commercial meaning is the legal
  payment ARRANGEMENT.** `profile.payment_arrangement` is accepted on
  law-firm profiles only, validated against the same `LEGAL_ARRANGEMENTS` the
  case editor uses, and prefills the Quick Legal arrangement select — a
  request, never a payment, exactly as on the case. **No figure of any kind
  lives on a profile** — no usual retainer, no rate, no matter number, no
  billing reference: `agreedRetainer()`, `PERSONAL` and `RATES` stay the only
  pricing sources, and the columns simply do not exist to freeze a price
  into. Nothing on a profile can mark anything paid; no profile read touches
  `retainer_payment`, `case_retainer` or the invoices.

- **D12 — Audit is row stamps plus the link row.** created_by/at and
  updated_by/at on profiles and contacts, `linked_by`/`linked_at` on
  `case_profile` — the `case_meta`/`legal_intake` norm, which is what "where
  existing audit logging supports it" supports. No `profile_event` table: an
  event feed for a rolodex is the CRM the brief forbids, and reads are never
  logged.

- **D13 — Inactive is a lens, not a lock — and inactive profiles stay inside
  duplicate detection.** Deactivated profiles leave the picker's default
  results and the directory's Active lens, but stay readable, linkable on
  explicit request, and one button from active again. They keep firing the
  possible-match warning, labelled inactive: a duplicate check that ignores
  inactive profiles manufactures the very duplicate it exists to prevent, the
  moment an old firm comes back. Archived-case reasoning applies: INACTIVE
  means "not in the working set", never "gone".

- **D14 — The quick forms' "also save as a reusable profile" tick creates
  nothing when a possible match exists.** It saves only a clean-miss new
  profile (and links it); on a possible match it creates nothing and says
  exactly why and where the explicit path is (the case screen's Use this
  profile / Save as profile). A convenience tick must not become the door
  that proliferates near-duplicates past the warning the deliberate doors get.

- **D15 — No website field, no city/state/ZIP columns, no avatars, no social
  fields, no event feed.** The brief's own conditions ("if current
  architecture supports it" — it does not) and its anti-CRM section decide
  all of these the same way. What the assignment flow does not consume, the
  profile does not store.

- **D16 — The boundary: admin-only at every door, and no public code path.**
  Every `/profiles*` route and `POST /cases/:no/profile` checks the admin
  role the way `/sheets` does; the workspace's `profile` rider is
  admin-gated like `WS.legal`; investigators get no directory, no picker, no
  chip, and the case list rows gained no profile columns at all. The public
  ingest cannot reach a profile table — `handleIngest` contains no profile
  read or write, and a submitted payload carrying `profile_id` writes no
  link (asserted by test). Public users cannot browse, search, or discover;
  there is no route to refuse them because the route does not exist on the
  public side.

## The second derivation

The schema was derived twice, independently — this document's design and a
second worked from the same brief and constraints without seeing it (the
house rule for high-stakes calls: two derivations that agree are evidence).
They converged on every load-bearing boundary: no CHECK on any growable enum,
phones as rows with a NULL `contact_id` as the organization's own line, the
partial unique index on preferred, one explicit case-link table as the only
connection — swept, and reachable only under `/cases/:no/` so the deleted-case
gate sees it — prefill through the existing manual-intake body, no price
columns, Worker-side normalization, and no merge operation existing at all.

Four structures the second derivation proposed were deliberately NOT adopted:

- **A separate normalized-key side table** (one row per comparable value,
  serving search and duplicate detection). Rejected for drift surface: a
  derived side table must be rebuilt by every writer and fails silently when
  one forgets — the stale-duplicate-of-a-boundary problem — while same-row
  derived columns (`name_norm`, `address_norm`, `digits`) cannot orphan.
  **The cost that argument does not remove, stated honestly:** a substring
  SEARCH is `LIKE '%x%'` and no index can seek it, so each search arm reads its
  table. That is bounded — admin-only, debounced, capped at `CANDIDATE_CAP`
  candidates and `PAGE_CAP` rows — and it buys back the thing that matters: the
  comparisons that run WITHOUT a person asking (the duplicate check's name,
  address and phone equalities) are indexed lookups, and the case workspace
  runs none of them at all. An early draft of this build claimed in a comment
  that every branch was an indexed lookup; it was not true, and a comment
  asserting something untrue about a boundary is worse than no comment.
- **A delete tombstone table.** The owner's brief prefers INACTIVE for
  profiles "already referenced by assignments" — which is a carve-out: a
  never-referenced profile (a typo, a test) may really delete. Refusing
  deletion whenever a link exists gives history the same protection with one
  fewer table and no hidden-profile filter on every read.
- **An `entity_kind` (org|person) column beside the type.** Derivable from
  `kind` in every current and plausible value, so storing both adds a
  consistency invariant and nothing else; the Worker keys behaviour off
  `kind` alone.
- **Multiple profile links per case with an origin flag.** The product needs
  one answer to "whose case is this" — `case_no` as the link table's primary
  key gives re-association REPLACE semantics and the UI one chip. A second
  relationship kind, if ever wanted, is an additive table then.

## What this unit deliberately does not do

No campaigns, scoring, pipelines, mass email, avatars, social fields, or
activity feeds. No Dropbox folder, no R2 object, no media read — a profile is
rows in D1 and nothing else. No SMS. No change to Insurance pricing or intake
rules, to the send-context model, to `FIELD_KEEP`, or to the public intake
form (`intake/index.html` is untouched by this unit). The Global Case Search
is Unit 8 and this picker is not it.

**Adding these tables means a manual `portal-setup.yml` dispatch after merge.**
Until it runs, every profile read degrades through `missingTables()` — the
directory says which workflow to run, the pickers simply do not offer, and
the one write returns 503 naming the workflow, exactly as `legal_intake` did.

---

## The owner's brief, verbatim (2026-08-20)

> Resume Always Precise Investigations from current clean master and NEXT.md.
>
> First verify:
> - Unit 6 / Legal Intake is merged and deployed
> - PR #192 is present
> - master is clean
> - origin/master is synced
> - required Legal schema/setup is live
> - no unfinished branch, stash, or unpushed work
>
> Repo and NEXT.md are authoritative.
>
> CURRENT ROADMAP
>
> 7. Repeat Client / Firm Profiles
> 8. Global Case Search + advanced Needs Attention
> 9. Multiple Report Templates
> 10. Case Timeline
> 11. Evidence Integrity
> 12. Storage Health
> 13. Case Closeout
> 14. Client Delivery Center
> 15. Retention Controls
>
> Start ONLY Unit 7.
>
> Do not begin Item 8.
>
> SAVE POINT POLICY
>
> Do not create routine pre-unit or mid-unit save points.
>
> Normal commits and pushes are sufficient during development.
>
> Create one normal save point after Unit 7 is:
> CODED
> TESTED
> PUSHED
> MERGED
> DEPLOYED
>
> Create an additional checkpoint only if a genuinely risky schema migration unexpectedly requires it.
>
> ==================================================
> UNIT 7
> REPEAT CLIENT / FIRM PROFILES
> ==================================================
>
> GOAL
>
> Make repeat assignments dramatically faster without turning the portal into a large CRM.
>
> An Admin receiving another assignment from an existing law firm, insurance carrier, attorney, adjuster, or repeat private client should not retype information already known.
>
> Primary experience:
>
> SEARCH EXISTING
> -> SELECT PROFILE
> -> PREFILL NEW ASSIGNMENT
> -> EDIT THIS ASSIGNMENT IF NEEDED
> -> CREATE
>
> Target:
> a repeat Legal or Insurance assignment should be startable in seconds.
>
> ==================================================
> CORE ARCHITECTURE RULE
> ==================================================
>
> Saved profiles are reusable DEFAULTS.
>
> Historical cases/intakes must remain historical snapshots.
>
> Editing a saved organization/contact later MUST NOT silently rewrite:
> - prior cases
> - prior intakes
> - prior reports
> - prior invoices
> - prior evidence
> - prior legal matters
>
> When a saved profile is selected for a NEW assignment:
> - prefill the new assignment
> - allow Admin to edit the assignment copy
> - preserve the case/intake's own values after creation
>
> Do not couple historical case truth to mutable profile data.
>
> If the existing schema already has a safe pattern for this, reuse it.
>
> ==================================================
> DO NOT BUILD A GIANT CRM
> ==================================================
>
> This unit does NOT need:
>
> - marketing campaigns
> - lead scoring
> - sales pipelines
> - tasks unrelated to investigations
> - mass email
> - complex contact history
> - duplicate document storage
> - notes copied everywhere
> - social-media fields
> - dozens of CRM metadata fields
>
> Build only what speeds up investigative assignment intake and billing/contact reuse.
>
> ==================================================
> PROFILE TYPES
> ==================================================
>
> Support lightweight reusable profiles for:
>
> 1. LAW FIRM
> 2. INSURANCE / ORGANIZATION
> 3. PRIVATE CLIENT
>
> Use a shared architecture where practical rather than three unrelated systems.
>
> Organization-based profiles should support multiple contacts.
>
> Private clients may be person-based.
>
> ==================================================
> LAW FIRM PROFILE
> ==================================================
>
> Store/reuse appropriate information such as:
>
> ORGANIZATION
> - Firm name
> - Main office phone
> - General email if supplied
> - Website if already appropriate/current architecture supports it
> - Office address
> - City
> - State
> - ZIP
> - Internal notes if useful and Admin-only
> - Active/inactive profile state
>
> CONTACTS
>
> Support multiple firm contacts with roles such as:
>
> - Attorney
> - Paralegal
> - Legal Assistant
> - Billing Contact
> - Office Manager
> - Other
>
> Each contact may include:
>
> - First name
> - Last name
> - Title/role
> - Email
> - Phone
> - Secondary phone where current phone architecture supports it
> - Optional phone label such as Mobile / Work / Home / Other
> - Preferred contact indicator if useful
>
> Do not require every contact field.
>
> A firm may have:
> - multiple attorneys
> - multiple paralegals
> - separate billing contact
>
> Do not cram them into one concatenated text field.
>
> ==================================================
> INSURANCE / ORGANIZATION PROFILE
> ==================================================
>
> Support reusable organization information such as:
>
> - Carrier/company name
> - Main phone
> - Main email
> - Address
> - City/state/ZIP
> - Active/inactive
>
> Contacts may include:
>
> - Adjuster
> - Claims Examiner
> - SIU Contact
> - Attorney
> - Billing Contact
> - Other
>
> Contact fields should reuse the same contact architecture where practical.
>
> Do not change existing Insurance pricing/intake rules.
>
> ==================================================
> PRIVATE CLIENT PROFILE
> ==================================================
>
> Support lightweight reuse for a repeat private client.
>
> Possible reusable information:
>
> - Name
> - Email
> - Phone(s)
> - Address
> - Preferred contact information
>
> Do NOT automatically reuse:
> - previous subject
> - previous allegations
> - old investigation facts
> - old evidence
> - old case narrative
>
> A repeat private client is still starting a new case.
>
> ==================================================
> ADMIN PROFILE DIRECTORY
> ==================================================
>
> Add a clean Admin-only Profiles / Clients & Firms area.
>
> Use the Unit 5 visual design system.
>
> Admin should be able to:
>
> - search profiles
> - filter by type
> - open profile
> - edit profile
> - add/remove/deactivate contacts
> - see basic contact information
> - start a new assignment from that profile
>
> Keep it operational.
>
> Do not expose huge analytics.
>
> Suggested filters:
>
> ALL
> LAW FIRMS
> INSURANCE
> PRIVATE
>
> Use existing navigation architecture intelligently.
>
> Do not overcrowd mobile navigation if a subpage under Clients makes more sense.
>
> ==================================================
> FAST SEARCH / PICKER
> ==================================================
>
> Inside Admin assignment/intake creation flows, provide:
>
> USE EXISTING CLIENT / FIRM
>
> Search should match appropriate structured fields such as:
>
> - organization name
> - person's name
> - attorney name
> - paralegal name
> - adjuster name
> - billing contact
> - email
> - phone
>
> This is a focused profile picker.
>
> Do NOT build the full Global Case Search engine here.
> That is Unit 8.
>
> Search results should be fast and lightweight.
>
> No media reads.
> No Dropbox calls.
>
> ==================================================
> QUICK LEGAL ASSIGNMENT INTEGRATION
> ==================================================
>
> Upgrade the Quick Legal Assignment built in Unit 6.
>
> At the beginning provide a clear choice such as:
>
> USE EXISTING FIRM
> or
> NEW FIRM
>
> If existing:
>
> 1. Search firm
> 2. Select firm
> 3. Select primary attorney/contact
> 4. Select paralegal if appropriate
> 5. Select billing contact if appropriate
> 6. Prefill firm/contact/billing information
> 7. Continue directly into:
>    - client
>    - subject
>    - assignment
>    - retainer
>    - payment arrangement
>    - deadline
>    - notes
>
> Do not ask Admin to re-enter the firm's address and contact data.
>
> If the firm has one obvious primary attorney/contact, a sensible default may be selected but must remain editable.
>
> ==================================================
> PUBLIC LEGAL INTAKE
> ==================================================
>
> DO NOT expose the firm's saved profile directory to public intake users.
>
> Public users must NOT be able to:
> - browse firms
> - search saved attorneys
> - discover client relationships
> - discover saved contacts
>
> The public Legal form continues accepting submitted information normally.
>
> When Admin reviews/accepts a Legal submission:
>
> If the submitted firm/contact appears to match an existing profile:
> - show a possible-match suggestion
> - allow Admin to associate/reuse it
>
> If no profile exists:
> - offer an explicit Admin action to save the firm/contact as a reusable profile
>
> Do NOT automatically merge submitted information into an existing profile.
>
> Do NOT silently overwrite saved contact information.
>
> ==================================================
> INSURANCE INTEGRATION
> ==================================================
>
> Add similar Admin reuse to Insurance intake/assignment flow.
>
> Example:
>
> USE EXISTING CARRIER
>
> Then:
> - select carrier
> - select adjuster/contact
> - prefill organization/contact information
> - enter new claim/case-specific information
>
> Do NOT reuse an old:
> - claim number
> - subject
> - assignment
> - incident details
> - investigation facts
>
> Those belong to the new matter.
>
> ==================================================
> PRIVATE INTEGRATION
> ==================================================
>
> For Admin-created Private assignments, allow:
>
> USE EXISTING CLIENT
>
> Prefill only reusable client identity/contact information.
>
> Do not prefill prior case-specific facts.
>
> ==================================================
> START NEW ASSIGNMENT FROM PROFILE
> ==================================================
>
> Inside an organization/person profile, provide a clear action:
>
> NEW ASSIGNMENT
>
> For a Law Firm:
> -> Quick Legal Assignment
>
> For Insurance:
> -> Insurance/Admin intake flow
>
> For Private:
> -> Private/Admin intake flow
>
> Prefill reusable identity/contact information only.
>
> This should be one of the fastest workflows in the portal.
>
> ==================================================
> CREATE / SAVE PROFILE
> ==================================================
>
> Provide sensible ways for Admin to create a reusable profile:
>
> - Profiles area -> New Profile
> - Accepted intake -> Save as Profile
> - Quick/Admin assignment -> optionally save new organization/client
>
> Avoid forcing Admin through a second giant form.
>
> If the assignment already contains the information, reuse those entered values.
>
> ==================================================
> UPDATE SAVED PROFILE
> ==================================================
>
> When Admin changes firm/contact information while creating a new assignment:
>
> DO NOT automatically mutate the saved profile.
>
> Where useful, provide an explicit action such as:
>
> UPDATE SAVED PROFILE WITH THESE CHANGES
>
> or otherwise keep profile editing separate.
>
> The owner must be able to intentionally distinguish:
>
> "This phone number changed for this case"
> from
> "This is the firm's new permanent phone number."
>
> Historical assignments remain untouched either way.
>
> ==================================================
> DUPLICATE PREVENTION
> ==================================================
>
> Prevent obvious profile proliferation without destructive automatic merging.
>
> Normalize where useful for comparison:
>
> - organization name
> - email
> - phone
> - address
>
> If Admin creates something that appears to match an existing profile:
>
> Show something like:
>
> POSSIBLE EXISTING PROFILE
>
> Then allow:
> - Use Existing
> - Continue as New
>
> Do NOT automatically merge based only on a similar name.
>
> Example:
> "Smith Law"
> and
> "Smith Law Group"
>
> may or may not be the same organization.
>
> Do not guess.
>
> ==================================================
> CONTACT DUPLICATES
> ==================================================
>
> Within an organization, detect obvious duplicate contacts where practical using normalized:
>
> - email
> - phone
> - name + organization
>
> Warn rather than silently merge.
>
> Allow two people with the same name.
>
> ==================================================
> PROFILE DELETION / DEACTIVATION
> ==================================================
>
> Prefer:
>
> ACTIVE
> INACTIVE
>
> rather than destructive deletion for profiles already referenced by assignments.
>
> If profile deletion exists:
>
> - Admin-only
> - explicit confirmation
> - must not destroy historical case information
> - must not cascade-delete cases/intakes
>
> Do not delete a historical case because a client profile was removed.
>
> ==================================================
> BILLING INFORMATION
> ==================================================
>
> Profiles may store reusable billing-contact information where appropriate.
>
> For Legal:
> - billing contact
> - billing email/address
> - matter-reference preference if useful
> - usual payment arrangement may be offered as a default only if existing rules make that safe
>
> Do NOT store a previous matter number as a universal firm value.
>
> Do NOT mark anything paid from a profile.
>
> Payment state remains case-specific.
>
> Legal options continue to exclude Cash App/Venmo.
>
> ==================================================
> RETAINER DEFAULTS
> ==================================================
>
> Do not invent new pricing.
>
> Legal continues to reuse Private pricing source.
>
> A profile may remember a useful preference only if it does not conflict with the authoritative pricing/retainer logic.
>
> Do not freeze old prices into firm profiles.
>
> The current pricing source must remain authoritative.
>
> ==================================================
> SCHEMA DESIGN
> ==================================================
>
> Inspect existing:
> - clients
> - contacts
> - phone storage
> - legal_intake
> - insurance/private intake
> - case references
>
> before creating new tables.
>
> Prefer a normalized lightweight model such as:
>
> organization/profile
> profile_contact
> profile_phone if existing phone architecture warrants it
>
> BUT do not blindly create those names if the repo already has appropriate tables.
>
> Avoid storing the same firm data repeatedly in several new tables.
>
> Any schema addition must be:
> - additive where possible
> - backwards compatible
> - idempotent in portal-setup
> - included in EXPECTED_TABLES / schema guards
> - safe on existing production data
>
> No destructive migration without stopping and reporting first.
>
> ==================================================
> PHONE NUMBER ARCHITECTURE
> ==================================================
>
> Where this unit touches phone handling, preserve the existing approved multiple-number direction:
>
> - Mobile
> - Work
> - Home
> - Other
>
> Preserve existing single-phone values.
>
> Do not make SMS functionality part of this unit.
>
> SMS remains outside scope.
>
> ==================================================
> STORAGE
> ==================================================
>
> This feature should consume almost no file storage.
>
> Profiles are structured database data only.
>
> Do not:
>
> - duplicate evidence
> - copy reports
> - copy media
> - create profile folders in Dropbox
> - upload contact avatars
> - create R2 objects
>
> No Dropbox storage is needed merely to create a reusable profile.
>
> ==================================================
> PROFILE DETAIL UX
> ==================================================
>
> A Law Firm profile might show:
>
> FIRM
> Name
> Address
> Main phone
> Main email
>
> PEOPLE
> Attorney
> Paralegal
> Billing Contact
> Other
>
> QUICK ACTION
> New Legal Assignment
>
> RECENT MATTERS
>
> If useful and cheap, show links to existing related cases/intakes using existing database relationships.
>
> Do not duplicate those cases into the profile.
>
> Limit the list sensibly.
>
> Do not create a giant activity CRM.
>
> ==================================================
> MOBILE UX
> ==================================================
>
> This must work well from phone because Admin may receive a call while mobile.
>
> Requirements:
>
> - no horizontal overflow
> - searchable profile picker
> - large enough touch targets
> - contacts presented as stacked cards on narrow screens
> - no giant desktop table on phone
> - clear New Assignment button
> - no tiny edit/delete controls
> - 16px mobile inputs
> - consistent Unit 5 styling
>
> ==================================================
> AUDIT / ATTRIBUTION
> ==================================================
>
> Where existing audit logging supports it, record important Admin actions such as:
>
> - profile created
> - profile edited
> - contact added
> - contact changed
> - profile deactivated
> - assignment started from profile
>
> Do not create noisy logs for every read/search.
>
> ==================================================
> PERMISSIONS
> ==================================================
>
> Profile directory is Admin operational data.
>
> Do not expose it to:
> - public intake users
> - unrelated investigator accounts
> - unauthorized roles
>
> Investigators may continue seeing the contact/case information already authorized within their assigned cases.
>
> Do not grant investigators general access to the firm's entire history/profile directory unless existing policy explicitly allows it.
>
> ==================================================
> PERFORMANCE
> ==================================================
>
> Profile search must be fast.
>
> Use indexed normalized searchable fields where appropriate.
>
> Avoid:
> - full-table expensive client-side filtering for large future datasets
> - N+1 contact queries where reasonably avoidable
> - Dropbox calls
> - media loads
>
> The architecture should comfortably support many repeat clients/firms later without redesign.
>
> ==================================================
> FOCUSED TESTS
> ==================================================
>
> Add durable focused assertions covering at least:
>
> LAW FIRM
>
> - create firm profile
> - multiple attorneys
> - paralegal
> - billing contact
> - multiple phone numbers where supported
> - edit profile
> - deactivate profile
> - old cases remain unchanged after profile edit
>
> QUICK LEGAL
>
> - Use Existing Firm
> - select attorney
> - select paralegal
> - select billing contact
> - prefill correct reusable information
> - case-specific values remain blank/new
> - profile edit does not retroactively change old matter
> - assignment edits do not automatically mutate profile
>
> PUBLIC LEGAL
>
> - public user cannot browse/search saved firms
> - accepted submission may be explicitly linked to existing profile
> - possible duplicate does not auto-merge
>
> INSURANCE
>
> - existing carrier reuse
> - adjuster selection
> - new claim-specific information not copied from old assignment
>
> PRIVATE
>
> - existing client identity/contact reuse
> - prior subject/case facts not copied
>
> DUPLICATES
>
> - normalized obvious-match warning
> - no destructive automatic merge
> - same-name contacts remain allowed
>
> PERMISSIONS
>
> - Admin can manage profiles
> - unauthorized roles cannot browse profile directory
> - investigator case permissions unchanged
>
> MOBILE
>
> - profile picker fits narrow phone
> - contact cards fit
> - buttons/touch targets fit
> - no page-wide overflow
>
> SCHEMA
>
> - setup idempotent
> - expected tables/guards updated if required
> - existing production records survive setup
>
> ==================================================
> REGRESSION TESTING
> ==================================================
>
> After focused tests pass:
>
> - Worker suite
> - Intake suite if touched
> - Deploy guard
> - Portal suite
>
> Run the full relevant portal suite once.
>
> Do not repeatedly rerun long suites unless a failure belongs to this unit or needs a confirming rerun.
>
> If a failure looks unrelated:
> compare against master before changing unrelated production behavior.
>
> ==================================================
> SHIP UNIT 7
> ==================================================
>
> When green:
>
> CODED
> TESTED
> PUSHED
> CREATE PR
> MERGED
> DEPLOYED
> RUN portal-setup only if schema/setup changed
> VERIFY required deployment/setup
> CREATE ONE MAJOR SAVE POINT
> UPDATE NEXT.md
>
> LIVE VERIFIED remains OPEN for actual-device interactions that automation cannot prove.
>
> STOP after Unit 7.
>
> Do NOT begin Item 8.
>
> ==================================================
> FINAL REPORT
> ==================================================
>
> Report:
>
> UNIT 7 - Repeat Client / Firm Profiles
>
> PR:
> MERGE SHA:
> SAVE POINT:
>
> CODED
> TESTED
> PUSHED
> MERGED
> DEPLOYED
> LIVE VERIFIED
>
> TEST TOTALS:
> SCHEMA CHANGE:
> PROFILE TYPES:
> PERFORMANCE NOTES:
> LIVE DEVICE CHECKS OPEN:
>
> NEXT:
> Unit 8 - Global Case Search + Advanced Needs Attention
