# Storage Health — designed from the audit, 2026-08-21 (Unit 14)

**No verbatim owner brief exists for this unit.** The roadmap row says
"Storage Health" and nothing else; `MASTER-HANDOFF.md` has no section for it.
Per the owner's instruction of 2026-08-21 — *"Audit first, then continue the
approved queue unless a stop condition is hit"* — this file records the audit
and the decisions DERIVED from it, each separately overturnable. The palette
brief's File-Queue language ("summary cards … teal processing/info, amber
awaiting review, green ready") is the visual register it inherits.

## THE AUDIT — what already exists, and what nothing answers

| Fact | Where it lives today | Who can see it |
| --- | --- | --- |
| R2 bytes vs free-tier cap, monthly upload count, per-file limit | `evidenceUsage()`; dashboard Storage card; `GET /storage` | admin |
| `storage_pct` as a bare public number | `/portal-api/health`; `site-health.yml` opens one issue over 75 | public (number only) |
| Dropbox connection: account, folder name, per-case links | `dropboxState()`; Settings Dropbox card | admin |
| Whether an upload would be refused right now | `dropboxStorageProblem()` — but only by TRYING one | nobody, passively |
| How many bytes sit in Dropbox vs legacy R2 | **nothing answers this** | — |
| How much of the firm's Dropbox quota is used | **nothing answers this** | — |
| How many legacy R2 video files the open export/remove decision covers | **nothing answers this** — the decision is recorded in CLAUDE.md with no inventory behind it | — |
| Integrity coverage: how many live files have no recorded hash | per-file "Not yet recorded" badges only; no total | — |
| Which cases carry the most stored bytes | **nothing answers this** | — |

So Storage Health is the SCREEN THAT ANSWERS THE UNANSWERED ROWS — from
metadata the database already holds, in one place, for an admin.

## DERIVED DECISIONS

- **D1 — One route, `GET /storage-health`, admin-only.** Composes: the
  existing Cloudflare meter (`evidenceUsage`, unchanged); Dropbox-side
  aggregates (live rows and bytes, deleted rows, timestamped-video copies
  filed, report PDFs filed); legacy-R2 aggregates split photo/video — the
  inventory the open decision has been missing; integrity coverage (live
  files with and without a live hash record, guarded through
  `missingTables`); the top cases by live bytes (one GROUP BY, LIMIT-bound);
  and the limits. **Metadata only: no byte is read, no folder is listed.**
- **D2 — The one external call is Dropbox `users/get_space_usage`,** because
  "is the firm's Dropbox filling up" is the storage-health fact the meter
  cannot know. It runs ONLY inside this route — never on the dashboard, never
  on a case — costs one RPC per explicit open/refresh, and degrades to
  `space: null` with a named reason rather than a guessed figure. No listing,
  no sharing scope, no bytes.
- **D3 — No schema.** Every number is an aggregate over tables that exist;
  no snapshot table, no history invented (the Unit 10 rule — a trend line
  would require an audit system nobody asked for). **No portal-setup
  dispatch owed.**
- **D4 — The panel lives on Settings** beside the Dropbox card it extends,
  behind the existing admin gate, fetched only when Settings opens. Three
  states, per the standing rule: never loaded / failed (says so, offers
  retry — a failed read must not draw as an empty store) / loaded.
- **D5 — The legacy-video inventory states the open decision instead of
  hiding it:** the row names the count and bytes and says in words that
  whether to export and remove them is a decision nobody has made — this
  screen informs it and must not perform it. **Sweeping them would be a stop
  condition, and nothing here writes at all.**
- **D6 — Thresholds are the ones that already exist** (`STORAGE.warnPct` on
  the R2 meter; 75% echoed for Dropbox space when known). No new alerting —
  `site-health.yml` and the dashboard card keep their jobs; this screen is
  where the numbers behind them live.
- **D7 — Deferred, named:** any storage ACTION (export, sweep, migrate) —
  Retention Controls is item 17 and owns policy; a stored history/trend; any
  per-file listing UI (the owner explicitly did not want a file manager).


---

## THE OWNER'S BRIEF — arrived 2026-08-21, mid-unit, verbatim

The audit-derived build above was already coded when the owner's own Unit 14
brief landed. It is the spec of record from here on; where it names something
the derived design lacked, the delta below adds it. It also supersedes the
"continue the queue" cadence for this unit: **stop after Unit 14.**

> UNIT 14 STORAGE HEALTH ONLY.
>
> Audit current storage first. Then implement and verify the approved
> storage-health system: Dropbox connection/health, last successful upload,
> failed uploads, safe storage status, and clear error states. Do not expose
> credentials or secrets.
>
> Enforce the approved storage rules: Dropbox is the permanent file storage
> for timestamped photos/videos, reports, and case images; do not add D1/R2
> permanent file storage. Keep originals untouched. Avoid duplicate permanent
> copies. Keep one final report PDF where practical. Store metadata, hashes,
> and references instead of unnecessary derivatives.
>
> Retention or deletion controls must be Admin-only. Never automatically
> delete or overwrite evidence. Do not add a paid provider, SMS, new storage
> service, or anything that can create an unapproved usage charge.
>
> Test disconnected Dropbox, failed upload, successful upload, duplicate
> handling, existing photo/video timestamp flows, report/package flows,
> mobile behavior, and existing portal regressions.
>
> Do not redesign the portal or build the File Queue mockup in this unit.
>
> Run the existing full tests. Fix only Unit 14 regressions. Push, merge,
> deploy, and live verify using the normal workflow if green.
>
> When complete, report exactly what changed, tests run, deployment SHA, live
> verification, storage impact, and any remaining risks.
>
> STOP before destructive migration, evidence deletion/overwrite, credential
> changes, new paid services, or an owner policy decision.
>
> Do not start Unit 15. Stop and report Unit 14 complete.

## THE DELTA the brief adds to the derived build

- **D8 — Failed uploads become a RECORD, because the owner asked for one.**
  Until now a refused upload was deliberately not logged (Unit 10 recorded
  that absence). The brief names "failed uploads" as part of the system, so
  `storage_failure` is one additive table — kind, case, filename, reason,
  who, when — written BEST-EFFORT at the moments a storage write is refused:
  the evidence upload, the timestamped photo, the timestamped-video steps and
  the report PDF. A failed log write never changes the caller's response
  (test: with the table absent, every refusal answers byte-identically), and
  a SUCCESSFUL write logs nothing — including the autorename path, which is a
  success. Guarded, in `EXPECTED_TABLES`, swept by `DEMO_SWEEP`. **This makes
  the unit owe one `portal-setup.yml` dispatch after merge.**
- **D9 — "Safe storage status" is the passive readiness answer**: the route
  reports `readiness` — would an upload be accepted right now — from the same
  three conditions the upload doors check (`provider configured`, `account
  connected`, `token mintable`), with the code named when the answer is no.
  One token mint shared with the space call, not a second.
- **D10 — "Last successful upload" derives from the rows that exist**
  (MAX `uploaded_at` over Dropbox-backed evidence) — no new write, nothing to
  drift.
- **D11 — No credential leaves.** The payload is asserted free of token,
  secret and refresh strings, the manifest's own rule applied here.
- **D12 — Duplicate report PDFs are reported as a REMAINING RISK, not
  changed.** Re-filing a report PDF today creates `…v1-1.pdf` beside
  `…v1.pdf` (Dropbox `add` + autorename — the deliberate never-overwrite
  posture of the shared upload helper). "Keep one final report PDF where
  practical" reads as wanting one; making the PDF save overwrite would put an
  overwrite mode on the helper that also writes EVIDENCE, one stray flag from
  the exact failure the posture exists to prevent. Deferred with its
  reasoning; the integrity record already supersedes correctly on re-filing.
