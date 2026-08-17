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
