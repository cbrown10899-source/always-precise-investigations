-- Case portal schema (Cloudflare D1 / SQLite).
--
--   npx wrangler d1 execute api-case-portal --remote --file=case-portal/schema.sql
--
-- Applying this twice is safe: every object is created IF NOT EXISTS.

-- Staff accounts. There is no self-signup — an admin creates every account,
-- and deactivating is preferred over deleting so a case keeps showing who it
-- was assigned to.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  display_name  TEXT    NOT NULL DEFAULT '',
  pass_hash     TEXT    NOT NULL,           -- PBKDF2-SHA256, hex
  pass_salt     TEXT    NOT NULL,           -- per-user, hex
  iterations    INTEGER NOT NULL,           -- recorded per user so it can be raised later
  role          TEXT    NOT NULL CHECK (role IN ('admin','investigator')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL,
  last_login_at TEXT
);

-- Server-side sessions. Only the SHA-256 of the cookie value is stored, so a
-- leaked database still does not hand anyone a usable session cookie.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Every intake submission. payload holds the form exactly as submitted; the
-- columns beside it are denormalised copies so the case list can be filtered
-- and searched without parsing JSON on every row.
CREATE TABLE IF NOT EXISTS submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no      TEXT    NOT NULL UNIQUE,
  kind         TEXT    NOT NULL CHECK (kind IN ('consumer','claims')),
  service      TEXT,
  status       TEXT    NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','assigned','in_progress','closed')),
  assigned_to  INTEGER REFERENCES users(id),
  client_name  TEXT,
  client_email TEXT,
  client_phone TEXT,
  subject_name TEXT,
  carrier      TEXT,
  claim_number TEXT,
  payload      TEXT    NOT NULL,
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_created  ON submissions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_assigned ON submissions(assigned_to);
CREATE INDEX IF NOT EXISTS idx_sub_claim    ON submissions(claim_number);
CREATE INDEX IF NOT EXISTS idx_sub_kind     ON submissions(kind);

-- Login throttling, keyed by username. Counting in the database rather than in
-- memory means the lockout survives the Worker being recycled between requests.
CREATE TABLE IF NOT EXISTS login_fails (
  username     TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

-- Invitations. There is no way to create an account except by redeeming one of
-- these, and only an admin can issue them. The invitee chooses their own
-- password when they redeem it, so nobody — including the admin who invited
-- them — ever knows it. Only the SHA-256 of the token is stored, so the
-- database does not contain a redeemable link.
CREATE TABLE IF NOT EXISTS invites (
  token_hash   TEXT PRIMARY KEY,
  username     TEXT    NOT NULL,
  display_name TEXT    NOT NULL DEFAULT '',
  email        TEXT,
  role         TEXT    NOT NULL CHECK (role IN ('admin','investigator')),
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,
  used_at      TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_invites_user ON invites(username);

-- Ingest rate limiting, one row per minute. The intake form is public, so its
-- ingest key is public too; this is what actually stops the table being
-- flooded. Losing a minute of portal writes never costs a client anything —
-- the form delivers by email independently of this.
CREATE TABLE IF NOT EXISTS ingest_rate (
  minute TEXT PRIMARY KEY,
  n      INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Case workspace (HANDOFF.md priorities 1-4 and 7). All additions are NEW
-- tables keyed by case_no, never ALTERs of existing ones, so applying this
-- file to a live database is still safe and still idempotent.

-- Case categories. Seeded below, and admins can add more from the portal —
-- the application reads this table rather than hard-coding the list.
CREATE TABLE IF NOT EXISTS case_types (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  label  TEXT    NOT NULL UNIQUE,
  side   TEXT    NOT NULL CHECK (side IN ('insurance','private')),
  active INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO case_types (label, side) VALUES
  ('Workers'' Compensation Surveillance','insurance'),
  ('Liability / Bodily Injury Surveillance','insurance'),
  ('Disability Surveillance','insurance'),
  ('SIU / Fraud','insurance'),
  ('Field Investigation / Canvass','insurance'),
  ('Recorded Statement','insurance'),
  ('Scene Investigation','insurance'),
  ('Background / Social Media','insurance'),
  ('Asset / Business Investigation','insurance'),
  ('Adultery / Infidelity','private'),
  ('Child Custody','private'),
  ('Domestic / Cohabitation','private'),
  ('Background Investigation','private'),
  ('Locate / Skip Trace','private'),
  ('Civil Investigation','private'),
  ('Asset Investigation','private'),
  ('Other / Custom','private');

-- Operational metadata a case accumulates after intake. Kept beside the
-- submission rather than inside it so the original intake row is never
-- rewritten. authorized_hours/budget are the numeric authorization the
-- admin confirms — the intake's free-text authorization stays in the payload
-- as what the carrier asked for.
CREATE TABLE IF NOT EXISTS case_meta (
  case_no           TEXT PRIMARY KEY,
  case_type_id      INTEGER REFERENCES case_types(id),
  authorized_hours  REAL,
  authorized_budget REAL,
  updated_by        INTEGER REFERENCES users(id),
  updated_at        TEXT
);

-- An investigation day: START INVESTIGATION opens one, END INVESTIGATION DAY
-- closes it with the totals. Nothing here is ever sent anywhere by itself —
-- it is the raw material an admin reviews.
CREATE TABLE IF NOT EXISTS case_days (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no         TEXT    NOT NULL,
  investigator_id INTEGER NOT NULL REFERENCES users(id),
  day_date        TEXT    NOT NULL,   -- YYYY-MM-DD, investigator-local
  start_time      TEXT    NOT NULL,   -- HH:MM, investigator-local
  end_time        TEXT,
  start_mileage   REAL,
  end_mileage     REAL,
  hours           REAL,               -- computed at day end
  miles           REAL,               -- computed at day end
  summary         TEXT,
  created_at      TEXT    NOT NULL,
  ended_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_days_case ON case_days(case_no, day_date);
CREATE INDEX IF NOT EXISTS idx_days_open ON case_days(investigator_id) WHERE end_time IS NULL;

-- The activity log: the timestamped field timeline. Append-only in spirit —
-- entries are edited with an audit stamp, never silently overwritten, and
-- there is no delete. `kind` powers the quick-add buttons; photo/video
-- entries record the observation now and link to stored media when evidence
-- management lands (HANDOFF priority 6).
CREATE TABLE IF NOT EXISTS activity_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no         TEXT    NOT NULL,
  day_id          INTEGER REFERENCES case_days(id),
  investigator_id INTEGER NOT NULL REFERENCES users(id),
  at_date         TEXT    NOT NULL,   -- YYYY-MM-DD
  at_time         TEXT    NOT NULL,   -- HH:MM
  kind            TEXT    NOT NULL DEFAULT 'activity'
                    CHECK (kind IN ('activity','photo','video','location',
                                    'vehicle','note','mileage','expense')),
  description     TEXT    NOT NULL,
  location        TEXT,
  vehicle         TEXT,
  internal_note   TEXT,
  created_at      TEXT    NOT NULL,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  edited_at       TEXT,
  edited_by       INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_activity_case ON activity_log(case_no, at_date, at_time);

-- What was captured at a timeline moment. A 1:1 side-table rather than new
-- columns so schema.sql never needs an ALTER: the flags record THAT the
-- subject was documented or footage acquired at that entry; the files
-- themselves attach when evidence storage (priority 6) lands.
CREATE TABLE IF NOT EXISTS activity_media (
  entry_id           INTEGER PRIMARY KEY REFERENCES activity_log(id),
  subject_documented INTEGER NOT NULL DEFAULT 0,
  video_acquired     INTEGER NOT NULL DEFAULT 0,
  photo_acquired     INTEGER NOT NULL DEFAULT 0
);

-- Daily reports (HANDOFF priority 5). A report is drafted FROM the activity
-- log and then belongs to whoever is writing it — the generated chronology is
-- a starting point, never a finished document, so `body` is plain editable
-- text from the moment it is created. One report per investigation day.
CREATE TABLE IF NOT EXISTS case_reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no         TEXT    NOT NULL,
  day_id          INTEGER REFERENCES case_days(id),
  investigator_id INTEGER NOT NULL REFERENCES users(id),
  report_date     TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','submitted','needs_revision','approved','delivered')),
  body            TEXT    NOT NULL DEFAULT '',
  review_note     TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT,
  updated_by      INTEGER REFERENCES users(id),
  status_at       TEXT,
  status_by       INTEGER REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_day ON case_reports(day_id) WHERE day_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reports_case ON case_reports(case_no, report_date DESC);

-- Expenses and mileage (HANDOFF priority 12). An investigator records what a
-- case cost them; an admin reviews it and sets the three classifications,
-- which are deliberately separate concepts: money owed back to the
-- investigator, money billable to the client, and money the company eats are
-- three different decisions about the same receipt. NULL means undecided —
-- the review is what sets them. Receipt images wait for evidence storage
-- (priority 6); until then the description carries what the receipt says.
CREATE TABLE IF NOT EXISTS case_expenses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no         TEXT    NOT NULL,
  day_id          INTEGER REFERENCES case_days(id),
  investigator_id INTEGER NOT NULL REFERENCES users(id),
  expense_date    TEXT    NOT NULL,
  category        TEXT    NOT NULL
                    CHECK (category IN ('mileage','tolls','parking','hotel','airfare',
                                        'rental','records','database','equipment','meals','other')),
  amount          REAL,               -- claimed; mileage may carry miles instead
  miles           REAL,
  description     TEXT    NOT NULL,
  reimbursable    INTEGER,            -- 1/0, NULL until reviewed
  billable        INTEGER,            -- 1/0, NULL until reviewed
  internal        INTEGER,            -- 1/0, NULL until reviewed
  reviewed_at     TEXT,
  reviewed_by     INTEGER REFERENCES users(id),
  created_at      TEXT    NOT NULL,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  edited_at       TEXT,
  edited_by       INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_expenses_case ON case_expenses(case_no, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_pending ON case_expenses(reviewed_at) WHERE reviewed_at IS NULL;

-- Categorised case notes with visibility (HANDOFF priority 15). Visibility is
-- enforced in the query that reads them, never by the page: admin-only notes
-- do not leave the Worker for an investigator. client_eligible only marks a
-- note as allowed into a future client-facing record — nothing sends it.
CREATE TABLE IF NOT EXISTS case_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no    TEXT    NOT NULL,
  author_id  INTEGER NOT NULL REFERENCES users(id),
  note_type  TEXT    NOT NULL
               CHECK (note_type IN ('investigator','admin','client_comm','strategy',
                                    'subject','evidence','billing')),
  visibility TEXT    NOT NULL DEFAULT 'team'
               CHECK (visibility IN ('admin','team','client_eligible')),
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  edited_at  TEXT,
  edited_by  INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_notes_case ON case_notes(case_no, id DESC);

-- What the firm pays an investigator (HANDOFF priority 11). Deliberately a
-- different number in a different table from anything a client is billed:
-- CLIENT RATE and INVESTIGATOR COMPENSATION never share a field.
CREATE TABLE IF NOT EXISTS user_rates (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id),
  hourly     REAL,               -- what the investigator is paid per hour
  mileage    REAL,               -- their mileage reimbursement per mile
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT
);

-- Per-case commercial settings, admin-set. client_hourly overrides the
-- standard rate for billing arithmetic on this one case; show_client_identity
-- is priority 10's toggle — default NO, and revealing it shows the
-- investigator who the client is, never what the case bills or who to call.
CREATE TABLE IF NOT EXISTS case_settings (
  case_no              TEXT PRIMARY KEY,
  client_hourly        REAL,
  client_mileage       REAL,
  show_client_identity INTEGER NOT NULL DEFAULT 0,
  updated_by           INTEGER REFERENCES users(id),
  updated_at           TEXT
);

-- Password resets, invitation-style: an admin issues a one-time link and the
-- person chooses their own new password, so nobody — the admin included —
-- ever knows it. Only the token's SHA-256 is stored. 24-hour expiry.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

-- Assignment offers (HANDOFF priority 13). An admin offers a case; the
-- investigator accepts or declines. BEFORE acceptance they see the shape of
-- the job — date, hours, general location, their compensation — and nothing
-- that identifies the subject or the client. Acceptance is what assigns the
-- case and opens the (redacted) workspace.
CREATE TABLE IF NOT EXISTS case_offers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no             TEXT    NOT NULL,
  investigator_id     INTEGER NOT NULL REFERENCES users(id),
  offered_by          INTEGER NOT NULL REFERENCES users(id),
  offered_at          TEXT    NOT NULL,
  investigation_date  TEXT,
  expected_hours      REAL,
  general_location    TEXT,
  instructions        TEXT,               -- revealed only after acceptance
  compensation_hourly REAL,               -- the investigator's pay, never a client rate
  mileage_terms       TEXT,
  status              TEXT    NOT NULL DEFAULT 'offered'
                        CHECK (status IN ('offered','accepted','declined','withdrawn')),
  responded_at        TEXT,
  decline_reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_offers_case ON case_offers(case_no, status);
CREATE INDEX IF NOT EXISTS idx_offers_inv  ON case_offers(investigator_id, status);

-- Small configuration values (authorization warning thresholds and whatever
-- comes next), so numbers like 75/90/100 are configuration, not code.
CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT
);
INSERT OR IGNORE INTO app_config (key, value) VALUES ('auth_warn_thresholds', '75,90,100');

-- Per-type operational details for private cases (HANDOFF priority 16).
-- One row per case: a JSON bag holding the fields that case's type calls
-- for — custody schedule, suspected companion, court dates and so on. The
-- Worker allow-lists the keys by case type, so nothing lands here that the
-- active set does not name. Claims cases never get a row: a carrier
-- assignment carries its own claim details in the intake payload.
CREATE TABLE IF NOT EXISTS case_details (
  case_no     TEXT PRIMARY KEY,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT,
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TEXT
);

-- Structured subject and vehicle records (HANDOFF priority 17). A case can
-- carry several subjects (a custody case watches two households; an
-- insurance case sometimes adds an associate), and a subject several
-- vehicles. Fieldwork facts, so both roles read and write them on cases
-- they can open; every write stamps who and when, and there is no delete —
-- corrections are edits, the way the activity log works. The DOB, phone and
-- registered-owner labels carry the handoff's "if legitimately obtained"
-- qualifiers on the form. Photographs join when evidence storage lands.
CREATE TABLE IF NOT EXISTS case_subjects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no         TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  alias           TEXT,
  dob             TEXT,
  height          TEXT,
  weight          TEXT,
  hair            TEXT,
  descriptors     TEXT,
  addresses       TEXT,
  employer        TEXT,
  phone           TEXT,
  social_accounts TEXT,
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT,
  updated_by      INTEGER REFERENCES users(id),
  updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_subjects_case ON case_subjects(case_no);

CREATE TABLE IF NOT EXISTS subject_vehicles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id       INTEGER NOT NULL REFERENCES case_subjects(id),
  year             TEXT,
  make             TEXT,
  model            TEXT,
  color            TEXT,
  plate            TEXT,
  plate_state      TEXT,
  registered_owner TEXT,
  notes            TEXT,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT,
  updated_by       INTEGER REFERENCES users(id),
  updated_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_vehicles_subject ON subject_vehicles(subject_id);

-- Communication log (HANDOFF priority 18). Per-case record of who was
-- spoken to, when, how, and what was said — email, phone, text, client
-- update, investigator communication, authorization request, internal.
-- Version 1 documents communication; it sends nothing. Office-authored:
-- admins write, and visibility decides what the assigned investigator can
-- see, the same three levels the notes use. Client-eligible only marks a
-- row as safe for a future client-facing record — nothing is auto-sent.
CREATE TABLE IF NOT EXISTS case_comms (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no        TEXT    NOT NULL,
  comm_type      TEXT    NOT NULL CHECK (comm_type IN
                   ('email','phone','text','client_update','investigator','authorization_request','internal')),
  at_date        TEXT    NOT NULL,   -- YYYY-MM-DD
  at_time        TEXT,               -- HH:MM, 24h storage like everything else
  person         TEXT,               -- who the communication was with
  summary        TEXT    NOT NULL,
  follow_up_date TEXT,               -- when this needs another touch
  visibility     TEXT    NOT NULL DEFAULT 'admin'
                   CHECK (visibility IN ('admin','team','client_eligible')),
  author_id      INTEGER REFERENCES users(id),
  created_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_comms_case ON case_comms(case_no, at_date);

-- Follow-up tasks (HANDOFF priority 19). Simple case to-dos — call the
-- adjuster, request more authorization, confirm the surveillance date, send
-- the invoice. Admin-created; a task may be assigned to an investigator, and
-- that assignment is the only way one ever sees it. Overdue open tasks show
-- on the dashboard. Done/cancelled keep the row — the record of what was
-- asked and when it was resolved is the point.
CREATE TABLE IF NOT EXISTS case_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no     TEXT    NOT NULL,
  task        TEXT    NOT NULL,
  assigned_to INTEGER REFERENCES users(id),   -- NULL = the office generally
  due_date    TEXT,                           -- YYYY-MM-DD
  priority    TEXT    NOT NULL DEFAULT 'normal'
                CHECK (priority IN ('low','normal','high','urgent')),
  status      TEXT    NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','done','cancelled')),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT,
  done_by     INTEGER REFERENCES users(id),
  done_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_case ON case_tasks(case_no, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due  ON case_tasks(status, due_date);

-- Case closure and extended statuses (HANDOFF priority 20). submissions.status
-- is CHECK-constrained to four coarse values and ALTERs are off the table, so
-- the nine operational stages live here and the coarse column is kept in sync
-- (closed/cancelled -> closed, open -> new, assigned -> assigned, the rest ->
-- in_progress) for everything that already reads it.
CREATE TABLE IF NOT EXISTS case_status (
  case_no TEXT PRIMARY KEY,
  stage   TEXT NOT NULL CHECK (stage IN
            ('open','assigned','in_progress','report_review','awaiting_client',
             'complete','on_hold','cancelled','closed')),
  set_by  INTEGER REFERENCES users(id),
  set_at  TEXT
);

-- The closing checklist: eight human attestations, and the only door to the
-- closed stage. The row keeps who closed the case and when; reopening clears
-- the stamp but keeps the ticks as history.
CREATE TABLE IF NOT EXISTS case_closure (
  case_no        TEXT PRIMARY KEY,
  checklist_json TEXT NOT NULL DEFAULT '{}',
  closed_by      INTEGER REFERENCES users(id),
  closed_at      TEXT,
  updated_by     INTEGER REFERENCES users(id),
  updated_at     TEXT
);

-- ---------------------------------------------------------------------------
-- ARCHIVED (owner, WORKFLOW-SIMPLIFICATION §2): "Archive preserves everything
-- and is restorable." A REAL state, separate from Completed and Cancelled — a
-- case leaves the active lists and is found under Archived, with nothing about
-- the case itself altered.
--
-- A COMPANION TABLE, NOT A STATUS. `submissions.status` carries a CHECK
-- constraint and `case_status.stage` is validated against STAGES; widening
-- either means rebuilding the table, which schema.sql — re-applied on every
-- portal-setup run — cannot do idempotently. Editing the CHECK in place would
-- leave a FRESH database able to store the new value while the LIVE one, made
-- before the edit, still refused it: a divergence that passes every test and
-- fails only in production. Same reasoning as `activity_removed` and
-- `build_custom`.
--
-- It also means archiving is orthogonal to the stage. A case can be archived
-- while closed, complete or on hold, and restoring puts back exactly the stage
-- it had — because the stage was never touched.
--
-- Restoring DELETES the row, the way `activity_removed` does. What is preserved
-- is the CASE; the archive marker is not itself history.
CREATE TABLE IF NOT EXISTS case_archive (
  case_no     TEXT PRIMARY KEY,
  archived_by INTEGER REFERENCES users(id),
  archived_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- DELETE CASE (owner, WORKFLOW-SIMPLIFICATION §2 answer): "an Admin-only
-- soft-delete/tombstone that removes it from normal views but preserves
-- records", and "a true irreversible data purge is NOT needed now."
--
-- SO NOTHING IS DESTROYED. Not the submission, not evidence, not reports, not
-- invoices, not payment history, not the send or audit logs. This table is a
-- marker and the ONLY thing a delete writes — exactly like `case_archive`, and
-- for the same reason: a tombstone that deleted rows would not be a tombstone.
--
-- WHY IT IS NOT JUST ARCHIVE. Archived is a normal end state and browsable
-- under its own lens; deleted means the case should not be in the working set
-- at all, so it leaves EVERY ordinary view including Archived. An admin can
-- still find it under Deleted and put it back — nothing the office does in the
-- portal is unrecoverable in the portal, which is the promise `activity_removed`,
-- the invoice void and evidence `deleted_at` all already make.
--
-- `reason` is optional and free text, kept because "why is this case gone" is
-- the question a tombstone exists to answer.
-- ---------------------------------------------------------------------------
-- PHONE NUMBERS, PLURAL (owner, 2026-08-16). A client has a mobile and a work
-- line; a subject has whatever is known. One row per number, so each carries
-- its own label and can be added or removed without rewriting a delimited
-- string — the same reasoning that made `notify_recipient` one row per
-- recipient rather than a comma-separated column.
--
-- `owner_kind` says whose number it is. A client number hangs off the case;
-- a subject number hangs off that subject, because a case can watch more than
-- one person and their numbers must not pool.
--
-- THE EXISTING SINGLE NUMBERS ARE NOT LOST AND ARE NOT MIGRATED BY A SCRIPT.
-- `submissions.client_phone` and `case_subjects.phone` stay exactly where they
-- are and keep working for everything that already reads them. The Worker reads
-- THROUGH: with no rows here, the legacy value IS the list, so a case nobody has
-- edited reads the same as it always did. When the office saves a list, the
-- first number is mirrored back into the legacy column so redaction, alerts and
-- every other existing reader keep seeing a primary number. Nothing has to be
-- backfilled and nothing can be dropped by a migration that half-ran.
CREATE TABLE IF NOT EXISTS case_phone (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no    TEXT    NOT NULL,
  owner_kind TEXT    NOT NULL CHECK (owner_kind IN ('client','subject')),
  subject_id INTEGER,                     -- set only when owner_kind = 'subject'
  label      TEXT,                        -- mobile | work | home | other
  number     TEXT    NOT NULL,            -- as the office typed it
  position   INTEGER NOT NULL DEFAULT 0,  -- the order they were entered
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_phone ON case_phone(case_no, owner_kind, position);

-- ---------------------------------------------------------------------------
-- WHO THE OFFICE WANTS TOLD, and about what.
--
-- One row per recipient, so "multiple phone numbers" is rows rather than a
-- delimited column: each number carries its OWN enable switch and its own
-- choice of alerts. The owner's phone can take payments and packages while a
-- second number takes intakes only, and switching one off never touches the
-- other. A comma-separated column could not do that, and would have to be
-- parsed on every read.
--
-- NOTHING HERE IS HARDCODED. Every number and address is entered by an admin
-- through the portal and lives only in this table. There is no default
-- recipient in the source, and there is no provider credential anywhere near
-- it — delivery reads its configuration from the environment, the way
-- RESEND_API_KEY already does.
--
-- `email` and `phone` are both optional individually, and the Worker requires
-- at least one: a recipient with neither is a row that can never be told
-- anything.
CREATE TABLE IF NOT EXISTS notify_recipient (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  label          TEXT    NOT NULL,            -- who this is, in the office's own words
  email          TEXT,
  phone          TEXT,                        -- as the admin typed it; never a literal in source
  enabled        INTEGER NOT NULL DEFAULT 1,  -- the master switch for this recipient
  alert_intakes  INTEGER NOT NULL DEFAULT 0,
  alert_payments INTEGER NOT NULL DEFAULT 0,
  alert_reports  INTEGER NOT NULL DEFAULT 0,
  alert_packages INTEGER NOT NULL DEFAULT 0,
  alert_tasks    INTEGER NOT NULL DEFAULT 0,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS case_deleted (
  case_no    TEXT PRIMARY KEY,
  reason     TEXT,
  deleted_by INTEGER REFERENCES users(id),
  deleted_at TEXT NOT NULL
);

-- Private retainer tracking (RATESHEETS.md admin side). One row per private
-- case: the required retainer, and whether it has been received. What the
-- work has consumed is computed from case_days at the case's rate — never
-- stored, so it cannot drift. Internal only; no client-facing surface reads
-- this, and the claims side never touches it (the two pricing models never
-- share a calculation).
CREATE TABLE IF NOT EXISTS case_retainer (
  case_no         TEXT PRIMARY KEY,
  retainer_amount REAL    NOT NULL DEFAULT 1500,
  received        INTEGER NOT NULL DEFAULT 0,
  received_at     TEXT,
  updated_by      INTEGER REFERENCES users(id),
  updated_at      TEXT
);

-- ------------------------------------------------------------------ invoices
-- The invoice system (INVOICING.md). The portal is the operational record;
-- BILL is the payment system — version 1 is the manual handoff, and the
-- provider fields are deliberately generic (billing_provider +
-- external_* ids) so a live integration later plugs in without a rebuild.
-- Totals are computed from lines and payments on read, never stored, so
-- they cannot drift. Finalized invoices are never deleted: void keeps the
-- row, and invoice_events is the audit trail.
CREATE TABLE IF NOT EXISTS invoices (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no           TEXT    NOT NULL UNIQUE,
  case_no              TEXT    NOT NULL,
  invoice_type         TEXT    NOT NULL CHECK (invoice_type IN ('insurance','private')),
  status               TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN
                         ('draft','ready','sent_to_bill','sent_to_client',
                          'partially_paid','paid','void')),
  issue_date           TEXT,
  due_date             TEXT,
  payment_terms        TEXT,
  currency             TEXT    NOT NULL DEFAULT 'USD',
  bill_to              TEXT,             -- the addressee block, as it should print
  billing_email        TEXT,
  refs_json            TEXT    NOT NULL DEFAULT '{}',  -- claim/PO/auth/vendor…; only values print
  client_notes         TEXT,
  internal_notes       TEXT,             -- never printed on the document
  adjustments          REAL    NOT NULL DEFAULT 0,
  billing_provider     TEXT    NOT NULL DEFAULT 'manual',
  external_customer_id TEXT,
  external_invoice_id  TEXT,
  external_status      TEXT,
  sent_to_bill_at      TEXT,
  last_synced_at       TEXT,
  created_by           INTEGER REFERENCES users(id),
  created_at           TEXT,
  updated_by           INTEGER REFERENCES users(id),
  updated_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_case   ON invoices(case_no);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  description TEXT    NOT NULL,
  qty         REAL    NOT NULL DEFAULT 1,
  rate        REAL,              -- NULL on a flat package line: no per-hour math prints
  amount      REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invlines ON invoice_lines(invoice_id, sort);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id          INTEGER NOT NULL,
  amount              REAL    NOT NULL,
  paid_date           TEXT    NOT NULL,
  method              TEXT    NOT NULL DEFAULT 'other' CHECK (method IN
                        ('ach','card','check','wire','other')),
  reference           TEXT,
  provider            TEXT    NOT NULL DEFAULT 'manual',
  external_payment_id TEXT,
  notes               TEXT,
  recorded_by         INTEGER REFERENCES users(id),
  recorded_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_invpay ON invoice_payments(invoice_id);

CREATE TABLE IF NOT EXISTS invoice_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  action     TEXT    NOT NULL,
  detail     TEXT,
  user_id    INTEGER REFERENCES users(id),
  at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_invevents ON invoice_events(invoice_id);

-- Evidence (HANDOFF priority 6), stored in the private case-evidence R2
-- bucket and metered here. size_bytes is what the free-plan failsafe sums —
-- the Worker refuses uploads before the account could ever owe Cloudflare a
-- cent. Originals are never overwritten (keys are unique per upload) and
-- never silently deleted: an admin delete removes the object but keeps this
-- row with who and when, which is the audit the handoff requires.
CREATE TABLE IF NOT EXISTS case_evidence (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no        TEXT    NOT NULL,
  r2_key         TEXT    NOT NULL UNIQUE,
  filename       TEXT    NOT NULL,
  content_type   TEXT,
  size_bytes     INTEGER NOT NULL,
  classification TEXT    NOT NULL DEFAULT 'needs_review' CHECK (classification IN
                   ('client_deliverable','internal_only','do_not_use','needs_review','needs_redaction')),
  entry_id       INTEGER,             -- optional: the activity moment it documents
  subject_id     INTEGER,             -- optional: a subject photograph
  note           TEXT,
  uploaded_by    INTEGER REFERENCES users(id),
  uploaded_at    TEXT,
  classified_by  INTEGER REFERENCES users(id),
  classified_at  TEXT,
  deleted_by     INTEGER REFERENCES users(id),
  deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_case ON case_evidence(case_no);

-- Case Build (CASEBUILD.md priority 0): the client package. A build selects
-- an approved report plus client-deliverable photos, videos and attachments,
-- previews as one document, and finalizes behind hard gates. Versioned per
-- case; reopening keeps the version and the trail. Admin-only territory —
-- an investigator never selects client deliverables.
CREATE TABLE IF NOT EXISTS case_builds (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no      TEXT    NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  status       TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized')),
  package_type TEXT    NOT NULL DEFAULT 'report_photos' CHECK (package_type IN
                 ('report_only','report_photos','report_photos_video','full')),
  report_id    INTEGER,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT,
  finalized_by INTEGER REFERENCES users(id),
  finalized_at TEXT,
  delivered_by INTEGER REFERENCES users(id),
  delivered_at TEXT,
  updated_by   INTEGER REFERENCES users(id),
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_builds_case ON case_builds(case_no);

CREATE TABLE IF NOT EXISTS build_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id    INTEGER NOT NULL,
  evidence_id INTEGER NOT NULL,
  role        TEXT    NOT NULL CHECK (role IN ('photo','video','attachment')),
  sort        INTEGER NOT NULL DEFAULT 0,
  added_by    INTEGER REFERENCES users(id),
  added_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_bitems ON build_items(build_id);

-- Delivery copies on an external provider (CASEBUILD.md). GENERIC fields on
-- purpose: dropbox is the first provider, never the architecture. A row here
-- is a CLIENT DELIVERY COPY — the evidentiary original stays in case_evidence
-- and R2, and revoking or deleting a share can never touch it.
CREATE TABLE IF NOT EXISTS external_files (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_id      INTEGER NOT NULL,
  storage_provider TEXT    NOT NULL CHECK (storage_provider IN
                     ('local_private_storage','dropbox','google_drive','onedrive','s3','other')),
  delivery_name    TEXT,               -- the professional client-facing filename
  external_file_id TEXT,
  external_folder_id TEXT,
  external_path    TEXT,
  external_share_id TEXT,
  external_share_url TEXT,
  share_created_at TEXT,
  share_expires_at TEXT,
  share_revoked_at TEXT,
  upload_status    TEXT    NOT NULL DEFAULT 'pending' CHECK (upload_status IN
                     ('pending','uploading','uploaded','failed')),
  upload_error     TEXT,
  external_metadata TEXT,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT,
  updated_by       INTEGER REFERENCES users(id),
  updated_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_extfiles ON external_files(evidence_id);

CREATE TABLE IF NOT EXISTS build_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id INTEGER NOT NULL,
  action   TEXT    NOT NULL,
  detail   TEXT,
  user_id  INTEGER REFERENCES users(id),
  at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_bevents ON build_events(build_id);

-- A submitted report is never overwritten (UIBUILD P11): submitting snapshots
-- the exact text with its moment and author, and later edits touch only the
-- working copy. There is deliberately no delete: like the activity log, a
-- report history that can be quietly erased is worth less in a hearing.
CREATE TABLE IF NOT EXISTS report_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id    INTEGER NOT NULL,
  body         TEXT    NOT NULL,
  submitted_at TEXT    NOT NULL,
  submitted_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_repvers ON report_versions(report_id);

-- Removing an activity entry (owner's request, 2026-08-14). It is a STAMPED
-- soft delete, never an erase: a timeline that can be quietly rewritten is
-- worth less in a hearing than one that shows its corrections, and the same
-- rule already governs evidence. The office can still see what was removed
-- and by whom; the report and the client package simply skip it.
--
-- A separate table rather than columns on activity_log ON PURPOSE: schema.sql
-- is re-applied by portal-setup.yml on every run and must stay idempotent.
-- ALTER TABLE ADD COLUMN is not — the second run fails on a duplicate column
-- and takes the whole apply with it.
CREATE TABLE IF NOT EXISTS activity_removed (
  entry_id   INTEGER PRIMARY KEY,
  removed_at TEXT    NOT NULL,
  removed_by INTEGER REFERENCES users(id),
  reason     TEXT
);

-- ---------------------------------------------------------------------------
-- CASE BUILD, multi-day (MASTER §13: "Do not assume one case = one day.")
--
-- A surveillance case runs three days and produces three approved daily
-- reports. `case_builds.report_id` holds one, so a package built from it
-- shipped the LAST day and silently dropped the first two. This table is the
-- ordered set of reports a package carries; `report_id` stays as the primary
-- report so nothing that already reads it breaks.
--
-- A side table rather than more columns, for the reason recorded above
-- `activity_removed`: schema.sql is re-applied on every portal-setup run and
-- ALTER TABLE ADD COLUMN is not idempotent.
CREATE TABLE IF NOT EXISTS build_reports (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id  INTEGER NOT NULL,
  report_id INTEGER NOT NULL,
  sort      INTEGER NOT NULL DEFAULT 0,
  added_by  INTEGER REFERENCES users(id),
  added_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_breports ON build_reports(build_id, report_id);

-- The Combined Summary of a multi-day package (MASTER §13). The factual
-- synopsis above it — dates, days, hours, exhibit counts — is DERIVED and
-- never stored, because a stored copy goes stale the moment a day is added.
-- This holds only the narrative paragraph an admin writes themselves.
CREATE TABLE IF NOT EXISTS build_summary (
  build_id   INTEGER PRIMARY KEY,
  body       TEXT    NOT NULL DEFAULT '',
  updated_at TEXT,
  updated_by INTEGER REFERENCES users(id)
);

-- "Custom Package" (MASTER §13) — the admin controls the exact contents, so
-- the type-based content gate does not apply to it.
--
-- A marker table rather than a fifth value in `case_builds.package_type` ON
-- PURPOSE: that column carries a CHECK constraint, and widening a CHECK in
-- SQLite means rebuilding the table. schema.sql cannot do that idempotently,
-- and editing the constraint in place would leave a fresh database able to
-- store 'custom' while the live one — created before the edit — still refuses
-- it. That divergence would pass every test and fail only in production.
CREATE TABLE IF NOT EXISTS build_custom (
  build_id INTEGER PRIMARY KEY,
  at       TEXT NOT NULL,
  by       INTEGER REFERENCES users(id)
);

-- ---------------------------------------------------------------------------
-- Pausing an investigation day (owner, 2026-08-14). A break for lunch, or the
-- subject going into a building for two hours, should stop the clock — and
-- the client should not be billed for it.
--
-- Recorded as SPANS ON THE SERVER, never as a client-side counter, for the
-- same reason the timer itself derives from `case_days.created_at`: a phone
-- that sleeps, reloads or has a wrong clock must not be able to move the
-- number. Elapsed is (now - started) - the paused spans, and while a pause is
-- open the display freezes at the instant it opened.
--
-- A companion table rather than columns on `case_days`, for the reason
-- recorded above `activity_removed`: schema.sql is re-applied on every
-- portal-setup run and ALTER TABLE ADD COLUMN is not idempotent.
CREATE TABLE IF NOT EXISTS case_day_pauses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id     INTEGER NOT NULL,
  started_at TEXT    NOT NULL,
  ended_at   TEXT,
  reason     TEXT,
  by_user    INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_daypause ON case_day_pauses(day_id);
-- At most one pause open per day. Enforced by the database rather than by a
-- check in the route, so two taps on a flaky connection cannot open two.
CREATE UNIQUE INDEX IF NOT EXISTS idx_daypause_open
  ON case_day_pauses(day_id) WHERE ended_at IS NULL;

-- ---------------------------------------------------------------------------
-- Lead statuses (MASTER §5). A lead's lifecycle is NOT a case's: "rate sheet
-- sent" and "intake received" are sales-desk facts with no meaning on a case,
-- and reusing case stages for them is what the 2026-08-14 audit flagged.
-- A side table keyed by case_no, for the standing idempotency reason.
CREATE TABLE IF NOT EXISTS lead_status (
  case_no TEXT PRIMARY KEY,
  status  TEXT NOT NULL CHECK (status IN
            ('lead','rate_sheet_sent','intake_sent','intake_received','contacted',
             'more_info_requested','converted','declined','closed_lead')),
  set_by  INTEGER REFERENCES users(id),
  set_at  TEXT
);

-- ---------------------------------------------------------------------------
-- Send history (audit, 2026-08-14). Nothing recorded who was emailed a rate
-- sheet or an intake link, or when — the lead's status was current-state
-- only, so "we sent that on the 3rd" was unanswerable and a second send to
-- the same adjuster was invisible.
--
-- One row per send ATTEMPT, written whether or not the provider took it: a
-- send that failed is exactly the one an office needs to see. `door` records
-- WHICH intake went, so the carrier/private pairing is auditable after the
-- fact rather than only enforced at the moment of sending.
CREATE TABLE IF NOT EXISTS send_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no    TEXT,                       -- null when a sheet is sent with no case
  kind       TEXT    NOT NULL CHECK (kind IN ('rate_sheet','intake')),
  sheet_id   TEXT,                       -- insurance_assignment | private_retainer
  door       TEXT,                       -- the intake URL actually sent, if any
  recipient  TEXT    NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 1, -- 0 when the provider refused it
  detail     TEXT,                       -- the failure reason, when it failed
  sent_by    INTEGER REFERENCES users(id),
  sent_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sendlog_case ON send_log(case_no, id DESC);

-- ---------------------------------------------------------------------------
-- Which invoice IS the retainer (audit, 2026-08-14). The retainer is a
-- DEPOSIT, and billing it is asking for that deposit — it is not work done.
-- `retainerBlock` sums every live invoice's lines as "amount applied", so
-- without this marker the retainer invoice consumed the retainer it was
-- billing: the client's own document read "Applied $1,500 · Remaining $0" on
-- the very invoice requesting it, and the next one said "Beyond the retainer"
-- while money was still in hand.
--
-- A marker table rather than a column, for the standing idempotency reason.
CREATE TABLE IF NOT EXISTS invoice_retainer (
  invoice_id INTEGER PRIMARY KEY,
  amount     REAL    NOT NULL,
  at         TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- PRIVATE-CLIENT PAYMENT METHODS (PAYMENTS.md, owner 2026-08-14).
--
-- Admin-only configuration so a handle is entered ONCE and never duplicated
-- across templates. What is stored is deliberately the whole of it: whether the
-- method is offered, the name a client sees, the handle, an OPTIONAL
-- admin-entered payment URL, and optional instructions.
--
-- NO CREDENTIALS. No password, access token, account login or payment secret
-- belongs in this table, and none is stored. Everything here is information the
-- firm hands a client on purpose; if a value would be damaging to read, it does
-- not go here.
--
-- `method` carries NO CHECK constraint, deliberately. schema.sql is re-applied
-- on every portal-setup run and CREATE TABLE IF NOT EXISTS is a no-op against a
-- database that already has the table — so a CHECK edited here would bind a
-- FRESH database while the LIVE one kept the old one, which passes every test
-- and fails only in production. The allowed methods live in the Worker, where
-- adding a third one is an ordinary change. Same reasoning as build_custom.
CREATE TABLE IF NOT EXISTS payment_methods (
  method       TEXT PRIMARY KEY,          -- cash_app | venmo (validated in the Worker)
  enabled      INTEGER NOT NULL DEFAULT 0,
  display_name TEXT    NOT NULL DEFAULT '',
  handle       TEXT    NOT NULL DEFAULT '',
  url          TEXT    NOT NULL DEFAULT '',  -- admin-entered only; NEVER derived from the handle
  instructions TEXT    NOT NULL DEFAULT '',
  updated_by   INTEGER REFERENCES users(id),
  updated_at   TEXT
);

-- Payment instructions that were actually sent. A companion table rather than a
-- new `send_log.kind`, for the reason written above: send_log.kind carries a
-- CHECK, and widening it in schema.sql would bind only fresh databases.
--
-- This is what the sent-confirmation reads back from, so the client is told what
-- WENT rather than what was asked for — the same class of mistake as marking a
-- retainer paid because instructions were sent. Failures are kept and marked,
-- because a send that vanished silently is how "I sent that last week" goes
-- wrong.
CREATE TABLE IF NOT EXISTS payment_send (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no    TEXT,                        -- null when sent with no case or lead
  recipient  TEXT    NOT NULL,
  methods    TEXT    NOT NULL DEFAULT '', -- the method ids actually included, comma-separated
  with_sheet INTEGER NOT NULL DEFAULT 0,  -- 1 when it rode along with a rate sheet
  ok         INTEGER NOT NULL DEFAULT 1,
  detail     TEXT,
  sent_by    INTEGER REFERENCES users(id),
  sent_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paysend_case ON payment_send(case_no, id DESC);

-- ---------------------------------------------------------------------------
-- WHAT WAS ACTUALLY RECEIVED against a private client's retainer (PAYMENTS.md
-- §5/§11, owner 2026-08-15).
--
-- `case_retainer.received` is a 0/1 flag: it can say that money arrived, and
-- nothing about WHICH money. The office needs the amount, how it came, the day
-- the client paid and a reference, or "the retainer is in" is a claim nobody
-- can check against a bank statement six weeks later.
--
-- A companion table rather than columns on case_retainer, for the standing
-- idempotency reason: schema.sql is re-applied on every portal-setup run and
-- ALTER TABLE ADD COLUMN is not idempotent, so columns added there would bind
-- a FRESH database while the live one kept the old shape. Same reasoning as
-- activity_removed, build_custom and invoice_retainer.
--
-- `method` deliberately carries NO CHECK constraint. A CHECK cannot be widened
-- in place for exactly the same reason, and the owner's list of payment methods
-- is the kind of thing that gains an entry. The allowed values live in the
-- Worker.
--
-- SENDING INSTRUCTIONS NEVER WRITES THIS ROW. It is created only when an admin
-- records the money, which is the whole point: payment_send records that the
-- firm asked, this records that the client paid, and the two must never be
-- confused for one another.
-- ---------------------------------------------------------------------------
-- RETAINER PAYMENTS, ADDITIVE (owner confirmation 2026-08-15).
--
-- A private client may pay a retainer in instalments: agreed $3,000, then
-- $1,000 and $1,000, giving RECEIVED $2,000 and OUTSTANDING $1,000. So payments
-- are a LOG keyed by id, never one row per case — a second payment must not
-- overwrite the first, and TOTAL RECEIVED is the sum across the case.
--
-- This supersedes retainer_receipt below, which is keyed by case_no and can
-- therefore hold only the latest instalment. That table is left in place rather
-- than dropped: schema.sql is re-applied on every portal-setup run and cannot
-- drop anything idempotently. Any row already written there is still counted,
-- once, by the read — see the Worker.
--
-- HISTORY IS NOT REWRITTEN. A payment recorded in error is VOIDED, never edited
-- or deleted, so the record still shows what was believed at the time and who
-- corrected it. Same reasoning as activity_removed and the invoice void path.
CREATE TABLE IF NOT EXISTS retainer_payment (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no     TEXT    NOT NULL,
  amount      REAL    NOT NULL,
  method      TEXT,               -- validated in the Worker, no CHECK (see above)
  paid_on     TEXT,               -- the calendar date the CLIENT paid
  reference   TEXT,
  recorded_by INTEGER REFERENCES users(id),
  recorded_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retpay_case ON retainer_payment(case_no, id);



-- A RETRY MUST NOT CHARGE THE CLIENT TWICE. A dropped response, a double tap or
-- an offline replay delivers the same recorded payment again, and an additive
-- ledger takes every arrival at face value — two rows, twice the money, a total
-- nobody can reconcile against the bank.
--
-- A COMPANION TABLE, NOT A COLUMN, and this one was learned the hard way: the
-- token began life as `retainer_payment.client_token`, which never reached the
-- live database. CREATE TABLE IF NOT EXISTS does nothing to a table that
-- already exists, so the column existed only in fresh databases while
-- portal-setup failed outright on the real one — "no such column: client_token"
-- — and the deployed Worker was left inserting a column that was not there.
-- That is the exact failure this file warns about in four other places.
--
-- The token is CLAIMED before the payment is written: the primary key is the
-- gate, so exactly one caller can claim a token and the loser writes nothing.
CREATE TABLE IF NOT EXISTS retainer_payment_token (
  token      TEXT PRIMARY KEY,
  case_no    TEXT    NOT NULL,
  payment_id INTEGER,           -- filled in once the payment it guards exists
  claimed_at TEXT    NOT NULL
);

-- A voided payment stays in the log and stops counting. Companion table, not a
-- column, for the standing idempotency reason.
CREATE TABLE IF NOT EXISTS retainer_payment_void (
  payment_id INTEGER PRIMARY KEY,
  reason     TEXT,
  voided_by  INTEGER REFERENCES users(id),
  voided_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- SUPERSEDED by retainer_payment above. Kept because schema.sql cannot drop a
-- table idempotently, and because a row written here before the log existed is
-- still real money that must keep counting.
CREATE TABLE IF NOT EXISTS retainer_receipt (
  case_no     TEXT PRIMARY KEY,
  amount      REAL,
  method      TEXT,      -- cash_app | venmo | check | cash | ach_bill (Worker validates)
  paid_on     TEXT,      -- the calendar date the CLIENT paid, not when it was typed
  reference   TEXT,      -- cheque number, transaction note, whatever identifies it
  recorded_by INTEGER REFERENCES users(id),
  recorded_at TEXT
);

-- ------------------------------------------------------- video timestamping
-- VIDEO IS DEVICE-FIRST (owner, 2026-08-17). The original stays on the
-- investigator's phone or computer, the timestamped derivative is generated in
-- their browser and saved back to their device, and NEITHER SET OF BYTES IS
-- STORED HERE OR IN R2. This table is metadata and audit only — there is no
-- blob column and there must never be one.
--
-- `start_utc` is the instant the footage begins, stored as UTC so it cannot be
-- ambiguous; `tz` is the zone it was ENTERED in, kept so the burned-in wording
-- (EST or EDT) can be re-derived exactly rather than remembered.
--
-- A correction does not edit a row: it inserts a new one and stamps the old
-- one `superseded_at`, so the audit history of what was generated and when
-- survives. `saved_at` is only written once the operator's device save has
-- actually completed — a generated derivative that was never saved must be
-- visibly not-saved rather than assumed.
CREATE TABLE IF NOT EXISTS video_stamp (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no         TEXT    NOT NULL,
  original_name   TEXT    NOT NULL,
  original_size   INTEGER,
  original_hash   TEXT,               -- when the browser could compute one
  start_utc       TEXT    NOT NULL,   -- the selected first-frame instant, UTC
  tz              TEXT    NOT NULL DEFAULT 'America/New_York',
  derivative_name TEXT,
  generated_by    INTEGER REFERENCES users(id),
  generated_at    TEXT,
  saved_at        TEXT,               -- null until the device save completed
  superseded_at   TEXT,               -- null = this is the active derivative
  dropbox_path    TEXT,               -- reserved; nothing writes it yet
  created_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vstamp_case ON video_stamp(case_no, id DESC);

/* ------------------------------------------------------------ Dropbox OAuth

   The company Dropbox connection, made by an admin through the connect and
   callback flow. ONE ROW, id pinned to 1 — this is the firm's single App Folder
   connection, not a per-user login, and a CHECK keeps it that way rather than
   trusting every writer to remember.

   WHAT IS AND IS NOT HERE. The app key and app secret are Worker SECRETS and
   never touch this table, this file or the repository. What is stored is the
   refresh token the flow returns, because a refresh token is the only part that
   has to outlive the request — access tokens are minted from it on demand and
   are never written down.

   That refresh token is a long-lived credential at rest in D1, and that is worth
   saying out loud rather than burying: anyone with the database has the firm's
   Dropbox App Folder. It is scoped to the App Folder, it can be revoked from
   the Dropbox account page or by Disconnect here, and nothing reads it back out
   over the API — no route returns it, and `/dropbox/status` deliberately reports
   the account and the moment, never the token.

   `account_email` is stored because a connection nobody can identify is a
   connection nobody can audit; it is read from Dropbox at callback time, which
   also proves the token works before anything claims to be connected. */
CREATE TABLE IF NOT EXISTS dropbox_auth (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token  TEXT NOT NULL,
  account_id     TEXT,
  account_email  TEXT,
  account_name   TEXT,
  scopes         TEXT,
  connected_by   INTEGER REFERENCES users(id),
  connected_at   TEXT NOT NULL,
  last_checked_at TEXT
);

/* HOW AN ACTIVITY ENTRY WAS CAPTURED (SURVEILLANCE-VOICE.md §3).

   A COMPANION TABLE, on the owner's instruction (2026-08-18): "track
   voice-created activity entries with an idempotent companion metadata table
   instead of altering the existing activity_log table". That is also what this
   file can actually do — it is re-applied on every portal-setup run and
   `ALTER TABLE ADD COLUMN` is not idempotent, so a column added here would
   bind a fresh database and not the live one. Same shape as activity_removed,
   activity_media and build_custom.

   `source` is a MARKER, never a privilege. §11 is explicit that voice entries
   use the same Edit / Remove system as any other, and §12 that voice and the
   quick buttons converge on the same canonical types. Nothing may read this
   column and decide an entry is more, or less, editable for it.

   `heard` is the raw transcript, which §5 permits to be kept as internal
   diagnostic metadata — it exists to answer "the entry says X, what did they
   actually say?" and must never replace the standardized text. Nothing
   surfaces it yet, deliberately. */
CREATE TABLE IF NOT EXISTS activity_source (
  entry_id   INTEGER PRIMARY KEY REFERENCES activity_log(id),
  source     TEXT NOT NULL CHECK (source IN ('voice')),
  command_id TEXT,                    -- the canonical command, when one matched
  heard      TEXT,                    -- raw transcript, diagnostic only
  at         TEXT NOT NULL
);

/* ONE SPOKEN COMMAND, ONE RECORD — THE HALF THE CLIENT CANNOT DO (§8).

   The loop already guards against a speech engine re-emitting a final result,
   but §8 also names "retries caused by connection/offline synchronisation",
   and those cross a network the browser cannot reason about: a POST that
   actually landed and whose response was lost looks identical to one that
   never arrived. Only the server can tell those apart, and only if the client
   names the utterance.

   The client mints an event id per utterance and keeps it across every retry.
   A second arrival with the same id returns the entry that already exists
   rather than writing another.

   A COMPANION TABLE, like activity_source beside it: schema.sql is re-applied
   on every portal-setup run and ALTER TABLE ADD COLUMN is not idempotent. */
CREATE TABLE IF NOT EXISTS activity_voice_event (
  event_id TEXT    PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES activity_log(id),
  case_no  TEXT    NOT NULL,
  at       TEXT    NOT NULL
);

/* THE TIMESTAMPED PHOTOGRAPH — ORIGINAL AND DERIVATIVE, NAMED AS A PAIR.

   The owner's video brief is explicit that "the system must distinguish
   ORIGINAL EVIDENCE from TIMESTAMPED COPY", and that the original is never
   modified. Both of those are properties of the PAIR, not of either row, so
   the pair is what is recorded: two ordinary `case_evidence` rows, and this
   table saying which is which and what instant was burned into the second.

   A COMPANION TABLE FOR THE USUAL REASON — `case_evidence` cannot gain a
   column, because schema.sql is re-applied on every portal-setup run and
   ALTER TABLE ADD COLUMN is not idempotent. Same reasoning as
   activity_removed, build_custom, case_archive and activity_source.

   `stamped_id` is nullable so the record can exist for the moment between the
   Dropbox upload and the evidence insert, and so a derivative that is later
   deleted leaves the pairing legible rather than dangling.

   `source` is PROVENANCE and it matters: 'exif' means the camera's own
   DateTimeOriginal, 'operator' means a person typed it. An evidence
   timestamp whose origin is unrecorded is an evidence timestamp nobody can
   defend, and this column is the difference between the two.

   A CORRECTION SUPERSEDES rather than overwrites — a new row, and the
   previous one stamped `superseded_at`, matched on `original_id` so no caller
   can supersede another photograph's stamp by naming it. The superseded
   derivative's own evidence row is untouched: removing it would be a purge,
   and nothing in this portal purges. */
CREATE TABLE IF NOT EXISTS photo_stamp (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no       TEXT    NOT NULL,
  original_id   INTEGER NOT NULL REFERENCES case_evidence(id),
  stamped_id    INTEGER REFERENCES case_evidence(id),
  taken_utc     TEXT    NOT NULL,   -- the instant burned into the pixels, UTC
  tz            TEXT    NOT NULL DEFAULT 'America/New_York',
  source        TEXT    NOT NULL CHECK (source IN ('exif','operator')),
  generated_by  INTEGER REFERENCES users(id),
  generated_at  TEXT    NOT NULL,
  superseded_at TEXT                -- null = this is the active derivative
);
CREATE INDEX IF NOT EXISTS idx_pstamp_case ON photo_stamp(case_no, id DESC);
CREATE INDEX IF NOT EXISTS idx_pstamp_orig ON photo_stamp(original_id, id DESC);

-- LEGAL / LAW FIRM intake (Unit 6, owner brief in case-portal/LEGAL-INTAKE.md).
-- A COMPANION TABLE, not a third value in submissions.kind: that CHECK cannot
-- widen idempotently (the build_custom reasoning), and keeping legal cases
-- typed 'consumer' is what makes the pricing rule STRUCTURAL — the retainer
-- selector, agreedRetainer() and the invoice retainer block all key off
-- consumer, so Legal reflects Private pricing because it IS the private
-- pricing path. The marker of record is payload.assignment='legal' on the
-- submission row itself; this table carries the structured firm/matter detail.
-- payment_arrangement is validated in the Worker, no CHECK (the
-- retainer_payment.method precedent) — the four values are the owner's, and a
-- fifth must not need a table rebuild.
CREATE TABLE IF NOT EXISTS legal_intake (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no             TEXT    NOT NULL UNIQUE,
  firm_name           TEXT,
  firm_address        TEXT,
  firm_phone          TEXT,
  firm_email          TEXT,
  attorney_name       TEXT,
  attorney_email      TEXT,
  attorney_phone      TEXT,
  paralegal_name      TEXT,
  paralegal_email     TEXT,
  paralegal_phone     TEXT,
  billing_name        TEXT,
  billing_email       TEXT,
  billing_phone       TEXT,
  billing_reference   TEXT,
  matter_number       TEXT,
  court_case_number   TEXT,
  court_jurisdiction  TEXT,
  assignment_type     TEXT,
  conflict_names      TEXT,
  hearing_date        TEXT,
  trial_date          TEXT,
  deadline            TEXT,
  other_date          TEXT,
  other_date_label    TEXT,
  payment_arrangement TEXT,
  created_at          TEXT    NOT NULL,
  updated_by          INTEGER REFERENCES users(id),
  updated_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_legal_case ON legal_intake(case_no);

/* ------------------------------------------ REPEAT CLIENT / FIRM PROFILES
   (Unit 7, owner brief and derivations in case-portal/PROFILES.md.)

   A PROFILE IS A REUSABLE DEFAULT. A CASE IS A SNAPSHOT. Selecting a profile
   PREFILLS a new assignment; the case is then written from the form body the
   way it always was, into `submissions` and `legal_intake`, and nothing in any
   case read path joins back to these tables. So "editing a firm must not
   rewrite prior cases" is STRUCTURAL — there is no code path by which it
   could — rather than a rule someone has to keep remembering.

   `kind` CARRIES NO CHECK CONSTRAINT, deliberately. schema.sql is re-applied
   on every portal-setup run and CREATE TABLE IF NOT EXISTS is a no-op against
   a database that already has the table, so a CHECK edited here would bind a
   FRESH database while the LIVE one kept the old one — passing every test and
   failing only in production. `submissions.kind` is this project's own proof
   of the cost: it could not widen for Legal, so a legal case had to be stored
   as 'consumer' with a payload marker. A fourth client category must be an
   ordinary Worker edit. Same reasoning as payment_methods.method,
   retainer_payment.method and legal_intake.payment_arrangement.

   NO PRICE LIVES HERE AND NOTHING CAN BE MARKED PAID FROM A PROFILE. There is
   deliberately no retainer, rate, matter number or amount column anywhere in
   these four tables: agreedRetainer(), case_retainer and RATES stay the only
   pricing sources, and a per-firm figure would be a second answer to them that
   goes stale the moment the real one moves. `payment_arrangement` is a legal
   ARRANGEMENT preference and never a payment — the same word the case panel
   uses, and it means the same thing there: a request.

   The address is ONE block rather than city/state/ZIP columns, because every
   surface it prefills or is saved from already stores one block
   (legal_intake.firm_address, the payload's client_address, invoices.bill_to).
   Splitting it here would mean parsing on the way in and composing on the way
   out — two places to be wrong about the same string. */
CREATE TABLE IF NOT EXISTS profile (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                TEXT    NOT NULL,   -- law_firm | insurance_org | private_client (Worker-validated, no CHECK)
  name                TEXT    NOT NULL,   -- the firm, the carrier, or the person: ONE searched column
  name_norm           TEXT    NOT NULL,   -- computed in the Worker; D1 has no regex
  email               TEXT,               -- the office inbox, or the private client's own
  address             TEXT,
  address_norm        TEXT    NOT NULL DEFAULT '',  -- the same address normalised, for the duplicate check
  billing_name        TEXT,               -- an AP desk that is not one of the contacts
  billing_email       TEXT,
  payment_arrangement TEXT,               -- law_firm only; validated against LEGAL_ARRANGEMENTS
  notes               TEXT,               -- admin-only, never sent anywhere
  active              INTEGER NOT NULL DEFAULT 1,
  created_by          INTEGER REFERENCES users(id),
  created_at          TEXT    NOT NULL,
  updated_by          INTEGER REFERENCES users(id),
  updated_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_profile_dir  ON profile(active, kind, name);
CREATE INDEX IF NOT EXISTS idx_profile_norm ON profile(name_norm);
CREATE INDEX IF NOT EXISTS idx_profile_addr ON profile(address_norm);

/* The organisation's people. first_name and last_name are separate columns —
   the owner's rule is that a firm's attorneys, paralegals and billing contact
   must not be crammed into one concatenated text field — and nothing stores a
   composed display string, so there is none to drift.

   `role` carries no CHECK for the reason above and one more: the vocabulary
   DIFFERS BY PROFILE KIND (Attorney/Paralegal/Legal Assistant/Billing/Office
   Manager against Adjuster/Claims Examiner/SIU/Attorney/Billing), which a
   single-column CHECK cannot express at all — it could only be the union, and
   would then permit Adjuster on a law firm while still refusing to widen. */
CREATE TABLE IF NOT EXISTS profile_contact (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  first_name TEXT,
  last_name  TEXT,
  name_norm  TEXT    NOT NULL DEFAULT '', -- the two names normalised, for search
  role       TEXT,                        -- per-kind vocabulary, validated in the Worker
  email      TEXT,
  preferred  INTEGER NOT NULL DEFAULT 0,  -- the one contact a new assignment defaults to
  active     INTEGER NOT NULL DEFAULT 1,
  position   INTEGER NOT NULL DEFAULT 0,
  notes      TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT    NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pcontact      ON profile_contact(profile_id, active, position);
CREATE INDEX IF NOT EXISTS idx_pcontact_norm ON profile_contact(name_norm);
/* At most one preferred contact per profile, enforced by the DATABASE rather
   than by a check in the route — so two taps on a flaky connection cannot
   crown two. The case_day_pauses open-pause index is the same shape. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_pcontact_pref
  ON profile_contact(profile_id) WHERE preferred = 1;

/* Numbers are ROWS, one per number with its own label — the case_phone rule,
   and the owner's approved multiple-number direction. `contact_id` NULL means
   the number belongs to the ORGANISATION itself (the main office line, or a
   private client's own numbers), which columns hanging off a contact could not
   have carried. `position` 0 is the primary and 1 the secondary, so "secondary
   phone" needed no second column.

   `digits` is the number reduced to its digits, written by the Worker at save
   time: phone search has to match (540) 555-1212 against 5405551212 and D1 has
   no regex, so the canonical form is stored beside the one the office typed.
   It is a search key and is never displayed. */
CREATE TABLE IF NOT EXISTS profile_phone (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  contact_id INTEGER,                     -- NULL = the organisation's own line
  label      TEXT,                        -- mobile | work | home | other
  number     TEXT    NOT NULL,            -- exactly as the office typed it
  digits     TEXT    NOT NULL DEFAULT '', -- the same number, digits only, for search
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pphone     ON profile_phone(profile_id, contact_id, position);
CREATE INDEX IF NOT EXISTS idx_pphone_dig ON profile_phone(digits);

/* THE ONE CONNECTION BETWEEN A PROFILE AND A CASE, and it is written only by
   an explicit act: creating an assignment from a selected profile, an admin
   pressing Use this profile on a submission, or Save as profile from a case.
   Never inferred from a matching name, an address or an email — the
   recipientIsCarrier() lesson is standing policy here.

   `case_no` is the primary key: one profile per case, so re-associating
   REPLACEs rather than accumulating, and the case screen has one answer to
   show. Recent matters is the reverse read, indexed and LIMITed.

   Case-scoped, so DEMO_SWEEP deletes it with the case. The other three tables
   are NOT swept: a link is case data and a profile is reference data, and
   clearing a test case must not delete a real firm. And no REFERENCES clause
   on profile_id, deliberately — a foreign key here invites ON DELETE CASCADE,
   which is the exact thing the owner forbade ("do not delete a historical case
   because a client profile was removed"). Cross-boundary ids validated in the
   Worker are already the house norm (build_items.evidence_id,
   case_phone.subject_id). */
CREATE TABLE IF NOT EXISTS case_profile (
  case_no      TEXT PRIMARY KEY,
  profile_id   INTEGER NOT NULL,
  contact_id   INTEGER,                   -- the person the assignment was started from
  /* THE PROVENANCE IS A SNAPSHOT TOO. Reading the contact's name back through
     the live contact list meant removing that person from the firm blanked a
     line on a case that had not changed — while the screen said "no case
     changed", which was true of the data and false of what the office saw.
     The name of who the assignment was started from is a fact about the
     assignment; it is written once and never re-resolved. */
  contact_name TEXT,
  source       TEXT,                      -- prefill | linked | saved_from_case
  linked_by    INTEGER REFERENCES users(id),
  linked_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_caseprof_recent ON case_profile(profile_id, linked_at DESC);

/* ------------------------------------------- WHICH REPORT TEMPLATE (Unit 9)

   Six report STYLES over ONE report engine. A template is presentation — the
   document's title, its section headings, their order, and which optional
   sections appear — and it decides nothing about the facts: the report body,
   the evidence selection, the timestamps and the activity entries are the same
   records whichever template is chosen.

   A MARKER TABLE, not a column on `case_builds`, for the reason written above
   `build_custom` a few tables up: schema.sql is re-applied on every
   portal-setup run, `ALTER TABLE ADD COLUMN` is not idempotent, and a column
   added here would bind a FRESH database while the LIVE one kept the old
   shape. Same family as build_custom, build_summary and activity_removed.

   `template` carries NO CHECK, deliberately — a seventh style must cost an
   ordinary Worker edit, never a table rebuild. The allowed ids live in the
   Worker beside the other validated vocabularies.

   ABSENT MEANS GENERAL. Every report that exists today has no row here and
   must keep rendering exactly as it does, so the reader treats a missing row
   as the general format rather than as a problem. That is also what stops a
   later change to the template definitions from rewriting historical
   documents: a finalized build keeps the id it was finalized with, and a
   build that never chose one keeps the format it was always printed in. */
CREATE TABLE IF NOT EXISTS build_template (
  build_id INTEGER PRIMARY KEY,
  template TEXT    NOT NULL,          -- validated in the Worker, no CHECK
  set_by   INTEGER REFERENCES users(id),
  set_at   TEXT    NOT NULL
);
