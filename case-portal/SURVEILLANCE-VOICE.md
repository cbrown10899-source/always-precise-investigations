# ACTIVE SURVEILLANCE — VOICE COMMAND MODE (INTERNAL)

**Owner handoff, 2026-08-15, restored in full across five recovery
transmissions.** Recorded before building, per the standing rule.

> **TRANSMISSION NOTE — now complete.** This handoff arrived in pieces, each
> degrading at the end, and was restored across five recovery transmissions.
> **Every section §1–§16 has now been received.** What remains marked
> [TRUNCATED] is a handful of SPOKEN ALIASES in the §4 table, which the owner
> instructed must not be inferred; every canonical command id is known.
> [inferred] marks a reading through a gap and is NOT the owner's words.

**This is real functionality, not mockup work.** Preserve the existing case,
activity, report, evidence, audit, authorization and Active Surveillance
architecture. **Do NOT create a parallel activity database.** Everything voice
creates uses the SAME activity records, API, timeline and report generation as
manually entered activity.

---

## §1 MOBILE HOME — STREAMLINE

The large surveillance timer consumes too much mobile screen. Replace it with a
**compact persistent status header**:

```
● ACTIVE   02:18:47
CASE API-2026-0178   DAY 2
```

Keep the current case, surveillance day, elapsed time and active status, but
**reduce vertical space substantially.** Use the reclaimed area for: QUICK
ACTIVITY · VOICE COMMAND MODE · LAST ACTIVITY · PHOTO · VIDEO · NOTE · END
INVESTIGATION DAY.

Bottom navigation remains: Home · Activity · Evidence · Report · More.

## §2 VOICE COMMAND MODE

Explicit user control: **[ VOICE MODE ON / OFF ]**. It must **NOT activate
automatically** when Active Surveillance opens.

When ON and microphone permission is granted, show a clear active state:
`🎙 LISTENING FOR "MOBILE…"`. The wake phrase is **MOBILE**.

The loop: listening for "Mobile" → detect "Mobile" → listen for one command →
interpret command → [create the activity, inferred] → return to listening.

The investigator **should not need to touch the microphone button after every
recognized structured command** while Voice Mode is active in the foreground.

## §3 VOICE COMMANDS MUST CREATE REAL ACTIVITY

**The most important requirement.** A recognized structured command must create
an actual Activity Log record **through the existing activity API**. It must
NOT simply display text on the mobile screen.

Each voice-created activity carries the normal activity fields **plus
`source = voice`** *(recovered 2026-08-15, transmission 2 of 5)*.

The intended fields: case ID · surveillance day · timestamp · activity type ·
**standardized** activity text · investigator/user ID · **`source = voice`** ·
audit fields.

This uses the **SAME** existing Activity API and data model as manual activity.

> **Implementation note, not an owner instruction.** `activity_log` has no
> `source` column today, and `ALTER TABLE ADD COLUMN` is not idempotent —
> `schema.sql` is re-applied on every `portal-setup` run, so adding one there
> would bind a fresh database and not the live one. The standing precedent is a
> companion table (`activity_removed`, `build_custom`, `build_reports`), which
> also keeps `source` out of the way of every existing read. Decide it
> deliberately when this is built; do not reach for `ALTER TABLE`.
>
> Note also what `source` is FOR: it marks how the entry was captured, and must
> not become a licence to treat voice entries differently. §11 is explicit that
> they use the same Edit / Remove system, and §12 that voice and buttons
> converge on the same canonical types — a spoken entry is not privileged or
> immutable because it came from speech recognition.

It must immediately appear in **LAST ACTIVITY** and the **ACTIVITY LOG /
TIMELINE**, and feed draft report derivation exactly like a manual activity.

## §4 COMMAND REGISTRY

**ONE centralized command registry.** No scattered phrase matching through UI
components. Shape: spoken aliases → canonical command → activity type →
[sentence] → optional structured fields.

| Spoken | Canonical |
| --- | --- |
| "Mobile, arrival" | `ARRIVAL` |
| "Mobile, no change" | `NO_CHANGE` |
| "Mobile, no change at residence" | `NO_CHANGE_RESIDENCE` → "No change observed at the residence." |
| "Mobile, doing a drive-by check of residence" | `MOBILE_RESIDENCE_CHECK` → "Mobile check of residence was conducted." |
| "Mobile, drive-by check" | `MOBILE_RESIDENCE_CHECK` |
| "Mobile check" | `MOBILE_CHECK` |
| "Mobile, subject observed" | `SUBJECT_OBSERVED` |
| "…departed" | `SUBJECT_DEPARTED` |
| "Mobile, subject arrived" | `SUBJECT_ARRIVED` |
| "Mobile, subject returned" | `SUBJECT_RETURNED` |
| "…observed" (vehicle) | `VEHICLE_OBSERVED` |
| "Mobile, subject vehicle present" | `SUBJECT_VEHICLE_PRESENT` |
| "…vehicle absent" | `SUBJECT_VEHICLE_ABSENT` |
| "Mobile, lost visual" | `LOST_VISUAL` |
| "Mobile, regained visual" | `REGAINED_VISUAL` |
| "Mobile, changing position" | `POSITION_CHANGE` |
| "Mobile, direct view" | `DIRECT_VIEW` |
| "Mobile, indirect view" | `INDIRECT_VIEW` |
| "…no activity" | `NO_ACTIVITY` |
| "Mobile, stationary surveillance" | `STATIONARY_SURVEILLANCE` |
| "…conducting mobile surveillance" | `MOBILE_SURVEILLANCE` |
| "Mobile, note" | `FREE_FORM_DICTATION_MODE` |

**Every canonical id and its primary alias has now arrived** (transmission 3B
closed the last one). `STATIONARY_SURVEILLANCE` is a structured command and
uses the same canonical Activity Log architecture as the rest.

**Several rows above still show a PARTIAL spoken phrase** — "…departed",
"…observed", "…vehicle absent", "…no activity", "…conducting mobile
surveillance". Those are exactly what arrived. The owner's instruction is
explicit: **do not infer or recreate any corrupted or truncated alias.** They
stay as received until the full phrase is sent. Aliases are extensible by
design, so an incomplete list delays nothing — an invented one would put words
in an investigator's mouth and map them to a real Activity Log record.

**A fragment reading "…at residence" → "…RESIDENCE" also arrived, and is NOT
recorded as a command.** Neither half of it is legible — an ellipsis is not an
identifier — and it sat between `NO_CHANGE_RESIDENCE` and
`MOBILE_RESIDENCE_CHECK`, both of which end the same way. It is far likelier to
be a truncation artefact of one of those two than a twenty-fourth command.
Listing it as a row would assert that a command exists on the evidence of a
fragment, which is how a guess quietly becomes a requirement.

### Near-collisions the registry has to resolve, not inherit

The recovered ids make two pairs visible that differ by a couple of words and
mean different things. These are §7's ambiguity case, and they are the reason
§7 exists:

| These sound alike | And mean different things |
| --- | --- |
| "Mobile check" → `MOBILE_CHECK` | "Mobile, drive-by check" → `MOBILE_RESIDENCE_CHECK` |
| "Mobile, no change" → `NO_CHANGE` | "Mobile, no change at residence" → `NO_CHANGE_RESIDENCE` |

"Mobile check" is also the wake word followed by a common noun, so it will be
heard often and by accident. Neither pair may be resolved by picking the closer
match: **§7 governs — offer the candidates, or create nothing.**

Design the registry so **additional aliases and standardized phrases can be
added later.**

## §5 STANDARDIZED ACTIVITY TEXT

Known commands store standardized language, not the raw transcript.

- Spoken: *"Mobile, doing a drive-by check of residence, stand by."*
  Stored: *"[Mobile check of] residence was conducted."*
- Spoken: *"Mobile, no change at residence."*
  Stored: *"[No change observed at the] residence."*

The raw transcript **may optionally be retained as internal diagnostic
metadata**, but must **NOT replace the standardized activity text.**

## §6 COMMANDS VS FREE-FORM DICTATION

Two distinct behaviours.

**A. Structured command** — confidently recognized. Save the standardized
activity entry → brief confirmation → return to listening.

**B. Free-form dictation** *(recovered 2026-08-15, transmission 4 of 5).*

`"Mobile, note"` starts `FREE_FORM_DICTATION_MODE`. After that command, listen
for the investigator's free-form dictated note.

**Do NOT automatically save dictated prose.** Show:

```
NOTE
[text]

[ SAVE ]   [ EDIT ]   [ DISCARD ]
```

- **SAVE** — creates the intended note/activity **only after user
  confirmation**.
- **EDIT** — correction before saving.
- **DISCARD** — no record.

After Save or Discard, return to the normal Voice Mode state:
`LISTENING FOR "MOBILE…"`.

**Free-form speech must never silently become an official Activity Log
entry.**

> This is §7's rule applied to the other half of the feature. §7 says an
> AMBIGUOUS command must not file itself; §6B says dictated PROSE must not
> either, even though it was heard perfectly. The two together mean the only
> thing that ever writes an Activity Log record without a human confirming it
> is a structured command matched with confidence — everything else stops and
> asks.
>
> The portal already works this way today: `SV.heard` holds the transcript and
> only Use Text turns it into an entry. §6B renames the controls (SAVE / EDIT /
> DISCARD) and adds the return to listening; it does not reverse the existing
> behaviour, so this is a smaller build than it looks.

## §7 AMBIGUOUS COMMANDS — NEVER GUESS

*(Recovered 2026-08-15, transmission 1 of 5.)*

When match confidence is low, recognition is incomplete, or **multiple commands
could match**:

**DO NOT CREATE AN ACTIVITY.**

```
I HEARD:
"Mobile change…"

DID YOU MEAN:
[ No Change ]
[ Change Position ]
[ Try Again ]
[ Cancel ]
```

**No ambiguous voice phrase may silently become an official Activity Log
record.**

> This is the rule the rest of the voice feature has to be built around, not a
> nicety bolted on at the end. An activity entry is evidence: it feeds the
> daily report, the client package and, eventually, testimony. A misheard
> phrase that files itself is worse than one that files nothing, because
> nothing announces it — the investigator moves on believing the log says what
> they said. "Mobile change" is the owner's own example and it is a good one:
> `NO_CHANGE` and `CHANGE_POSITION` are opposite facts about the same minute.
>
> It also sets the default for the registry in §4. A phrase that matches
> nothing is not a free-form note and must not quietly become one — free-form
> is entered deliberately, by saying "Mobile, note" (§6B), and it requires
> review before save in any case.

---

## §8 DUPLICATE PROTECTION

Speech recognition can emit **repeated final results**. A single spoken command
must never create duplicate Activity Log entries.

**Use command/event idempotency rather than relying only on matching text.**

> "Mobile, no change at residence" recognized twice by the speech engine during
> the same recognition cycle → **ONE** Activity Log record.

**Retries caused by connection/offline synchronisation must also not create
duplicates.**

## §9 VOICE CONFIRMATION

After a structured command is successfully saved, show a brief confirmation —
e.g. `NO CHANGE · [10:42] AM`, or `MOBILE CHECK · [added to the] Activity Log`.

Optional: a short tone. **Do not use lengthy spoken responses.**

After success, **automatically return to** `LISTENING FOR "MOBILE…"`.

## §10 LAST ACTIVITY

Active Surveillance mobile Home shows, prominently:

```
LAST ACTIVITY
10:42 AM
[No change] observed at the residence.
[ Edit ] [ Remove ]
```

The investigator must be able to **correct the most recent activity without
navigating away from the Active Surveillance Home screen.**

## §11 EDIT / REMOVE — VOICE AND MANUAL ACTIVITY

Voice-created activity uses the **SAME** Edit / Remove system as manual
activity. Normal editable rows expose `•••` → Edit · Remove.

**EDIT:** repopulated activity form → field corrections → update the live
timeline → update derived draft report content where appropriate → preserve
audit history → **never rewrite immutable submitted report snapshots.**

**REMOVE:** uses the existing soft-delete / removal architecture. A removed
activity must disappear from the active timeline, be excluded from future
generated reports, be excluded from future Case Build / client packages, remain
available in authorized audit/history, and record **who removed it and when.**

Provide `REMOVED [ Undo ]`, restoring the **original record** — not a duplicate
replacement record.

## §12 QUICK ACTIVITY AND VOICE MUST SHARE LOGIC

Quick Activity buttons and voice commands must converge on the **same canonical
activity types and the same standardized sentence generator.**

Quick Activity examples: Arrival · Mobile Check · Subject · Vehicle · Location.

Identical behaviour for **voice vs buttons vs manual entry.** All ultimately use
the existing activity API and data architecture.

## §13 PHOTO / VIDEO VOICE COMMANDS

Support "Mobile, take photo" and "Mobile, video".

Respect browser/iPhone security and permission requirements. If the browser
requires a user gesture before actual capture: **open/prepare the correct
capture interface**, and **do not claim a photo or video was captured until it
actually was.**

**Never fake evidence creation.**

## §14 MICROPHONE STATE / PRIVACY

Voice Mode requires **explicit user activation**. Do NOT automatically start
microphone processing when Active Surveillance opens.

Display states clearly: `VOICE MODE OFF` · `LISTENING FOR "MOBILE…"` ·
`[LISTENING, inferred]…` · `PROCESSING…` · `[PERMISSION] REQUIRED` ·
`[ACTION] NEEDED`.

Requires all of: an investigator · an authorized current case · an active
surveillance session · explicit Voice Mode ON.

When OFF: the microphone is inactive.

## §15 AUTHORIZATION

**Enforce voice activity authorization SERVER-SIDE.**

Voice commands must not allow an investigator to write activity to: another
investigator's unauthorized case · a case they are not permitted to work ·
[finalized/closed, inferred] cases where new activity is prohibited ·
admin-only contexts.

**Use the same authorization boundaries as manual activity creation. Do not
rely on hidden UI controls for security.**

## §16 CURRENT WEB / PWA LIMITATION

*(Completed 2026-08-15, transmission 5 of 5. Spec now complete.)*

**Voice Command Mode is FOREGROUND functionality** in the current browser/PWA
implementation.

**Do not claim reliable continuous microphone listening while:**

- the iPhone is locked
- Safari / the browser is suspended
- the page is terminated
- the app is fully backgrounded

**Design the centralized command registry and Activity API so a future native
iOS/Android app or wrapper can reuse them.**

> This is a truth-in-labelling rule, and it is the same one the privacy wording
> already follows: say only what is verifiable. An investigator who believes
> the phone is listening in their pocket will stop narrating, and the day's log
> will have a hole in it that nobody notices until the report is written. The
> honest failure — "Voice Mode stopped when the screen locked" — costs one
> restart. The dishonest one costs the evidence.
>
> The registry requirement is why §4 insists on ONE centralized registry rather
> than phrase matching spread through the UI: a native wrapper can adopt a
> registry and an API, and cannot adopt logic tangled into a web view.

## §16.1 MOBILE PRIORITY

Keep the Active Surveillance status/timer **compact**.

Put these controls **high enough for easy thumb reach**: Quick Activity ·
Voice Mode · [Last] Activity · Photo · Video · End Investigation Day.

**Do not stack unnecessary informational blocks above the controls
investigators actually need.**

Use **large tap targets, minimal scrolling, a one-handed layout, and clear
success/error states.**

> This restates §1 as a rule rather than a layout, and it matches the visual
> finding the owner sent separately about mobile Active Surveillance. The two
> agreeing is worth noting: the compact header is not a cosmetic preference,
> it is what puts the controls where a thumb can reach them while the
> investigator is holding a camera in the other hand.

---

## WHAT IS ALREADY BUILT — audit before writing anything

- **Speech input exists.** `SV._rec` / `svListen` in `portal/index.html` uses
  `SpeechRecognition`, shows a listening state, and offers the transcript for
  review with Use Text / Discard. **Nothing spoken is auto-submitted**, which is
  §6B's rule already in force.
- **Activity creation is one API.** Voice, quick lines and the custom composer
  all POST `/cases/:no/activity`; there is no parallel store to remove.
- **Edit and remove exist.** `activity_removed` (#55) soft-deletes with who and
  when, strikes the row through, offers restore, and excludes the entry from
  reports and packages — most of §11's REMOVE list.
- **Server-side authorization exists.** `caseFor()` gates every activity write,
  so §15 is largely a matter of confirming voice uses the same path rather than
  building new checks.
- **The privacy wording rule.** CLAUDE.md: say only what is verifiable ("this
  page keeps no audio"), never "never stored".

The genuinely new work is therefore: the wake-phrase loop, the command
registry, standardized sentence mapping, idempotency, the compact status
header, and Last Activity edit/remove on the Home screen.

## RECOVERY LOG — all five transmissions received

1. ~~§7 entirely~~ — **RECOVERED 2026-08-15** (transmission 1 of 5).
2. ~~§3 field~~ — **RECOVERED 2026-08-15** (transmission 2 of 5): `source = voice`.
3. ~~§4 canonical ids and aliases~~ — **RECOVERED** across transmissions 3 and
   3B: `POSITION_CHANGE`, `DIRECT_VIEW`, `INDIRECT_VIEW`, `NO_CHANGE`,
   `MOBILE_CHECK`, and `STATIONARY_SURVEILLANCE` ("Mobile, stationary
   surveillance"). Some rows still carry a partial spoken phrase exactly as
   received; by owner instruction those are **not** to be inferred, and the
   note under the table says so.
4. ~~§6B free-form dictation flow~~ — **RECOVERED 2026-08-15** (transmission 4 of 5).
5. ~~§16 tail~~ — **RECOVERED 2026-08-15** (transmission 5 of 5).

---

## BUILD STATUS — first slice shipped 2026-08-18

**Built: §4 the registry, §5 standardized text, §7 never guess.** One table in
`portal/index.html` (`VOICE_COMMANDS`) and one matcher (`voiceMatch`) — the only
place in the portal that turns a spoken phrase into a canonical command, and the
only place that decides what it is stored as. It feeds the transcript review
that already existed, so a recognized phrase now offers §5's standardized
sentence instead of the raw words, an ambiguous one asks which was meant, and an
unrecognized one behaves exactly as it did before.

**Still true, and deliberately unchanged: nothing auto-submits.** §6B and §7
both require a human to confirm, and the existing Use / Discard review is that
confirmation. This slice did not reverse it and did not add a path around it.

### What is NOT built yet, in the order it probably wants doing

| | Section | Note |
| --- | --- | --- |
| ✅ | §3 `source = voice` on the activity record | **Shipped 2026-08-18.** `activity_source` is a companion table keyed on `entry_id`, on the owner's instruction — "an idempotent companion metadata table instead of altering the existing activity_log table" — which is also the only thing `schema.sql` can do, being re-applied on every portal-setup run. `source` is a closed list matching the column's CHECK, so an unknown value is dropped rather than stored. The entry is written FIRST and the marker second, so a database that has not had the dispatch run costs the marker and never the investigator's words. §11/§12 hold: the same edit, the same removal, no privilege |
| 🔴 | §2 wake-word listening loop, VOICE MODE ON/OFF | The hands-free half. Explicit control, never auto-activating |
| 🔴 | §1 compact status header | Reclaims the space the big timer takes on mobile |
| 🔴 | §6B dictation mode as a loop | The SAVE / EDIT / DISCARD wording and the return to listening. The behaviour it depends on already exists |
| 🔴 | §8 duplicate protection, §9 spoken confirmation, §10 LAST ACTIVITY, §13 photo/video commands | |

### Two things the owner still has to supply

- **The truncated spoken aliases in §4.** `VEHICLE_OBSERVED` was **answered by
  the owner on 2026-08-18**: *"vehicle observed"* and *"vehicle sighting"*, and
  explicitly **not** the bare word *"observed"* — which is exactly why it had
  been left unaliased, since mapping it would file "subject observed" as a
  vehicle sighting. Both halves are asserted. `SUBJECT_DEPARTED`,
  `SUBJECT_VEHICLE_ABSENT`, `NO_ACTIVITY` and `MOBILE_SURVEILLANCE` are still
  registered on their visible fragments only and could use the same treatment.
- **The standardized sentences.** §5 gives two verbatim and they are used
  exactly. The other nineteen are this implementation's wording, written in the
  same register, and every one of them is in the single `VOICE_COMMANDS` table —
  reword any of them in one edit.

### The §3 record, in one place

`activity_source(entry_id, source, command_id, heard, at)`.

- **`source` is a marker, never a privilege.** §11 and §12 are explicit, and
  there are tests: a voice entry edits and removes exactly like a typed one, and
  its source survives an edit because it records how the entry was CAPTURED, not
  what it now says.
- **`heard` is the raw transcript**, which §5 permits as internal diagnostic
  metadata — it answers "the entry says X, what did they actually say?". It must
  never replace the standardized text, and **nothing surfaces it yet**: it is
  stored, it is deliberately kept out of the workspace payload, and a test
  fails if it appears there.
- **The join is guarded** through `missingTables()`, like every table added
  after the live database existed. Between a merge and the manual portal-setup
  dispatch the table does not exist, and the workspace is the most-used screen
  in the portal.
- **`source = voice` is set for anything captured through the microphone**,
  whether or not a command matched and whether or not the operator edited the
  wording afterwards. The canonical command rides along only when there was one:
  "use my own words instead" claims none.
