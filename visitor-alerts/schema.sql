-- Live Visitors journey schema (Cloudflare D1 / SQLite).
--
--   npx wrangler d1 execute api-visitor-journeys --remote --file=visitor-alerts/schema.sql
--
-- Applied by .github/workflows/visitors-setup.yml. Applying it twice is safe:
-- every object is created IF NOT EXISTS, and nothing here alters or drops.
-- Keep semicolons out of these comments: the setup sends the file to D1's
-- query endpoint, which splits statements on them.
--
-- THIS IS ITS OWN DATABASE, BOUND ONLY TO THE api-visitor-alerts WORKER. The
-- case portal's database holds claimant names, signatures and case narratives,
-- and this one holds anonymous page journeys. They are kept apart for the same
-- reason the two Workers are: a fault in the public beacon's Worker must not be
-- able to reach a single row of case data.
--
-- WHAT IS NEVER HERE: an IP address, a user agent, a screen size, a raw visitor
-- token, or anything typed into a form. The visitor id is a salted hash of a
-- random token the visitor's own browser keeps, and the only link to an intake is
-- the request number the intake page itself minted, written after the visitor
-- pressed Submit. Every timestamp is epoch milliseconds, UTC.
--
-- `kind` and `name` carry no CHECK on purpose (the case portal's Unit 7 rule):
-- widening a CHECK in SQLite is a table rebuild this file cannot do
-- idempotently, so the allow-list lives in the Worker.

-- One row per browser that has made a real (bot-filtered) visit. The running
-- figures beside the id are maintained by the Worker so the dashboard list
-- never has to sum a visitor's whole history to draw one card.
CREATE TABLE IF NOT EXISTS visitor (
  id            TEXT    PRIMARY KEY,          -- sha256 of the browser's random token + SALT, never the token
  first_at      INTEGER NOT NULL,
  last_at       INTEGER NOT NULL,
  sessions      INTEGER NOT NULL DEFAULT 0,   -- visits: a new one after 30 minutes with no activity
  engaged_ms    INTEGER NOT NULL DEFAULT 0,   -- visible, focused, recently-active time, all visits
  score         INTEGER NOT NULL DEFAULT 0,   -- 0-100, the Worker's explainable interest score
  tier          TEXT    NOT NULL DEFAULT 'browsing',
  interest      TEXT,                         -- service key, NULL = not determined
  reasons       TEXT,                         -- JSON: what the score is made of
  summary       TEXT,                         -- JSON: the card's facts (pages seen, intake opened)
  alerted_high_at INTEGER,                    -- last HIGH INTENT alert, for de-duplication
  intake_case   TEXT,                         -- latest linked submission: the intake's own request number
  intake_at     INTEGER,
  intake_service TEXT
);
CREATE INDEX IF NOT EXISTS idx_visitor_last ON visitor(last_at);

-- One row per visit. The landing page, source and approximate location are
-- the visit's own, so a returning visitor's second visit can arrive from a
-- different place and the record says so.
CREATE TABLE IF NOT EXISTS visitor_session (
  id            TEXT    PRIMARY KEY,
  visitor_id    TEXT    NOT NULL,
  started_at    INTEGER NOT NULL,
  last_at       INTEGER NOT NULL,
  landing_path  TEXT,
  current_path  TEXT,
  source        TEXT,                         -- Google / Bing / Facebook / Direct / Referral: host
  ref_host      TEXT,                         -- the referring host only, never a URL
  city          TEXT,
  region        TEXT,
  country       TEXT,
  pages         INTEGER NOT NULL DEFAULT 0,
  engaged_ms    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_vsession_visitor ON visitor_session(visitor_id, last_at);
CREATE INDEX IF NOT EXISTS idx_vsession_started ON visitor_session(started_at);
CREATE INDEX IF NOT EXISTS idx_vsession_last ON visitor_session(last_at);

-- The journey: page views and the actions taken on them, in the order they
-- happened. A page view's id is the visitor's id plus the random id its page
-- load chose, so two browsers can never write to one row.
CREATE TABLE IF NOT EXISTS visitor_event (
  id            TEXT    PRIMARY KEY,
  visitor_id    TEXT    NOT NULL,
  session_id    TEXT    NOT NULL,
  page_id       TEXT,                         -- the page view an action happened on
  at            INTEGER NOT NULL,
  kind          TEXT    NOT NULL,             -- page | action
  name          TEXT,                         -- action name (call, email, intake_opened, ...)
  path          TEXT,                         -- pathname only, never a query string
  service       TEXT,
  detail        TEXT,                         -- action detail from a fixed vocabulary (the button pressed)
  engaged_ms    INTEGER NOT NULL DEFAULT 0,
  beats         INTEGER NOT NULL DEFAULT 0,   -- engagement check-ins received for this page view
  related_submission_id TEXT                  -- the intake's request number, on intake_submitted only
);
CREATE INDEX IF NOT EXISTS idx_vevent_session ON visitor_event(session_id, at);
CREATE INDEX IF NOT EXISTS idx_vevent_visitor ON visitor_event(visitor_id, at);

-- Alerts the Worker raised, so the phone's service worker can read the text
-- of the one that woke it. A push carries no payload, so this is where it lives.
CREATE TABLE IF NOT EXISTS visitor_alert (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  kind          TEXT    NOT NULL,             -- visit | high | intake
  visitor_id    TEXT,
  session_id    TEXT,
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_valert_at ON visitor_alert(at);

-- Small key/value facts the Worker keeps for itself (the day the retention
-- sweep last ran).
CREATE TABLE IF NOT EXISTS visitor_meta (
  k             TEXT    PRIMARY KEY,
  v             TEXT
);
