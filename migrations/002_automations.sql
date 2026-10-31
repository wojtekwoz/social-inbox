-- M5 automations: deterministic flows, runs, metrics log and opt-outs (docs/SPEC-automations.md).
-- Timestamps are unix epoch milliseconds.

CREATE TABLE flows (
  id         TEXT PRIMARY KEY,           -- short id "f1"
  name       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0,
  mode       TEXT NOT NULL DEFAULT 'draft', -- draft | auto
  priority   INTEGER NOT NULL DEFAULT 100,  -- lower is evaluated first, then creation order
  trigger    TEXT NOT NULL,              -- JSON
  steps      TEXT NOT NULL,              -- JSON array
  rr         INTEGER NOT NULL DEFAULT 0, -- round-robin counter for public_reply variants
  enabled_at INTEGER,                    -- items older than this (minus a grace period) never trigger
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE flow_runs (
  id         TEXT PRIMARY KEY,           -- short id "r1"
  flow_id    TEXT NOT NULL REFERENCES flows(id),
  net        TEXT NOT NULL,
  contact_id TEXT NOT NULL,              -- IGSID of the person who acted first
  thread_id  TEXT,
  item_id    TEXT NOT NULL,              -- trigger item
  media_id   TEXT,                       -- native media / story id of the trigger
  step       INTEGER NOT NULL DEFAULT 0, -- index of the next step to run
  state      TEXT NOT NULL,              -- active | waiting_input | done | stopped | failed
  vars       TEXT NOT NULL DEFAULT '{}', -- JSON (captured email, armed button payloads, …)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (flow_id, item_id)
);
CREATE INDEX flow_runs_contact ON flow_runs (net, contact_id, state);

-- Append-only metrics log.
CREATE TABLE flow_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id  TEXT,
  run_id   TEXT,
  type     TEXT NOT NULL,                -- triggered | drafted | sent | public_reply | button_tap | quick_reply
                                         -- | email_captured | email_pushed | skipped | failed
  reason   TEXT,
  step     INTEGER,
  media_id TEXT,
  ts       INTEGER NOT NULL
);
CREATE INDEX flow_events_flow ON flow_events (flow_id, ts);
CREATE INDEX flow_events_ts ON flow_events (ts, type);

-- People who asked not to be messaged: automations never contact them again.
CREATE TABLE contacts_optout (
  net        TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  keyword    TEXT,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (net, contact_id)
);

-- Evaluation ledger: the engine looks at every inbound item at most once.
CREATE TABLE flow_seen (
  item_id TEXT PRIMARY KEY,
  ts      INTEGER NOT NULL
);

ALTER TABLE drafts ADD COLUMN flow_run_id TEXT;
ALTER TABLE drafts ADD COLUMN payload TEXT;     -- JSON: buttons / quick replies for the connector
CREATE INDEX drafts_flow_run ON drafts (flow_run_id);
