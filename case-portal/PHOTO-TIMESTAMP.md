# Timestamp Photo — what was asked for, and what was derived (INTERNAL)

**Written before any code, 2026-08-18**, the way `VIDEO-TIMESTAMP.md` was, so
that the reasoning is on disk instead of in a session that will end.

## What the owner actually said

All of it:

> 2. Build Timestamp Photo

That is the whole brief. It arrived as item 2 of the locked roadmap order
recorded in `NEXT.md`, immediately after *"Finish current Active Surveillance
mobile and voice polish"*.

**Four words is not a specification, and this file exists so that nobody later
mistakes what follows for one.** Everything below is either (a) taken from the
owner's own video-timestamp brief, which is their words about the same problem
one file over, or (b) marked **DERIVED** — a decision this build made, which the
owner may overturn at no cost to anything already stored.

## What comes straight from the owner (`VIDEO-TIMESTAMP.md`)

The video brief is not a different subject. It is the owner describing what a
timestamped piece of evidence has to be, and every sentence of it applies to a
photograph without translation:

| The owner's rule, for video | Applied to a photograph |
| --- | --- |
| *"The original video must never be modified."* | The original photograph is never modified — not recompressed, not overwritten, not re-keyed. |
| *"Create a separate timestamped derivative."* | The stamp produces a **second** evidence row. |
| *"The system must distinguish ORIGINAL EVIDENCE from TIMESTAMPED COPY."* | Both are badged, everywhere either appears. |
| *"Use the existing evidence/storage architecture wherever possible; do not duplicate storage systems unnecessarily."* | The derivative is an ordinary `case_evidence` row in the case's Dropbox `Photos` folder. No new store, no second upload path. |
| *"date/time visibly burned into the bottom-right corner"* | Same corner, same face, the same `vstDraw` — literally the same function. |
| *"Do not hard-code fixed EST year-round"* | Same `vstLabel`; `Intl` resolves EST or EDT from the date itself. |
| No paid external service; no faking the burn-in with CSS. | Same. The pixels are burned on a canvas in the operator's own browser. |

**Where the video brief and a photograph genuinely differ, it is one thing:** a
clip has a running clock and a photograph has a single instant. Everything the
video feature does to advance a clock frame by frame has no counterpart here,
and none of it is carried over.

## DERIVED — the decisions this build made

Each of these is a judgement call. They are listed so they can be overturned
individually rather than argued about as a lump.

**D1. The door is the photograph, not a top-level screen.** Timestamp Video is a
top-level door because the portal never holds the clip — there is nothing to
hang the action on. A photograph is already in the case, so the action lives on
it: the gallery, and the field view's own photo list. Adding a second top-level
door would mean uploading the original through a path that already exists.

**D2. The derivative is stored, not saved to the device.** This is the one place
the photo path deliberately diverges from the video path, and the reason is the
storage decision that was already made: **video is device-first because video
bytes must never become Cloudflare storage — photographs already go to Dropbox
and have since 2026-08-18.** Sending a stamped photograph to the device instead
of the case would be inventing a restriction the owner did not ask for, on the
one file type that has somewhere to go. Nothing here touches R2, so the free-plan
failsafe is not in play, exactly as it is not for any other photograph.

**D3. The instant is the operator's, seeded from the camera where the camera
said so.** A photograph's EXIF `DateTimeOriginal` is the camera's own record of
when the shutter fired, and it is the right seed. But EXIF is frequently absent
(stripped by a share sheet, a screenshot, a scan) and it carries **no time zone**
unless `OffsetTimeOriginal` is also present. So:

- read it when it is there, and **say on screen that it came from the camera**;
- when it is not there, the fields start **empty** and the operator fills them —
  never `file.lastModified`, which on a Photos export is when the export was
  written, and never today's date, which would be a plausible-looking lie;
- either way the operator confirms before anything is burned, and what was
  burned records **which of the two it was**.

`file.lastModified` is rejected here for the reason already measured and written
down in `VIDEO-TIMESTAMP.md`. It is not a second opinion about when the picture
was taken; it is a fact about a file system.

**D4 — SUPERSEDED BY THE OWNER, 2026-08-18.** See "The package rule" below.
This build originally shipped both halves of the pair as deliverable and said
so on screen; the owner read that and decided otherwise the same day.

**D5. A correction supersedes, it does not overwrite.** Re-stamping the same
original inserts a new record and marks the previous one superseded, matched on
the **original's id** — an id, not a filename, so no caller can supersede
another photograph's stamp by naming it. This is the project's existing audit
shape (`send_log`, `build_events`, `invoice_events`, `video_stamp`), and the
superseded derivative's own evidence row is left alone: removing it would be a
purge, and nothing in this portal purges.

## What is NOT built, and is not an oversight

- **No change to what a client package ships.** Still not authorised (the same
  line in `VIDEO-TIMESTAMP.md` still stands). The derivative is ordinary
  evidence and is treated as ordinary evidence.
- **No EXIF writing.** The burn is into the pixels because that is what was
  asked for. Writing a corrected EXIF field into the original would be modifying
  the original, which is the one thing the brief forbids outright.
- **No batch stamping.** One photograph, one deliberate act, one confirmation of
  the instant. A batch would mean applying one operator-typed time to pictures
  taken at different moments.
- **No stamping of documents or PDFs.** The action is offered on images the
  browser can actually decode, and on nothing else.

## The package rule — the owner's own words, 2026-08-18

> Preserve the original untouched as case evidence, but do not automatically
> include both original and timestamped copy in the client package.
> Add "Include timestamped copy in client package" default ON. Original keeps
> its existing classification unless Admin explicitly selects it.

Three sentences, and each one lands somewhere different:

**"Preserve the original untouched as case evidence"** — unchanged, and it was
already the first rule of the whole feature. Nothing in the stamp route reads or
writes the original beyond looking it up.

**"Include timestamped copy in client package, default ON"** — a checkbox on the
generate screen, and what it decides is the classification the copy is **born
with**. ON: the original's own classification, so an ordinary deliverable
photograph produces a deliverable copy. OFF: `internal_only`, which is how this
portal already says *in the case, not for the client*.

There is deliberately **no second flag**. Package eligibility already IS
`classification === 'client_deliverable'`; an `include_in_package` column beside
it would be a second answer to one question, and the two would disagree the
first time an admin changed the copy's classification by hand. The
classification is the record.

Two things the switch cannot do. It cannot **widen**: a held-back original still
produces a held-back copy, because the inheritance ceiling is the package gate
and that is the one thing the gate exists to stop. And turning it OFF on an
original that was already `do_not_use` inherits rather than rewriting it as the
milder `internal_only` — the switch picks between *as the original* and *held
back*, never a third meaning.

**"Original keeps its existing classification unless Admin explicitly selects
it"** — so the original is not reclassified by anything here, and the "do not
include both" half is enforced where inclusion actually happens: **the package
picker**. An original whose live timestamped copy is deliverable is shown as
having the copy going in its place, and its Add becomes an explicit **Add
anyway** rather than the ordinary one. Nothing refuses it; the Worker's
`POST /build/:id/items` is untouched, because an Admin explicitly selecting the
original is exactly what the owner allowed for.

## Open for the owner

1. Whether the burned face should carry anything besides the date, time and zone
   — a case number and an investigator's initials are both plausible and both
   would be **DERIVED**, so neither is there.

---

# What was built

## The route

`POST /cases/:no/photo-stamp` — multipart: the burned copy, the original's
evidence id, the instant (UTC), the zone, and the provenance. It is the only
writer.

What it does, in order, and the order is deliberate:

1. `caseFor` — an investigator reaches only their own cases, exactly as the
   ordinary upload does. **Not admin-only:** the person who took the picture is
   the one standing in the field with it.
2. The `photo_stamp` guard — 503 naming `portal-setup.yml`, because the table
   arrives by a manual dispatch while the Worker deploys on push.
3. The original is **looked up, never trusted from the body**: this case's, not
   deleted, and an image. Another case's photograph is refused rather than
   silently ignored.
4. **A copy of a copy is refused by name** (`already_a_copy`).
5. The instant, the zone and the provenance are validated. There is no default
   provenance — an evidence timestamp with no recorded origin is one nobody can
   defend.
6. Dropbox, in the ordinary upload's own words for the same three conditions.
7. The bytes go to `/<case>/Photos/`. **Nothing is recorded until they are
   safe** — a refused upload leaves no `photo_stamp` row and no evidence row.
8. The evidence row, then the supersede, then the pairing.

The deleted and archived gate needs nothing here: the case number is in the
path, so `route()`'s one chokepoint answers first.

## What the page does

`PST` in `portal/index.html`, a sibling root beside `#vstamp`.

- Reads the original **back from the case** through the existing evidence route,
  so the copy is made from the file the case actually holds rather than from
  something the browser happened to still have.
- **Proves the decode before offering anything.** A picture this browser cannot
  open gets the reason where the action would have been — the lesson `vstProbe`
  already learned about HEIC and `.mov`, and HEIC is named in the wording
  because it is the case an operator will actually hit.
- Seeds from EXIF `DateTimeOriginal` (with `OffsetTimeOriginal` when the phone
  wrote one), and says on screen which of the three it is: the camera with its
  zone, the camera without one and therefore read as Eastern, or nothing at all.
- Burns with **`vstDraw`** and words it with **`vstLabel`** — the video
  renderer's own functions.
- The burned wording **follows the typing**, and only that one line is rewritten:
  a repaint would rebuild the box the cursor is in, mid-number.
- Shows the copy before it is filed, then posts it.

## The tests, and the one that matters

The strongest assertion in the suite is a pixel read, not a wording check: the
fixture is a **flat-colour JPEG this browser wrote itself**, with an EXIF APP1
segment spliced in after the SOI marker, and after filing the test decodes both
files and counts bright pixels. The bottom-right corner of the copy has them,
the top-left has none, and the original has none in either place. A screen full
of confident wording cannot stand in for that.

The rest: the seed comes from the camera and not the clock; a file with no EXIF
fills in nothing and says so; the current year never appears as a seed; the
zone resolves to EDT for an August date; a correction supersedes and the
superseded copy keeps its place; the copy is never offered for stamping and the
original always is; every classification is inherited including the four that
hold material back; a document is refused; another case's photograph is refused;
an investigator can stamp on their own case and reaches nothing on another's;
deleted and archived are refused by the gate; the table missing degrades the
read and 503s the write; and Dropbox refusing leaves no row of any kind.
