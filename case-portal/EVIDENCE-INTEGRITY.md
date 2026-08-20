# Evidence Integrity — the owner's brief, and what this build derived

**Unit 11, roadmap item 11.** Built 2026-08-20. The owner's brief arrived in
full as the unit instruction; the operative parts are quoted verbatim below,
each beside what was built for it. Decisions the brief did not make are listed
at the bottom, **one per entry**, so any one can be overturned without
disturbing the others.

## The goal, in the owner's words

> *"Add lightweight, defensible evidence-integrity tracking without duplicating
> evidence files or increasing storage materially. For evidence and intentional
> derivatives, record enough metadata to answer: What file is this? Which case
> does it belong to? Who added/generated it? When was it captured/uploaded/
> generated? Is it an original or derivative? If derivative, what source does
> it relate to? What is its SHA-256? Where is the authoritative stored copy?
> Has the stored byte content changed from the recorded hash?"*

One additive table answers all nine: **`evidence_integrity`**, one row per
recording, the live record being the newest unsuperseded row for an
(`artifact_kind`, `artifact_id`) pair.

## The core rule, applied structurally

> *"The hash describes the exact bytes of the specific artifact being recorded.
> Original and derivative are separate artifacts and therefore may have
> different hashes. Do not claim a timestamped copy is byte-identical to the
> original. Do not use metadata-only fingerprints as a substitute for SHA-256."*

Every writer hashes the buffer it is itself holding for its own artifact; no
code path copies a digest between records. The suite uploads an original,
stamps a copy with different bytes, and asserts the two records disagree while
the original's is untouched.

## Where hashing happens — the whole design

> *"Prefer hashing during a file operation where bytes are already available,
> rather than downloading the file again solely to hash it."*

The four filing paths all held the complete bytes already:

| Path | Bytes were already in hand as | Origin recorded |
| --- | --- | --- |
| Evidence upload | the `arrayBuffer()` handed to Dropbox | `worker` |
| Timestamp Photo filing | same | `worker` |
| Filed report PDF | same | `worker` |
| Timestamp Video → Dropbox | **never whole in the Worker** — 8 MB session parts | `device` |

The video is the honest exception: the generating browser hashes the very blob
it uploaded and sends the digest with `finish`. `hash_origin` records which of
the two happened — the `photo_stamp.source` idea again. A junk digest is
refused by shape (`HEX64`); an absent one files the copy and leaves the record
unwritten.

## Nothing is backfilled, and nothing is read unasked

> *"Do NOT automatically download every historical Dropbox file to backfill
> hashes."* · *"Do not run this against all case media automatically when a
> case opens."* · *"No Dropbox byte fetch unless explicit."*

Ordinary rendering reads only `evidence_integrity` rows riding with the
workspace. Two admin actions read bytes, one file at a time, because a button
was pressed: **Record integrity hash** and **Verify integrity**. The suite
counts Dropbox calls across a workspace read and a manifest build and asserts
zero.

## The statuses, and what "verified" is not allowed to mean

> *"Do not use 'Verified' to mean legally authenticated by a third party.
> Prefer wording that truthfully means: 'the current bytes match the hash
> recorded by this portal.'"*

- **Hash recorded / Not yet recorded** — the stored state, derived from the
  record's presence, never a flag.
- **Match / Mismatch** — the verify answer, about NOW, computed and shown but
  **never stored**: a stamped "verified on the 3rd" would draw as a
  present-tense claim about bytes nobody has looked at since.
- **Unavailable** — the store would not answer, or the file exceeds what the
  Worker can hold; shown with the recorded hash, never as a pass or fail.

## Failure honesty at the filing routes

> *"Do not create a database integrity record claiming a file exists if the
> file save failed. Do not falsely show success if hash recording failed."*

The record is written **after** the bytes are safe, and its failure does not
turn a stored file into an error: the response carries
`integrity: 'recorded' | 'not_recorded'` with the reason. Both directions are
asserted.

## Edits, replacement, deletion

> *"Hash records should not silently mutate when someone edits descriptive
> metadata."* — `editEvidence` touches classification and note only; the suite
> reclassifies a file and asserts its record did not move.

> *"If actual file bytes are intentionally replaced… must not silently
> overwrite the old hash."* — this portal has **no replace route** (Dropbox
> uploads are `add` + autorename; originals are never overwritten), so the case
> arises only as a re-record, which **supersedes**: new row, earlier row
> stamped `superseded_at` and kept, response naming the previous digest and
> whether the answer changed.

> *"Do not necessarily delete all integrity history"* on evidence delete — the
> tombstone keeps every integrity row; Record refuses (`deleted`) and Verify
> answers `unavailable` with the recorded hash still shown.

## The manifest

> *"Generated from integrity metadata, not duplicate media… Do not expose
> secret Dropbox tokens or internal credentials."*

`GET /cases/:no/manifest`, admin-only: every evidence row in filing order with
digest, role, source, classification, uploader and times; filed report PDFs and
timestamped video copies listed **apart**, because they are not case evidence.
Zero byte reads, zero Dropbox calls, no token anywhere in the payload
(asserted by grep of the JSON). Print is the existing print-region pattern
(`#mandoc` beside `#tldoc`); no second PDF writer (the Unit 9 test still counts
exactly one), no automatic copy anywhere.

## Derived decisions — each overturnable on its own

- **D1 — One table for all artifact kinds** (`evidence`, `video_stamp`,
  `report_pdf`) rather than one per kind: the questions are identical, the
  manifest reads one statement, and `artifact_kind` is Worker-validated with no
  CHECK so a fourth kind is an ordinary edit.
- **D2 — Supersede, never update** for re-records: `photo_stamp`'s shape,
  because integrity history that can be quietly overwritten is worth nothing in
  the one conversation it exists for.
- **D3 — `hash_origin` provenance column** (`worker` | `device`): an integrity
  record whose origin is unstated is one nobody can weigh.
- **D4 — The video digest is device-computed, optional, and shape-checked.**
  The Worker never holds the clip whole (that is the session upload's point),
  Web Crypto has no incremental digest, so the generating device is the only
  honest hasher. Absent → filed anyway, `not_recorded`. Malformed → refused.
- **D5 — The report PDF's artifact is the BUILD** (`report_pdf`/`build_id`),
  not a `case_evidence` row: a report of the case is not evidence in it (the
  `saveBuildPdf` rule), and the manifest lists it apart for the same reason.
- **D6 — `integrityTarget` scopes the id to the case in the same statement**,
  so the hash routes cannot be used to probe another case's ids: wrong-case and
  never-existed answer byte-identically. The brief's probe rule, structural.
- **D7 — Verify writes nothing.** No `last_verified_at`: a stored pass would
  draw as a present-tense claim about bytes nobody has looked at since — the
  failsafe-reporting-the-opposite shape this repo has been bitten by.
- **D8 — `INTEGRITY_MAX_BYTES` read ceiling** (default: the per-file upload
  limit), env-overridable for tests: a re-read refuses (`too_large` /
  `unavailable`) rather than discovering in production that a legacy clip does
  not fit in Worker memory. Nothing filed through the portal exceeds it.
- **D9 — `storage_ref` is admin-only on the way out** (`integrityOut`): the
  path inside the App Folder is office filing; the field sees the hash, the
  role, the provenance — the FIELD_KEEP posture applied to a new surface.
- **D10 — The workspace sends `null`, not `[]`, before portal-setup** — the
  three-state rule: unknown must not draw as "no file has a hash".
- **D11 — Uploads are recorded as `original`; the only derivative markers come
  from explicit relationships** (the photo-stamp pairing, the build, the video
  record). On-demand Record consults `photo_stamp` — never filenames — to type
  a stamped copy correctly. "Do not infer a source relationship from similar
  filenames alone", enforced by there being no filename comparison anywhere.
- **D12 — `capture_at` is written only where an authoritative instant exists**
  (the burned instant on a photo stamp). The plain upload writes `filed_at`
  and leaves capture empty — upload time is never substituted.
- **D13 — The manifest lives on the media panel and prints via `#mandoc`**;
  a Dropbox save of a manifest is NOT built (the brief allows deferring it) —
  documented follow-up rather than a fifth writer this unit.
- **D14 — Integrity UI state resets on `openCase`** (`EV_VERIFY`, `MAN*`): an
  answer carried to the next case would state another file's facts — the
  retainer-form lesson at a new surface.

## What this unit deliberately does not do

No thumbnails, no R2 objects, no media duplication, no automatic manifest PDF,
no automatic backfill, no scan of Dropbox, no shared links, no
chain-of-custody claim. If a custody log is ever wanted it is a different
feature with a different name, and every transfer would have to be a recorded
fact.
