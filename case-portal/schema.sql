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
