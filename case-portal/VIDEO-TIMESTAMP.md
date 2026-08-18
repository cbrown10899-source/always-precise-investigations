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
