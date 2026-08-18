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
| ✅ | §2 wake-word loop + VOICE MODE ON/OFF, §9 confirmation, §14 states, §16 foreground limit | **Shipped 2026-08-18.** Explicit toggle on the field home; opening Active Surveillance constructs no recogniser at all. Say "Mobile" and the command in one breath, or "Mobile" alone to arm it. A confidently matched command files a real entry and returns to listening without a tap. §16 is enforced, not merely written: the loop stops when the page is hidden and says why |
| 🟡 | §8 duplicate protection | **Half built, with the loop, because the loop is what creates the failure.** Repeated finals from the engine are guarded by an in-flight lock plus a six-second same-command window. **The offline/retry half is NOT built** and needs a server-side event key |
| 🔴 | §1 compact status header | Reclaims the space the big timer takes on mobile |
| 🔴 | §6B dictation mode as a loop | The SAVE / EDIT / DISCARD wording and the return to listening. The behaviour it depends on already exists |
| ✅ | §10 LAST ACTIVITY | **Shipped 2026-08-18.** Edit and Remove on the field home, correcting the newest entry *in place* — the editor opens inside the card and the home screen never leaves the screen. A removed one is struck through with Put it back. Two defects fell out of building it, both fixed and both tested: `editActivity` was **replace-all**, so a wording-only correction would have written NULL over the location and vehicle the investigator recorded; and `svDeleteEntry` forced a jump to the timeline, which was harmless while Delete only existed ON the timeline and navigated you away from the field home the moment it did not |
| 🔴 | §8 duplicate protection, §9 spoken confirmation, §13 photo/video commands | |

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

### What §10 taught, worth keeping

**A screen that corrects one field exposes every route that replaces all of
them.** `editActivity` had been replace-all since it was written and nothing had
noticed, because the timeline's Edit form was its only caller and always posted
all four fields. The rule it now follows is the one `/cases/:no/meta` already
states in its own words: **an absent field means unchanged, a blank string still
clears**, and the untouched fields are resolved INSIDE the UPDATE from the row
rather than from a value read a moment earlier.

**"Without navigating away" has to be asserted as a screen, not as a message.**
The first version of the removal test passed while standing on the timeline,
because the timeline shows the same "not in the report" wording — which is
exactly how the unwanted jump hid. The assertions now pin a home-screen marker
alongside the text.

### What the loop will and will not do on its own

**Only a confidently matched structured command files itself.** That is §6/§7's
rule made concrete: ambiguous phrases, dictated prose and phrases that matched
nothing all **stop the loop** and hand over to the review that already existed.
The loop stops deliberately — the operator is now looking at a question, and a
microphone still listening would file something over the top of it.

**Speech without the wake word is ignored entirely.** While voice mode is on the
microphone hears the radio, the passenger and the road. Only an utterance
carrying "Mobile", or the one immediately after "Mobile" said alone, is treated
as addressed to the portal. Without this the screen fills with review prompts
from a conversation nobody was having with the portal.

**§16 is enforced.** The loop stops on `visibilitychange` and says *"Voice mode
stopped because this page went into the background."* An investigator who
believes the phone is listening in their pocket stops narrating, and the hole in
the log is found when the report is written.

**§8's covered half.** Speech engines re-emit a final result, and an auto-filing
loop turns that into a duplicate entry in the evidence log. Two guards, because
§8 says not to rely on matching text alone: nothing files while a file is in
flight, and the same canonical command inside six seconds is the engine hearing
it twice rather than the investigator saying it twice. A failed POST clears the
guard, so a genuine retry is not mistaken for a duplicate.

**§8's uncovered half, stated plainly:** retries after an offline period. That
needs an event key the server enforces, and it is not built.

### How it is tested without a microphone

Headless Chromium has no speech recognition, so the **engine** is stubbed and
everything around it is real — the real registry, the real activity API, the
real database. The stub supplies only what a machine in a data centre cannot:
what was heard. It counts `start()` and `stop()`, so "the microphone is inactive
when off" is asserted as a fact about calls rather than as wording on a screen.

**The microphone itself stays LIVE VERIFIED OPEN** and can only be closed on a
real phone.

## The iPhone bug, 2026-08-18 — ON, microphone lit, nothing happens

Owner, on the device: *"Voice Mode shows ON and iOS mic indicator is active, but
saying Mobile produces no result and Tap to speak does nothing."*

**Two symptoms, and one of them needed no Safari knowledge to find.** The page
had **two** recognisers — the loop's and "Tap to speak"'s — and a browser gives
a page **one** speech session. With the loop holding it, the manual button
started a second engine on top of the first and the browser ignored it. That is
exactly what a button that does nothing looks like. "Tap to speak" now takes the
session properly: the loop stands down, and the handover is on the record.

**The other symptom is `continuous`.** iOS Safari does not honour continuous
recognition — the session starts, the indicator lights, and no result is ever
delivered, which is the report word for word. The loop is now **one-shot,
restarted on `end`**, which is the portable shape and behaves the same on
desktop. One code path, no device sniffing.

**And a start that throws no longer leaves the panel claiming ON**, which is the
shape of the whole complaint: a control saying it is listening while nothing is.

### The device now says what it did

Every `SpeechRecognition` event is logged with a timestamp — `start`,
`audiostart`, `soundstart`, `speechstart`, `result`, `nomatch`, `error`,
`speechend`, `soundend`, `audioend`, `end` — **alongside the calls this page
makes itself** (`start() called`, `restarting`, `start() threw`). That
distinction is the diagnostic: *"we called start() and the engine never said
start"* is a different fault from *"start, audiostart, speechstart, then end
with no result"*, and they have different fixes.

It is shown **on the phone**, under Speech events on the field home. A log in a
console nobody can open on an iPhone in a car is not a diagnostic. It appears
once there is something in it and can be cleared.

**Errors are logged even when they stop nothing.** `no-speech` and `aborted` are
ordinary and the loop carries on through them — but silence about them is what
made this bug invisible in the first place.

### What is still unproven

This container has **no speech engine at all**, so the fix for the results
symptom is reasoned from the reported behaviour and iOS Safari's known
treatment of `continuous`, not observed. The event log exists precisely so the
next device test reports a fact rather than a symptom: if it shows `start()
called` and nothing after it, that is a different finding from a full
`start → audiostart → speechstart → end` with no `result`.

## §7 OVERRIDDEN BY THE OWNER, 2026-08-18 — after "Mobile", nothing is thrown away

Owner, after using it: *"Voice commands are too strict. After Mobile, use a
known command if confident; otherwise save the spoken words as an editable
VOICE activity entry. Do not reject unmatched useful speech or pause the loop.
Keep the raw transcript for audit and return to listening after save."*

**This reverses what §7 asked for, and the reversal is right.** §7 was written
to stop a misheard phrase filing itself as an official record, and the first
build honoured it by PAUSING the loop and asking. At the wheel that is the
worse failure: the investigator carries on narrating to a microphone that
stopped listening, and the hole in the day's log is found when the report is
written. A surveillance log with gaps is the evidence problem. An unpolished
but accurate sentence is not.

**The part of §7 that still holds, and it is the part that mattered.** An
uncertain phrase **never gets a canonical command id**. "Mobile change" fits
both `NO_CHANGE` and `CHANGE_POSITION`, which are opposite facts about the same
minute, and guessing between them puts a claim in the evidence log that nobody
made. Saving the words actually spoken asserts nothing false: it records what
was said, marked `source = voice`, with `command_id` **null**, editable and
removable like any other entry, and the raw transcript kept beside it.

So the loop now has exactly two outcomes after the wake word:

| What was heard | What is filed |
| --- | --- |
| a confidently matched command | the standardized sentence, with its canonical `command_id` |
| anything else — ambiguous, dictated, unmatched | **the spoken words**, `command_id` null |

Both confirm briefly and **return to listening**. Neither pauses.

**The wake word stays strict, and that is the one thing that must not relax.**
Only an utterance carrying "Mobile" — or the one immediately after "Mobile"
said alone — is treated as addressed to the portal. Without it the day's log
fills with the passenger's half of a phone call and the radio.

**The words are the operator's.** The wake word is stripped off the front, and
a leading "note" with it, because that word asked for free text rather than
describing anything. Nothing else is rewritten — tidying someone's words is how
a log stops matching what happened.

**§8 still applies to free speech**, which has no command id to key on: the
duplicate guard keys on the normalized words instead, so an engine re-emitting
a final result still produces one entry.

**The review screens are not dead code.** "Tap to speak" still goes through
transcript review, and an ambiguous transcript there still gets §7's chooser.
What changed is the LOOP, which is where pausing was costing the log.
