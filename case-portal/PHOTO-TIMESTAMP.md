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

**D1 — WRONG, AND CORRECTED THE SAME DAY.** The original reasoning: *"Timestamp
Video is a top-level door because the portal never holds the clip — there is
nothing to hang the action on. A photograph is already in the case, so the
action lives on it."*

That was true and it was **not enough**. With no photograph uploaded there is no
card, and with no card there was no entry point **anywhere** — so the tool was
invisible until someone had already done the thing it existed for. The owner
went looking for it beside Timestamp Video and found nothing, which is the whole
proof.

It now has four doors, beside the video ones in every place video has one: the
**navigation foot** (both roles, every screen), the **dashboard quick tools
row**, its **own card on Case media**, and the **field view's media screen** —
that last because inside the field view the navigation rail is not on screen at
all, so the nav door does not reach it there.

The top-level copies carry an **empty `data-case`**, the same rule the video
door follows: the utility asks which case rather than adopting whichever one is
open behind it. Unlike video it always needs a case, since the original it
copies lives in one, so "no case" is a **question** here and never a skip. A
case with no photographs says so and says where one comes from — an empty grid
with no words is the same dead end in a different costume.

**The lesson worth keeping:** "there is somewhere natural to put this control"
is not the same as "someone can find this control". The second needs its own
check, and the reachability assertions are now written as a **pair** across both
tools, so a door that exists for one and not the other fails rather than
ships.

**D2 — REPLACED BY THE OWNER AFTER A DEVICE TEST, 2026-08-19.** The original
reasoning was that photographs have somewhere to go, so a stamped photograph
should be stored rather than saved to the device. What that produced was a tool
that could not do its one job without first being told where to file the result.

The owner's words: *"Match Timestamp Video: choose a local photo first on iOS
Android Mac or Windows, timestamp it locally, then optionally choose a case only
for Dropbox or case filing."*

So the ORDER changed, not the storage. The copy is made on the operator's own
machine from a picture on that machine, and it is theirs immediately — saved to
the device through the same file-picker / share-sheet path the video tool uses,
with the same honesty about which of those may be called a save. **Filing is a
separate, optional act**, and it is the only thing that uploads anything or
leaves a record in the portal. When a case IS chosen, the original goes up
beside the copy — the owner's rule that it is preserved untouched as case
evidence is what makes the pair a pair.

Both entrances still exist. A photograph already in the case (the gallery card,
the field media card) skips the picker and skips uploading an original, because
it is already the original.

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

---

# V2 — MANY PHOTOS, ONE AT A TIME, EVERY COPY A CLEAN DERIVATIVE — 2026-09-28

Owner brief (51 sections), built only after Timestamp Video V2 had shipped
(PR #343), on the merged master, as its own PR: *"Do not mix Video and Photo
changes in one PR. Do not let the second unit alter or regress the first. Reuse
shared queue/UI components only where genuinely appropriate. Keep separate
media-specific processing logic."* Everything in the sections above still
holds — the route, the table, the package rule, the doors, the inherited
classification — and every one of their tests still runs.

## 1. What is shared with Video V2, and what is the photo's own

**Shared, because it is presentation or generic:** the dashboard's CSS (the
`.vqd` classes, with a `.pqd` modifier for the three places a photograph looks
different), the icons, the name sort, the folder walker, the drag test, the
narrow-screen test, the size and badge helpers, `vstLabel`/`vstStart`/`vstToUtc`
(one clock, one wording), `vstSha256`, and `vstDraw` — which gained a corner
argument (§4).

**The photo's own, because it is media processing:** everything that touches a
picture's bytes — the metadata reader (`pqMeta`), the orientation plan, the
render, the JPEG scrub, the clean check, the fingerprints, the queue state
(`PQ`), its statuses and its dashboard's markup. No video function was changed
except the two below, and both keep the video's output byte-identical:

| Shared function | Change | Why the video is unaffected |
| --- | --- | --- |
| `vstDraw(cx, W, H, text, pos = "br")` | a corner | the video never passes one; a test compares the new function, pixel for pixel, against a frozen copy of the one Video V2 shipped (master `845a50c`) at five video and photo sizes, with and without the corner named |
| `vstCopyName(ms, tz, n, ext = "mp4")` | an extension | the video never passes one |

## 2. The door opens the queue

Every door — the navigation foot, the Home card, Case media, the field view —
opens the dashboard, empty, with nothing chosen and nothing read, because the
queue is where photographs are dropped. Its drop zone is a `<button>`, so a
click, a tap, Enter and a drop all arrive at one door. The picker takes several
files at once (`multiple`, `accept="image/*"`, **no `capture`** — capture would
force the camera, and the operator is choosing photographs that already exist;
on an iPhone this is the Photo Library with multiple selection, Take Photo and
Files). A desk browser also offers *Select folder*.

**Adding is not starting.** A drop, a pick and a folder all go through one
`pqAdd`: what is not a photograph is left out and named; a photograph already in
the queue is not added twice; from a FOLDER a file must positively look like a
photo (a folder holds more than photographs), while a file picked by hand gets
the forgiving test the single picker always used. **The queue holds 500**
(`PQ_MAX`), and past it the screen says how many were left out — measured
usable at 1, 10, 50 and 100 (§9). The queue lasts while the page is open and is
saved nowhere (§37): closing the page clears the list, never the files.

**The Case media door** (`pstOpen`) opens the queue with that photograph in the
editor and its case already known, read back from the case through the existing
evidence route and decoded from the recorded content type — the IMG_3576 rule.

## 3. One writer per status, and READY means a time you can stand behind

`pqStatus` derives READY / NEEDS REVIEW / ANALYZING / PROCESSING / COMPLETE /
FAILED from the entry every time it is drawn. **READY needs the camera's own
record WITH its zone** (EXIF `DateTimeOriginal` + `OffsetTimeOriginal` — an
exact moment), **or a time the operator saved.** A camera time with no zone is a
reading on a clock, not a moment, so it stands at NEEDS REVIEW until it is
saved; so does a photo with no time at all. `file.lastModified` is still never
used (D3 above), and neither is today's date.

**This amends D3**, which interpreted a zone-less camera time as Eastern and
said so. It still fills the boxes with that reading, in Eastern by default,
with the zone picker beside it — but Generate waits for a Save, because Process
next (§7) must not be a way round the look the single screen always made the
operator take.

## 4. Each photograph's settings are its own

The editor holds THIS photograph's date, time, zone and stamp corner. Typed
values are a **draft** until Save writes them to this photo and no other; typing
never repaints (the burned-in label, the preview's stamp and the zone names are
updated in place); and **moving off a photo with an unsaved change asks** — Save
and continue, Discard changes, or Stay here — and never keeps or drops the change
silently (§16).

- **Eight named zones** (Eastern, Central, Mountain, Arizona, Pacific, Alaska,
  Hawaii, UTC), each labelled for the photo's own date — *"EDT (UTC−4) —
  Eastern"* in September, EST in January.
- **Four corners**, bottom right first because it is where the stamp has always
  gone. `vstDraw` computes the corner from the same face and the same safe
  margin; the stamp moves, it never resizes (asserted to 2px across corners).
- **The detected time is shown beside the selected one and is never
  overwritten** (§11). Where the camera's time is an exact moment and the
  operator has not typed over it, changing the zone shows **the same moment** in
  the new zone; any other time is a reading on a clock, and the zone only says
  which clock.

**Safe bulk convenience (§17)** is two buttons, each changing exactly one
setting, only when pressed and confirmed, naming the zone or corner and the
count: *Apply timezone to all* and *Apply stamp position to all*. Neither
touches a date or a time. A photograph already made keeps the settings its copy
was made with.

## 5. Orientation — CRITICAL (§13, §45)

**The copy is turned into the pixels, and carries no tag to be turned by
again.** `pqOrientPlan` decides, per photograph, who turns it:

| Plan | When | Who turns it |
| --- | --- | --- |
| `none` | tag absent or 1 | nobody |
| `decoder` | this browser's decoder applies EXIF orientation for this format | the decoder, once |
| `manual` | this browser's decoder ignores it for this format | the page, by the tag's own transform |
| `heif` | HEIC / HEIF / AVIF | the decoder, from the format's own `irot`/`imir` — an EXIF tag inside a HEIC is never applied a second time |
| `fail` | the answer cannot be established | **nobody — the photo is FAILED, never guessed** |

Which decoders turn which formats is **measured on this device**, once per
format, by decoding a 4×2 probe carrying orientation 6 (`PQ_PROBE`, cached in
`PQ_ORIENT`) — never assumed from a browser's name. For tags 5–8 the decoded
size is also held against the raw stored size read from the file's own header
(JPEG SOF, PNG IHDR, WebP VP8/VP8L/VP8X, TIFF, BMP, HEIF `ispe`), so a decoder
that turned one photo and not another cannot slip through. **Measured here:**
Chromium turns a JPEG by its tag and **ignores the tag on a WebP**, so a WebP
stored on its side is `manual` — a copy made on the assumption that "the browser
handles it" would have come out on its side.

## 6. The clean derivative (§22–§29)

The owner's preferred architecture, and the only one this has:

    decode the original → orient into pixels → stamp → FRESH JPEG encode
    → scrub → verify clean → decode back → fingerprint copy → re-check original

**Nothing of the original's container reaches the copy.** The canvas is filled
white (a transparent PNG must not turn black), drawn in sRGB, stamped and
encoded at quality 0.92. The encoder's own output is then **scrubbed**
(`pqScrubJpeg`) down to what a picture needs:

| Kept | Dropped |
| --- | --- |
| SOI; a **fresh** JFIF APP0 this tool writes (1.01, 1:1, no thumbnail); DQT; DHT; the one SOF; DRI; SOS and its scan; EOI | every other APPn (EXIF, XMP, ICC, IPTC/Photoshop, maker data, MPF previews), COM, and anything after EOI. **An unknown marker returns null** — a structure this is not ours to guess at, refused as an encode fault |

**Measured, and the reason the scrub is load-bearing:** this browser's own
canvas JPEG carries an ICC APP2 naming its maker (*"Google Inc. 2016"*). With the
scrub switched off, the check below refuses every copy (test O), so a copy that
ships with the encoder's own signature is not a possibility the tests merely
hope against.

**Colour (§24).** The pixels are sRGB and the copy carries **no** profile: an
untagged JPEG is read as sRGB by convention, which is generic and names nobody.
A wide-gamut original (an iPhone's Display P3) is converted to sRGB by the
browser when drawn, so the most saturated colours can clip slightly — the
appearance of the correctly rendered original, within sRGB, which is what §24
asks for.

**`pqCleanCheck` proves it, independently of the steps that made it clean** —
run on the bytes that will be offered, before any Blob exists: exactly the
fresh APP0 at offset 2; well-formed DQT/DHT/SOF/SOS/DRI; one frame, at the size
it was drawn; image data present; an end marker and **nothing after it**; no
other segment of any kind; and every word the original's metadata carried,
plus its file name, stem and folder path, searched for — in UTF-8, UTF-16LE and
UTF-16BE — in every byte that is not image data or a proven table. A failure is
a **`clean` fault**: no copy, no object URL, no Generate under it, the check's
own words on the screen (*"The copy carries an APP2 (colour profile or
previews)…"*).

**Then:** the copy is decoded back and must be a picture at the size it was
drawn; its SHA-256 is taken (Web Crypto, or the in-place hasher); and the
**original is read again** and held to its fingerprint from before (or byte for
byte where no fingerprint could be taken). An original that changed after it
was queued is refused before anything is made (*Choose this photo again*); one
that reads back differently after is refused and the copy discarded. **Two
fingerprints, two fields, never one** (§28–§29).

## 7. One at a time, and only when pressed

Generate makes one photograph. Nothing else starts. *Process next* names the
next READY photo after the one just made, wraps to the top, skips any NEEDS
REVIEW, and runs only because the operator pressed it. **One finished copy is
held in memory**: starting another lets go of a copy already saved or filed,
and asks first about one that is not. The run shows the owner's six phases —
Reading original, Normalizing orientation, Applying timestamp, Encoding clean
derivative, Verifying metadata, Fingerprinting derivative — each ticked only
when the work reaches it, and **no percentage**, because there is nothing to
count.

**THERE IS NO STOP, AND THAT IS §21 BEING OBEYED.** *"If photo generation is
effectively instantaneous and cannot meaningfully be stopped mid-operation: do
not fake a Stop control. Be truthful to the architecture."* A photograph is made
in a few seconds by a decode and an encode the browser does not let a page
interrupt part-way; a Stop would only ever take effect at the end. Closing the
tool or removing the photo is still read between every phase, and abandons the
copy.

**A failure is that photograph's alone (§32).** A photo this device cannot
decode is FAILED at analysis and says why, and every other photo stays exactly
as it was.

## 8. The copy, its name, its details, and where it can go

`API-Timestamped-YYYYMMDD-HHMMSS-NNN.jpg` — the burned moment and the queue
position, from the one writer the video uses. The details drawer shows both
fingerprints, both formats, the detected and selected times, the corner, the
verification, when it was made, and what the original carried (*"location
(GPS), camera … — none of it goes into the copy"*). **Save copy** uses the
browser's save dialog where it has one, the share sheet on an iPhone or iPad
(which resolves only when the operator completes it, so it may honestly be
called a save), and otherwise a download — which the page does not call saved
until the operator says the file arrived. **Save to Dropbox** is the unchanged
filing route above, original first. Remove, Clear completed and Clear queue let go of references
only, and ask first only when something would be lost — a copy never saved,
settings saved for a photo not yet made, or a change never saved.

## 9. Local, light, and measured

**Nothing is uploaded to make a copy.** Adding, checking, making, removing and
clearing make no request, beacon or download — counted in the page — and the
photo block's own source is inventoried: its only requests are filing to a case
and reading a case photo, both pressed by a person, and reading the case list
while one is being chosen.

**Light (§35):** each photograph is analysed once and in turn — its metadata
read, its fingerprint taken, and **one** decode that proves this device can make
the copy, gives its size and draws a 240px thumbnail, after which the pixels
are let go. The editor's preview (≤1280px, oriented as the copy will be, the
stamp where it will burn) is the only other full decode, and it is for the
selected photo only. Measured at 1, 10, 50 and 100 photos: never more than two
decodes at once, no entry holding decoded pixels, and the editor still working
on a photo in the middle of the queue.

## 10. Layout

The same two shapes as the video dashboard, at the same 1240px line: a desk
gets the table (with Size from 1440), the editor beside it and the processing
row; narrower gets cards, and the editor and the run each take the whole
screen, with Back returning to the list at the same scroll position. Measured at
1280, 1440 and 1920, and at 390 and 320: nothing scrolls sideways, every control
and corner choice is at least 44px, nothing a person must press is covered, the
selected row is obvious to the eye and carries `aria-current`.

## 11. Found on the way

- **The empty VIDEO dashboard shows *Select folder* twice** — `.vqd-b
  {display:inline-flex}` outranks `.vqd-hfold{display:none}` by source order.
  Fixed for the photo dashboard with one scoped rule; the video dashboard is left
  exactly as it shipped (§42) and the fix is offered as its own task.
- **Four instrument defects, none of them the product.** A finished check
  repaints up to 120ms later (`pqPaintSoon`), so a test reading the controls
  the moment the state said "done" read a stale row — the helpers wait for the
  paint now. The suite's own JPEG walker stopped four bytes early and reported
  every clean copy as having no end marker. A test that wrote saved times
  straight into the entries was read back by the render-time capture as an
  unsaved edit — the `fcSeed` lesson, answered with the product's own
  `skipCapture`. And the suite's default 1200px page is NARROW here (<1240), so
  after a run the list was behind the run screen: sections whose subject is not
  layout run on a desk.

## 12. Tests, mutations, and what is left for the device

**Twenty photo sections of `portal/test-portal.mjs`.** The seven that existed
were re-aimed at the queue rather than deleted — the stamp really in the
pixels, nothing guessed, the package rule, the served CSP, the operator's own
file decoded, picture first and case only to file, and the burned stamp's
geometry — and thirteen are new: the corner (pinned pixel for pixel against the
function Video V2 shipped); the clean derivative over metadata-rich JPEG, PNG
and WebP fixtures, audited by the suite's own JPEG walker and by exiftool; the
HEIC reader; orientation, all eight tags through two decoders plus the
stored-pixels negative; fail-closed (tests N and O, and a changed or re-read
original); each photo's own settings and the two bulk actions (E–H, and the
unsaved-change question); one at a time and Process next (I, J); removing and
clearing, and nothing leaving the device (K–M, §41); 1, 10, 50 and 100 photos
and the 500 ceiling (A–C, §36); drag and drop (D); the desk at 1280, 1440 and
1920; the phone at 390 and 320; and accessibility with Escape's layering. The
Home art-card walk and the direct-launch "way back" section were re-aimed too:
the photo card opens its queue, and the queue's own Close is measured.

**Twenty-eight mutations**, each in a git worktree (never the working tree),
each run against the sections that hold its property alone, each counted only
when an assertion **naming it** failed. Twenty-six were named on the first run:
the scrub bypassed or keeping APP1; the clean check ignored or blind to the
original's words; no manual turn, or a turn applied twice; a HEIC's tag
applied again; a changed original, an original reading back differently, and
an unconfirmable orientation each let through; a zone-less camera time treated
as READY; the zone applied without keeping the camera's moment, or without
asking; the unsaved-change question removed; one edit reaching every photo; a
held copy released without asking; runs chaining on by themselves; analyses in
parallel; decoded pixels kept on the entry; a request made while making; a
drop let through to the browser; the copy fingerprinted as the original; the
corner ignored; the selected row losing `aria-current`; no 500 ceiling; and
Clear completed never asking.

**The other two were the TEST'S fault, and both tests were strengthened rather
than the mutations retired:**

- **Process next taking a NEEDS REVIEW photo** passed, because the walk never
  put one between the photo just made and the next READY one — #4 sat after
  #1, which was ready, so *"skips #4"* was asserted over an order that could
  not have reached it. The walk now makes #3 on its own and requires the
  Process next on screen to NAME #5, and then to make it. Mutated, it fails
  both, by name (*"Process next: SEQ_04.jpg"*).
- **Escape closing the queue** crashed the section instead of failing it: the
  mutation worked, and the probe's next line read the closed queue. A crash is
  caught, not named (`CLAUDE.md`). The Escape walk now runs last and every step
  survives the queue having gone; mutated, it fails *"and never closes the
  queue"* by name.

**The trimmed run** of the twenty photo sections and the two re-aimed Home
sections: **584 passed**, beside the two "long case number" failures that a
trimmed run always carries (`CLAUDE.md`). **The final regression, each suite
alone and written to a file, was green on its first run:**

| suite | result |
| --- | --- |
| `portal/test-portal.mjs` | **4794 passed, 0 failed** (4486 at Video V2) |
| `case-portal/test-worker.mjs` | **4393 passed, 0 failed** — no Worker change |
| `.github/test-deploy.mjs` | **127 passed, 0 failed** |
| `portal/test-ceo-gate.mjs` | **43 PASS, 0 WARN, 0 FAIL** — the CEO Bot's recorded summary still agrees |

Unlike Video V2's first full run, nothing outside the photo sections failed:
the two sections that describe the photo door from elsewhere — the Home
art-card walk and the direct-launch way back — were found and re-aimed before
the targeted runs, by searching the suite for every assertion that names the
photo tool rather than only the sections named after it. `intake/` and
`visitor-alerts/` are untouched and were not re-run.

**Proven here:** everything above, in Chromium, on bytes built by the test
itself — the metadata-rich fixtures carry EXIF (GPS, make, model, serial, lens,
owner, software, dates and zones, maker note, text tags, a thumbnail), XMP
(people regions, history), IPTC, a comment and a trailer, as JPEG, PNG and WebP,
and are read by exiftool as well as by the suite's own walker. **Left for the
owner's device:** HEIC decoding (Chromium decodes none, so the HEIC reader is
proven on built bytes and the decode is Safari's); the iPhone Photo Library's
multiple selection and share-sheet save; real camera files with their own maker
data; and memory on a 48-megapixel photo.
