# Surveillance video timestamp / burn-in — owner brief (INTERNAL)

**Recorded on arrival, 2026-08-17, before any of it was built**, and queued
behind Active Surveillance Mobile PR 1 on the owner's own instruction. Nothing
here has been implemented. This file is the durable record so none of it is
reconstructed from memory later.

**The owner pre-authorised stopping after the audit.** See §12 — if real video
rendering needs infrastructure this project does not have, the instruction is to
report rather than invent, and explicitly **not** to introduce a paid external
video service or to fake the burn-in with CSS.

---

## The goal, in the owner's words

> When video evidence is uploaded, allow the authorized user to set or edit the
> video's starting date and time, then produce a finished timestamped video with
> the date/time visibly burned into the bottom-right corner.
>
> This is an evidence feature. **The original video must never be modified.**

And, on why it is a running clock rather than a label:

> The video could start at 5:14:32 PM, and the burned-in time should then advance
> 5:14:33, 5:14:34, 5:14:35… with the footage. That makes it much more useful for
> surveillance reporting than a static upload-time stamp.

> **The photograph's answer to this brief is `PHOTO-TIMESTAMP.md`** (2026-08-18).
> It reuses this file's rules verbatim — original never modified, separate
> derivative, distinguishable, burned into the pixels, zone from the date — and
> shares the burn itself (`vstDraw`) and the wording (`vstLabel`) rather than
> copying them. It diverges in exactly one place: a stamped photograph is
> **stored in the case**, because photographs go to Dropbox and the
> device-first rule below is about video bytes reaching Cloudflare.

## 1. Original + derivative model

Preserve the original uploaded video **exactly as received**. Never overwrite it,
recompress it in place, burn a timestamp into it, or alter its evidence metadata
merely to display a timestamp.

Create a **separate timestamped derivative**. The system must distinguish
**ORIGINAL EVIDENCE** from **TIMESTAMPED COPY**. Use the existing
evidence/storage architecture wherever possible; do not duplicate storage
systems unnecessarily.

## 2. Timestamp entry during video upload

A timestamp section on adding a video: **video start date · video start time ·
time zone**.

**Default time zone: Eastern Time — `America/New_York`**, correctly observing
EST/EDT **based on the selected date**. *Do not hard-code fixed EST year-round* —
the owner's reason: Virginia is on daylight saving part of the year, and a
hard-coded EST makes every summer timestamp an hour wrong.

Reliable file metadata may be used as a **suggested default**, but the operator
must be able to correct it before generating. Do not silently trust unreliable
metadata.

## 3. Edit timestamp

An obvious **Edit timestamp** action before final generation, allowing month,
day, year, hour, minute, second and AM/PM, showing the resolved Eastern zone:

```
08/17/2026
05:14:32 PM EDT
```

Editing this **does not change the original video file**.

## 4. Running video clock

The finished video must **not** carry a static label. The timestamp advances with
the video, from the selected start time, **according to the actual video
timeline** — not from the viewer's browser clock.

## 5. Visual burn-in

Bottom right. `08/17/2026 05:14:32 PM EDT`. Clearly readable, professional
surveillance appearance, white/light text with a subtle dark outline or shadow so
it survives light and dark footage, a modest safe margin, scaled to the video
resolution, readable on phone playback, and it must not move during playback.

**Encoded into the derivative itself**, so it survives download, sharing and case
packaging. **"A browser-only HTML overlay is NOT sufficient."**

## 6. Preview before generation

Original filename · selected start date/time · resolved EST/EDT · position
(bottom right), with **Edit timestamp · Generate timestamped video · Cancel**.
Generation is not complete until the derivative actually exists.

## 7. After generation

The evidence area distinguishes **ORIGINAL** from **TIMESTAMPED**, viewable
through the existing secure evidence viewer. *"Do not make the user guess which
file is the original."*

## 8. Audit / evidence integrity

Record enough to establish: original identity, derivative identity, selected
start timestamp, resolved zone, who generated it, when, and whether it was
regenerated with a corrected start time. **Reuse the existing audit/activity
architecture**; do not invent a parallel logging system. If hashing already
exists for evidence, preserve and use it.

## 9. Correction / regeneration

Edit timestamp → corrected date/time → regenerate. The original is never
modified. Do not silently overwrite history where the existing architecture
supports revision history. The currently active derivative must be obvious.

## 10. Mobile

Must work from Active Surveillance / field use. At 390px: fields easy to edit,
≥44px controls, no horizontal overflow, readable preview, an obvious Generate
button, no giant forms, one-handed date/time entry. Must not interfere with the
current Photo / Video / Activity / Note workflows.

## 11. Security / permissions

Existing admin/investigator evidence permissions are preserved. An investigator
may only timestamp video they are **already** authorised to access. **The
derivative inherits the original's case/evidence access boundary**, and evidence
access is not broadened merely because a derivative exists.

## 12. Implementation audit FIRST — and the authorised stop

Audit the current video upload flow, any share-link behaviour, evidence storage,
the R2/storage architecture, package generation, existing video metadata,
evidence audit logging, and **server/Worker processing capabilities**. Determine
the smallest safe architecture for genuinely rendering the timestamp into the
video.

> **DO NOT FAKE BURN-IN WITH CSS.**
>
> If true video transcoding requires infrastructure/dependencies that are not
> currently available or would materially change deployment cost/architecture:
> **STOP AFTER THE AUDIT** and report — what currently exists, the exact missing
> capability, the recommended rendering approach, expected storage/compute
> implications, and the smallest implementation path.
>
> **DO NOT silently introduce a paid external video-processing service.**

**The reader should expect this stop to be reached.** The portal's only compute
is a Cloudflare Worker — a short-lived, memory-capped JavaScript isolate with no
ffmpeg and no filesystem. Transcoding a surveillance video is not something it
can do, and the free-tier failsafe this project is built around (see the storage
cap in `CLAUDE.md`) means a second full-size copy of every video also has a real
storage cost that the owner must agree to. Both belong in the audit report, not
in an implementation.

## 13. Testing the owner asked for

Original unchanged · entered timestamp persists · manual correction works ·
`America/New_York` resolves EST/EDT correctly by date · the stamp begins at the
chosen second · it advances with playback · the derivative visibly carries it
bottom-right · the downloaded derivative retains it independently of the portal ·
the original remains separately accessible · unauthorised users can reach
neither · regeneration does not corrupt the original · desktop and 390px mobile ·
no horizontal overflow · ≥44px controls.

## Where this meets the package work

The owner's note, for whenever packages are next touched:

> When you later build a case package, I would make the timestamped derivative
> the normal client-facing/video-delivery version while retaining the untouched
> original as evidence.

That is a change to what a package ships, and it is **not** authorised as part of
this feature — record it against the package rules when the time comes.

---

# ARCHITECTURE AUDIT — 2026-08-17, no code written

Carried out against master `182f9b8`. **The authorised stop in §12 is reached:**
true burn-in cannot be done by this project's current compute, and every path
that can do it needs an owner decision. Nothing was built, enabled or signed up
for.

## 1. What the current architecture can already do

More than half of the feature, and none of it is the hard half:

| Piece | Status today |
| --- | --- |
| Video ingestion | `POST …/evidence` accepts any `content_type`; `video/*` is already recognised and counted (`worker.js:5038`, `:6468`) |
| Evidence storage | R2 bucket `case-evidence`, private, one object per row, `r2_key` on `case_evidence` |
| Access control | one authenticated route serves the bytes; investigators are scoped to their own cases; the viewer shipped in #156 keeps it in-app |
| Audit trail | `activity_log`, `case_evidence.uploaded_by/uploaded_at`, classification, and the never-erase rule already exist |
| Storage failsafe | 9 GB hard cap, 75 MB per file, 50k uploads/month, meter computed from `SUM(size_bytes)` |
| An original + derivative MODEL | **fits the existing schema** — a derivative is another `case_evidence` row with its own `r2_key`, plus a column or side table linking it to its original |

So the *data* design needs no new storage system, and §1's "use existing
evidence/storage architecture" is satisfiable. Timestamp entry, the edit screen,
the preview, the EST/EDT resolution and the audit records are all ordinary work
this project can do today.

## 2. The exact blocker

**Rendering pixels into a video file. Nothing in this project can do it.**

- **The only compute is a Cloudflare Worker.** A V8 isolate: no filesystem, no
  native binaries, no ffmpeg, ~128 MB memory, and on the **free plan 10 ms CPU
  per request** (30 s on paid). Transcoding even a one-minute clip is orders of
  magnitude beyond that.
- **`ffmpeg.wasm` is not a way round it.** ~30 MB of WASM, wants
  `SharedArrayBuffer` and threads, and needs seconds-to-minutes of CPU and
  hundreds of MB of memory. It does not fit a Worker on any plan.
- **The upload path already sits near a limit**: `addEvidence` does
  `await file.arrayBuffer()` (`worker.js:4600`), so a 75 MB upload is 75 MB
  resident in a 128 MB isolate. There is no headroom to also hold a decoded
  frame buffer.
- **No video service is connected.** `wrangler.toml` binds exactly two things —
  D1 and R2. No Stream, Images, Containers, Queues or Browser Rendering.

## 3. Best recommended architecture — browser-side render, on the desktop

**Render the derivative in the browser with WebCodecs, on a desktop/laptop, and
upload it as a new evidence object.**

Decode the original with `VideoDecoder`, draw each frame to a canvas, draw the
timestamp for that frame's own presentation time, re-encode with `VideoEncoder`,
mux, and `POST` the result as a derivative. **This is genuine burn-in** — pixels
in an encoded file that survive download and packaging — and it is not the CSS
overlay §5 forbids.

Why it is the recommendation:

- **no new infrastructure, no new service, no credential, no cost** — the thing
  the owner's brief is most concerned about
- the original is never touched: it is read, and a *second* object is written
- it reuses the existing upload route, permissions and audit trail exactly
- the running clock is computed from **frame presentation time**, which is what
  §4 asks for ("according to the actual video timeline", not the browser clock)
- `America/New_York` resolves correctly with `Intl.DateTimeFormat` and
  `timeZoneName: 'short'`, which yields EST or EDT **from the date itself** —
  no table to maintain and no hard-coded offset

Its honest costs, which the owner should weigh:

- **desktop only in practice.** WebCodecs exists on iOS 17+, but re-encoding a
  long clip on a phone is slow, hot and battery-hungry, and an interrupted
  encode wastes the trip. §10 asks the *entry* to work in the field; the
  recommendation is that the field **records the start time** and the office
  **generates** the derivative.
- it is a **re-encode**, so the derivative is generationally lossy. That is
  acceptable precisely because it is a viewing/delivery copy and the untouched
  original remains the evidence.
- the 75 MB per-file cap applies to the derivative too.

## 4. Second best — a self-hosted ffmpeg step the office runs

A small local service (or a scripted step) on a machine the firm already owns,
running real `ffmpeg` with a `drawtext` filter, pulling the original through the
existing authenticated route and posting the derivative back.

Better output than a browser re-encode and no per-clip browser cost — but it
adds a machine that has to be running, reachable and maintained, and it is the
first piece of this system that would not be serverless. Recommended only if
browser rendering proves inadequate in practice.

## 5. Storage and compute implications

- **Every timestamped video roughly doubles that video's storage.** Against a
  9 GB cap that is the single most consequential fact here. A one-line policy
  decision is needed: do derivatives count toward the cap (they must — the meter
  is `SUM(size_bytes)` over all live rows), and is an original ever retired once
  a derivative exists? **It must not be**, per §1, so the answer is that video
  capacity is effectively halved.
- Regeneration (§9) adds a third object unless the superseded derivative is
  deleted. Recommend: keep one *active* derivative, soft-delete the superseded
  one the way evidence deletion already works, so history survives and the meter
  does not grow without bound.
- Compute: zero server cost under the recommendation — the work happens on the
  operator's machine.

## 6. Is a new Cloudflare service appropriate?

**Not without owner approval, and probably not at all.**

- **Cloudflare Stream** is the obvious candidate and is **paid** (storage per
  minute plus delivery per minute). It is also a *delivery* product: it
  transcodes and streams, but it does not burn a running timestamp into frames,
  so it would not actually deliver this feature.
- **Containers / a container-based job** could run ffmpeg properly, but it is a
  paid product and a materially different deployment model.
- **Browser Rendering** is for headless Chrome, not video encoding.

None is connected today, and §12 forbids introducing a paid video service
silently. **No action taken.**

## 7. Is local/server processing practical?

Yes, technically — see §4 — and the firm already has a Windows desktop. It is
practical for a small volume and impractical as a silent dependency: it must be
running when someone presses Generate. It is the fallback, not the first choice.

## 8. What owner setup or credentials would be required

**For the recommendation: none.** No account, no key, no binding, no spend. That
is why it is the recommendation.

What is needed is **decisions**, not credentials:

1. Accept that the derivative is a **re-encode** and that the untouched original
   remains the evidence of record.
2. Accept that **video storage is effectively halved** against the 9 GB cap, or
   raise the cap deliberately.
3. Confirm the split: **field records the start time, office generates the
   derivative.**
4. Confirm that a superseded derivative is soft-deleted on regeneration.

Only if the answer to (1) is "no — the delivery copy must not be re-encoded"
does this become an infrastructure question, and then §4 or a paid service is
the conversation.

## 9. How this ties into "Save to my Dropbox"

Cleanly, and the ordering matters: **the derivative is what gets exported, and
the export is never the source of truth.**

The existing evidence route stays the only reader of R2. A Dropbox export
enumerates a case's *deliverable* material — which, once this exists, means the
**timestamped derivative** for any video that has one, and the original only for
video that does not. Dropbox receives a copy; it never becomes the store, is
never read back as evidence, and its absence or failure changes nothing about
the case. The same rule the package work already follows: the portal is the
operational record.

The owner's related note — that the derivative should become the client-facing
delivery video in case packages, with the original retained as evidence — is a
change to what a package ships and is **not authorised by this brief**. It
belongs with the package rules when that work is next opened.

## Recommendation in one line

**Build everything except the render** — timestamp entry, edit, preview, the
original/derivative model, the audit records and the EST/EDT resolution are all
ordinary work with no blocker — **and decide the four questions in §8 before the
render is written.** Nothing here should be started until the owner has answered
them.

---

# WHAT WAS ACTUALLY BUILT — 2026-08-17, after the owner's decision

**The owner answered §8 with an architecture the audit had not proposed: VIDEO
IS DEVICE-FIRST.** No new video byte becomes Cloudflare storage. The original
stays on the device that shot it, the timestamped copy is rendered in that
device's own browser and saved back to it, and the portal keeps the **record**
and no video at all.

That supersedes §1's "derivative is another `case_evidence` row" and §7's
"the evidence area distinguishes ORIGINAL from TIMESTAMPED" — with no stored
derivative there is nothing to distinguish, and the storage cost the audit
flagged in §8 disappears entirely rather than being weighed.

**The legacy rule the owner attached to it:** *do not delete, migrate, move or
modify existing videos already stored in R2 during this PR.* Nothing did.

## The capability proof, run before any feature code

| Capability | Result |
| --- | --- |
| `VideoEncoder` / `VideoDecoder` (WebCodecs) | **absent** — §3's primary recommendation could not be used or proven |
| `MediaRecorder` `video/webm;codecs=vp9` | supported |
| `MediaRecorder` `video/mp4` | **reports supported while `avc1.42E01E` reports NOT** |
| decode → canvas → burn → encode → re-decode | full round trip succeeded |
| burned marker present in the re-decoded output | **yes**; a control pixel elsewhere was clean |

**The proof corrected this document's own audit.** §3 recommended WebCodecs and
it is not there. Canvas + `MediaRecorder` does the whole round trip, with no
dependency, no service, no credential and no cost — and the mp4 line is a trap
worth remembering: recording to a container the platform "supports" without the
codec produces a file nothing can play. `vstMime()` never offers it.

## The brief, item by item

| § | Asked for | Built |
| --- | --- | --- |
| 1 | Original never modified; separate derivative | The original is a `File` opened read-only and never written; the copy is a new Blob on the device |
| 2 | Start date · time · zone, default `America/New_York`, EST/EDT by date | `vstToUtc`/`vstLabel` via `Intl`, resolved from the instant |
| 3 | An obvious Edit timestamp before generating | Its own step, reachable from the preview and from the finished screen |
| 4 | A running clock on the video's timeline | The label is the chosen start plus the frame's presentation time |
| 5 | Bottom right, readable, outlined, scaled, does not move | `vstDraw` — 5% of height, monospace so the seconds do not shift, dark stroke plus shadow under white |
| 6 | Preview before generation | Original, resolved instant, position, fingerprint, with Edit / Generate / Cancel |
| 7 | Tell ORIGINAL from TIMESTAMPED | **Superseded by device-first.** Nothing stored to confuse; legacy rows are badged *stored earlier* |
| 8 | Enough audit to establish identity, zone, who, when, regeneration | `video_stamp`, append-only, `superseded_at` on correction |
| 9 | Correct and regenerate without losing history | A new row; the earlier one stamped, never edited |
| 10 | Works at 390px, ≥44px, no overflow | Asserted by measurement, not by looking |
| 11 | Existing evidence permissions preserved | Every route goes through `caseFor`; the case picker offers only the caller's own cases |
| 12 | Audit first, stop rather than invent | The stop was reached, the owner decided, and the proof ran before the feature |
| 13 | The listed tests | Written; the burn-in one decodes the output and reads its pixels |

## What is deliberately NOT here

- **Audio.** `HTMLMediaElement.captureStream` is not dependable across the
  browsers this must run on, and half-working audio on an evidence file is worse
  than none. The original keeps its audio, untouched, on the device.
- **Dropbox.** §9 above is still a plan and nothing was started.
- **A change to what a package ships.** Still not authorised, and now moot in its
  original form: there is no stored derivative for a package to prefer.
- **Any decision about legacy stored video.** Recorded in `NEXT.md` as an open
  question. Do not sweep it as a side effect of anything.

---

# MOV / HEVC AUDIT — 2026-08-18, from the owner's live test

**The failing case, in the owner's words:** `IMG_0440.mov` read its filename and
recording start time (`05/03/2025 11:27:58 AM EDT`), then reported *"This browser
could not read that video file"* — while the large **Generate timestamped video**
button stayed active underneath the error.

## 1. Why it fails

**A real decode failure of the bitstream. Not the container label.**

The first hypothesis was that `.mov` is refused by MIME type: a `.mov` File
carries `video/quicktime`, the object URL inherits it, and Chrome does not
register that type in `canPlayType` (measured: `video/quicktime` returns the
empty string, meaning "cannot play", while `video/webm; codecs=vp9` returns
"probably").

**That hypothesis is wrong, and it was measured rather than argued.** The same
decodable bytes were relabelled and loaded through the real code path:

| Blob type on identical bytes | Loads? |
| --- | --- |
| `video/webm` | yes |
| `video/quicktime` | **yes** |
| `application/octet-stream` | **yes** |
| no type at all | **yes** |

The browser sniffs the content and ignores the declared type for a blob URL. So
**re-wrapping the container would fix nothing**, and the refusal is the decoder
genuinely being unable to decode what is inside.

## 2. The likely codec — named from the file, never guessed

An iPhone writes `.mov` in one of two camera settings: **High Efficiency →
HEVC/H.265**, **Most Compatible → H.264/AVC**. Chrome decodes H.264 essentially
everywhere; its HEVC support exists only where the OS and hardware provide it and
is commonly absent. **HEVC is therefore the strong hypothesis for this file — and
the code no longer relies on a hypothesis.**

`vstBoxCodec()` reads the codec out of the file's own boxes with no decoder:
walk the top-level box list (`[4-byte size][4-char type]`), find `moov`, and read
the sample-entry four-character code in `stsd` — `avc1`/`avc3` = H.264,
`hvc1`/`hev1` = HEVC, plus VP9, AV1, MPEG-4 Part 2, MJPEG and ProRes.

**iPhone QuickTime writes `mdat` first and `moov` LAST**, so a head-only scan
finds nothing; this walks to the end. Measured on a 5 MB fixture with that exact
layout: **182 bytes read, 0.003% of the file**, and it named `hvc1` correctly.
When the boxes cannot be read it returns **null** and the screen says the codec
could not be determined, rather than naming one.

## 3. What the browser renderer supports today

Unchanged and still working: anything the browser can decode goes in, and
**VP9/WebM** comes out. On the tested platform `video/mp4` reports supported
while its only real codec `avc1` reports **not**, so mp4 output is refused by
construction.

## 4. The UI fault, fixed

Both halves of the owner's report are addressed, and the check now runs when the
file is **chosen** rather than when Generate is pressed:

- **A file that cannot be decoded shows a compatibility stop where the action
  was.** No prominent Generate button under a fatal error.
- **While the check is still running the button is present but disabled**, so it
  does not appear and vanish.
- **Edit timestamp and Cancel stay in every state** — a timestamp is still worth
  correcting for a file that will be generated elsewhere.
- The wording names the codec only when it was actually read.
- `vstGenerate` refuses on its own as well; the page is not the only guard.

## 5. Browser-side FFmpeg / WASM — measured, and the answer is NO for real files

Measured in the browser this project tests with:

| Measurement | Value |
| --- | --- |
| `crossOriginIsolated` | **false** |
| `SharedArrayBuffer` | **absent** |
| Largest single `WebAssembly.Memory` | ~4,065 MB (32-bit wasm ceiling) |
| Largest single `ArrayBuffer` | **1,024 MB — 2,048 MB throws `RangeError`** |
| `hardwareConcurrency` | 4 |
| `@ffmpeg/core` unpacked | **64.7 MB** (`core-mt`: 65.7 MB) |

Five things follow, and each is independently disqualifying for
surveillance-size video:

1. **No `SharedArrayBuffer` means no multithreaded build.** `core-mt` needs it,
   and it needs COOP/COEP cross-origin isolation, which `/portal/*` does not set.
   Only the single-threaded core is usable, and it is several times slower.
2. **It cannot be served from Cloudflare Pages.** Pages caps a single file at
   25 MiB; the core is **64.7 MB**. It would have to come from a third-party CDN
   — a dependency the owner's own rules push against — or be split, which the
   loader does not support.
3. **ffmpeg.wasm's world is one 32-bit memory.** Input, output and working
   buffers share it. `WORKERFS` can map the input `File` without copying it, but
   the **output still lands in memory**, so a long clip's H.264 output alone can
   exceed what is available.
4. **`file.arrayBuffer()` fails above 1 GB on this platform** — measured. Any
   path that materialises a surveillance file as one buffer is already broken.
5. **It cannot stream or chunk a transcode.** Splitting at keyframes and
   concatenating is a real technique, but it is a project, not a fallback, and it
   multiplies the memory problem by the number of concurrent segments.

**So: no. Browser-side FFmpeg/WASM does not solve MOV/HEVC for real surveillance
video, and it would be dishonest to ship it as though it did.** It would work for
small clips and fail on exactly the files that matter.

## 6. Memory, CPU and time

Single-threaded WASM H.264 encode runs roughly **0.2×–1× realtime** on 4 cores
for 1080p — a 10-minute clip is 10–50 minutes with the tab open, on one core,
with no ability to use the machine's hardware encoder. The current canvas +
`MediaRecorder` path is **1× realtime and hardware-accelerated**, so it is
strictly faster as well as smaller.

## 7. Can the output be MP4 / H.264?

Not from the current path — `avc1` reports unsupported for recording. From
ffmpeg.wasm it could be, but `libx264` is **GPL**, which would put the whole page
under a licence the owner has not chosen, and H.264 carries patent licensing that
is not settled by "it runs in a browser". **This needs an owner decision before
anyone writes code, not after.**

## 8. iPhone and mobile

An iPhone shoots the problem format and is the worst place to transcode it: no
`SharedArrayBuffer` in Safari without isolation, a hard per-tab memory ceiling
that kills the tab rather than throwing, and thermal throttling on a long encode.
**Mobile should stay timestamp-entry plus generation for formats the phone can
already decode**, and say plainly why anything else must be finished on a laptop.
Safari **can** decode HEVC natively, so an iPhone may well render its own footage
successfully where Chrome cannot — the compatibility check reports what the
browser in front of the user can actually do, which is the honest answer.

## 9. Would a local desktop helper be more reliable?

**Yes, decisively — and it is the only option that handles real files.** A native
`ffmpeg` on the owner's own machine has no 32-bit memory ceiling, streams input
and output to disk, uses hardware encoders, and handles HEVC and any other codec.
The costs are equally real: something must be installed and kept up to date, it
is a second place where evidence is handled, and it is outside everything this
project currently deploys.

## 10. Recommendation

**Ship the compatibility fix — already coded and tested — and stop there.**

The tool is now honest: it names the codec when it can read it, refuses clearly
when it cannot, and never offers an action it cannot perform. For H.264 `.mov`
and everything else the browser decodes, it works today.

For HEVC specifically, in order of preference:

1. **Ask the owner to change the iPhone camera setting** to *Settings → Camera →
   Formats → Most Compatible*. Zero engineering, zero dependency, zero cost, and
   it makes every future clip H.264 — which the existing renderer already
   handles. **This is the recommendation.**
2. **Try the clip in Safari**, which decodes HEVC natively where Chrome does not.
   The tool already works there if the browser can decode the file.
3. **A local desktop helper**, if 1 and 2 are not acceptable — but that is a new
   piece of software and its own decision.
4. **Browser-side FFmpeg/WASM — do not.** Measured above; it fails on the files
   this exists for.

**No large dependency was installed and none is proposed.** Nothing in the
storage architecture changed: video is still device-first, no bytes reach R2 or
D1, photos and legacy video are untouched.

---

# iOS VIDEO COMPATIBILITY AUDIT — 2026-08-18

**Owner requirement:** iPhone and iPad video are **primary input**, not an edge
case, and the previous unit's advice — change the camera to *Most Compatible*,
or use a laptop running Chrome or Edge — is **rejected**. Existing Apple footage
must have a usable workflow.

## The honesty constraint, stated first

**iOS Safari cannot be run in this container.** The browser here is headless
Chromium built without proprietary codecs. Every previous claim about "a laptop
running Chrome or Edge" was made without measurement and proved wrong in the
owner's own test. So this audit separates three things by name:

- **MEASURED HERE** — run in this container, reproducible.
- **PUBLISHED** — from vendor and standards sources, cited, not measured here.
- **UNKNOWN UNTIL THE DEVICE ANSWERS** — which is why the tool now carries a
  device read-out that the owner's own iPhone fills in.

## What was MEASURED here

| Fact | Result |
| --- | --- |
| A blob's MIME label decides nothing | Identical decodable bytes load as `video/quicktime`, `video/mp4`, `application/octet-stream` or with no type at all — the browser sniffs content |
| The codec can be read without decoding | `stsd` sample entry, walking to the END for QuickTime's `moov`-last layout — **182 bytes read of a 5 MB fixture** |
| `SharedArrayBuffer` / `crossOriginIsolated` | absent / false |
| Largest single `ArrayBuffer` | **1,024 MB; 2,048 MB throws `RangeError`** |
| `@ffmpeg/core` unpacked | **64.7 MB** vs Cloudflare Pages' 25 MiB per-file cap |

## What is PUBLISHED, and what it implies

The renderer has **two halves that fail independently**, and iOS is precisely
the platform where one works and the other does not:

| Capability | iOS Safari (published) | Consequence |
| --- | --- | --- |
| **HEVC/H.265 decode** | native, hardware, standard since 2017 | iOS can very likely **read** `IMG_0440.mov` when Chrome on Windows cannot |
| `canvas.captureStream()` | **reported unimplemented / unreliable on WebKit iOS**; the captured track "does not appear to contain valid information", with intermittent `onstop`/`ondataavailable` failures | **the current encode path is the part that breaks on iOS** |
| `MediaRecorder` | present since iOS 14.3; **`video/mp4;codecs=avc1`** — and WebM/VP8/VP9 from iOS 18.4 | iOS can produce a **broadly playable H.264 MP4**, which this project's desktop path cannot |
| `MediaRecorder.isTypeSupported` | **has historically returned true where `start()` then fails on iOS** | a capability string is not evidence; only an actual render is |
| **WebCodecs** `VideoDecoder`/`VideoEncoder` | **present from Safari 16.4** (video-only subset), hardware-backed; full support from Safari 26 | an encode route that **does not need `captureStream` at all** |
| `navigator.share({files})` | the system share sheet — Photos, Files | the correct iOS save path, and it resolves only after the user completes it |
| `showSaveFilePicker` | absent | the desktop "honest save" path does not exist on iOS |

**Chrome and Edge on iPhone and iPad are Safari underneath.** "Try another
browser" is not advice on iOS, and the tool no longer offers it.

## Why `IMG_0440.mov` failed, precisely

A **real bitstream decode failure on the machine that opened it** — not the
container, not the extension, not the MIME label. The likely codec is HEVC
(iPhone *High Efficiency*), and the tool now reads that from the file's own
boxes rather than inferring it. The original was never modified, which is correct.

## The route that would make iOS first-class — WebCodecs, not FFmpeg

demux (`mp4box.js`) → `VideoDecoder` (hvc1, hardware) → canvas draw + burn →
`VideoEncoder` (avc1, hardware) → MP4 muxer → share sheet.

It is **materially better than ffmpeg.wasm on every axis that disqualified
ffmpeg.wasm**, and that is the re-evaluation the owner asked for:

| | ffmpeg.wasm | WebCodecs route |
| --- | --- | --- |
| Download size | **64.7 MB** — exceeds the Pages 25 MiB file cap | ~230 KB of pure JS (demuxer + muxer) |
| Threads | needs `SharedArrayBuffer`, absent | not needed |
| Memory | whole input **and output** in one 32-bit heap | **a few frames at a time — genuinely streaming** |
| Speed | software, ~0.2–1× realtime on 4 cores | **hardware, typically faster than realtime** |
| HEVC | software decode | **hardware decode on iOS** |
| H.264 out | `libx264`, **GPL** + patent questions | the platform's own encoder |
| Licensing | GPL contamination of the page | none |

**It also fixes the desktop.** The current path cannot emit H.264 (`avc1`
reports unsupported for recording here), so it writes WebM. A WebCodecs encoder
would produce the MP4/H.264 the owner asked for wherever the platform provides
the encoder.

**Two new dependencies would be required** — an MP4 demuxer and an MP4 muxer,
both small, pure JavaScript, permissively licensed. **Nothing was installed and
this is where the audit stops for approval.**

## Large surveillance video

- **ffmpeg.wasm: unsafe.** `file.arrayBuffer()` already throws above 1 GB here,
  and its model needs input and output resident simultaneously.
- **WebCodecs: safe by construction** — one frame in, one chunk out. The binding
  constraint becomes where the OUTPUT is written, which on desktop is
  `showSaveFilePicker` + a `FileSystemWritableFileStream` (streams to disk, no
  ceiling) and on iOS is a Blob in memory until shared.
- **The current path is already ~1× realtime**, because the clip is played
  through once. That is the floor for any approach; a 40-minute clip is a
  40-minute render with the screen awake, which is a real operational limit on a
  phone regardless of codec.
- **Mobile thermal and memory risk is real** on long clips. Even with a working
  iOS encode path, a long surveillance file is better finished on a desktop.

## Recommendation

1. **Ship the small safe fixes already made** (below) — the tool is now honest on
   every device and recommends no browser it has not proven.
2. **Have the owner run the device read-out on the iPhone or iPad that shot
   `IMG_0440.mov`, with that file selected.** It reports decode, canvas capture,
   MediaRecorder MP4/WebM, WebCodecs, share, and an **actual end-to-end render
   attempt** — because on iOS the capability strings have historically lied.
   That single screen fills every row of the iOS matrix with measurement instead
   of inference, and it decides between Outcome A and Outcome B.
3. **Then approve or decline the WebCodecs route**, which is the only path that
   makes iOS HEVC first-class without a large dependency. It needs two small
   pure-JS libraries and is a real piece of work, so it is a decision, not a fix.
4. **A local Windows helper is not needed if the WebCodecs route is approved** —
   and it is the fallback if it is declined.

## The small safe fixes made in this unit

- **Every browser recommendation removed.** The screen states what happened and
  that the original is unchanged, and names no browser it has not proven.
- **Container and codec reported as separate named lines**, with the container
  described as a label and the codec read from the file or reported as
  undetermined — never invented.
- **Compatibility distinguishes "cannot decode" from "can play but cannot write
  the copy here"** — the second is the iOS case, and calling it "unsupported
  video" would have been wrong.
- **iOS is detected and named**, so the screen does not suggest another browser
  on a platform where every browser is Safari.
- **The share sheet is the save path where it exists**, which is how a file
  reaches Photos or Files on iOS — and it resolves only after the operator
  completes it, so it may honestly be treated as saved.
- **A device read-out**, including a real end-to-end render attempt.

---

# THE iOS DEVICE ANSWERED — 2026-08-18, and it named the bug

**Owner ran the read-out on the real iPhone/iPad with `IMG_0440.mov`:**

| Row | Device answer |
| --- | --- |
| Container | MOV / QuickTime |
| **Media-element decode of the file** | **NO** |
| Canvas capture | **YES** |
| MediaRecorder | YES |
| MediaRecorder reports MP4 / AVC | **YES** |
| MediaRecorder reports WebM / VP9 | YES |
| WebCodecs decode API present | YES |
| WebCodecs encode API present | YES |
| Share to device | YES |
| Save-file picker | NO |
| **End-to-end** | **FAILED — wrote a file the device could not read back** |

## Why the end-to-end test failed — found, and fixed

**`vstMime()` returned WebM because WebM was first in its list.** iOS records
WebM and does not play it, so the test wrote a file and then could not open it.
The device was telling the truth on every row; the code asked the wrong question.

Two things changed, and the second is the durable one:

1. **MP4/H.264 is now first in the preference order** — the format the owner
   asked the derivative to be, and the one an iPhone plays.
2. **`isTypeSupported` no longer decides anything.** `vstProveMime()` writes a
   four-frame clip in each candidate and **reads it back on this same device**;
   the first that survives wins, and one that cannot be read back is never
   chosen whatever it claims. `vstGenerate` awaits it before recording.

This project has now been bitten by `isTypeSupported` in **both** directions —
a desktop reporting `video/mp4` while `avc1` reports unsupported, and an iPhone
recording a WebM it cannot open. A capability string is not evidence. Measured
after the change: on this container `video/mp4` **does** round-trip, so even the
earlier "never mp4" conclusion was wrong — which is exactly why the round trip,
not the string, is the rule.

## Canvas capture works on iOS after all

The published sources said `canvas.captureStream()` was unimplemented on WebKit
iOS. **The owner's device says YES.** That is a material correction to the
previous audit, and it means the **existing renderer may work unchanged on iOS**
for any file the device can decode — no WebCodecs needed for those.

## What is still blocked, and it is one thing

**`Media-element decode of IMG_0440.mov: NO`.** The iPhone would not decode its
own footage through a `<video>` element. So for this file the existing path
cannot start, and WebCodecs is the only route.

**"WebCodecs decode: YES" proves only that the API exists.** The owner said so
explicitly and they are right. So the read-out now parses the file properly —
`tkhd` / `mdhd` / `stsd`, the `avcC`/`hvcC` configuration record, dimensions,
timescale, duration, audio track and codec, and the **rotation matrix** iOS uses
instead of turning pixels — builds the real WebCodecs codec string from the
configuration bytes, and asks **`VideoDecoder.isConfigSupported()` about THAT
configuration**. It also asks `VideoEncoder` for H.264.

That is the measurement that decides the pipeline, and it can only be taken on
the device.

## Two deployment constraints found before installing anything

Both are specific to this project and both need an owner decision, because they
touch things this repo treats as load-bearing:

1. **`/portal/*` sets `script-src 'unsafe-inline'` with no `'self'`** — so **no
   external script file can load on the portal at all.** A demuxer and muxer
   would have to be **inlined into `portal/index.html`** (already 570 KB), or
   the CSP would have to gain `'self'` — which `verify.sh` and `harden-check.yml`
   police.
2. **`default-src 'none'` with no `worker-src` blocks Web Workers**, so a
   WebCodecs transcode could not be moved off the main thread without a second
   CSP change.

## The dependency audit, as requested — nothing installed

| Package | Version | Licence | Unpacked | Role |
| --- | --- | --- | --- | --- |
| `mp4box` | 2.4.1 | **BSD-3-Clause** | 2.26 MB | demux MOV/MP4, the standard WebCodecs front end |
| `mp4-muxer` | 5.2.2 | **MIT** | 156 KB | write a standards-compliant MP4 from encoded chunks, AVC + AAC passthrough |

Both are pure JavaScript, no WASM, no server, no upload, licences compatible.
Together they are a fraction of `@ffmpeg/core`'s 64.7 MB and sit far under the
Pages 25 MiB per-file cap — **but see the CSP constraints above**, which decide
*how* they would ship rather than *whether* they can.

## Recommended order from here

1. **Re-run the read-out on the iPhone with `IMG_0440.mov`.** It now reports the
   owner's §11 matrix, including whether the decoder accepts the file's actual
   configuration and which output format the device proved it can read back.
2. **If `WebCodecs decode` says it accepts the configuration** — build the
   pipeline, with the CSP decision made first.
3. **If it declines** — that is the STOP the owner asked for, and no muxer would
   have helped.

---

# THE PIPELINE, BUILT — 2026-08-18

**The owner's device passed the decision gate on the real file:**

| | |
| --- | --- |
| Container | MOV / QuickTime |
| Video | **H.264 / AVC, `avc1.640028`, 1920x1080, ~48.12 s** |
| Audio | AAC / mp4a, mono, 44100 Hz |
| Media-element decode | **NO** |
| **WebCodecs decode** | **YES — accepts this file's actual configuration** |
| **WebCodecs H.264 encode** | **YES** |
| Share to device | YES |

So the route is confirmed, and it is **H.264, not HEVC** — which makes the
encode a same-codec re-encode rather than a format conversion.

## What was built

```
local file -> demux (this repo) -> VideoDecoder -> frame
           -> canvas draw + burn -> VideoEncoder (H.264)
           -> MP4 mux (vendored) -> Blob -> share / save
```

**No MediaRecorder on this path.** MediaRecorder is what wrote a file the iPhone
could not read back; it remains only for the legacy formats it has been proven
on, and `vstProveMime` still governs those.

## The dependency decision — one library, not two

The owner approved `mp4box` (2.26 MB) **and** `mp4-muxer` (156 KB). **Only the
muxer was taken**, and the reasoning is worth keeping:

- **The demuxer is written in this repo** (`vstSampleTable`, `vstEsdsAsc`). It is
  pure byte arithmetic over `stts` / `ctts` / `stsz` / `stsc` / `stco` / `co64` /
  `stss`, which means **it is testable in this container** against fixtures built
  to the shapes an iPhone writes — `moov` last, chunked samples, run-length
  tables, keyframes at intervals, composition offsets. Two hundred lines against
  2.26 MB.
- **The muxer is vendored**, because writing a standards-compliant MP4 is the one
  thing that **must** be right — the hard gate is the iPhone playing the file it
  made — and it **cannot be tested here**, since this container has no WebCodecs.
  A purpose-built, audited library is the low-risk choice for exactly that.

`portal/vendor/mp4-muxer.js` — **MIT**, 69 KB, no runtime dependencies, and
audited before committing: **no `fetch`, `XMLHttpRequest`, `WebAssembly`, `eval`
or `importScripts`**. There is a test asserting all of that, so an update cannot
quietly introduce any of it.

**It is `.js`, not `.mjs`, deliberately.** Every test suite in this repo is
`.mjs` and the deploy guard's rule is that no `.mjs` is ever published. That
invariant is worth more than the extension, and `import()` does not care.

## The CSP change — one directive, and why

`/portal/*` gained **`script-src 'self'`** and nothing else. It is needed for
exactly one same-origin module import. No third-party origin, no CDN.

**`worker-src` was NOT added.** The pipeline runs on the main thread, so nothing
needs a worker yet — and the owner's instruction was the minimum change the
implementation actually uses. If a worker is added later for UI smoothness, that
is its own decision and its own directive.

`media-src 'self' blob:` was added alongside, because the finished derivative is
previewed from a blob URL before it is saved.

## Audio: STRIPPED BY DESIGN

**Owner requirement change, mid-build:** the timestamped copy is **picture only**
— no audio track — and AAC passthrough is not a requirement for this milestone.
The AAC passthrough that had been written was removed rather than left dormant:
dead code that once muxed audio is exactly the thing someone re-enables by
accident later.

This is a deliberate omission, not a limitation, and the distinction is enforced
where this project always enforces it — in what the screen says:

- The muxer is **never given an audio track**, so the output has none. Asserted
  against the pipeline's own source, not a comment.
- **Nothing claims audio was preserved.** The finished screen says *"Not included
  — the copy is picture only"* and names the original's own audio as *"still on
  your original, untouched"*.
- The read-out reports **Audio in original** and **Audio in the copy** as two
  separate rows, so the two facts cannot be confused.
- The original's audio is still **parsed** (`esds` → AudioSpecificConfig), because
  reporting what the source contains is useful. It is reported and not muxed.

## Memory, on the real 84.7 MB baseline

**One sample at a time.** The demuxer produces a list of `{offset, size, dts,
cts, sync}` and never reads media bytes; the pipeline then pulls each sample with
`file.slice`. Frames are `close()`d the instant they are drawn, and the decode
queue is held under 24 so the whole film is never queued at once. The file is
never resident, and there is a test that a 6 MB fixture parses from under a tenth
of itself.

Nothing is written to R2, D1, `localStorage`, `sessionStorage` or IndexedDB —
already asserted structurally — and the output is one Blob the operator saves or
shares.

## Orientation

`tkhd`'s matrix is read and handed to the muxer as `rotation`, so the copy
carries the same orientation metadata the original did. **No pixels are turned,
stretched or cropped** to achieve it, which is what keeps the aspect ratio and
framing identical.

## What is NOT proven, and cannot be from here

**This container has no WebCodecs**, so the pipeline has never been executed —
only its demuxer, its refusals and its wiring are tested here. **iOS LIVE
VERIFIED remains OPEN** until the owner's device selects `IMG_0440.mov`,
generates, and plays the result back.


---

# THE STAMP IS ANCHORED TO THE RECORDING — 2026-08-18

**Owner, before push:** the burned timestamp must anchor to the source's actual
capture date and time when the metadata is there, and must **never** start from
the moment the investigator processes the file.

**It did not, and that was a real defect.** The default came from
`file.lastModified` — when the file was *written*, which on a Photos export is
long after the shot — and it fell back to **`Date.now()`**, the processing time
itself. Both look plausible on screen, which is what made it dangerous.

## What it reads now, in priority order

| Source | Carries a zone? | Trusted |
| --- | --- | --- |
| `moov/meta` keys+ilst **`com.apple.quicktime.creationdate`** | **yes, its own UTC offset** | **yes** |
| `moov/udta/©day` (or `©dat`) | usually | yes |
| `mvhd` `creation_time` (1904 epoch) | **no** — Apple has written local time here | **no** — read, but the operator is asked to check |
| the file's modified date | n/a | **no** — labelled *not* the recording |
| nothing | | the form asks; nothing is invented |

Whatever is found is an **instant**, and `vstLabel` renders it in
`America/New_York`, so EST or EDT comes from the date itself. The
`com.apple.quicktime.creationdate` fixture resolves to exactly the owner's own
example: **`05/03/2025 11:27:58 AM EDT`**.

`Date.now()` is gone from the opener entirely. A file with no date at all now
gets an empty form that asks, which is honest — the processing time is the one
value guaranteed to be wrong.

**The form says which source it used**, in four distinct wordings, because a
stamp taken from a modified date must not read like one taken from the capture
metadata. The device read-out carries **Recorded at** and **Stamp anchored to**
for the same reason.

**An operator's correction always outranks the file** — the metadata is applied
only while the fields are still untouched.

## Two parser bugs this found, both caught before the suite ran

- **The box-type check admitted only printable ASCII**, so QuickTime's
  ©-prefixed metadata atoms — `©day`, exactly where an Apple device writes the
  capture date — were discarded as if the box were corrupt. 0xA9 is allowed now.
- **`ilst` children are indexed by a BINARY number**, not a four-character code,
  so `vstBox` refused them, correctly, as not being types. They are walked
  directly instead.

Both were found by a thirty-second targeted probe rather than a twelve-minute
suite run, which is the reason to keep that probe habit.


---

# THE GATE ASKED THE WRONG QUESTION — 2026-08-18

**Owner:** *"WebCodecs pipeline says YES but old media-element compatibility gate
still blocks generation."*

Exactly right, and it was **one condition**. The screen gated on `readable` —
whether a `<video>` element could decode the file — and that check predates the
pipeline entirely. On the owner's iPhone the media element says **NO** and
WebCodecs says **YES**, so **the one device the pipeline was built for was the
one it refused.**

## There are two independent routes, and either is sufficient

| Route | How |
| --- | --- |
| **pipeline** | demux → `VideoDecoder` → burn → `VideoEncoder` → MP4 mux |
| **legacy** | `<video>` → canvas → `MediaRecorder` |

`vstPath()` is the single place that decides, and it returns
`pipeline` / `legacy` / `checking` / `none`. Three consumers now share it — the
Generate button, `vstGenerate` itself, and the Compatibility line — so the screen
and the generator cannot disagree about whether a file can be processed, which is
how the two got out of step in the first place.

**An outstanding answer is not a refusal.** `checking` disables the action rather
than removing it; only `none` blocks.

## The old warning is kept, as information

It is true and worth saying — it just may not decide anything. When the media
element fails but a route exists, the screen says:

> This device's ordinary media player could not open this file, but its video
> codec can — the copy is made by decoding and re-encoding it here, so
> generation is unaffected.

And when nothing can take the file, the refusal names **which route failed**:
no WebCodecs at all, or a decoder that declined this file's configuration. The
owner has to know which one to chase.

The read-out gained **Route for this file**, so the answer is visible rather
than inferred from the button.

## A non-video file is refused where it is chosen

Owner, 2026-08-18: on a desktop the picker's `video/*` filter can be switched to
**All Files**, and the wizard would then carry a spreadsheet all the way to a
decode failure that reads like a codec problem. It now says **"Video files
only"** the moment the file is chosen — before an object URL is made, so there
is nothing to revoke and nothing to unwind.

**The restraint is the design, and it is the same measurement this file already
records.** Identical decodable `.mov` bytes arrive as `video/quicktime`, as
`application/octet-stream`, or **with no type at all**. A rule that refused an
empty or octet-stream type would reject the exact iPhone file the whole feature
exists for.

So `vstNotVideo` refuses only what it can positively identify as something else:

| The file | What happens |
| --- | --- |
| type is `video/*` | allowed — it says it is video |
| extension is a known video one | allowed — it is named as one |
| no type, or `application/octet-stream` | allowed — this is the iPhone case, and the **decode probe** is the real arbiter |
| type says image, audio, text or document | **refused**, "Video files only" |

The picker still asks for `video/*` first. The refusal is the backstop for a
filter being switched, not a replacement for asking — there is a test for both.

## MTS / M2TS — a transport stream is demuxed, never played (2026-08-24)

Owner: *"Add local MTS/M2TS support to Video Timestamp. Do not rely on browser
playback to decide compatibility. Decode/process locally, burn the timestamp,
output MP4, keep original untouched, and never upload the source."*

A camcorder's `.MTS`/`.M2TS` is MPEG-TS — a fixed grid of 188-byte packets
(192 with the 4-byte AVCHD arrival stamp ahead of each), no boxes, no sample
tables. `vstParse` could not read it, so the tool refused every camcorder file
with a codec sentence that named no codec. The format was absent, not broken.

### The design, in the shape this file already uses

- **The container is decided by the bytes.** `vstTsSniff` reads 64 KB and
  scores each candidate stride (188/192/204/208) by how many packets land on
  the 0x47 grid; a single sync byte proves nothing and the extension is never
  consulted. An ISO file cannot false-positive (measured: the box fixtures and
  a random-bytes file both sniff null), and an AVCHD file named `.mp4` still
  parses as a transport stream — asserted.
- **`vstTsParse` answers the same questions `vstParse` does**, from the
  stream's own structures: PAT → PMT → stream types (video AND audio named,
  MPEG-2/HEVC/VC-1 included, so a refusal can say what the file actually is);
  the H.264 **SPS** for width, height, profile/level (the `avc1.PPCCLL` codec
  string) and interlacing — with `frame_cropping` applied, because 1080-line
  AVCHD codes 1088 and crops 8, and a parser that skips the crop stretches
  every frame; PES **PTS/DTS** at 90 kHz for timing. The frame interval comes
  from **DTS spacing, not PTS** — with B-frames the presentation stamps arrive
  reordered and a PTS-based rate lands at half or double. Duration is first
  PTS to last PTS, the last read from a tail window on the packet grid; a
  33-bit stamp is unwrapped across the 26.5-hour rollover.
- **No `<video>` element is consulted, structurally.** No browser this portal
  runs in plays MPEG-TS, so the media probe would refuse every camcorder file
  on the planet after a 20-second timeout. For a TS, `vstOpen` never starts
  the probe's verdict path, `vstPath` does not read `readable` at all, and the
  legacy MediaRecorder route does not exist. The suite pins the owner's rule
  directly: `readable: true` opens nothing for a TS, `readable: false` blocks
  nothing, and a declined decoder blocks even a "playable" stream.
- **Annex B is why no `description` is invented.** WebCodecs reads a
  length-prefixed stream when a codec description is supplied and a start-code
  stream when it is not. A transport stream carries SPS/PPS in-band ahead of
  each keyframe, so the decoder is configured with the codec string alone —
  nothing synthesises an `avcC`, which is one fewer record to get wrong.
  Asserted: the decoder receives `avc1.42001E` (the fixture's own profile
  bytes) and no `description` key.
- **`vstTranscodeTs` is the same pipeline with a different feed.** Same
  muxer, same `vstDraw`/`vstLabel` burn, same MP4-no-audio output, same
  refusal sentences. Frames stream out of the packet grid in ~1.2 MB
  packet-aligned slices (`file.slice`, one access unit held back so its
  duration is the measured distance to the next); decode starts at the first
  IDR because a stream cut mid-GOP smears; the burned label is the operator's
  start plus the frame's own PTS offset, never this machine's clock. Nothing
  is uploaded, nothing touches R2/D1/browser storage, and the original is
  opened read-only — the tests count fetches/XHR/beacons during a full parse
  and demux and assert zero.

### What the demux refuses, by name

- A stream whose video is **not H.264** — named ("This is a MPEG-2 video
  transport stream. Only H.264 / AVC is processed here."), because only
  H.264's parameter sets are read.
- A stream that **packs more than one picture into a PES** under one PTS —
  no honest per-frame stamp exists. The **exception is measured, not
  assumed**: an interlaced frame is two field pictures under one PTS and one
  moment, so a field PAIR in a stream whose SPS says interlaced is normal;
  three pictures, or two in a progressive stream, still refuse.
- A stream whose SPS cannot be read — no dimensions, no configuration, said
  in those words.

### The last packet of an AVCHD file is shorter than the stride

Found by the fixture suite before it shipped: a 192-byte stream is
[4-byte stamp][188-byte packet] repeated, so the final packet ends at the file
end with no trailing pad — and chunking the read to whole strides silently
dropped the last frame of every clip (29 of 30 came out, and the duration was
short one frame). The scan now feeds a tail that still holds a whole packet.

### What is proven here, and what is not

The fixtures are written by an **independent muxer in the test file** —
spec-first bit packing (Exp-Golomb SPS writer, RBSP escaper, PES/PSI/packet
writers) that shares no code with the page's reader, so a mirrored
misunderstanding cannot pass itself. Proven in this container, in real
Chromium: layout sniffing (both strides, ISO negative), SPS arithmetic
(1920×1080 progressive, 1440×1080 interlaced cropped from 1088, 1280×720),
codec strings, fps from DTS, duration, byte-exact AU extraction across packet
boundaries, 33-bit PTS exactness and rollover, keyframe flags, every refusal,
the no-network guarantee, and the decoder boundary (right codec string, no
description, demux genuinely reaches `configure`).

**The owner's first real .MTS found the next defect downstream (2026-08-24),
and it was mine, not the parser's:** the demux, PMT and SPS all read the file
("M2TS/AVCHD, H.264/AVC" on the read-out), the decoder was configured — and the
screen then said *"flush called after codec closed."* A WebCodecs codec that
errors CLOSES ITSELF, and both transcode paths called `flush()`
unconditionally, so the flush's own `InvalidStateError` replaced the one
sentence that explained anything. Reproduced against the real API in this
container (junk VP8 keyframe → error callback → `state: "closed"` → flush
throws), fixed as `vstCodecDrain` — flush only a codec still `configured`,
never let the drain outrank the first recorded error, close defensively — plus
first-error-wins on both callbacks and guarded `decode()` calls, because
decode() can ALSO throw synchronously (measured: `DataError: A key frame is
required after configure() or flush()`). The harness ran the fixed and the
pre-fix code against the same real AVCHD fixture and stub codecs: old code
reports the flush noise, fixed code reports the codec's own error with
"your original is unchanged". What the codec's real error on the owner's
device IS remains unknown until the retest — this fix makes it say so.

**A measurement corrected the same day:** the "this container has no
WebCodecs" claim from the first probe was an artifact of the probe's own
context — `VideoDecoder` is `[SecureContext]` and the probe page was not one,
while `VideoFrame` (not SecureContext) stayed visible, which is exactly the
split the probe recorded. The suite's pages run on `127.0.0.1`, a secure
context, and the first full run proved WebCodecs PRESENT there. The suite now
RECORDS presence instead of asserting absence, and the path assertions are
written as invariances that hold either way. **The burn on the owner's real
`.MTS`, on their hardware, remains the owner's device check** — the screen
says **Ready — decoded and re-encoded on this device** when that device's
decoder accepts the stream, and names what failed when it does not.

One capability note recorded for that check: WebCodecs Annex-B H.264 decode
is standard in Chromium-family browsers; Safari has historically wanted
length-prefixed + description. If the owner's iPhone declines the Annex-B
configuration, the recorded fallback design is to convert AU payloads to
length-prefixed form and synthesise the `avcC` from the in-band SPS/PPS —
both already in hand from the demux — as a follow-up keyed to a real device
answer, not built speculatively against a guess.

---

# MID-DECODE FAILURE — 2026-09-27, the owner's 00029.MTS

Owner, live: `00029.MTS` — M2TS / AVCHD, H.264 / AVC. The tool opened it,
read its metadata, took its start time (09/26/2026 06:11:02 AM EDT) and its
fingerprint, recognised the container, began the decode — and stopped with
*"The device's video codec stopped part-way: Decoding error. Nothing was
saved and your original is unchanged."* The screen then still offered
**Generate timestamped copy**, under a Compatibility line reading *"Ready —
decoded and re-encoded on this device"*.

## 1. The pipeline, traced — no guessing

```
file picker (File object, read-only)
  -> vstParse -> vstTsSniff (0x47 grid, 64 KB) -> vstTsParse
       head scan (48 MB cap): PAT -> PMT -> H.264 SPS; DTS spacing -> fps
       tail scan (8 MB): last PTS -> duration
  -> vstDecoderAccepts: VideoDecoder.isConfigSupported({codec, codedWidth, codedHeight})
  -> Generate -> vstTranscode -> vstTranscodeTs
       vstTsScan: ~1.2 MB packet-aligned file.slice reads -> vstTsReader
         (PES reassembly per access unit) -> vstTsAu
       -> WebCodecs VideoDecoder, Annex B, NO description, NO hardwareAcceleration
          key (the browser's default choice: on most computers the GPU decoder)
       -> output VideoFrame -> canvas drawImage -> vstDraw(vstLabel(...)) burn
       -> WebCodecs VideoEncoder (H.264, avc) -> vendored mp4-muxer
          (ArrayBufferTarget, fastStart in-memory)
       -> Blob -> object URL -> Save / Share -> portal record (metadata only)
```

What decodes: **WebCodecs `VideoDecoder`** — nothing else. No `<video>`
element (not consulted for a TS), no MediaSource, no WASM, no server. The
demux is this repository's own MPEG-TS/M2TS reader.

Where it failed: the decoder's error callback, during `decode()`. The words
*"Decoding error."* are the codec's own — Chromium's generic text for a
decode failure — with our prefix and suffix around them (the old wording
printed *"Decoding error.. Nothing was saved"*, a doubled full stop, now
gone). There was **exactly one decoder**, so the run ended; the catch put the
screen back on `preview` with Generate still drawn, so a second press re-ran
the identical configuration against the identical file.

## 2. The failure shape, reproduced on master before anything changed

A scratch harness ran master's page code against an AVCHD-shaped fixture
(192-byte packets, 1440x1080 interlaced field pairs, AC-3 audio, 90 frames)
with a stub decoder that fails after 40 units:

| Codec behaviour | master did |
| --- | --- |
| close + error callback in one task (Chromium's order) | the owner's exact screen: the sentence, **Generate still offered**, Compatibility **"Ready — decoded and re-encoded on this device"**; no output kept |
| codec seen closed a moment BEFORE its callback ran | **a 15-frame copy of a 90-frame clip, offered as "Timestamped copy is ready"** |

The second row is the finding that matters most: master treated a closed
decoder as the end of the stream and checked nothing about the copy, so
"the encoder ended without throwing" was all it took to offer a partial
file as evidence.

## 3. Why the device decoder stopped — what is known and what is not

Not determinable from here: this container's Chromium has no H.264 decoder
or encoder at all (measured again 2026-09-27: `isConfigSupported` false for
every `avc1` profile, hardware or software), and the owner's device was not
available. **The strongest candidate is interlacing**: 1080i, coded as field
pictures, is the default recording mode of most AVCHD camcorders, and it is
a known limit of hardware H.264 decoders that a software decoder handles.
That is a hypothesis, labelled as one. The new failure screen makes the next
report decisive either way: it says how many frames the device decoder
returned before it stopped, and where in the clip — "before it produced a
single frame" is a format the decoder refuses; "after 4,812 frames (about
2:40 into the clip)" is something at that point.

## 4. What was built — two local decoders, and a copy proven whole or not made

**The fallback is the browser's own software decoder**, through the same API:
`VideoDecoder` configured with `hardwareAcceleration: "prefer-software"`.
Local, no download, no new dependency, no CSP change. The primary pass is
configured exactly as before (no `hardwareAcceleration` key — asserted), so a
device where it worked behaves identically. When the primary fails:

- its incomplete output is discarded (codecs closed, muxer dropped);
- the software decoder decodes the stream again **from the first keyframe**,
  from the same `File` — the operator does not re-select anything;
- the screen says so while it happens.

**A copy is offered only when it is PROVEN whole** (`vstTsAttempt`'s ledger):
every frame the stream holds (counted from the slice headers — two fields are
one frame, whether they travel in one PES or two) came back from the decoder
exactly once and no stray frame appeared; every decoded frame was stamped,
encoded and muxed; the stream was read to its end; the source's own clock span
matches the head/tail measurement; the copy covers the span from the first
keyframe to the end; and the finished MP4, **read back with this page's own
parser**, has that many frames, that picture size and that running time.

**Damage is found as the file is read, and stops the read.** The demuxer now
keeps a ledger on the picture's own stream: a broken packet grid, a packet the
writer flagged (`transport_error_indicator`), a continuity-counter gap (a lost
packet), a PES shorter than it declared, a PES header that never completed, a
reserved adaptation-field value, a scrambled picture stream, a file that ends
part-way through a packet, and a NAL whose `forbidden_zero_bit` is set. The
standard's permitted duplicate packet is recognised and its payload is not
appended twice (before, it was — corrupting that frame). Damage is a FILE /
STREAM ERROR and **no second decoder is run for it**: a software decoder
conceals damage rather than refusing it, and a concealed hole in evidence is
worse than no copy.

**When no decoder finishes, the file is read through once more for damage
alone** (no decoding, same bounded slices), so the verdict can say which it is:

| Found | Verdict |
| --- | --- |
| damage anywhere in the file | FILE / STREAM ERROR, with the kind and where |
| packets clean; device decoder failed; no software decoder here | DEVICE DECODER COMPATIBILITY ERROR |
| packets clean; both refused the very first frame | DEVICE DECODER COMPATIBILITY ERROR (probable) |
| packets clean; both stopped at the same moment part-way | FILE / STREAM ERROR (probable) |
| packets clean; they stopped at different moments | CAUSE NOT DETERMINED |

Encoder, memory and read failures are their own classes and never trigger a
decoder retry.

## 5. The screen

States, in the owner's order: **Ready** ("will be decoded and re-encoded" —
never the past tense before anything ran) -> **Processing** -> **Primary
decoder failed — trying compatibility mode** -> **Checking the copy is
complete** -> **Complete**, or **Could not completely decode**. The finished
screen names the decoder used, what was checked ("All 1,800 frames decoded,
stamped and re-encoded; the finished MP4 reads back with 1,800 frames,
60.06 s"), the original's fingerprint as the original's, and — when the
software decoder was used — the owner's sentence: *"Compatibility mode was used
for this AVCHD/MTS file. Processing remained on this device."*

The failure headline is the owner's sentence verbatim: *"Video could not be
completely decoded. No timestamped copy was created and your original is
unchanged."* — then one line per decoder (what it did, how far it got), then
the verdict.

**No loop.** After a failure there is no Generate button, and `vstGenerate`
refuses a direct call. The one exception is an original that stopped being
READABLE (a card pulled mid-run): that offers *Choose the video again*, which is
a different run. A file this tab's primary decoder failed on goes straight to
compatibility mode the next time — a corrected time on a finished copy, or the
same file chosen again — and the ready screen says so before anything runs
(`VST_PRIMARY_FAILED`, in memory only; `vstLaneFor` is the one writer of which
decoder a run starts with).

**Stop stops the work.** Before, Stop closed the screen and the decode ran on
to the end of the file behind it. Every loop now reads the run between frames,
closes the codecs and keeps nothing — on the MOV path too.

## 6. FFmpeg / WASM — evaluated again, with today's numbers

| | measured 2026-09-27 |
| --- | --- |
| `@ffmpeg/core` 0.12.10 `ffmpeg-core.wasm` | **32,232,419 bytes (30.7 MiB)** — over Cloudflare Pages' 25 MiB per-file cap |
| libav.js prebuilt variants | **none decodes H.264** — its `h264-aac` variant is source-only and uses OpenH264, which does not decode interlaced (field) pictures |
| portal CSP | `script-src 'self'` — WebAssembly compilation needs `'wasm-unsafe-eval'` added on the origin that holds case data |
| threads | no `SharedArrayBuffer` (no COOP/COEP) — single-threaded software H.264, slower than real time on a phone |

So the software decoder built into the browser — reached through the same
WebCodecs API — is the local software decoder that fits without shipping one.
A vendored WASM decoder (a custom FFmpeg build with only the H.264 decoder and
the frame API, a few MB) is the remaining option for a browser that has no
software H.264 decoder of its own; it needs the CSP relaxation and a new
dependency, which are **the owner's decision**, and it was not built.

## 7. What is proven here, and what is not

Proven in this container, in real Chromium, with stub codecs and everything
else real (canvas, burn, `VideoFrame`, `EncodedVideoChunk`, the vendored
muxer, the read-back): the fallback, the ledger, every damage kind, the
permitted duplicate, the verdict table, the screen states, the no-loop rules,
Stop, and zero network during all of it. **Not proven here:** that a given
device's browser offers the software decoder, and that it decodes the owner's
real `00029.MTS`. Both are the owner's device check. Whether a device has it is
now stated on the ready screen ("Compatibility mode: available if this device's
decoder fails" / "not available in this browser") and in *What can this device
do?* before anything runs.

**Unchanged on purpose:** the original is fingerprinted when chosen (up to
128 MB, as before) and Generate now waits for that fingerprint; the copy stays
picture only (owner, 2026-08-18), so there is no audio track whose alignment
could drift, and the screen says the original's audio is still on the
original — which it now actually shows, since the pipeline never passed the
source's audio name to that row before; frames before a stream's first
keyframe (a later part of a split recording) cannot be decoded by any decoder
and are **reported** on the finished screen, never dropped silently; the MOV /
MP4 path keeps its single decoder, and gains the completeness count, the
read-back and a Stop that stops.

# V2 — CLEAN DERIVATIVES + A MULTI-VIDEO QUEUE — 2026-09-28

Owner brief (40 items): every newly generated timestamped video must be a
**clean derivative** — original untouched, stamp burned in, all source-carried
metadata stripped, only what playback needs left — and **many videos** must go
through one queue: selected together, each with its own start, generated one
at a time, never processed without the operator pressing for it. Local only,
throughout. Nothing in the MTS/AVCHD fail-closed protections (2026-09-27) was
loosened; every one of those sections still runs and passes.

## 1. The copy starts clean — the architecture the brief preferred was already this one

The copy is a NEW container of NEW encoded frames: every frame is decoded,
drawn, stamped and encoded afresh, and the vendored muxer (mp4-muxer 5.2.2) has
no metadata API at all. So the original's boxes, its SEI, its GPS, its camera
model and its name have **no path** into the copy. The audit of what the muxer
writes on its own found exactly three things that are not playback:

| Field | Written by | What it was | Now |
| --- | --- | --- | --- |
| `mvhd`/`tkhd`/`mdhd` creation + modification time | mp4-muxer | the moment of PROCESSING | zero — the standard's "not set"; the brief calls processing time audit information |
| `hdlr` name | mp4-muxer | `"mp4-muxer-hdlr"` — the library signing its work | empty |
| sample-entry compressor name | mp4-muxer | already 32 zero bytes | verified empty |

and one thing a DEVICE encoder may add: SEI user data (type 5, where x264 and
others write their name and settings; type 4, registered user data) and the
"unspecified" NAL types 24–31. Those are stripped from every encoded chunk
before the muxer sees it (`vstCleanChunk` → `vstStripUserData`, which rebuilds
an SEI NAL keeping its other messages and re-applies emulation prevention).

The processing-time fields are zeroed **in place** after the muxer finishes
(`vstScrubMp4`) rather than by editing the vendored library: same length, so
no box and no frame moves, and a future update of the muxer keeps working —
or, if it ever started writing something new, fails the check below loudly.

## 2. Proven clean — `vstCleanCheck`, independent of the steps that made it clean

Run on the bytes that will be saved, before a Blob exists:

- **structure** — exactly `ftyp, moov, mdat`; one video track; every box on a
  strict allow-list (`mvhd, trak, tkhd, mdia, mdhd, hdlr, minf, vmhd, dinf,
  dref, url, stbl, stsd, stts, stss, stsc, stsz, stco|co64, ctts, avc1, avcC,
  colr`); anything else — `udta`, `meta`, `uuid`, `XMP_`, `tref`/chapters, an
  edit list, a second track, free space — fails, named;
- **fields** — every creation/modification time zero, the handler named
  nothing and typed `vide`, the compressor named nothing, the language `und`,
  the data reference self-contained, the file-type brands only generic ones;
- **frames** (H.264) — every sample walked NAL by NAL: only slice, SEI,
  parameter-set, delimiter and filler units; no SEI carrying user data; a unit
  that cannot be read fails;
- **the source** — every piece of text read out of the ORIGINAL's metadata
  (`vstIsoMeta`: QuickTime text atoms, Apple `mdta` keys, iTunes item lists,
  3GPP atoms) and the original's file name and stem, searched for in every
  byte of the copy that is not compressed picture or a table of numbers.

A failure is a **`clean` fault**: no copy, no object URL, no Generate under it,
the check's own words on the screen, and it is never retried on the other
decoder (the pictures were whole; the file around them was not).

### What the copy carries, exactly, and why

`ftyp` (isom / avc1 / mp41), one video track's timescales, durations and
dimensions, the display matrix (rotation — playback information: the copy is
upright wherever the original was), language `und`, handler type `vide`, a
self-contained data reference, the sample tables, the new encoder's SPS/PPS
(`avcC`) and its colour parameters (`colr`) when it reports them, and the
pictures. Nothing else. The new file's filesystem date is whenever the
operator saves it; nothing tries to fake it.

### What the original may carry, and the copy never does

`vstIsoMeta` inventories the source by category — **recording date and time;
location (GPS); camera make and model; device and software details; title,
author, comments and other text tags; chapters; cover art or attachments; XMP;
manufacturer-specific data; timecode, text or timed-metadata tracks** — and a
transport stream's **camcorder MDPM record** (AVCHD writes date, time and
camera settings as SEI user data in the picture stream) and any other user
data there. The finished screen and the receipt name what was found; none of
it is in the copy.

## 3. Two fingerprints, never one field

- **Original** — as before: Web Crypto, when the file is chosen, up to
  `VST_HASH_MAX` (128 MB), recorded as absent above that. Unchanged, per the
  brief ("according to the current workflow").
- **Copy** — `vstSha256`, FIPS 180-4 in JavaScript, over the finished buffer
  **in place**. Web Crypto takes a private copy of its input, and a phone
  holding the writer's buffer plus a second copy of a long clip closes the tab.
  ~90 MB/s in this container; held to Web Crypto at every block and 4 MB slice
  boundary and on NIST's `abc`; a stopped run returns no fingerprint rather
  than a partial one. The Dropbox upload still computes its own digest of what
  it uploads, as before.

## 4. The canvas recorder is retired

It played the clip in real time and let `MediaRecorder` catch what it could:
a frame dropped under load leaves no trace, and its container is the browser's
(Chrome names itself in it). It could prove a copy neither whole nor clean,
and V2 offers no copy that is not both. Every file the owner records — iPhone
MOV/MP4 and camcorder MTS — takes the WebCodecs pipeline, so the loss is a
browser with no WebCodecs, or a container the pipeline cannot list frame by
frame (WebM, MKV, AVI); those are refused at the door, in words, instead of
being copied without proof.

## 5. The queue

| Rule | How |
| --- | --- |
| Many at once | **Add videos** opens the device picker with `multiple`; files can be dropped on the dashboard (§6); a desktop with a folder picker also gets **Select folder** (never drawn on touch / iOS). Batches are sorted by name, numbers as numbers (camera order); Move up/down change it |
| Each video is its own | an entry is the same object the single tool always used; `VQ.sel` is the one in the editor, `VST` the one whose details are open. Editing video 2 writes video 2 |
| One heavy thing at a time | analysis (structure, decoder questions, one thumbnail frame, fingerprint) is sequential and pauses during a run; Generate waits for the analysis in flight |
| One finished copy in memory | starting another lets go of a saved copy; an unsaved one only after **Save it first / Let it go** |
| Light entries | a checked MOV/MP4 lets its frame table go and keeps the count (`vstSlim`; measured in V8 at ~85 bytes a frame — 1.4 MB for ten minutes at 30 fps, 18 MB for an hour at 60, per entry). Generate reads the table again from the same file and refuses one that no longer reads with the frames that were checked. A transport stream never held a table in the queue |
| READY means a start you can stand behind | capture metadata, or a time the operator saved. Modified-date and zone-less creation times are **NEEDS REVIEW** |
| Nothing runs unpressed | Generate per row (▶ on a desk, ⋮ and the editor everywhere); **Process next** after a copy, naming the next READY video; nothing processes the rest on its own |
| Stop | ends the run where it stands; the entry reads STOPPED and can be generated again; the queue stays |
| Remove / Clear | take entries out of the list only; asked first only when an unsaved copy or saved start times would be lost |
| Session only | the queue holds references to the chosen files for as long as the page is open; nothing about it is stored |
| Receipt | per video: original name, size and fingerprint; the start found and where; the start burned in; processing time; decoder; the copy's name, size and fingerprint; metadata-clean PASS and what the original carried; the result. A text file the operator saves; never in any video |

Statuses: ANALYZING, READY, NEEDS REVIEW, PROCESSING, TRYING COMPATIBILITY
MODE, VERIFYING, COMPLETE, FAILED, STOPPED — one writer (`vqStatus`), derived
each time a row is drawn.

**No timezone selector exists in this tool** (the start is always resolved in
America/New_York, EST or EDT from the date), so there is no "apply timezone
to all"; the brief made it conditional on one existing.

**A queue repaints while somebody is using it.** Each video finishes its check
on its own schedule; `paintVStamp` keeps the list's and the editor's scroll
positions, an open ⋮ menu, the focused field and its caret, the control that
had the keyboard, a playing preview, and a half-typed correction (as the
entry's draft — only Save writes the entry). Found by a screenshot that would
not stay scrolled.

**The case record** is the existing `video_stamp` row (no schema change): the
original's name, size and fingerprint, the start, the zone and the copy's
clean name. The Worker now supersedes an earlier record only for the SAME
original — the same name and no disagreement on size or fingerprint — because
a camcorder numbers from 00000 again after its card is formatted, and a queue
of two days' cards is two different `00029.MTS`.

## 6. The dashboard — the approved mockup, built (second brief, 2026-09-28)

"THIS IS NOT JUST A VISUAL MOCKUP. Build the complete working product behind
it." The queue of §5 is now one screen, and every control on it is wired to
the same queue logic — nothing on the dashboard is a picture of a feature.

### One screen, two shapes

| Region | Desk (≥ 1240px) | Phone and tablet |
| --- | --- | --- |
| Header | title, the owner's lede, the four promises in one bordered strip, Close | title, Close and **+ Add videos**; the promises as a 2×2 grid while the queue is empty, and under the queue once it is not |
| Way in | drop zone (the button itself), Supported formats, Select folder | the same, until videos are listed; then the header's Add videos |
| Queue | a table: # · thumbnail · filename · size (≥ 1440) · format · detected start · edit time · status · actions | a card per video: number, thumbnail, name, size · format, start, status, **Edit** and **⋮** |
| Editor | the right-hand column, sticky, always showing the selected video | the whole screen, with **Back to queue** |
| Processing | a row under the queue: the run, and Next in queue | the whole screen while a run is shown: progress, steps, **Stop**, then **Save copy / View / Process next / Back to queue** |
| Details | a drawer at the side, the dashboard dimmed behind it | the whole screen |

**1240, not 1180.** Below 1240 the table's columns cannot sit beside the
editor without the page scrolling sideways, so an iPad in landscape gets the
cards — the layout built for touch. The controls are the same elements with
the same acts at every width; what a width does not show is `display:none`,
never a second copy.

**The processing row stays in view only on a tall desk** (≥ 1000px high). At
1280×800 a sticky row covered the whole queue — measured in the first
screenshot, before any test was written. On a shorter desk it sits under the
queue and starting a run brings it into view (`scrollIntoView`, `nearest`).

### Adding

- **The door opens the dashboard**, not the picker: the queue is where videos
  are dropped, so it has to be on screen before any are chosen. It opens
  empty, reading nothing.
- **The drop zone is a `<button>`** — a click, a tap, Enter and a drop all
  arrive at the same door. Dragging is never the only way in.
- **Drag and drop** targets the whole dashboard while it is open, shows
  *Release to add videos*, and is ADDING: the same `vqAdd`, the same checks
  and messages, and nothing starts. A dropped **folder** is walked from its
  entries by name (depth 6, 500 files at most), and only files that look like
  video join — an AVCHD card's index and clip-info files are named as left
  out. A drop onto an open video's details adds nothing, and no drop ever
  falls through to the browser (which would navigate away to the file).

### A thumbnail is one frame

During analysis, after the decoder has said yes: the first keyframe — one
sample of an MP4/MOV, one access unit from the first 8 MB of a transport
stream — is read by `file.slice`, decoded by one decoder made for it and
closed at once, drawn 160px wide (turned upright by the file's own rotation)
and kept as a small JPEG in this tab only. It is decoration: a file it cannot
draw keeps a placeholder, and nothing else about the entry changes. Asserted
over twenty videos: one decoder per video at most, each fed one chunk, only
one alive at a time, no encoder.

### The editor

- **Detected source time and the time being set are two things**, shown
  apart: the first is read-only with where it came from; the second is the
  form, and **Burned into the copy** repeats it as the burn will say it.
- **Date and time are typed as parts** (MM / DD / YYYY, hh : mm : ss AM/PM),
  not native pickers: the iPhone's time picker has no seconds, and a
  surveillance start needs them.
- **The zone is shown, not chosen**: EDT (UTC−4) or EST (UTC−5), resolved
  from the date being set. The tool has no zone selector (§5).
- **Typing never repaints** (`vqTimeLive`): the burned-in line, the preview's
  stamp, EST/EDT and whether Generate can be pressed update in place.
- **Leaving an unsaved change asks** — Previous, Next, another row, or Back on
  a phone: *Save and continue*, *Discard changes*, or *Stay here*. Nothing is
  kept or dropped silently. Previous and Next step through every video.
- **The preview is the selected video's, played on this device**: a local
  object URL of the original, `preload="metadata"`, muted. Only one exists.
  The element is MOVED into each repaint inside the same task, so a repaint
  does not pause it (the HTML spec only pauses a media element that is still
  out of the document once the task has finished). A transport stream is
  never handed to the player; it shows its first frame and says why. A file
  this device will not play in the page says that this does not affect making
  the copy — a preview is not a verdict.

### The processing panel

The owner's steps — *Reading source file, Applying timestamp overlay,
Encoding video, Trying compatibility mode, Finalizing file, Verifying clean
metadata, Creating output file* — each ticked only when the pipeline has
actually reached the next one (`v.seen`, the stages the run really emitted).
Decode, stamp and encode happen together, a frame at a time, so those rows
advance together and carry the real frame percentage; after the frame loop
the bar stands at 99% until the copy is proven. The compatibility row appears
only when this run needed it, and a damage-read row only when no decoder
finished. **Stop** is on the panel; on a desk it is also reachable from the
row's **View**.

### Palette

`--vqd-*` in `:root`: near-black navy, restrained gold, cream serif headings,
blue-grey borders. Each ink measured on its own ground — cream 14.3:1 and ink
14.5 on the panel, muted 8.1, gold 8.2, dark ink on the gold button 7.1 and
more, every status ink 8.2–10.5 on its own tint. A status is always a WORD;
the colour only repeats it.

### Keyboard and screen readers

Every action is a `<button>` (the drop zone included). A row is selected by
its **Edit**; a region that opens takes focus on its heading, never on a text
field, so no screen opens the on-screen keyboard by being arrived at; what is
behind a phone's full-screen region, a confirmation or a drawer is `inert`.
**Escape** steps back one layer — a ⋮ menu, a question, the drawer, a phone's
editor — and never closes the queue.

### Where the build differs from the mockup, on purpose

- **Timezone** is read-only (see above), not a dropdown.
- **Date and time** are typed parts, not pickers (seconds).
- **No bottom navigation on the phone** (Queue / Process / Help): the list,
  the editor and the run each take the screen in turn, and every one has its
  own way back; a Help tab would need help content nobody has written.
- **The fourth promise reads "Local processing only (no upload to
  process)"**, not "(No Upload)": a finished copy that belongs to a case can
  still be sent, on the operator's own press in its details, to the case's
  Dropbox folder — the owner-approved optional step of 2026-08-18. Processing
  never uploads anything; that button is the one way a video byte (the clean
  derivative, never an original) can leave the device.
- **The processing row is sticky only on tall desks** (measured above).

## 7. Found on the way, and fixed there

- **A failed MP4 finish on the MOV/MP4 path offered the same run again.** The
  transport-stream path already classified a writer that throws at its last
  step (`encoder`, or `memory` for a `RangeError`); the MOV/MP4 path called
  `finalize()` bare, so the error reached the screen with no class,
  `vstFaultView` returned nothing, and the preview drew Generate over the
  failure. Found by writing item 35's "failed mux/finalization" test; both
  paths now answer the same way and the test holds each.
- **"Too large to fingerprint in a browser" stopped being true** the day the
  copy was fingerprinted in the browser at any size. The limit is this tool's
  (the original's workflow is Web Crypto, whole file, ≤128 MB), and
  `vstOrigHashWhy` is now the one writer of that sentence — both screens and
  the receipt. Each queue row also carries the brief's compact *Original
  fingerprint recorded ✓* (under *More*, so the phone card stays compact).
- **A queue entry was not light.** Each checked MOV/MP4 kept its whole frame
  table — measured in V8 at ~85 bytes a frame, so 18 MB for an hour at 60 fps
  — and a queue of long clips held every one at once, against item 16's
  "lightweight references". A checked entry now keeps the count
  (`vstSlim`); Generate reads the table again from the same file and refuses a
  file that no longer reads with the frames that were checked (a `read` fault,
  offered *Choose this video again*).
- **A time typed a moment before the file's own date arrived was written
  over by it.** Analysis writes the capture time into an entry only when
  nothing is typed, and it read "nothing typed" from the draft — which a value
  put in the box without an input event did not have yet. It now takes the
  editor's boxes as the draft first. Found by the existing typing test after
  the dashboard rewrite.
- **The receipt sat inside a guard's range.** "The opener never falls back to
  the current clock" scans from `vstOpen` to `vstLoadCases`; the receipt,
  which reads the clock on purpose, had been placed between them, so the
  guard was failing on the branch. The receipt moved out of the range; the
  guard was not narrowed.
- **A Generate pressed while another video was processing did nothing,
  silently.** It now says videos are made one at a time.
- **"Everything happens on this device and nothing is uploaded"** was wider
  than the product: a finished copy that belongs to a case can still be sent,
  on the operator's explicit press, to the case's Dropbox folder — the
  owner-approved optional step of 2026-08-18, unchanged here. The queue now
  says *every copy is made on this device, and nothing is uploaded to make
  it*, which is exactly true. **That button is the only path by which any
  video byte leaves the device**, it sends the clean DERIVATIVE only, never an
  original, and nothing presses it for the operator.

## 8. Tests

{{TESTS}}

## 9. Every safety property, mutated

Each mutation was applied in a git worktree (never the working tree), the
sections that hold that property were run alone, and the mutation counts only
when an assertion **naming it** failed — a crash or an unrelated failure does
not count.

{{MUTATIONS}}

## 10. Proven here, and what is left for the device

Proven in this container: the whole pipeline on real codecs (VP9 decode →
burn → encode → mux → scrub → clean check → fingerprint → read-back → played
by the browser, stamp measured in the pixels) for MP4 and a metadata-loaded
MOV; the MTS/M2TS/AVCHD paths, the H.264 NAL walk and SEI stripping on stub
codecs with the real muxer; SHA-256 against Web Crypto; every queue rule A–L;
the dashboard at 1280, 1440, 1920, 390 and 320 — including drag and drop, the
editor's local preview, the unsaved-change prompt and the scroll position kept
across the phone's editor.

**Not provable here, and the owner's check:** this Chromium has no H.264
decoder or encoder, so an H.264 copy made by a real device's encoder — the
iPhone's — is proven by the same code path and the same check, but not by a
run in this container. The first real copy on the iPhone is the test that
settles it: it either passes the clean check, or it is refused with the
check's own words, and nothing in between is possible.

**The copy is picture only** (unchanged): the original's audio stays on the
original. The brief's "audio remains aligned where applicable" does not apply
to a copy with no audio track, and nothing claims otherwise.
