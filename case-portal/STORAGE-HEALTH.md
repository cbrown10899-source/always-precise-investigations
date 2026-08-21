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
