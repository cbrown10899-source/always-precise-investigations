# Report Daily Summary Builder — the owner's brief, verbatim

**Roadmap item 12.** Queued by the owner on **2026-08-20**, mid-Unit-11, with
the instruction *"Do not start this while the current major unit is in flight.
Record it in NEXT.md in the correct roadmap position and continue the current
unit unchanged."*

Their placement rule was *"immediately after the current active unit and before
later report-dependent delivery/closeout work"*, which is why it takes 12 and
Storage Health, Case Closeout, Client Delivery Center and Retention Controls
each move one place down.

**Nothing below is designed yet.** This file exists so the brief survives the
gap between being queued and being built — the same reason `LEGAL-INTAKE.md`,
`PROFILES.md`, `TIMELINE.md` and `PHOTO-TIMESTAMP.md` exist. When it is built,
the derived decisions get listed underneath, one per entry, so each can be
overturned on its own.

---

## THE BRIEF, AS WRITTEN

> REPORT DAILY SUMMARY BUILDER
>
> Goal:
> Make each surveillance/investigation day easy to summarize into a professional
> narrative paragraph using existing case/activity data plus guided
> dropdowns/editable fields.
>
> This must use the existing report engine and templates. Do not create a second
> report system.
>
> For each worked day, provide a Daily Summary Builder.
>
> The builder should automatically know or offer values from the case/day where
> available:
>
> - Day of week
> - Date
> - Surveillance/investigation start time
> - Surveillance/investigation end time
> - Location/residence/address
> - Number of vehicles present
> - Vehicle make
> - Vehicle model
> - Vehicle year
> - Vehicle color
> - License plate/state
> - Registered owner if recorded
> - Subject departure/arrival times
> - Subject vehicle used
> - Other persons observed
> - Major activity/observations
> - No-activity periods
> - Surveillance termination time/reason
> - Investigator
>
> Use existing Activity Log / Surveillance entries and structured case data as
> sources where reliable.
>
> Do not invent facts.
>
> ## NARRATIVE BUILDER UX
>
> The Admin/report writer should see a readable paragraph being assembled, not a
> giant questionnaire.
>
> Example structure:
>
> "On [Thursday], [08-20-2026], surveillance was initiated at [8:03 AM] at
> [subject residence/address]. [Two] vehicles were observed in the driveway:
> [vehicle 1 description]. [Vehicle 2 description]. [Additional
> activity/observation sentence]. Surveillance was concluded at [time] due to
> [reason]."
>
> Variable portions should be interactive.
>
> Use appropriate controls such as:
> - dropdown/select
> - searchable select
> - time picker
> - number selector
> - existing case-data picker
> - free text when no structured value exists
>
> Do not force every blank into a dropdown if free text is more appropriate.
>
> ## VEHICLE SENTENCE BUILDER
>
> Support one or multiple vehicles.
>
> Example generated language:
>
> "A 2022 Chevrolet Silverado bearing Virginia registration ABC-1234 was
> observed in the driveway. The vehicle was recorded as registered to John
> Smith."
>
> or:
>
> "Two vehicles were observed in the driveway: a 2022 Chevrolet Silverado
> bearing Virginia registration ABC-1234, registered to John Smith, and a 2020
> Toyota Camry bearing Virginia registration XYZ-5678, registered to Jane
> Smith."
>
> Use only recorded values.
>
> If registration owner is unknown:
> omit that clause rather than writing "registered to unknown" unless Admin
> chooses that wording.
>
> If year/color/model is unavailable:
> construct grammatically correct language using only what is known.
>
> ## ACTIVITY LOG INTEGRATION
>
> Allow the Daily Summary Builder to pull meaningful events from that day's
> Activity Log.
>
> Examples:
> - subject departed residence
> - subject returned
> - vehicle departed
> - vehicle arrived
> - subject entered a business
> - subject met another person
> - no activity observed
> - mobile surveillance initiated
> - surveillance terminated
>
> Provide a selectable list of that day's activity entries.
>
> Admin can:
> - include an activity
> - exclude an activity
> - reorder if needed
> - edit the generated wording
>
> Do not alter the original Activity Log when editing report narrative.
>
> The Activity Log remains authoritative source data.
> The report summary is a separate authored narrative.
>
> ## SMART SENTENCE TEMPLATES
>
> Use deterministic sentence templates, not AI-generated facts.
>
> Examples:
>
> START:
> "On {weekday}, {date}, surveillance was initiated at {time} at {location}."
>
> VEHICLES:
> "{count} vehicle(s) were observed at the residence: {vehicle descriptions}."
>
> DEPARTURE:
> "At {time}, the subject exited the residence and departed in {vehicle}."
>
> ARRIVAL:
> "At {time}, the subject arrived at {location}."
>
> NO ACTIVITY:
> "No activity was observed during this period."
>
> END:
> "Surveillance was concluded at {time} due to {reason}."
>
> The system may combine these into a paragraph.
>
> Admin must always be able to edit the final narrative text.
>
> ## SOURCE INDICATORS
>
> Where useful, distinguish:
>
> AUTO-FILLED FROM CASE
> AUTO-FILLED FROM ACTIVITY
> MANUALLY ENTERED
>
> Do not clutter the final report with these labels.
> They are report-builder aids only.
>
> ## DAY-BY-DAY REPORT STRUCTURE
>
> For cases with multiple surveillance/investigation days:
>
> Create a summary section for each worked day.
>
> Example:
>
> Thursday, August 20, 2026
> [Daily narrative paragraph]
>
> Friday, August 21, 2026
> [Daily narrative paragraph]
>
> Saturday, August 22, 2026
> [Daily narrative paragraph]
>
> The report writer should be able to generate/edit each day independently.
>
> Do not collapse several dates into one confusing narrative unless Admin
> deliberately chooses to.
>
> ## TEMPLATE INTEGRATION
>
> This feature should work especially well with:
>
> - Surveillance
> - Domestic / Custody
> - Insurance Investigation
> - Legal Investigation
>
> General and Process/Locate may use it when a day-based chronology exists.
>
> Do not duplicate template engines.
>
> The selected Unit 9 template determines where Daily Summaries appear.
>
> ## EDITABILITY
>
> Generated narrative is a starting point.
>
> Admin must be able to:
> - edit any wording
> - add sentences
> - remove sentences
> - correct grammar
> - change selected values
> - regenerate a sentence without wiping unrelated manual edits where practical
>
> Never silently overwrite a manually edited finalized paragraph.
>
> Protect typed work from repaint/render operations.
>
> ## MOBILE
>
> Make Daily Summary Builder usable on iPhone.
>
> Requirements:
> - paragraph remains readable
> - variable controls stack cleanly
> - no horizontal overflow
> - dropdowns large enough
> - 16px inputs
> - activity-entry selectors touch-friendly
> - save state survives navigation/repaint
> - easy to collapse/expand each day
>
> ## NO AI FACT INVENTION
>
> Do not send case facts to an LLM merely to generate the paragraph.
>
> Use deterministic structured templates from existing data.
>
> If later AI polishing is considered, that must be a separate explicit owner
> decision.
>
> For now:
> structured facts + deterministic wording + human editing.
>
> ## TESTS
>
> Cover:
>
> - day/date generation
> - surveillance start/end
> - one vehicle
> - multiple vehicles
> - missing vehicle fields
> - registered owner present/absent
> - activity entries selected
> - activity entries excluded
> - chronological order
> - no-activity sentence
> - termination reason
> - manual edits persist
> - regeneration does not destroy unrelated edits
> - Activity Log source unchanged
> - multiple worked days
> - template integration
> - mobile layout
> - no page-wide overflow
> - Admin permissions
> - investigator restrictions unchanged
>
> Do not start this while the current major unit is in flight.
>
> Record it in NEXT.md in the correct roadmap position and continue the current
> unit unchanged.

---

## WHAT THIS REPO ALREADY HOLDS FOR IT

Noted at queueing time only, so whoever builds this does not go looking. **No
design decisions are made here.**

- **The report engine and the six templates are Unit 9** — `REPORT_TEMPLATES`
  in `portal/index.html`, `build_template` in the Worker, one `%PDF-1.` writer,
  and a test that fails if a second one appears. *"The selected Unit 9 template
  determines where Daily Summaries appear"* lands in `tdef.sections`.
- **A worked day is `case_days`** (`day_date`, `start_time`, `end_time`,
  `hours`, `miles`, `summary`, per investigator) and **one report per day** is
  already enforced by `idx_reports_day`. `case_reports.body` is plain editable
  text from the moment it is created — *"the generated chronology is a starting
  point, never a finished document"*, which is the same sentence this brief
  opens with.
- **The day's activity is `activity_log`** scoped by `day_id`, with
  `activity_removed` for entries taken out and `activity_source` for voice.
  *"Do not alter the original Activity Log"* means the builder reads it and the
  narrative is stored somewhere else.
- **Vehicles are `subject_vehicles`** beside `case_subjects` — year, make,
  model, colour, plate and state are already structured columns, which is what
  makes deterministic sentence assembly possible without inference.
- **`EDIT_DRAFT` / `RET_DRAFT` is the existing answer to *"protect typed work
  from repaint"***, and it has been needed four times already. Anything that
  repaints must collect the typed values first.
- **Nothing in this portal calls an LLM**, and *"do not send case facts to an
  LLM"* keeps it that way.

## THE OPEN QUESTION THIS FILE IS NOT ANSWERING

Where the authored narrative is STORED. `case_reports.body` already exists and
already holds the day's report text, but a per-day builder with regenerable
sentences and manual edits may want the two kept apart so regeneration can
rebuild one sentence without touching the rest — and `schema.sql` is re-applied
on every portal-setup run, so a column cannot be added to `case_reports`
idempotently. That is a companion-table decision to be made when the unit is
designed, against the same reasoning that produced `build_custom`,
`activity_removed` and `photo_stamp`.
