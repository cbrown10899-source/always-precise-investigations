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
