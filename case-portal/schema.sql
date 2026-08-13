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

-- Small configuration values (authorization warning thresholds and whatever
-- comes next), so numbers like 75/90/100 are configuration, not code.
CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT
);
INSERT OR IGNORE INTO app_config (key, value) VALUES ('auth_warn_thresholds', '75,90,100');
